const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const { spawn } = require('child_process');
const crypto       = require('crypto');

let ffmpegPath;
try { ffmpegPath = require('ffmpeg-static'); } catch {}
// WSL: ffmpeg-static resolves to 'ffmpeg' but the installed binary is 'ffmpeg.exe' (Windows build)
if (ffmpegPath && !fs.existsSync(ffmpegPath) && fs.existsSync(ffmpegPath + '.exe')) {
  ffmpegPath = ffmpegPath + '.exe';
}

// Only applies WSL-specific path conversions — on Windows the paths are already correct
const IS_WSL = (() => { try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); } catch { return false; } })();

// In WSL, /mnt/c/foo must become C:\foo for the Windows ffmpeg.exe binary
function toFfmpegPath(p) {
  if (!IS_WSL || !ffmpegPath || !ffmpegPath.endsWith('.exe')) return p;
  return p.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
}

// Return a temp dir writable by ffmpeg and readable by Node in this process.
// In WSL + ffmpeg.exe: /tmp is Linux-only; use a path under C:\ accessible as /mnt/c/
let _sessionTempBase = null;
function getSessionTempBase() {
  if (_sessionTempBase) return _sessionTempBase;
  if (!IS_WSL || !ffmpegPath || !ffmpegPath.endsWith('.exe')) return _sessionTempBase = os.tmpdir();
  try {
    const { execSync } = require('child_process');
    const winTemp = execSync('cmd.exe /c echo %TEMP%', { encoding: 'utf8' }).trim();
    // Convert C:\Users\... → /mnt/c/Users/... so Node (WSL) can read the files
    _sessionTempBase = winTemp.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
  } catch {
    _sessionTempBase = os.tmpdir();
  }
  return _sessionTempBase;
}

const TRANSCODE_EXTS  = new Set(['mkv','avi','ts','wmv','flv']);
const sessions        = new Map();
const segmentSessions = new Map(); // sessionId → { filePath, seekOffset, tempDir, ffmpegProcess, done }

const app = express();
let server;

app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

const { execFile } = require('child_process');

// Probe file for problematic streams (EAC3 audio or any subtitle track)
function getStreamInfo(filePath) {
  return new Promise(resolve => {
    if (!ffmpegPath) return resolve({ hasEAC3: false, hasSSA: false, duration: 0 });
    execFile(ffmpegPath, ['-hide_banner', '-i', toFfmpegPath(filePath)], (_err, stdout, stderr) => {
      // On Windows/Electron, ffmpeg exits code 1 (no output file) so output
      // may be in _err.stderr rather than the stderr parameter — check both
      const info = (_err?.stderr || '') + (stderr || '') + (_err?.stdout || '') + (stdout || '');
      if (info.length < 50) {
        // Probe failed entirely — safe default: assume needs remux
        console.log(`[CastHub] Stream probe empty for ${require('path').basename(filePath)}, defaulting to remux`);
        return resolve({ hasEAC3: true, hasSSA: false, duration: 0 });
      }
      const hasEAC3 = /Stream.*Audio.*(eac3|ac3b|e-ac3)/i.test(info);
      const hasSSA  = /Stream.*Subtitle/i.test(info);
      const dm = info.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      const duration = dm ? parseInt(dm[1])*3600 + parseInt(dm[2])*60 + parseFloat(dm[3]) : 0;
      console.log(`[CastHub] Stream info for ${require('path').basename(filePath)}: EAC3=${hasEAC3} SSA=${hasSSA} (info len=${info.length})`);
      resolve({ hasEAC3, hasSSA, duration });
    });
  });
}

// ── Segmented MKV session system ──────────────────────────────────
function startSegmentSession(filePath, seekOffset) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg not available'));

    // Kill any existing session for this file
    for (const [id, s] of segmentSessions) {
      if (s.filePath === filePath) {
        try { s.ffmpegProcess.kill('SIGKILL'); } catch {}
        segmentSessions.delete(id);
        setTimeout(() => { try { fs.rmSync(s.tempDir, { recursive: true, force: true }); } catch {} }, 2000);
      }
    }

    const sessionId = crypto.randomUUID();
    const tempDir   = path.join(getSessionTempBase(), 'casthub-segments', sessionId);
    fs.mkdirSync(tempDir, { recursive: true });

    const proc = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(seekOffset || 0),
      '-i', toFfmpegPath(filePath),
      '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '256k', '-sn',
      '-f', 'segment', '-segment_format', 'matroska',
      '-segment_time', '10', '-segment_start_number', '0',
      toFfmpegPath(path.join(tempDir, 'segment%d.mkv'))
    ]);

    const session = { filePath, seekOffset: seekOffset || 0, tempDir, ffmpegProcess: proc, done: false };
    segmentSessions.set(sessionId, session);
    proc.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.error('[segment]', s); });
    proc.on('close', code => {
      session.done = true;
      console.log(`[CastHub] Segment session ${sessionId} ended (exit ${code})`);
    });

    // Return as soon as segment0 starts being written — don't wait for finalization
    const deadline = Date.now() + 10000;
    (function waitForReady() {
      const seg0 = path.join(tempDir, 'segment0.mkv');
      try {
        if (fs.existsSync(seg0))
          return resolve({ sessionId, firstSegmentUrl: `http://${getLocalIP()}:8765/segment/${sessionId}/0` });
      } catch {}
      if (Date.now() > deadline) return reject(new Error('Timeout: ffmpeg did not produce output'));
      setTimeout(waitForReady, 50);
    })();
  });
}

function stopSegmentSession(sessionId) {
  const s = segmentSessions.get(sessionId);
  if (!s) return;
  try { s.ffmpegProcess.kill('SIGKILL'); } catch {}
  segmentSessions.delete(sessionId);
  setTimeout(() => { try { fs.rmSync(s.tempDir, { recursive: true, force: true }); } catch {} }, 2000);
  console.log(`[CastHub] Segment session stopped: ${sessionId}`);
}

function stopAllSegmentSessions() {
  for (const id of [...segmentSessions.keys()]) stopSegmentSession(id);
}

// ── Segmented MKV routes ───────────────────────────────────────────
app.post('/session/start', express.json(), async (req, res) => {
  const { filePath, seekOffset } = req.body || {};
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  try {
    const result = await startSegmentSession(filePath, seekOffset || 0);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/segment/:sessionId/:index', async (req, res) => {
  const session = segmentSessions.get(req.params.sessionId);
  if (!session) return res.status(404).send('Session not found');
  const index = parseInt(req.params.index, 10);
  if (isNaN(index)) return res.status(400).send('Invalid segment index');

  const segPath  = path.join(session.tempDir, `segment${index}.mkv`);
  const nextPath = path.join(session.tempDir, `segment${index + 1}.mkv`);

  // Wait for this segment to start being written
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(segPath)) {
    if (session.done) return res.status(404).send('No more segments');
    if (Date.now() > deadline) return res.status(404).send('Timeout waiting for segment');
    await new Promise(r => setTimeout(r, 50));
  }

  // Stream bytes live as ffmpeg writes them; end response when segment is finalized
  res.setHeader('Content-Type', 'video/x-matroska');
  res.setHeader('Accept-Ranges', 'bytes');

  let offset = 0;
  let closed = false;
  req.on('close', () => { closed = true; });

  while (!closed) {
    try {
      const size = fs.statSync(segPath).size;
      if (size > offset) {
        const len = size - offset;
        const buf = Buffer.allocUnsafe(len);
        const fd  = fs.openSync(segPath, 'r');
        fs.readSync(fd, buf, 0, len, offset);
        fs.closeSync(fd);
        offset += len;
        const ok = res.write(buf);
        if (!ok) await new Promise(r => res.once('drain', r));
      }
    } catch {
      break;
    }
    // Segment is finalized when next segment file appears or ffmpeg exits
    if (session.done || fs.existsSync(nextPath)) {
      // One final read for any bytes written in the last polling gap
      try {
        const finalSize = fs.statSync(segPath).size;
        if (finalSize > offset) {
          const len = finalSize - offset;
          const buf = Buffer.allocUnsafe(len);
          const fd  = fs.openSync(segPath, 'r');
          fs.readSync(fd, buf, 0, len, offset);
          fs.closeSync(fd);
          res.write(buf);
        }
      } catch {}
      break;
    }
    await new Promise(r => setTimeout(r, 50));
  }

  res.end();
});

// Remux: video passthrough, stereo AAC audio, subtitles stripped
app.get('/remux', (req, res) => {
  const filePath    = decodeURIComponent(req.query.path || '');
  const seekSeconds = parseFloat(req.query.seek || '0');
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  if (!ffmpegPath) return res.status(500).send('ffmpeg-static not installed');

  console.log(`[CastHub] Remuxing: ${path.basename(filePath)} (seek: ${seekSeconds}s)`);
  res.setHeader('Content-Type', 'video/x-matroska');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Accept-Ranges', 'none');
  res.writeHead(200);

  const proc = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-probesize', '1M', '-analyzeduration', '100000',
    '-ss', String(seekSeconds),
    '-i', toFfmpegPath(filePath),
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '256k', '-ac', '2',
    '-sn',
    '-f', 'matroska', 'pipe:1'
  ]);

  proc.stdout.pipe(res);
  proc.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.error('[remux]', s); });
  proc.on('close', code => { if (code && code !== null) console.log(`[remux] exit ${code}`); });
  req.on('close', () => { try { proc.kill('SIGKILL'); } catch {} });
});




// ── Direct file serve for all formats (Custom Receiver handles decoding) ──
app.get('/transcode', (req, res) => {
  const filePath = decodeURIComponent(req.query.path || '');
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');

  console.log(`[CastHub] Serving: ${path.basename(filePath)}`);

  const stat      = fs.statSync(filePath);
  const fileSize  = stat.size;
  const ext       = path.extname(filePath).toLowerCase().slice(1);
  const mimeTypes = {
    mkv:'video/x-matroska', avi:'video/x-msvideo', mp4:'video/mp4',
    mov:'video/quicktime',  m4v:'video/mp4',        webm:'video/webm',
    ts:'video/mp2t',        wmv:'video/x-ms-wmv',   flv:'video/x-flv',
    hevc:'video/mp4',       mp3:'audio/mpeg',        aac:'audio/aac'
  };
  const contentType = mimeTypes[ext] || 'video/mp4';
  const range = req.headers.range;

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start  = parseInt(s, 10);
    const end    = e ? parseInt(e, 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   contentType
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type':   contentType,
      'Accept-Ranges':  'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ── HLS helpers ────────────────────────────────────────────────────
function waitForFile(filePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function check() {
      try { if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return resolve(); } catch {}
      if (Date.now() > deadline) return reject(new Error('Timeout: ' + filePath));
      setTimeout(check, 150);
    })();
  });
}

function generateSession(filePath, seekSeconds) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(getSessionTempBase(), `ch_${id}`);
  fs.mkdirSync(dir, { recursive: true });

  const proc = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'warning',
    '-ss', String(seekSeconds || 0),
    '-i', toFfmpegPath(filePath),
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '256k',
    '-hls_time', '6', '-hls_list_size', '5',
    '-hls_flags', 'delete_segments',
    '-hls_segment_filename', toFfmpegPath(path.join(dir, 'seg%05d.ts')),
    toFfmpegPath(path.join(dir, 'playlist.m3u8'))
  ]);

  const session = { proc, dir, lastPlaylist: null, done: false };
  proc.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.log('[HLS]', s.substring(0, 120)); });
  proc.on('close', code => { session.done = true; console.log(`[CastHub] HLS ${id} ended (exit ${code})`); });
  sessions.set(id, session);
  console.log(`[CastHub] HLS session started: ${id} seek=${seekSeconds}s`);
  return id;
}

function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.proc.kill('SIGKILL'); } catch {}
  sessions.delete(id);
  setTimeout(() => { try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {} }, 4000);
  console.log(`[CastHub] HLS session stopped: ${id}`);
}

// ── HLS routes ─────────────────────────────────────────────────────

app.get('/hls/:id/master.m3u8', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).send('Session not found');
  // Declare codecs explicitly so Chromecast knows it can play HEVC + AAC
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="avc1.640028,mp4a.40.2"',
    'playlist.m3u8'
  ].join('\n');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(master);
});

app.get('/hls/:id/playlist.m3u8', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).send('Session not found');

  res.setHeader('Content-Type', 'application/x-mpegURL');
  res.setHeader('Cache-Control', 'no-cache');

  const plist = path.join(s.dir, 'playlist.m3u8');
  const seg0  = path.join(s.dir, 'seg00000.ts');
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    // 1. Try real playlist — cache valid reads to survive mid-write truncation
    try {
      const raw = fs.readFileSync(plist, 'utf8');
      const segLines = raw.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      if (segLines.length > 0 && segLines[segLines.length - 1].trim().endsWith('.ts')) {
        const content = raw.split('\n').map(line => {
          const t = line.trim();
          return (t && !t.startsWith('#')) ? path.basename(t) : line;
        }).join('\n');
        s.lastPlaylist = content;
        return res.send(content);
      }
    } catch {}

    // 2. Mid-write: serve cached version so Chromecast doesn't get truncated content
    if (s.lastPlaylist) return res.send(s.lastPlaylist);

    // 3. seg00000.ts has started — synthesise a one-entry playlist so Chromecast
    //    can begin fetching and buffering it before the segment is fully encoded
    try {
      if (fs.existsSync(seg0) && fs.statSync(seg0).size > 0) {
        return res.send([
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:7',
          '#EXT-X-MEDIA-SEQUENCE:0',
          '#EXTINF:6.000,',
          'seg00000.ts'
        ].join('\n'));
      }
    } catch {}

    await new Promise(r => setTimeout(r, 150));
  }

  res.status(504).send('Timeout waiting for playlist');
});

app.get('/hls/:id/:seg', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).send('Session not found');

  const segName  = req.params.seg;
  const segPath  = path.join(s.dir, segName);
  const segNum   = parseInt((segName.match(/(\d+)\.ts$/) || [])[1] ?? '0', 10);
  const nextPath = path.join(s.dir, `seg${String(segNum + 1).padStart(5, '0')}.ts`);

  // Wait for the segment file to start being written
  const deadline = Date.now() + 20000;
  while (!(fs.existsSync(segPath) && fs.statSync(segPath).size > 0)) {
    if (s.done) return res.status(404).send('No more segments');
    if (Date.now() > deadline) return res.status(504).send('Timeout waiting for segment');
    await new Promise(r => setTimeout(r, 50));
  }

  // Stream bytes as ffmpeg writes them; end when the next segment appears
  // (ffmpeg only moves on once the current segment is fully flushed)
  res.setHeader('Content-Type', 'video/MP2T');
  res.setHeader('Cache-Control', 'no-cache');

  let offset = 0;
  let closed = false;
  req.on('close', () => { closed = true; });

  while (!closed) {
    try {
      const size = fs.statSync(segPath).size;
      if (size > offset) {
        const len = size - offset;
        const buf = Buffer.allocUnsafe(len);
        const fd  = fs.openSync(segPath, 'r');
        fs.readSync(fd, buf, 0, len, offset);
        fs.closeSync(fd);
        offset += len;
        const ok = res.write(buf);
        if (!ok) await new Promise(r => res.once('drain', r));
      }
    } catch {
      // File disappeared (e.g. delete_segments removed it) — end the response cleanly
      break;
    }
    if (s.done || fs.existsSync(nextPath)) {
      // Final drain: read any bytes written in the last polling gap
      try {
        const final = fs.statSync(segPath).size;
        if (final > offset) {
          const len = final - offset;
          const buf = Buffer.allocUnsafe(len);
          const fd  = fs.openSync(segPath, 'r');
          fs.readSync(fd, buf, 0, len, offset);
          fs.closeSync(fd);
          res.write(buf);
        }
      } catch {}
      break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  res.end();
});

// ── Direct file serve (MP4, WebM) ──────────────────────────────────
app.get('/file', (req, res) => {
  const filePath = decodeURIComponent(req.query.path || '');
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const stat = fs.statSync(filePath), fileSize = stat.size;
  const mimeTypes = { mp4:'video/mp4', m4v:'video/mp4', mov:'video/quicktime', webm:'video/webm', hevc:'video/mp4' };
  const contentType = mimeTypes[ext] || 'video/mp4';
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10), end = e ? parseInt(e, 10) : fileSize - 1;
    res.writeHead(206, { 'Content-Range':`bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges':'bytes', 'Content-Length':end-start+1, 'Content-Type':contentType });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length':fileSize, 'Content-Type':contentType, 'Accept-Ranges':'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ── Directory browser ──────────────────────────────────────────────
function browseDirectory(dirPath) {
  if (!dirPath) dirPath = process.platform === 'win32' ? path.join(os.homedir(), 'Videos') : os.homedir();
  if (dirPath === 'drives') return { path:'drives', parent:null, entries:['C:','D:','E:','F:','G:'].map(d => ({ name:d, type:'drive', path:d+'\\' })) };
  if (!fs.existsSync(dirPath)) return { error:'Path not found', status:404 };
  const VIDEO_EXTS = new Set(['.mp4','.mkv','.avi','.mov','.hevc','.ts','.m4v','.wmv','.flv','.webm']);
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes:true })
      .filter(e => e.isDirectory() || VIDEO_EXTS.has(path.extname(e.name).toLowerCase()))
      .map(e => { const fp = path.join(dirPath, e.name); const en = { name:e.name, type:e.isDirectory()?'dir':'file', path:fp }; if (!e.isDirectory()) { try { en.size = fs.statSync(fp).size; } catch {} } return en; })
      .sort((a,b) => a.type !== b.type ? (a.type==='dir'?-1:1) : a.name.localeCompare(b.name));
    const parent = dirPath !== path.parse(dirPath).root ? path.dirname(dirPath) : (process.platform==='win32'?'drives':null);
    return { path:dirPath, parent, entries };
  } catch (err) { return { error:err.message, status:500 }; }
}

app.get('/browse', (req, res) => {
  const r = browseDirectory(decodeURIComponent(req.query.path || ''));
  if (r.error) return res.status(r.status||500).json({ error:r.error });
  res.json(r);
});

// ── IP detection ───────────────────────────────────────────────────
let _cachedIP = null;
function getLocalIP() {
  if (_cachedIP) return _cachedIP;
  const skip = ['vethernet','vmware','virtualbox','hamachi','hyper-v','wsl','docker','vpn','tap','tun'];
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.some(s => name.toLowerCase().includes(s))) continue;
    for (const i of addrs) { if (i.family==='IPv4' && !i.internal) candidates.push({ ip:i.address, name }); }
  }
  console.log('[CastHub] Network adapters:', candidates.map(c=>`${c.name}: ${c.ip}`).join(', ')||'none');
  return _cachedIP = candidates.find(c=>c.ip.startsWith('192.168.'))?.ip || candidates.find(c=>/^10\.(0|1)\./.test(c.ip))?.ip || candidates[0]?.ip || '127.0.0.1';
}

function startFileServer() {
  return new Promise(resolve => { server = app.listen(8765, '0.0.0.0', () => { console.log(`[CastHub] File server → http://${getLocalIP()}:8765`); resolve(); }); });
}
function stopFileServer() { return new Promise(resolve => server?.close(resolve)); }

module.exports = { startFileServer, stopFileServer, getLocalIP, browseDirectory, getStreamInfo, generateSession, stopSession, TRANSCODE_EXTS, startSegmentSession, stopSegmentSession, stopAllSegmentSessions };
