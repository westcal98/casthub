# CastHub — Project Reference Brief
> Last updated: May 24, 2026. Use this to resume development without re-explaining history.

---

## What It Is
Electron desktop app for casting local MKV/HEVC video files to Chromecast. Goal: match Airflow's performance (fast play, seamless seeking, proper audio/subtitle handling). Built with vanilla Node.js, Express file server, castv2-client, and a registered Custom Receiver.

---

## Key Identifiers

| Item | Value |
|---|---|
| **Repo** | `github.com/westcal98/casthub` (branch: `master`) |
| **Project path** | `C:\Users\westc\GitProjects\casthub\` |
| **Custom Receiver URL** | `casthub-receiver.pages.dev` |
| **Custom Receiver App ID** | `E8C19FEC` — do NOT change this |
| **Mobile PWA** | `casthub-mobile.pages.dev` |
| **Both Pages** | Connected to GitHub — auto-deploy on `git push` |
| **Chromecast** | Serial `7A06CY163Z`, Bedroom TV |
| **Local IP** | `192.168.1.155` (Wi-Fi) — always skip `10.x.x.x` (PIA VPN wgpia0) |
| **File server port** | `8765` |
| **WebSocket port** | `8766` |

---

## File Structure

```
C:\Users\westc\GitProjects\casthub\
  main.js           — Electron main, IPC handlers, buildCastURL, live tracking, position save
  logger.js         — File logging: patches console.*, rotating log in logs/, exports logPath
  preload.js        — contextBridge exposing castHub API to renderer
  test.js           — Headless integration test (node test.js) — 5 WSL-safe steps
  server/
    cast.js         — CastManager, CastHubReceiver (APP_ID E8C19FEC), castURL, reconnect
    fileServer.js   — Express: /transcode, /remux, /hls/*, getStreamInfo, QSV detection
    wsServer.js     — WebSocket server for mobile remote
  src/
    index.html      — Desktop UI (includes resume-notice bar)
    renderer.js     — Queue, controls, applyState, resume-from-position flow
    styles.css
  receiver/         — Custom Receiver HTML (auto-deploys to casthub-receiver.pages.dev)
  mobile/           — Mobile PWA (auto-deploys to casthub-mobile.pages.dev)
  logs/             — Session log files (casthub-YYYY-MM-DDTHH-MM-SS.log, max 5 kept)
```

---

## Test Files

| File | Video | Audio | Subtitle | Route |
|---|---|---|---|---|
| `28.Years.Later.The.Bone.Temple.2026.1080p.WEBRip.10Bit.DDP.5.1.x265-NeoNoir.mkv` | HEVC | EAC3 (5.1) | SSA (English) | HLS |
| `Creation of the Gods I Kingdom of Storms 2023 1080p Chinese WEB-DL HEVC x265 5.1 BONE.mkv` | HEVC | AAC (Chinese 5.1) | SSA | HLS |

test.js uses `28.Years.Later` and is WSL-safe (skips Chromecast network tests in WSL2).

---

## Airflow Architecture Analysis (Ground Truth)

Airflow (`C:\Program Files\Airflow\`) is a **native C++ Qt5 app**, not Electron. Key findings from reading its installed files and logs:

### Process model
5 separate processes launched by `Airflow.exe`:
- `airflow_ui.dll` — Qt5 GUI
- `media_analyzer` + `media_analyzer_impl` — stream probing (ffprobe equivalent)
- `airflow_server.dll` — HTTPS server on **port 42015** + Google Cast protocol
- `transcoder.dll` + `transcoding.dll` — GStreamer transcode pipeline

### Transcoding engine
- **GStreamer** (50+ plugin DLLs including `mpegtsmux2.dll`, `gstx264.dll`, `gstmatroska.dll`)
- **Intel Quick Sync Video** for hardware **decode** (`quick_sync_video_decoder` seen in logs)
- Hardware decode is the key to instant seek response: finding keyframe + decoding to seek point is near-instant on QSV vs several seconds in software
- Also uses `h264_qsv` for encode — 3-5x faster than libx264
- Outputs **MPEG-TS piped directly** to HTTPS response — no disk writes, no HLS overhead
- `subtitles.dll` (2.3MB) burns ASS/SSA/SRT subs directly into video frames

### Why Airflow is "immediately responsive"
1. **Direct MPEG-TS pipe**: GStreamer writes bytes directly to HTTP response. Chromecast starts receiving within ~1s of play. No segment files, no M3U8 polling.
2. **QSV hardware decode**: seek to keyframe is near-instant
3. **QSV hardware encode**: first bytes ready much faster than libx264
4. **Reconnect logic**: `Unexpected disconnect during playback - attempting to reconnect in 10 seconds` (seen in logs)

### Server details
- HTTPS on port 42015 (generates self-signed cert on first run via `certificate.pem`)
- mDNS/Bonjour registration so Chromecast can discover it
- Registers itself as a Bonjour service (not just passive server)
- `LastPositionManager.db` — SQLite database tracking resume position per file
- `Playback.prefs` — JSON with per-file audio stream + subtitle preferences

### CastHub gaps vs Airflow
| Feature | Airflow | CastHub |
|---|---|---|
| Startup latency | ~1-2s (direct pipe) | ~3-4s (HLS 3s segments, live-streamed) |
| Seek latency | ~1-2s (QSV decode) | ~3-5s (new ffmpeg process) |
| Hardware encode | QSV h264_qsv | libx264 (QSV auto-detected if available) |
| Subtitle rendering | Burns ASS/SSA into video | Strips subtitles (-sn flag) |
| Resume position | SQLite per-file | JSON file per-file (casthub_positions.json) |
| Reconnect | Yes (10s retry) | Yes (5s retry) |
| HTTPS | Yes (self-signed) | HTTP only (not blocking) |

---

## Architecture Decisions

### Streaming Pipeline
| File Type | Detection | Route | streamType |
|---|---|---|---|
| EAC3 audio OR any subtitle track | `getStreamInfo()` ffmpeg probe | HLS session (`/hls/:id/master.m3u8`) | **BUFFERED** |
| Clean (AAC, no subtitles) | same | `/transcode` with range support | BUFFERED |

**Why BUFFERED for HLS**: Changed from LIVE on 2026-05-24. BUFFERED enables native `player.pause()` and `player.play()` commands via castv2-client. ExoPlayer (Chromecast) handles EVENT-type HLS playlists correctly with BUFFERED. We pass `duration` in the media object so Chromecast knows total length.

### Key Rules — Do NOT Break These
- **Never** change Custom Receiver APP_ID `E8C19FEC`
- `getStreamInfo()` must check `_err?.stderr` not just `stderr` — Windows/Electron execFile quirk causes ffmpeg output to land in the error object
- HLS uses `streamType: 'BUFFERED'` (not LIVE) so native pause/play work
- Native `player.pause()` IS used for HLS pause — keeps video frame on TV instead of showing idle screen
- `airflow.capture.pcapng` is in `.gitignore` — do not commit it

### getStreamInfo Fix (Critical — Windows/Electron)
```javascript
execFile(ffmpegPath, ['-hide_banner', '-i', filePath], (_err, stdout, stderr) => {
  // Must check _err.stderr — on Windows/Electron ffmpeg exits code 1
  // and output lands in _err.stderr not stderr parameter
  const info = (_err?.stderr || '') + (stderr || '') + (_err?.stdout || '') + (stdout || '');
  if (info.length < 50) {
    return resolve({ hasEAC3: true, hasSSA: false, duration: 0 }); // safe default
  }
  const hasEAC3 = /Stream.*Audio.*(eac3|ac3b|e-ac3)/i.test(info);
  const hasSSA  = /Stream.*Subtitle/i.test(info);
  ...
});
```

### HLS Session Pipeline
- `generateSession(filePath, seekSeconds)` spawns ffmpeg:
  - Hardware: `-hwaccel auto -c:v h264_qsv -preset veryfast -global_quality 26` (if QSV detected)
  - Software fallback: `-c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p`
  - Audio: `EAC3→AAC -ac 2 -b:a 256k` (stereo downmix required — Chromecast rejects 5.1 AAC in MPEG-TS)
  - Segments: `3s`, `hls_list_size 0`, `hls_playlist_type event`
- QSV detection: synchronous test encode of 2 frames at startup; `useQSV` flag set once
- `master.m3u8` declares `CODECS="avc1.640028,mp4a.40.2"` so Chromecast knows it can play
- `playlist.m3u8` endpoint: serves cached last-good playlist to survive mid-write truncation; synthesises a one-entry playlist as soon as seg00000.ts starts writing (fast startup)
- Segment endpoint: streams bytes live as ffmpeg writes them; finalises when next segment file appears
- Session cleanup: `stopSession(id)` kills ffmpeg + schedules temp dir removal after 4s

### Pause/Resume for HLS Streams
- **Pause**: `livePausedAt = getLiveTime()`, stops liveTimer, calls `castManager.control('pause')` → native PAUSE sent to Chromecast → video frame frozen on TV screen. Falls back to `softStop()` if native pause rejected.
- **Resume (play)**: `castManager.control('play')` → Chromecast resumes same HLS session, `startLiveTimer(resumeAt)` restarts local time tracking
- **Seek**: stop old session → new `generateSession` at seekTo → `reloadURL` or `castURL` fallback → `startLiveTimer(seekTo)`
- **Stop ⏹**: `stopMedia()` — stops player, marks disconnected
- **Stop Casting**: `disconnect()` — full disconnect, Chromecast returns to home

### Live Time Tracking
HLS streams report `currentTime` relative to session start (always 0-based). Main.js tracks absolute movie time locally:
```
liveSeekBase + (Date.now() - liveStartedAt) / 1000
```
Variables: `liveTimer` (500ms tick), `liveSeekBase`, `liveStartedAt`, `livePausedAt`, `liveDuration`
Functions: `startLiveTimer(seekOffset, duration)`, `stopLiveTimer()`, `getLiveTime()`

### Reconnect Logic
- `cast.js`: error handler checks `this.state.connected` — if true, it's a post-connect drop; fires `_onStateChange` with `_connectionLost: true`
- `main.js` `_onStateChange`: detects `_connectionLost`, waits 5s, creates new HLS session at current `getLiveTime()`, calls `castURL` to reconnect

### Resume Last Position
- Storage: `${app.getPath('userData')}/casthub_positions.json`
- Key: MD5 of file path
- Saves on: pause, seek, stop, disconnect, every 30s during playback
- Threshold: position > 60s AND < 95% of duration
- UX: auto-resumes from saved position + shows "Resumed from X:XX | Start over" notice for 8s

### Idle State Debounce (renderer.js)
Seeks fire IDLE INTERRUPTED/CANCELLED from Chromecast before new session starts PLAYING. Without debounce this resets the UI to dropzone mid-seek. Fix: 2.5s debounce before `showIdle()`. Genuine idle (stream ended, Stop pressed) still shows correctly.

### File Logging (logger.js)
- Must be `require('./logger')` as the **first** require in main.js and test.js
- Patches `console.log/error/warn` to tee to a timestamped log file in `logs/`
- Keeps at most 5 log files (oldest deleted on startup)
- Exports `logPath` so tests can print the full log path in their summary

### Dead Code (safe to remove later)
`startSegmentSession`, `stopSegmentSession`, `/session/start`, `/segment/:id/:index` routes, and `currentSessionId` branches in main.js — old MKV segmented remux path, replaced entirely by HLS. Not yet removed.

---

## Integration Test (test.js)

Run with `node test.js` from the project root (no Electron needed).
WSL-safe: steps 1-5 run in WSL; steps 6-12 (Chromecast network tests) skipped with a warning.

**Steps (WSL-safe subset):**
1. File server + WebSocket server start
2. Test file found on disk (`28.Years.Later`, tries WSL + Windows paths)
3. ffprobe: detects EAC3 audio (confirms HLS code path will activate)
4. Chromecast device found in device cache
5. HLS session created (`generateSession`)

**Full steps (Windows host only):**
6-12: cast, PLAYING, 15s stable, seek to 5:00, 10s stable after seek, volume, disconnect

**Requirements:** App must have been opened once to populate device cache. Test file must exist at one of the two candidate paths.

---

## Current Status (May 24, 2026)

### Working ✅
- Audio + video on all test files via HLS (H.264 + AAC stereo, EVENT playlist)
- Pause: native Chromecast PAUSE command — video frame frozen on TV, app stays on controls
- Play (resume from pause): native Chromecast PLAY — instant resume, no new HLS session needed
- Seek / back 10s / fwd 30s: new HLS session at target time, UI stays on controls during transition (2.5s idle debounce)
- Time bar: updates every 500ms (liveTimer) + 1s CC status poll (even when paused)
- Intel Quick Sync auto-detected at startup; falls back to libx264 if unavailable
- Resume last position: auto-resumes with 8s "Start over" notice
- Reconnect: 5s retry on dropped Chromecast TCP connection
- Queue persistence (localStorage + IPC backup)
- Stop Casting properly disconnects and dismisses Chromecast receiver
- File logging with 5-file rotation
- Headless integration test (WSL-safe)
- Receiver + mobile PWA auto-deploy via Cloudflare Pages

### Known Gaps ❌
- **Subtitle rendering**: SSA/ASS subtitles are stripped (`-sn`). Airflow burns them into video. Implementing requires `-vf subtitles=...` filter + complex font handling.
- **Direct MPEG-TS streaming**: Airflow pipes transcode output directly — no HLS overhead, ~1-2s startup. CastHub uses HLS (necessary for native pause/buffered seeking). Gap: ~1-2s additional startup latency.
- **HTTPS**: Airflow uses HTTPS on port 42015. CastHub uses HTTP. Not currently blocking anything.
- **Dead code**: Segmented-MKV session code still in fileServer.js / main.js, not yet cleaned up.

---

## Git Workflow
```bash
cd /mnt/c/Users/westc/GitProjects/casthub
git add -A && git commit -m "description" && git push
# Receiver + mobile auto-deploy via Cloudflare Pages Git connection
```
