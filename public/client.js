(() => {
  'use strict';

  // ---------- Konstanten ----------
  const COLORS = ['#ff4d6d', '#ff9f1c', '#ffd60a', '#2ec4b6', '#3a86ff', '#8338ec', '#ff70a6', '#70e000'];
  const RADIUS = 28;
  const INTERP = 55; // ms Render-Verzögerung (Server sendet mit 60 Hz)
  const F_ALIVE = 1, F_DASH = 2, F_SHIELD = 4, F_FALL = 16, F_STUN = 32;

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (isTouch) document.body.classList.add('touch');

  // ---------- Zustand ----------
  let ws = null;
  let myId = null;
  let joined = false;
  const roster = new Map();
  const snaps = [];
  let offset = null; // serverZeit - clientZeit
  let W = 0, H = 0, DPR = 1;
  const cam = { x: 0, y: 0, s: 0.5 };
  let shake = 0;
  let freezeLeft = 0; // Hit-Stop
  let freezeAcc = 0;
  let lastFrame = performance.now();
  let arenaR = 560;
  let phase = 0;
  let myPos = null;
  let myAlive = false;
  let myCharge = 0;
  let myCooldown = 0;
  let lastChargeFull = false;
  let edgeDanger = 0;
  let slowLeft = 0; // Zeitlupe (ms)
  let camKick = 0; // Zoom-Punch
  let flashA = 0;
  let flashColor = '255,255,255';
  let localChargeAt = 0; // wann die eigene Aufladung (lokal) begonnen hat
  let selfDashSoundAt = 0;
  let lastMyHitAt = 0;
  let inPerfect = false;
  const vis = new Map(); // pro Spieler: Trails, Wobble ...
  const particles = [];
  const texts = [];
  const rings = [];
  const stars = [];
  for (let i = 0; i < 160; i++) {
    stars.push({ x: (Math.random() - 0.5) * 4000, y: (Math.random() - 0.5) * 4000, s: Math.random() * 2 + 0.5, d: Math.random() * 0.5 + 0.2 });
  }
  const cracks = [];
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2;
    const r0 = Math.random() * 0.5 + 0.1;
    const pts = [[Math.cos(a) * r0, Math.sin(a) * r0]];
    let ang = a + (Math.random() - 0.5);
    for (let j = 0; j < 4; j++) {
      const last = pts[pts.length - 1];
      ang += (Math.random() - 0.5) * 1.2;
      pts.push([last[0] + Math.cos(ang) * 0.09, last[1] + Math.sin(ang) * 0.09]);
    }
    cracks.push(pts);
  }

  // ---------- Menü ----------
  let myColor = localStorage.getItem('da_color') || COLORS[Math.floor(Math.random() * COLORS.length)];
  $('name').value = localStorage.getItem('da_name') || '';
  const colorsEl = $('colors');
  COLORS.forEach((c) => {
    const s = document.createElement('div');
    s.className = 'swatch' + (c === myColor ? ' sel' : '');
    s.style.background = c;
    s.onclick = () => {
      myColor = c;
      document.querySelectorAll('.swatch').forEach((e) => e.classList.remove('sel'));
      s.classList.add('sel');
    };
    colorsEl.appendChild(s);
  });
  $('play').onclick = start;
  $('name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') start();
    e.stopPropagation();
  });
  $('mute').onclick = () => {
    $('mute').textContent = SFX.toggleMute() ? '🔇' : '🔊';
  };
  $('mute').textContent = SFX.muted ? '🔇' : '🔊';
  $('music').onclick = () => {
    $('music').classList.toggle('off', !SFX.toggleMusic());
  };
  $('music').classList.toggle('off', !SFX.musicOn);
  function vibrate(ms) {
    if (isTouch && navigator.vibrate) navigator.vibrate(ms);
  }

  let pendingJoin = null;
  function start() {
    if (joined) return;
    SFX.init();
    const name = $('name').value.trim() || 'Blob' + Math.floor(Math.random() * 100);
    localStorage.setItem('da_name', name);
    localStorage.setItem('da_color', myColor);
    pendingJoin = { type: 'join', name, color: myColor };
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(pendingJoin));
      pendingJoin = null;
    } else {
      $('status').textContent = 'Verbinde …';
      if (!ws || ws.readyState > 1) connect();
    }
  }

  // Sofort verbinden (als Zuschauer) -> hinter dem Menü läuft die echte Arena
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      $('status').textContent = '';
      if (pendingJoin) {
        ws.send(JSON.stringify(pendingJoin));
        pendingJoin = null;
      }
    };
    ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      const wasJoined = joined;
      joined = false;
      myId = null;
      $('menu').classList.remove('hidden');
      $('hud').classList.add('hidden');
      $('touch').classList.add('hidden');
      $('online').textContent = '';
      $('status').textContent = wasJoined ? 'Verbindung verloren – verbinde neu …' : 'Server nicht erreichbar – versuche es erneut …';
      snaps.length = 0;
      offset = null;
      setTimeout(connect, 2000);
    };
  }
  connect();

  let lastOnline = -1;
  let best = +localStorage.getItem('da_best') || 0;
  let bestStreak = +localStorage.getItem('da_bestStreak') || 0;
  let recordAnnounced = false;
  let lifeStreak = 0;
  function showRecord() {
    $('record').textContent = best > 0 ? `🏆 Dein Rekord: ${best} Punkte · beste Serie ${bestStreak}` : '';
  }
  showRecord();
  let pingSent = 0;
  setInterval(() => {
    if (ws && ws.readyState === 1 && joined) {
      pingSent = performance.now();
      ws.send(JSON.stringify({ type: 'ping', t: pingSent }));
    }
  }, 2000);

  function onMessage(m) {
    if (m.type === 'welcome') {
      myId = m.id;
      joined = true;
      recordAnnounced = false;
      lifeStreak = 0;
      tutStart();
      $('menu').classList.add('hidden');
      $('hud').classList.remove('hidden');
      if (isTouch) $('touch').classList.remove('hidden');
      $('status').textContent = '';
      canvas.focus();
    } else if (m.type === 'pong') {
      $('ping').textContent = Math.round(performance.now() - m.t) + ' ms';
    } else if (m.type === 'state') {
      const now = performance.now();
      const o = m.t - now;
      if (offset === null || Math.abs(o - offset) > 1000) offset = o;
      else if (o > offset) offset += (o - offset) * 0.2;
      else offset += (o - offset) * 0.02;

      const players = new Map();
      for (const a of m.p) {
        players.set(a[0], { id: a[0], x: a[1], y: a[2], a: a[3], ch: a[4] / 100, cd: a[5] / 100, f: a[6], v: a[7] });
      }
      snaps.push({ t: m.t, r: m.r, ph: m.ph, players, events: m.e, done: false });
      if (m.h !== lastOnline) {
        lastOnline = m.h;
        $('online').textContent = m.h > 0 ? `🟢 ${m.h} ${m.h === 1 ? 'Spieler' : 'Spieler'} online` : '🟢 Arena bereit – sei der Erste!';
      }
      if (snaps.length > 90) snaps.shift();
      if (m.roster) {
        roster.clear();
        for (const r of m.roster) roster.set(r.i, r);
        updateBoard();
      }
    }
  }

  // ---------- Eingabe ----------
  const keys = new Set();
  let mouseX = 0, mouseY = 0;
  let mouseCharge = false, keyCharge = false, touchCharge = false;
  const stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
  let dashPointer = null;

  addEventListener('keydown', (e) => {
    if (!joined) return;
    const k = e.key.toLowerCase();
    if (k === ' ') {
      keyCharge = true;
      e.preventDefault();
    } else if (k === 'm') {
      $('mute').click();
    } else if (k === 'n') {
      $('music').click();
    }
    keys.add(k);
    sendInput();
  });
  addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ') keyCharge = false;
    keys.delete(k);
    sendInput();
  });
  addEventListener('blur', () => {
    keys.clear();
    keyCharge = mouseCharge = touchCharge = false;
    stick.id = null;
    sendInput();
  });
  addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (!joined) return;
    SFX.init();
    if (e.pointerType === 'mouse') {
      if (e.button === 0 || e.button === 2) mouseCharge = true;
    } else {
      touchDown(e);
    }
    sendInput();
  });
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') {
      mouseX = e.clientX;
      mouseY = e.clientY;
    } else if (e.pointerId === stick.id) {
      stick.x = e.clientX;
      stick.y = e.clientY;
      updateStickVisual();
      sendInput();
    }
  });
  addEventListener('pointerup', pointerEnd);
  addEventListener('pointercancel', pointerEnd);
  function pointerEnd(e) {
    if (e.pointerType === 'mouse') {
      mouseCharge = false;
    } else {
      if (e.pointerId === stick.id) {
        stick.id = null;
        updateStickVisual();
      }
      if (e.pointerId === dashPointer) {
        dashPointer = null;
        touchCharge = false;
        $('dashBtn').classList.remove('down');
      }
    }
    sendInput();
  }
  function touchDown(e) {
    if (e.clientX < W * 0.5) {
      if (stick.id === null) {
        stick.id = e.pointerId;
        stick.ox = stick.x = e.clientX;
        stick.oy = stick.y = e.clientY;
        updateStickVisual();
      }
    } else if (dashPointer === null) {
      dashPointer = e.pointerId;
      touchCharge = true;
      $('dashBtn').classList.add('down');
    }
  }
  function stickVec() {
    if (stick.id === null) return [0, 0];
    let dx = stick.x - stick.ox;
    let dy = stick.y - stick.oy;
    const l = Math.hypot(dx, dy);
    const max = 55;
    if (l < 6) return [0, 0];
    const m = Math.min(1, l / max);
    return [(dx / l) * m, (dy / l) * m];
  }
  function updateStickVisual() {
    const el = $('stick');
    const knob = $('knob');
    if (stick.id === null) {
      el.classList.remove('active');
      el.style.left = '22%';
      el.style.top = '72%';
      knob.style.transform = '';
      return;
    }
    el.classList.add('active');
    el.style.left = stick.ox + 'px';
    el.style.top = stick.oy + 'px';
    const [vx, vy] = stickVec();
    knob.style.transform = `translate(${vx * 45}px, ${vy * 45}px)`;
  }

  function moveVec() {
    let x = 0, y = 0;
    if (keys.has('w') || keys.has('arrowup')) y -= 1;
    if (keys.has('s') || keys.has('arrowdown')) y += 1;
    if (keys.has('a') || keys.has('arrowleft')) x -= 1;
    if (keys.has('d') || keys.has('arrowright')) x += 1;
    if (x || y) {
      const l = Math.hypot(x, y);
      return [x / l, y / l];
    }
    return stickVec();
  }
  function aimVec() {
    if (isTouch || !myPos) return [0, 0];
    const wx = (mouseX - W / 2) / cam.s + cam.x;
    const wy = (mouseY - H / 2) / cam.s + cam.y;
    const dx = wx - myPos.x;
    const dy = wy - myPos.y;
    const l = Math.hypot(dx, dy);
    return l > 1 ? [dx / l, dy / l] : [0, 0];
  }

  let lastSent = '';
  let lastSentAt = 0;
  let wasCharging = false;
  function sendInput() {
    if (!ws || ws.readyState !== 1 || !joined) return;
    const [mx, my] = moveVec();
    const [ax, ay] = aimVec();
    const ch = mouseCharge || keyCharge || touchCharge;
    if (ch !== wasCharging) {
      wasCharging = ch;
      const now = performance.now();
      if (ch) {
        localChargeAt = now + Math.max(0, myCooldown) * 1200;
        if (myAlive) SFX.chargeStart();
      } else {
        SFX.chargeStop();
        // Sofortiges Feedback, ohne auf den Server zu warten
        const raw = now - localChargeAt;
        if (myAlive && raw >= 0) {
          const c = Math.min(1, raw / 600);
          const perfect = raw >= 580 && raw <= 760;
          tutEvent(perfect ? 'perfect' : 'dash');
          SFX.dash(c, 1, perfect);
          selfDashSoundAt = now;
          addShake(2 + c * 4);
        }
      }
      lastChargeFull = false;
    }
    const msg = { type: 'input', mx: +mx.toFixed(2), my: +my.toFixed(2), ch, ax: +ax.toFixed(2), ay: +ay.toFixed(2) };
    const s = JSON.stringify(msg);
    const now = performance.now();
    if (s !== lastSent || now - lastSentAt > 100) {
      ws.send(s);
      lastSent = s;
      lastSentAt = now;
    }
  }
  setInterval(sendInput, 50);

  // ---------- HUD ----------
  function updateBoard() {
    const list = [...roster.values()].sort((a, b) => b.s - a.s || a.i - b.i);
    let html = '';
    const myIdx = list.findIndex((r) => r.i === myId);
    list.forEach((r, idx) => {
      if (idx >= (isTouch ? 4 : 6) && r.i !== myId) return;
      html += `<div class="row${r.i === myId ? ' me' : ''}"><span class="rk">${idx + 1}</span><span class="dot" style="background:${r.c}"></span><span class="nm">${r.cr ? '👑 ' : ''}${esc(r.n)}</span><span class="sc">${r.s}</span></div>`;
    });
    $('board').innerHTML = html;
    const me = roster.get(myId);
    if (me) {
      const el = $('myScore');
      if (el.textContent !== String(me.s)) {
        el.textContent = me.s;
        el.classList.remove('pop');
        void el.offsetWidth;
        el.classList.add('pop');
      }
      $('myStreak').textContent = me.st >= 2 ? `🔥 ${me.st}er-Serie` : me.cr ? '👑 Du hast die Krone!' : '';
      if (me.st > 0) lifeStreak = me.st;
      if (me.st > bestStreak) {
        bestStreak = me.st;
        localStorage.setItem('da_bestStreak', bestStreak);
      }
      if (me.s > best) {
        if (best > 0 && !recordAnnounced) {
          recordAnnounced = true;
          setTimeout(() => {
            banner('🏆 NEUER REKORD!', 'info', 2200);
            SFX.crown();
          }, 900);
        }
        best = me.s;
        localStorage.setItem('da_best', best);
        showRecord();
      }
    }
    void myIdx;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }
  function nameOf(id) {
    const r = roster.get(id);
    return r ? r.n : '???';
  }
  function colorOf(id) {
    const r = roster.get(id);
    return r ? r.c : '#ccc';
  }
  function killfeed(html, me) {
    const el = document.createElement('div');
    el.className = 'kf' + (me ? ' me' : '');
    el.innerHTML = html;
    const kf = $('killfeed');
    kf.prepend(el);
    while (kf.children.length > 5) kf.lastChild.remove();
    setTimeout(() => (el.style.opacity = '0'), 4200);
    setTimeout(() => el.remove(), 4900);
  }
  function kfName(id) {
    return `<span style="color:${colorOf(id)}">${esc(nameOf(id))}</span>`;
  }
  let centerTimer = 0;
  function centerText(big, sub, color, dur = 1400) {
    $('center').innerHTML = `<div class="big" style="color:${color || '#fff'}">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ''}`;
    clearTimeout(centerTimer);
    centerTimer = setTimeout(() => ($('center').innerHTML = ''), dur);
  }
  let bannerTimer = 0;
  function banner(text, cls, dur) {
    const b = $('banner');
    b.textContent = text;
    b.className = 'show ' + cls;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => (b.className = ''), dur);
  }
  const STREAK = { 2: 'DOUBLE!', 3: 'TRIPLE!', 4: 'QUAD!', 5: 'RAMPAGE!', 6: 'UNAUFHALTBAR!', 7: 'GODLIKE!' };

  // ---------- Effekte ----------
  function burst(x, y, n, color, speed, life, size) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.9);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, size: size * (0.5 + Math.random()), color, drag: 3 });
    }
  }
  function floatText(x, y, text, color, size = 30) {
    texts.push({ x, y, text, color, size, life: 1.2, max: 1.2 });
  }
  function ring(x, y, color, maxR, life, width = 6) {
    rings.push({ x, y, color, maxR, life, max: life, width });
  }
  function addShake(a) {
    shake = Math.min(28, shake + a);
  }
  function hitStop(ms) {
    freezeLeft = Math.max(freezeLeft, ms);
  }
  function flash(color, a) {
    flashColor = color;
    flashA = Math.max(flashA, a);
  }
  function distVol(x, y) {
    if (!myPos) return 0.6;
    const d = Math.hypot(x - myPos.x, y - myPos.y);
    return Math.max(0.15, 1 - d / 1400);
  }
  function getVis(id) {
    let v = vis.get(id);
    if (!v) {
      v = { trail: [], wob: 0, wobV: 0, fallAt: 0, blink: Math.random() * 4, lastF: 0, sprayAcc: 0 };
      vis.set(id, v);
    }
    return v;
  }

  function handleEvent(e, snap) {
    const p = (id) => snap.players.get(id);
    switch (e.k) {
      case 'dash': {
        const pl = p(e.i);
        if (pl) {
          burst(pl.x, pl.y, 8 + e.c / 10, 'rgba(230,248,255,0.9)', 220, 0.35, 6);
          if (e.pf) {
            burst(pl.x, pl.y, 18, '#ffd60a', 420, 0.45, 6);
            ring(pl.x, pl.y, 'rgba(255,214,10,0.95)', 110, 0.35, 7);
          }
          const selfDone = e.i === myId && performance.now() - selfDashSoundAt < 500;
          if (!selfDone) SFX.dash(e.c / 100, distVol(pl.x, pl.y) * (e.i === myId ? 1 : 0.5), e.pf && e.i === myId);
          if (e.i === myId && e.pf) {
            floatText(pl.x, pl.y - 50, 'PERFEKT!', '#ffd60a', 30);
            camKick = Math.max(camKick, 0.05);
            flash('255,214,10', 0.12);
          }
        }
        break;
      }
      case 'hit': {
        const mine = e.a === myId || e.b === myId;
        const pw = Math.min(1, e.p / 1600);
        burst(e.x, e.y, 14 + pw * 20, '#fff', 500 + pw * 500, 0.45, 5);
        burst(e.x, e.y, 10, colorOf(e.b), 380, 0.5, 7);
        ring(e.x, e.y, 'rgba(255,255,255,0.9)', 70 + pw * 90, 0.35, 8);
        const vb = getVis(e.b);
        vb.wobV += 18 + pw * 12;
        vb.flash = 1;
        if (e.pf) burst(e.x, e.y, 20, '#ffd60a', 650, 0.5, 6);
        if (e.a === myId) {
          camKick = Math.max(camKick, 0.06 + pw * 0.06);
          flash('255,255,255', 0.1 + pw * 0.12);
          vibrate(25 + pw * 30);
          const n = performance.now();
          if (n - lastMyHitAt < 1300) floatText(e.x, e.y - 70, 'COMBO!', '#70e000', 28);
          lastMyHitAt = n;
        } else if (e.b === myId) {
          flash('255,60,90', 0.18);
          vibrate(60);
        }
        addShake((mine ? 10 : 3) + pw * (mine ? 12 : 4));
        if (mine || pw > 0.75) hitStop(mine ? 70 + pw * 40 : 45);
        SFX.hit(e.p, distVol(e.x, e.y));
        if (e.a === myId && pw > 0.6) floatText(e.x, e.y - 40, pw > 0.85 ? 'WUMMS!' : 'BAM!', '#ffe066', 26);
        break;
      }
      case 'clash': {
        burst(e.x, e.y, 34, '#ffe066', 700, 0.5, 5);
        ring(e.x, e.y, 'rgba(255,224,102,0.95)', 160, 0.45, 10);
        floatText(e.x, e.y - 30, 'CLASH!', '#ffe066', 34);
        addShake(14);
        hitStop(90);
        SFX.clash(distVol(e.x, e.y));
        break;
      }
      case 'bump': {
        if (e.p > 120) {
          burst(e.x, e.y, 5, 'rgba(255,255,255,0.8)', 160, 0.25, 4);
          SFX.bump(distVol(e.x, e.y) * Math.min(1, e.p / 400));
        }
        break;
      }
      case 'fall': {
        const v = getVis(e.i);
        v.fallAt = performance.now();
        ring(e.x, e.y, 'rgba(120,180,255,0.7)', 120, 0.7, 5);
        SFX.fall(distVol(e.x, e.y));
        {
          // Platsch ins Wasser, kurz nachdem der Blob über die Kante ist
          const d = Math.hypot(e.x, e.y) || 1;
          const sx = e.x + (e.x / d) * 70;
          const sy = e.y + (e.y / d) * 70;
          const col = colorOf(e.i);
          setTimeout(() => {
            burst(sx, sy, 26, 'rgba(140,210,255,0.95)', 520, 0.7, 7);
            burst(sx, sy, 10, col, 300, 0.6, 6);
            ring(sx, sy, 'rgba(180,230,255,0.9)', 150, 0.8, 6);
            ring(sx, sy, 'rgba(180,230,255,0.6)', 230, 1.1, 4);
          }, 420);
        }
        if (e.by) {
          const label = STREAK[Math.min(e.st, 7)] || '';
          const kp = p(e.by);
          const tx = kp ? kp.x : e.x;
          const ty = kp ? kp.y - 60 : e.y;
          floatText(tx, ty, `+${e.pts}`, '#ffe066', 36);
          if (e.bo) floatText(tx, ty - 38, '👑 KOPFGELD!', '#ffd60a', 28);
          if (label) floatText(tx, ty - (e.bo ? 74 : 38), label, '#ff9f1c', 30);
          killfeed(`${kfName(e.by)} ➜ ${kfName(e.i)}${e.bo ? ' 👑' : ''}${e.st >= 2 ? ` <b style="color:#ff9f1c">x${e.st}</b>` : ''}`, e.by === myId || e.i === myId);
          if (e.by === myId) {
            centerText(label || 'RAUS DAMIT!', `${esc(nameOf(e.i))} fliegt${e.bo ? ' – Krone geklaut! +3' : ''}`, '#ffe066');
            SFX.ko(e.st);
            if (e.bo) SFX.bounty();
            const VOICE = { 2: 'double', 3: 'triple', 4: 'rampage', 5: 'unstoppable' };
            const vName = e.st >= 6 ? 'godlike' : VOICE[e.st];
            if (vName || e.bo) setTimeout(() => SFX.voice(vName || 'bounty'), 250);
            addShake(8);
            // Kill-Cam: kurze Zeitlupe
            slowLeft = 380;
            SFX.duck(0.4, 600);
            camKick = Math.max(camKick, 0.1);
            flash('255,224,102', 0.2);
            vibrate([30, 40, 60]);
          }
        } else {
          killfeed(`${kfName(e.i)} ist abgerutscht`, e.i === myId);
        }
        if (e.i === myId) {
          const streakInfo = lifeStreak >= 2 ? `<br><span style="opacity:.75">Deine Serie: ${lifeStreak} KOs</span>` : '';
          lifeStreak = 0;
          centerText('RAUS!', (e.by ? `${kfName(e.by)} hat dich erwischt` : 'Abgerutscht …') + streakInfo, '#ff4d6d', 1800);
          SFX.out();
          SFX.chargeStop();
          addShake(12);
          vibrate(150);
        }
        break;
      }
      case 'spawn': {
        const pl = p(e.i);
        if (pl) {
          ring(pl.x, pl.y, colorOf(e.i), 70, 0.5, 5);
          burst(pl.x, pl.y, 10, colorOf(e.i), 200, 0.4, 5);
          if (e.i === myId) SFX.spawn(1);
        }
        const v = getVis(e.i);
        v.trail.length = 0;
        v.fallAt = 0;
        if (e.i === myId && wasCharging) {
          localChargeAt = performance.now() + 300;
          SFX.chargeStart();
        }
        break;
      }
      case 'pulse': {
        if (e.p === 1) {
          banner('⚠ PLATTFORM SCHRUMPFT!', 'warn', 2400);
          SFX.alarm();
        } else if (e.p === 2) {
          addShake(10);
        } else if (e.p === 3) {
          banner('Plattform wächst wieder', 'info', 1500);
        }
        break;
      }
      case 'clutch': {
        const pl = p(e.i);
        if (pl) floatText(pl.x, pl.y - 55, 'KNAPP!', '#9fe7ff', e.i === myId ? 32 : 22);
        if (e.i === myId) {
          SFX.voice('close');
          flash('159,231,255', 0.12);
        }
        break;
      }
      case 'crown': {
        killfeed(`👑 ${kfName(e.i)} hat jetzt die Krone`, e.i === myId);
        if (e.i === myId) {
          SFX.crown();
          setTimeout(() => SFX.voice('king'), 400);
          banner('👑 DU HAST DIE KRONE – alle jagen dich!', 'info', 2200);
        }
        break;
      }
    }
  }

  // ---------- Interpolation ----------
  function sample(rt) {
    if (snaps.length === 0) return null;
    let a = snaps[0];
    let b = snaps[snaps.length - 1];
    if (rt >= b.t) return { a: b, b: b, t: 0 };
    if (rt <= a.t) return { a: a, b: a, t: 0 };
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].t <= rt) {
        a = snaps[i - 1];
        b = snaps[i];
        break;
      }
    }
    return { a, b, t: (rt - a.t) / (b.t - a.t || 1) };
  }
  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // ---------- Rendering ----------
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth;
    H = innerHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
  }
  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      for (const s of snaps) s.done = true;
      freezeLeft = slowLeft = freezeAcc = 0;
      particles.length = texts.length = rings.length = 0;
    }
  });
  resize();

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    // Hit-Stop: Renderzeit kurz einfrieren und dann weich aufholen
    let timeScale = 1;
    if (freezeLeft > 0) {
      freezeAcc += dt * 1000;
      freezeLeft -= dt * 1000;
      timeScale = 0.08;
    } else if (slowLeft > 0) {
      freezeAcc += dt * 1000 * 0.7; // Zeitlupe: Renderzeit läuft mit 30 %
      slowLeft -= dt * 1000;
      timeScale = 0.3;
    } else if (freezeAcc > 0) {
      freezeAcc = Math.max(0, freezeAcc - dt * 1000 * 0.45);
    }
    freezeAcc = Math.min(freezeAcc, 400);
    SFX.setMusicRate(timeScale < 1 ? 0.85 : 1);
    const effDt = dt * timeScale;

    let interp = null;
    let rt = 0;
    if (offset !== null) {
      rt = now + offset - INTERP - freezeAcc;
      interp = sample(rt);
      for (const s of snaps) {
        if (!s.done && s.t <= rt) {
          s.done = true;
          for (const e of s.events) handleEvent(e, s);
        }
      }
    }

    // Spieler-Positionen berechnen
    const drawList = [];
    if (interp) {
      const { a, b, t } = interp;
      arenaR = a.r + (b.r - a.r) * t;
      phase = b.ph;
      for (const pb of b.players.values()) {
        const pa = a.players.get(pb.id) || pb;
        drawList.push({
          id: pb.id,
          x: pa.x + (pb.x - pa.x) * t,
          y: pa.y + (pb.y - pa.y) * t,
          a: lerpAngle(pa.a, pb.a, t),
          ch: pa.ch + (pb.ch - pa.ch) * t,
          cd: pb.cd,
          f: pb.f,
          v: pa.v + (pb.v - pa.v) * t,
        });
      }
    }

    const me = drawList.find((p) => p.id === myId);
    myAlive = !!(me && me.f & F_ALIVE);
    if (me) myPos = { x: me.x, y: me.y };
    inPerfect = false;
    if (me) {
      myCooldown = me.cd;
      if (wasCharging && myAlive) {
        // eigene Aufladung lokal berechnen -> reagiert sofort
        const raw = now - localChargeAt;
        me.ch = Math.max(0, Math.min(1, raw / 600));
        inPerfect = raw >= 580 && raw <= 760;
        me.perfect = inPerfect;
      } else me.ch = 0;
      myCharge = me.ch;
      if (myCharge >= 0.99 && !lastChargeFull && wasCharging) {
        lastChargeFull = true;
        SFX.chargeFull();
      }
      if (me.v > 760 && !(me.f & F_DASH) && myAlive) SFX.skid(0.8);
    }

    // Kamera
    const minDim = Math.min(W, H);
    const small = minDim < 700;
    const viewR = small ? Math.max(430, arenaR * 0.8) : arenaR * 1.22 + 70;
    const targetS = minDim / 2 / viewR;
    cam.s += (targetS - cam.s) * Math.min(1, dt * 2.5);
    const follow = small ? 0.85 : 0.35;
    const look = myAlive && me ? Math.min(me.v, 600) * 0.07 : 0;
    const tx = myAlive && me ? me.x * follow + Math.cos(me.a) * look : 0;
    const ty = myAlive && me ? me.y * follow + Math.sin(me.a) * look : 0;
    camKick *= Math.pow(0.002, dt);
    flashA *= Math.pow(0.004, dt);
    cam.x += (tx - cam.x) * Math.min(1, dt * 5);
    cam.y += (ty - cam.y) * Math.min(1, dt * 5);
    shake *= Math.pow(0.0015, dt);
    if (shake < 0.1) shake = 0;

    // Rand-Gefahr für Vignette
    const dangerTarget = myAlive && me ? Math.max(0, (Math.hypot(me.x, me.y) / arenaR - 0.72) / 0.28) : 0;
    edgeDanger += (dangerTarget - edgeDanger) * Math.min(1, dt * 8);

    // ---- Zeichnen ----
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawBackground(now);

    const st = now / 1000;
    const sx = (Math.sin(st * 61) + Math.sin(st * 37) * 0.6) * shake * 0.4;
    const sy = (Math.cos(st * 53) + Math.sin(st * 29) * 0.6) * shake * 0.4;
    ctx.save();
    ctx.translate(W / 2 + sx, H / 2 + sy);
    const zs = cam.s * (1 + camKick + (wasCharging && myAlive ? myCharge * 0.04 : 0));
    ctx.scale(zs, zs);
    ctx.translate(-cam.x, -cam.y);

    // Fallende unter der Arena zeichnen
    for (const p of drawList) if (p.f & F_FALL) drawBlob(p, now, dt);
    drawArena(now);
    updateParticles(effDt, false);
    for (const p of drawList) if (!(p.f & F_FALL)) drawTrail(p, effDt);
    for (const p of drawList) if (!(p.f & F_FALL)) drawBlob(p, now, dt);
    updateParticles(effDt, true);
    for (const p of drawList) if (!(p.f & F_FALL)) drawLabel(p, now);
    updateTexts(effDt);
    ctx.restore();

    if (joined) drawOffscreen(drawList, zs, sx, sy);
    drawVignette();
    tutUpdate(me);
    if (flashA > 0.01) {
      ctx.fillStyle = `rgba(${flashColor},${flashA})`;
      ctx.fillRect(0, 0, W, H);
    }
    updateRespawn();
    updateTouchButton();
  }

  function drawBackground(now) {
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, '#0d3b66');
    g.addColorStop(1, '#03111f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    const t = now / 1000;
    for (const s of stars) {
      const x = W / 2 + (s.x - cam.x * s.d) * cam.s;
      const y = H / 2 + (s.y - cam.y * s.d) * cam.s;
      if (x < -5 || y < -5 || x > W + 5 || y > H + 5) continue;
      // Lichtreflexe auf dem Wasser
      ctx.globalAlpha = Math.max(0, 0.15 + 0.35 * Math.sin(t * 1.3 + s.x));
      ctx.fillRect(x, y, s.s * 4, s.s * 0.8);
    }
    ctx.globalAlpha = 1;
  }

  function drawArena(now) {
    const r = arenaR;
    const t = now / 1000;
    // Wellenringe um die Eisscholle
    ctx.lineWidth = 5;
    for (let i = 0; i < 4; i++) {
      const k = (t * 0.35 + i / 4) % 1;
      ctx.strokeStyle = `rgba(160,220,255,${0.22 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(0, 0, r + 30 + k * 260, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Äußeres Glühen
    const glow = ctx.createRadialGradient(0, 0, r * 0.9, 0, 0, r * 1.25);
    const warn = phase === 1 ? 0.5 + 0.5 * Math.sin(t * 20) : 0;
    glow.addColorStop(0, phase >= 1 ? `rgba(255,${80 + 80 * (1 - warn)},100,0.45)` : 'rgba(110,190,255,0.35)');
    glow.addColorStop(1, 'rgba(110,190,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2);
    ctx.fill();

    // Seitenkante (3D-Eisblock)
    ctx.fillStyle = '#4c8fc4';
    ctx.beginPath();
    ctx.arc(0, 14, r, 0, Math.PI * 2);
    ctx.fill();

    // Eis
    const ice = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.05, 0, 0, r);
    ice.addColorStop(0, '#f4fbff');
    ice.addColorStop(0.6, '#cdeaff');
    ice.addColorStop(1, '#93c9ef');
    ctx.fillStyle = ice;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // Kratzer / Risse
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const c of cracks) {
      ctx.beginPath();
      ctx.moveTo(c[0][0] * r, c[0][1] * r);
      for (let i = 1; i < c.length; i++) ctx.lineTo(c[i][0] * r, c[i][1] * r);
      ctx.stroke();
    }
    // Ringe
    ctx.strokeStyle = 'rgba(80,150,210,0.18)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.33, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
    ctx.stroke();

    // Rand
    ctx.lineWidth = 10;
    ctx.strokeStyle = phase === 1 ? `rgba(255,${60 + 120 * (1 - warn)},90,1)` : phase >= 2 ? '#ff8fa3' : '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, r - 5, 0, Math.PI * 2);
    ctx.stroke();
    // Gefahrenzone innen am Rand
    const edge = ctx.createRadialGradient(0, 0, r * 0.82, 0, 0, r);
    edge.addColorStop(0, 'rgba(255,80,110,0)');
    edge.addColorStop(1, phase >= 1 ? 'rgba(255,80,110,0.35)' : 'rgba(255,80,110,0.12)');
    ctx.fillStyle = edge;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTrail(p, dt) {
    const v = getVis(p.id);
    if (p.f & F_DASH || p.v > 650) v.trail.push({ x: p.x, y: p.y, life: 0.25, fl: !(p.f & F_DASH) });
    for (const tr of v.trail) tr.life -= dt;
    while (v.trail.length && v.trail[0].life <= 0) v.trail.shift();
    const col = colorOf(p.id);
    for (const tr of v.trail) {
      ctx.globalAlpha = (tr.life / 0.25) * (tr.fl ? 0.25 : 0.35);
      ctx.fillStyle = tr.fl ? '#ffffff' : col;
      ctx.beginPath();
      ctx.arc(tr.x, tr.y, RADIUS * (0.5 + tr.life * 2), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Eis-Spray bei hoher Geschwindigkeit
    if (p.v > 430 && p.f & F_ALIVE) {
      v.sprayAcc += dt * (p.v / 40);
      while (v.sprayAcc > 1) {
        v.sprayAcc--;
        particles.push({
          x: p.x + (Math.random() - 0.5) * 30,
          y: p.y + (Math.random() - 0.5) * 30,
          vx: (Math.random() - 0.5) * 80,
          vy: (Math.random() - 0.5) * 80,
          life: 0.4,
          max: 0.4,
          size: 4 + Math.random() * 5,
          color: 'rgba(255,255,255,0.85)',
          drag: 2,
          under: true,
        });
      }
    }
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.max(0, Math.min(255, r + amt));
    g = Math.max(0, Math.min(255, g + amt));
    b = Math.max(0, Math.min(255, b + amt));
    return `rgb(${r},${g},${b})`;
  }

  function drawBlob(p, now, dt) {
    const v = getVis(p.id);
    const col = colorOf(p.id);
    // Wobble-Feder
    v.wobV += -v.wob * 260 * dt - v.wobV * 9 * dt;
    v.wob += v.wobV * dt;
    v.blink -= dt;
    if (v.blink < -0.12) v.blink = 2 + Math.random() * 4;

    let scale = 1;
    let alpha = 1;
    let spin = 0;
    if (p.f & F_FALL) {
      if (!v.fallAt) v.fallAt = now;
      const ft = Math.min(1, (now - v.fallAt) / 600);
      scale = 1 - ft * 0.85;
      alpha = 1 - ft * 0.7;
      spin = ft * 6;
    }
    const shield = p.f & F_SHIELD;
    if (shield) alpha *= 0.45 + 0.35 * Math.sin(now / 50);

    // Squash & Stretch
    let along = 1, perp = 1;
    if (p.ch > 0) {
      along = 1 - 0.28 * p.ch;
      perp = 1 + 0.16 * p.ch;
    }
    if (p.f & F_DASH) {
      along = 1.32;
      perp = 0.8;
    }
    along *= 1 + v.wob * 0.02;
    perp *= 1 - v.wob * 0.02;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = alpha;

    // Schatten
    if (!(p.f & F_FALL)) {
      ctx.fillStyle = 'rgba(20,60,110,0.25)';
      ctx.beginPath();
      ctx.ellipse(4, 12, RADIUS * 1.05, RADIUS * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.rotate(p.a + spin);
    ctx.scale(along * scale, perp * scale);

    // Lade-Glühen
    if (p.ch > 0) {
      const full = p.ch >= 0.99;
      ctx.fillStyle = full ? `rgba(255,120,0,${0.35 + 0.25 * Math.sin(now / 40)})` : `rgba(255,224,102,${0.25 * p.ch})`;
      ctx.beginPath();
      ctx.arc(0, 0, RADIUS * (1.25 + p.ch * 0.25), 0, Math.PI * 2);
      ctx.fill();
    }

    // Körper
    const body = ctx.createRadialGradient(-RADIUS * 0.35, -RADIUS * 0.4, RADIUS * 0.1, 0, 0, RADIUS);
    body.addColorStop(0, shade(col, 70));
    body.addColorStop(0.7, col);
    body.addColorStop(1, shade(col, -40));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = shade(col, -70);
    ctx.stroke();
    if (v.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${v.flash})`;
      ctx.beginPath();
      ctx.arc(0, 0, RADIUS, 0, Math.PI * 2);
      ctx.fill();
      v.flash = Math.max(0, v.flash - dt * 7);
    }

    // Augen (schauen nach vorne)
    const stunned = p.f & F_STUN || p.f & F_FALL;
    const blinking = v.blink < 0;
    for (const side of [-1, 1]) {
      const ex = RADIUS * 0.38;
      const ey = side * RADIUS * 0.36;
      if (stunned) {
        ctx.strokeStyle = '#1a1a2e';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(ex - 6, ey - 6);
        ctx.lineTo(ex + 6, ey + 6);
        ctx.moveTo(ex + 6, ey - 6);
        ctx.lineTo(ex - 6, ey + 6);
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(ex, ey, 9, blinking ? 1.5 : 10, 0, 0, Math.PI * 2);
      ctx.fill();
      if (!blinking) {
        ctx.fillStyle = '#1a1a2e';
        ctx.beginPath();
        ctx.arc(ex + 3.5, ey, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(ex + 5, ey - 2, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      // Böse Augenbrauen beim Aufladen
      if (p.ch > 0.15 || p.f & F_DASH) {
        ctx.strokeStyle = shade(col, -90);
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(ex - 9, ey - side * 12);
        ctx.lineTo(ex + 8, ey - side * 4);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Schutz-Blase
    if (shield) {
      ctx.strokeStyle = 'rgba(160,230,255,0.7)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, RADIUS * 1.35, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Lade-Ring
    if (p.ch > 0 && !(p.f & F_FALL)) {
      if (p.perfect) {
        // PERFEKT-Fenster: goldener pulsierender Ring = jetzt loslassen!
        ctx.strokeStyle = `rgba(255,214,10,${0.6 + 0.4 * Math.sin(now / 30)})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, RADIUS + 26 + 4 * Math.sin(now / 30), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.strokeStyle = p.perfect ? '#ffd60a' : p.ch >= 0.99 ? '#ff7b00' : '#ffe066';
      ctx.beginPath();
      ctx.arc(p.x, p.y, RADIUS + 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.ch);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawLabel(p, now) {
    const r = roster.get(p.id);
    if (!r) return;
    const mine = p.id === myId;
    const y = p.y - RADIUS - 18;
    if (r.cr) drawCrown(p.x, y - 22 + Math.sin(now / 200) * 3);
    ctx.font = `800 ${mine ? 20 : 17}px Segoe UI, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(10,20,50,0.7)';
    ctx.strokeText(r.n, p.x, y);
    ctx.fillStyle = mine ? '#ffe066' : '#fff';
    ctx.fillText(r.n, p.x, y);
    if (mine) {
      // Cooldown-Leiste unter dem eigenen Blob
      const w = 46;
      const yy = p.y + RADIUS + 14;
      ctx.fillStyle = 'rgba(10,20,50,0.45)';
      ctx.fillRect(p.x - w / 2, yy, w, 6);
      ctx.fillStyle = p.cd > 0 ? '#9fb7d9' : '#70e000';
      ctx.fillRect(p.x - w / 2, yy, w * (1 - p.cd), 6);
    }
  }

  function drawCrown(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#ffd60a';
    ctx.strokeStyle = '#a86b00';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-16, 8);
    ctx.lineTo(-18, -8);
    ctx.lineTo(-8, 0);
    ctx.lineTo(0, -12);
    ctx.lineTo(8, 0);
    ctx.lineTo(18, -8);
    ctx.lineTo(16, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ff4d6d';
    ctx.beginPath();
    ctx.arc(0, 2, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function updateParticles(dt, over) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (!!p.under === over) continue;
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * (p.life / p.max)), 0, Math.PI * 2);
      ctx.fill();
    }
    if (over) {
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.life -= dt;
        if (r.life <= 0) {
          rings.splice(i, 1);
          continue;
        }
        const k = 1 - r.life / r.max;
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = r.color;
        ctx.lineWidth = r.width * (1 - k * 0.6);
        ctx.beginPath();
        ctx.arc(r.x, r.y, 10 + r.maxR * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function updateTexts(dt) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      t.life -= dt;
      if (t.life <= 0) {
        texts.splice(i, 1);
        continue;
      }
      const k = 1 - t.life / t.max;
      const pop = k < 0.15 ? 0.6 + (k / 0.15) * 0.6 : 1.2 - Math.min(0.2, (k - 0.15) * 0.6);
      const y = t.y - k * 60;
      ctx.globalAlpha = t.life < 0.35 ? t.life / 0.35 : 1;
      ctx.font = `900 ${Math.round(t.size * pop)}px Segoe UI, system-ui, sans-serif`;
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(10,20,50,0.75)';
      ctx.strokeText(t.text, t.x, y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, y);
    }
    ctx.globalAlpha = 1;
  }

  function drawOffscreen(list, zs, sx, sy) {
    const m = 26;
    for (const p of list) {
      if (p.id === myId || p.f & F_FALL) continue;
      const x = W / 2 + sx + (p.x - cam.x) * zs;
      const y = H / 2 + sy + (p.y - cam.y) * zs;
      if (x > -10 && x < W + 10 && y > -10 && y < H + 10) continue;
      const ang = Math.atan2(y - H / 2, x - W / 2);
      const cx = Math.max(m, Math.min(W - m, x));
      const cy = Math.max(m, Math.min(H - m, y));
      const r = roster.get(p.id);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = r ? r.c : '#fff';
      ctx.strokeStyle = 'rgba(10,20,50,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(-8, -9);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (r && r.cr) {
        ctx.rotate(-ang);
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('👑', 0, -14);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Tutorial für Neue ----------
  const TUT = isTouch
    ? [
        { id: 'move', text: '👈 Linke Seite wischen = bewegen' },
        { id: 'dash', text: '👉 Rechte Seite halten & loslassen = DASH' },
        { id: 'perfect', text: '✨ Loslassen, wenn der Ring GOLDEN pulsiert = PERFEKT' },
        { id: 'goal', text: '💥 Schubs alle ins Wasser!' },
      ]
    : [
        { id: 'move', text: 'WASD / Pfeile = bewegen' },
        { id: 'dash', text: 'LEERTASTE halten & loslassen = DASH' },
        { id: 'perfect', text: '✨ Loslassen, wenn der Ring GOLDEN pulsiert = PERFEKT' },
        { id: 'goal', text: '💥 Schubs alle ins Wasser!' },
      ];
  let tutStep = localStorage.getItem('da_tut') === 'done' ? TUT.length : 0;
  let tutMoved = 0;
  let tutShownAt = 0;
  function tutStart() {
    tutShownAt = performance.now();
    tutRender();
  }
  function tutRender() {
    const el = $('hint');
    if (tutStep >= TUT.length) {
      el.className = '';
      return;
    }
    el.textContent = TUT[tutStep].text;
    el.className = 'show';
  }
  function tutAdvance() {
    tutStep++;
    tutShownAt = performance.now();
    if (tutStep >= TUT.length) localStorage.setItem('da_tut', 'done');
    const el = $('hint');
    el.className = '';
    setTimeout(tutRender, 350);
  }
  function tutEvent(kind) {
    if (tutStep >= TUT.length) return;
    const cur = TUT[tutStep].id;
    if ((cur === 'move' || cur === 'dash') && (kind === 'dash' || kind === 'perfect')) {
      // wer schon dasht, kann offensichtlich auch laufen
      tutStep = TUT.findIndex((t) => t.id === 'perfect') - 1;
      tutAdvance();
    }
    else if (cur === 'perfect' && kind === 'perfect') {
      tutAdvance();
    }
  }
  let tutLast = 0;
  function tutUpdate(me) {
    const tn = performance.now();
    const tdt = Math.min(0.1, (tn - (tutLast || tn)) / 1000);
    tutLast = tn;
    if (!joined || tutStep >= TUT.length || !me) return;
    const cur = TUT[tutStep].id;
    const [mx, my] = moveVec();
    if (cur === 'move' && (mx || my)) {
      tutMoved += tdt;
      if (tutMoved > 0.6) tutAdvance();
    }
    if (cur === 'goal' && performance.now() - tutShownAt > 4000) tutAdvance();
  }

  function drawVignette() {
    if (edgeDanger < 0.02) return;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(255,40,70,0)');
    g.addColorStop(1, `rgba(255,40,70,${0.45 * edgeDanger})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  let lastCountdown = '';
  function updateRespawn() {
    const r = roster.get(myId);
    if (!r || offset === null) return;
    if (!myAlive && r.dead) {
      const srvNow = performance.now() + offset - INTERP;
      const left = Math.max(0, (r.ra - srvNow) / 1000);
      const txt = left > 0.05 ? `Zurück in ${left.toFixed(1)}` : '';
      if (txt !== lastCountdown) {
        lastCountdown = txt;
        let el = $('center').querySelector('.cd');
        if (!el && txt) {
          el = document.createElement('div');
          el.className = 'sub cd';
          $('center').appendChild(el);
        }
        if (el) el.textContent = txt;
      }
    } else if (lastCountdown) {
      lastCountdown = '';
      const el = $('center').querySelector('.cd');
      if (el) el.remove();
    }
  }

  function updateTouchButton() {
    if (!isTouch) return;
    $('dashFill').style.height = Math.round(myCharge * 100) + '%';
    $('dashBtn').classList.toggle('cool', myCooldown > 0 && !touchCharge);
  }

  requestAnimationFrame(frame);
})();
