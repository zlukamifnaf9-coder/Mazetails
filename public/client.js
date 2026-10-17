const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');

let MAP = [], TILE = 64, WORLD_W = 0, WORLD_H = 0;
let myId = null;
let players = new Map();
let targetPlayers = new Map();
let bullets = [];

// Настройки по умолчанию (обновятся с сервера)
let CFG = {
  tankRadius: 18,
  tankSpeed: 140,
  tankTurn: 2.8,
  fireCooldown: 0.6,
  bulletSpeed: 420,
};

const keys = {};
let mouse = { x: 0, y: 0, down: false };
const camera = { x: 0, y: 0 };

window.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === ' ') e.preventDefault();
});
window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);
canvas.addEventListener('mousemove', e => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
});
canvas.addEventListener('mousedown', () => mouse.down = true);
canvas.addEventListener('mouseup', () => mouse.down = false);

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// ============ WS ============
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${proto}//${location.host}`);

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  if (msg.type === 'welcome') {
    myId = msg.id;
    MAP = msg.map; TILE = msg.tile;
    WORLD_W = msg.worldW; WORLD_H = msg.worldH;
    if (msg.config) CFG = { ...CFG, ...msg.config };
    hud.textContent = `Ты: ${myId}`;
  } else if (msg.type === 'playerJoined') {
    const p = msg.player;
    players.set(p.id, { ...p });
    targetPlayers.set(p.id, { ...p });
  } else if (msg.type === 'playerLeft') {
    players.delete(msg.id);
    targetPlayers.delete(msg.id);
  } else if (msg.type === 'state') {
    for (const p of msg.players) {
      targetPlayers.set(p.id, p);
      if (!players.has(p.id)) players.set(p.id, { ...p });
    }
    for (const id of [...players.keys()]) {
      if (!msg.players.find(p => p.id === id)) {
        players.delete(id);
        targetPlayers.delete(id);
      }
    }
    bullets = msg.bullets;
  } else if (msg.type === 'hit') {
    const p = players.get(msg.id);
    if (p) { p.hp = msg.hp; p.hitFlash = 0.15; }
  } else if (msg.type === 'death') {
    const p = players.get(msg.id);
    if (p) { p.alive = false; }
  }
};

// ============ ОТПРАВКА ИНПУТА ============
let aimAngle = 0;

function sendInput() {
  if (ws.readyState !== 1) return;
  const me = players.get(myId);
  if (me) {
    const dx = mouse.x - canvas.width / 2;
    const dy = mouse.y - canvas.height / 2;
    aimAngle = Math.atan2(dy, dx);
  }
  ws.send(JSON.stringify({
    type: 'input',
    keys: {
      w: keys['w'] ? 1 : 0,
      a: keys['a'] ? 1 : 0,
      s: keys['s'] ? 1 : 0,
      d: keys['d'] ? 1 : 0,
    },
    aim: aimAngle,
    shooting: mouse.down,
  }));
}
setInterval(sendInput, 1000 / 30);

// ============ ПРЕДСКАЗАНИЕ СВОЕГО ТАНКА ============
function isWall(tx, ty) {
  if (tx < 0 || ty < 0 || ty >= MAP.length || tx >= MAP[0].length) return true;
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
      const rx = tx * TILE, ry = ty * TILE;
      const cx = Math.max(rx, Math.min(x, rx + TILE));
      const cy = Math.max(ry, Math.min(y, ry + TILE));
      const dx = x - cx, dy = y - cy;
      const d2 = dx*dx + dy*dy;
      if (d2 < r*r) {
        const d = Math.sqrt(d2) || 0.0001;
        const ov = r - d;
        x += (dx/d) * ov;
        y += (dy/d) * ov;
      }
    }
  }
  return { x, y };
}

function predictLocal(dt) {
  const me = players.get(myId);
  if (!me || !me.alive) return;

  if (keys['a']) me.angle -= CFG.tankTurn * dt;
  if (keys['d']) me.angle += CFG.tankTurn * dt;

  let move = 0;
  if (keys['w']) move += 1;
  if (keys['s']) move -= 1;

  const nx = me.x + Math.cos(me.angle) * CFG.tankSpeed * move * dt;
  const ny = me.y + Math.sin(me.angle) * CFG.tankSpeed * move * dt;
  const r = resolveCollision(nx, ny, CFG.tankRadius);
  me.x = r.x;
  me.y = r.y;
  me.turret = aimAngle;
}

// ============ ИНТЕРПОЛЯЦИЯ ЧУЖИХ ============
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function interpolate(dt) {
  const t = Math.min(1, dt * 12);
  for (const [id, p] of players) {
    const target = targetPlayers.get(id);
    if (!target) continue;
    if (id === myId) {
      p.x += (target.x - p.x) * 0.1;
      p.y += (target.y - p.y) * 0.1;
      p.angle = lerpAngle(p.angle, target.angle, 0.1);
      p.hp = target.hp;
      p.alive = target.alive;
    } else {
      p.x += (target.x - p.x) * t;
      p.y += (target.y - p.y) * t;
      p.angle = lerpAngle(p.angle, target.angle, t);
      p.turret = lerpAngle(p.turret ?? target.turret, target.turret, t);
      p.hp = target.hp;
      p.alive = target.alive;
    }
  }
}

// ============ РЕНДЕР ============
function drawMap() {
  const camX = camera.x;
  const camY = camera.y;
  const startTx = Math.max(0, Math.floor(camX / TILE));
  const endTx = Math.min(MAP[0].length - 1, Math.ceil((camX + canvas.width) / TILE));
  const startTy = Math.max(0, Math.floor(camY / TILE));
  const endTy = Math.min(MAP.length - 1, Math.ceil((camY + canvas.height) / TILE));

  for (let ty = startTy; ty <= endTy; ty++) {
    for (let tx = startTx; tx <= endTx; tx++) {
      const sx = tx * TILE - camX;
      const sy = ty * TILE - camY;
      if (MAP[ty][tx] === '#') {
        ctx.fillStyle = '#3a3a3a';
        ctx.fillRect(sx, sy, TILE, TILE);
        ctx.strokeStyle = '#555';
        ctx.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
      } else {
        ctx.fillStyle = '#222';
        ctx.fillRect(sx, sy, TILE, TILE);
      }
    }
  }
}

function drawTank(p, isMe) {
  const sx = p.x - camera.x;
  const sy = p.y - camera.y;

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(p.angle);
  const baseColor = !p.alive ? '#555' : (isMe ? '#4a9eff' : '#e05a5a');
  ctx.fillStyle = (p.hitFlash > 0) ? '#ffffff' : baseColor;
  ctx.fillRect(-20, -14, 40, 28);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.strokeRect(-20, -14, 40, 28);
  ctx.restore();

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(p.turret ?? p.angle);
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, -4, 28, 8);
  ctx.beginPath();
  ctx.arc(0, 0, 12, 0, Math.PI * 2);
  ctx.fillStyle = !p.alive ? '#444' : (isMe ? '#2e6fb8' : '#a83a3a');
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.stroke();
  ctx.restore();

  if (p.alive) {
    ctx.fillStyle = '#000';
    ctx.fillRect(sx - 22, sy - 32, 44, 6);
    ctx.fillStyle = p.hp > 50 ? '#3ec46d' : p.hp > 25 ? '#e0b040' : '#e05050';
    ctx.fillRect(sx - 22, sy - 32, 44 * (p.hp / 100), 6);
  }
}

function drawBullet(b) {
  ctx.beginPath();
  ctx.arc(b.x - camera.x, b.y - camera.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffcc33';
  ctx.fill();
}

let lastFrame = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  for (const p of players.values()) {
    if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - dt);
  }

  predictLocal(dt);
  interpolate(dt);

  const me = players.get(myId);
  if (me) {
    camera.x += (me.x - canvas.width / 2 - camera.x) * 0.15;
    camera.y += (me.y - canvas.height / 2 - camera.y) * 0.15;
  }

  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawMap();
  for (const b of bullets) drawBullet(b);
  for (const [id, p] of players) drawTank(p, id === myId);

  const me2 = players.get(myId);
  if (me2) {
    ctx.strokeStyle = '#fff8';
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mouse.x - 14, mouse.y);
    ctx.lineTo(mouse.x + 14, mouse.y);
    ctx.moveTo(mouse.x, mouse.y - 14);
    ctx.lineTo(mouse.x, mouse.y + 14);
    ctx.stroke();
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

setInterval(() => {
  const me = players.get(myId);
  if (me) hud.textContent = `Ты: ${myId} | HP: ${Math.round(me.hp)} | Игроков: ${players.size}`;
}, 200);
