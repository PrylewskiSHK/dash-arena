// Sound-System: echte Samples aus /sfx (generiert mit Higgsfield / ElevenLabs),
// synthetische WebAudio-Sounds als Fallback, falls ein Sample fehlt.
window.SFX = (() => {
  const NAMES = ['hit', 'hit2', 'hit3', 'dash', 'clash', 'fall', 'ko', 'bump', 'charge', 'crown', 'alarm', 'spawn', 'perfect', 'music',
    'v_double', 'v_triple', 'v_rampage', 'v_unstoppable', 'v_godlike', 'v_bounty', 'v_king', 'v_close'];
  const SAMPLE_FILES = Object.fromEntries(NAMES.map((n) => [n, n + '.mp3']));
  let ctx = null;
  let master = null;
  let sfxBus = null;
  let musicBus = null;
  let voiceBus = null;
  let muted = localStorage.getItem('da_muted') === '1';
  let musicOn = localStorage.getItem('da_music') !== '0';
  let noiseBuf = null;
  let chargeNode = null;
  let musicSrc = null;
  const buffers = {};
  const gains = {};
  const VARIANTS = { hit: ['hit', 'hit2', 'hit3'] };
  const lastPlayed = {};

  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master.connect(comp);
    comp.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.8;
    sfxBus.connect(master);
    voiceBus = ctx.createGain();
    voiceBus.gain.value = 1.0;
    voiceBus.connect(master);
    musicBus = ctx.createGain();
    musicBus.gain.value = musicOn ? 0.32 : 0;
    musicBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    for (const [name, file] of Object.entries(SAMPLE_FILES)) load(name, file);
  }

  async function load(name, file) {
    try {
      const res = await fetch('sfx/' + file);
      if (!res.ok) return;
      const arr = await res.arrayBuffer();
      const raw = await ctx.decodeAudioData(arr);
      if (name === 'music') {
        buffers.music = raw;
        if (musicOn) startMusic();
        return;
      }
      const clean = polish(raw);
      if (!clean) {
        console.warn('Sound ist (fast) stumm, nehme Ersatz-Sound:', name);
        return;
      }
      buffers[name] = clean.buf;
      gains[name] = clean.gain;
    } catch (e) {
      console.warn('Sound konnte nicht geladen werden:', name, e);
    }
  }

  // Generierte Samples aufräumen: Stille vorne/hinten abschneiden (sonst kommt der
  // Sound spürbar zu spät), kurze Fades gegen Knackser, Lautstärke angleichen.
  function polish(buf) {
    const ch = buf.numberOfChannels;
    const len = buf.length;
    const sr = buf.sampleRate;
    let peak = 0;
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const v = Math.abs(d[i]);
        if (v > peak) peak = v;
      }
    }
    if (peak < 0.03) return null;
    let first = len;
    let last = 0;
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        if (Math.abs(d[i]) > peak * 0.08) {
          if (i < first) first = i;
          break;
        }
      }
      for (let i = len - 1; i >= 0; i--) {
        if (Math.abs(d[i]) > peak * 0.015) {
          if (i > last) last = i;
          break;
        }
      }
    }
    const start = Math.max(0, first - Math.floor(sr * 0.003));
    const end = Math.min(len, last + Math.floor(sr * 0.03));
    const n = Math.max(1, end - start);
    const out = ctx.createBuffer(ch, n, sr);
    const fadeIn = Math.min(n, Math.floor(sr * 0.002));
    const fadeOut = Math.min(n, Math.floor(sr * 0.025));
    for (let c = 0; c < ch; c++) {
      const src = buf.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < n; i++) {
        let v = src[start + i];
        if (i < fadeIn) v *= i / fadeIn;
        if (i > n - fadeOut) v *= (n - i) / fadeOut;
        dst[i] = v;
      }
    }
    return { buf: out, gain: Math.min(4, 0.9 / peak) };
  }

  // Sample abspielen. Gibt false zurück, wenn es (noch) nicht da ist.
  function sample(name, vol = 1, rate = 1, bus = sfxBus, minGap = 0.03) {
    // Varianten (hit, hit2, hit3 …) zufällig abwechseln
    const vars = VARIANTS[name];
    if (vars) {
      const avail = vars.filter((v) => buffers[v]);
      if (avail.length) name = avail[Math.floor(Math.random() * avail.length)];
    }
    const buf = buffers[name];
    if (!ctx || !buf) return false;
    vol *= gains[name] || 1;
    const t = ctx.currentTime;
    if (lastPlayed[name] && t - lastPlayed[name] < minGap) return true;
    lastPlayed[name] = t;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = vol;
    s.connect(g);
    g.connect(bus);
    s.start();
    return s;
  }

  function tone(type, f0, f1, dur, vol, delay = 0) {
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(sfxBus);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function noise(dur, vol, f0, f1, q = 1, type = 'bandpass', delay = 0) {
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(sfxBus);
    s.start(t);
    s.stop(t + dur + 0.02);
  }

  function jitter(a = 0.08) {
    return 1 + (Math.random() - 0.5) * a;
  }

  function startMusic() {
    if (!ctx || !buffers.music || musicSrc) return;
    musicSrc = ctx.createBufferSource();
    musicSrc.buffer = buffers.music;
    musicSrc.loop = true;
    musicSrc.connect(musicBus);
    musicSrc.start();
  }

  return {
    init,
    get muted() {
      return muted;
    },
    get musicOn() {
      return musicOn;
    },
    toggleMute() {
      muted = !muted;
      localStorage.setItem('da_muted', muted ? '1' : '0');
      if (master) master.gain.value = muted ? 0 : 0.8;
      return muted;
    },
    toggleMusic() {
      musicOn = !musicOn;
      localStorage.setItem('da_music', musicOn ? '1' : '0');
      if (musicBus) musicBus.gain.setTargetAtTime(musicOn ? 0.32 : 0, ctx.currentTime, 0.1);
      if (musicOn) startMusic();
      return musicOn;
    },
    // Musik kurz leiser (z. B. bei Zeitlupe)
    duck(amount = 0.35, ms = 500) {
      if (!ctx || !musicOn) return;
      const t = ctx.currentTime;
      musicBus.gain.cancelScheduledValues(t);
      musicBus.gain.setTargetAtTime(0.32 * amount, t, 0.03);
      musicBus.gain.setTargetAtTime(0.32, t + ms / 1000, 0.25);
    },
    setMusicRate(r) {
      if (musicSrc) musicSrc.playbackRate.setTargetAtTime(r, ctx.currentTime, 0.05);
    },
    dash(charge, vol = 1, perfect = false) {
      if (!sample('dash', 0.45 * vol, (0.95 + charge * 0.35) * jitter())) {
        noise(0.18 + charge * 0.15, 0.5 * vol, 600 + charge * 600, 3500 + charge * 3000, 0.8);
        tone('sine', 180 + charge * 120, 520 + charge * 500, 0.12, 0.12 * vol);
      }
      if (perfect) sample('perfect', 0.55 * vol, 1.1) || tone('sine', 1760, 1760, 0.15, 0.15 * vol);
    },
    hit(power, vol = 1) {
      const p = Math.min(1, power / 1500);
      // Bass-Layer immer synthetisch, damit es richtig drückt
      tone('sine', 140 + p * 40, 38, 0.25 + p * 0.15, (0.45 + p * 0.4) * vol);
      if (!sample('hit', (0.55 + p * 0.4) * vol, (1.15 - p * 0.3) * jitter(), sfxBus, 0.02)) {
        noise(0.08 + p * 0.06, 0.6 * vol, 2500, 400, 0.7);
        tone('square', 90, 40, 0.1, 0.08 * vol);
      }
    },
    clash(vol = 1) {
      tone('sine', 120, 35, 0.35, 0.6 * vol);
      if (!sample('clash', 0.6 * vol, jitter())) {
        tone('square', 880, 620, 0.25, 0.12 * vol);
        tone('square', 1310, 900, 0.3, 0.08 * vol);
        noise(0.15, 0.5 * vol, 4000, 1200, 1.5);
      }
    },
    bump(vol = 1) {
      if (!sample('bump', 0.3 * vol, jitter(0.2), sfxBus, 0.06)) tone('sine', 240, 110, 0.09, 0.22 * vol);
    },
    fall(vol = 1) {
      if (!sample('fall', 0.5 * vol, jitter())) {
        tone('sine', 900, 120, 0.7, 0.18 * vol);
        noise(0.5, 0.18 * vol, 1200, 200, 2, 'lowpass', 0.45);
      }
    },
    skid(vol = 1) {
      sample('skid', 0.25 * vol, jitter(0.2), sfxBus, 0.25);
    },
    ko(streak = 1) {
      const rate = Math.pow(1.06, Math.min(streak - 1, 8));
      if (!sample('ko', 0.55, rate)) {
        const base = 520 * rate;
        [0, 4, 7, 12].forEach((s, i) => tone('triangle', base * Math.pow(2, s / 12), base * Math.pow(2, s / 12), 0.16, 0.22, i * 0.06));
      }
    },
    bounty() {
      if (!sample('crown', 0.45, 1.1)) {
        [0, 5, 9, 12, 17].forEach((s, i) => tone('square', 660 * Math.pow(2, s / 12), 660 * Math.pow(2, s / 12), 0.12, 0.07, i * 0.07));
      }
    },
    spawn(vol = 1) {
      if (!sample('spawn', 0.3 * vol)) tone('sine', 300, 900, 0.18, 0.12 * vol);
    },
    alarm() {
      if (!sample('alarm', 0.22)) for (let i = 0; i < 4; i++) tone('square', 740, 740, 0.12, 0.06, i * 0.24);
    },
    crown() {
      if (!sample('crown', 0.45)) {
        [0, 7, 12].forEach((s, i) => tone('triangle', 880 * Math.pow(2, s / 12), 880 * Math.pow(2, s / 12), 0.2, 0.15, i * 0.08));
      }
    },
    out() {
      tone('sawtooth', 300, 60, 0.6, 0.1);
    },
    voice(name) {
      sample('v_' + name, 0.85, 1, voiceBus, 0.5);
    },
    chargeStart() {
      if (!ctx || chargeNode) return;
      const t = ctx.currentTime;
      if (buffers.charge) {
        const s = ctx.createBufferSource();
        s.buffer = buffers.charge;
        s.playbackRate.value = buffers.charge.duration / 0.6; // genau auf die Ladezeit
        const g = ctx.createGain();
        g.gain.value = 0.3 * (gains.charge || 1);
        s.connect(g);
        g.connect(sfxBus);
        s.start(t);
        chargeNode = { s, g };
        return;
      }
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(180, t);
      o.frequency.linearRampToValueAtTime(720, t + 0.6);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.05);
      o.connect(g);
      g.connect(sfxBus);
      o.start(t);
      chargeNode = { s: o, g };
    },
    chargeFull() {
      // Das Signal für den PERFEKT-Moment – muss klar hörbar sein
      tone('sine', 1568, 1568, 0.12, 0.16);
      tone('sine', 2093, 2093, 0.16, 0.1, 0.05);
    },
    chargeStop() {
      if (!chargeNode || !ctx) return;
      const t = ctx.currentTime;
      chargeNode.g.gain.cancelScheduledValues(t);
      chargeNode.g.gain.setValueAtTime(chargeNode.g.gain.value, t);
      chargeNode.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      try {
        chargeNode.s.stop(t + 0.06);
      } catch {}
      chargeNode = null;
    },
  };
})();
