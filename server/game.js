const { updateBot, BOT_NAMES } = require('./bots');

// ---------- Tuning ----------
const TICK_HZ = 60;
const SEND_EVERY = 1; // 60 Hz Broadcast – fühlt sich deutlich direkter an
const DT = 1 / TICK_HZ;

const C = {
  radius: 28,
  accel: 1500,
  chargeAccelMul: 0.35,
  friction: 1.1, // Basis-Reibung (Eis!)
  walkMax: 360,
  excessDrag: 3.2, // bremst alles über walkMax (nicht während Dash)
  dashMin: 720,
  dashMax: 1450,
  dashTimeMin: 0.2,
  dashTimeMax: 0.34,
  chargeTime: 0.6,
  dashCooldown: 1.2,
  dashBuffer: 0.2,
  hitBase: 1.25,
  hitChargeBonus: 0.65,
  hitMinPower: 380,
  stunTime: 0.35,
  bumpBonus: 90,
  creditWindow: 3.0,
  fallTime: 0.6,
  respawnDelay: 1.3,
  shieldTime: 1.5,
  bounty: 3,
  minEntities: 6,
  pulseCycle: 40,
  perfectWindow: 0.16, // so lange nach Vollladung gilt Loslassen als PERFEKT
  perfectBonus: 1.18,
  hitRefund: 0.35, // Treffer setzt Cooldown fast zurück -> Combos
};

const COLORS = ['#ff4d6d', '#ff9f1c', '#ffd60a', '#2ec4b6', '#3a86ff', '#8338ec', '#ff70a6', '#70e000'];

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

class Game {
  constructor() {
    this.players = new Map();
    this.spectators = new Set();
    this.nextId = 1;
    this.tick = 0;
    this.time = 0; // Sekunden seit Start
    this.events = [];
    this.rosterDirty = true;
    this.baseR = 560;
    this.arenaR = 560;
    this.pulsePhase = 0; // 0 normal, 1 Warnung, 2 geschrumpft
    this.crownId = null;
    this.botTimer = 0;
  }

  start() {
    const start = process.hrtime.bigint();
    let acc = 0;
    let last = start;
    setInterval(() => {
      const now = process.hrtime.bigint();
      acc += Number(now - last) / 1e9;
      last = now;
      let steps = 0;
      while (acc >= DT && steps < 5) {
        this.step();
        acc -= DT;
        steps++;
      }
      if (acc > DT * 5) acc = 0;
    }, 1000 / TICK_HZ / 2);
  }

  // ---------- Spieler ----------
  createPlayer(name, color, isBot) {
    const id = this.nextId++;
    const p = {
      id,
      name,
      color,
      isBot,
      ws: null,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      angle: Math.random() * Math.PI * 2,
      state: 'dead', // alive | falling | dead
      stateAt: 0,
      respawnAt: this.time + (isBot ? Math.random() * 1.5 : 0.2),
      shieldUntil: 0,
      charging: false,
      chargeStart: 0,
      dashCharge: 0,
      dashUntil: 0,
      cooldownUntil: 0,
      queuedDashAt: 0,
      queuedCharge: 0,
      stunUntil: 0,
      lastHitBy: null,
      lastHitAt: -99,
      score: 0,
      kos: 0,
      streak: 0,
      best: 0,
      input: { mx: 0, my: 0, ch: false, ax: 0, ay: 0 },
      bot: isBot ? {} : null,
    };
    this.players.set(id, p);
    this.rosterDirty = true;
    return p;
  }

  addSpectator(ws) {
    this.spectators.add(ws);
    this.rosterDirty = true;
    this.balanceBots(true);
  }

  removeSpectator(ws) {
    if (this.spectators.delete(ws)) this.balanceBots(true);
  }

  addHuman(ws, name, color) {
    this.spectators.delete(ws);
    name = String(name || '').replace(/[<>]/g, '').trim().slice(0, 14) || 'Blob';
    if (!COLORS.includes(color)) color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const p = this.createPlayer(name, color, false);
    p.ws = ws;
    this.balanceBots(true);
    return p.id;
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.crownId === id) this.crownId = null;
    this.rosterDirty = true;
    this.balanceBots(true);
  }

  setInput(id, msg) {
    const p = this.players.get(id);
    if (!p) return;
    const mx = Number(msg.mx) || 0;
    const my = Number(msg.my) || 0;
    const len = Math.hypot(mx, my);
    p.input.mx = len > 1 ? mx / len : mx;
    p.input.my = len > 1 ? my / len : my;
    p.input.ax = Number(msg.ax) || 0;
    p.input.ay = Number(msg.ay) || 0;
    this.handleCharge(p, !!msg.ch);
  }

  handleCharge(p, ch) {
    if (ch && !p.charging) {
      p.charging = true;
      p.chargeStart = Math.max(this.time, p.cooldownUntil);
    } else if (!ch && p.charging) {
      p.charging = false;
      const raw = this.time - p.chargeStart;
      const charge = clamp(raw / C.chargeTime, 0, 1);
      const perfect = raw >= C.chargeTime - 0.02 && raw <= C.chargeTime + C.perfectWindow;
      if (p.state !== 'alive') return;
      if (this.time >= p.cooldownUntil) {
        this.dash(p, charge, perfect);
      } else if (p.cooldownUntil - this.time < C.dashBuffer) {
        p.queuedDashAt = p.cooldownUntil;
        p.queuedCharge = charge;
      }
    }
  }

  dash(p, charge, perfect = false) {
    let dx = p.input.mx;
    let dy = p.input.my;
    if (Math.hypot(dx, dy) < 0.2) {
      dx = p.input.ax;
      dy = p.input.ay;
    }
    if (Math.hypot(dx, dy) < 0.01) {
      dx = Math.cos(p.angle);
      dy = Math.sin(p.angle);
    }
    const l = Math.hypot(dx, dy);
    dx /= l;
    dy /= l;
    const speed = lerp(C.dashMin, C.dashMax, charge) * (perfect ? C.perfectBonus : 1);
    p.perfect = perfect;
    p.vx = dx * speed + p.vx * 0.15;
    p.vy = dy * speed + p.vy * 0.15;
    p.angle = Math.atan2(dy, dx);
    p.dashCharge = charge;
    p.dashUntil = this.time + lerp(C.dashTimeMin, C.dashTimeMax, charge);
    p.cooldownUntil = this.time + C.dashCooldown;
    p.queuedDashAt = 0;
    p.shieldUntil = 0; // Dash beendet Spawn-Schutz
    this.events.push({ k: 'dash', i: p.id, c: Math.round(charge * 100), pf: perfect ? 1 : 0 });
  }

  spawn(p) {
    const R = this.arenaR * 0.62;
    let best = null;
    let bestScore = -1;
    for (let tries = 0; tries < 14; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * R;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      let minD = 1e9;
      for (const o of this.players.values()) {
        if (o === p || o.state !== 'alive') continue;
        minD = Math.min(minD, Math.hypot(o.x - x, o.y - y));
      }
      if (minD > bestScore) {
        bestScore = minD;
        best = { x, y };
      }
    }
    p.x = best.x;
    p.y = best.y;
    p.vx = 0;
    p.vy = 0;
    p.state = 'alive';
    p.stateAt = this.time;
    p.shieldUntil = this.time + C.shieldTime;
    p.lastHitBy = null;
    p.onEdge = false;
    p.dashUntil = 0;
    p.stunUntil = 0;
    p.cooldownUntil = this.time + 0.3;
    p.chargeStart = Math.max(p.chargeStart, p.cooldownUntil);
    p.angle = Math.atan2(-p.y, -p.x);
    this.events.push({ k: 'spawn', i: p.id });
    this.rosterDirty = true;
  }

  // ---------- Bots ----------
  balanceBots(force) {
    const humans = [...this.players.values()].filter((p) => !p.isBot).length;
    const bots = [...this.players.values()].filter((p) => p.isBot);
    const watching = humans + this.spectators.size;
    const target = watching === 0 ? 0 : Math.max(0, C.minEntities - humans);
    if (bots.length < target) {
      const used = new Set(bots.map((b) => b.name));
      for (let i = bots.length; i < target; i++) {
        const free = BOT_NAMES.filter((n) => !used.has(n));
        const name = free[Math.floor(Math.random() * free.length)] || 'Bot';
        used.add(name);
        // möglichst eine Farbe, die noch keiner hat
        const taken = [...this.players.values()].map((o) => o.color);
        const freeCols = COLORS.filter((c) => !taken.includes(c));
        const pool = freeCols.length ? freeCols : COLORS;
        const color = pool[Math.floor(Math.random() * pool.length)];
        this.createPlayer(name, color, true);
      }
    } else if (bots.length > target) {
      // Bots nach und nach entfernen – bevorzugt solche, die gerade nicht leben
      const removable = bots.sort((a, b) => (a.state === 'alive') - (b.state === 'alive') || a.score - b.score);
      const n = force && watching === 0 ? removable.length : 1;
      for (let i = 0; i < n && i < bots.length - target; i++) {
        this.removePlayer(removable[i].id);
      }
    }
  }

  // ---------- Arena ----------
  updateArena() {
    const count = this.players.size;
    const targetBase = clamp(430 + count * 28, 520, 820);
    this.baseR += (targetBase - this.baseR) * 0.01;

    const t = this.time % C.pulseCycle;
    let f = 1;
    let phase = 0;
    if (t >= 30 && t < 32) phase = 1;
    else if (t >= 32 && t < 33.5) {
      phase = 2;
      f = lerp(1, 0.6, easeInOut((t - 32) / 1.5));
    } else if (t >= 33.5 && t < 38.5) {
      phase = 2;
      f = 0.6;
    } else if (t >= 38.5) {
      phase = 3;
      f = lerp(0.6, 1, easeInOut((t - 38.5) / 1.5));
    }
    if (phase !== this.pulsePhase) {
      this.pulsePhase = phase;
      this.events.push({ k: 'pulse', p: phase });
    }
    this.arenaR = this.baseR * f;
  }

  // ---------- Hauptschleife ----------
  step() {
    this.tick++;
    this.time += DT;
    const now = this.time;

    this.botTimer += DT;
    if (this.botTimer > 1.5) {
      this.botTimer = 0;
      this.balanceBots(false);
    }

    this.updateArena();

    // Bots denken
    for (const p of this.players.values()) {
      if (p.isBot) {
        const ch = updateBot(p, this, now, C);
        this.handleCharge(p, ch);
      }
    }

    // Bewegung
    for (const p of this.players.values()) {
      if (p.state === 'dead') {
        if (now >= p.respawnAt) this.spawn(p);
        continue;
      }
      if (p.state === 'falling') {
        p.vx *= 0.96;
        p.vy *= 0.96;
        p.x += p.vx * DT;
        p.y += p.vy * DT;
        if (now - p.stateAt > C.fallTime) {
          p.state = 'dead';
          p.stateAt = now;
        }
        continue;
      }

      if (p.queuedDashAt && now >= p.queuedDashAt) this.dash(p, p.queuedCharge);

      const dashing = now < p.dashUntil;
      const stunned = now < p.stunUntil;
      if (!stunned && !dashing) {
        const mul = p.charging ? C.chargeAccelMul : 1;
        p.vx += p.input.mx * C.accel * mul * DT;
        p.vy += p.input.my * C.accel * mul * DT;
      }
      const fr = 1 - C.friction * DT * (p.charging ? 2.2 : 1);
      p.vx *= fr;
      p.vy *= fr;
      const sp = Math.hypot(p.vx, p.vy);
      if (!dashing && sp > C.walkMax) {
        const ns = C.walkMax + (sp - C.walkMax) * (1 - C.excessDrag * DT);
        p.vx *= ns / sp;
        p.vy *= ns / sp;
      }
      p.x += p.vx * DT;
      p.y += p.vy * DT;

      // Blickrichtung
      if (!dashing) {
        let tx = p.input.mx;
        let ty = p.input.my;
        if (Math.hypot(tx, ty) < 0.2) {
          tx = p.input.ax;
          ty = p.input.ay;
        }
        if (Math.hypot(tx, ty) > 0.05) {
          const ta = Math.atan2(ty, tx);
          let d = ta - p.angle;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          p.angle += d * Math.min(1, 14 * DT);
        }
      }
    }

    this.collide(now);

    // Absturz + "KNAPP!"-Rettungen
    for (const p of this.players.values()) {
      if (p.state !== 'alive') continue;
      const d = Math.hypot(p.x, p.y);
      if (d > this.arenaR) {
        this.fall(p, now);
        continue;
      }
      if (d > this.arenaR * 0.88 && now - p.lastHitAt < 1.5) p.onEdge = true;
      else if (p.onEdge && d < this.arenaR * 0.72) {
        p.onEdge = false;
        this.events.push({ k: 'clutch', i: p.id });
      }
    }

    this.updateCrown();

    if (this.tick % SEND_EVERY === 0) this.broadcast();
  }

  collide(now) {
    const list = [...this.players.values()].filter((p) => p.state === 'alive' && now >= p.shieldUntil);
    const r2 = C.radius * 2;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d >= r2 || d === 0) continue;
        const nx = dx / d;
        const ny = dy / d;
        const overlap = (r2 - d) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;

        const van = a.vx * nx + a.vy * ny;
        const vbn = b.vx * nx + b.vy * ny;
        const rel = van - vbn;
        if (rel <= 0) continue;

        const aDash = now < a.dashUntil;
        const bDash = now < b.dashUntil;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;

        if (aDash && bDash) {
          // CLASH – beide fliegen zurück
          const jImp = (rel * 2.3) / 2 + 150;
          a.vx -= nx * jImp;
          a.vy -= ny * jImp;
          b.vx += nx * jImp;
          b.vy += ny * jImp;
          a.dashUntil = b.dashUntil = now;
          a.stunUntil = b.stunUntil = now + C.stunTime * 0.6;
          this.markHit(b, a, now);
          this.markHit(a, b, now);
          this.events.push({ k: 'clash', x: Math.round(mx), y: Math.round(my), p: Math.round(jImp) });
        } else if (aDash || bDash) {
          const att = aDash ? a : b;
          const vic = aDash ? b : a;
          const sx = aDash ? nx : -nx;
          const sy = aDash ? ny : -ny;
          const attN = att.vx * sx + att.vy * sy;
          const power =
            Math.max(attN, C.hitMinPower) * (C.hitBase + C.hitChargeBonus * att.dashCharge) * (att.perfect ? 1.12 : 1);
          const vicN = vic.vx * sx + vic.vy * sy;
          if (vicN < 0) {
            vic.vx -= sx * vicN;
            vic.vy -= sy * vicN;
          }
          vic.vx += sx * power;
          vic.vy += sy * power;
          vic.stunUntil = now + C.stunTime;
          vic.dashUntil = now;
          // Angreifer stoppt fast komplett (Billard-Gefühl)
          att.vx -= sx * attN * 0.85;
          att.vy -= sy * attN * 0.85;
          att.dashUntil = now;
          // Treffer belohnt: Cooldown fast weg -> Ketten-Combos möglich
          att.cooldownUntil = Math.min(att.cooldownUntil, now + C.hitRefund);
          this.markHit(vic, att, now);
          this.events.push({
            k: 'hit', x: Math.round(mx), y: Math.round(my), a: att.id, b: vic.id, p: Math.round(power), pf: att.perfect ? 1 : 0,
          });
        } else {
          const jImp = (rel * 1.8) / 2 + C.bumpBonus;
          a.vx -= nx * jImp;
          a.vy -= ny * jImp;
          b.vx += nx * jImp;
          b.vy += ny * jImp;
          if (rel > 180) {
            // Wer schneller reinläuft, bekommt den Credit
            if (van > -vbn) this.markHit(b, a, now);
            else this.markHit(a, b, now);
          }
          this.events.push({ k: 'bump', x: Math.round(mx), y: Math.round(my), p: Math.round(rel) });
        }
      }
    }
  }

  markHit(victim, attacker, now) {
    victim.lastHitBy = attacker.id;
    victim.lastHitAt = now;
  }

  fall(p, now) {
    p.state = 'falling';
    p.stateAt = now;
    p.respawnAt = now + C.fallTime + C.respawnDelay;
    p.charging = false;
    p.queuedDashAt = 0;
    const killer = p.lastHitBy && now - p.lastHitAt < C.creditWindow ? this.players.get(p.lastHitBy) : null;
    const ev = { k: 'fall', i: p.id, x: Math.round(p.x), y: Math.round(p.y) };
    if (killer && killer !== p) {
      killer.streak++;
      killer.kos++;
      killer.best = Math.max(killer.best, killer.streak);
      let pts = 1;
      const bounty = this.crownId === p.id;
      if (bounty) pts += C.bounty;
      if (killer.streak >= 3) pts += 1;
      killer.score += pts;
      ev.by = killer.id;
      ev.pts = pts;
      ev.st = killer.streak;
      if (bounty) ev.bo = 1;
    }
    p.streak = 0;
    this.events.push(ev);
    this.rosterDirty = true;
  }

  updateCrown() {
    let best = null;
    for (const p of this.players.values()) {
      if (p.score <= 0) continue;
      if (!best || p.score > best.score) best = p;
    }
    const cur = this.crownId !== null ? this.players.get(this.crownId) : null;
    // Krone wechselt nur bei echtem Überholen
    if (best && (!cur || best.score > cur.score)) {
      if (this.crownId !== best.id) {
        this.crownId = best.id;
        this.rosterDirty = true;
        this.events.push({ k: 'crown', i: best.id });
      }
    }
  }

  // ---------- Netzwerk ----------
  broadcast() {
    const now = this.time;
    const ps = [];
    for (const p of this.players.values()) {
      if (p.state === 'dead') continue;
      let f = 0;
      if (p.state === 'alive') f |= 1;
      if (now < p.dashUntil) f |= 2;
      if (now < p.shieldUntil) f |= 4;
      if (p.state === 'falling') f |= 16;
      if (now < p.stunUntil) f |= 32;
      const charge = p.charging ? clamp((now - p.chargeStart) / C.chargeTime, 0, 1) : 0;
      const cd = now < p.cooldownUntil ? (p.cooldownUntil - now) / C.dashCooldown : 0;
      ps.push([
        p.id,
        Math.round(p.x),
        Math.round(p.y),
        Math.round(p.angle * 100) / 100,
        Math.round(charge * 100),
        Math.round(cd * 100),
        f,
        Math.round(Math.hypot(p.vx, p.vy)),
      ]);
    }
    const msg = {
      type: 'state',
      t: Math.round(now * 1000),
      r: Math.round(this.arenaR),
      ph: this.pulsePhase,
      pt: Math.round(((this.time % C.pulseCycle) / C.pulseCycle) * 1000),
      p: ps,
      e: this.events,
      h: this.humanCount(),
    };
    if (this.rosterDirty) {
      msg.roster = [...this.players.values()].map((p) => ({
        i: p.id,
        n: p.name,
        c: p.color,
        s: p.score,
        k: p.kos,
        st: p.streak,
        b: p.isBot ? 1 : 0,
        cr: p.id === this.crownId ? 1 : 0,
        dead: p.state === 'alive' ? 0 : 1,
        ra: Math.round(p.respawnAt * 1000),
      }));
      this.rosterDirty = false;
    }
    this.events = [];
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(data);
    }
    for (const ws of this.spectators) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

module.exports = { Game, COLORS, C };
