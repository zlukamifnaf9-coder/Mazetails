import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ КОНСТАНТЫ ============
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const SNAPSHOT_EVERY = 2;
const TILE = 64;

const MAP = [
  '################',
  '#..............#',
  '#..##......##..#',
  '#..##......##..#',
  '#..............#',
  '#......##......#',
  '#......##......#',
  '#..............#',
  '#..##......##..#',
  '#..##......##..#',
  '#..............#',
  '################',
];
const MAP_W = MAP[0].length;
const MAP_H = MAP.length;
const WORLD_W = MAP_W * TILE;
const WORLD_H = MAP_H * TILE;

const TANK_RADIUS = 18;
const TANK_SPEED = 140;
const TANK_TURN = 2.8;
const BULLET_SPEED = 420;
const BULLET_RADIUS = 4;
const BULLET_LIFE = 3;
const FIRE_COOLDOWN = 0.6;
const TANK_HP = 100;
const BULLET_DMG = 25;
const RESPAWN_DELAY = 2000;

// ============ HTTP (раздаёт клиент) ============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, 'public', safePath);

  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ============ КАРТА / КОЛЛИЗИИ ============
function isWall(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return true;
  return MAP[ty][tx] === '#';
}

function resolveCollision(x, y, r) {
  const minTx = Math.floor((x - r) / TILE);
  const maxTx = Math.floor((x + r) / TILE);
  const minTy = Math.floor((y - r) / TILE);
  const maxTy = Math.floor((y + r) / TILE);

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!isWall(tx, ty)) continue;
      const rx = tx * TILE;
      const ry = ty * TILE;
      const cx = Math.max(rx, Math.min(x, rx + TILE));
      const cy = Math.max(ry, Math.min(y, ry + TILE));
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < r * r) {
        const d = Math.sqrt(d2) || 0.0001;
        const overlap = r - d;
        x += (dx / d) * overlap;
        y += (dy / d) * overlap;
      }
    }
  }

  x = Math.max(r, Math.min(WORLD_W - r, x));
  y = Math.max(r, Math.min(WORLD_H - r, y));
  return { x, y };
}

function bulletHitsWall(x, y) {
  return isWall(Math.floor(x / TILE), Math.floor(y / TILE));
}

// ============ ИГРОК ============
class Player {
  constructor(id) {
    this.id = id;
    this.x = 0; this.y = 0;
    this.angle = 0;
    this.turret = 0;
    this.hp = TANK_HP;
    this.alive = true;
    this.input = { w: 0, a: 0, s: 0, d: 0 };
    this.aim = 0;
    this.shooting = false;
    this.cooldown = 0;
    this.respawnAt = 0;
    this.spawn();
  }

  spawn() {
    for (let tries = 0; tries < 300; tries++) {
      const tx = 1 + Math.floor(Math.random() * (MAP_W - 2));
      const ty = 1 + Math.floor(Math.random() * (MAP_H - 2));
      if (!isWall(tx, ty)) {
        this.x = tx * TILE + TILE / 2;
        this.y = ty * TILE + TILE / 2;
        this.angle = Math.random() * Math.PI * 2;
        this.turret = this.angle;
        this.hp = TANK_HP;
        this.alive = true;
        return;
      }
    }
  }

  update(dt, world, now) {
    if (!this.alive) {
      if (this.respawnAt && now >= this.respawnAt) {
        this.respawnAt = 0;
        this.spawn();
      }
      return;
    }

    this.cooldown = Math.max(0, this.cooldown - dt);

    if (this.input.a) this.angle -= TANK_TURN * dt;
    if (this.input.d) this.angle += TANK_TURN * dt;

    let move = 0;
    if (this.input.w) move += 1;
    if (this.input.s) move -= 1;

    if (move !== 0) {
      const nx = this.x + Math.cos(this.angle) * TANK_SPEED * move * dt;
      const ny = this.y + Math.sin(this.angle) * TANK_SPEED * move * dt;
      const r = resolveCollision(nx, ny, TANK_RADIUS);
      this.x = r.x;
      this.y = r.y;
    }

    this.turret = this.aim;

    if (this.shooting && this.cooldown <= 0) {
      this.shoot(world);
      this.cooldown = FIRE_COOLDOWN;
    }
  }

  shoot(world) {
    const bx = this.x + Math.cos(this.turret) * (TANK_RADIUS + 6);
    const by = this.y + Math.sin(this.turret) * (TANK_RADIUS + 6);
    world.bullets.push({
      id: world.nextBulletId++,
      x: bx, y: by,
      vx: Math.cos(this.turret) * BULLET_SPEED,
      vy: Math.sin(this.turret) * BULLET_SPEED,
      owner: this.id,
      life: BULLET_LIFE,
    });
  }

  damage(amount, world, now) {
    if (!this.alive) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.respawnAt = now + RESPAWN_DELAY;
      this.input = { w: 0, a: 0, s: 0, d: 0 };
      this.shooting = false;
      world.broadcast({ type: 'death', id: this.id });
    }
  }

  serialize() {
    return {
      id: this.id,
      x: Math.round(this.x * 10) / 10,
      y: Math.round(this.y * 10) / 10,
      angle: Math.round(this.angle * 100) / 100,
      turret: Math.round(this.turret * 100) / 100,
      hp: this.hp,
      alive: this.alive,
    };
  }
}

// ============ МИР ============
class World {
  constructor() {
    this.players = new Map();
    this.bullets = [];
    this.nextBulletId = 1;
    this.tick = 0;
    this.wss = null;
  }

  broadcast(obj, exceptId = null) {
    if (!this.wss) return;
    const msg = JSON.stringify(obj);
    for (const client of this.wss.clients) {
      if (client.readyState !== 1) continue;
      if (client.playerId === exceptId) continue;
      client.send(msg);
    }
  }

  addPlayer(id) {
    const p = new Player(id);
    this.players.set(id, p);
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  update(dt, now) {
    for (const p of this.players.values()) p.update(dt, this, now);

    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;

      let dead = false;

      if (b.life <= 0) dead = true;
      else if (bulletHitsWall(b.x, b.y)) dead = true;
      else {
        for (const p of this.players.values()) {
          if (!p.alive || p.id === b.owner) continue;
          const dx = p.x - b.x;
          const dy = p.y - b.y;
          const rr = TANK_RADIUS + BULLET_RADIUS;
          if (dx * dx + dy * dy < rr * rr) {
            p.damage(BULLET_DMG, this, now);
            this.broadcast({ type: 'hit', id: p.id, hp: p.hp, by: b.owner });
            dead = true;
            break;
          }
        }
      }

      if (dead) this.bullets.splice(i, 1);
    }

    this.tick++;
  }

  snapshot() {
    return {
      type: 'state',
      tick: this.tick,
      players: [...this.players.values()].map(p => p.serialize()),
      bullets: this.bullets.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), owner: b.owner })),
    };
  }
}

// ============ СЕТЬ ============
const world = new World();
const wss = new WebSocketServer({ server });
world.wss = wss;

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).slice(2, 8);
  ws.playerId = id;
  const player = world.addPlayer(id);

  console.log(`[+] ${id} connected (${wss.clients.size} online)`);

  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    map: MAP,
    tile: TILE,
    worldW: WORLD_W,
    worldH: WORLD_H,
    config: {
      tankRadius: TANK_RADIUS,
      tankSpeed: TANK_SPEED,
      tankTurn: TANK_TURN,
      fireCooldown: FIRE_COOLDOWN,
      bulletSpeed: BULLET_SPEED,
    },
  }));

  world.broadcast({ type: 'playerJoined', player: player.serialize() }, id);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'input') {
      const p = world.players.get(id);
      if (!p) return;
      p.input = {
        w: msg.keys?.w ? 1 : 0,
        a: msg.keys?.a ? 1 : 0,
        s: msg.keys?.s ? 1 : 0,
        d: msg.keys?.d ? 1 : 0,
      };
      if (typeof msg.aim === 'number' && Number.isFinite(msg.aim)) {
        p.aim = msg.aim;
      }
      p.shooting = !!msg.shooting;
    }
  });

  ws.on('close', () => {
    world.removePlayer(id);
    world.broadcast({ type: 'playerLeft', id });
    console.log(`[-] ${id} disconnected (${wss.clients.size} online)`);
  });

  ws.on('error', (err) => {
    console.error(`[!] ${id} error:`, err.message);
  });
});

// ============ ИГРОВОЙ ЦИКЛ ============
setInterval(() => {
  const now = Date.now();
  world.update(DT, now);

  if (world.tick % SNAPSHOT_EVERY === 0) {
    world.broadcast(world.snapshot());
  }
}, DT * 1000);

// ============ СТАРТ ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tanks server: http://localhost:${PORT}`);
  console.log(`Tick rate: ${TICK_RATE} Hz, snapshot every ${SNAPSHOT_EVERY} ticks`);
  console.log(`Map: ${MAP_W}x${MAP_H} tiles, world ${WORLD_W}x${WORLD_H}px`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.close();
  server.close(() => process.exit(0));
});
