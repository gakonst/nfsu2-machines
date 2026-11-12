# Midnight Machines: spec

An original night street racer (circuit, sprint and drag) in the spirit of mid-2000s street racing games, built from
scratch: no code, data, names, logos, cars, tracks or music from any other game. Everything is drawn and simulated in
code. Style follows tempoxyz/zempo: Zig, TigerStyle, deterministic simulation testing (DST), zero dependencies.

## Rules

- **Zig 0.16.0**, fetched by zig/download.sh into ./zig/ (run ./zig/zig). No other toolchain to build or test the game.
- **Zero dependencies.** Zig std only. The web client is plain ES modules, no npm, no bundler. The Worker's room code
  is plain JS. The single exception: Tempo fuel's payment code uses mppx + viem (worker/package.json; the browser loads
  them from esm.sh only when ?tempo is set). Record it in docs/DEVIATIONS.md.
- **TigerStyle:** no allocation after init (fixed arrays, static buffers), every loop bounded, assert invariants,
  explicit integer widths, no recursion.
- **Determinism:** the simulation is integer and fixed point only (no floats, no clock, no randomness except the
  seeded PRNG in src/prng.zig). The renderer may use floats; it only reads state. The same seed and inputs give
  the same mm_hash() on every machine and in the Worker.
- Fixed tick: 60 Hz. Units: mm, mm per tick, ticks.

## Layout

- build.zig: zig build wasm -> zig-out/bin/machines.wasm and a copy at web/machines.wasm (wasm32-freestanding,
  ReleaseSmall, rdynamic exports, entry disabled); zig build test (unit tests, native); zig build dst
  [-- --seed N --seeds K] (the simulator, native).
- src/prng.zig, src/track.zig, src/sim.zig, src/lockstep.zig, src/dst.zig, src/wasm.zig: owner A.
- src/render.zig (+ src/sprites.zig, src/font.zig if wanted): owner C.
- web/ (index.html, main.js, net.js, audio.js, fuel.js, style.css), worker/ (worker.js, room.js, pump.js,
  package.json), wrangler.jsonc, test/ (node tests of the worker protocol against the real wasm): owner B.
- README.md, docs/: everyone adds their part; the integrator merges.

## Game

- Up to 8 cars: slots 0..humans-1 are humans, then bots. A race: countdown (3 s), racing, finished (all humans
  finished or 5 min after the first finisher... bots always finish within a bound).
- Modes: 0 circuit (closed loop, laps), 1 sprint (point to point), 2 drag (straight 402 m strip, two to four lanes,
  manual shifting decides it: a shift light and perfect / good / early / late shifts, nitrous).
- Tracks: procedural from (track id, seed): a list of segments, each 5000 mm long, with curve (signed, per-mille of
  lateral shift per segment), hill (mm of rise), and a scenery kind (downtown towers, harbour cranes, neon strip,
  tunnel, bridge, industrial). Track ids 0..7 give eight named original tracks (names in track.zig, e.g. "Harbor
  Loop", "Neon Mile", "Tunnel Run"...).
- Car: speed, rpm, gear 1..6 (automatic for circuit/sprint unless the player shifts; manual in drag), nitrous tank
  (refills slowly in circuit, one bottle in drag), lateral position on a road 4 lanes wide, off-road slowdown,
  bumps between cars (lateral push, small speed loss), a crash (big hit at speed) costs 1.5 s.
- Bots: deterministic AI with per-bot skill from the seed; they follow the racing line, use nitrous on straights.
- Tempo fuel (optional, per slot): when on, a car whose distance driven reaches the metres paid is limited to 20 km/h
  until more is paid.

## WASM interface (src/wasm.zig exports; memory exported as "memory")

    mm_init(seed_lo: u32, seed_hi: u32, mode: u32, track: u32, laps: u32, humans: u32, bots: u32) void
    mm_input_ptr() u32         8 bytes, one per slot: THROTTLE 1, BRAKE 2, LEFT 4, RIGHT 8, NITRO 16,
                               SHIFT_UP 32, SHIFT_DOWN 64 (shifts act on the edge, the sim keeps last tick's byte)
    mm_tick() void             one 1/60 s tick with the bytes in the input buffer
    mm_hash() u32              FNV-1a of the whole simulation state
    mm_state_ptr() u32         i32 words, HUD and results (layout below)
    mm_fuel(slot: u32, on: u32, paid_m: u32) void
    mm_render(slot: u32, w: u32, h: u32) void     draws slot's chase view into the frame buffer (w <= 640, h <= 360)
    mm_fb_ptr() u32            RGBA bytes, w * h * 4, row-major
    mm_track_name_ptr() u32    NUL-terminated ASCII name of the current track
    -- lockstep (src/lockstep.zig): frames from the room, ordered and applied inside the wasm
    mm_net_reset() void
    mm_net_buf_ptr() u32       scratch: a frame's input bytes, TICKS_PER_FRAME * humans bytes, tick-major
    mm_net_push(n: u32) i32    frame n from the scratch; 0 stored, 1 duplicate, 2 too far ahead (dropped), 3 old
    mm_net_pump(max_ticks: u32) u32   applies buffered frames in order (sets inputs, mm_tick per tick), returns ticks
    mm_net_next() u32          the next frame number it needs (to ask the room for a resend)

State words (mm_state_ptr): header 8 words then 8 cars x 16 words.

    header: phase (0 countdown, 1 racing, 2 finished), tick, cars, laps, countdown_ticks_left, track_length_m,
            mode, finish_tick_of_leader
    car:    progress_mm (along the track, all laps), lap (1-based), place (1-based, a permutation), speed_kmh_x10,
            rpm, gear, nitro_permille, finished_tick (0 = not), lateral_mm (0 = centre), flags (1 human,
            2 fuel-limited, 4 perfect shift just now, 8 nitro on, 16 crashed), distance_m, last_shift
            (0 none, 1 perfect, 2 good, 3 early, 4 late), best_lap_ticks, colour (0..7), reserved, reserved

Constants: TICKS_PER_FRAME = 3 (a frame every 50 ms), MAX_CARS = 8, MAX_HUMANS = 4, NET_WINDOW = 256 frames.

## Multiplayer (Cloudflare Worker + one Durable Object per room)

JSON over a WebSocket at /room/<id>:

    client -> room: {t:"hello", name}  {t:"start", mode, track, laps, bots} (host only)  {t:"in", b}  (input byte,
                    on change and every 250 ms)  {t:"resend", from}
    room -> client: {t:"room", you, host, players:[{slot, name}]}
                    {t:"start", seed:[lo,hi], mode, track, laps, humans, bots, names}
                    {t:"f", n, i:[...TICKS_PER_FRAME*humans bytes]}   every 50 ms, each human's latest byte
                    {t:"h", n, hash}   the room's own hash after frame n, every 20 frames (desync check)
                    {t:"end", results:[{slot, name, place, ticks}]}

The room runs the same machines.wasm: it steps every frame it sends, so the results and the hash are the room's,
not the clients'. It keeps the last 600 frames for resends. A room is at most 4 humans; bots fill to 'bots'.
Single player runs the same wasm locally with no room.

## DST (src/dst.zig, zig build dst)

From one seed: (1) replicas: N simulations fed the same random inputs agree on mm_hash every tick; (2) the network: a
simulated room sends frames to N lockstep clients over a seeded network that delays, drops, duplicates and reorders,
clients ask for resends; every client applies the same frames in order and ends with the room's hash; buffers stay
bounded; (3) invariants every tick: places a permutation, progress never decreases, speed within bounds, a finished
car stays finished, a race with only bots finishes within a bound. A failing seed prints itself; zig build dst --
--seed N replays it.

## Tempo fuel (MPP sessions)

?tempo in the page: one MPP session per race against the Worker's /mpp/fuel ($0.001 per 50 m can, 200 m kept paid
ahead, closed and settled at the race's end). The page calls mm_fuel(slot, 1, paid_m) as vouchers land.
