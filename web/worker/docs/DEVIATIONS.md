# Deviations of the Workers port from the Rust server

Each area lists what it leaves out (what cannot exist on Workers, or is ops tooling) and every deviation it keeps.

## Online host (web/worker/src/online/, port of web/server-rs/crates/online)

The host is a line-for-line port. The differential tests compare it with the Rust crate itself, frame for frame, log line for log line, and stored file for stored file. Over 1000+ traces nothing differs (web/worker/test/online/diff.test.mjs). What follows is everything that is not the same, and why.

Left out (cannot exist on Workers, or ops tooling):
- **Its own thread.** Rust runs the host on a thread of its own and takes events through a channel. It has a backlog with high and low water marks, catch_unwind, and oneshot replies for info(), vips() and friends(). Here the host runs inside the switch's turn as a sans-IO object (OnlineHost in online.js). The order is kept: timers due before a frame run before it, as the Rust loop does, and a handler that throws is caught the way catch_unwind caught a panic. That means an error line, the frame's stream closed ("service error"), and the host goes on. info(), vips() and friends() answer at once.
- **The dev trace.** trace.rs, --online-trace and LobbyTrace decode frames to a file on a thread. Not ported. options.tap(frame) still sees every frame the host sends.
- **Files on disk.** stats.json, races.json, buddies.json and the friends shelf friends/<2hex>/<32hex>.json live in the injected storage under the keys 'online/<file>'. Atomic writes (temp file, sync, rename, 0600/0700 modes) and libuv-worded fs errors become one storage put. A failed write's console line carries the storage's error message.
  - The storage must be **synchronous**: get(key) returns string|undefined, plus put(key, string), delete(key) and list(prefix). The core reads a friends list in the middle of a handler. web/worker/src/online/storage.js syncStorage(state.storage) is a write-through cache over Durable Object storage: everything under 'online/' is read at start, and each write is applied in memory and then put to the DO, not awaited (the output gate keeps it durable). A SQLite-backed DO's ctx.storage.kv also works.
  - Console lines name the key ('online/stats.json') where Rust printed a path.
  - A stats.json that does not parse is copied to 'stats.json.bad-<host clock>' and deleted. Rust renamed it, with the real wall clock in the name.
- **The tests' load measure** (tests/load.rs, ignored by default in Rust): not ported.

Deviations kept:
- **Clocks.** Rust has two clocks: now_ms() (wall) for the rules and mono_ms() for the timers. The host takes the switch's nowMs for both. Its clock never moves back (the latest nowMs is kept). The core keeps both clocks ({now(), timer()}) so the tests can move each one alone, as the Rust tests do.
- **Randomness.** The OS RNG is replaced by the injected Prng (util/prng.js). It is drawn exactly as nfsu2_util::rand draws: randomInt reads a u64 from 8 bytes little-endian with the same rejection, hex(n) reads n bytes, and a room password's key is 32 bytes. A Rust build whose OS bytes come from the same Prng therefore gives the same SESS, MASK, SKEY, LKEY, AUTH, SEED and name digits. The differential tests build it that way.
- **Logging.** Rust's OnlineOptions.log is the server's rate-limited console (log::limited). Here it is options.log(line, key|null): the opaque client group as the key, console.log by default, and no rate limit inside the host. Error lines go to console.error.
- **Friends shelf sweep.** The hourly sweep of lists whose claim ended runs synchronously inside the lobby tick. Rust ran it on a thread. Its line goes through options.log.
- **JSON reading.** stats.json and the friends lists are read with V8's own JSON.parse. Rust's jsonparse.rs copies V8 with two exceptions: it reads 1e400 as `true`, which the JS reads as Infinity (every loader rule treats the two alike), and it turns an escaped lone surrogate into U+FFFD, which the JS keeps. Only a hand-edited file can tell the difference.
- **races.json.** It is written as serde_json writes it: struct field order, and f64 as ryu writes it ("4.0", "1e16"). When the file does not parse, the console line's reason is a short text of its own. Rust gives serde's message with line and column.
- **Iteration order.** Rust iterates a HashMap or HashSet in a few places: the order the dirty friends lists are written, fans in move_list, made.retain, and USCH's walk over by_persona (sorted afterwards). The JS uses insertion order. No frame or stored text shows the difference. The only visible effect would be which write error is reported first when several writes fail.
- **Unicode tables.** cleanText (NFC, Cc/Cf to spaces) uses the engine's ICU tables. Rust uses the unicode-normalization and unicode-general-category crates. The game's text is latin1, where they agree; only text from a stored file outside latin1 could meet a Unicode-version difference.
- **API shape.** new OnlineHost({sw, prng, storage, nowMs, options}). It provides vip (0x0a4d0001), name ('NFSU2 Online'), listed(), frame(frame, ctx, nowMs), peerGone(vip, nowMs), tick(nowMs), nextTickMs(), info(), vips(), stop(nowMs), plus friends(owner, group, ask, nowMs) and setPageMail(fn) (or sw.pageMail) for free roam's pages. ctx is {group, site, owner, noRaces, cause} with cause = {spend, overspent}.

Differential-test aids added under web/server-rs (test-only, behaviour unchanged): crates/online/src/tests/difftrace.rs, and one line `mod difftrace;` in crates/online/src/tests/mod.rs. The tests are built with RUSTFLAGS='--cfg getrandom_backend="custom"' in their own target folder (~/.cache/nfsu2-rs/online-diff).


## Free-roam hub (web/worker/src/roam/, port of web/server-rs/crates/roam; and web/worker/src/claims/, nfsu2-claims)

What the hub sends (PEERS lists with crew marks and hints, MAPD, NEARD, LOBBIES), which players it links and in which
order (every pair of a small room, the grid and heap of a large one, one-way links, crews, friends, lobbies, outruns,
blocks, the busy cap), its console lines and its counts are the Rust hub's, byte for byte: test/roam/difftrace.test.mjs
replays seeded traces (small rooms to 3000 players in one room) into both and compares every datagram, line and answer.
To get there the port carries, beside the hub itself:

- f64::hypot as glibc 2.39 computes it on x86-64 without FMA (Borges' correction: util/crmath.js hypot), not V8's
  Math.hypot, which differs in the last bit for about a third of inputs; links.rs hypot3 is V8's Math.hypot written out
  (as the Rust has it).
- f64::cos and f64::sin of a heading byte (h * PI / 128) from a table made by the Rust build (glibc's values; V8 differs
  in the last bit for 14 of the 512).
- f64::atan2 (a SNAP's heading byte) correctly rounded: V8's Math.atan2 refined in double-double.  glibc's atan2 is
  "max 0.524 ulp", so it may differ from the correctly rounded value by an ulp; the heading byte (floor(atan2 * 128 / PI
  + 0.5)) can change only when that lands within an ulp of a half step, which no input of the 300,000 tried came near.
  Exact emulation would need glibc's own e_atan2.c with its FMA ifunc variant, which itself differs between machines.
- Rust's slice::sort_unstable_by_key (ipnsort, Rust 1.99) step for step (roam/rsort.js) for the two sorts whose ties
  show: a one-way list's links by slot (a pair's two links may carry different ages after a restart) and the minimap
  grid's players by cell.  Checked against the Rust on 8000 arrays.
- Rust's float formatting ({:.N}: exact value, ties to even) for the console lines (util/rustfmt.js).

Left out or changed, and why:

- No threads.  The Rust hub runs on a thread of its own and reads a large room's walks on up to 4 (link_threads); the
  links are the same on one (the Rust's own claim, and the difftraces run the Rust with link_threads 1 and the JS on its
  one thread).  There is no frame queue (MAX_PENDING: frames beyond 8192 waiting were dropped): the switch calls the hub
  synchronously, as Node's hub was.
- No clock and no CPU measure.  The Rust "busy" (the share of the runtime's workers' time, or of a CPU quota, over 10 s)
  cannot be read in a Worker: RoamHub takes options.busy (a function, 0 to 1) or setBusy(fraction), 0 by default, so the
  busy cap (links cut by a quarter past busy_high) only acts when the Durable Object feeds it a measure.  Likewise the
  hub's own thread busy (the minimap's 500/1000 ms gaps past 60/75 %) is setThreadBusy(), 0 by default.  info().tickMsMax
  stays 0.
- The hub's sender id is drawn from the injected prng (1 + prng.below(0xffffffff)), or options.id.
- The order of console lines that come from Rust HashMap iterations is insertion order here: the cheat watches of
  players gone a minute summed up in one tick, and races judged in one tick (results.rs; two races of one track due in
  the same tick may also be judged in the other order, so the second is measured against the first's clean win).
- Console lines go to options.log (console.log by default).
- storage is not used: the hub keeps memory only, as the Rust hub.  Claims (nfsu2-claims) are an object the Durable
  Object owns: Claims.open(storage, now) / save(storage, now) over its storage ({get, put}) under 'names.json', in place
  of <state>/names.json; RoamHub takes it as options.claims.  Claims.read of a file edited by hand with two current names
  of one owner made in the same millisecond keeps the file's last (the Rust: whichever its HashMap gives).
- RoamHub's extra calls (blocks, pageName, friends, roomName, flew, linkedWith, whereabouts, hosted, info, vips,
  otherNames, linkPairs) are synchronous and take the time where the Rust read its clock; /players' snapshots
  (crowded, inRoam, inRoom, inWorld, inCrews, coopSeats) are as of the last tick, as the Rust's atomics.

- Speed: the same algorithm on one JS thread.  A tick of 2000 players in one room took about 60 ms (cores before 15:
  link_many) and 210 ms (one-way cores) on the build Hand, several times the Rust's; a Durable Object holding thousands
  of free-roam players spends that much CPU every tickMs (500 ms).  The busy cap (setBusy) is the lever to give them
  fewer links when it must.

## Switch (web/worker/src/switch/, web/worker/src/names/, port of web/server-rs/crates/lan, crates/names, the parts of crates/util and crates/ws it uses; the Worker's /lan in src/switch/do.js)

How it runs. The Rust switch was tasks and threads (a reader and a writer per connection, the bundle clocks' 16 shard tasks,
the hosts' actor threads, locks and atomics). The JS switch (lib.js) is one sans-IO object in the Switch Durable Object:
every call takes nowMs, randomness comes from the injected Prng, and each input (a message, a timer) runs to completion,
then the hosts' mailboxes are drained, then the connections that ended run their close logic, then the woken writers
write (LanSwitch._settle). The rules, limits, counts, messages and frames are the Rust ones; the differential tests say
how closely (byte for byte on 160 seeded traces through the Rust LanSwitch, and end to end against nfsu2-server).

Workers cannot do it (Durable Object adapter, do.js):
- A server cannot send WebSocket pings, and clients' pings are answered by Workers and never reach the switch. The
  switch's keepalive and probe pings are answered in the adapter at once with the pong a browser would send. So a
  connection counts as alive while Workers holds it open (a dead one ends with its 'close' event), and round trips timed
  by ping read 0 ms: lag.rs thins nobody's snapshots on ping round trips. Pages that echo compact bundles' stamps
  ("echo":1) are still timed by their echoes. Breakdown.behind/thinning follow from that.
- ws terminate() (end a connection without a close frame) does not exist: the adapter closes with 1011. A browser saw
  1006; the page reconnects on either.
- The kernel's send buffer: Workers takes every message at once and exposes no bufferedAmount, so 'buffered' only counts
  what waits in the switch's own queue (the bundle clocks, the stream pump). send_buffer cuts ("slow", "queue") and
  stream stalls can only come from the switch's own queues there; a page that stops reading is found by Workers, not by
  the switch. The core still implements the Rust rules against a transport that reports partial takes (the simulator
  and the ported tests use one), so they are tested.
- WebSocket framing is Workers': the ws crate's frame-level protocol errors (1002) and invalid UTF-8 (1007) are the
  platform's; a message over max_payload is still closed with 1009 by the switch. Workers' own message limit is 1 MiB.
- Binary messages are taken as ArrayBuffer (ws.binaryType = 'arraybuffer'; the standard default Blob would make them
  asynchronous and could reorder them).
- No hibernation: the switch's state lives in memory while any connection is open, as the Rust process's did. A Durable
  Object that is evicted loses the connections (they reconnect with ?resume: lan-addresses.json in DO storage gives them
  their addresses back, as the store did over a restart).
- Timers: one setTimeout for the switch's next due time (nextWakeMs). Workers' clock advances only between I/O, so
  ticks come at or after their time, never early.
- SO_SNDBUF (send_buffer_os, NFSU2_LAN_SNDBUF) has no meaning; the option is accepted and ignored.
- The Online host's backlog (nfsu2_util::host::Backlog 4096/1024, the reader waiting for the host): the hosts run inside
  the switch's step (their mailbox is drained before the step ends), so a host is never behind and no reader waits.
  FrameCtx.slot is left out.
- The hosts' info()/vips()/other_names()/link_pairs() are synchronous; who(), breakdown(), paths(), messages_by_kind()
  and info() are synchronous methods (Rust awaited the host threads).
- Logs: on_join/on_leave lines go to console.log without nfsu2_util::log::limited's rate limit; the [plate] lines go to
  console.log through onLine.

Clocks and randomness (all injected):
- mono_ms is sw.mono() = nowMs - the switch's start (the Rust process's first call, at the server's start); now_ms is
  nowMs. Both come from the DO's Date.now().
- now_us (a free-roam ping's or pong's wait for the bundle clock, compact.rs waited) is derived from nowMs, so it moves
  in whole milliseconds (Rust: microseconds).
- The bundle clocks' jitter, the welcome tokens, queue tickets and probe ping payloads come from the Prng (Rust: a
  time-seeded xorshift per shard, OsRng). lag.rs pick uses lag.js PickRng (Rust's thread-local xorshift64, bit for bit),
  seeded once from the Prng. Timer granularity: tokio rounds timers up to whole milliseconds; the JS timers fire at their
  exact (fractional) time when the caller's clock has passed it.

API shape (for the integrator):
- LanSwitch({options (LanOptions in camelCase, options.js; LanOptions::sane applied, unknown keys throw), prng, nowMs,
  transport, impair, hosts: {online, roam} (factories called with {sw, prng, storage, nowMs, options}), hostOptions,
  storage (the switch's own store, async get/put), hostStorage (the hosts', synchronous get/put/delete/list), stored
  (store.load's entries), tap, onText, onLine}); attach(opts, nowMs, bind) / message / socketGone / drained / tick /
  nextWakeMs. AttachOpts' callbacks are plain functions (onJoin, onLeave, onHello -> {refuse: [msg, code], noRaces: msg},
  onClaim -> owner|null).
- The Rust table of 24000 ArcSwap slots is a Map by address; vips_of_owner walks it in slot order, as Rust did.
- Members.lan is an IndexMap with swap_remove (timers.js SwapMap), so LAN play's broadcast order is Rust's.
- route::Streams' VecDeque is an array with a head index.

Not wired here (other areas own them; the hooks exist):
- nfsu2-bans at /lan (AttachOpts ident, refuse, on_hello): the Worker passes ident/refuse null and the DO no onHello, so
  no bans, renames or race bans apply until a bans port lands. on_claim is wired (claims/claims.js ownerOfToken) when
  NAMES=on, as lan.rs does it only with the names service.
- The server's friends.rs (pages' {"t":"friend"|"room"|"flying"} through LanSwitch.on_text, answered with send_text and
  vips_of_owner, the Online host's page mail): the switch hands those messages to onText, which the DO does not set yet.
- The operator's control socket (kick, ban, who, the [players]/paths console lines): LanSwitch.expel, setRaces, who,
  whoAt, breakdown, paths, messagesByKind and mix.js's lines exist; nothing calls them on Workers.
- --lan-impair is LAN_IMPAIR in the environment (a test aid, as with --dev).

Names (crates/names): the categories are generated tables of Rust's unicode-general-category 1.1.0 (Unicode 16) and
normalization is the runtime's String#normalize: exact on a runtime with Unicode 16 or newer ICU tables, except for code
points assigned after Unicode 16 (Node 24.22 has Unicode 17: 57 names of the cross-check corpus differ from names.mjs
there, as the Rust crate's own cross_check test does on that Node). A JS lone surrogate reads as U+FFFD.

Text and JSON (text.rs, util json.rs, serde_json): parseJson is an exact port of serde_json's Value parser (depth 128,
duplicate keys keep the first position with the last value, no BOM, lone-surrogate escapes refused); numbers become JS
doubles (an integer above 2^53 becomes as_f64's double); objects are null-prototype objects, whose integer-like keys JS
orders first (serde's preserve_order kept the text's order: the switch never shows that order).

Leaf modules (each with its differential test against the Rust module): compact/fpred/mix (Fpred works on Numbers within
2^52 and throws past that, where Rust wraps i64: the switch's fields are within 2^32; decode wraps like Rust's release
build), bucket/lag/away/paths/impair/store (impair delivers from due(nowMs) on the switch's timer instead of tokio tasks;
store is a DO storage value under "lan-addresses.json", no temporary file or mode 0600), plates/text/names. Where Rust
panics (unreachable for the switch's own inputs), JS throws.

Tests that do not apply: crates/lan/tests/page.rs (the page's own network code against a socket listener; the end-to-end
test test/e2e/switch.diff.mjs drives the Worker with WebSocket clients instead); load.rs and memory.rs measure CPU,
threads and the allocator (ported as small-scale rule checks); backlog.rs's "the reader waits for a stuck host" (no
backlog: see above). Real-time measurements run on the virtual clock with the Rust thresholds.

