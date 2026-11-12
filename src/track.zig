//! Procedural tracks: a list of 5 m segments built from (track id, seed, mode).
//! Conventions shared with the renderer:
//! - curve > 0 bends right; at speed cars drift outward, to negative lateral (left).
//! - lateral_mm > 0 is right of the centre line; the road spans +-ROAD_HALF_WIDTH_MM.
//! - hill is the rise in mm over the segment; a closed track's hills sum to zero.
//! - Every track starts with START_SEGMENTS of flat straight (the grid); the start line is at
//!   START_SEGMENTS * SEGMENT_MM. Open tracks end with RUNOFF_SEGMENTS past the finish line.
const std = @import("std");
const assert = std.debug.assert;
const Prng = @import("prng.zig").Prng;

pub const SEGMENT_MM: i32 = 5000;
pub const MAX_SEGMENTS: u32 = 1024;
pub const ROAD_HALF_WIDTH_MM: i32 = 8000;

pub const TRACK_COUNT: u8 = 8;
pub const START_SEGMENTS: u32 = 8;
pub const RUNOFF_SEGMENTS: u32 = 40;
pub const DRAG_MM: i32 = 402_000;
pub const DRAG_SEGMENTS: u32 = 81; // ceil(402 m / 5 m)
pub const CURVE_LIMIT: i32 = 90;
pub const HILL_LIMIT: i32 = 600;

pub const MODE_CIRCUIT: u8 = 0;
pub const MODE_SPRINT: u8 = 1;
pub const MODE_DRAG: u8 = 2;

pub const Scenery = enum(u8) { downtown, harbor, neon, tunnel, bridge, industrial };

pub const Segment = struct { curve: i32, hill: i32, scenery: Scenery };

pub const Track = struct {
    segments: [MAX_SEGMENTS]Segment,
    count: u32,
    closed: bool,
    lanes: u8,
    id: u8,
    name: [:0]const u8,
};

pub const names = [TRACK_COUNT][:0]const u8{
    "Harbor Loop",
    "Neon Mile",
    "Tunnel Run",
    "Foundry Row",
    "Skyline Bridge",
    "Old Town Spiral",
    "Canal Street",
    "Midnight Causeway",
};

const Style = struct {
    base: Scenery,
    alt: Scenery,
    curve_max: i32, // strongest curve the generator picks
    hill_max: i32,
    tunnels: u8, // tunnel runs per track
    bridges: u8,
    straightness: u32, // percent of sections that are straights
};

const styles = [TRACK_COUNT]Style{
    .{ .base = .harbor, .alt = .industrial, .curve_max = 60, .hill_max = 150, .tunnels = 0, .bridges = 1, .straightness = 40 },
    .{ .base = .neon, .alt = .downtown, .curve_max = 45, .hill_max = 80, .tunnels = 0, .bridges = 0, .straightness = 55 },
    .{ .base = .downtown, .alt = .neon, .curve_max = 55, .hill_max = 200, .tunnels = 3, .bridges = 0, .straightness = 40 },
    .{ .base = .industrial, .alt = .harbor, .curve_max = 70, .hill_max = 120, .tunnels = 1, .bridges = 0, .straightness = 35 },
    .{ .base = .downtown, .alt = .harbor, .curve_max = 50, .hill_max = 350, .tunnels = 0, .bridges = 3, .straightness = 45 },
    .{ .base = .downtown, .alt = .neon, .curve_max = 85, .hill_max = 300, .tunnels = 1, .bridges = 0, .straightness = 25 },
    .{ .base = .harbor, .alt = .neon, .curve_max = 65, .hill_max = 100, .tunnels = 1, .bridges = 2, .straightness = 35 },
    .{ .base = .industrial, .alt = .downtown, .curve_max = 75, .hill_max = 250, .tunnels = 2, .bridges = 2, .straightness = 30 },
};

/// Builds track id (0..7) for mode (0 circuit, 1 sprint, 2 drag) into out. Deterministic in (id, seed, mode).
pub fn build(out: *Track, id: u8, seed: u64, mode: u8) void {
    assert(id < TRACK_COUNT);
    assert(mode <= MODE_DRAG);
    const style = styles[id];
    var rng = Prng.init(seed ^ (@as(u64, id) << 56) ^ (@as(u64, mode) << 48) ^ 0x7472_6163_6B00);

    out.id = id;
    out.name = names[id];
    out.closed = mode == MODE_CIRCUIT;
    out.lanes = if (mode == MODE_DRAG) @intCast(2 + rng.below(3)) else 4;
    out.count = switch (mode) {
        MODE_CIRCUIT => 280 + rng.below(140) + @as(u32, id) * 8,
        MODE_SPRINT => START_SEGMENTS + 560 + rng.below(200) + RUNOFF_SEGMENTS,
        else => START_SEGMENTS + DRAG_SEGMENTS + RUNOFF_SEGMENTS,
    };
    assert(out.count <= MAX_SEGMENTS);

    for (&out.segments) |*s| s.* = .{ .curve = 0, .hill = 0, .scenery = style.base };
    if (mode == MODE_DRAG) {
        // A flat straight strip; scenery alternates in long blocks.
        var i: u32 = 0;
        while (i < out.count) : (i += 1) {
            out.segments[i].scenery = if ((i / 24) % 2 == 0) style.base else style.alt;
        }
        return;
    }

    // Layout region: everything except the flat grid (and the run-off on open tracks, kept gentle).
    const first: u32 = START_SEGMENTS + 4;
    const last: u32 = if (out.closed) out.count - 6 else out.count - RUNOFF_SEGMENTS + 10;
    build_curves(out, &rng, style, first, last);
    build_hills(out, &rng, style, first, last);
    build_scenery(out, &rng, style, first, last);
}

fn build_curves(out: *Track, rng: *Prng, style: Style, first: u32, last: u32) void {
    var i: u32 = first;
    var sections: u32 = 0;
    while (i < last) : (sections += 1) {
        assert(sections < MAX_SEGMENTS); // every section advances i by at least 4
        const remaining = last - i;
        if (rng.below(100) < style.straightness) {
            i += @min(remaining, 6 + rng.below(18));
            continue;
        }
        const len: u32 = @min(remaining, 10 + rng.below(28));
        const peak = rng.range(@divTrunc(style.curve_max, 3), style.curve_max);
        const sign: i32 = if (rng.below(2) == 0) -1 else 1;
        const ease: u32 = @max(1, len / 4);
        var k: u32 = 0;
        while (k < len) : (k += 1) {
            // Ease in, hold, ease out.
            const ramp: u32 = @min(@min(k + 1, len - k), ease);
            const c = @divTrunc(peak * @as(i32, @intCast(ramp)), @as(i32, @intCast(ease)));
            out.segments[i + k].curve = std.math.clamp(sign * c, -CURVE_LIMIT, CURVE_LIMIT);
        }
        i += len;
    }
}

fn build_hills(out: *Track, rng: *Prng, style: Style, first: u32, last: u32) void {
    if (style.hill_max == 0) return;
    var i: u32 = first;
    var sections: u32 = 0;
    while (i + 8 < last) : (sections += 1) {
        assert(sections < MAX_SEGMENTS);
        const half: u32 = @min((last - i) / 2, 6 + rng.below(20));
        if (rng.below(3) == 0 or half < 2) {
            i += 4 + rng.below(12);
            continue;
        }
        // Rise then an equal fall, so every hill nets to zero height.
        const amp = rng.range(@divTrunc(style.hill_max, 4), style.hill_max);
        const sign: i32 = if (rng.below(2) == 0) -1 else 1;
        var k: u32 = 0;
        while (k < half) : (k += 1) {
            const ramp: i32 = @intCast(@min(k + 1, half - k));
            const h = std.math.clamp(@divTrunc(sign * amp * ramp, @as(i32, @intCast(half))), -HILL_LIMIT, HILL_LIMIT);
            out.segments[i + k].hill = h;
            out.segments[i + half + k].hill = -h;
        }
        i += 2 * half;
    }
}

fn build_scenery(out: *Track, rng: *Prng, style: Style, first: u32, last: u32) void {
    // Alternate base and alt in blocks, then drop tunnels and bridges on top.
    var i: u32 = 0;
    var blocks: u32 = 0;
    var use_alt = false;
    while (i < out.count) : (blocks += 1) {
        assert(blocks < MAX_SEGMENTS);
        const len: u32 = @min(out.count - i, 20 + rng.below(40));
        var k: u32 = 0;
        while (k < len) : (k += 1) out.segments[i + k].scenery = if (use_alt) style.alt else style.base;
        use_alt = !use_alt;
        i += len;
    }
    place_runs(out, rng, .tunnel, style.tunnels, first, last);
    place_runs(out, rng, .bridge, style.bridges, first, last);
}

fn place_runs(out: *Track, rng: *Prng, kind: Scenery, runs: u8, first: u32, last: u32) void {
    if (last <= first + 40) return;
    var r: u8 = 0;
    while (r < runs) : (r += 1) {
        const len: u32 = 10 + rng.below(16);
        const at: u32 = first + rng.below(last - first - len);
        var k: u32 = 0;
        while (k < len) : (k += 1) {
            const s = &out.segments[at + k];
            s.scenery = kind;
            if (kind == .bridge) s.hill = 0; // bridges are flat decks
        }
    }
    // A flattened bridge can break a closed track's zero hill sum; rebalance on the last flat segment.
    rebalance_hills(out);
}

fn rebalance_hills(out: *Track) void {
    if (!out.closed) return;
    var sum: i64 = 0;
    for (out.segments[0..out.count]) |s| sum += s.hill;
    // Spread the residue over the closing segments (before the grid), at most HILL_LIMIT each.
    var i: u32 = out.count;
    var left: i64 = -sum;
    while (left != 0 and i > START_SEGMENTS) {
        i -= 1;
        const s = &out.segments[i];
        if (s.scenery == .bridge) continue;
        const room_up: i64 = HILL_LIMIT - s.hill;
        const room_down: i64 = -HILL_LIMIT - s.hill;
        const step = std.math.clamp(left, room_down, room_up);
        s.hill += @intCast(step);
        left -= step;
    }
}

/// Length in mm of the whole segment list.
pub fn length_mm(t: *const Track) i64 {
    return @as(i64, t.count) * SEGMENT_MM;
}

/// Segment index under a track position (wraps on closed tracks, clamps on open ones).
pub fn segment_index(t: *const Track, pos_mm: i64) u32 {
    assert(t.count > 0);
    const len = length_mm(t);
    const p = if (t.closed) @mod(pos_mm, len) else std.math.clamp(pos_mm, 0, len - 1);
    return @intCast(@divTrunc(p, SEGMENT_MM));
}

test "tracks build within limits for every id and mode" {
    var t: Track = undefined;
    var id: u8 = 0;
    while (id < TRACK_COUNT) : (id += 1) {
        var mode: u8 = 0;
        while (mode <= MODE_DRAG) : (mode += 1) {
            build(&t, id, 1234 + @as(u64, id), mode);
            try std.testing.expect(t.count > START_SEGMENTS and t.count <= MAX_SEGMENTS);
            var sum: i64 = 0;
            for (t.segments[0..t.count], 0..) |s, i| {
                try std.testing.expect(s.curve >= -CURVE_LIMIT and s.curve <= CURVE_LIMIT);
                try std.testing.expect(s.hill >= -HILL_LIMIT and s.hill <= HILL_LIMIT);
                if (i < START_SEGMENTS) try std.testing.expectEqual(@as(i32, 0), s.curve);
                sum += s.hill;
            }
            if (t.closed) try std.testing.expectEqual(@as(i64, 0), sum);
            if (mode == MODE_DRAG) try std.testing.expect(t.lanes >= 2 and t.lanes <= 4);
        }
    }
}

test "same inputs build the same track" {
    var a: Track = undefined;
    var b: Track = undefined;
    build(&a, 3, 99, 0);
    build(&b, 3, 99, 0);
    try std.testing.expectEqual(a.count, b.count);
    for (a.segments[0..a.count], b.segments[0..b.count]) |x, y| {
        try std.testing.expectEqual(x.curve, y.curve);
        try std.testing.expectEqual(x.hill, y.hill);
        try std.testing.expectEqual(x.scenery, y.scenery);
    }
}
