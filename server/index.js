const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const game = new Game();
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let playerId = null;
  // Jeder startet als Zuschauer -> das Menü zeigt die laufende Arena
  game.addSpectator(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'join' && playerId === null) {
      playerId = game.addHuman(ws, msg.name, msg.color);
      ws.send(JSON.stringify({ type: 'welcome', id: playerId }));
    } else if (msg.type === 'input' && playerId !== null) {
      game.setInput(playerId, msg);
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    }
  });

  ws.on('close', () => {
    game.removeSpectator(ws);
    if (playerId !== null) game.removePlayer(playerId);
  });
});

game.start();

server.listen(PORT, () => {
  console.log(`\n  DASH ARENA läuft!\n`);
  console.log(`  Lokal:   http://localhost:${PORT}`);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) {
        console.log(`  WLAN:    http://${i.address}:${PORT}`);
      }
    }
  }
  console.log('');
});
