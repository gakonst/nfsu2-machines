//! Lockstep frame buffer: frames from the room arrive in any order, duplicated or late, and are
//! applied strictly in order. A frame holds TICKS_PER_FRAME ticks of every human's input byte.
const std = @import("std");
const assert = std.debug.assert;
const sim = @import("sim.zig");

pub const TICKS_PER_FRAME = 3;
pub const NET_WINDOW: u32 = 256;
pub const FRAME_BYTES = TICKS_PER_FRAME * sim.MAX_HUMANS;

pub const PUSH_STORED: i32 = 0;
pub const PUSH_DUPLICATE: i32 = 1;
pub const PUSH_AHEAD: i32 = 2; // beyond the window, dropped: ask again later
pub const PUSH_OLD: i32 = 3; // already applied

pub const Lockstep = struct {
    frames: [NET_WINDOW][FRAME_BYTES]u8,
    frame_no: [NET_WINDOW]u32,
    present: [NET_WINDOW]bool,
    next: u32, // the frame applied next
    sub: u8, // ticks of frame next already applied
    humans: u8,
    stored: u32,

    pub fn reset(self: *Lockstep, humans: u8) void {
        assert(humans <= sim.MAX_HUMANS);
        @memset(&self.present, false);
        @memset(&self.frame_no, 0);
        for (&self.frames) |*f| @memset(f, 0);
        self.next = 0;
        self.sub = 0;
        self.humans = humans;
        self.stored = 0;
    }

    pub fn frame_len(self: *const Lockstep) usize {
        return @as(usize, TICKS_PER_FRAME) * self.humans;
    }

    /// Stores frame n (bytes: TICKS_PER_FRAME * humans, tick-major).
    pub fn push(self: *Lockstep, n: u32, bytes: []const u8) i32 {
        assert(bytes.len == self.frame_len());
        if (n < self.next) return PUSH_OLD;
        if (n - self.next >= NET_WINDOW) return PUSH_AHEAD;
        const idx = n % NET_WINDOW;
        if (self.present[idx]) {
            assert(self.frame_no[idx] == n);
            return PUSH_DUPLICATE;
        }
        @memcpy(self.frames[idx][0..bytes.len], bytes);
        self.frame_no[idx] = n;
        self.present[idx] = true;
        self.stored += 1;
        assert(self.stored <= NET_WINDOW);
        return PUSH_STORED;
    }

    /// Applies buffered ticks in order, at most max_ticks, stopping at the first missing frame.
    /// Writes each tick's human bytes into inputs[0..humans] and steps the race.
    pub fn pump(self: *Lockstep, race: *sim.Race, inputs: *[sim.MAX_CARS]u8, max_ticks: u32) u32 {
        const limit: u32 = @min(max_ticks, NET_WINDOW * TICKS_PER_FRAME);
        var done: u32 = 0;
        while (done < limit) : (done += 1) {
            const idx = self.next % NET_WINDOW;
            if (!self.present[idx]) break;
            assert(self.frame_no[idx] == self.next);
            const f = &self.frames[idx];
            var h: u8 = 0;
            while (h < self.humans) : (h += 1) inputs[h] = f[@as(usize, self.sub) * self.humans + h];
            sim.tick(race, inputs);
            self.sub += 1;
            if (self.sub == TICKS_PER_FRAME) {
                self.sub = 0;
                self.present[idx] = false;
                self.stored -= 1;
                self.next += 1;
            }
        }
        return done;
    }

    /// The first frame not yet received (what to ask the room to resend from).
    pub fn next_needed(self: *const Lockstep) u32 {
        var k: u32 = 0;
        while (k < NET_WINDOW) : (k += 1) {
            if (!self.present[(self.next + k) % NET_WINDOW]) return self.next + k;
        }
        return self.next + NET_WINDOW;
    }
};

const testing = std.testing;

fn frame_bytes(n: u32, humans: u8, out: []u8) void {
    for (out[0 .. TICKS_PER_FRAME * @as(usize, humans)], 0..) |*b, i| {
        b.* = @truncate((n * 7 + @as(u32, @intCast(i)) * 3) % 26 | sim.IN_THROTTLE);
    }
}

test "push results and in-order pumping" {
    var race: sim.Race = undefined;
    sim.init(&race, 5, 0, 1, 1, 2, 2);
    var l: Lockstep = undefined;
    l.reset(2);
    var inputs = [_]u8{0} ** sim.MAX_CARS;
    var buf: [FRAME_BYTES]u8 = undefined;
    frame_bytes(1, 2, &buf);
    try testing.expectEqual(PUSH_STORED, l.push(1, buf[0..6]));
    try testing.expectEqual(PUSH_DUPLICATE, l.push(1, buf[0..6]));
    try testing.expectEqual(PUSH_AHEAD, l.push(NET_WINDOW, buf[0..6]));
    try testing.expectEqual(@as(u32, 0), l.next_needed());
    try testing.expectEqual(@as(u32, 0), l.pump(&race, &inputs, 30)); // frame 0 missing
    frame_bytes(0, 2, &buf);
    try testing.expectEqual(PUSH_STORED, l.push(0, buf[0..6]));
    try testing.expectEqual(@as(u32, 2), l.next_needed());
    try testing.expectEqual(@as(u32, 4), l.pump(&race, &inputs, 4)); // a partial frame
    try testing.expectEqual(@as(u32, 2), l.pump(&race, &inputs, 30));
    try testing.expectEqual(PUSH_OLD, l.push(0, buf[0..6]));
    try testing.expectEqual(@as(u32, 2), l.next);
    try testing.expectEqual(@as(u32, 6), race.tick);
}

test "arrival order and pump sizes do not change the result" {
    var a: sim.Race = undefined;
    var b: sim.Race = undefined;
    sim.init(&a, 11, 1, 4, 1, 3, 3);
    sim.init(&b, 11, 1, 4, 1, 3, 3);
    var la: Lockstep = undefined;
    var lb: Lockstep = undefined;
    la.reset(3);
    lb.reset(3);
    var ia = [_]u8{0} ** sim.MAX_CARS;
    var ib = [_]u8{0} ** sim.MAX_CARS;
    var buf: [FRAME_BYTES]u8 = undefined;
    const frames: u32 = 200;
    var n: u32 = 0;
    while (n < frames) : (n += 1) {
        frame_bytes(n, 3, &buf);
        _ = la.push(n, buf[0..9]);
        _ = la.pump(&a, &ia, 3);
    }
    // b gets them in blocks of 50, each block reversed, and pumps 1 tick at a time.
    var block: u32 = 0;
    while (block < frames) : (block += 50) {
        var k: u32 = 50;
        while (k > 0) {
            k -= 1;
            frame_bytes(block + k, 3, &buf);
            _ = lb.push(block + k, buf[0..9]);
        }
        var t: u32 = 0;
        while (t < 200) : (t += 1) _ = lb.pump(&b, &ib, 1);
    }
    try testing.expectEqual(a.tick, b.tick);
    try testing.expectEqual(sim.hash(&a), sim.hash(&b));
}
