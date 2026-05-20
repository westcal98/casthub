# CastHub

Local media caster for Chromecast with mobile remote control.

## Architecture

- **Desktop (Electron)** — file picker, Chromecast discovery, local file server, WebSocket server
- **Mobile PWA** — file browser, playback controls, connects to desktop over LAN

## Setup

From WSL inside the project folder:

```bash
chmod +x setup.sh && ./setup.sh
```

This will:
1. Initialize git and push to GitHub
2. Run `npm install`
3. Deploy the mobile PWA to Cloudflare Pages

## Running

```bash
npm start          # Launch desktop app
```

## Ports

| Port | Purpose |
|------|---------|
| 8765 | File server (video streaming + file browser API) |
| 8766 | WebSocket (mobile remote control) |

> **Windows Firewall** — allow both ports for Private networks.

## Mobile

Open `casthub-mobile.pages.dev` on your phone. Enter the WebSocket address shown in the CastHub desktop sidebar (e.g. `192.168.1.100:8766`) in Settings, tap Connect.
