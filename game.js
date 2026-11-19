'use strict';

/* ============================================================
   A timed aim trainer.
   Every tuning knob lives in CONFIG.
   ============================================================ */

const CONFIG = {
  startingPoints: 1000,
  defaultLength: 60, // seconds per round
  lengthOptions: [30, 60, 90, 120], // picked on the start screen

  basePoints: 100, // per shape hit
  movingBonus: 1.25, // moving shapes are worth a bit more
  critMultiplier: 1.5, // hitting the gold crit spot

  // Drain stages: once `from` (a share of the round, 0–1) has passed, every
  // shape still on screen costs `points` once every `every` seconds.
  // Both get worse over time, at the same pace whatever the round length.
  drainSchedule: [
    { from: 0, every: 1.0, points: 20 },
    { from: 0.25, every: 0.8, points: 30 },
    { from: 0.5, every: 0.6, points: 40 },
    { from: 0.75, every: 0.5, points: 50 },
  ],

  missPenalty: 25, // clicking empty space

  combo: {
    stepPerHit: 0.1, // multiplier gained per hit (crits count as 2 hits)
    max: 3, // multiplier cap
    timeout: 2.5, // seconds without a hit before the combo drops
  },

  spawn: {
    interval: [0.9, 0.45], // seconds between spawns, start → end of game
    maxOnScreen: [3, 6], // start → end of game
    hardCap: 30, // never more than this, even with shapes sent over in a team battle
  },

  shapes: {
    radius: [24, 44], // base size range on a ~800px-tall play area
    endScale: 0.8, // shapes shrink to 80% by the end
    movingChance: [0.25, 0.7], // start → end of game
    speed: [
      [60, 150], // px/s at the start
      [130, 300], // px/s at the end
    ],
    turnChance: 0.35, // share of movers that curve instead of going straight
    spinChance: 0.6, // share of movers that spin (so the crit orbits)
    critPlacement: { inside: 0.35, edge: 0.35, outside: 0.3 },
  },
};

const TAU = Math.PI * 2;
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const GOLD = '#ffd60a';
const RED = '#ff4d5e';
const GREEN = '#5dffa3';
const KEYS = { best: 'aim.best', bestLance: 'aim.best.lance', muted: 'aim.muted', calm: 'aim.calm', length: 'aim.length' };

// Each mode and round length keeps its own best. 60s rounds use the original
// keys so bests saved before round lengths existed still count.
function bestKey(mode, length) {
  const base = mode === 'lance' ? KEYS.bestLance : KEYS.best;
  return length === 60 ? base : `${base}.${length}s`;
}

/* ---------- DOM ---------- */

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
// Off-screen context used only for point-in-shape tests (identity transform).
const hitCtx = document.createElement('canvas').getContext('2d');
hitCtx.lineWidth = 6; // a few px of forgiveness around shape edges

const ui = {
  hud: $('hud'),
  score: $('score'),
  time: $('time'),
  drain: $('drain-rate'),
  pips: $('drain-pips'),
  mute: $('mute'),
  menu: $('menu'),
  over: $('over'),
  start: $('start'),
  startLance: $('start-lance'),
  again: $('again'),
  toMenu: $('to-menu'),
  overTitle: $('over-title'),
  calm: $('reduce-flash'),
  rules: $('rules'),
  bestMenu: $('best-menu'),
  finalScore: $('final-score'),
  breakdown: $('breakdown'),
  bestLine: $('best-line'),
  stats: $('stats'),
  lengths: $('lengths'),
  lengthText: $('length-text'),
  teambar: $('teambar'),
  overActions: $('over-actions'),
  overHint: $('over-hint'),
  partyResults: $('party-results'),
  partyOverActions: $('party-over-actions'),
  pauseBtn: $('pause-btn'),
  pause: $('pause'),
  pauseTitle: $('pause-title'),
  pauseHint: $('pause-hint'),
  pauseMeta: $('pause-meta'),
  resume: $('resume'),
  restart: $('restart'),
  quit: $('quit'),
};

/* ---------- Helpers ---------- */

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sign = () => (Math.random() < 0.5 ? -1 : 1);
const fmt = (n) => (n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('en-US');
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function weighted(weights) {
  let roll = Math.random() * Object.values(weights).reduce((a, b) => a + b, 0);
  for (const [key, w] of Object.entries(weights)) {
    roll -= w;
    if (roll <= 0) return key;
  }
  return Object.keys(weights)[0];
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable — fine, it's just a convenience */
    }
  },
};

const prefersCalm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const savedLength = store.get(KEYS.length, CONFIG.defaultLength);
const settings = {
  muted: store.get(KEYS.muted, false),
  calm: store.get(KEYS.calm, prefersCalm), // fewer flashes, no shake / drift
  length: CONFIG.lengthOptions.includes(savedLength) ? savedLength : CONFIG.defaultLength,
};

/* ---------- Sound ---------- */

let audioCtx = null;
let lastDrainSfx = 0;

function ensureAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!audioCtx && AC) audioCtx = new AC();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function tone(freq, dur, { type = 'sine', vol = 0.1, slide = 0, delay = 0 } = {}) {
  if (settings.muted || !audioCtx) return;
  const t0 = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

const sfx = {
  hit: (m) => tone(480 + m * 120, 0.09, { type: 'triangle', slide: 820 + m * 180 }),
  crit: (m) => {
    tone(880 + m * 60, 0.06, { type: 'square', vol: 0.05, slide: 1760 });
    tone(1320 + m * 90, 0.14, { type: 'triangle', vol: 0.09, delay: 0.045, slide: 2400 });
  },
  miss: () => tone(190, 0.12, { type: 'sawtooth', vol: 0.05, slide: 90 }),
  drain: () => {
    const now = performance.now();
    if (now - lastDrainSfx < 90) return;
    lastDrainSfx = now;
    tone(150, 0.05, { type: 'square', vol: 0.025 });
  },
  comboLost: () => tone(420, 0.2, { type: 'triangle', vol: 0.08, slide: 150 }),
  milestone: () => [660, 880, 1100].forEach((f, i) => tone(f, 0.1, { type: 'square', vol: 0.05, delay: i * 0.06 })),
  warn: () => {
    tone(300, 0.12, { type: 'sawtooth', vol: 0.05 });
    tone(240, 0.16, { type: 'sawtooth', vol: 0.05, delay: 0.13 });
  },
  incoming: () => tone(330, 0.14, { type: 'square', vol: 0.04, slide: 165 }),
  count: () => tone(660, 0.1, { type: 'triangle', vol: 0.09 }),
  go: () => tone(990, 0.25, { type: 'square', vol: 0.06, slide: 1480 }),
  end: () => [784, 659, 523].forEach((f, i) => tone(f, 0.18, { type: 'triangle', vol: 0.09, delay: i * 0.12 })),
};

/* ---------- Shapes ---------- */

function polygon(n, R, start) {
  const p = new Path2D();
  for (let i = 0; i < n; i++) {
    const a = start + (i * TAU) / n;
    if (i === 0) p.moveTo(Math.cos(a) * R, Math.sin(a) * R);
    else p.lineTo(Math.cos(a) * R, Math.sin(a) * R);
  }
  p.closePath();
  return p;
}

function star(points, outer, inner) {
  const p = new Path2D();
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const R = i % 2 === 0 ? outer : inner;
    if (i === 0) p.moveTo(Math.cos(a) * R, Math.sin(a) * R);
    else p.lineTo(Math.cos(a) * R, Math.sin(a) * R);
  }
  p.closePath();
  return p;
}

function cross(arm, half) {
  const pts = [
    [-half, -arm], [half, -arm], [half, -half], [arm, -half], [arm, half], [half, half],
    [half, arm], [-half, arm], [-half, half], [-arm, half], [-arm, -half], [-half, -half],
  ];
  const p = new Path2D();
  pts.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
  p.closePath();
  return p;
}

// Each builder takes a nominal radius r; sizes are tuned so shapes look similar in weight.
const SHAPES = {
  circle: { color: '#4cc9f0', build: (r) => { const p = new Path2D(); p.arc(0, 0, r, 0, TAU); return p; } },
  square: { color: '#f72585', build: (r) => { const s = r * 0.88; const p = new Path2D(); p.rect(-s, -s, s * 2, s * 2); return p; } },
  triangle: { color: '#80ffdb', build: (r) => polygon(3, r * 1.3, -Math.PI / 2) },
  diamond: { color: '#ff6b6b', build: (r) => polygon(4, r * 1.2, -Math.PI / 2) },
  pentagon: { color: '#b388ff', build: (r) => polygon(5, r * 1.08, -Math.PI / 2) },
  hexagon: { color: '#06d6a0', build: (r) => polygon(6, r * 1.04, 0) },
  star: { color: '#ff8fd8', build: (r) => star(5, r * 1.35, r * 0.62) },
  plus: { color: '#4895ef', build: (r) => cross(r * 1.15, r * 0.44) },
};
const SHAPE_TYPES = Object.keys(SHAPES);

// Distance from the shape's centre to its edge along an angle.
// All shapes are "star-shaped" around their centre, so a binary search works.
function edgeDistance(path, angle, r) {
  const cx = Math.cos(angle);
  const cy = Math.sin(angle);
  let lo = 0;
  let hi = r * 1.8;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (hitCtx.isPointInPath(path, cx * mid, cy * mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/* ---------- Layout ---------- */

let W = 0;
let H = 0;
let dpr = 1;
let hudH = 70;
const bg = document.createElement('canvas');
const bgCtx = bg.getContext('2d');

function bounds() {
  return { left: 8, right: W - 8, top: hudH + 6, bottom: H - 8 };
}

function sizeScale() {
  return clamp(Math.min(W, H - hudH) / 800, 0.6, 1.3);
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  for (const c of [canvas, bg]) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
  }
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  hudH = ui.hud.offsetHeight || 70;
  paintBackground();
  for (const s of state.shapes) keepInBounds(s);
}

function paintBackground() {
  const g = bgCtx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const grad = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
  grad.addColorStop(0, '#121633');
  grad.addColorStop(1, '#06070d');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255, 255, 255, 0.035)';
  g.lineWidth = 1;
  g.beginPath();
  const step = 48;
  for (let x = (W / 2) % step; x < W; x += step) {
    g.moveTo(Math.round(x) + 0.5, 0);
    g.lineTo(Math.round(x) + 0.5, H);
  }
  for (let y = (H / 2) % step; y < H; y += step) {
    g.moveTo(0, Math.round(y) + 0.5);
    g.lineTo(W, Math.round(y) + 0.5);
  }
  g.stroke();
}

/* ---------- Game state ---------- */

function freshStats() {
  return { hits: 0, crits: 0, misses: 0, earned: 0, drained: 0, missPenalty: 0 };
}

const state = {
  phase: 'menu', // menu → countdown → playing → over
  paused: false, // only during countdown / playing; freezes everything
  mode: 'normal', // 'normal' | 'lance'
  length: settings.length, // seconds in this round
  score: CONFIG.startingPoints,
  elapsed: 0,
  countdown: 0,
  overTimer: 0,
  shapes: [],
  effects: [],
  floaters: [],
  combo: 0,
  bestCombo: 0,
  comboTimer: 0,
  comboPop: 0,
  spawnTimer: 0,
  drainPhase: 0,
  banner: null,
  shake: 0,
  stats: freshStats(),
};

// Lance mode pins every difficulty knob at its end-of-game value from the first second.
const isLance = () => state.mode === 'lance';
// A team battle round (see party.js).
const inParty = () => state.mode === 'party';

// Team battle (party.js) plugs into these. Solo play never needs them.
const net = {
  busy: () => false, // true while a team battle room is open: solo shortcuts stay off
  pop: () => {}, // this player popped a shape
  score: (score) => {}, // this player's score changed
  roundOver: (summary) => {}, // this player's round ended
  leave: () => {}, // this player quit from the in-game menu
};

const progress = () => (isLance() ? 1 : clamp(state.elapsed / state.length, 0, 1));

function drainPhaseIndex() {
  if (isLance()) return CONFIG.drainSchedule.length - 1;
  let idx = 0;
  CONFIG.drainSchedule.forEach((step, i) => {
    if (state.elapsed >= step.from * state.length) idx = i;
  });
  return idx;
}

const drainStage = () => CONFIG.drainSchedule[drainPhaseIndex()];
const drainInterval = () => drainStage().every;

function multiplierFor(combo) {
  const m = 1 + combo * CONFIG.combo.stepPerHit;
  return Math.round(Math.min(CONFIG.combo.max, m) * 10) / 10;
}
const multiplier = () => multiplierFor(state.combo);

/* ---------- Spawning ---------- */

function createShape() {
  const p = progress();
  const cfg = CONFIG.shapes;
  const scale = sizeScale();
  const type = pick(SHAPE_TYPES);
  const def = SHAPES[type];
  const r = rand(cfg.radius[0], cfg.radius[1]) * scale * lerp(1, cfg.endScale, p);
  const path = def.build(r);

  let outerR = 0;
  for (let i = 0; i < 24; i++) outerR = Math.max(outerR, edgeDistance(path, (i / 24) * TAU, r));

  // Crit spot: somewhere inside, sitting on the edge, or hanging off on a stem.
  const critR = clamp(r * 0.3, 7, 13);
  const angle = rand(0, TAU);
  const edge = edgeDistance(path, angle, r);
  const mode = weighted(cfg.critPlacement);
  let dist = edge;
  if (mode === 'inside') dist = edge * rand(0.1, 0.55);
  if (mode === 'outside') dist = edge + critR + rand(6, 20) * scale;

  const moving = Math.random() < lerp(cfg.movingChance[0], cfg.movingChance[1], p);
  const speedLo = lerp(cfg.speed[0][0], cfg.speed[1][0], p);
  const speedHi = lerp(cfg.speed[0][1], cfg.speed[1][1], p);
  const speed = rand(speedLo, speedHi) * scale;
  const dir = rand(0, TAU);

  return {
    type,
    color: def.color,
    fill: rgba(def.color, 0.38),
    path,
    r,
    outerR,
    bound: Math.max(outerR, dist + critR) + 4, // for wall bounces
    crit: { angle, dist, edge, r: critR, mode },
    x: 0,
    y: 0,
    rot: rand(0, TAU),
    moving,
    vx: moving ? Math.cos(dir) * speed : 0,
    vy: moving ? Math.sin(dir) * speed : 0,
    turn: moving && Math.random() < cfg.turnChance ? rand(0.8, 2.2) * sign() : 0,
    spin: moving && Math.random() < cfg.spinChance ? rand(0.8, 2.6) * sign() : 0,
    age: 0,
    drainTimer: 0,
    flash: 0,
    seed: rand(0, TAU),
    attack: false, // sent over by the other team in a team battle
    attackColor: '',
  };
}

function keepInBounds(s) {
  const b = bounds();
  s.x = clamp(s.x, b.left + s.bound, Math.max(b.left + s.bound, b.right - s.bound));
  s.y = clamp(s.y, b.top + s.bound, Math.max(b.top + s.bound, b.bottom - s.bound));
}

function spawnShape() {
  const s = createShape();
  const b = bounds();
  for (let tries = 0; tries < 30; tries++) {
    s.x = rand(b.left + s.bound, b.right - s.bound);
    s.y = rand(b.top + s.bound, b.bottom - s.bound);
    const clear = state.shapes.every((o) => Math.hypot(o.x - s.x, o.y - s.y) > o.bound + s.bound + 10);
    if (clear) break;
  }
  keepInBounds(s);
  state.shapes.push(s);
  return s;
}

// Team battle: someone on the other team popped a shape, so one lands here.
function spawnIncoming(fromName, color) {
  if (state.phase !== 'playing' || state.shapes.length >= CONFIG.spawn.hardCap) return;
  const s = spawnShape();
  s.attack = true;
  s.attackColor = color;
  floater(s.x, s.y - s.bound - 18, `+1 from ${fromName}`, color, 15, 1.1);
  sfx.incoming();
}

/* ---------- Effects ---------- */

function burst(x, y, color, count, power = 1) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, TAU);
    const sp = rand(80, 330) * power;
    const life = rand(0.3, 0.6);
    state.effects.push({ kind: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life, color, size: rand(2, 4.5) });
  }
}

function ring(x, y, r, color, life = 0.35) {
  state.effects.push({ kind: 'ring', x, y, r, grow: r * 0.8 + 24, life, max: life, color });
}

function floater(x, y, text, color, size = 18, life = 0.8) {
  state.floaters.push({ x, y, text, color, size, life, max: life });
}

function showBanner(text, sub = '', life = 1.4) {
  state.banner = { text, sub, life, max: life };
}

function multiplierCenter() {
  return { x: W / 2, y: hudH + (H - hudH) / 2 };
}

/* ---------- Game flow ---------- */

function blurFocus() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

// Start a round from the menu or results screen (ignored mid-round).
function startGame(mode = 'normal') {
  if (net.busy()) return;
  if (state.phase === 'countdown' || state.phase === 'playing') return;
  if (state.phase === 'over' && state.overTimer > 0) return;
  beginRound(mode);
}

// Reset everything and count in a fresh round. Also used by Restart,
// and by party.js when the host starts a team battle.
function beginRound(mode, length = settings.length) {
  ensureAudio();
  Object.assign(state, {
    phase: 'countdown',
    paused: false,
    mode,
    length,
    countdown: 3,
    score: CONFIG.startingPoints,
    elapsed: 0,
    overTimer: 0,
    shapes: [],
    effects: [],
    floaters: [],
    combo: 0,
    bestCombo: 0,
    comboTimer: 0,
    comboPop: 0,
    spawnTimer: 0,
    drainPhase: mode === 'lance' ? CONFIG.drainSchedule.length - 1 : 0,
    banner: null,
    shake: 0,
    stats: freshStats(),
  });
  ui.menu.classList.add('hidden');
  ui.over.classList.add('hidden');
  ui.pause.classList.add('hidden');
  ui.teambar.hidden = mode !== 'party';
  ui.hud.classList.remove('hidden');
  hudH = ui.hud.offsetHeight || hudH;
  blurFocus();
  sfx.count();
  updateHud(true);
}

/* ---------- Pause menu ---------- */

// In a team battle the menu doesn't freeze anything: everyone else is still playing.
const canPause = () => !state.paused && (state.phase === 'countdown' || state.phase === 'playing');

function pauseGame() {
  if (!canPause()) return;
  state.paused = true;
  const teamBattle = inParty();
  if (teamBattle) {
    ui.pauseMeta.textContent = 'The battle keeps going while this is open.';
  } else {
    const remaining = Math.ceil(Math.max(0, state.length - state.elapsed));
    const parts = [`${remaining}s left`, `Score ${fmt(state.score)}`];
    if (isLance()) parts.push('Lance mode');
    ui.pauseMeta.textContent = parts.join(' · ');
  }
  ui.pauseTitle.textContent = teamBattle ? 'Menu' : 'Paused';
  ui.resume.textContent = teamBattle ? 'Keep playing' : 'Resume';
  ui.restart.hidden = teamBattle;
  ui.quit.textContent = teamBattle ? 'Leave game' : 'Quit to main menu';
  ui.pauseHint.textContent = teamBattle ? 'Esc to close' : 'Esc to resume · R to restart';
  ui.pause.classList.remove('hidden');
  ui.resume.focus({ preventScroll: true });
}

function resumeGame() {
  if (!state.paused) return;
  state.paused = false;
  ui.pause.classList.add('hidden');
  blurFocus();
  ensureAudio();
}

function restartGame() {
  if (state.paused && !inParty()) beginRound(state.mode);
}

function endGame() {
  state.phase = 'over';
  state.overTimer = 1.2;
  for (const s of state.shapes) burst(s.x, s.y, s.color, 8, 0.6);
  state.shapes = [];
  state.combo = 0;
  showBanner('TIME!', '', 1.2);
  sfx.end();
  updateHud(true);
}

// The results card has a solo layout (your score, best) and a team battle layout
// (team scores, filled in by party.js).
function setOverLayout(teamBattle) {
  for (const el of [ui.finalScore, ui.breakdown, ui.bestLine, ui.overActions, ui.overHint]) el.hidden = teamBattle;
  ui.partyResults.hidden = !teamBattle;
  ui.partyOverActions.hidden = !teamBattle;
}

function showResults() {
  const st = state.stats;
  const final = Math.round(state.score);
  const shots = st.hits + st.misses;
  const accuracy = shots ? Math.round((st.hits / shots) * 100) : 0;
  const critRate = st.hits ? Math.round((st.crits / st.hits) * 100) : 0;

  const rows = [
    ['Hits', st.hits],
    ['Crits', `${st.crits} (${critRate}%)`],
    ['Accuracy', `${accuracy}%`],
    ['Best combo', `${state.bestCombo} · ×${multiplierFor(state.bestCombo).toFixed(1)}`],
  ];
  ui.stats.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  if (inParty()) {
    // Team battle scores aren't saved as bests; the host collects everyone's and sends results.
    setOverLayout(true);
    ui.overTitle.textContent = `Team battle · ${state.length}s`;
    ui.over.classList.remove('hidden');
    net.roundOver({ score: final });
    return;
  }
  setOverLayout(false);

  // Each mode and round length keeps its own best so they don't get compared.
  const key = bestKey(state.mode, state.length);
  const prevBest = store.get(key, null);
  const isBest = prevBest === null || final > prevBest;
  if (isBest) store.set(key, final);

  ui.overTitle.textContent = ['Final score', `${state.length}s`, isLance() ? 'Lance mode' : '']
    .filter(Boolean)
    .join(' · ');
  ui.finalScore.textContent = fmt(final);
  ui.finalScore.classList.toggle('negative', final < 0);
  ui.breakdown.textContent =
    `${fmt(CONFIG.startingPoints)} start + ${fmt(st.earned)} earned − ` +
    `${fmt(st.drained)} drained − ${fmt(st.missPenalty)} miss penalty`;
  if (prevBest === null) ui.bestLine.textContent = 'First run — that’s the score to beat.';
  else if (isBest) ui.bestLine.textContent = `New best! (was ${fmt(prevBest)})`;
  else ui.bestLine.textContent = `Best: ${fmt(prevBest)}`;

  renderBestMenu();
  ui.over.classList.remove('hidden');
}

// Back to the start screen. A round quit from the pause menu isn't scored.
function goToMenu() {
  Object.assign(state, { phase: 'menu', mode: 'normal', paused: false, shapes: [], effects: [], floaters: [], banner: null, combo: 0, shake: 0 });
  ui.over.classList.add('hidden');
  ui.pause.classList.add('hidden');
  ui.hud.classList.add('hidden');
  ui.menu.classList.remove('hidden');
  blurFocus();
}

function showMenu() {
  if (state.phase !== 'over' || state.overTimer > 0) return;
  goToMenu();
}

function quitToMenu() {
  if (!state.paused) return;
  if (inParty()) net.leave();
  else goToMenu();
}

function dropCombo(label) {
  const hadCombo = state.combo >= 3;
  state.combo = 0;
  state.comboTimer = 0;
  if (hadCombo) {
    const c = multiplierCenter();
    floater(c.x, c.y + Math.min(W, H) * 0.12, label, RED, 22, 1);
    sfx.comboLost();
  }
}

/* ---------- Input ---------- */

function hitTest(s, px, py) {
  // Move the click into the shape's own (unrotated) coordinates.
  const dx = px - s.x;
  const dy = py - s.y;
  const c = Math.cos(s.rot);
  const sn = Math.sin(s.rot);
  const lx = dx * c + dy * sn;
  const ly = -dx * sn + dy * c;

  const k = s.crit;
  const kx = Math.cos(k.angle) * k.dist;
  const ky = Math.sin(k.angle) * k.dist;
  if (Math.hypot(lx - kx, ly - ky) <= k.r + 2) return 'crit';
  if (hitCtx.isPointInPath(s.path, lx, ly) || hitCtx.isPointInStroke(s.path, lx, ly)) return 'body';
  if (k.mode === 'outside') {
    const ex = Math.cos(k.angle) * k.edge;
    const ey = Math.sin(k.angle) * k.edge;
    if (distToSegment(lx, ly, ex, ey, kx, ky) <= 5) return 'body';
  }
  return null;
}

function shoot(px, py) {
  // Newest shapes are drawn on top, so check them first.
  for (let i = state.shapes.length - 1; i >= 0; i--) {
    const kind = hitTest(state.shapes[i], px, py);
    if (kind) {
      registerHit(i, kind === 'crit', px, py);
      return;
    }
  }
  registerMiss(px, py);
}

function registerHit(index, crit, px, py) {
  const s = state.shapes[index];
  state.shapes.splice(index, 1);

  const mult = multiplier();
  const base = CONFIG.basePoints * (s.moving ? CONFIG.movingBonus : 1);
  const pts = Math.round(base * (crit ? CONFIG.critMultiplier : 1) * mult);
  state.score += pts;
  state.stats.hits++;
  state.stats.earned += pts;
  if (crit) state.stats.crits++;

  state.combo += crit ? 2 : 1;
  state.bestCombo = Math.max(state.bestCombo, state.combo);
  state.comboTimer = CONFIG.combo.timeout;
  state.comboPop = 1;
  const newMult = multiplier();

  burst(s.x, s.y, s.color, 14, 1);
  ring(s.x, s.y, s.outerR, s.color);
  if (crit) {
    burst(px, py, GOLD, 18, 1.3);
    ring(px, py, s.crit.r, GOLD, 0.45);
    state.shake = Math.max(state.shake, 5);
  }
  floater(px, py - 14, `+${pts}${crit ? ' CRIT' : ''}`, crit ? GOLD : '#ffffff', crit ? 26 : 20);
  if (inParty()) net.pop(); // sends a shape to someone on the other team

  if (Math.floor(newMult) > Math.floor(mult)) {
    showBanner(`×${newMult.toFixed(1)}`, 'MULTIPLIER UP', 1);
    sfx.milestone();
  } else if (crit) sfx.crit(newMult);
  else sfx.hit(newMult);
}

function registerMiss(px, py) {
  state.score -= CONFIG.missPenalty;
  state.stats.misses++;
  state.stats.missPenalty += CONFIG.missPenalty;
  ring(px, py, 3, RED, 0.3);
  floater(px, py - 10, `−${CONFIG.missPenalty} MISS`, RED, 15, 0.6);
  state.shake = Math.max(state.shake, 3);
  sfx.miss();
  dropCombo('COMBO LOST');
}

function drainTick(s) {
  const pts = drainStage().points;
  state.score -= pts;
  state.stats.drained += pts;
  s.flash = 0.18;
  floater(s.x, s.y - s.outerR - 10, `−${pts}`, '#ff8a95', 14, 0.6);
  sfx.drain();
}

canvas.addEventListener('pointerdown', (e) => {
  if (state.phase !== 'playing' || state.paused) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  shoot(e.clientX - rect.left, e.clientY - rect.top);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.target instanceof HTMLInputElement && e.target.type === 'text') return; // typing a name or room code
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const activatesButton = key === ' ' || key === 'Enter';
  if (key === ' ' && e.target instanceof HTMLInputElement) return; // Space toggles a focused checkbox / radio
  if (activatesButton && e.target instanceof HTMLButtonElement) return; // let the focused button handle it

  if (key === 'Escape' || key === 'p') {
    if (state.paused) resumeGame();
    else pauseGame();
    return;
  }
  if (key === 'm') {
    toggleMute();
    return;
  }
  if (state.paused) {
    if (key === 'r') restartGame();
    else if (activatesButton) {
      e.preventDefault();
      resumeGame();
    }
    return;
  }
  if (net.busy()) return; // in a team battle room: no solo shortcuts
  if (key === 'l') {
    e.preventDefault();
    startGame('lance');
    return;
  }
  if (activatesButton) {
    e.preventDefault();
    startGame(state.phase === 'over' ? state.mode : 'normal');
  }
});

// After a mouse click, drop focus from a checkbox / radio so Space still starts the game.
// Keyboard users keep focus (they're on :focus-visible) so arrow keys keep working.
function releaseMouseFocus(input) {
  if (!input.matches(':focus-visible')) input.blur();
}

ui.start.addEventListener('click', () => startGame('normal'));
ui.startLance.addEventListener('click', () => startGame('lance'));
ui.again.addEventListener('click', () => startGame(state.mode));
ui.toMenu.addEventListener('click', showMenu);
ui.pauseBtn.addEventListener('click', pauseGame);
ui.resume.addEventListener('click', resumeGame);
ui.restart.addEventListener('click', restartGame);
ui.quit.addEventListener('click', quitToMenu);
ui.mute.addEventListener('click', () => {
  toggleMute();
  ui.mute.blur();
});
ui.calm.addEventListener('change', () => {
  settings.calm = ui.calm.checked;
  store.set(KEYS.calm, settings.calm);
  document.body.classList.toggle('calm', settings.calm);
  releaseMouseFocus(ui.calm);
});
ui.lengths.addEventListener('change', (e) => {
  if (!(e.target instanceof HTMLInputElement)) return;
  setLength(Number(e.target.value));
  releaseMouseFocus(e.target);
});
window.addEventListener('resize', resize);
// Switching tabs or minimising mid-round pauses instead of silently draining.
// (Not in a team battle: the round's clock keeps running for everyone.)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !inParty()) pauseGame();
});

function toggleMute() {
  settings.muted = !settings.muted;
  store.set(KEYS.muted, settings.muted);
  renderMute();
}

/* ---------- Update ---------- */

// `dt` is capped so motion stays smooth after a hiccup. `rawDt` is the real time
// that passed: a team battle's clock uses it so everyone's round ends together,
// even if this tab was in the background for a while.
function update(dt, rawDt = dt) {
  if (state.paused && !inParty()) return;
  const clockDt = inParty() ? rawDt : dt;
  state.comboPop = Math.max(0, state.comboPop - dt * 3.5);
  state.shake = Math.max(0, state.shake - dt * 30);
  updateEffects(dt);
  if (state.banner) {
    state.banner.life -= dt;
    if (state.banner.life <= 0) state.banner = null;
  }

  if (state.phase === 'countdown') {
    const before = Math.ceil(state.countdown);
    state.countdown -= clockDt;
    const after = Math.ceil(state.countdown);
    if (after !== before && after > 0) sfx.count();
    if (state.countdown <= 0) {
      state.phase = 'playing';
      showBanner('GO!', '', 0.7);
      sfx.go();
    }
    return;
  }

  if (state.phase === 'over') {
    if (state.overTimer > 0) {
      state.overTimer -= dt;
      if (state.overTimer <= 0) showResults();
    }
    return;
  }

  if (state.phase !== 'playing') return;

  state.elapsed += clockDt;
  if (state.elapsed >= state.length) {
    state.elapsed = state.length;
    endGame();
    return;
  }

  const phase = drainPhaseIndex();
  const interval = drainInterval();
  if (phase !== state.drainPhase) {
    state.drainPhase = phase;
    const stage = drainStage();
    showBanner('DRAIN GETS WORSE', `−${stage.points} every ${stage.every.toFixed(1)}s`, 1.6);
    sfx.warn();
  }

  if (state.combo > 0) {
    state.comboTimer -= dt;
    if (state.comboTimer <= 0) dropCombo('COMBO DROPPED');
  }

  // Spawning: never leave the screen empty; otherwise spawn on a timer up to a cap.
  const p = progress();
  const maxShapes = Math.round(lerp(CONFIG.spawn.maxOnScreen[0], CONFIG.spawn.maxOnScreen[1], p));
  state.spawnTimer -= dt;
  if (state.shapes.length === 0 || (state.spawnTimer <= 0 && state.shapes.length < maxShapes)) {
    spawnShape();
    state.spawnTimer = lerp(CONFIG.spawn.interval[0], CONFIG.spawn.interval[1], p);
  }

  for (const s of state.shapes) updateShape(s, dt, interval);
  updateHud();
}

function updateShape(s, dt, interval) {
  s.age += dt;
  s.flash = Math.max(0, s.flash - dt);

  s.drainTimer += dt;
  while (s.drainTimer >= interval) {
    s.drainTimer -= interval;
    drainTick(s);
  }

  if (!s.moving) return;
  if (s.turn) {
    const a = s.turn * dt;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const vx = s.vx * c - s.vy * sn;
    s.vy = s.vx * sn + s.vy * c;
    s.vx = vx;
  }
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.rot += s.spin * dt;

  const b = bounds();
  if (s.x - s.bound < b.left) {
    s.x = b.left + s.bound;
    s.vx = Math.abs(s.vx);
  } else if (s.x + s.bound > b.right) {
    s.x = b.right - s.bound;
    s.vx = -Math.abs(s.vx);
  }
  if (s.y - s.bound < b.top) {
    s.y = b.top + s.bound;
    s.vy = Math.abs(s.vy);
  } else if (s.y + s.bound > b.bottom) {
    s.y = b.bottom - s.bound;
    s.vy = -Math.abs(s.vy);
  }
}

function updateEffects(dt) {
  for (const e of state.effects) {
    e.life -= dt;
    if (e.kind === 'spark') {
      const drag = Math.max(0, 1 - 4 * dt);
      e.vx *= drag;
      e.vy *= drag;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
    }
  }
  state.effects = state.effects.filter((e) => e.life > 0);

  for (const f of state.floaters) {
    f.life -= dt;
    f.y -= 55 * dt;
  }
  state.floaters = state.floaters.filter((f) => f.life > 0);
}

/* ---------- HUD (DOM) ---------- */

const hudCache = { score: null, time: null, phase: null };

function updateHud(force = false) {
  const score = Math.round(state.score);
  if (force || score !== hudCache.score) {
    const delta = hudCache.score === null ? 0 : score - hudCache.score;
    ui.score.textContent = fmt(score);
    ui.score.classList.toggle('negative', score < 0);
    if (delta && !force) pulseScore(delta > 0, score < 0);
    hudCache.score = score;
    if (inParty()) net.score(score);
  }

  const remaining = Math.max(0, state.length - state.elapsed);
  const timeText = remaining < 10 ? remaining.toFixed(1) : String(Math.ceil(remaining));
  if (force || timeText !== hudCache.time) {
    ui.time.textContent = timeText;
    ui.time.classList.toggle('urgent', remaining < 10 && state.phase === 'playing');
    hudCache.time = timeText;
  }

  const phase = drainPhaseIndex();
  if (force || phase !== hudCache.phase) {
    const stage = CONFIG.drainSchedule[phase];
    ui.drain.textContent = `−${stage.points} / ${stage.every.toFixed(1)}s`;
    Array.from(ui.pips.children).forEach((pip, i) => pip.classList.toggle('on', i <= phase));
    hudCache.phase = phase;
  }
}

function pulseScore(gain, negative) {
  const rest = negative ? '#ff8a95' : '#f4f6ff';
  const frames = settings.calm
    ? [{ color: gain ? GREEN : RED }, { color: rest }]
    : [
        { color: gain ? GREEN : RED, transform: `scale(${gain ? 1.14 : 1.05})` },
        { color: rest, transform: 'scale(1)' },
      ];
  ui.score.animate(frames, { duration: gain ? 260 : 160, easing: 'ease-out' });
}

function renderMute() {
  ui.mute.textContent = settings.muted ? 'Sound: off' : 'Sound: on';
}

// Bests shown on the start screen are for the round length currently picked.
function renderBestMenu() {
  const len = settings.length;
  const best = store.get(bestKey('normal', len), null);
  const lanceBest = store.get(bestKey('lance', len), null);
  const parts = [];
  if (best !== null) parts.push(`${len}s best: ${fmt(best)}`);
  if (lanceBest !== null) parts.push(`Lance best: ${fmt(lanceBest)}`);
  ui.bestMenu.textContent = parts.join(' · ');
}

// Builds the 30s / 60s / … radio buttons once, then only updates which one is
// checked, so a keyboard user's focus survives re-renders. The team battle
// lobby has its own copy (a different container and radio group name).
function renderLengthPicker(container = ui.lengths, name = 'length') {
  if (!container.querySelector('input')) {
    container.innerHTML = CONFIG.lengthOptions
      .map((len) => `<label><input type="radio" name="${name}" value="${len}"><span>${len}s</span></label>`)
      .join('');
  }
  for (const input of container.querySelectorAll('input')) input.checked = Number(input.value) === settings.length;
}

function setLength(len) {
  if (!CONFIG.lengthOptions.includes(len)) return;
  settings.length = len;
  store.set(KEYS.length, len);
  renderLengthPicker();
  renderLength();
}

// Everything on the start screen that mentions the round length.
function renderLength() {
  ui.lengthText.textContent = `${settings.length} seconds`;
  renderRules();
  renderBestMenu();
}

function renderRules() {
  const c = CONFIG;
  const steps = c.drainSchedule.map((d) => `−${d.points} / ${d.every.toFixed(1)}s`).join(' → ');
  ui.rules.innerHTML = [
    `<b>+${c.basePoints}</b> per shape you click. Moving shapes pay <b>×${c.movingBonus}</b>.`,
    `Every shape has a <b class="gold">gold crit spot</b> — inside it, on its edge, or hanging off it. Crits pay <b>×${c.critMultiplier}</b>.`,
    `Every shape still on screen drains points on a tick, and the drain gets worse as the game goes on: <b>${steps}</b>.`,
    `Chain hits to grow your <b>combo multiplier</b> (up to ×${c.combo.max}). A miss (−${c.missPenalty}) or ${c.combo.timeout}s without a hit resets it.`,
    `You start with <b>${fmt(c.startingPoints)}</b> and have <b>${settings.length}s</b>. Your score can go negative.`,
  ]
    .map((line) => `<li>${line}</li>`)
    .join('');
}

/* ---------- Render (canvas) ---------- */

function render(time) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(bg, 0, 0, W, H);

  ctx.save();
  if (state.shake > 0 && !settings.calm) {
    ctx.translate(rand(-1, 1) * state.shake, rand(-1, 1) * state.shake);
  }
  // The multiplier is hidden while paused so it doesn't flash behind the menu.
  if (state.phase === 'playing' && !state.paused) drawMultiplier(time);
  const interval = drainInterval();
  for (const s of state.shapes) drawShape(s, time, interval);
  drawEffects();
  drawFloaters();
  ctx.restore();

  if (state.phase === 'countdown' && !state.paused) drawCountdown();
  if (state.banner) drawBanner();
}

// The big, flashing, drifting combo multiplier behind the shapes.
// Flash rate stays at or under 3 per second.
function drawMultiplier(time) {
  const m = multiplier();
  const calm = settings.calm;
  const heat = clamp((m - 1) / (CONFIG.combo.max - 1), 0, 1); // 0 → 1 as the combo grows
  const pop = state.comboPop;
  const c = multiplierCenter();
  const base = Math.min(W, H - hudH) * 0.3;
  const size = base * (0.85 + heat * 0.35) * (1 + (calm ? 0.06 : 0.3) * pop);

  let x = c.x;
  let y = c.y;
  if (!calm) {
    x += Math.sin(time * 0.9) * W * 0.12 * heat + rand(-1, 1) * 5 * heat * heat;
    y += Math.cos(time * 1.3) * (H - hudH) * 0.1 * heat + rand(-1, 1) * 5 * heat * heat;
  }

  const flashHz = 1 + heat * 2;
  const flashOn = Math.sin(time * TAU * flashHz) > 0;
  const hue = calm ? 48 : (time * 90 * (1 + heat * 3)) % 360;
  let alpha = calm ? 0.12 : 0.1 + (flashOn ? 0.08 + heat * 0.14 : 0) + pop * 0.38;
  if (state.combo === 0) alpha *= 0.5;
  const color = `hsl(${hue}, 100%, 62%)`;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = Math.min(alpha, 0.6);
  ctx.fillStyle = color;
  if (!calm) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 20 + 30 * Math.max(pop, heat);
  }
  ctx.font = `900 ${size}px ${FONT}`;
  ctx.fillText(`×${m.toFixed(1)}`, x, y);
  ctx.shadowBlur = 0;

  if (state.combo > 0) {
    ctx.globalAlpha = calm ? 0.35 : 0.3 + pop * 0.4;
    ctx.font = `800 ${Math.max(14, size * 0.14)}px ${FONT}`;
    ctx.fillText(`${state.combo} COMBO`, x, y + size * 0.52);
    // combo timeout bar
    const barW = size * 1.1;
    const frac = clamp(state.comboTimer / CONFIG.combo.timeout, 0, 1);
    const barY = y + size * 0.66;
    ctx.globalAlpha = calm ? 0.3 : 0.35;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillRect(x - barW / 2, barY, barW, 4);
    ctx.fillStyle = color;
    ctx.fillRect(x - barW / 2, barY, barW * frac, 4);
  }
  ctx.restore();
}

function drawShape(s, time, interval) {
  const k = s.crit;
  const appear = easeOutBack(Math.min(1, s.age / 0.18));
  const drainFrac = clamp(s.drainTimer / interval, 0, 1);
  const flashing = s.flash > 0;
  const stroke = flashing ? RED : s.color;

  ctx.save();
  ctx.translate(s.x, s.y);

  // Drain timer: an arc that fills up until the next tick.
  ctx.beginPath();
  ctx.arc(0, 0, (s.outerR + 8) * appear, -Math.PI / 2, -Math.PI / 2 + TAU * drainFrac);
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(255, 77, 94, ${0.15 + 0.7 * drainFrac * drainFrac})`;
  ctx.stroke();

  // Sent over by the other team: a dashed ring in their colour.
  if (s.attack) {
    ctx.save();
    ctx.setLineDash([7, 6]);
    if (!settings.calm) ctx.lineDashOffset = -time * 24;
    ctx.beginPath();
    ctx.arc(0, 0, (s.outerR + 15) * appear, 0, TAU);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = s.attackColor;
    ctx.stroke();
    ctx.restore();
  }

  ctx.scale(appear, appear);
  ctx.rotate(s.rot);

  const ca = Math.cos(k.angle);
  const sa = Math.sin(k.angle);
  if (k.mode === 'outside') {
    ctx.beginPath();
    ctx.moveTo(ca * k.edge * 0.85, sa * k.edge * 0.85);
    ctx.lineTo(ca * k.dist, sa * k.dist);
    ctx.lineWidth = 4;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  // Body
  ctx.shadowColor = stroke;
  ctx.shadowBlur = 16;
  ctx.fillStyle = flashing ? rgba(RED, 0.55) : s.fill;
  ctx.fill(s.path);
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke;
  ctx.stroke(s.path);
  ctx.shadowBlur = 0;

  // Crit spot
  const cx = ca * k.dist;
  const cy = sa * k.dist;
  const pulse = settings.calm ? 0.5 : 0.5 + 0.5 * Math.sin(time * 9 + s.seed);
  ctx.beginPath();
  ctx.arc(cx, cy, k.r + 3 + pulse * 3, 0, TAU);
  ctx.lineWidth = 2;
  ctx.strokeStyle = `rgba(255, 214, 10, ${0.25 + 0.4 * (1 - pulse)})`;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, k.r, 0, TAU);
  ctx.fillStyle = GOLD;
  ctx.shadowColor = GOLD;
  ctx.shadowBlur = 14;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#1b1400';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, k.r * 0.32, 0, TAU);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.restore();
}

function drawEffects() {
  ctx.save();
  for (const e of state.effects) {
    const t = e.life / e.max;
    ctx.globalAlpha = t;
    if (e.kind === 'spark') {
      ctx.fillStyle = e.color;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.size * (0.4 + 0.6 * t), 0, TAU);
      ctx.fill();
    } else {
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 3 * t + 0.5;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r + e.grow * (1 - t), 0, TAU);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawFloaters() {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const f of state.floaters) {
    const t = f.life / f.max;
    const grow = 1 + 0.25 * Math.max(0, t - 0.8) * 5;
    ctx.globalAlpha = Math.min(1, t * 2);
    ctx.font = `900 ${f.size * grow}px ${FONT}`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.restore();
}

function drawCountdown() {
  const n = Math.ceil(state.countdown);
  if (n <= 0) return;
  const t = 1 - (n - state.countdown); // 1 → 0 during each number
  const c = multiplierCenter();
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.7;
  ctx.font = `800 ${Math.max(14, Math.min(W, H) * 0.03)}px ${FONT}`;
  const label = isLance() ? 'GET READY, LANCE' : inParty() ? 'TEAM BATTLE' : 'GET READY';
  ctx.fillText(label, c.x, c.y - Math.min(W, H) * 0.17);
  ctx.globalAlpha = Math.min(1, t * 2.5);
  ctx.font = `900 ${Math.min(W, H) * 0.22 * (1 + 0.4 * t * t)}px ${FONT}`;
  ctx.fillText(String(n), c.x, c.y);
  ctx.restore();
}

function drawBanner() {
  const b = state.banner;
  const age = b.max - b.life;
  const inT = Math.min(1, age / 0.15);
  const alpha = Math.min(inT, b.life / 0.3, 1);
  const scale = 0.8 + 0.2 * easeOutBack(inT);
  const y = hudH + (H - hudH) * 0.26;
  const size = Math.max(28, Math.min(W, H) * 0.085);

  ctx.save();
  ctx.translate(W / 2, y);
  ctx.scale(scale, scale);
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.font = `900 ${size}px ${FONT}`;
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.strokeText(b.text, 0, 0);
  ctx.fillStyle = b.text === 'GO!' ? GREEN : b.text.startsWith('DRAIN') || b.text === 'TIME!' ? RED : GOLD;
  ctx.fillText(b.text, 0, 0);
  if (b.sub) {
    ctx.font = `800 ${size * 0.32}px ${FONT}`;
    ctx.lineWidth = 5;
    ctx.strokeText(b.sub, 0, size * 0.72);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(b.sub, 0, size * 0.72);
  }
  ctx.restore();
}

/* ---------- Boot ---------- */

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const rawDt = Math.max(0, (now - last) / 1000);
  const dt = Math.min(0.05, rawDt); // clamp big gaps (e.g. tab switch)
  last = now;
  if (W !== window.innerWidth || H !== window.innerHeight) resize();
  update(dt, rawDt);
  if (W > 0 && H > 0) render(now / 1000);
}

ui.calm.checked = settings.calm;
document.body.classList.toggle('calm', settings.calm);
renderLengthPicker();
renderLength();
renderMute();
resize();
updateHud(true);
requestAnimationFrame(loop);
