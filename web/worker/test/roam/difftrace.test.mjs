// The Worker's free-roam hub against the Rust hub: seeded traces of virtual players (test/roam/difftrace.mjs) replayed
// into both, every datagram the hubs send, every console line and every query's answer compared, line by line.
// Skipped without the Rust tool: (cd web/server-rs && cargo build --release -p nfsu2-roam --example difftrace).
//   ROAM_DIFF_SEEDS=500 node --test test/roam/difftrace.test.mjs     more seeds
//   ROAM_DIFF_BIG=1                                                  the thousands-of-players rooms too (minutes)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSeed, haveRust, RUST_BIN } from './difftrace.mjs';

const SEEDS = Number(process.env.ROAM_DIFF_SEEDS || 40);
const BIG = process.env.ROAM_DIFF_BIG === '1';
const skip = haveRust() ? false : 'no Rust difftrace tool at ' + RUST_BIN + ' (cargo build --release -p nfsu2-roam --example difftrace)';

function campaign(name, cfg, seeds, from = 1) {
  test(name + ' (' + seeds + ' seeds)', { skip }, () => {
    let lines = 0;
    for (let s = from; s < from + seeds; s++) {
      const { diff, lines: n } = compareSeed(s, cfg);
      lines += n;
      assert.equal(diff, null, 'seed ' + s + ' ' + JSON.stringify(cfg) + ': the first difference: ' + JSON.stringify(diff, null, 1));
    }
    assert.ok(lines > 0);
  });
}

// small rooms (every pair weighed), several rooms, every message kind, churn, blocks, claims, friends, the busy cap
campaign('small rooms, every kind of message', { players: 30, seconds: 12 }, SEEDS, 1);
campaign('rooms of the oldest cores (both-way links only)', { players: 40, seconds: 10, cores: 'old' }, Math.ceil(SEEDS / 4), 1000);
campaign('rooms of one-way cores (link_first and one_way)', { players: 40, seconds: 10, cores: 'new' }, Math.ceil(SEEDS / 4), 2000);
campaign('heavy churn of one-way cores (restarts, BYEs: links one end forgot)', { players: 60, seconds: 10, cores: 'new', churn: 0.2 }, Math.ceil(SEEDS / 4), 2500);
campaign('the grid even for small rooms (exactRoom 1)', { players: 40, seconds: 10, exactRoom: 1 }, Math.ceil(SEEDS / 4), 3000);
campaign('a lattice of parked players (ties at one distance)', { players: 120, seconds: 6, rooms: 1, lattice: true, churn: 0 }, 4, 4000);
// past exactRoom (256): the grid and the heap of a large room, both-way and one-way
campaign('a large room of old cores (link_many)', { players: 400, seconds: 5, rooms: 1, area: 900, cores: 'old', busy: false }, 2, 5000);
campaign('a large room of mixed cores (link_many and one_way)', { players: 400, seconds: 5, rooms: 1, area: 900, busy: false }, 2, 6000);
campaign('a large room of one-way cores', { players: 400, seconds: 5, rooms: 1, area: 900, cores: 'new', busy: false }, 2, 7000);
if (BIG) {
  campaign('thousands of players in one room, old cores', { players: 3000, seconds: 4, rooms: 1, area: 2500, cores: 'old', busy: false, maps: false }, 2, 8000);
  campaign('thousands of players in one room, mixed cores', { players: 3000, seconds: 4, rooms: 1, area: 2500, busy: false }, 2, 9000);
  campaign('thousands of players in one room, one-way cores', { players: 3000, seconds: 4, rooms: 1, area: 2500, cores: 'new', busy: false }, 2, 10000);
  campaign('thousands of players crowded on one spot', { players: 2000, seconds: 3, rooms: 1, area: 200, hotspots: 1, busy: false }, 1, 11000);
}
