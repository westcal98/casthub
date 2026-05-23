'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// CastHub headless integration test
// Usage:  node test.js
// Starts fileServer + wsServer without Electron, casts a real file to the
// Chromecast, exercises all controls, reports pass/fail with a log tail.
// ─────────────────────────────────────────────────────────────────────────────

const { logPath } = require('./logger'); // must be first — patches console.*

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const {
  startFileServer, stopFileServer,
  getLocalIP, getStreamInfo,
  generateSession, stopSession,
} = require('./server/fileServer');
const { startWSServer, stopWSServer } = require('./server/wsServer');
const CastManager = require('./server/cast');

// ── Config ────────────────────────────────────────────────────────────────────

// Try both WSL and Windows paths for the test file
const FILE_CANDIDATES = [
  "/mnt/c/Plex/Movies/28.Years.Later.The.Bone.Temple.2026.1080p.WEBRip.10Bit.DDP.5.1.x265-NeoNoir.mkv",
  "C:\\Plex\\Movies\\28.Years.Later.The.Bone.Temple.2026.1080p.WEBRip.10Bit.DDP.5.1.x265-NeoNoir.mkv",
];

// Electron writes the cache to the Windows home dir; node in WSL has a different homedir
const DEVICE_CACHE_CANDIDATES = [
  path.join(os.homedir(), '.casthub_devices.json'),
  '/mnt/c/Users/westc/.casthub_devices.json',
];

// WSL2 can't reach the LAN — detect so cast tests can be skipped gracefully
const IS_WSL = (() => {
  try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); } catch { return false; }
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Poll castManager.getState() until status matches, or timeout
async function waitForStatus(cm, wanted, timeoutMs) {
  const statuses = Array.isArray(wanted) ? wanted : [wanted];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = cm.getState();
    if (statuses.includes(s.status)) return s;
    await sleep(300);
  }
  return null;
}

// ── Test runner ───────────────────────────────────────────────────────────────

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`[TEST] ✓  ${name}`);
  } catch (err) {
    const msg = err?.message || String(err);
    results.push({ name, ok: false, err: msg });
    console.error(`[TEST] ✗  ${name}`);
    console.error(`[TEST]    ${msg}`);
    throw err; // stop subsequent tests
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[TEST] ══════════════════════════════════════════════════');
  console.log('[TEST]  CastHub integration test');
  console.log(`[TEST]  Log → ${logPath}`);
  console.log('[TEST] ══════════════════════════════════════════════════');

  const cm = new CastManager();
  // Echo every Chromecast state transition into the log
  cm._onStateChange = s =>
    console.log(`[TEST] CC → ${s.status.padEnd(9)} t=${Math.round(s.currentTime)}s vol=${s.volume.toFixed(2)}`);

  let sessionId = null;
  let filePath  = null;
  let duration  = 0;
  let deviceHost = null;

  try {
    // ── 1. Servers ────────────────────────────────────────────────────────
    await test('File server + WebSocket server start', async () => {
      await startFileServer();
      startWSServer();
      console.log(`[TEST]    IP: ${getLocalIP()}`);
    });

    // ── 2. Locate test file ───────────────────────────────────────────────
    await test('Test file found on disk', () => {
      filePath = FILE_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
      if (!filePath) throw new Error(`Not found at:\n  ${FILE_CANDIDATES.join('\n  ')}`);
      console.log(`[TEST]    ${path.basename(filePath)}`);
    });

    // ── 3. Stream probe ───────────────────────────────────────────────────
    await test('ffprobe: detects EAC3 audio (required for HLS path)', async () => {
      const info = await getStreamInfo(filePath);
      duration = info.duration;
      if (!info.hasEAC3) throw new Error('Expected EAC3; got plain AAC — test needs EAC3 file');
      console.log(`[TEST]    EAC3=${info.hasEAC3} SSA=${info.hasSSA} duration=${Math.round(duration)}s`);
    });

    // ── 4. Resolve Chromecast ─────────────────────────────────────────────
    await test('Chromecast device found in cache', () => {
      const cachePath = DEVICE_CACHE_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
      if (!cachePath) throw new Error(`Device cache not found — open the app once to populate it`);
      const devices = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (!devices.length) throw new Error('No devices in cache — open the app once to populate it');
      // Prefer IP over mDNS hostname — .local hostnames don't resolve in WSL
      deviceHost = devices[0].ip || devices[0].host;
      console.log(`[TEST]    ${devices[0].name}  (${deviceHost})`);
    });

    // ── 5. Start HLS session ──────────────────────────────────────────────
    let masterUrl;
    await test('HLS session created', () => {
      sessionId = generateSession(filePath, 0);
      masterUrl = `http://${getLocalIP()}:8765/hls/${sessionId}/master.m3u8`;
      console.log(`[TEST]    ${masterUrl}`);
    });

    if (IS_WSL) {
      console.log('[TEST] ⚠  WSL detected — skipping Chromecast network tests (LAN not reachable from WSL2)');
      console.log('[TEST]    Run on Windows host for full cast coverage.');
    } else {

    // ── 6. Connect + cast ─────────────────────────────────────────────────
    await test('castURL: connect to Chromecast + load media', async () => {
      await cm.castURL(deviceHost, masterUrl, path.basename(filePath), { duration });
    });

    // ── 7. Reach PLAYING ──────────────────────────────────────────────────
    await test('Chromecast reaches PLAYING within 30s', async () => {
      const s = await waitForStatus(cm, 'playing', 30000);
      if (!s) {
        const cur = cm.getState();
        throw new Error(`Timed out — last status: ${cur.status}`);
      }
      console.log(`[TEST]    playing at t=${Math.round(s.currentTime)}s`);
    });

    // ── 8. Stable playback ────────────────────────────────────────────────
    await test('No IDLE ERROR for 15s of playback', async () => {
      await sleep(15000);
      const s = cm.getState();
      if (s.status !== 'playing') throw new Error(`Unexpected status: ${s.status}`);
      console.log(`[TEST]    still playing at t=${Math.round(s.currentTime)}s`);
    });

    // ── 9. Seek to 5:00 ───────────────────────────────────────────────────
    await test('Seek to 5:00 (new HLS session + reloadURL)', async () => {
      stopSession(sessionId);
      sessionId = generateSession(filePath, 300);
      const seekUrl = `http://${getLocalIP()}:8765/hls/${sessionId}/master.m3u8`;
      try {
        await cm.reloadURL(seekUrl, path.basename(filePath), { duration });
      } catch {
        await cm.castURL(deviceHost, seekUrl, path.basename(filePath), { duration });
      }
      const s = await waitForStatus(cm, 'playing', 30000);
      if (!s) throw new Error(`Did not resume playing after seek — status: ${cm.getState().status}`);
      console.log(`[TEST]    playing at t=${Math.round(s.currentTime)}s after seek`);
    });

    // ── 10. Stable after seek ─────────────────────────────────────────────
    await test('No IDLE ERROR for 10s after seek', async () => {
      await sleep(10000);
      const s = cm.getState();
      if (s.status !== 'playing') throw new Error(`Unexpected status: ${s.status}`);
    });

    // ── 11. Volume ────────────────────────────────────────────────────────
    await test('Volume control (0.3 → 1.0)', async () => {
      await cm.control('volume', 0.3);
      await sleep(800);
      await cm.control('volume', 1.0);
      await sleep(800);
    });

    // ── 12. Disconnect ────────────────────────────────────────────────────
    await test('Disconnect', async () => {
      if (sessionId) { stopSession(sessionId); sessionId = null; }
      await cm.disconnect();
    });

    } // end !IS_WSL

  } catch {
    // test() already logged the failure; proceed to cleanup + summary
  } finally {
    if (sessionId) { try { stopSession(sessionId); } catch {} }
    try { if (cm.client) await cm.disconnect(); } catch {}
    try { await stopFileServer(); } catch {}
    try { stopWSServer(); } catch {}
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);

  console.log('\n[TEST] ══════════════════════════════════════════════════');
  results.forEach(r =>
    console.log(`[TEST] ${r.ok ? '✓' : '✗'}  ${r.name}${r.err ? `\n[TEST]    ↳ ${r.err}` : ''}`)
  );
  console.log(`[TEST] ${passed}/${results.length} passed`);
  console.log(`[TEST] Full log: ${logPath}`);
  console.log('[TEST] ══════════════════════════════════════════════════');

  // Give logger stream time to flush before exit
  await sleep(300);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error('[TEST] Uncaught fatal:', err);
  process.exit(1);
});
