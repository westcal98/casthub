const express = require('express');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');

const app = express();
let server;

// CORS for mobile app
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ── File streaming with range request support ──────────────────────────────
app.get('/file', (req, res) => {
  const filePath = decodeURIComponent(req.query.path || '');
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');

  const stat        = fs.statSync(filePath);
  const fileSize    = stat.size;
  const ext         = path.extname(filePath).toLowerCase().slice(1);
  const mimeTypes   = {
    mp4:'video/mp4', mkv:'video/x-matroska', avi:'video/x-msvideo',
    mov:'video/quicktime', webm:'video/webm', m4v:'video/mp4',
    ts:'video/mp2t', wmv:'video/x-ms-wmv', flv:'video/x-flv', hevc:'video/mp4'
  };
  const contentType = mimeTypes[ext] || 'video/mp4';
  const range       = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start     = parseInt(startStr, 10);
    const end       = endStr ? parseInt(endStr, 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunkSize,
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

// ── File browser endpoint for mobile app ──────────────────────────────────
app.get('/browse', (req, res) => {
  let browseDir = decodeURIComponent(req.query.path || '');

  // Default to Videos folder on Windows, home on other platforms
  if (!browseDir) {
    browseDir = process.platform === 'win32'
      ? path.join(os.homedir(), 'Videos')
      : os.homedir();
  }

  // Windows drive listing (path = 'drives')
  if (browseDir === 'drives') {
    const drives = ['C:', 'D:', 'E:', 'F:', 'G:'].map(d => ({
      name: d, type: 'drive', path: d + '\\'
    }));
    return res.json({ path: 'drives', entries: drives });
  }

  if (!fs.existsSync(browseDir)) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const VIDEO_EXTS = new Set(['.mp4','.mkv','.avi','.mov','.hevc','.ts','.m4v','.wmv','.flv','.webm']);

  try {
    const entries = fs.readdirSync(browseDir, { withFileTypes: true })
      .filter(e => {
        if (e.isDirectory()) return true;
        return VIDEO_EXTS.has(path.extname(e.name).toLowerCase());
      })
      .map(e => {
        const fullPath = path.join(browseDir, e.name);
        const entry = { name: e.name, type: e.isDirectory() ? 'dir' : 'file', path: fullPath };
        if (!e.isDirectory()) {
          try { entry.size = fs.statSync(fullPath).size; } catch {}
        }
        return entry;
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const parent = browseDir !== path.parse(browseDir).root
      ? path.dirname(browseDir)
      : (process.platform === 'win32' ? 'drives' : null);

    res.json({ path: browseDir, parent, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function startFileServer() {
  return new Promise(resolve => {
    server = app.listen(8765, '0.0.0.0', () => {
      console.log(`[CastHub] File server → http://${getLocalIP()}:8765`);
      resolve();
    });
  });
}

function stopFileServer() {
  return new Promise(resolve => server?.close(resolve));
}

module.exports = { startFileServer, stopFileServer, getLocalIP };
