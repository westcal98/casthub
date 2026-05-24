const { Client, DefaultMediaReceiver } = require('castv2-client');
const util = require('util');

// Custom receiver with CastHub APP_ID — uses same media protocol as Default
function CastHubReceiver() { DefaultMediaReceiver.apply(this, arguments); }
util.inherits(CastHubReceiver, DefaultMediaReceiver);
CastHubReceiver.APP_ID = 'E8C19FEC';
const { Bonjour } = require('bonjour-service');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CACHE_FILE = path.join(os.homedir(), '.casthub_devices.json');

function loadCachedDevices() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return []; }
}
function saveCachedDevices(devices) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(devices)); } catch {}
}

class CastManager {
  constructor() {
    this.devices = loadCachedDevices(); this.client = null; this.player = null;
    this._statusInterval = null;
    this._onStateChange = null;
    this.state = { connected:false, deviceHost:null, deviceName:null, title:null,
      status:'idle', currentTime:0, duration:0, volume:1.0, muted:false };
  }

  startDiscovery(onUpdate) {
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: 'googlecast' });
    browser.on('up', svc => {
      if (this.devices.find(d => d.host === svc.host)) return;
      const ip = svc.addresses?.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || null;
      this.devices.push({ name: svc.txt?.fn || svc.name, host: svc.host, ip, port: svc.port || 8009 });
      console.log(`[CastHub] Device found: ${svc.txt?.fn || svc.name} @ ${svc.host}`);
      saveCachedDevices(this.devices);
      onUpdate([...this.devices]);
    });
    browser.on('down', svc => { this.devices = this.devices.filter(d => d.host !== svc.host); onUpdate([...this.devices]); });
  }

  castURL(deviceHost, url, title, { duration = 0 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.client) { try { this.client.close(); } catch {} this.client = null; this.player = null; }
      if (!deviceHost) return reject(new Error('No device selected'));

      const isHLS     = url.includes('/hls/') || url.endsWith('.m3u8');
      const isRemux   = url.includes('/remux');
      const isSegment = url.includes('/segment/');
      const contentType = isHLS ? 'application/vnd.apple.mpegurl' : (isRemux || isSegment) ? 'video/x-matroska' : 'video/mp4';
      const streamType  = isRemux ? 'LIVE' : 'BUFFERED';

      this.client = new Client();
      this.client.connect({ host: deviceHost, port: 8009 }, () => {
        this.client.launch(CastHubReceiver, (err, player) => {
          if (err) return reject(err);
          this.player = player;
          const media = {
            contentId: url, contentType, streamType,
            metadata: { type:0, metadataType:0, title },
            ...(duration > 0 && { duration })
          };
          player.load(media, { autoplay: true }, (err, status) => {
            if (err) { console.error('[CastHub] player.load error:', err.message); return reject(err); }
            this.state.connected = true; this.state.deviceHost = deviceHost;
            this.state.deviceName = this.devices.find(d => d.host === deviceHost)?.name;
            this.state.title = title; this.state.status = 'playing';
            this._applyStatus(status);
            player.on('status', s => {
              console.log('[CastHub] CC status:', s?.playerState, s?.idleReason || '');
              this._applyStatus(s);
            });
            // Poll for currentTime updates
            if (this._statusInterval) clearInterval(this._statusInterval);
            this._statusInterval = setInterval(() => {
              if (this.player && (this.state.status === 'playing' || this.state.status === 'paused')) {
                this.player.getStatus((err, s) => { if (s && !err) this._applyStatus(s); });
              }
            }, 1000);
            resolve();
          });
        });
      });
      this.client.on('error', err => {
        console.error('[CastHub] Cast error:', err.message);
        if (this.state.connected) {
          // Post-connect drop — signal main.js to attempt reconnect
          this.state.connected = false;
          this.state.status = 'idle';
          if (this._onStateChange) this._onStateChange({ ...this.state, _connectionLost: true });
        } else {
          this.state.connected = false;
          reject(err);
        }
      });
    });
  }

  _applyStatus(s) {
    if (!s) return;
    if (s.playerState)         this.state.status      = s.playerState.toLowerCase();
    if (s.currentTime != null) this.state.currentTime = s.currentTime;
    if (s.media?.duration)     this.state.duration    = s.media.duration;
    if (s.media) {
      const m = (s.media.contentId || '').match(/\/segment\/[^/]+\/(\d+)$/);
      this.state.segmentIndex = m ? parseInt(m[1], 10) : null;
    }
    if (s.volume) {
      if (s.volume.level != null) this.state.volume = s.volume.level;
      if (s.volume.muted  != null) this.state.muted  = s.volume.muted;
    }
    if (this._onStateChange) this._onStateChange({ ...this.state });
  }

  control(action, value) {
    return new Promise((resolve, reject) => {
      if (!this.player && action !== 'stop') return reject(new Error('No active player'));
      const cb = err => err ? reject(err) : resolve();
      switch (action) {
        case 'play':   this.player.play(cb); break;
        case 'pause':  this.player.pause(cb); break;
        case 'seek':   this.player.seek(value, cb); break;
        case 'volume': this.client.setVolume({ level: value }, cb); break;
        case 'mute':   this.client.setVolume({ muted: value }, cb); break;
        case 'stop':
          if (this._statusInterval) { clearInterval(this._statusInterval); this._statusInterval = null; }
          this.player?.stop(() => {});
          try { this.client?.close(); } catch {}
          this.client = null; this.player = null;
          this.state.connected = false; this.state.status = 'idle';
          resolve(); break;
        default: resolve();
      }
    });
  }

  disconnect() {
    // Tells Chromecast to dismiss the receiver app entirely
    return new Promise(resolve => {
      if (this._statusInterval) { clearInterval(this._statusInterval); this._statusInterval = null; }
      const cleanup = () => {
        try { this.client?.close(); } catch {}
        this.client = null; this.player = null;
        this.state.connected = false; this.state.status = 'idle';
        resolve();
      };
      if (!this.client) return cleanup();
      if (this.player) {
        // client.stop(session, callback) — session required as first arg
        try {
          this.client.stop(this.player, () => cleanup());
        } catch { cleanup(); }
      } else {
        cleanup();
      }
    });
  }


  // Stop media without closing TCP connection (used for LIVE stream pause)
  softStop() {
    return new Promise(resolve => {
      if (!this.player) return resolve();
      if (this._statusInterval) { clearInterval(this._statusInterval); this._statusInterval = null; }
      this.player.stop(err => {
        if (err) console.error('[CastHub] softStop error:', err.message);
        // Keep client + player alive for reloadURL
        resolve();
      });
    });
  }

  // Reload media on existing connection — much faster than full castURL()
  reloadURL(url, title, { duration = 0 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.player) return reject(new Error('No active player'));
      const isHLS       = url.includes('/hls/') || url.endsWith('.m3u8');
      const isRemux     = url.includes('/remux');
      const isSegment   = url.includes('/segment/');
      const contentType = isHLS ? 'application/vnd.apple.mpegurl' : (isRemux || isSegment) ? 'video/x-matroska' : 'video/mp4';
      const streamType  = isRemux ? 'LIVE' : 'BUFFERED';
      const media = { contentId: url, contentType, streamType,
                      metadata: { type:0, metadataType:0, title: title || this.state.title },
                      ...(duration > 0 && { duration }) };
      if (this._statusInterval) { clearInterval(this._statusInterval); this._statusInterval = null; }
      this.player.load(media, { autoplay: true }, (err, status) => {
        if (err) return reject(err);
        this.state.connected = true;
        this.state.status = 'playing';
        this.state.title  = title || this.state.title;
        this._applyStatus(status);
        this._statusInterval = setInterval(() => {
          if (this.player && (this.state.status === 'playing' || this.state.status === 'paused')) {
            this.player.getStatus((err, s) => { if (s && !err) this._applyStatus(s); });
          }
        }, 1000);
        resolve();
      });
    });
  }

  stopMedia() {
    return new Promise(resolve => {
      if (this._statusInterval) { clearInterval(this._statusInterval); this._statusInterval = null; }
      const finish = () => {
        this.state.status    = 'idle';
        this.state.connected = false;
        if (this._onStateChange) this._onStateChange({ ...this.state });
        resolve();
      };
      if (!this.player) return finish();
      this.player.stop(err => {
        if (err) console.error('[CastHub] stopMedia error:', err.message);
        finish();
      });
    });
  }

  getState() { return { ...this.state }; }
}

module.exports = CastManager;
