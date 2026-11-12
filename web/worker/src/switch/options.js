// The switch's limits: crates/lan/src/lib.rs LanOptions (each field's doc there says what it bounds and why), camelCase.

/** @typedef {ReturnType<typeof defaultOptions>} LanOptions */

/** LanOptions::default() */
export function defaultOptions() {
  return {
    maxPeers: 128,
    maxWaiting: 5000,
    lineTellMs: 5000,
    maxFrame: 8192,
    maxBundle: 64 << 10,
    frameRate: 2500.0,
    byteRate: 256 << 10,
    groupFrameRate: 10000.0,
    groupByteRate: 1 << 20,
    siteFrameRate: 20000.0,
    siteByteRate: 2 << 20,
    textRate: 20.0,
    maxText: 1024,
    ctlRate: 10.0,
    shedQueue: 256 << 10,
    roamQueue: 128 << 10,
    streamQueue: 2 << 20,
    streamShare: 1 << 20,
    stallMs: 1000.0,
    sendBuffer: 8 << 20,
    keepaliveMs: 25_000,
    probeMs: 1000,
    idleMs: 10 * 60_000,
    reserveMs: 60_000,
    groupReserve: 8,
    siteReserve: 16,
    resumeWaitMs: 5_000,
    onlineQueue: 1 << 20,
    peersMs: 250,
    bundleMs: 50,
    bundleMaxMs: 50,
    bundleBudget: 125_000,
    bundleJitter: 0.4,
    awayMs: 500,
    lanMs: 4,
    fpred: true,
    probeEcho: true,
    sendBufferOs: 0,
    maxPayload: 64 << 10,
  };
}

const WHOLE = ['maxPeers', 'maxWaiting', 'lineTellMs', 'maxFrame', 'maxBundle', 'maxText', 'shedQueue', 'roamQueue',
  'streamQueue', 'streamShare', 'sendBuffer', 'keepaliveMs', 'groupReserve', 'siteReserve', 'resumeWaitMs', 'onlineQueue',
  'peersMs', 'maxPayload', 'bundleBudget'];
const SIGNED = ['idleMs', 'reserveMs'];
const REAL = ['frameRate', 'byteRate', 'groupFrameRate', 'groupByteRate', 'siteFrameRate', 'siteByteRate', 'textRate',
  'ctlRate', 'stallMs'];
/** whole-number options that keep their 0 (LanOptions::sane leaves them as they are) */
const ZERO_OK = ['bundleMs', 'bundleMaxMs', 'sendBufferOs', 'probeMs', 'awayMs', 'lanMs'];

/**
 * LanOptions::sane over the defaults: only finite numbers above 0 are taken; a 0 (or a negative or non-finite rate)
 * keeps the default.  Unknown keys throw (a typo must not pass silently).
 * @param {Partial<LanOptions>} [o]
 * @returns {LanOptions}
 */
export function saneOptions(o = {}) {
  const d = defaultOptions();
  for (const k of Object.keys(o)) {
    if (!(k in d)) throw new Error('unknown LAN option ' + k);
  }
  const r = { ...d, ...o };
  // usize fields in Rust: whole, non-negative
  for (const k of [...WHOLE, ...ZERO_OK]) {
    if (!Number.isFinite(r[k]) || r[k] < 0) r[k] = d[k];
    r[k] = Math.floor(r[k]);
  }
  for (const k of WHOLE) if (r[k] === 0) r[k] = d[k];
  for (const k of SIGNED) if (!(r[k] > 0)) r[k] = d[k];
  for (const k of REAL) if (!(Number.isFinite(r[k]) && r[k] > 0)) r[k] = d[k];
  r.fpred = !!r.fpred;
  r.probeEcho = !!r.probeEcho;
  if (!Number.isFinite(r.bundleJitter)) r.bundleJitter = d.bundleJitter;
  return r;
}

/** lib.rs bundle_tick: the bundle clock's tick (µs) for n players who take bundles */
export function bundleTickUs(o, n) {
  const lo = o.bundleMs * 1000;
  const hi = Math.max(o.bundleMaxMs, o.bundleMs) * 1000;
  const v = Math.floor((n * 1_000_000) / Math.max(o.bundleBudget, 1));
  return Math.min(Math.max(v, lo), hi);
}

