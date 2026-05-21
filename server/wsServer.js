const { WebSocketServer } = require('ws');
let wss, _mobileCommandHandler = null, _browseHandler = null, _getState = null;

function startWSServer() {
  wss = new WebSocketServer({ port: 8766 });
  wss.on('connection', (ws, req) => {
    console.log(`[CastHub] Mobile connected: ${req.socket.remoteAddress}`);
    if (_getState) ws.send(JSON.stringify({ type:'state', ..._getState() }));
    ws.on('message', (data) => {
      try {
        const cmd = JSON.parse(data.toString());
        if (cmd.action === 'browse') {
          _browseHandler?.(cmd, (result) => { ws.send(JSON.stringify({ type:'browse', requestId:cmd.requestId, ...result })); });
        } else { _mobileCommandHandler?.(cmd); }
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

function onMobileCommand(h) { _mobileCommandHandler = h; }
function onBrowseRequest(h) { _browseHandler = h; }
function setStateGetter(fn) { _getState = fn; }
function stopWSServer()     { wss?.close(); }

module.exports = { startWSServer, stopWSServer, broadcast, onMobileCommand, onBrowseRequest, setStateGetter };
