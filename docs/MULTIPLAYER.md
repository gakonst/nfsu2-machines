# Multiplayer and Tempo fuel

One Cloudflare Worker (wrangler.jsonc at the repo root, code in worker/) serves the game's files from web/, a room
per code at /room/<CODE> (a Durable Object, Room) and the Tempo fuel pump at /mpp/* (a Durable Object, Pump).

## Lockstep

The room is authoritative for inputs and runs the same machines.wasm as the page. Every 50 ms it builds frame n from
each human's latest input byte (repeated for the frame's 3 ticks, tick-major), applies it to its own simulation
through mm_net_push / mm_net_pump (the same path the clients use), and sends it. Clients never simulate ahead: they
apply the room's frames in order, so every machine runs the same ticks with the same inputs and reaches the same
mm_hash. Results, the end of the race and the hash are the room's.

    page                                room (Durable Object)
    {t:"hello", name}  ----------->     member; first member hosts
                       <-----------     {t:"room", you, host, players, racing}
    {t:"start", ...}   ----------->     (host only) mm_init with a crypto seed
                       <-----------     {t:"start", seed, mode, track, laps, humans, bots, names}
    {t:"in", b}        ----------->     latest byte per slot (on change and every 250 ms)
                       <-----------     {t:"f", n, i:[3*humans bytes], fu?}   every 50 ms
                       <-----------     {t:"h", n, hash}   after every 20th frame
    {t:"resend", from} ----------->     frames from..newest (at most 256; 600 kept)
                       <-----------     {t:"end", why, results:[{slot, name, place, ticks}]}

- Frames start at n = 0 (mm_net_next() after mm_init). The hash is sent after frame n when (n + 1) % 20 = 0;
  the page records its own mm_hash at exactly that frame boundary and shows a desync banner if they differ.
- The page asks for a resend from mm_net_next() when a push returns 2 (too far ahead) or no tick was applied for
  300 ms. It paces frames at 60 Hz (mm_net_pump takes single ticks) and speeds up when more than 4 frames behind.
- A shift is an edge in the simulation; the page holds a shift bit for 100 ms so at least one frame carries it.
- ticks in results is race time since GO (finished_tick - 180), 0 for a car that did not finish.
- The room ends the race when phase reaches 2, after 6 minutes, or when every racer has left. Someone joining
  mid-race waits (you = -1) and gets a slot at the next race. A fifth human gets {t:"full"} and is closed.
- Everything from clients is validated (size <= 512 bytes, JSON object, integer ranges); bad input is ignored.

### Extensions to SPEC.md

- {t:"fuel", m} (client) and fu:[slot, paid_m, ...] (on a frame): mm_fuel changes hashed state, so in a room it is
  applied by the room and every client just before the frame that carries it, never locally.
- room carries racing; end carries why ("finished", "cap", "empty", "error").

## Code

- web/net.js: Machine (the wasm exports) and NetClient (the client protocol over any transport, no DOM), plus
  openRoom() for a WebSocket. The page, the room and the tests all use it.
- worker/room.js: RoomCore (the whole room as a plain class: send, clock and timers injected) and the Room
  Durable Object around it (WebSocket accept, setInterval while racing, crypto seeds). WebSockets are accepted
  without hibernation: a room's state lives in memory for as long as someone is connected.
- worker/worker.js: routing; room codes are /^[A-Z]{4,6}$/.

## Tempo fuel

Only with ?tempo in the address. web/fuel.js loads mppx@0.16.0 and viem@2.57.12 from esm.sh, keeps a testnet key
in localStorage, funds it from the faucet, and opens one tempo.session.manager (maxDeposit 1) per race against
/mpp/fuel. It pays one $0.001 voucher per 50 m can, keeping 200 m paid ahead of the local car's distance_m, and tells
the game: mm_fuel(slot, 1, paid_m) in a single race, {t:"fuel", m} to the room in multiplayer. At the race's end it
closes the session and links the settle transaction (https://explore.testnet.tempo.xyz/tx/<hash>).

worker/pump.js is the server: an mppx tempo.session on testnet (feePayer, pathUSD
0x20c0000000000000000000006a37da5c996874be, $0.001 per can), with a fresh faucet-funded wallet made lazily inside
the Pump Durable Object. /mpp/health reports it. mppx and viem are the project's only dependencies (worker/package.json).

## Running

    ./zig/zig build wasm                       # web/machines.wasm
    node --test test/*.test.mjs                         # room protocol against the real wasm
    cd worker && npm install                   # wrangler, mppx, viem
    worker/node_modules/.bin/wrangler dev --config wrangler.jsonc --port 8787   # from the repo root
    MM_URL=http://localhost:8787 node --test test/worker.test.mjs
    MM_URL=http://localhost:8787 MM_SHOTS=/tmp/mm-shots PLAYWRIGHT=/path/to/playwright/index.mjs node --test test/screens.test.mjs
    worker/node_modules/.bin/wrangler deploy --config wrangler.jsonc

Controls: arrows or WASD drive, Shift / N / Space nitrous, E shift up, Q shift down, Esc pause, M sound. Gamepad: RT
gas, LT brake, left stick steer, X nitrous, RB / LB shift. Phones get on-screen buttons.
