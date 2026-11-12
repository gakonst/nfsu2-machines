// Midnight Machines in the browser: loads machines.wasm, runs single races at a fixed 60 Hz, multiplayer races in
// lockstep with a room (net.js), draws the frame from the wasm and the HUD over it, and plays the synthesized sound.
import { C, FLAG, H, IN, Machine, carNames, clampOptions, openRoom, results, TICKS_PER_FRAME } from './net.js';
import { Hud, CAR_COLOURS } from './hud.js';
import { Audio } from './audio.js';
import { TempoFuel, tempoBase, tempoWanted } from './fuel.js';

const W = 320, HT = 180, TICK_MS = 1000 / 60;
const MODE_NAMES = ['Circuit', 'Sprint', 'Drag'];
const $ = (id) => document.getElementById(id);

const canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: false });
const image = ctx.createImageData(W, HT);
const hud = new Hud($('hud'));
const audio = new Audio();
const fuel = tempoWanted() ? new TempoFuel($('fuel'), tempoBase()) : null;

let machine = null;
let trackNames = [];
// what runs: 'attract' (bots behind the menu), 'single', 'net' (a room race), 'idle'
let run = 'idle';
let paused = false;
let acc = 0;
let lastT = performance.now();
let single = null; // { opts, names }
let room = null; // { code, conn, names, slot, results }
let finishedShown = false;
const opts = loadOpts();

// ---------- input ----------

const keys = new Set();
const pulse = { [IN.SHIFT_UP]: 0, [IN.SHIFT_DOWN]: 0 }; // shift bits stay on 100 ms so a frame always sees them
const touchBits = new Map(); // pointerId -> bit
let padPrev = 0;
const KEYMAP = {
  ArrowUp: IN.THROTTLE, KeyW: IN.THROTTLE, ArrowDown: IN.BRAKE, KeyS: IN.BRAKE,
  ArrowLeft: IN.LEFT, KeyA: IN.LEFT, ArrowRight: IN.RIGHT, KeyD: IN.RIGHT,
  ShiftLeft: IN.NITRO, ShiftRight: IN.NITRO, KeyN: IN.NITRO, Space: IN.NITRO,
};
const SHIFT_KEYS = { KeyE: IN.SHIFT_UP, KeyQ: IN.SHIFT_DOWN };

function racing() { return run === 'single' || run === 'net'; }

addEventListener('keydown', (e) => {
  audio.unlock();
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Escape' || e.code === 'KeyP') { if (racing()) togglePause(); return; }
  if (e.code === 'KeyM') { audio.setMuted(!audio.muted); toast(audio.muted ? 'Sound off' : 'Sound on'); return; }
  if (!racing()) return;
  if (KEYMAP[e.code] || SHIFT_KEYS[e.code]) e.preventDefault();
  if (SHIFT_KEYS[e.code] && !e.repeat) pulse[SHIFT_KEYS[e.code]] = performance.now() + 100;
  keys.add(e.code);
  sendInputNow();
});
addEventListener('keyup', (e) => { keys.delete(e.code); sendInputNow(); });

/** In a room, an input change goes out at once rather than at the next animation frame. */
function sendInputNow() {
  if (run === 'net' && room?.slot >= 0 && room.conn.client.racing && !paused) room.conn.client.setInput(inputByte());
}
addEventListener('blur', () => keys.clear());

function padBits() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let b = 0;
  for (const p of pads) {
    if (!p) continue;
    const btn = (i) => (p.buttons[i] ? p.buttons[i].value > 0.25 || p.buttons[i].pressed : false);
    const x = p.axes[0] ?? 0;
    if (btn(7) || btn(0)) b |= IN.THROTTLE;
    if (btn(6) || btn(1)) b |= IN.BRAKE;
    if (x < -0.3 || btn(14)) b |= IN.LEFT;
    if (x > 0.3 || btn(15)) b |= IN.RIGHT;
    if (btn(2) || btn(3)) b |= IN.NITRO;
    if (btn(5)) b |= IN.SHIFT_UP;
    if (btn(4)) b |= IN.SHIFT_DOWN;
    if (btn(9)) b |= 128; // start: pause
  }
  const now = performance.now(), rise = b & ~padPrev;
  if (rise & IN.SHIFT_UP) pulse[IN.SHIFT_UP] = now + 100;
  if (rise & IN.SHIFT_DOWN) pulse[IN.SHIFT_DOWN] = now + 100;
  if (rise & 128 && racing()) togglePause();
  padPrev = b;
  return b & (IN.THROTTLE | IN.BRAKE | IN.LEFT | IN.RIGHT | IN.NITRO);
}

function inputByte() {
  let b = padBits();
  for (const k of keys) b |= KEYMAP[k] ?? 0;
  for (const bit of touchBits.values()) b |= bit & ~(IN.SHIFT_UP | IN.SHIFT_DOWN);
  const now = performance.now();
  if (pulse[IN.SHIFT_UP] > now) b |= IN.SHIFT_UP;
  if (pulse[IN.SHIFT_DOWN] > now) b |= IN.SHIFT_DOWN;
  if ((b & IN.LEFT) && (b & IN.RIGHT)) b &= ~(IN.LEFT | IN.RIGHT);
  return b & 127;
}

function setupTouch() {
  const coarse = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const el = $('touch');
  for (const btn of el.querySelectorAll('button[data-bit]')) {
    const bit = Number(btn.dataset.bit);
    const down = (e) => {
      e.preventDefault(); audio.unlock();
      touchBits.set(e.pointerId, bit); btn.classList.add('on');
      if (bit === IN.SHIFT_UP || bit === IN.SHIFT_DOWN) pulse[bit] = performance.now() + 100;
      sendInputNow();
    };
    const up = (e) => { if (touchBits.get(e.pointerId) === bit) touchBits.delete(e.pointerId); btn.classList.remove('on'); sendInputNow(); };
    btn.addEventListener('pointerdown', down);
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  $('touch-pause').addEventListener('click', () => racing() && togglePause());
  return coarse;
}
const touchUi = setupTouch();
hud.touch = touchUi;

// ---------- menu ----------

function loadOpts() {
  try { return { mode: 0, track: 0, laps: 3, bots: 5, ...JSON.parse(localStorage.getItem('mm.opts') ?? '{}') }; } catch { return { mode: 0, track: 0, laps: 3, bots: 5 }; }
}
function saveOpts() { localStorage.setItem('mm.opts', JSON.stringify(opts)); }

function show(screen) {
  $('menu').hidden = !screen;
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== screen;
  const first = screen && $(screen).querySelector('button.hot, button');
  if (first && !touchUi) first.focus({ preventScroll: true });
}

let toastTimer = 0;
function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/** The race options form (mode, track, laps, bots); onChange after every edit. */
function optionsForm(root, humans, onChange) {
  root.replaceChildren();
  const row = (label, el) => { const s = document.createElement('span'); s.textContent = label; root.append(s, el); };
  const seg = document.createElement('div'); seg.className = 'seg';
  MODE_NAMES.forEach((name, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = name;
    b.classList.toggle('on', opts.mode === i);
    b.onclick = () => { opts.mode = i; changed(); };
    seg.append(b);
  });
  const sel = document.createElement('select');
  trackNames.forEach((n, i) => { const o = document.createElement('option'); o.value = i; o.textContent = (i + 1) + '. ' + n; sel.append(o); });
  sel.value = opts.track;
  sel.onchange = () => { opts.track = Number(sel.value); changed(); };
  const stepper = (get, set) => {
    const d = document.createElement('div'); d.className = 'step';
    const minus = document.createElement('button'); minus.type = 'button'; minus.textContent = '\u2212';
    const out = document.createElement('output'); out.textContent = get();
    const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = '+';
    minus.onclick = () => { set(-1); changed(); };
    plus.onclick = () => { set(1); changed(); };
    d.append(minus, out, plus);
    return d;
  };
  row('Mode', seg);
  row('Track', sel);
  if (opts.mode === 0) row('Laps', stepper(() => opts.laps, (d) => { opts.laps = Math.max(1, Math.min(9, opts.laps + d)); }));
  row('Bots', stepper(() => opts.bots, (d) => { opts.bots = Math.max(0, Math.min(opts.mode === 2 ? 3 : 7, opts.bots + d)); }));
  function changed() {
    Object.assign(opts, clampOptions(opts, humans()));
    if (opts.mode !== 0) opts.laps = Math.max(1, opts.laps);
    saveOpts();
    optionsForm(root, humans, onChange);
    onChange?.();
  }
}

function keysHelp() {
  const k = [['\u2191 W', 'gas'], ['\u2193 S', 'brake'], ['\u2190\u2192 A D', 'steer'], ['Shift N', 'nitrous'],
    ['E', 'shift up'], ['Q', 'shift down'], ['Esc', 'pause'], ['M', 'sound']];
  const el = $('keys');
  el.replaceChildren();
  for (const [key, what] of k) {
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = key;
    d.append(b, what);
    el.append(d);
  }
  const pad = document.createElement('div');
  pad.style.gridColumn = '1 / -1';
  pad.textContent = touchUi ? 'Touch: buttons on screen' : 'Gamepad: RT gas \u00b7 LT brake \u00b7 stick steer \u00b7 X nitrous \u00b7 RB/LB shift';
  el.append(pad);
}

$('go-single').onclick = () => { audio.unlock(); optionsForm($('single-opts'), () => 1); show('single'); };
$('go-multi').onclick = () => { audio.unlock(); show('multi'); };
for (const b of document.querySelectorAll('.back')) b.onclick = () => show('home');
$('single-start').onclick = () => startSingle();
$('pause-resume').onclick = () => togglePause();
$('pause-restart').onclick = () => { paused = false; if (run === 'single') startSingle(); };
$('pause-quit').onclick = () => quit();
$('after-again').onclick = () => { if (run === 'single') startSingle(); else if (room) backToLobby(); };
$('after-menu').onclick = () => quit();

function togglePause() {
  if (run === 'single') {
    paused = !paused;
    show(paused ? 'pause' : null);
    $('pause-restart').hidden = false;
    if (paused) audio.silence();
  } else if (run === 'net') {
    // a room race cannot pause: offer to leave
    paused = !paused;
    show(paused ? 'pause' : null);
    $('pause-restart').hidden = true;
  }
}

function quit() {
  paused = false;
  $('after').hidden = true;
  if (room) { room.conn.close(); room = null; }
  fuel?.end();
  fuel?.hide();
  audio.silence();
  hud.reset();
  startAttract();
  show('home');
}

// ---------- single race ----------

function startSingle() {
  Object.assign(opts, clampOptions(opts, 1));
  saveOpts();
  const seed = crypto.getRandomValues(new Uint32Array(2));
  machine.init(seed[0], seed[1], opts.mode, opts.track, opts.laps, 1, opts.bots);
  single = { opts: { ...opts }, names: carNames(['You'], opts.bots), track: machine.trackName() };
  run = 'single';
  paused = false;
  acc = 0;
  finishedShown = false;
  hud.reset();
  $('after').hidden = true;
  $('after-again').textContent = 'Race again';
  show(null);
  fuel?.begin((paid) => machine.fuel(0, true, paid));
}

function stepSingle(dt) {
  if (paused) return;
  acc = Math.min(acc + dt, 200);
  for (let k = 0; k < 12 && acc >= TICK_MS; k++) {
    machine.setInput(0, inputByte());
    machine.tick();
    acc -= TICK_MS;
  }
}

// ---------- attract mode: a bots-only race behind the menu ----------

function startAttract() {
  const seed = crypto.getRandomValues(new Uint32Array(2));
  machine.init(seed[0], seed[1], 0, seed[0] % 8, 1, 0, 6);
  run = 'attract';
  acc = 0;
}

function stepAttract(dt) {
  acc = Math.min(acc + dt, 200);
  for (let k = 0; k < 12 && acc >= TICK_MS; k++) { machine.tick(); acc -= TICK_MS; }
  if (machine.state()[H.phase] === 2) startAttract();
}

// ---------- multiplayer ----------

const NAME_KEY = 'mm.name';
$('mp-name').value = localStorage.getItem(NAME_KEY) ?? '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('mp-code').value = urlRoom.toUpperCase();
$('mp-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('mp-create').onclick = () => {
  const a = crypto.getRandomValues(new Uint8Array(4));
  join(Array.from(a, (x) => String.fromCharCode(65 + (x % 26))).join(''));
};
$('mp-join').onclick = () => join($('mp-code').value);
$('mp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join($('mp-code').value); });
$('lobby-leave').onclick = () => quit();
$('lobby-start').onclick = () => {
  if (!room) return;
  Object.assign(opts, clampOptions(opts, room.conn.client.players.length || 1));
  room.conn.send({ t: 'start', mode: opts.mode, track: opts.track, laps: opts.laps, bots: opts.bots });
};

function join(code) {
  code = String(code).toUpperCase();
  if (!/^[A-Z]{4,6}$/.test(code)) { toast('Room codes are 4 to 6 letters'); return; }
  const name = $('mp-name').value.trim().slice(0, 16) || 'Driver';
  localStorage.setItem(NAME_KEY, name);
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/room/' + code;
  room = { code, names: [], slot: -1, results: null, open: false };
  room.conn = openRoom({ url, machine, name, onEvent: (e, m) => onRoomEvent(e, m) });
  $('lobby-code').textContent = code;
  $('lobby-link').textContent = 'Invite: ' + location.origin + location.pathname + '?room=' + code;
  $('lobby-players').replaceChildren();
  $('lobby-wait').textContent = 'Connecting\u2026';
  $('lobby-start').hidden = true;
  show('lobby');
}

function onRoomEvent(e, m) {
  if (!room) return;
  const client = room.conn.client;
  if (e === 'open') room.open = true;
  else if (e === 'room') renderLobby(client, m);
  else if (e === 'start') {
    room.names = Array.isArray(m.names) ? m.names.map(String) : [];
    room.slot = client.you;
    room.results = null;
    room.track = machine.trackName();
    run = 'net';
    paused = false;
    finishedShown = false;
    hud.reset();
    $('after').hidden = true;
    show(null);
    if (fuel && room.slot >= 0) fuel.begin((paid) => room.conn.send({ t: 'fuel', m: paid }));
  } else if (e === 'end') {
    room.results = client.endResults;
    fuel?.end();
    $('after-again').textContent = 'Back to lobby';
    $('after').hidden = false;
  } else if (e === 'desync') {
    console.warn('desync', m);
  } else if (e === 'error') {
    toast(m?.t === 'full' ? 'That room is full (4 drivers)' : 'Connection problem');
  } else if (e === 'close') {
    toast(room.open ? 'Disconnected from the room' : 'Could not reach the room');
    room = null;
    if (run === 'net' || !$('lobby').hidden) quit();
  }
}

function renderLobby(client, m) {
  const list = $('lobby-players');
  list.replaceChildren();
  for (const p of client.players) {
    const li = document.createElement('li');
    li.textContent = String(p.name ?? '').slice(0, 16) + (p.slot === client.host ? ' \u2605' : '');
    li.style.setProperty('--c', CAR_COLOURS[(p.slot >= 0 ? p.slot : 7) & 7]);
    if (p.slot === client.you) li.classList.add('me');
    list.append(li);
  }
  if (run === 'net') return;
  const isHost = client.you >= 0 && client.you === client.host;
  optionsForm($('lobby-opts'), () => client.players.length || 1);
  $('lobby-opts').classList.toggle('locked', !isHost);
  $('lobby-opts').hidden = !isHost;
  $('lobby-start').hidden = !isHost;
  $('lobby-wait').textContent = m.racing ? 'A race is running: you join the next one.' : isHost ? 'You host: pick the race and start.' : 'Waiting for the host to start\u2026';
}

function backToLobby() {
  $('after').hidden = true;
  room.results = null;
  hud.reset();
  startAttract();
  renderLobby(room.conn.client, { racing: false });
  show('lobby');
}

// ---------- the frame ----------

function frame(t) {
  const dt = Math.min(250, t - lastT);
  lastT = t;
  if (machine) {
    if (run === 'single') stepSingle(dt);
    else if (run === 'attract') stepAttract(dt);
    else if (run === 'net' && room) {
      const c = room.conn.client;
      if (c.racing && room.slot >= 0) c.setInput(paused ? 0 : inputByte());
      c.update();
    }
    draw(t);
  }
  requestAnimationFrame(frame);
}

function draw(now) {
  const s = machine.state();
  const slot = run === 'single' ? 0 : run === 'net' ? Math.max(0, room?.slot ?? 0) : 0;
  image.data.set(machine.render(slot, W, HT));
  ctx.putImageData(image, 0, 0);
  if (!racing()) { hud.clear(); return; }
  const names = run === 'single' ? single.names : room?.names;
  let res = null;
  if (run === 'single' && s[H.phase] === 2) res = single.results ??= results(machine, names); // places settle at the first phase-2 tick
  if (run === 'net' && room?.results) res = room.results;
  const c = run === 'net' ? room?.conn.client : null;
  const events = hud.draw({
    state: s, slot, names, now, results: res,
    trackName: run === 'single' ? single.track : room?.track,
    desync: c?.desync ?? null,
    waiting: c ? c.racing && now - c.lastProgress > 500 : false,
    note: run === 'net' ? 'ROOM ' + room.code + (room.slot < 0 ? ' \u00b7 SPECTATING' : '') : '',
  });
  audio.events(events);
  if (res || paused) audio.silence();
  else audio.engine(machine.car(s, slot, C.rpm), (inputByte() & IN.THROTTLE) !== 0, (machine.car(s, slot, C.flags) & FLAG.NITRO) !== 0);
  if (fuel && !res) fuel.update(machine.car(s, slot, C.distance_m));
  if (run === 'single' && res && !finishedShown) {
    finishedShown = true;
    fuel?.end();
    $('after').hidden = false;
  }
  $('touch').hidden = !touchUi || !!res || paused;
}

// ---------- boot ----------

async function boot() {
  keysHelp();
  show('home');
  try {
    const { instance } = await WebAssembly.instantiateStreaming(fetch('machines.wasm'), {});
    machine = new Machine(instance.exports);
    for (let t = 0; t < 8; t++) { machine.init(1, 0, 0, t, 1, 1, 0); trackNames.push(machine.trackName() || 'Track ' + (t + 1)); }
    startAttract();
    if (urlRoom) show('multi');
  } catch (e) {
    $('load-msg').textContent = 'Could not load the game (machines.wasm): ' + e;
    for (const b of document.querySelectorAll('#home button')) b.disabled = true;
  }
  addEventListener('resize', () => hud.resize());
  requestAnimationFrame((t) => { lastT = t; frame(t); });
}

window.mm = { get machine() { return machine; }, get run() { return run; }, get room() { return room; }, startSingle, opts, TICKS_PER_FRAME };
boot();
