// Players in free roam who are not driving: in a race, a shop, the menus or loading (runtime/roam_core.h RC_ST_*, as
// their own HELLOs and SNAPs say): a port of web/server-rs/crates/lan/src/away.rs.  Their game draws no other car
// then, and no one draws theirs, but the hub keeps their links: what their friends send them waits for the slow clock
// (LanOptions::away_ms), and of the car states sent to them they get one in 16 (SHARE).  The first HELLO or SNAP of
// theirs that says they drive (or are paused there) ends it.

import { SHARE_FULL } from './lag.js';

/** away.rs SHARE: of the car states sent to a player who is not driving, the share it gets (as a path far behind gets, lag.js) */
export const SHARE = SHARE_FULL / 16;

/** away.rs ROAM_PORT: runtime/roam_core.h RC_DEFAULT_PORT */
export const ROAM_PORT = 47210;

/** lib.rs KIND_UDP: a UDP datagram frame */
const KIND_UDP = 1;

/**
 * away.rs status: the free-roam status a frame of a player's own says, when it is a HELLO or a SNAP of free roam (to
 * anyone: its friends, the hub): RC_ST_*, else null.  The CRC is not checked: a player who says the wrong thing gets
 * its own traffic slower or as it is now, no one else's.
 * @param {Uint8Array} frame
 * @returns {number|null}
 */
export function status(frame) {
  if (frame.length < 16 + 20 || frame[0] !== KIND_UDP || frame[16] !== 0x4e || frame[17] !== 0x32 || frame[18] !== 0x46 ||
    frame[19] !== 0x52 || frame[20] !== 1) {
    return null;
  }
  if (((frame[14] << 8) | frame[15]) !== ROAM_PORT) return null;
  // after the datagram's 16-byte header: a HELLO's core version (2) and platform (1), then its status; a SNAP's
  // status first
  switch (frame[21]) {
    case 1: return frame[16 + 19];
    case 3: return frame[16 + 16];
    default: return null;
  }
}

/**
 * away.rs away: a status of a player who is not driving: the menus (0), loading (1), a race (3), a shop (4); not in free
 * roam (2) or paused there (5), and not a number the core does not send
 */
export function away(st) {
  return st === 0 || st === 1 || st === 3 || st === 4;
}
