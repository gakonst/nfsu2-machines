// What the lobby (lobby.rs) and EA Messenger (buddy.rs) share: the lobby's limits, the slur rule, a message kind's
// shape.

/** the lobby's limits (lobby.rs Limits::default), camelCase */
export const LIMITS = Object.freeze({
  sessions: 12000, perVip: 3, perGroup: 8, perSite: 32, freeShare: 0.25, msgRate: 20, chatRate: 1, chatLen: 255,
  muteMs: 10000, slurLines: 3, slurWindowMs: 600000, slurMuteMs: 600000, saidLines: 5, saidMs: 600000,
  createRate: 0.5, actRate: 1, announceMs: 1000, personas: 4, games: 3600, openPerVip: 2, openPerGroup: 4,
  startedPerVip: 2, startedPerGroup: 8, gameSize: 6, gameNameLen: 32, auxiLen: 2048, pingMs: 20000,
  idleMs: 120000, preLoginMs: 120000, raceMs: 30 * 60000, orphanMs: 120000,
});

/** One more line that reads as a slur at now, rec = {times: [...], until} its sender's: slurLines of them in
 *  slurWindowMs mute the sender (rec.until = now + slurMuteMs) and the count starts again.  True: muted now. */
export function slurSaid(l, rec, now) {
  rec.times = rec.times.filter((t) => now - t < l.slurWindowMs);
  rec.times.push(now);
  const muted = rec.times.length >= l.slurLines;
  if (muted) {
    rec.until = now + l.slurMuteMs;
    rec.times = [];
  }
  return muted;
}

/** a message kind: four printable ASCII characters, no space (as aries tagText writes them) */
export function fourPrintable(k) {
  if (k.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const c = k.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

