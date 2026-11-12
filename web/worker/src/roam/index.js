// The free-roam hub at 10.77.0.253 (web/server-rs/crates/roam): the host the switch runs in its Durable Object.
//   hosts: { roam: (a) => new RoamHub(a) }  with a = {sw, prng, storage, nowMs, options}

export {
  RoamHub, Hub, ROAM_HUB_VIP, TRACK_KEYS, CREWS, defaultOptions, trackRoom, mainWorld, worldCount, crewCount, hubInvariants, hypot,
  decodeRoam, encodePeers, encodePeersCrews,
} from './hub.js';
