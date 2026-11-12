//! Deterministic simulation testing. From one seed:
//! 1. replicas: REPLICAS races fed the same random inputs agree on the hash every tick;
//! 2. network: a simulated room streams frames to lockstep clients over a seeded network that delays,
//!    drops, duplicates and reorders; clients ask for resends, apply the same frames in order and match
//!    the room's hash after every frame; buffers stay bounded;
//! 3. invariants every tick, and a bots-only race finishes within a bound.
//! A failing seed prints itself; zig build dst -- --seed N replays it.
const std = @import("std");
const assert = std.debug.assert;
const sim = @import("sim.zig");
const lockstep = @import("lockstep.zig");
const prng = @import("prng.zig");
const Prng = prng.Prng;

const REPLICAS = 3;
const CLIENTS_MAX = sim.MAX_HUMANS;
const ROOM_HISTORY = 600; // frames the room keeps for resends (as the Worker does)
const QUEUE_MAX = 4096;
const RESEND_BATCH = 32;
const RESEND_INTERVAL = 15; // ticks between a client's resend requests
const REPLICA_TICKS_MAX = 12_000;
const DRAIN_TICKS_MAX = 30_000;
const BOT_MIN_AVG_SPEED = 300; // mm/tick (65 km/h): the bound bots-only races must beat

pub const Error = error{ Desync, Invariant, NotFinished, NetStuck };

var fail_buf: [512]u8 = undefined;
var fail_len: usize = 0;

fn fail(err: Error, comptime fmt: []const u8, args: anytype) Error {
    const msg = std.fmt.bufPrint(&fail_buf, fmt, args) catch fail_buf[0..0];
    fail_len = msg.len;
    return err;
}

pub fn failure_message() []const u8 {
    return fail_buf[0..fail_len];
}

const Config = struct { mode: u8, track: u8, laps: u8, humans: u8, bots: u8 };

fn config_for(rng: *Prng, humans_min: u8) Config {
    const humans: u8 = @intCast(rng.range(humans_min, sim.MAX_HUMANS));
    const max_bots: i32 = sim.MAX_CARS - humans;
    return .{
        .mode = @intCast(rng.below(3)),
        .track = @intCast(rng.below(8)),
        .laps = @intCast(rng.range(1, 2)),
        .humans = humans,
        .bots = @intCast(rng.range(if (humans == 0) 1 else 0, max_bots)),
    };
}

fn init_race(race: *sim.Race, seed: u64, c: Config) void {
    sim.init(race, seed, c.mode, c.track, c.laps, c.humans, c.bots);
}

/// Simulated players: mostly the bot driver (so races finish), with bursts of random keys and shifts.
const Players = struct {
    held: [sim.MAX_HUMANS]u8,
    hold_left: [sim.MAX_HUMANS]u8,
    random: [sim.MAX_HUMANS]bool,

    fn init() Players {
        return .{ .held = .{0} ** sim.MAX_HUMANS, .hold_left = .{0} ** sim.MAX_HUMANS, .random = .{false} ** sim.MAX_HUMANS };
    }

    fn input(self: *Players, rng: *Prng, race: *const sim.Race, slot: u8) u8 {
        assert(slot < sim.MAX_HUMANS);
        if (self.hold_left[slot] == 0) {
            self.random[slot] = rng.chance(1, 4);
            self.held[slot] = @intCast(rng.below(128));
            self.hold_left[slot] = @intCast(rng.range(5, 40));
        }
        self.hold_left[slot] -= 1;
        var b: u8 = if (self.random[slot]) self.held[slot] else sim.bot_input(race, slot);
        if (rng.chance(1, 50)) b |= sim.IN_SHIFT_UP;
        if (rng.chance(1, 80)) b |= sim.IN_SHIFT_DOWN;
        return b;
    }
};

/// Invariants checked after every tick, against the previous tick.
pub const Watch = struct {
    tick: u32,
    phase: u8,
    progress: [sim.MAX_CARS]i64,
    finished: [sim.MAX_CARS]u32,
    speed: [sim.MAX_CARS]i32,

    pub fn init(race: *const sim.Race) Watch {
        var w: Watch = .{ .tick = race.tick, .phase = race.phase, .progress = undefined, .finished = undefined, .speed = undefined };
        for (race.cars, 0..) |c, i| {
            w.progress[i] = c.progress_mm;
            w.finished[i] = c.finished_tick;
            w.speed[i] = c.speed;
        }
        return w;
    }

    pub fn check(self: *Watch, race: *const sim.Race) Error!void {
        if (race.tick != self.tick + 1) return fail(error.Invariant, "tick {d} after {d}", .{ race.tick, self.tick });
        if (race.phase < self.phase) return fail(error.Invariant, "phase went back {d} -> {d}", .{ self.phase, race.phase });
        var seen: u32 = 0;
        for (race.cars[0..race.car_count], 0..) |c, i| {
            if (c.place < 1 or c.place > race.car_count) return fail(error.Invariant, "tick {d} car {d} place {d}", .{ race.tick, i, c.place });
            seen |= @as(u32, 1) << @intCast(c.place - 1);
            if (c.progress_mm < self.progress[i]) return fail(error.Invariant, "tick {d} car {d} progress {d} < {d}", .{ race.tick, i, c.progress_mm, self.progress[i] });
            if (c.speed < 0 or c.speed > sim.MAX_SPEED) return fail(error.Invariant, "tick {d} car {d} speed {d}", .{ race.tick, i, c.speed });
            if (self.finished[i] != 0 and c.finished_tick != self.finished[i]) return fail(error.Invariant, "tick {d} car {d} unfinished", .{ race.tick, i });
            if (c.lap < 1 or c.lap > race.laps) return fail(error.Invariant, "tick {d} car {d} lap {d}", .{ race.tick, i, c.lap });
            if (@abs(c.lateral_mm) > sim.BARRIER_MM) return fail(error.Invariant, "tick {d} car {d} lateral {d}", .{ race.tick, i, c.lateral_mm });
            if (c.nitro < 0 or c.nitro > 1000) return fail(error.Invariant, "tick {d} car {d} nitro {d}", .{ race.tick, i, c.nitro });
            if (c.gear < 1 or c.gear > sim.GEARS) return fail(error.Invariant, "tick {d} car {d} gear {d}", .{ race.tick, i, c.gear });
            if (c.rpm < 0 or c.rpm > sim.RPM_LIMIT) return fail(error.Invariant, "tick {d} car {d} rpm {d}", .{ race.tick, i, c.rpm });
            // A car out of paid fuel is at 20 km/h or braking down to it.
            if (c.fuel_limited and c.speed > sim.FUEL_SPEED and c.speed >= self.speed[i]) return fail(error.Invariant, "tick {d} car {d} fuel speed {d}", .{ race.tick, i, c.speed });
            if (c.finished_tick != 0 and c.progress_mm < race.finish_mm) return fail(error.Invariant, "tick {d} car {d} finished early", .{ race.tick, i });
            self.progress[i] = c.progress_mm;
            self.finished[i] = c.finished_tick;
            self.speed[i] = c.speed;
        }
        const all: u32 = (@as(u32, 1) << @intCast(race.car_count)) - 1;
        if (seen != all) return fail(error.Invariant, "tick {d} places not a permutation ({b})", .{ race.tick, seen });
        self.tick = race.tick;
        self.phase = race.phase;
    }
};

// 1. Replicas.

var replicas: [REPLICAS]sim.Race = undefined;

fn run_replicas(seed: u64, rng: *Prng, c: Config) Error!u32 {
    for (&replicas) |*r| init_race(r, seed, c);
    var players = Players.init();
    var watch = Watch.init(&replicas[0]);
    var inputs = [_]u8{0} ** sim.MAX_CARS;
    var t: u32 = 0;
    while (t < REPLICA_TICKS_MAX and replicas[0].phase != sim.PHASE_FINISHED) : (t += 1) {
        var h: u8 = 0;
        while (h < c.humans) : (h += 1) inputs[h] = players.input(rng, &replicas[0], h);
        if (rng.chance(1, 400)) {
            // Tempo fuel changes land on every replica alike.
            const slot = rng.below(sim.MAX_CARS);
            const on = rng.chance(1, 2);
            const paid = rng.below(3000);
            for (&replicas) |*r| sim.set_fuel(r, slot, on, paid);
        }
        for (&replicas) |*r| sim.tick(r, &inputs);
        try watch.check(&replicas[0]);
        const h0 = sim.hash(&replicas[0]);
        for (replicas[1..], 1..) |*r, k| {
            if (sim.hash(r) != h0) return fail(error.Desync, "replica {d} hash differs at tick {d}", .{ k, replicas[0].tick });
        }
    }
    return t;
}

// 3. Bots-only races finish within a bound.

var bots_race: sim.Race = undefined;

pub fn bot_bound(race: *const sim.Race) u32 {
    const distance = race.finish_mm - race.cars[race.car_count - 1].progress_mm;
    return sim.COUNTDOWN_TICKS + @as(u32, @intCast(@divTrunc(distance, BOT_MIN_AVG_SPEED))) + 600;
}

fn run_bots(seed: u64, rng: *Prng) Error!u32 {
    var c = config_for(rng, 0);
    c.humans = 0;
    if (c.bots == 0) c.bots = 1;
    init_race(&bots_race, seed, c);
    const bound = bot_bound(&bots_race);
    var watch = Watch.init(&bots_race);
    const none = [_]u8{0} ** sim.MAX_CARS;
    var t: u32 = 0;
    while (t < bound and bots_race.phase != sim.PHASE_FINISHED) : (t += 1) {
        sim.tick(&bots_race, &none);
        try watch.check(&bots_race);
    }
    for (bots_race.cars[0..bots_race.car_count], 0..) |car, i| {
        if (car.finished_tick == 0) {
            return fail(error.NotFinished, "bots-only race (mode {d} track {d} cars {d}): car {d} unfinished after {d} ticks", .{ c.mode, c.track, bots_race.car_count, i, bound });
        }
    }
    return t;
}

// 2. Network.

const Kind = enum(u8) { frame, resend };

const Msg = struct {
    at: u32, // delivery tick
    kind: Kind,
    client: u8,
    n: u32,
    bytes: [lockstep.FRAME_BYTES]u8,
};

const Net = struct {
    queue: [QUEUE_MAX]Msg,
    len: u32,
    delay_min: u32,
    jitter: u32,
    drop_pm: u32,
    dup_pm: u32,
    dropped: u32,
    sent: u32,

    fn send(self: *Net, rng: *Prng, now: u32, msg: Msg) void {
        self.sent += 1;
        if (rng.chance(self.drop_pm, 1000)) {
            self.dropped += 1;
            return;
        }
        const copies: u32 = if (rng.chance(self.dup_pm, 1000)) 2 else 1;
        var k: u32 = 0;
        while (k < copies) : (k += 1) {
            if (self.len == QUEUE_MAX) {
                self.dropped += 1; // a full link drops; resends recover
                return;
            }
            var m = msg;
            m.at = now + self.delay_min + rng.below(self.jitter + 1);
            self.queue[self.len] = m;
            self.len += 1;
        }
    }
};

const RoomFrame = struct { n: u32, bytes: [lockstep.FRAME_BYTES]u8, hash: u32 };

const Client = struct {
    race: sim.Race,
    ls: lockstep.Lockstep,
    inputs: [sim.MAX_CARS]u8,
    last_progress_tick: u32,
    last_resend_tick: u32,
    highest_seen: u32,
    seen_any: bool,
};

var net: Net = undefined;
var room: sim.Race = undefined;
var room_history: [ROOM_HISTORY]RoomFrame = undefined;
var clients: [CLIENTS_MAX]Client = undefined;

pub const NetStats = struct { frames: u32, sent: u32, dropped: u32, ticks: u32 };

fn run_network(seed: u64, rng: *Prng) Error!NetStats {
    const c = config_for(rng, 1);
    const client_count: u8 = @intCast(rng.range(1, CLIENTS_MAX));
    net.len = 0;
    net.delay_min = rng.below(10);
    net.jitter = rng.below(60);
    net.drop_pm = rng.below(300);
    net.dup_pm = rng.below(200);
    net.dropped = 0;
    net.sent = 0;
    init_race(&room, seed, c);
    const humans = room.humans;
    const frame_len: usize = lockstep.TICKS_PER_FRAME * @as(usize, humans);
    for (clients[0..client_count]) |*cl| {
        init_race(&cl.race, seed, c);
        cl.ls.reset(humans);
        cl.inputs = .{0} ** sim.MAX_CARS;
        cl.last_progress_tick = 0;
        cl.last_resend_tick = 0;
        cl.highest_seen = 0;
        cl.seen_any = false;
    }
    var players = Players.init();
    var room_inputs = [_]u8{0} ** sim.MAX_CARS;
    var watch = Watch.init(&room);
    const frames_total: u32 = 300 + rng.below(900);
    var room_frames: u32 = 0;

    var now: u32 = 0;
    const tick_bound: u32 = frames_total * lockstep.TICKS_PER_FRAME + DRAIN_TICKS_MAX;
    while (now < tick_bound) : (now += 1) {
        // The room steps and broadcasts one frame every TICKS_PER_FRAME ticks.
        if (now % lockstep.TICKS_PER_FRAME == 0 and room_frames < frames_total) {
            var f: RoomFrame = .{ .n = room_frames, .bytes = .{0} ** lockstep.FRAME_BYTES, .hash = 0 };
            var t: usize = 0;
            while (t < lockstep.TICKS_PER_FRAME) : (t += 1) {
                var h: u8 = 0;
                while (h < humans) : (h += 1) {
                    room_inputs[h] = players.input(rng, &room, h);
                    f.bytes[t * humans + h] = room_inputs[h];
                }
                sim.tick(&room, &room_inputs);
                try watch.check(&room);
            }
            f.hash = sim.hash(&room);
            room_history[room_frames % ROOM_HISTORY] = f;
            room_frames += 1;
            var k: u8 = 0;
            while (k < client_count) : (k += 1) {
                net.send(rng, now, .{ .at = 0, .kind = .frame, .client = k, .n = f.n, .bytes = f.bytes });
            }
        }

        // Deliver what is due (swap-remove keeps it deterministic and bounded).
        var q: u32 = 0;
        while (q < net.len) {
            const m = net.queue[q];
            if (m.at > now) {
                q += 1;
                continue;
            }
            net.len -= 1;
            net.queue[q] = net.queue[net.len];
            switch (m.kind) {
                .frame => {
                    const cl = &clients[m.client];
                    const r = cl.ls.push(m.n, m.bytes[0..frame_len]);
                    if (r < 0 or r > 3) return fail(error.Invariant, "push returned {d}", .{r});
                    if (!cl.seen_any or m.n > cl.highest_seen) cl.highest_seen = m.n;
                    cl.seen_any = true;
                },
                .resend => {
                    if (room_frames > ROOM_HISTORY and m.n < room_frames - ROOM_HISTORY) {
                        return fail(error.NetStuck, "client {d} needs frame {d}, room history starts at {d}", .{ m.client, m.n, room_frames - ROOM_HISTORY });
                    }
                    var n = m.n;
                    while (n < room_frames and n < m.n + RESEND_BATCH) : (n += 1) {
                        const f = &room_history[n % ROOM_HISTORY];
                        assert(f.n == n);
                        net.send(rng, now, .{ .at = 0, .kind = .frame, .client = m.client, .n = n, .bytes = f.bytes });
                    }
                },
            }
        }

        // Clients pump a few frames each tick (like an animation frame) and check every frame's hash.
        var all_done = room_frames == frames_total;
        for (clients[0..client_count], 0..) |*cl, k| {
            const frames_now = rng.below(4);
            var p: u32 = 0;
            while (p < frames_now) : (p += 1) {
                assert(cl.ls.sub == 0);
                const done = cl.ls.pump(&cl.race, &cl.inputs, lockstep.TICKS_PER_FRAME);
                if (done == 0) break;
                if (done != lockstep.TICKS_PER_FRAME) return fail(error.Invariant, "partial frame {d}", .{done});
                cl.last_progress_tick = now;
                const applied = cl.ls.next - 1;
                if (applied >= room_frames) return fail(error.Invariant, "client {d} ahead of room", .{k});
                const rf = &room_history[applied % ROOM_HISTORY];
                if (rf.n == applied and rf.hash != sim.hash(&cl.race)) {
                    return fail(error.Desync, "client {d} hash differs from room after frame {d}", .{ k, applied });
                }
            }
            if (cl.ls.stored > lockstep.NET_WINDOW) return fail(error.Invariant, "client {d} buffer {d}", .{ k, cl.ls.stored });
            const need = cl.ls.next_needed();
            const gap = cl.seen_any and need <= cl.highest_seen;
            const stalled = now - cl.last_progress_tick > 30;
            if ((gap or stalled) and now - cl.last_resend_tick >= RESEND_INTERVAL and need < room_frames + 1) {
                cl.last_resend_tick = now;
                net.send(rng, now, .{ .at = 0, .kind = .resend, .client = @intCast(k), .n = need, .bytes = .{0} ** lockstep.FRAME_BYTES });
            }
            if (cl.ls.next != frames_total) all_done = false;
        }
        if (all_done) break;
    }
    const room_hash = sim.hash(&room);
    for (clients[0..client_count], 0..) |*cl, k| {
        if (cl.ls.next != frames_total) {
            return fail(error.NetStuck, "client {d} at frame {d} of {d} after {d} ticks (drop {d}/1000)", .{ k, cl.ls.next, frames_total, now, net.drop_pm });
        }
        if (sim.hash(&cl.race) != room_hash) return fail(error.Desync, "client {d} final hash differs", .{k});
    }
    return .{ .frames = frames_total, .sent = net.sent, .dropped = net.dropped, .ticks = now };
}

pub const SeedStats = struct { replica_ticks: u32, bot_ticks: u32, net: NetStats };

/// Runs every check for one seed.
pub fn run_seed(seed: u64) Error!SeedStats {
    var rng = Prng.init(seed);
    const c = config_for(&rng, 0);
    const replica_ticks = try run_replicas(seed, &rng, c);
    const bot_ticks = try run_bots(seed, &rng);
    const n = try run_network(seed, &rng);
    return .{ .replica_ticks = replica_ticks, .bot_ticks = bot_ticks, .net = n };
}

pub fn main(init: std.process.Init.Minimal) void {
    var first: u64 = 1;
    var count: u64 = 100;
    var single = false;
    var it = init.args.iterate();
    _ = it.next();
    var arg_count: u32 = 0;
    while (it.next()) |arg| : (arg_count += 1) {
        if (arg_count > 16) break;
        const value = it.next() orelse usage();
        const v = std.fmt.parseInt(u64, value, 10) catch usage();
        if (std.mem.eql(u8, arg, "--seed")) {
            first = v;
            single = true;
        } else if (std.mem.eql(u8, arg, "--seeds")) {
            count = v;
            single = false;
        } else usage();
    }
    if (single) count = 1;
    var totals: SeedStats = .{ .replica_ticks = 0, .bot_ticks = 0, .net = .{ .frames = 0, .sent = 0, .dropped = 0, .ticks = 0 } };
    var s: u64 = 0;
    while (s < count) : (s += 1) {
        const seed = first + s;
        const st = run_seed(seed) catch |err| {
            std.debug.print("DST FAIL seed={d} {s}: {s}\nreplay: zig build dst -- --seed {d}\n", .{ seed, @errorName(err), failure_message(), seed });
            std.process.exit(1);
        };
        totals.replica_ticks += st.replica_ticks;
        totals.bot_ticks += st.bot_ticks;
        totals.net.frames += st.net.frames;
        totals.net.sent += st.net.sent;
        totals.net.dropped += st.net.dropped;
        if (single) {
            std.debug.print("seed {d}: replica ticks {d}, bots-only ticks {d}, net frames {d} sent {d} dropped {d} in {d} ticks\n", .{ seed, st.replica_ticks, st.bot_ticks, st.net.frames, st.net.sent, st.net.dropped, st.net.ticks });
        }
    }
    std.debug.print("DST OK: seeds {d}..{d} ({d}): replica ticks {d}, bots-only ticks {d}, net frames {d}, messages {d} ({d} dropped)\n", .{ first, first + count - 1, count, totals.replica_ticks, totals.bot_ticks, totals.net.frames, totals.net.sent, totals.net.dropped });
}

fn usage() noreturn {
    std.debug.print("usage: dst [--seed N] [--seeds K]   (--seed alone replays one seed; both run K seeds from N)\n", .{});
    std.process.exit(2);
}

// Tests, including mutations that show the checks catch real bugs.

const testing = std.testing;

test "dst: a few seeds pass" {
    var seed: u64 = 1;
    while (seed <= 2) : (seed += 1) _ = try run_seed(seed);
}

test "mutation: one corrupted input byte in the frame stream is caught by the hash check" {
    var a: sim.Race = undefined;
    var b: sim.Race = undefined;
    sim.init(&a, 77, 0, 3, 1, 2, 2);
    sim.init(&b, 77, 0, 3, 1, 2, 2);
    var la: lockstep.Lockstep = undefined;
    var lb: lockstep.Lockstep = undefined;
    la.reset(2);
    lb.reset(2);
    var ia = [_]u8{0} ** sim.MAX_CARS;
    var ib = [_]u8{0} ** sim.MAX_CARS;
    var rng = Prng.init(5);
    var n: u32 = 0;
    while (n < 400) : (n += 1) {
        var bytes: [6]u8 = undefined;
        for (&bytes) |*x| x.* = sim.IN_THROTTLE | @as(u8, @intCast(rng.below(16)));
        _ = la.push(n, &bytes);
        if (n == 200) bytes[3] ^= sim.IN_LEFT | sim.IN_RIGHT; // the mutation
        _ = lb.push(n, &bytes);
        _ = la.pump(&a, &ia, 3);
        _ = lb.pump(&b, &ib, 3);
    }
    try testing.expect(sim.hash(&a) != sim.hash(&b));
}

test "mutation: invariant checks catch broken places, backwards progress and unfinishing" {
    var race: sim.Race = undefined;
    sim.init(&race, 3, 0, 0, 1, 0, 4);
    const none = [_]u8{0} ** sim.MAX_CARS;
    var t: u32 = 0;
    while (t < 400) : (t += 1) sim.tick(&race, &none);

    var w = Watch.init(&race);
    sim.tick(&race, &none);
    try w.check(&race); // the real sim passes

    var bad = race;
    w = Watch.init(&race);
    sim.tick(&bad, &none);
    bad.cars[1].place = bad.cars[0].place;
    try testing.expectError(error.Invariant, w.check(&bad));

    bad = race;
    w = Watch.init(&race);
    sim.tick(&bad, &none);
    bad.cars[2].progress_mm = race.cars[2].progress_mm - 1;
    try testing.expectError(error.Invariant, w.check(&bad));

    bad = race;
    w = Watch.init(&race);
    w.finished[0] = 1234;
    sim.tick(&bad, &none);
    try testing.expectError(error.Invariant, w.check(&bad));
}

test "mutation: a client that applies frames in arrival order desyncs" {
    var good: sim.Race = undefined;
    var naive: sim.Race = undefined;
    sim.init(&good, 21, 1, 2, 1, 1, 1);
    sim.init(&naive, 21, 1, 2, 1, 1, 1);
    var ig = [_]u8{0} ** sim.MAX_CARS;
    var in = [_]u8{0} ** sim.MAX_CARS;
    var rng = Prng.init(9);
    var frames: [200][3]u8 = undefined;
    for (&frames) |*f| {
        for (f) |*x| x.* = sim.IN_THROTTLE | @as(u8, @intCast(rng.below(16))) << 2;
    }
    var n: usize = 0;
    while (n < frames.len) : (n += 2) {
        // Frames n and n+1 arrive swapped.
        for ([2]usize{ n, n + 1 }) |k| {
            for (frames[k]) |x| {
                ig[0] = x;
                sim.tick(&good, &ig);
            }
        }
        for ([2]usize{ n + 1, n }) |k| {
            for (frames[k]) |x| {
                in[0] = x;
                sim.tick(&naive, &in);
            }
        }
    }
    try testing.expect(sim.hash(&good) != sim.hash(&naive));
}
