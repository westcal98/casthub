const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, 'logs');
const MAX_LOGS = 5;

// Create logs dir if missing
fs.mkdirSync(LOG_DIR, { recursive: true });

// Rotate: remove oldest files beyond MAX_LOGS - 1
const existing = fs.readdirSync(LOG_DIR)
  .filter(f => f.startsWith('casthub-') && f.endsWith('.log'))
  .sort();                                  // lexicographic = chronological for ISO names
while (existing.length >= MAX_LOGS) {
  try { fs.unlinkSync(path.join(LOG_DIR, existing.shift())); } catch {}
}

// Session log file: casthub-YYYY-MM-DDTHH-MM-SS.log
const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
const logPath = path.join(LOG_DIR, `casthub-${stamp}.log`);
const stream  = fs.createWriteStream(logPath, { flags: 'a' });

function ts() {
  return new Date().toISOString();
}

function write(level, args) {
  const line = `[${ts()}] [${level}] ${args.map(a =>
    (typeof a === 'object' ? JSON.stringify(a) : String(a))
  ).join(' ')}`;
  stream.write(line + '\n');
}

const _log   = console.log.bind(console);
const _error = console.error.bind(console);
const _warn  = console.warn.bind(console);

console.log = (...args) => { write('LOG',   args); _log(...args);   };
console.error = (...args) => { write('ERR',   args); _error(...args); };
console.warn  = (...args) => { write('WARN',  args); _warn(...args);  };

console.log(`[CastHub] Logging to ${logPath}`);
module.exports = { logPath };
