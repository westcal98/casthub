const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const { spawn } = require('child_process');

let ffmpegPath;
try { ffmpegPath = require('ffmpeg-static'); } catch {}

const TRANSCODE_EXTS = new Set(['mkv','avi','ts','wmv','flv']);
const sessions = new Map();

const app = express();
let server;

app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

const { execFile } = require('child_process');

// Probe file for problematic streams (EAC3 audio or SSA subtitles)
function getStreamInfo(filePath) {
  return new Promise(resolve => {
    if (!ffmpegPath) return resolve({ hasEAC3: false, hasSSA: false });
    execFile(ffmpegPath, ['-hide_banner', '-i', filePath], (_err, stdout, stderr) => {
      const info = (stderr || '') + (stdout || '');
      const hasEAC3 = /Stream.*Audio.*(eac3|ac3b|e-ac3)/i.test(info);
      const hasSSA  = /Stream.*Subtitle/i.test(info); // catch SSA, ASS, subt, etc.
      console.log(`[CastHub] Stream info for ${require('path').basename(filePath)}: EAC3=${hasEAC3} SSA=${hasSSA}`);
      resolve({ hasEAC3, hasSSA });
    });
  });
}

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
    '-i', filePath,
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
  const dir = path.join(os.tmpdir(), `ch_${id}`);
  fs.mkdirSync(dir, { recursive: true });

  const proc = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'warning',
    '-ss', String(seekSeconds || 0),
    '-i', filePath,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy', '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', '256k',
    '-hls_time', '4', '-hls_list_size', '0',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'playlist.m3u8')
  ]);

  proc.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.log('[HLS]', s.substring(0, 120)); });
  proc.on('close', code => console.log(`[CastHub] HLS ${id} ended (exit ${code})`));
  sessions.set(id, { proc, dir });
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
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-STREAM-INF:BANDWIDTH=15000000,CODECS="hvc1.2.4.L153.B0,mp4a.40.2",RESOLUTION=3840x1600,FRAME-RATE=23.976',
    'playlist.m3u8'
  ].join('\n');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(master);
});

app.get('/hls/:id/playlist.m3u8', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).send('Session not found');
  const plist = path.join(s.dir, 'playlist.m3u8');
  try {
    // Wait for a complete, non-truncated playlist
    const deadline = Date.now() + 30000;
    let content = '';
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(plist, 'utf8');
        const segLines = raw.split('\n').filter(l => l.trim() && !l.startsWith('#'));
        // Only serve once the last segment line is a complete filename
        if (segLines.length > 0 && segLines[segLines.length - 1].trim().endsWith('.ts')) {
          content = raw;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    if (!content) throw new Error('Playlist never became complete');
    console.log('[HLS] Playlist ready, last segment:', content.split('\n').filter(l=>l.endsWith('.ts')).pop());
    // Replace absolute paths with just filenames so Chromecast can resolve them
    content = content.split('\n').map(line => {
      const t = line.trim();
      if (t && !t.startsWith('#')) return path.basename(t);
      return line;
    }).join('\n');
    res.setHeader('Content-Type', 'application/x-mpegURL');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(content);
  } catch (e) {
    console.error('[CastHub] Playlist error:', e.message);
    res.status(504).send('Timeout waiting for playlist');
  }
});

app.get('/hls/:id/:seg', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).send('Session not found');
  const segPath = path.join(s.dir, req.params.seg);
  try {
    await waitForFile(segPath, 20000);
    // Small delay to ensure segment is fully written
    await new Promise(r => setTimeout(r, 250));
    const size = fs.statSync(segPath).size;
    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(segPath).pipe(res);
  } catch (e) {
    res.status(504).send('Timeout waiting for segment');
  }
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

module.exports = { startFileServer, stopFileServer, getLocalIP, browseDirectory, getStreamInfo, generateSession, stopSession, TRANSCODE_EXTS };
