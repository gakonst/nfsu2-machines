# Deviations

Places where the build departs from SPEC.md's rules or fills a gap in it.

## Dependencies

- **Tempo fuel payments use mppx + viem** (worker/package.json; the browser loads them from esm.sh
  only when ?tempo is set). This is the one exception to zero dependencies, allowed by SPEC.md. The
  game itself (Zig, web client, room code) has none.

## Simulation (src/sim.zig, owner A)

- **humans = 0 is allowed** (bots-only races, used by DST and attract screens). Such a race ends when
  every car has finished, or 5 minutes after the first finisher.
- **Drag races have at most 4 cars**: lanes = car count (2..4); extra bots are dropped. Drag cars are
  fixed to their lane (no steering) and never collide.
- **Nitrous refills slowly in sprint as well as circuit** (1 per 3 ticks); drag has one bottle.
- **After the race ends (phase 2) the cars keep moving**: finished cars and bots cruise on the bot
  driver and humans keep their controls, but no finish or lap is recorded any more. Places of cars that
  never finished keep following progress, so read results on the first tick of phase 2.
- **finished_tick is absolute** (the same base as the header tick, countdown included); race time is
  finished_tick - 180. best_lap_ticks is a duration.
- **track_length_m** (state word 5) is the lap length for circuits and the race distance for sprint and
  drag.
- **The fuel limit brakes the car down to 20 km/h** (about 3 s from top speed) instead of cutting
  speed in one tick.
- **mm_fuel changes hashed state.** In multiplayer it must be applied at the same tick on the room and
  every client (or kept to single player), or the room's hash check reports a desync.
- **Tracks come from (track id, race seed)** as the spec says, so a named track's layout changes with
  the seed while keeping its character (scenery, curviness, hills, tunnels, bridges).

## DST (src/dst.zig)

- Clients compare their hash with the room's after every frame (from the simulated room's history)
  rather than only on the room's "h" message every 20 frames: a stronger version of the same check.
