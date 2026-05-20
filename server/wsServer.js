const { WebSocketServer } = require('ws');

let wss;
let _mobileCommandHandler = null;

function startWSServer() {
  wss = new WebSocketServer({ port: 8766 });

  wss.on('connection', (ws, req) => {
    console.log(`[CastHub] Mobile connected: ${req.socket.remoteAddress}`);

    ws.on('message', (data) => {
      try {
        const cmd = JSON.parse(data.toString());
        _mobileCommandHandler?.(cmd);
      } catch {}
    });

    ws.on('close', () => console.log('[CastHub] Mobile disconnected'));
  });

  console.log('[CastHub] WebSocket server → ws://0.0.0.0:8766');
}

function broadcast(data) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function onMobileCommand(handler) {
  _mobileCommandHandler = handler;
}

function stopWSServer() {
  wss?.close();
}

module.exports = { startWSServer, stopWSServer, broadcast, onMobileCommand };
