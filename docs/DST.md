# Deterministic simulation testing

The simulation (src/sim.zig) is integer and fixed point only and draws randomness only from the race
seed (src/prng.zig), so a seed and an input stream fully determine every tick. src/dst.zig turns one
seed into a whole scenario and checks it:

    ./zig/zig build dst                         # seeds 1..100
    ./zig/zig build dst -- --seeds 200          # seeds 1..200
    ./zig/zig build dst -- --seed 1000 --seeds 3000
    ./zig/zig build dst -- --seed 42            # replay one seed, with its stats

A failure prints the seed, the check and a replay line, and exits 1:

    DST FAIL seed=2 Invariant: tick 1415 car 0 fuel speed 917
    replay: zig build dst -- --seed 2

## What one seed runs

1. **Replicas.** A random race (mode, track, laps, 0..4 humans, bots) is started three times. Simulated
   players drive the human slots: mostly the bot driver, with bursts of random keys, random shifts and
   random Tempo fuel changes applied to all replicas. All replicas must give the same mm_hash after
   every tick (up to 12,000 ticks or the end of the race).
2. **Network.** A simulated room steps its own race and broadcasts one frame (TICKS_PER_FRAME ticks of
   every human's byte) every 3 ticks to 1..4 lockstep clients (src/lockstep.zig, the code the wasm
   uses). The link has a seeded base delay (0..9 ticks), jitter (0..60), drop rate (0..30 %) and
   duplicate rate (0..20 %); jitter reorders. A full link drops. Clients pump 0..3 frames per tick,
   ask the room to resend from mm_net_next() when they see a gap or stall (at most every 15 ticks),
   and the room answers with up to 32 frames from a 600-frame history, as the Worker does. After every
   frame a client applies, its hash must equal the room's hash after that frame; at the end every
   client must reach the room's last frame and hash. The lockstep buffer must stay within NET_WINDOW
   and every push must return 0..3.
3. **Invariants**, after every tick of every race above: tick advances by one, phase never goes back,
   places are a permutation of 1..cars, progress never decreases, 0 <= speed <= MAX_SPEED, a finished
   car stays finished (and is past the finish line), lap, lateral position, nitro, gear and rpm stay in
   range, and a car out of paid fuel is at 20 km/h or braking down to it.
4. **Bots-only race** with a random mode, track and car count must have every car finish within
   countdown + distance / (65 km/h) + 10 s.

## Mutation tests (zig build test)

Checks are only worth something if they fail on a bug. src/dst.zig includes:

- one flipped input byte in one frame of a lockstep stream gives a different hash;
- a corrupted state (two cars sharing a place, progress going backwards, a finished car unfinishing)
  makes the invariant check fail, while the real sim passes;
- a client that applies two swapped frames in arrival order instead of frame order desyncs.

The hash is FNV-1a over every field of the race and every car slot, walked by type at compile time,
so a new field is hashed automatically. The track is derived from (id, seed, mode) and only its header
is hashed. Native and wasm builds give the same hash: seed 1, circuit, Harbor Loop, 2 laps, 6 bots
ends at tick 4286 with hash 0x98e04997 in both.
