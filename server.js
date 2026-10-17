import { WebSocketServer } from 'ws';
import http from 'http';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Mazetail Server is running!');
});

const TICK_RATE = 30;
const players = new Map();

let enemies = [
  { id: 1, type: 'captain', x: 1500, y: 275, hp: 100, maxHp: 100, dir: -1 },
  { id: 2, type: 'captain', x: 3000, y: 340, hp: 100, maxHp: 100, dir: -1 }
];

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).slice(2, 6).toUpperCase();
  ws.playerId = id;

  players.set(id, {
    id: id, x: 200, y: 275, dir: 1, anim: 'idle', hp: 100, activeHero: 'eynar'
  });

  console.log(`[+] Игрок ${id} зашел (Всего: ${players.size})`);

  ws.send(JSON.stringify({ type: 'welcome', id: id, enemies: enemies }));
  broadcast({ type: 'playerJoined', player: players.get(id) }, id);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const p = players.get(id);
      if (!p) return;

      if (msg.type === 'move') {
        p.x = msg.x; p.y = msg.y; p.dir = msg.dir; 
        p.anim = msg.anim; p.activeHero = msg.activeHero;
      }
      if (msg.type === 'attack') {
        // Проверка, попал ли игрок по врагу
        enemies.forEach(e => {
          if (e.hp > 0 && Math.abs(e.x - p.x) < 80 && Math.abs(e.y - p.y) < 60) {
            e.hp -= 25;
            if (e.hp < 0) e.hp = 0;
            broadcast({ type: 'enemyHit', id: e.id, hp: e.hp });
          }
        });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'playerLeft', id: id });
    console.log(`[-] Игрок ${id} вышел`);
  });
});

function broadcast(obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.playerId !== exceptId) {
      client.send(msg);
    }
  }
}

setInterval(() => {
  broadcast({
    type: 'state',
    players: Array.from(players.values()),
    enemies: enemies
  });
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Mazetail Server on port ${PORT}`));
