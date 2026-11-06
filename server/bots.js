// Einfache, aber gemeine Bot-KI.
const BOT_NAMES = [
  'Blobert', 'Rutschi', 'Glitschi', 'Schubsi', 'Flitz', 'Wobbel', 'Kugelblitz',
  'Plumps', 'Bumsti', 'Zisch', 'Murmel', 'Gleiti', 'Wumms', 'Pingu',
];

function rand(a, b) {
  return a + Math.random() * (b - a);
}

function dashDistance(charge, C) {
  // grobe Schätzung, wie weit ein Dash trägt
  const v = C.dashMin + (C.dashMax - C.dashMin) * charge;
  const t = C.dashTimeMin + (C.dashTimeMax - C.dashTimeMin) * charge;
  return v * t + (v - C.walkMax) / (C.excessDrag + C.friction) + 60;
}

function updateBot(p, game, now, C) {
  const b = p.bot;
  if (b.skill === undefined) {
    b.skill = rand(0.4, 0.85);
    b.nextThink = 0;
    b.chargeUntil = 0;
    b.plannedCharge = 0;
    b.wander = rand(0, Math.PI * 2);
    b.mx = 0;
    b.my = 0;
    b.attackReady = 0;
  }
  if (p.state !== 'alive') {
    b.chargeUntil = 0;
    return false;
  }

  const R = game.arenaR;
  const d = Math.hypot(p.x, p.y) || 1;
  const ox = p.x / d;
  const oy = p.y / d;
  const cdReady = now >= p.cooldownUntil;

  // Lädt gerade auf -> weiter zielen, zum geplanten Zeitpunkt loslassen
  if (b.chargeUntil) {
    const t = b.targetId && game.players.get(b.targetId);
    if (t && t.state === 'alive') {
      const ax = t.x + t.vx * 0.12 - p.x;
      const ay = t.y + t.vy * 0.12 - p.y;
      const l = Math.hypot(ax, ay) || 1;
      p.input.mx = ax / l;
      p.input.my = ay / l;
    }
    if (now >= b.chargeUntil) {
      b.chargeUntil = 0;
      return false; // loslassen = Dash
    }
    return true;
  }

  if (now >= b.nextThink) {
    b.nextThink = now + rand(0.08, 0.22) / b.skill;
    let mx = 0;
    let my = 0;

    const danger = d > R * 0.7 || game.pulsePhase === 1;
    const outward = p.vx * ox + p.vy * oy;

    // Notfall-Rettung: rutscht nach außen -> Dash zur Mitte
    if (d > R * 0.82 && outward > 220 && cdReady && Math.random() < b.skill) {
      p.input.mx = -ox;
      p.input.my = -oy;
      b.targetId = null;
      b.chargeUntil = now + 0.02;
      return true;
    }

    // Ziel suchen: nah und möglichst nah am Rand
    let target = null;
    let bestScore = Infinity;
    for (const o of game.players.values()) {
      if (o === p || o.state !== 'alive' || now < o.shieldUntil) continue;
      const dist = Math.hypot(o.x - p.x, o.y - p.y);
      const edge = Math.hypot(o.x, o.y) / R;
      let s = dist - edge * 260;
      if (o.id === game.crownId) s -= 150;
      if (now - o.stateAt < 4) s += 400; // Frisch Gespawnte in Ruhe lassen
      if (s < bestScore) {
        bestScore = s;
        target = o;
      }
    }

    // Ausweichen vor anrauschenden Dashern
    for (const o of game.players.values()) {
      if (o === p || o.state !== 'alive' || now >= o.dashUntil) continue;
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 260) continue;
      const sp = Math.hypot(o.vx, o.vy) || 1;
      const toward = (o.vx * dx + o.vy * dy) / (sp * dist);
      if (toward > 0.8 && Math.random() < b.skill * 0.8) {
        // senkrecht ausweichen, bevorzugt Richtung Mitte
        let px = -o.vy / sp;
        let py = o.vx / sp;
        if (px * -ox + py * -oy < 0) {
          px = -px;
          py = -py;
        }
        mx = px;
        my = py;
      }
    }

    if (mx === 0 && my === 0) {
      if (danger) {
        mx = -ox;
        my = -oy;
      } else if (target) {
        // Position "hinter" dem Ziel (zur Mitte hin), damit der Stoß nach außen geht
        const td = Math.hypot(target.x, target.y) || 1;
        const tox = target.x / td;
        const toy = target.y / td;
        const gx = target.x - tox * 140;
        const gy = target.y - toy * 140;
        const dx = gx - p.x;
        const dy = gy - p.y;
        const l = Math.hypot(dx, dy) || 1;
        mx = dx / l;
        my = dy / l;

        // Angriff?
        const ax = target.x + target.vx * 0.15 - p.x;
        const ay = target.y + target.vy * 0.15 - p.y;
        const al = Math.hypot(ax, ay) || 1;
        const pushOut = (ax / al) * tox + (ay / al) * toy;
        if (cdReady && now >= b.attackReady && al < 330 && pushOut > 0.15 && Math.random() < 0.25 + b.skill * 0.4) {
          b.attackReady = now + C.dashCooldown + rand(0.4, 2.2) / b.skill;
          const charge = Math.min(1, rand(0, 0.8) * b.skill + (al > 220 ? 0.3 : 0));
          // nicht selbst von der Plattform dashen
          const err = (Math.random() - 0.5) * (1 - b.skill) * 0.7;
          const ang = Math.atan2(ay, ax) + err;
          const reach = dashDistance(charge, C);
          const ex = p.x + Math.cos(ang) * Math.min(reach, al + 120);
          const ey = p.y + Math.sin(ang) * Math.min(reach, al + 120);
          if (Math.hypot(ex, ey) < R * 0.92 || Math.random() > b.skill) {
            p.input.mx = Math.cos(ang);
            p.input.my = Math.sin(ang);
            b.targetId = target.id;
            b.chargeUntil = now + charge * C.chargeTime + 0.02;
            return true;
          }
        }
      } else {
        b.wander += rand(-0.6, 0.6);
        mx = Math.cos(b.wander) * 0.5 - ox * (d / R);
        my = Math.sin(b.wander) * 0.5 - oy * (d / R);
      }
    }
    const l = Math.hypot(mx, my) || 1;
    b.mx = mx / Math.max(1, l);
    b.my = my / Math.max(1, l);
  }

  p.input.mx = b.mx;
  p.input.my = b.my;
  p.input.ax = 0;
  p.input.ay = 0;
  return false;
}

module.exports = { updateBot, BOT_NAMES };
