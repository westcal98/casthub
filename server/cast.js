const { Client, DefaultMediaReceiver } = require('castv2-client');
const { Bonjour } = require('bonjour-service');

class CastManager {
  constructor() {
    this.devices    = [];
    this.client     = null;
    this.player     = null;
    this.state = {
      connected:  false,
      deviceHost: null,
      deviceName: null,
      title:      null,
      status:     'idle',   // idle | playing | paused | buffering
      currentTime: 0,
      duration:    0,
      volume:      1.0,
      muted:       false
    };
  }

  startDiscovery(onUpdate) {
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: 'googlecast' });

    browser.on('up', (svc) => {
      if (this.devices.find(d => d.host === svc.host)) return;
      this.devices.push({
        name: svc.txt?.fn || svc.name,
        host: svc.host,
        port: svc.port || 8009
      });
      console.log(`[CastHub] Device found: ${svc.txt?.fn || svc.name} @ ${svc.host}`);
      onUpdate([...this.devices]);
    });

    browser.on('down', (svc) => {
      this.devices = this.devices.filter(d => d.host !== svc.host);
      onUpdate([...this.devices]);
    });
  }

  castURL(deviceHost, url, title) {
    return new Promise((resolve, reject) => {
      // Disconnect existing session
      if (this.client) {
        try { this.client.close(); } catch {}
        this.client = null;
        this.player = null;
      }

      if (!deviceHost) return reject(new Error('No device selected'));

      this.client = new Client();

      this.client.connect({ host: deviceHost, port: 8009 }, () => {
        this.client.launch(DefaultMediaReceiver, (err, player) => {
          if (err) return reject(err);
          this.player = player;

          const media = {
            contentId:   url,
            contentType: 'video/mp4',
            streamType:  'BUFFERED',
            metadata: { type: 0, metadataType: 0, title }
          };

          player.load(media, { autoplay: true }, (err, status) => {
            if (err) return reject(err);
            this.state.connected  = true;
            this.state.deviceHost = deviceHost;
            this.state.deviceName = this.devices.find(d => d.host === deviceHost)?.name;
            this.state.title      = title;
            this.state.status     = 'playing';
            this._applyStatus(status);

            player.on('status', (s) => this._applyStatus(s));
            resolve();
          });
        });
      });

      this.client.on('error', (err) => {
        console.error('[CastHub] Cast error:', err.message);
        this.state.connected = false;
        reject(err);
      });
    });
  }

  _applyStatus(s) {
    if (!s) return;
    if (s.playerState)      this.state.status      = s.playerState.toLowerCase();
    if (s.currentTime != null) this.state.currentTime = s.currentTime;
    if (s.media?.duration)  this.state.duration    = s.media.duration;
    if (s.volume) {
      if (s.volume.level != null) this.state.volume = s.volume.level;
      if (s.volume.muted  != null) this.state.muted  = s.volume.muted;
    }
  }

  control(action, value) {
    return new Promise((resolve, reject) => {
      if (!this.player && action !== 'stop') return reject(new Error('No active player'));

      const cb = (err) => err ? reject(err) : resolve();

      switch (action) {
        case 'play':   this.player.play(cb);                                       break;
        case 'pause':  this.player.pause(cb);                                      break;
        case 'seek':   this.player.seek(value, cb);                                break;
        case 'volume': this.client.setVolume({ level: value }, cb);                break;
        case 'mute':   this.client.setVolume({ muted: value }, cb);                break;
        case 'stop':
          this.player?.stop(() => {});
          try { this.client?.close(); } catch {}
          this.client = null; this.player = null;
          this.state.connected = false; this.state.status = 'idle';
          resolve();
          break;
        default: resolve();
      }
    });
  }

  getState() { return { ...this.state }; }
}

module.exports = CastManager;
