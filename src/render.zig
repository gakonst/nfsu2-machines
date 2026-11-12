//! Midnight Machines renderer: a pseudo-3D chase view (segment projection) drawn in software into
//! an RGBA frame. Reads the race state only; floats are fine here since nothing feeds back into
//! the simulation. All buffers are static; every loop is bounded by the frame size or a constant.
const std = @import("std");
const assert = std.debug.assert;
const sim = @import("sim.zig");
const track = @import("track.zig");
const font = @import("font.zig");
const palette = @import("palette.zig");

pub const MAX_W: u32 = 640;
pub const MAX_H: u32 = 360;

/// Bitmap text for the HUD: text(fb, w, h, x, y, str, 0xRRGGBBAA).
pub const text = font.text;
pub const textScaled = font.textScaled;

const V3 = @Vector(3, f32);

// World and camera, in metres.
const SEG_M: f32 = @as(f32, @floatFromInt(track.SEGMENT_MM)) / 1000.0;
const ROAD_HALF: f32 = @as(f32, @floatFromInt(track.ROAD_HALF_WIDTH_MM)) / 1000.0;
const BARRIER: f32 = @as(f32, @floatFromInt(sim.BARRIER_MM)) / 1000.0;
const CAR_LEN: f32 = @as(f32, @floatFromInt(sim.CAR_LENGTH_MM)) / 1000.0;
const CAR_HALF_W: f32 = @as(f32, @floatFromInt(sim.CAR_WIDTH_MM)) / 2000.0 * 0.95;
const CURVE_K: f32 = SEG_M / 1000.0; // per-mille of a segment: lateral shift change per segment
const HILL_K: f32 = 1.0 / 1000.0;
const CAM_H: f32 = 2.5;
const CAM_BACK_MM: i64 = 7000;
const CAM_FOLLOW: f32 = 0.8; // share of the player's lateral offset the camera follows
const NEAR: f32 = 0.7;
const HORIZON: f32 = 0.44; // horizon height as a share of the frame
const FOCAL: f32 = 0.56; // focal length as a share of the width (about 84 degrees)
const DRAW_SEGS: u32 = 200;
const FOG_M: f32 = 330.0;
const KERB: f32 = 0.7;
const LAMP_H: f32 = 8.2;
const LAMP_POST_X: f32 = 9.3;
const LAMP_HEAD_X: f32 = 6.9;
const MAX_LAMPS: u32 = 256;
const MAX_POOLS: u32 = 8;
const MAX_POLY: u32 = 8;

const Pt = struct {
    z: f32, // camera space depth
    wx: f32, // road centre, camera space
    wy: f32,
    sx: f32, // screen road centre
    sy: f32,
    ppm: f32, // pixels per metre at this depth
    clip: f32, // nearer road hides rows at or below this y
    seg: i64, // segment index (wrapped on closed tracks)
    scen: track.Scenery,
};

const Lamp = struct {
    z: f32,
    X: f32, // lateral, metres from the road centre
    col: V3,
    pool: f32, // light pool strength on the ground
    // Screen-space reflection streak (on wet ground) below the light.
    sx: f32,
    y0: f32,
    y1: f32,
    wpx: f32,
    refl: f32,
};

const Pool = struct { X: f32, col: V3, width: f32, sharp: bool };

const CarView = struct { idx: u8, z: f32, X: f32 };

const Frame = struct {
    fb: []u8,
    w: i32,
    h: i32,
    fw: f32,
    fh: f32,
    sc: f32, // w / 320
    f: f32,
    cx0: f32,
    hy: f32,
    race: *const sim.Race,
    trk: *const track.Track,
    slot: u8,
    cam_x: f32,
    cam_y: f32,
    cam_mm: i64,
    base: i64,
    frac: f32,
    k0: u32,
    heading: f32, // radians, accumulated track bend at the camera
    speed: f32, // 0..1 of top speed
    nitro: bool,
    tick: u32,
    tid: u32,
    fog: V3,
    sky_top: V3,
    sky_mid: V3,
    sky_low: V3,
    fin_z: f32, // finish line depth (may be behind)
    start_z: f32,
};

var F: Frame = undefined;
var pts: [DRAW_SEGS + 1]Pt = undefined;
var lamps: [MAX_LAMPS]Lamp = undefined;
var lamp_n: u32 = 0;
var row_col: [MAX_W]V3 = undefined;
var row_wet: [MAX_W]f32 = undefined;
var pools: [MAX_POOLS]Pool = undefined;
var views: [sim.MAX_CARS]CarView = undefined;
var view_n: u32 = 0;

// ---------------------------------------------------------------- small math

inline fn fl(x: anytype) f32 {
    return @floatFromInt(x);
}
inline fn lerp(a: f32, b: f32, t: f32) f32 {
    return a + (b - a) * t;
}
inline fn sat(x: f32) f32 {
    return std.math.clamp(x, 0.0, 1.0);
}
inline fn rgb(r: f32, g: f32, b: f32) V3 {
    return .{ r, g, b };
}
inline fn sp(v: f32) V3 {
    return @splat(v);
}
inline fn mixc(a: V3, b: V3, t: f32) V3 {
    return a + (b - a) * sp(t);
}
inline fn fract(x: f32) f32 {
    return x - @floor(x);
}
fn iround(x: f32) i32 {
    const c = std.math.clamp(x, -100000.0, 100000.0);
    return @intFromFloat(@floor(c + 0.5));
}
fn ifloor(x: f32) i32 {
    const c = std.math.clamp(x, -1.0e9, 1.0e9);
    return @intFromFloat(@floor(c));
}
inline fn to8(v: f32) u8 {
    if (!(v > 0.0)) return 0;
    if (v >= 255.0) return 255;
    return @intFromFloat(v);
}
fn hash(x: u32) u32 {
    var v = x;
    v ^= v >> 16;
    v *%= 0x7feb352d;
    v ^= v >> 15;
    v *%= 0x846ca68b;
    v ^= v >> 16;
    return v;
}
fn h2(a: u32, b: u32) u32 {
    return hash(a ^ hash(b +% 0x9e3779b9));
}
fn h3(a: u32, b: u32, c: u32) u32 {
    return h2(h2(a, b), c);
}
fn unit(v: u32) f32 {
    return fl(v >> 8) / 16777216.0;
}
fn seg32(s: i64) u32 {
    return @truncate(@as(u64, @bitCast(s)));
}
/// exp(-x) for x >= 0, a cheap rational stand-in for looks.
inline fn fexp(x: f32) f32 {
    const v = @max(x, 0.0);
    return 1.0 / (1.0 + v + 0.5 * v * v + 0.1667 * v * v * v);
}
fn fogAt(z: f32) f32 {
    if (z <= 0) return 0;
    return 1.0 - @exp(-z / FOG_M);
}
fn rgbOf(c: palette.Rgb) V3 {
    return rgb(fl(c.r), fl(c.g), fl(c.b));
}

// ---------------------------------------------------------------- pixels

inline fn pidx(x: i32, y: i32) usize {
    return (@as(usize, @intCast(y)) * @as(usize, @intCast(F.w)) + @as(usize, @intCast(x))) * 4;
}
inline fn getp(x: i32, y: i32) V3 {
    if (x < 0 or y < 0 or x >= F.w or y >= F.h) return sp(0);
    const i = pidx(x, y);
    return rgb(fl(F.fb[i]), fl(F.fb[i + 1]), fl(F.fb[i + 2]));
}
inline fn putp(x: i32, y: i32, c: V3) void {
    if (x < 0 or y < 0 or x >= F.w or y >= F.h) return;
    const i = pidx(x, y);
    F.fb[i] = to8(c[0]);
    F.fb[i + 1] = to8(c[1]);
    F.fb[i + 2] = to8(c[2]);
    F.fb[i + 3] = 255;
}

const Mode = enum { normal, add, mul };

inline fn plot(x: i32, y: i32, c: V3, a: f32, mode: Mode) void {
    if (a <= 0.002) return;
    switch (mode) {
        .normal => if (a >= 0.999) putp(x, y, c) else putp(x, y, mixc(getp(x, y), c, a)),
        .add => putp(x, y, getp(x, y) + c * sp(a)),
        .mul => putp(x, y, getp(x, y) * mixc(sp(1), c, a)),
    }
}

const P2 = struct { x: f32, y: f32 };

/// Rectangle in pixel coordinates; thinner than a pixel draws one pixel with partial alpha.
fn fillRect(x0_in: f32, y0_in: f32, x1_in: f32, y1_in: f32, c: V3, alpha: f32, mode: Mode, clip: f32) void {
    var x0 = x0_in;
    var x1 = x1_in;
    var y0 = y0_in;
    var y1 = @min(y1_in, clip);
    if (!(x1 > x0) or !(y1 > y0)) return;
    var a = alpha;
    if (x1 - x0 < 1.0) {
        a *= x1 - x0;
        const m = (x0 + x1) * 0.5;
        x0 = m - 0.5;
        x1 = m + 0.5;
    }
    if (y1 - y0 < 1.0) {
        a *= y1 - y0;
        const m = (y0 + y1) * 0.5;
        y0 = m - 0.5;
        y1 = m + 0.5;
    }
    const ix0 = @max(iround(x0), 0);
    const ix1 = @min(iround(x1), F.w);
    const iy0 = @max(iround(y0), 0);
    const iy1 = @min(iround(y1), @min(F.h, iround(clip)));
    var y = iy0;
    while (y < iy1) : (y += 1) {
        var x = ix0;
        while (x < ix1) : (x += 1) plot(x, y, c, a, mode);
    }
}

/// Convex polygon, scanline filled; rows at or below clip are skipped.
fn fillPoly(p: []const P2, c: V3, alpha: f32, mode: Mode, clip: f32) void {
    assert(p.len >= 3 and p.len <= MAX_POLY);
    var ymin: f32 = p[0].y;
    var ymax: f32 = p[0].y;
    for (p[1..]) |q| {
        ymin = @min(ymin, q.y);
        ymax = @max(ymax, q.y);
    }
    if (!(ymax > ymin)) return;
    const iy0 = @max(iround(ymin), 0);
    const iy1 = @min(@min(iround(ymax), F.h), iround(clip));
    if (iy1 - iy0 > 4 * F.h) return; // degenerate projection
    var y = iy0;
    while (y < iy1) : (y += 1) {
        const yc = fl(y) + 0.5;
        var xl: f32 = 1.0e9;
        var xr: f32 = -1.0e9;
        var i: usize = 0;
        while (i < p.len) : (i += 1) {
            const a = p[i];
            const b = p[(i + 1) % p.len];
            if ((a.y <= yc and yc < b.y) or (b.y <= yc and yc < a.y)) {
                const x = a.x + (yc - a.y) * (b.x - a.x) / (b.y - a.y);
                xl = @min(xl, x);
                xr = @max(xr, x);
            }
        }
        if (xl > xr) continue;
        var ix0 = iround(xl);
        var ix1 = iround(xr);
        var a = alpha;
        if (ix1 <= ix0) {
            a *= sat(xr - xl);
            ix0 = ifloor((xl + xr) * 0.5);
            ix1 = ix0 + 1;
        }
        ix0 = @max(ix0, 0);
        ix1 = @min(ix1, F.w);
        var x = ix0;
        while (x < ix1) : (x += 1) plot(x, y, c, a, mode);
    }
}

fn quad(a: P2, b: P2, c2: P2, d: P2, c: V3, alpha: f32, mode: Mode, clip: f32) void {
    const p = [4]P2{ a, b, c2, d };
    fillPoly(&p, c, alpha, mode, clip);
}

fn line(x0: f32, y0: f32, x1: f32, y1: f32, thick: f32, c: V3, alpha: f32, mode: Mode, clip: f32) void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = @sqrt(dx * dx + dy * dy);
    if (len < 0.01) return;
    var t = thick;
    var a = alpha;
    if (t < 1.0) {
        a *= t;
        t = 1.0;
    }
    const nx = -dy / len * t * 0.5;
    const ny = dx / len * t * 0.5;
    quad(.{ .x = x0 + nx, .y = y0 + ny }, .{ .x = x1 + nx, .y = y1 + ny }, .{ .x = x1 - nx, .y = y1 - ny }, .{ .x = x0 - nx, .y = y0 - ny }, c, a, mode, clip);
}

/// Soft additive glow (or a soft blended blob with Mode.normal).
fn glow(cx: f32, cy: f32, rx_in: f32, ry_in: f32, c: V3, intensity: f32, mode: Mode, clip: f32) void {
    if (intensity <= 0.002) return;
    const rx = std.math.clamp(rx_in, 0.5, @max(56.0 * F.sc, 1.0));
    const ry = std.math.clamp(ry_in, 0.5, @max(56.0 * F.sc, 1.0));
    if (rx < 1.0 and ry < 1.0) {
        plot(ifloor(cx), ifloor(cy), c, intensity * rx * ry * 1.5, mode);
        return;
    }
    const ix0 = @max(ifloor(cx - rx), 0);
    const ix1 = @min(ifloor(cx + rx) + 1, F.w);
    const iy0 = @max(ifloor(cy - ry), 0);
    const iy1 = @min(@min(ifloor(cy + ry) + 1, F.h), iround(clip));
    var y = iy0;
    while (y < iy1) : (y += 1) {
        const dy = (fl(y) + 0.5 - cy) / ry;
        var x = ix0;
        while (x < ix1) : (x += 1) {
            const dx = (fl(x) + 0.5 - cx) / rx;
            const d2 = dx * dx + dy * dy;
            if (d2 >= 1.0) continue;
            const k = (1.0 - d2) * (1.0 - d2);
            plot(x, y, c, k * intensity, mode);
        }
    }
}

/// Solid disc with an anti-aliased rim.
fn disc(cx: f32, cy: f32, r: f32, c: V3, alpha: f32, clip: f32) void {
    if (r < 0.7) {
        plot(ifloor(cx), ifloor(cy), c, alpha * sat(r * r * 2.0), .normal);
        return;
    }
    const rr = @min(r, 120.0);
    const ix0 = @max(ifloor(cx - rr), 0);
    const ix1 = @min(ifloor(cx + rr) + 1, F.w);
    const iy0 = @max(ifloor(cy - rr), 0);
    const iy1 = @min(@min(ifloor(cy + rr) + 1, F.h), iround(clip));
    var y = iy0;
    while (y < iy1) : (y += 1) {
        var x = ix0;
        while (x < ix1) : (x += 1) {
            const dx = fl(x) + 0.5 - cx;
            const dy = fl(y) + 0.5 - cy;
            const d = @sqrt(dx * dx + dy * dy);
            plot(x, y, c, alpha * sat(rr - d + 0.5), .normal);
        }
    }
}

/// Text with font pixels of any (fractional) size; tiny text turns into a soft bar.
fn worldText(cx: f32, cy: f32, px: f32, str: []const u8, c: V3, alpha: f32, mode: Mode, clip: f32) void {
    const n: f32 = fl(str.len);
    const tw = (n * 6.0 - 1.0) * px;
    const th = 7.0 * px;
    const x0 = cx - tw * 0.5;
    const y0 = cy - th * 0.5;
    if (px < 0.55) {
        fillRect(x0, y0 + th * 0.2, x0 + tw, y0 + th * 0.8, c, alpha * 0.55, mode, clip);
        return;
    }
    for (str, 0..) |ch, i| {
        const g = font.glyph(ch);
        const gx = x0 + fl(i) * 6.0 * px;
        var row: u32 = 0;
        while (row < 7) : (row += 1) {
            var col: u32 = 0;
            while (col < 5) : (col += 1) {
                if (g[row] & (@as(u8, 0x10) >> @intCast(col)) == 0) continue;
                const x = gx + fl(col) * px;
                const y = y0 + fl(row) * px;
                fillRect(x, y, x + px, y + px, c, alpha, mode, clip);
            }
        }
    }
}

// ---------------------------------------------------------------- frame setup

const Sky = struct { top: V3, mid: V3, low: V3 };
const skies = [8]Sky{
    .{ .top = rgb(3, 6, 16), .mid = rgb(10, 22, 44), .low = rgb(96, 62, 58) }, // harbour sodium haze
    .{ .top = rgb(6, 3, 16), .mid = rgb(30, 10, 46), .low = rgb(120, 40, 104) }, // neon magenta
    .{ .top = rgb(3, 3, 14), .mid = rgb(16, 14, 46), .low = rgb(70, 48, 100) }, // indigo
    .{ .top = rgb(6, 4, 8), .mid = rgb(28, 14, 20), .low = rgb(130, 60, 34) }, // foundry glow
    .{ .top = rgb(2, 6, 18), .mid = rgb(12, 20, 52), .low = rgb(108, 56, 96) }, // bridge blue to pink
    .{ .top = rgb(5, 3, 14), .mid = rgb(24, 12, 42), .low = rgb(92, 50, 86) }, // old town violet
    .{ .top = rgb(2, 8, 12), .mid = rgb(8, 26, 34), .low = rgb(60, 82, 80) }, // canal teal
    .{ .top = rgb(3, 4, 14), .mid = rgb(14, 16, 40), .low = rgb(116, 74, 46) }, // causeway amber
};
const skyline_scale = [8]f32{ 0.8, 1.25, 1.1, 0.55, 1.35, 0.9, 0.85, 0.7 };

fn segAt(i: i64) track.Segment {
    const t = F.trk;
    const n: i64 = t.count;
    if (t.closed) return t.segments[@intCast(@mod(i, n))];
    if (i < 0) return .{ .curve = 0, .hill = 0, .scenery = t.segments[0].scenery };
    if (i >= n) return .{ .curve = 0, .hill = 0, .scenery = t.segments[@intCast(n - 1)].scenery };
    return t.segments[@intCast(i)];
}

fn wrapSeg(i: i64) i64 {
    if (F.trk.closed) return @mod(i, @as(i64, F.trk.count));
    return i;
}

/// Camera-relative depth (m) of a track position, shortest way round on a circuit.
fn depthOf(pos_mm: i64) f32 {
    var d = pos_mm - F.cam_mm;
    if (F.trk.closed) {
        const len = track.length_mm(F.trk);
        d = @mod(d + @divTrunc(len, 2), len) - @divTrunc(len, 2);
    }
    return fl(d) / 1000.0;
}

fn setup(fb: []u8, w: u32, h: u32, race: *const sim.Race, slot_in: u8) void {
    const slot: u8 = if (slot_in < race.car_count) slot_in else 0;
    const car = &race.cars[slot];
    const trk = &race.track;
    F.fb = fb;
    F.w = @intCast(w);
    F.h = @intCast(h);
    F.fw = fl(w);
    F.fh = fl(h);
    F.sc = F.fw / 320.0;
    F.f = F.fw * FOCAL;
    F.race = race;
    F.trk = trk;
    F.slot = slot;
    F.tick = race.tick;
    F.tid = trk.id;
    const sky = skies[trk.id & 7];
    F.sky_top = sky.top;
    F.sky_mid = sky.mid;
    F.sky_low = sky.low;
    F.fog = mixc(sky.low, sky.mid, 0.45) * sp(0.7);
    F.speed = sat(fl(car.speed) / fl(sim.MAX_SPEED));
    F.nitro = car.nitro_on;

    // Camera shake grows with speed, more with nitrous, a jolt while crashed.
    var shake = F.sc * (0.9 * F.speed * F.speed * F.speed + (if (F.nitro) @as(f32, 0.9) else 0.0));
    if (car.crashed_ticks > 0) shake += F.sc * 2.0 * fl(car.crashed_ticks) / fl(sim.CRASH_TICKS);
    const tk = fl(race.tick & 0xffff);
    const jx = @sin(tk * 1.37) * 0.6 + @sin(tk * 3.1 + 1.0) * 0.4;
    const jy = @sin(tk * 2.03 + 0.5) * 0.6 + @sin(tk * 4.7) * 0.4;
    F.cx0 = F.fw * 0.5 + jx * shake * 0.5;
    F.hy = F.fh * HORIZON + jy * shake;

    F.cam_mm = car.progress_mm - CAM_BACK_MM;
    if (trk.closed) F.cam_mm = @mod(F.cam_mm, track.length_mm(trk));
    F.base = @divFloor(F.cam_mm, track.SEGMENT_MM);
    F.frac = fl(F.cam_mm - F.base * track.SEGMENT_MM) / fl(track.SEGMENT_MM);
    F.cam_x = fl(car.lateral_mm) / 1000.0 * CAM_FOLLOW;

    // Heading: the bend accumulated from the start up to the camera (skyline and stars scroll with it).
    var acc: f32 = 0;
    const upto: i64 = std.math.clamp(F.base, 0, @as(i64, trk.count));
    var i: i64 = 0;
    while (i < upto) : (i += 1) acc += fl(trk.segments[@intCast(i)].curve);
    acc += fl(segAt(F.base).curve) * F.frac;
    F.heading = acc * CURVE_K / SEG_M;

    F.fin_z = depthOf(race.finish_mm);
    F.start_z = depthOf(sim.START_MM);
    if (trk.closed) F.start_z = 1.0e6; // the finish line is the start line
}

fn project() void {
    const s0 = segAt(F.base);
    var x: f32 = 0;
    var y: f32 = 0;
    var dx: f32 = -fl(s0.curve) * CURVE_K * F.frac;
    var k: u32 = 0;
    while (k <= DRAW_SEGS) : (k += 1) {
        const s = segAt(F.base + k);
        pts[k] = .{
            .z = (fl(k) - F.frac) * SEG_M,
            .wx = x,
            .wy = y,
            .sx = 0,
            .sy = 0,
            .ppm = 0,
            .clip = 0,
            .seg = wrapSeg(F.base + k),
            .scen = s.scenery,
        };
        x += dx;
        dx += fl(s.curve) * CURVE_K;
        y += fl(s.hill) * HILL_K;
    }
    F.cam_y = F.frac * fl(s0.hill) * HILL_K + CAM_H;

    // Clip the nearest segment at the near plane.
    F.k0 = if (pts[1].z > NEAR) 0 else 1;
    const a = pts[F.k0];
    const b = pts[F.k0 + 1];
    const t = (NEAR - a.z) / (b.z - a.z);
    pts[F.k0].z = NEAR;
    pts[F.k0].wx = lerp(a.wx, b.wx, t);
    pts[F.k0].wy = lerp(a.wy, b.wy, t);

    k = F.k0;
    while (k <= DRAW_SEGS) : (k += 1) {
        const p = &pts[k];
        p.ppm = F.f / p.z;
        p.sx = F.cx0 + (p.wx - F.cam_x) * p.ppm;
        p.sy = F.hy - (p.wy - F.cam_y) * p.ppm;
    }
    var maxy = F.fh;
    k = F.k0;
    while (k < DRAW_SEGS) : (k += 1) {
        pts[k].clip = maxy;
        const far = pts[k + 1].sy;
        if (far < pts[k].sy and far < maxy) maxy = far;
    }
    pts[DRAW_SEGS].clip = maxy;
}

const RoadAt = struct { sx: f32, sy: f32, ppm: f32, clip: f32, k: u32 };

/// Screen position of the road centre at camera depth z (z > NEAR).
fn roadAt(z_in: f32) RoadAt {
    const zmax = pts[DRAW_SEGS].z - 0.01;
    const z = std.math.clamp(z_in, NEAR, zmax);
    var k: u32 = @intCast(std.math.clamp(ifloor(z / SEG_M + F.frac), @as(i32, @intCast(F.k0)), @as(i32, DRAW_SEGS - 1)));
    if (z < pts[k].z and k > F.k0) k -= 1;
    const a = pts[k];
    const b = pts[k + 1];
    const t = sat((z - a.z) / (b.z - a.z));
    const ppm = F.f / z;
    return .{
        .sx = F.cx0 + (lerp(a.wx, b.wx, t) - F.cam_x) * ppm,
        .sy = F.hy - (lerp(a.wy, b.wy, t) - F.cam_y) * ppm,
        .ppm = ppm,
        .clip = a.clip,
        .k = k,
    };
}

inline fn at(r: RoadAt, X: f32, H: f32) P2 {
    return .{ .x = r.sx + X * r.ppm, .y = r.sy - H * r.ppm };
}

inline fn atPt(k: u32, X: f32, H: f32) P2 {
    return .{ .x = pts[k].sx + X * pts[k].ppm, .y = pts[k].sy - H * pts[k].ppm };
}

// ---------------------------------------------------------------- sky and skyline

fn drawSky() void {
    var y: i32 = 0;
    while (y < F.h) : (y += 1) {
        const yf = fl(y) + 0.5;
        var c: V3 = undefined;
        if (yf < F.hy) {
            const t = sat(yf / F.hy);
            if (t < 0.55) {
                c = mixc(F.sky_top, F.sky_mid, t / 0.55);
            } else {
                const u = (t - 0.55) / 0.45;
                c = mixc(F.sky_mid, F.sky_low, u * u);
            }
        } else {
            const t = sat((yf - F.hy) / (F.fh - F.hy + 1.0));
            c = mixc(F.fog, rgb(5, 5, 9), sat(t * 1.6));
        }
        var x: i32 = 0;
        while (x < F.w) : (x += 1) putp(x, y, c);
    }
}

fn panorama() f32 {
    return 2.0 * std.math.pi * F.f;
}

fn drawStars() void {
    const P = panorama();
    var i: u32 = 0;
    while (i < 150) : (i += 1) {
        const hv = h3(F.tid, i, 0x5747);
        const x = @mod(unit(hv) * P - F.heading * F.f, P);
        if (x >= F.fw) continue;
        const yv = unit(hash(hv));
        const y = yv * yv * F.hy * 0.85;
        const b = 0.25 + 0.75 * unit(h2(hv, 5));
        const tw = 0.7 + 0.3 * @sin(fl(F.tick & 0xffff) * 0.05 + fl(i) * 1.7);
        const c = mixc(rgb(190, 205, 255), rgb(255, 225, 190), unit(h2(hv, 9)));
        const a = b * tw * (1.0 - y / F.hy * 0.7);
        plot(ifloor(x), ifloor(y), c, a, .add);
        if (b > 0.93 and F.sc >= 1.0) {
            plot(ifloor(x) + 1, ifloor(y), c, a * 0.3, .add);
            plot(ifloor(x) - 1, ifloor(y), c, a * 0.3, .add);
            plot(ifloor(x), ifloor(y) + 1, c, a * 0.3, .add);
            plot(ifloor(x), ifloor(y) - 1, c, a * 0.3, .add);
        }
    }
}

fn drawMoon() void {
    if (F.tid % 4 == 3) return; // the foundry sky is too smoky for a moon
    const P = panorama();
    const az = unit(hash(F.tid *% 31 +% 7)) * P;
    var x = @mod(az - F.heading * F.f, P);
    const r = 6.5 * F.sc;
    if (x > P - 40.0 * F.sc) x -= P;
    if (x < -40.0 * F.sc or x > F.fw + 40.0 * F.sc) return;
    const y = F.hy * (0.22 + 0.15 * unit(hash(F.tid +% 99)));
    const mc = rgb(236, 230, 212);
    glow(x, y, r * 6.0, r * 6.0, mc, 0.10, .add, F.fh);
    glow(x, y, r * 2.4, r * 2.4, mc, 0.18, .add, F.fh);
    disc(x, y, r, mc, 1.0, F.fh);
    disc(x - r * 0.3, y - r * 0.2, r * 0.28, rgb(200, 194, 180), 0.8, F.fh);
    disc(x + r * 0.35, y + r * 0.3, r * 0.2, rgb(205, 198, 184), 0.8, F.fh);
    disc(x + r * 0.1, y - r * 0.5, r * 0.14, rgb(210, 204, 190), 0.7, F.fh);
}

const Layer = struct { mul: f32, bw: f32, hmin: f32, hmax: f32, col: V3, win: f32, haze: f32 };

fn drawSkyline() void {
    const layers = [3]Layer{
        .{ .mul = 0.55, .bw = 9, .hmin = 5, .hmax = 40, .col = rgb(26, 20, 44), .win = 0.10, .haze = 0.55 },
        .{ .mul = 0.75, .bw = 15, .hmin = 4, .hmax = 56, .col = rgb(14, 11, 26), .win = 0.18, .haze = 0.3 },
        .{ .mul = 1.0, .bw = 27, .hmin = 3, .hmax = 36, .col = rgb(7, 6, 13), .win = 0.26, .haze = 0.1 },
    };
    const hs = skyline_scale[F.tid & 7];
    const hy_i = ifloor(F.hy);
    var x: i32 = 0;
    while (x < F.w) : (x += 1) {
        var top: [3]f32 = undefined;
        var cell: [3]u32 = undefined;
        var local: [3]f32 = undefined;
        var bwv: [3]f32 = undefined;
        var spire: [3]bool = undefined;
        var ymin: f32 = F.hy;
        for (layers, 0..) |L, li| {
            const P = panorama() * L.mul;
            const cells = @max(@round(P / (L.bw * F.sc)), 8.0);
            const bw = P / cells;
            const u = @mod(fl(x) + 0.5 + F.heading * F.f * L.mul + F.cam_x * F.sc * 3.0 * L.mul, P);
            const ci = @floor(u / bw);
            const hv = h3(F.tid, @intCast(li), @intFromFloat(ci));
            const wf = 0.55 + 0.45 * unit(hv);
            const loc = u - ci * bw;
            const hu = unit(h2(hv, 1));
            const height = (L.hmin + (L.hmax - L.hmin) * hu * hu) * F.sc * hs;
            cell[li] = hv;
            local[li] = loc;
            bwv[li] = bw;
            spire[li] = false;
            top[li] = 1.0e9;
            if (loc < bw * wf) {
                top[li] = F.hy - height;
                // Antenna on some tall ones.
                if (hu > 0.7 and @abs(loc - bw * wf * 0.5) < 0.5 * F.sc and unit(h2(hv, 2)) > 0.4) {
                    top[li] = F.hy - height - 9.0 * F.sc;
                    spire[li] = true;
                }
            }
            ymin = @min(ymin, top[li]);
        }
        var y: i32 = @max(ifloor(ymin), 0);
        while (y < hy_i and y < F.h) : (y += 1) {
            const yf = fl(y) + 0.5;
            var li: usize = 3;
            var found: usize = 3;
            while (li > 0) {
                li -= 1;
                if (yf >= top[li]) {
                    found = li;
                    break;
                }
            }
            if (found == 3) continue;
            const L = layers[found];
            const up = F.hy - yf; // pixels above the horizon
            var c = L.col + F.sky_low * sp(0.22 * sat(1.0 - up / (30.0 * F.sc)));
            const tip = spire[found] and yf < top[found] + 9.0 * F.sc;
            if (tip) {
                if (yf < top[found] + 1.5 * F.sc and ((F.tick / 40 + cell[found]) & 1) == 0) c = rgb(255, 40, 40);
            } else {
                const cw = 2.0 * F.sc;
                const chh = 2.6 * F.sc;
                const lx = local[found] / cw;
                const ly = up / chh;
                if (fract(lx) < 0.55 and fract(ly) < 0.5 and lx > 0.6) {
                    const wv = h3(cell[found], @intFromFloat(@floor(lx)), @intFromFloat(@floor(ly)));
                    if (unit(wv) < L.win) {
                        const warm = mixc(rgb(255, 196, 120), rgb(160, 200, 255), unit(hash(wv)));
                        c = mixc(warm * sp(0.75), F.sky_low, L.haze);
                    }
                }
            }
            putp(x, y, c);
        }
    }
}

// ---------------------------------------------------------------- lights

fn lampSide(seg: i64, scen: track.Scenery) f32 {
    if (scen == .tunnel) return 0;
    const m = @mod(seg, 4);
    if (m == 0) return -1;
    if (m == 2) return 1;
    return 0;
}

fn lampColour(seg: i64, scen: track.Scenery) V3 {
    return switch (scen) {
        .downtown => rgb(255, 168, 78),
        .harbor => rgb(255, 150, 62),
        .neon => if (@mod(@divFloor(seg, 4), 2) == 0) rgb(255, 70, 205) else rgb(70, 220, 255),
        .bridge => rgb(190, 215, 255),
        .industrial => rgb(205, 255, 210),
        .tunnel => rgb(255, 222, 160),
    };
}

const sign_words = [_][]const u8{ "NITE", "24H", "DINER", "ARCADE", "MOTEL", "OPEN", "BAR", "TACOS", "RAMEN", "KARAOKE", "PAWN", "LIVE" };
const sign_cols = [_]V3{ rgb(255, 60, 200), rgb(60, 230, 255), rgb(255, 210, 60), rgb(120, 255, 90), rgb(255, 90, 60), rgb(170, 110, 255) };

fn hasSign(seg: i64, scen: track.Scenery) bool {
    return scen == .neon and @mod(seg, 3) == 1;
}
fn signSide(seg: i64) f32 {
    return if (@mod(@divFloor(seg, 3), 2) == 0) -1 else 1;
}
fn signColour(seg: i64) V3 {
    return sign_cols[h2(seg32(seg), 0x51) % sign_cols.len];
}

fn addLamp(z: f32, X: f32, H: f32, col: V3, pool: f32, refl: f32) void {
    if (lamp_n >= MAX_LAMPS) return;
    if (z < 1.0) return;
    const r = roadAt(z);
    if (r.sy > r.clip + 1.0) return; // behind a crest
    const ppm = r.ppm;
    lamps[lamp_n] = .{
        .z = z,
        .X = X,
        .col = col,
        .pool = pool,
        .sx = r.sx + X * ppm,
        .y0 = r.sy,
        .y1 = r.sy + H * ppm,
        .wpx = std.math.clamp(0.5 * ppm, 0.6, @max(5.0 * F.sc, 0.6)),
        .refl = refl * (1.0 - fogAt(z)),
    };
    lamp_n += 1;
}

fn collectLamps() void {
    lamp_n = 0;
    var k: u32 = F.k0 + 1;
    while (k < DRAW_SEGS) : (k += 1) {
        const p = pts[k];
        const side = lampSide(p.seg, p.scen);
        if (side != 0) addLamp(p.z, side * LAMP_HEAD_X, LAMP_H, lampColour(p.seg, p.scen) * sp(1.0 / 255.0), 1.0, 0.75);
        if (p.scen == .tunnel) addLamp(p.z + 1.0, 0, 6.2, rgb(255, 225, 170) * sp(1.0 / 255.0), 0.75, 0.6);
        if (hasSign(p.seg, p.scen)) addLamp(p.z, signSide(p.seg) * 11.0, 5.0, signColour(p.seg) * sp(1.0 / 255.0), 0.45, 0.7);
    }
}

fn braking(car: *const sim.Car) bool {
    if (F.race.phase == sim.PHASE_COUNTDOWN) return true;
    return car.input_prev & sim.IN_BRAKE != 0 or car.crashed_ticks > 0;
}

fn collectCars() void {
    view_n = 0;
    var i: u8 = 0;
    while (i < F.race.car_count) : (i += 1) {
        const car = &F.race.cars[i];
        const z = depthOf(car.progress_mm) - CAR_LEN * 0.5; // rear bumper
        if (z < 2.2 or z > pts[DRAW_SEGS].z - CAR_LEN - 1.0) continue;
        views[view_n] = .{ .idx = i, .z = z, .X = fl(car.lateral_mm) / 1000.0 };
        view_n += 1;
        // Tail lights reflect on the wet road.
        const brake = braking(car);
        const red = rgb(1.0, 0.12, 0.1);
        addLamp(z, views[view_n - 1].X - 0.7, 0.62, red, 0, if (brake) 0.9 else 0.4);
        addLamp(z, views[view_n - 1].X + 0.7, 0.62, red, 0, if (brake) 0.9 else 0.4);
    }
    // Far to near.
    var a: u32 = 1;
    while (a < view_n) : (a += 1) {
        var b = a;
        while (b > 0 and views[b - 1].z < views[b].z) : (b -= 1) {
            const t = views[b];
            views[b] = views[b - 1];
            views[b - 1] = t;
        }
    }
}

// ---------------------------------------------------------------- road

fn drawRoad() void {
    var k: u32 = F.k0;
    while (k < DRAW_SEGS) : (k += 1) {
        const a = pts[k];
        const b = pts[k + 1];
        if (!(b.sy < a.sy)) continue;
        const y_near = @min(a.sy, a.clip);
        if (!(b.sy < y_near)) continue;
        const iy0 = @max(iround(b.sy), 0);
        const iy1 = @min(iround(y_near), F.h);
        var y = iy0;
        while (y < iy1) : (y += 1) {
            const t = sat((a.sy - (fl(y) + 0.5)) / (a.sy - b.sy));
            roadRow(y, k, t);
        }
    }
}

fn lineCov(X: f32, centre: f32, half: f32, ppm: f32) f32 {
    const wpx = half * 2.0 * ppm;
    const d = @abs(X - centre) * ppm;
    if (wpx >= 1.0) return sat(wpx * 0.5 - d + 0.5);
    return wpx * sat(1.0 - d);
}

const Ground = struct { base: V3, wet: f32, emis: V3 };

fn offGround(X: f32, d: f32, along: f32, scen: track.Scenery, x: i32, y: i32) Ground {
    switch (scen) {
        .downtown, .neon => {
            var c = rgb(50, 48, 54);
            if (fract(along / 2.0) < 0.05 or fract(d / 2.0) < 0.05) c = rgb(36, 34, 40);
            if (d > BARRIER - ROAD_HALF - KERB + 1.2) c = rgb(24, 22, 28);
            return .{ .base = c, .wet = 0.5, .emis = sp(0) };
        },
        .harbor => {
            if (X < 0 and d > 2.6) return water(x, y);
            var c = rgb(46, 46, 50);
            if (X < 0 and d > 2.2) c = rgb(150, 120, 30); // quay edge paint
            return .{ .base = c, .wet = 0.4, .emis = sp(0) };
        },
        .bridge => {
            if (d > 1.2) return water(x, y);
            return .{ .base = rgb(40, 40, 46), .wet = 0.4, .emis = sp(0) };
        },
        .tunnel => return .{ .base = rgb(44, 44, 50), .wet = 0.2, .emis = sp(0) },
        .industrial => {
            if (d < 1.5) return .{ .base = rgb(44, 42, 44), .wet = 0.3, .emis = sp(0) };
            const n = unit(h3(@bitCast(ifloor(X * 3.0)), @bitCast(ifloor(along * 3.0)), 11)) * 10.0;
            return .{ .base = rgb(30 + n, 27 + n, 25 + n), .wet = 0.15, .emis = sp(0) };
        },
    }
}

fn water(x: i32, y: i32) Ground {
    const yf = fl(y) + 0.5;
    const tk = fl(F.tick & 0xffff);
    const wob = @sin(yf * 0.9 / F.sc + tk * 0.07) * 1.6 * F.sc;
    const my = 2.0 * F.hy - yf;
    var c = rgb(4, 7, 16);
    if (my >= 0) c += getp(x + iround(wob), ifloor(my)) * sp(0.45);
    if (unit(h3(@bitCast(x >> 1), @bitCast(y), F.tick / 6)) > 0.992) c += rgb(120, 110, 90);
    return .{ .base = rgb(4, 6, 12), .wet = 1.0, .emis = c };
}

fn roadRow(y: i32, k: u32, t: f32) void {
    const a = pts[k];
    const b = pts[k + 1];
    const iz = lerp(1.0 / a.z, 1.0 / b.z, t);
    const z = 1.0 / iz;
    const ppm = F.f * iz;
    const cx = lerp(a.sx, b.sx, t);
    const along = fl(@mod(a.seg, 8)) * SEG_M + (z - a.z);
    const scen = a.scen;
    const yc = fl(y) + 0.5;

    // Light pools that reach this row: street lamps, headlights, underglow.
    var pool_n: u32 = 0;
    var li: u32 = 0;
    while (li < lamp_n) : (li += 1) {
        const l = lamps[li];
        if (l.pool <= 0) continue;
        const dz = (z - l.z) / 7.0;
        if (@abs(dz) > 3.0) continue;
        const q = 1.0 + dz * dz;
        if (pool_n < MAX_POOLS) {
            pools[pool_n] = .{ .X = l.X, .col = l.col * sp(1.6 * l.pool / (q * q)), .width = 6.0, .sharp = false };
            pool_n += 1;
        }
    }
    var vi: u32 = 0;
    while (vi < view_n) : (vi += 1) {
        const v = views[vi];
        const car = &F.race.cars[v.idx];
        const d = z - (v.z + CAR_LEN);
        if (d > 0 and d < 60.0 and pool_n < MAX_POOLS) {
            const fall = 1.0 - d / 60.0;
            pools[pool_n] = .{ .X = v.X, .col = rgb(1.0, 0.96, 0.82) * sp(fall * fall * sat(d / 2.0) * 1.1), .width = 0.9 + d * 0.2, .sharp = true };
            pool_n += 1;
        }
        if (z > v.z - 1.0 and z < v.z + CAR_LEN + 1.0 and pool_n < MAX_POOLS) {
            pools[pool_n] = .{ .X = v.X, .col = rgbOf(palette.car(car.colour)) * sp(1.6 / 255.0), .width = 1.7, .sharp = true };
            pool_n += 1;
        }
    }

    const lanes: u32 = std.math.clamp(@as(u32, F.trk.lanes), 1, 8);
    const lw = 2.0 * ROAD_HALF / fl(lanes);
    const dash = F.race.mode == track.MODE_DRAG or fract(along / 10.0) < 0.4;
    const grain_k = sat(1.0 - z / 35.0);
    const amb = if (scen == .tunnel) rgb(0.3, 0.3, 0.36) else rgb(0.42, 0.44, 0.62);
    const sheen = F.sky_low * sp((0.08 + 0.3 * sat(z / 160.0)));
    const fin = @abs(z - F.fin_z) < 1.2;
    const start = @abs(z - F.start_z) < 0.25;

    var x: i32 = 0;
    while (x < F.w) : (x += 1) {
        const X = (fl(x) + 0.5 - cx) / ppm;
        const aX = @abs(X);
        var g: Ground = undefined;
        if (aX < ROAD_HALF) {
            var c = rgb(23, 24, 32);
            if (grain_k > 0) {
                const n = unit(h3(@bitCast(ifloor(X * 7.0)), @bitCast(ifloor(along * 7.0)), 3)) - 0.5;
                c += sp(n * 12.0 * grain_k);
            }
            const patch = unit(h2(@bitCast(ifloor(along / 4.0)), @bitCast(ifloor(X / 3.0))));
            c *= sp(0.9 + 0.2 * patch);
            var paint: f32 = lineCov(aX, ROAD_HALF - 0.35, 0.1, ppm);
            if (dash) {
                const li2 = std.math.clamp(@round((X + ROAD_HALF) / lw), 1.0, fl(lanes - 1));
                if (lanes > 1) paint += lineCov(X, -ROAD_HALF + li2 * lw, 0.08, ppm);
            }
            if (fin) {
                const chk = (ifloor(X) + ifloor((z - F.fin_z) / 1.0 + 8.0)) & 1;
                c = if (chk == 0) rgb(200, 200, 200) else rgb(14, 14, 16);
                paint = 0;
            }
            if (start) paint = 1;
            c = mixc(c, rgb(185, 185, 175), sat(paint));
            g = .{ .base = c, .wet = 1.0, .emis = sp(0) };
        } else if (aX < ROAD_HALF + KERB) {
            var c = rgb(70, 70, 76);
            if (scen != .tunnel and scen != .bridge) {
                c = if (@mod(ifloor(along / 2.5), 2) == 0) rgb(150, 28, 36) else rgb(175, 175, 175);
            }
            g = .{ .base = c, .wet = 0.6, .emis = sp(0) };
        } else {
            g = offGround(X, aX - ROAD_HALF - KERB, along, scen, x, y);
        }
        var light = amb;
        var pi: u32 = 0;
        while (pi < pool_n) : (pi += 1) {
            const p = pools[pi];
            const dx = (X - p.X) / p.width;
            if (@abs(dx) > 3.0) continue;
            const q = 1.0 + dx * dx;
            const f = if (p.sharp) 1.0 / (q * q * q) else 1.0 / (q * q);
            light += p.col * sp(f);
        }
        row_col[@intCast(x)] = g.base * light + g.emis + sheen * sp(g.wet);
        row_wet[@intCast(x)] = g.wet;
    }

    // Wet reflections: a vertical streak under each light, brightest at its mirror image.
    li = 0;
    while (li < lamp_n) : (li += 1) {
        const l = lamps[li];
        if (l.refl <= 0.01) continue;
        const span = @max(l.y1 - l.y0, 1.0);
        if (yc < l.y0 or yc > l.y1 + span * 0.8) continue;
        var v: f32 = undefined;
        if (yc <= l.y1) {
            const u = (yc - l.y0) / span;
            v = 0.2 + 0.8 * u * u;
        } else {
            const u = 1.0 - (yc - l.y1) / (span * 0.8);
            v = u * u;
        }
        const inten = v * l.refl * 255.0;
        const wpx = l.wpx * (1.0 + 0.6 * sat((yc - l.y0) / span));
        const xa = @max(ifloor(l.sx - 3.0 * wpx), 0);
        const xb = @min(ifloor(l.sx + 3.0 * wpx) + 1, F.w);
        var px = xa;
        while (px < xb) : (px += 1) {
            const d = (fl(px) + 0.5 - l.sx) / wpx;
            const q = 1.0 + d * d;
            const pu: usize = @intCast(px);
            row_col[pu] += l.col * sp(inten / (q * q) * row_wet[pu]);
        }
    }

    const fog = fogAt(z);
    x = 0;
    while (x < F.w) : (x += 1) {
        putp(x, y, mixc(row_col[@intCast(x)], F.fog, fog));
    }
}

// ---------------------------------------------------------------- scenery

const WallKind = enum { facade, shop, containers, tunnel, railing, fence };
const Shade = struct { c: V3, a: f32 };

const cont_cols = [_]V3{ rgb(150, 50, 36), rgb(36, 80, 140), rgb(40, 110, 70), rgb(190, 110, 30), rgb(110, 110, 116), rgb(130, 40, 90) };
const win_cols = [_]V3{ rgb(255, 210, 140), rgb(255, 236, 196), rgb(150, 196, 255), rgb(255, 160, 96) };

/// Per-wall constants, computed once per segment side.
const WallCtx = struct { accent: V3, roof: V3, hue: f32, lamp: V3 };

fn wallCtx(seg: i64, scen: track.Scenery, side: f32) WallCtx {
    const sgn: u32 = if (side < 0) 1 else 2;
    return .{
        .accent = signColour(seg),
        .roof = sign_cols[h2(seg32(seg), 3) % sign_cols.len],
        .hue = unit(h3(seg32(@divFloor(seg, 3)), sgn, 0xFA)),
        .lamp = if (scen == .tunnel) sp(0) else lampColour(seg, scen) * sp(1.1 / 255.0),
    };
}

/// Lamp light reaching a wall column: the nearest lamp on this side (every 4 segments, offset 0 or 2).
fn wallLampK(ctx: *const WallCtx, along_seg: f32, side: f32) V3 {
    const phase: f32 = if (side < 0) 0 else 2.0 * SEG_M;
    const d = @mod(along_seg - phase + 2.0 * SEG_M, 4.0 * SEG_M) - 2.0 * SEG_M;
    return ctx.lamp * sp(fexp(d * d / 30.0));
}

inline fn wallLight(hm: f32, lk: V3) V3 {
    const dh = (hm - 5.0) / 6.0;
    return rgb(0.32, 0.33, 0.45) + rgb(0.5, 0.36, 0.22) * sp(fexp(hm / 4.0)) + lk * sp(fexp(dh * dh));
}

fn shadeWall(kind: WallKind, seg: i64, ctx: *const WallCtx, lk: V3, u: f32, hm: f32, top: f32, side: f32, ppm: f32) Shade {
    const along = u * SEG_M; // within this segment
    const sgn: u32 = if (side < 0) 1 else 2;
    const s32 = seg32(seg);
    switch (kind) {
        .facade => {
            const wall = mixc(rgb(42, 40, 50), rgb(54, 44, 40), ctx.hue) * wallLight(hm, lk);
            if (hm > top - 0.6) return .{ .c = wall * sp(0.6), .a = 1 };
            if (hm < 4.0) {
                const shop = fract((fl(@mod(seg, 3)) * SEG_M + along) / 5.0);
                if (shop < 0.07 or hm > 3.6) return .{ .c = wall, .a = 1 };
                const sv = h3(s32, sgn, @intFromFloat(@floor((fl(@mod(seg, 3)) * SEG_M + along) / 5.0)));
                if (unit(sv) < 0.6) {
                    const ic = win_cols[sv % win_cols.len] * sp(0.55 + 0.25 * sat(1.0 - hm / 3.5));
                    return .{ .c = ic, .a = 1 };
                }
                const shutter: f32 = if (fract(hm / 0.18) < 0.5) 1.0 else 0.8;
                return .{ .c = rgb(36, 36, 42) * sp(shutter) * wallLight(hm, lk), .a = 1 };
            }
            if (hm < 4.3) return .{ .c = wall * sp(1.4), .a = 1 };
            const fy = (hm - 4.3) / 3.2;
            const fx = along / 1.66;
            if (ppm < 1.6) {
                const lit = 0.18 * unit(h3(s32, sgn, @intFromFloat(@floor(fy))));
                return .{ .c = mixc(wall, rgb(230, 190, 130), lit), .a = 1 };
            }
            if (fract(fx) > 0.18 and fract(fx) < 0.82 and fract(fy) > 0.22 and fract(fy) < 0.8) {
                const wv = h3(s32 *% 7 +% sgn, @intFromFloat(@floor(fx)), @intFromFloat(@floor(fy)));
                if (unit(wv) < 0.4) return .{ .c = win_cols[wv % win_cols.len] * sp(0.6 + 0.3 * unit(hash(wv))), .a = 1 };
                return .{ .c = rgb(14, 16, 26) + F.sky_low * sp(0.12), .a = 1 };
            }
            return .{ .c = wall, .a = 1 };
        },
        .shop => {
            const sc = ctx.accent;
            const wall = rgb(44, 28, 34) * wallLight(hm, lk);
            if (hm < 3.3) {
                if (fract(along / 2.5) < 0.06 or hm < 0.4) return .{ .c = wall, .a = 1 };
                const g = 0.45 + 0.3 * sat(1.0 - hm / 3.3);
                return .{ .c = sc * sp(g * 0.6) + rgb(60, 50, 50), .a = 1 };
            }
            if (hm < 3.65) return .{ .c = sc * sp(1.1) + rgb(60, 60, 60), .a = 1 };
            if (hm > top - 0.28) return .{ .c = ctx.roof * sp(1.05), .a = 1 };
            if (ppm > 6 and (fract(hm / 0.3) < 0.12 or fract((along + if (fract(hm / 0.6) < 0.5) @as(f32, 0.3) else 0.0) / 0.6) < 0.08)) return .{ .c = wall * sp(0.7), .a = 1 };
            const fx = along / 2.5;
            if (hm > 4.6 and fract(fx) > 0.3 and fract(fx) < 0.7 and fract((hm - 4.6) / 2.4) < 0.6) {
                const wv = h3(s32, sgn, @intFromFloat(@floor(fx)));
                if (unit(wv) < 0.35) return .{ .c = win_cols[wv % win_cols.len] * sp(0.55), .a = 1 };
                return .{ .c = rgb(12, 12, 20), .a = 1 };
            }
            return .{ .c = wall, .a = 1 };
        },
        .containers => {
            const pos = fl(seg) * SEG_M + along;
            const blk = @floor(pos / 6.1);
            const bh = h3(@bitCast(@as(i32, @intFromFloat(blk))), sgn, 0xC0);
            const stack = 1 + bh % 3;
            if (hm > fl(stack) * 2.6) return .{ .c = sp(0), .a = 0 };
            const level: u32 = @intFromFloat(@floor(hm / 2.6));
            var c = cont_cols[h2(bh, level) % cont_cols.len] * sp(0.55) * wallLight(hm, lk);
            if (ppm > 5 and fract(pos / 0.3) < 0.3) c *= sp(0.75);
            const fe = fract(pos / 6.1);
            if (fe < 0.03 or fe > 0.97 or fract(hm / 2.6) > 0.95) c = rgb(14, 14, 16);
            return .{ .c = c, .a = 1 };
        },
        .tunnel => {
            const lightk = 0.55 + 0.45 * @cos((fract(along / SEG_M) - 0.3) * 2.0 * std.math.pi);
            if (hm < 0.9) return .{ .c = rgb(40, 40, 46) * sp(0.6 + 0.4 * lightk), .a = 1 };
            if (hm < 1.1) return .{ .c = rgb(170, 120, 30), .a = 1 };
            if (hm < 4.6) {
                if (@mod(seg, 12) == 0 and hm > 2.0 and hm < 2.5 and fract(along / SEG_M) > 0.4 and fract(along / SEG_M) < 0.6) return .{ .c = rgb(40, 210, 120), .a = 1 };
                var c = rgb(120, 118, 106) * sp(0.35 + 0.55 * lightk);
                if (ppm > 5 and (fract(along / 0.6) < 0.06 or fract(hm / 0.6) < 0.06)) c *= sp(0.7);
                return .{ .c = c, .a = 1 };
            }
            return .{ .c = rgb(30, 30, 36) * sp(0.5 + 0.5 * lightk), .a = 1 };
        },
        .railing => {
            const steel = rgb(110, 116, 130) * wallLight(hm, lk);
            if (ppm < 3) return .{ .c = steel, .a = if (hm > 0.35) 0.5 else 0.0 };
            if (fract(along / 1.25) < 0.1 or (hm > 0.45 and hm < 0.55) or hm > 1.04) return .{ .c = steel, .a = 1 };
            return .{ .c = sp(0), .a = 0 };
        },
        .fence => {
            const grey = rgb(90, 92, 96) * wallLight(hm, lk);
            if (fract(along / 2.5) < 0.04 or hm > 2.4) return .{ .c = grey, .a = 1 };
            if (ppm < 8) return .{ .c = grey, .a = 0.3 };
            if (fract((along + hm) / 0.3) < 0.14 or fract((along - hm) / 0.3) < 0.14) return .{ .c = grey, .a = 0.9 };
            return .{ .c = sp(0), .a = 0 };
        },
    }
}

/// A vertical wall along segment k at lateral X from height h0 to h1, drawn column by column.
fn drawWall(k: u32, X: f32, h0: f32, h1: f32, kind: WallKind, side: f32) void {
    const a = pts[k];
    const b = pts[k + 1];
    const xn = a.sx + X * a.ppm;
    const xf = b.sx + X * b.ppm;
    if (@abs(xf - xn) < 0.25) return;
    const ytn = a.sy - h1 * a.ppm;
    const ybn = a.sy - h0 * a.ppm;
    const ytf = b.sy - h1 * b.ppm;
    const ybf = b.sy - h0 * b.ppm;
    const izn = 1.0 / a.z;
    const izf = 1.0 / b.z;
    const ix0 = @max(iround(@min(xn, xf)), 0);
    const ix1 = @min(iround(@max(xn, xf)), F.w);
    const yclip = @min(iround(a.clip), F.h);
    const ctx = wallCtx(a.seg, a.scen, side);
    var x = ix0;
    while (x < ix1) : (x += 1) {
        const s = sat((fl(x) + 0.5 - xn) / (xf - xn));
        const iz = lerp(izn, izf, s);
        const z = 1.0 / iz;
        const u = s * izf / iz;
        const ppm = F.f * iz;
        const top = lerp(ytn, ytf, s);
        const bot = lerp(ybn, ybf, s);
        const fog = fogAt(z);
        const iy0 = @max(iround(top), 0);
        const iy1 = @min(iround(bot), yclip);
        const lk = wallLampK(&ctx, fl(@mod(a.seg, 4)) * SEG_M + u * SEG_M, side);
        var y = iy0;
        while (y < iy1) : (y += 1) {
            const hm = h0 + (bot - (fl(y) + 0.5)) / ppm;
            const sh = shadeWall(kind, a.seg, &ctx, lk, u, hm, h1, side, ppm);
            if (sh.a <= 0) continue;
            plot(x, y, mixc(sh.c, F.fog, fog), sh.a, .normal);
        }
    }
}

fn drawCeiling(k: u32, H: f32, half: f32) void {
    const a = pts[k];
    const b = pts[k + 1];
    const yn = a.sy - (H) * a.ppm;
    const yf = b.sy - (H) * b.ppm;
    if (!(yf > yn)) return;
    const iy0 = @max(iround(yn), 0);
    const iy1 = @min(iround(yf), F.h);
    var y = iy0;
    while (y < iy1) : (y += 1) {
        const t = sat((fl(y) + 0.5 - yn) / (yf - yn));
        const iz = lerp(1.0 / a.z, 1.0 / b.z, t);
        const z = 1.0 / iz;
        const ppm = F.f * iz;
        // Screen x of the road centre is linear along the projected segment.
        const s = (iz - 1.0 / a.z) / (1.0 / b.z - 1.0 / a.z);
        const cx = lerp(a.sx, b.sx, s);
        const along = z - a.z;
        const fog = fogAt(z);
        const lightk = 0.5 + 0.5 * @cos((fract(along / SEG_M) - 0.3) * 2.0 * std.math.pi);
        const xa = @max(iround(cx - half * ppm), 0);
        const xb = @min(iround(cx + half * ppm), F.w);
        var x = xa;
        while (x < xb) : (x += 1) {
            const X = (fl(x) + 0.5 - cx) / ppm;
            var c = rgb(34, 34, 40) * sp(0.5 + 0.7 * lightk);
            if (fract(along / 2.5) < 0.07) c *= sp(0.6);
            const fa = fract(along / SEG_M);
            if (@abs(X) < 0.45 and fa > 0.1 and fa < 0.5) c = rgb(255, 238, 200);
            if (@abs(X) > half - 1.0) c *= sp(0.7);
            putp(x, y, mixc(c, F.fog, fog));
        }
    }
}

fn drawPortal(k: u32) void {
    const p = pts[k];
    const ppm = p.ppm;
    const fog = fogAt(p.z);
    const clip = p.clip;
    const face = mixc(rgb(50, 48, 54), F.fog, fog);
    const frame = mixc(rgb(86, 84, 88), F.fog, fog);
    const hill = mixc(rgb(14, 16, 20), F.fog, fog * 0.8);
    const L = atPt(k, -9.8, 6.5);
    const R = atPt(k, 9.8, 6.5);
    const top = p.sy - 60.0 * ppm;
    // Hillside, then the concrete face around the opening.
    fillRect(-1.0, top, F.fw + 1.0, p.sy - 14.0 * ppm, hill, 1, .normal, clip);
    fillRect(-1.0, p.sy - 14.0 * ppm, L.x, p.sy, face, 1, .normal, clip);
    fillRect(R.x, p.sy - 14.0 * ppm, F.fw + 1.0, p.sy, face, 1, .normal, clip);
    fillRect(L.x, p.sy - 14.0 * ppm, R.x, L.y, face, 1, .normal, clip);
    fillRect(L.x - 0.8 * ppm, L.y - 0.8 * ppm, R.x + 0.8 * ppm, L.y, frame, 1, .normal, clip);
    fillRect(L.x - 0.8 * ppm, L.y, L.x, p.sy, frame, 1, .normal, clip);
    fillRect(R.x, L.y, R.x + 0.8 * ppm, p.sy, frame, 1, .normal, clip);
    // Amber lamps over the mouth.
    var i: u32 = 0;
    while (i < 5) : (i += 1) {
        const lx = lerp(L.x, R.x, (fl(i) + 0.5) / 5.0);
        glow(lx, L.y - 0.4 * ppm, 1.2 * ppm, 1.2 * ppm, rgb(255, 170, 60), 0.6 * (1.0 - fog), .add, clip);
    }
}

fn drawLampPost(k: u32, side: f32) void {
    const p = pts[k];
    const ppm = p.ppm;
    const fog = fogAt(p.z);
    const clip = p.clip;
    const col = lampColour(p.seg, p.scen);
    const pole = mixc(rgb(34, 34, 40), F.fog, fog);
    const base = atPt(k, side * LAMP_POST_X, 0);
    const top = atPt(k, side * LAMP_POST_X, LAMP_H + 0.3);
    const head = atPt(k, side * LAMP_HEAD_X, LAMP_H);
    fillRect(base.x - 0.1 * ppm, top.y, base.x + 0.1 * ppm, base.y, pole, 1, .normal, clip);
    line(top.x, top.y, head.x, head.y, 0.12 * ppm, pole, 1, .normal, clip);
    fillRect(head.x - 0.55 * ppm, head.y - 0.12 * ppm, head.x + 0.55 * ppm, head.y + 0.06 * ppm, pole * sp(1.3), 1, .normal, clip);
    const vis = 1.0 - fog * 0.75;
    fillRect(head.x - 0.45 * ppm, head.y + 0.02 * ppm, head.x + 0.45 * ppm, head.y + 0.11 * ppm, mixc(col, rgb(255, 250, 235), 0.6), vis, .normal, clip);
    // Light cone through the damp air, then the halo.
    const g0 = atPt(k, side * LAMP_HEAD_X - 3.5, 0);
    const g1 = atPt(k, side * LAMP_HEAD_X + 3.5, 0);
    const cone = 0.05 * vis * sat((p.z - 8.0) / 15.0); // fades up close, where it would wash the frame
    quad(.{ .x = head.x - 0.4 * ppm, .y = head.y }, .{ .x = head.x + 0.4 * ppm, .y = head.y }, g1, g0, col, cone, .add, clip);
    glow(head.x, head.y + 0.1 * ppm, 3.0 * ppm, 2.2 * ppm, col, 0.5 * vis, .add, clip);
    glow(head.x, head.y + 0.1 * ppm, 0.9 * ppm, 0.6 * ppm, rgb(255, 250, 230), 0.6 * vis, .add, clip);
}

fn drawSign(k: u32) void {
    const p = pts[k];
    const seg = p.seg;
    const side = signSide(seg);
    const word = sign_words[h2(seg32(seg), 0x77) % sign_words.len];
    var col = signColour(seg);
    // A few signs buzz off now and then.
    if (h2(seg32(seg), 9) % 5 == 0 and ((F.tick / 4 +% seg32(seg)) % 23) < 2) col *= sp(0.25);
    const ppm = p.ppm;
    const fog = fogAt(p.z);
    const vis = 1.0 - fog * 0.6;
    const clip = p.clip;
    const fpx_m = @min(0.24, 4.8 / (fl(word.len) * 6.0));
    const tw = (fl(word.len) * 6.0 - 1.0) * fpx_m * ppm;
    const th = 7.0 * fpx_m * ppm;
    const c = atPt(k, side * 10.4, 5.3);
    const pad = 0.3 * ppm;
    const wallp = atPt(k, side * 12.0, 5.3);
    line(c.x, c.y, wallp.x, wallp.y, 0.12 * ppm, mixc(rgb(30, 30, 34), F.fog, fog), 1, .normal, clip);
    fillRect(c.x - tw * 0.5 - pad, c.y - th * 0.5 - pad, c.x + tw * 0.5 + pad, c.y + th * 0.5 + pad, mixc(rgb(14, 8, 18), F.fog, fog), 0.92, .normal, clip);
    const bt = @max(0.06 * ppm, 0.5);
    const x0 = c.x - tw * 0.5 - pad;
    const x1 = c.x + tw * 0.5 + pad;
    const y0 = c.y - th * 0.5 - pad;
    const y1 = c.y + th * 0.5 + pad;
    const edge = col * sp(0.8);
    fillRect(x0, y0, x1, y0 + bt, edge, vis, .normal, clip);
    fillRect(x0, y1 - bt, x1, y1, edge, vis, .normal, clip);
    fillRect(x0, y0, x0 + bt, y1, edge, vis, .normal, clip);
    fillRect(x1 - bt, y0, x1, y1, edge, vis, .normal, clip);
    glow(c.x, c.y, tw * 0.75 + pad * 2.0, th * 1.4 + pad * 2.0, col, 0.35 * vis, .add, clip);
    worldText(c.x, c.y, fpx_m * ppm, word, mixc(col, rgb(255, 255, 255), 0.45), vis, .normal, clip);
}

fn drawCrane(k: u32, X: f32, side: f32) void {
    const p = pts[k];
    const ppm = p.ppm;
    const fog = fogAt(p.z);
    const clip = p.clip;
    const vis = 1.0 - fog * 0.7;
    const steel = mixc(rgb(52, 44, 40), F.fog, fog);
    const t = 0.9 * ppm;
    const l0 = atPt(k, X - 5.0, 0);
    const l1 = atPt(k, X + 5.0, 0);
    const top = p.sy - 30.0 * ppm;
    fillRect(l0.x - t * 0.5, top, l0.x + t * 0.5, l0.y, steel, 1, .normal, clip);
    fillRect(l1.x - t * 0.5, top, l1.x + t * 0.5, l1.y, steel, 1, .normal, clip);
    fillRect(l0.x, top, l1.x, top + t * 1.2, steel, 1, .normal, clip);
    if (ppm > 1.5) {
        line(l0.x, top + t, l1.x, l0.y - 12.0 * ppm, 0.3 * ppm, steel, 1, .normal, clip);
        line(l1.x, top + t, l0.x, l0.y - 12.0 * ppm, 0.3 * ppm, steel, 1, .normal, clip);
    }
    const apex = atPt(k, X, 42.0);
    line(l0.x, top, apex.x, apex.y, 0.5 * ppm, steel, 1, .normal, clip);
    line(l1.x, top, apex.x, apex.y, 0.5 * ppm, steel, 1, .normal, clip);
    const b0 = atPt(k, X - side * 16.0, 33.0);
    const b1 = atPt(k, X + side * 30.0, 33.0);
    fillRect(@min(b0.x, b1.x), b0.y - 0.8 * ppm, @max(b0.x, b1.x), b0.y + 0.8 * ppm, steel, 1, .normal, clip);
    line(apex.x, apex.y, b1.x, b1.y, 0.2 * ppm, steel, 1, .normal, clip);
    line(apex.x, apex.y, b0.x, b0.y, 0.2 * ppm, steel, 1, .normal, clip);
    const hook = atPt(k, X + side * 20.0, 14.0);
    line(hook.x, b1.y, hook.x, hook.y, 0.1 * ppm, steel, 1, .normal, clip);
    const blink: f32 = if (((F.tick / 45) +% seg32(p.seg)) % 2 == 0) 1.0 else 0.25;
    glow(apex.x, apex.y, 1.6 * ppm, 1.6 * ppm, rgb(255, 40, 30), 0.8 * vis * blink, .add, clip);
    glow(b1.x, b1.y, 1.4 * ppm, 1.4 * ppm, rgb(255, 40, 30), 0.7 * vis * (1.25 - blink), .add, clip);
    glow(l0.x, top + t, 2.5 * ppm, 2.0 * ppm, rgb(255, 200, 120), 0.4 * vis, .add, clip);
    glow(l1.x, top + t, 2.5 * ppm, 2.0 * ppm, rgb(255, 200, 120), 0.4 * vis, .add, clip);
}

fn drawStack(k: u32, X: f32) void {
    const p = pts[k];
    const ppm = p.ppm;
    const fog = fogAt(p.z);
    const clip = p.clip;
    const vis = 1.0 - fog * 0.7;
    const b = atPt(k, X, 0);
    const H: f32 = 46.0;
    const top = p.sy - H * ppm;
    const r = 2.2 * ppm;
    const body = mixc(rgb(52, 46, 46), F.fog, fog);
    fillRect(b.x - r, top, b.x + r, b.y, body, 1, .normal, clip);
    fillRect(b.x - r, top, b.x - r * 0.3, b.y, body * sp(0.7), 1, .normal, clip);
    fillRect(b.x - r, top + 2.0 * ppm, b.x + r, top + 4.0 * ppm, mixc(rgb(120, 34, 34), F.fog, fog), 1, .normal, clip);
    fillRect(b.x - r, top + 6.0 * ppm, b.x + r, top + 8.0 * ppm, mixc(rgb(110, 110, 110), F.fog, fog), 1, .normal, clip);
    // Storage tank beside it.
    const tk = atPt(k, X - (if (X < 0) @as(f32, -9.0) else 9.0), 0);
    const tr = 4.5 * ppm;
    fillRect(tk.x - tr, b.y - 10.0 * ppm, tk.x + tr, b.y, mixc(rgb(64, 64, 70), F.fog, fog), 1, .normal, clip);
    glow(tk.x, b.y - 10.0 * ppm, tr, 0.9 * ppm, mixc(rgb(64, 64, 70), F.fog, fog), 1.0, .normal, clip);
    glow(tk.x, b.y - 10.5 * ppm, 0.8 * ppm, 0.8 * ppm, rgb(255, 60, 40), 0.6 * vis, .add, clip);
    const blink: f32 = if (((F.tick / 30) +% seg32(p.seg)) % 2 == 0) 1.0 else 0.2;
    glow(b.x, top, 1.6 * ppm, 1.6 * ppm, rgb(255, 40, 30), 0.9 * vis * blink, .add, clip);
    // Smoke, lit from below by the city.
    var i: u32 = 0;
    while (i < 7) : (i += 1) {
        const ph = fract(fl(F.tick % 2400) / 300.0 + fl(i) / 7.0);
        const sx = b.x + ph * 16.0 * ppm;
        const sy = top - ph * 26.0 * ppm;
        const sr = (2.0 + ph * 7.0) * ppm;
        glow(sx, sy, sr, sr * 0.8, mixc(rgb(90, 80, 90), F.sky_low, 0.5), 0.3 * (1.0 - ph) * vis, .normal, clip);
    }
}

fn bridgeCableH(seg: i64) f32 {
    const pos = fl(@mod(seg, 24));
    const u = (pos - 12.0) / 12.0;
    return 3.2 + 40.0 * u * u;
}

fn drawBridge(k: u32) void {
    const p = pts[k];
    const ppm = p.ppm;
    const fog = fogAt(p.z);
    const clip = p.clip;
    const vis = 1.0 - fog * 0.7;
    const steel = mixc(rgb(96, 104, 124), F.fog, fog);
    const hk = bridgeCableH(p.seg);
    const hk1 = bridgeCableH(pts[k + 1].seg);
    var si: u32 = 0;
    while (si < 2) : (si += 1) {
        const side: f32 = if (si == 0) -1 else 1;
        const X = side * 9.9;
        if (@mod(p.seg, 24) == 0) {
            const b = atPt(k, X, 0);
            const t = atPt(k, X, 52.0);
            const pyl = mixc(rgb(60, 62, 72), F.fog, fog);
            fillRect(b.x - 0.9 * ppm, t.y, b.x + 0.9 * ppm, b.y, pyl, 1, .normal, clip);
            glow(t.x, t.y, 1.6 * ppm, 1.6 * ppm, rgb(255, 40, 30), 0.9 * vis, .add, clip);
            if (side > 0) {
                const l = atPt(k, -9.9, 47.0);
                fillRect(l.x, l.y - 1.2 * ppm, t.x, l.y + 1.2 * ppm, pyl, 1, .normal, clip);
            }
        } else {
            const b = atPt(k, X, 1.2);
            const t = atPt(k, X, hk);
            line(b.x, b.y, t.x, t.y, 0.08 * ppm, steel, 0.9, .normal, clip);
        }
        const a = atPt(k, X, hk);
        const c = atPt(k + 1, X, hk1);
        line(a.x, a.y, c.x, c.y, 0.4 * ppm, steel, 1, .normal, clip);
        if (@mod(p.seg, 2) == 0) glow(a.x, a.y, 0.8 * ppm, 0.8 * ppm, rgb(200, 225, 255), 0.7 * vis, .add, clip);
    }
}

fn drawGantry(z: f32) void {
    const r = roadAt(z);
    const ppm = r.ppm;
    const fog = fogAt(z);
    const clip = r.clip;
    const vis = 1.0 - fog * 0.7;
    const post = mixc(rgb(44, 44, 52), F.fog, fog);
    const xs = [2]f32{ -(ROAD_HALF + 1.5), ROAD_HALF + 1.5 };
    for (xs) |X| {
        const b = at(r, X, 0);
        fillRect(b.x - 0.35 * ppm, b.y - 7.8 * ppm, b.x + 0.35 * ppm, b.y, post, 1, .normal, clip);
    }
    const l = at(r, xs[0], 7.8);
    const rr = at(r, xs[1], 6.2);
    const cell = 0.7 * ppm;
    const cols: u32 = @intFromFloat(std.math.clamp(@ceil((rr.x - l.x) / @max(cell, 0.5)), 1, 40));
    var j: u32 = 0;
    while (j < 2) : (j += 1) {
        var i: u32 = 0;
        while (i < cols) : (i += 1) {
            const c = if ((i + j) % 2 == 0) rgb(210, 210, 210) else rgb(18, 18, 22);
            const x0 = l.x + fl(i) * cell;
            const y0 = l.y + fl(j) * (rr.y - l.y) * 0.5;
            fillRect(x0, y0, @min(x0 + cell, rr.x), y0 + (rr.y - l.y) * 0.5, mixc(c, F.fog, fog), 1, .normal, clip);
        }
    }
    const mid = at(r, 0, 7.0);
    fillRect(mid.x - 3.4 * ppm, l.y, mid.x + 3.4 * ppm, rr.y, mixc(rgb(10, 10, 14), F.fog, fog), 1, .normal, clip);
    worldText(mid.x, mid.y, 0.17 * ppm, "FINISH", rgb(255, 230, 120), vis, .normal, clip);
    var i: u32 = 0;
    while (i < 14) : (i += 1) {
        const bx = lerp(l.x, rr.x, (fl(i) + 0.5) / 14.0);
        const on = ((F.tick / 6) + i) % 4 != 0;
        glow(bx, rr.y + 0.2 * ppm, 0.6 * ppm, 0.6 * ppm, rgb(255, 210, 120), (if (on) @as(f32, 0.8) else 0.2) * vis, .add, clip);
    }
}

/// Drag start tree: stage bulbs, three ambers, green. Lit from the countdown.
const TreeState = struct { ambers: u32, green: bool, show: bool };

fn treeState() TreeState {
    const race = F.race;
    if (race.mode != track.MODE_DRAG) return .{ .ambers = 0, .green = false, .show = false };
    if (race.phase == sim.PHASE_COUNTDOWN) {
        const left: u32 = race.countdown_left;
        var n: u32 = 0;
        if (left <= 135) n += 1;
        if (left <= 90) n += 1;
        if (left <= 45) n += 1;
        return .{ .ambers = n, .green = false, .show = true };
    }
    const since = race.tick -| @as(u32, sim.COUNTDOWN_TICKS);
    return .{ .ambers = 0, .green = true, .show = since < 90 };
}

/// Tree drawn in units u (pixels per 0.1 m): housing 28u tall, optional pole below to 50u.
fn drawTreeAt(cx: f32, top: f32, u: f32, st: TreeState, clip: f32, fog: f32, pole: bool) void {
    const vis = 1.0 - fog * 0.7;
    const housing = mixc(rgb(20, 20, 24), F.fog, fog);
    if (pole) fillRect(cx - 0.6 * u, top + 28.0 * u, cx + 0.6 * u, top + 50.0 * u, housing, 1, .normal, clip);
    fillRect(cx - 3.2 * u, top, cx + 3.2 * u, top + 28.0 * u, housing, 1, .normal, clip);
    const rows = [_]f32{ 2.0, 4.8, 9.0, 13.0, 17.0, 21.5, 25.5 };
    var i: usize = 0;
    while (i < rows.len) : (i += 1) {
        var c: V3 = undefined;
        var on = false;
        switch (i) {
            0, 1 => {
                c = rgb(255, 250, 220);
                on = !st.green;
            },
            2, 3, 4 => {
                c = rgb(255, 170, 20);
                on = st.ambers > i - 2;
            },
            5 => {
                c = rgb(40, 255, 80);
                on = st.green;
            },
            else => {
                c = rgb(255, 30, 30);
                on = false;
            },
        }
        const r: f32 = if (i < 2) 0.8 * u else 1.4 * u;
        var sx: u32 = 0;
        while (sx < 2) : (sx += 1) {
            const bx = cx + (if (sx == 0) @as(f32, -1.6) else 1.6) * u;
            const by = top + rows[i] * u;
            disc(bx, by, r, if (on) c else c * sp(0.14), 1, clip);
            if (on) glow(bx, by, r * 3.5, r * 3.5, c, 0.55 * vis, .add, clip);
        }
    }
}

fn drawTreeWorld(z: f32) void {
    if (F.race.mode != track.MODE_DRAG) return;
    const st = treeState();
    const r = roadAt(z);
    const b = at(r, -(ROAD_HALF + 1.4), 0);
    const u = 0.1 * r.ppm;
    drawTreeAt(b.x, b.y - 50.0 * u, u, st, r.clip, fogAt(z), true);
}

fn drawSegment(k: u32) void {
    const p = pts[k];
    const seg = p.seg;
    const tid: u32 = F.tid;
    switch (p.scen) {
        .downtown => {
            var si: u32 = 0;
            while (si < 2) : (si += 1) {
                const side: f32 = if (si == 0) -1 else 1;
                const blk = seg32(@divFloor(seg, 3));
                const hgt = 12.0 + unit(h3(blk, si, tid)) * 38.0;
                drawWall(k, side * 12.5, 0, hgt, .facade, side);
            }
        },
        .neon => {
            var si: u32 = 0;
            while (si < 2) : (si += 1) {
                const side: f32 = if (si == 0) -1 else 1;
                const hgt = 6.5 + unit(h3(seg32(@divFloor(seg, 2)), si, 5)) * 5.0;
                drawWall(k, side * 12.0, 0, hgt, .shop, side);
            }
        },
        .harbor => {
            if (@mod(seg, 16) == 5) drawCrane(k, -26.0, -1);
            if (@mod(seg, 16) == 13) drawCrane(k, 30.0, 1);
            drawWall(k, 12.5, 0, 7.8, .containers, 1);
        },
        .tunnel => {
            drawWall(k, -9.8, 0, 6.5, .tunnel, -1);
            drawWall(k, 9.8, 0, 6.5, .tunnel, 1);
            drawCeiling(k, 6.5, 9.8);
        },
        .bridge => {
            drawWall(k, -9.4, 0, 1.2, .railing, -1);
            drawWall(k, 9.4, 0, 1.2, .railing, 1);
            drawBridge(k);
        },
        .industrial => {
            if (@mod(seg, 11) == 3) {
                const side: f32 = if (@mod(@divFloor(seg, 11), 2) == 0) -1 else 1;
                drawStack(k, side * (30.0 + 12.0 * unit(seg32(seg))));
            }
            drawWall(k, -10.6, 0, 2.6, .fence, -1);
            drawWall(k, 10.6, 0, 2.6, .fence, 1);
        },
    }
    const side = lampSide(seg, p.scen);
    if (side != 0 and k > F.k0) drawLampPost(k, side);
    if (hasSign(seg, p.scen) and k > F.k0) drawSign(k);
}

// ---------------------------------------------------------------- cars

fn carLight(z: f32) V3 {
    var l = rgb(0.34, 0.35, 0.48) + F.sky_low * sp(0.25 / 255.0);
    var i: u32 = 0;
    while (i < lamp_n) : (i += 1) {
        const lp = lamps[i];
        if (lp.pool <= 0) continue;
        const d = (z - lp.z) / 9.0;
        if (@abs(d) > 4) continue;
        l += lp.col * sp(0.9 * lp.pool / (1.0 + d * d));
    }
    return l;
}

fn drawSparks(v: CarView, clip: f32) void {
    var i: u32 = 0;
    while (i < 16) : (i += 1) {
        const hv = h3(i, F.tick, v.idx);
        const r = roadAt(v.z + unit(hv) * CAR_LEN);
        const p = at(r, v.X + (unit(hash(hv)) - 0.5) * 2.6, unit(h2(hv, 2)) * 1.1);
        const dx = (unit(h2(hv, 3)) - 0.5) * 1.6 * r.ppm;
        const dy = -unit(h2(hv, 4)) * 0.8 * r.ppm;
        line(p.x, p.y, p.x + dx, p.y + dy, @max(0.08 * r.ppm, 0.6), rgb(255, 190, 80), 0.9, .add, clip);
    }
    const r = roadAt(v.z + 1.0);
    const p = at(r, v.X, 1.0);
    glow(p.x, p.y, 2.5 * r.ppm, 1.6 * r.ppm, rgb(70, 66, 72), 0.4, .normal, clip);
}

/// A wheel on the car's side plane: a circle in (depth, height) projected to a polygon.
fn sideWheel(az: f32, X: f32, rad: f32, c: V3, clip: f32) void {
    var p: [8]P2 = undefined;
    for (&p, 0..) |*q, i| {
        const a = fl(i) * std.math.pi / 4.0;
        q.* = at(roadAt(az + rad * @cos(a)), X, 0.34 + rad * @sin(a));
    }
    fillPoly(&p, c, 1, .normal, clip);
}

fn drawCar(v: CarView) void {
    const car = &F.race.cars[v.idx];
    const zr = v.z;
    const R = [_]RoadAt{
        roadAt(zr), // 0 rear
        roadAt(zr + 0.85), // 1 deck end / rear window base
        roadAt(zr + 1.75), // 2 roof start
        roadAt(zr + 2.75), // 3 roof end
        roadAt(zr + 3.35), // 4 windshield base
        roadAt(zr + CAR_LEN * 0.97), // 5 front
        roadAt(zr + 0.85), // 6 rear axle
        roadAt(zr + CAR_LEN - 0.95), // 7 front axle
        roadAt(zr + 2.2), // 8 middle
    };
    const clip = R[0].clip;
    const ppm = R[0].ppm;
    if (car.crashed_ticks > 0) {
        drawSparks(v, clip);
        if ((F.tick >> 2) & 1 == 1) return; // flicker
    }
    const X = v.X;
    const hw = CAR_HALF_W;
    const model = v.idx % 4;
    const fog = fogAt(zr);
    const vis = 1.0 - fog * 0.6;
    const col = rgbOf(palette.car(car.colour));
    const light = carLight(zr);
    const brake = braking(car);
    const fogc = struct {
        fn f(c: V3, k: f32) V3 {
            return mixc(c, F.fog, k);
        }
    }.f;
    const top = fogc(col * light * sp(0.8), fog);
    const side = fogc(col * light * sp(0.45), fog);
    const rear = fogc(col * light * sp(0.62), fog);
    const glass = fogc(rgb(14, 18, 30) + F.sky_low * sp(0.12), fog);
    const black = fogc(rgb(10, 10, 13), fog);

    // Shadow and underglow on the road.
    quad(at(R[0], X - 1.1, 0), at(R[0], X + 1.1, 0), at(R[5], X + 1.1, 0), at(R[5], X - 1.1, 0), sp(0.25), 0.8, .mul, clip);
    const gm = at(R[8], X, 0);
    const gry = @max((R[0].sy - R[5].sy) * 0.75, 0.35 * R[8].ppm);
    glow(gm.x, gm.y, 2.0 * R[8].ppm, gry, col, 0.45 * vis, .add, clip);
    glow(gm.x, gm.y, 1.3 * R[8].ppm, gry * 0.7, col, 0.4 * vis, .add, clip);

    // Tyres peeking out under the body.
    var ti: u32 = 0;
    while (ti < 2) : (ti += 1) {
        const s: f32 = if (ti == 0) -1 else 1;
        const rr = if (ti == 0) R[7] else R[7];
        quad(at(rr, X + s * (hw - 0.34), 0.0), at(rr, X + s * (hw - 0.02), 0.0), at(rr, X + s * (hw - 0.02), 0.55), at(rr, X + s * (hw - 0.34), 0.55), black, 1, .normal, clip);
        quad(at(R[0], X + s * (hw - 0.36), 0.0), at(R[0], X + s * (hw - 0.04), 0.0), at(R[0], X + s * (hw - 0.04), 0.55), at(R[0], X + s * (hw - 0.36), 0.55), black, 1, .normal, clip);
    }

    // Hood.
    quad(at(R[4], X - 0.9, 0.76), at(R[4], X + 0.9, 0.76), at(R[5], X + 0.86, 0.66), at(R[5], X - 0.86, 0.66), top, 1, .normal, clip);

    // The side facing the camera, if any.
    var si: u32 = 0;
    while (si < 2) : (si += 1) {
        const s: f32 = if (si == 0) -1 else 1;
        const xr = at(R[0], X + s * hw, 0.5).x;
        const xf = at(R[5], X + s * hw, 0.5).x;
        const visible = if (s < 0) xf < xr - 0.3 else xf > xr + 0.3;
        if (!visible) continue;
        quad(at(R[0], X + s * hw, 0.2), at(R[0], X + s * hw, 0.8), at(R[5], X + s * hw * 0.97, 0.7), at(R[5], X + s * hw * 0.97, 0.24), side, 1, .normal, clip);
        const b0 = at(R[0], X + s * hw, 0.77);
        const b1 = at(R[5], X + s * hw, 0.67);
        line(b0.x, b0.y, b1.x, b1.y, @max(0.05 * ppm, 0.5), fogc(col * light * sp(1.3), fog), 0.9, .normal, clip);
        // Neon side skirt.
        const k0p = at(R[0], X + s * hw, 0.2);
        const k1p = at(R[5], X + s * hw, 0.24);
        line(k0p.x, k0p.y, k1p.x, k1p.y, @max(0.05 * ppm, 0.6), col, 0.8 * vis, .add, clip);
        // Wheels with rims.
        const axles = [2]f32{ zr + 0.85, zr + CAR_LEN - 0.95 };
        for (axles) |az| {
            sideWheel(az, X + s * (hw + 0.02), 0.34, black, clip);
            sideWheel(az, X + s * (hw + 0.03), 0.21, fogc(rgb(110, 112, 124) * light, fog), clip);
            sideWheel(az, X + s * (hw + 0.04), 0.07, black, clip);
        }
        quad(at(R[1], X + s * 0.8, 0.82), at(R[2], X + s * 0.66, 1.28), at(R[3], X + s * 0.66, 1.28), at(R[4], X + s * 0.8, 0.8), glass, 1, .normal, clip);
    }

    // Roof, rear window, deck, rear face.
    quad(at(R[2], X - 0.66, 1.3), at(R[2], X + 0.66, 1.3), at(R[3], X + 0.64, 1.3), at(R[3], X - 0.64, 1.3), top, 1, .normal, clip);
    quad(at(R[1], X - 0.8, 0.82), at(R[1], X + 0.8, 0.82), at(R[2], X + 0.66, 1.29), at(R[2], X - 0.66, 1.29), glass, 1, .normal, clip);
    const g0 = at(R[1], X - 0.3, 0.84);
    const g1 = at(R[2], X + 0.1, 1.27);
    line(g0.x, g0.y, g1.x, g1.y, @max(0.12 * ppm, 0.5), fogc(F.sky_low * sp(0.5), fog), 0.5, .add, clip);
    if (model == 3) {
        var li: u32 = 1;
        while (li < 5) : (li += 1) {
            const t = fl(li) / 5.0;
            const ra = roadAt(zr + 0.85 + 0.9 * t);
            const pa = at(ra, X - 0.75 + 0.1 * t, 0.82 + 0.47 * t);
            const pb = at(ra, X + 0.75 - 0.1 * t, 0.82 + 0.47 * t);
            line(pa.x, pa.y, pb.x, pb.y, @max(0.04 * ra.ppm, 0.5), black, 1, .normal, clip);
        }
    }
    quad(at(R[0], X - hw, 0.8), at(R[0], X + hw, 0.8), at(R[1], X + hw * 0.97, 0.83), at(R[1], X - hw * 0.97, 0.83), top, 1, .normal, clip);

    const r0 = R[0];
    const rx = struct {
        fn f(r: RoadAt, x: f32) f32 {
            return r.sx + x * r.ppm;
        }
    }.f;
    const ry = struct {
        fn f(r: RoadAt, hh: f32) f32 {
            return r.sy - hh * r.ppm;
        }
    }.f;
    quad(.{ .x = rx(r0, X - hw), .y = ry(r0, 0.2) }, .{ .x = rx(r0, X + hw), .y = ry(r0, 0.2) }, .{ .x = rx(r0, X + hw - 0.04), .y = ry(r0, 0.8) }, .{ .x = rx(r0, X - hw + 0.04), .y = ry(r0, 0.8) }, rear, 1, .normal, clip);
    fillRect(rx(r0, X - hw), ry(r0, 0.8), rx(r0, X + hw), ry(r0, 0.77), fogc(col * light * sp(1.2), fog), 1, .normal, clip);
    fillRect(rx(r0, X - 0.82), ry(r0, 0.34), rx(r0, X + 0.82), ry(r0, 0.18), black, 1, .normal, clip);
    // Plate with a tiny lamp above it.
    fillRect(rx(r0, X - 0.26), ry(r0, 0.5), rx(r0, X + 0.26), ry(r0, 0.37), fogc(rgb(150, 150, 140), fog), 1, .normal, clip);
    if (ppm > 30) worldText(rx(r0, X), ry(r0, 0.435), 0.012 * ppm, "MM-60", fogc(rgb(30, 30, 40), fog), 1, .normal, clip);

    // Exhausts.
    var ex: [4]f32 = undefined;
    var exn: usize = 2;
    switch (model) {
        0 => ex[0..2].* = .{ -0.55, 0.55 },
        1 => {
            ex = .{ -0.42, -0.28, 0.28, 0.42 };
            exn = 4;
        },
        2 => {
            ex[0] = 0;
            exn = 1;
        },
        else => ex[0..2].* = .{ -0.66, 0.66 },
    }
    const ex_r: f32 = if (model == 2) 0.1 else 0.065;
    for (ex[0..exn]) |e| {
        disc(rx(r0, X + e), ry(r0, 0.27), ex_r * ppm, fogc(rgb(90, 90, 96), fog), 1, clip);
        disc(rx(r0, X + e), ry(r0, 0.27), ex_r * 0.6 * ppm, black, 1, clip);
    }

    // Tail lights.
    const bi: f32 = if (brake) 1.0 else 0.5;
    const red = rgb(255, 34, 44) * sp(bi);
    const hot = mixc(red, rgb(255, 210, 200), if (brake) 0.45 else 0.0);
    const lv = 1.0 - fog * 0.4;
    switch (model) {
        0 => {
            fillRect(rx(r0, X - 0.9), ry(r0, 0.69), rx(r0, X + 0.9), ry(r0, 0.63), red, lv, .normal, clip);
            fillRect(rx(r0, X - 0.9), ry(r0, 0.68), rx(r0, X - 0.6), ry(r0, 0.64), hot, lv, .normal, clip);
            fillRect(rx(r0, X + 0.6), ry(r0, 0.68), rx(r0, X + 0.9), ry(r0, 0.64), hot, lv, .normal, clip);
        },
        1 => {
            const xs = [4]f32{ -0.74, -0.5, 0.5, 0.74 };
            for (xs) |lx| {
                disc(rx(r0, X + lx), ry(r0, 0.63), 0.09 * ppm, red, lv, clip);
                disc(rx(r0, X + lx), ry(r0, 0.63), 0.045 * ppm, hot, lv, clip);
            }
        },
        2 => {
            var s2: u32 = 0;
            while (s2 < 2) : (s2 += 1) {
                const s: f32 = if (s2 == 0) -1 else 1;
                quad(.{ .x = rx(r0, X + s * 0.93), .y = ry(r0, 0.7) }, .{ .x = rx(r0, X + s * 0.5), .y = ry(r0, 0.72) }, .{ .x = rx(r0, X + s * 0.5), .y = ry(r0, 0.67) }, .{ .x = rx(r0, X + s * 0.93), .y = ry(r0, 0.62) }, red, lv, .normal, clip);
            }
        },
        else => {
            fillRect(rx(r0, X - 0.9), ry(r0, 0.73), rx(r0, X - 0.52), ry(r0, 0.56), red, lv, .normal, clip);
            fillRect(rx(r0, X + 0.52), ry(r0, 0.73), rx(r0, X + 0.9), ry(r0, 0.56), red, lv, .normal, clip);
            fillRect(rx(r0, X - 0.84), ry(r0, 0.69), rx(r0, X - 0.58), ry(r0, 0.6), hot, lv, .normal, clip);
            fillRect(rx(r0, X + 0.58), ry(r0, 0.69), rx(r0, X + 0.84), ry(r0, 0.6), hot, lv, .normal, clip);
        },
    }
    const halo: f32 = if (brake) 0.75 else 0.3;
    glow(rx(r0, X - 0.72), ry(r0, 0.65), (if (brake) @as(f32, 0.9) else 0.5) * ppm, 0.45 * ppm, rgb(255, 30, 40), halo * lv, .add, clip);
    glow(rx(r0, X + 0.72), ry(r0, 0.65), (if (brake) @as(f32, 0.9) else 0.5) * ppm, 0.45 * ppm, rgb(255, 30, 40), halo * lv, .add, clip);
    if (brake) {
        const hb = at(R[2], X, 1.26);
        fillRect(hb.x - 0.22 * R[2].ppm, hb.y - 0.025 * R[2].ppm, hb.x + 0.22 * R[2].ppm, hb.y + 0.025 * R[2].ppm, rgb(255, 60, 60), lv, .normal, clip);
        glow(hb.x, hb.y, 0.5 * R[2].ppm, 0.2 * R[2].ppm, rgb(255, 40, 40), 0.4 * lv, .add, clip);
    }

    // Spoiler.
    switch (model) {
        0, 2 => {
            const hgt: f32 = if (model == 0) 1.08 else 1.26;
            const half: f32 = if (model == 0) 0.95 else 0.88;
            const rs = roadAt(zr + 0.12);
            const rs2 = roadAt(zr + 0.42);
            var s2: u32 = 0;
            while (s2 < 2) : (s2 += 1) {
                const s: f32 = if (s2 == 0) -1 else 1;
                const a = at(rs, X + s * 0.5, 0.8);
                const b = at(rs, X + s * 0.5, hgt);
                line(a.x, a.y, b.x, b.y, @max(0.06 * rs.ppm, 0.6), black, 1, .normal, clip);
            }
            quad(at(rs, X - half, hgt + 0.06), at(rs, X + half, hgt + 0.06), at(rs2, X + half, hgt + 0.08), at(rs2, X - half, hgt + 0.08), top, 1, .normal, clip);
            quad(at(rs, X - half, hgt - 0.02), at(rs, X + half, hgt - 0.02), at(rs, X + half, hgt + 0.06), at(rs, X - half, hgt + 0.06), rear, 1, .normal, clip);
            fillRect(rx(rs, X - half - 0.03), ry(rs, hgt + 0.12), rx(rs, X - half + 0.02), ry(rs, hgt - 0.08), black, 1, .normal, clip);
            fillRect(rx(rs, X + half - 0.02), ry(rs, hgt + 0.12), rx(rs, X + half + 0.03), ry(rs, hgt - 0.08), black, 1, .normal, clip);
        },
        1 => {
            quad(at(R[0], X - hw, 0.8), at(R[0], X + hw, 0.8), at(R[0], X + hw * 0.92, 0.9), at(R[0], X - hw * 0.92, 0.9), top, 1, .normal, clip);
        },
        else => {},
    }

    // Nitrous: flickering flame cones from the exhausts, pointing back at the camera.
    if (car.nitro_on) {
        for (ex[0..exn]) |e| {
            const fv = unit(h3(F.tick, v.idx, @intFromFloat((e + 1.0) * 10.0)));
            const flen = 1.2 + 1.0 * fv;
            const zt = @max(zr - flen, NEAR + 0.3);
            const zm = lerp(zr, zt, 0.4);
            const rb = R[0];
            const rm = roadAt(zm);
            const rt = roadAt(zt);
            const ex_x = X + e;
            const wob = (unit(hash(h3(F.tick, v.idx, 7))) - 0.5) * 0.12;
            const outer = [5]P2{
                at(rb, ex_x - 0.08, 0.27),
                at(rm, ex_x - 0.16, 0.27),
                at(rt, ex_x + e * 0.15 + wob, 0.3),
                at(rm, ex_x + 0.16, 0.27),
                at(rb, ex_x + 0.08, 0.27),
            };
            fillPoly(&outer, rgb(90, 70, 255), 0.75, .add, F.fh);
            const zi = lerp(zr, zt, 0.6);
            const ri = roadAt(zi);
            const rim = roadAt(lerp(zr, zt, 0.25));
            const inner = [5]P2{
                at(rb, ex_x - 0.045, 0.27),
                at(rim, ex_x - 0.08, 0.27),
                at(ri, ex_x + e * 0.08 + wob * 0.5, 0.29),
                at(rim, ex_x + 0.08, 0.27),
                at(rb, ex_x + 0.045, 0.27),
            };
            fillPoly(&inner, rgb(140, 220, 255), 0.9, .add, F.fh);
            const p0 = at(rb, ex_x, 0.27);
            glow(p0.x, p0.y, 0.45 * ppm, 0.35 * ppm, rgb(120, 160, 255), 0.7, .add, F.fh);
            glow(p0.x, p0.y, 0.15 * ppm, 0.12 * ppm, rgb(255, 255, 255), 0.9, .add, F.fh);
        }
    }
    // Perfect shift: a quick flash from the exhaust.
    if (car.shift_flash > 0 and !car.nitro_on) {
        for (ex[0..exn]) |e| glow(rx(r0, X + e), ry(r0, 0.27), 0.3 * ppm, 0.25 * ppm, rgb(255, 160, 60), 0.8, .add, F.fh);
    }
}

// ---------------------------------------------------------------- composition

fn drawWorld() void {
    var ci: u32 = 0;
    var k: u32 = DRAW_SEGS - 1;
    var steps: u32 = 0;
    while (steps < DRAW_SEGS) : (steps += 1) {
        const z0 = pts[k].z;
        const z1 = pts[k + 1].z;
        drawSegment(k);
        if (F.fin_z >= z0 and F.fin_z < z1 and F.fin_z > NEAR + 0.5) drawGantry(F.fin_z);
        if (F.start_z >= z0 and F.start_z < z1 and F.start_z > NEAR + 0.5) drawTreeWorld(F.start_z);
        while (ci < view_n and views[ci].z >= z0) : (ci += 1) drawCar(views[ci]);
        if (k > F.k0 and pts[k].scen == .tunnel and pts[k - 1].scen != .tunnel) drawPortal(k);
        if (k == F.k0) break;
        k -= 1;
    }
    while (ci < view_n) : (ci += 1) drawCar(views[ci]);
}

fn drawEffects() void {
    const s = F.speed;
    var n: u32 = 0;
    if (s > 0.45) n = @intFromFloat((s - 0.45) * 90.0);
    if (F.nitro) n += 40;
    n = @min(n, 120);
    const R = @sqrt(F.fw * F.fw + F.fh * F.fh) * 0.5;
    const col = if (F.nitro) rgb(150, 200, 255) else rgb(215, 215, 235);
    var i: u32 = 0;
    while (i < n) : (i += 1) {
        const hv = h3(i, F.tick / 2, 0x5EED);
        const ang = unit(hv) * 2.0 * std.math.pi;
        const r0 = (0.42 + 0.5 * unit(hash(hv))) * R;
        const len = (0.06 + 0.18 * unit(h2(hv, 3))) * R * (0.5 + s);
        const dx = @cos(ang);
        const dy = @sin(ang) * 0.8;
        line(F.cx0 + dx * r0, F.hy + dy * r0, F.cx0 + dx * (r0 + len), F.hy + dy * (r0 + len), @max(0.7 * F.sc, 0.7), col, if (F.nitro) 0.3 else 0.16, .add, F.fh);
    }
    // Vignette, tinted blue while nitrous burns.
    const tint = if (F.nitro) rgb(30, 70, 255) else sp(0);
    var y: i32 = 0;
    while (y < F.h) : (y += 1) {
        const dy = (fl(y) + 0.5 - F.fh * 0.5) / (F.fh * 0.5);
        const dy2 = dy * dy * 0.6;
        // Columns where the vignette starts: d = 0.6 dx^2 + dy2 >= 0.35.
        const rem = (0.35 - dy2) / 0.6;
        const inner: i32 = if (rem > 0) @intFromFloat(@sqrt(rem) * F.fw * 0.5) else 0;
        const xa = std.math.clamp(@divTrunc(F.w, 2) - inner, 0, F.w);
        const xb = std.math.clamp(@divTrunc(F.w, 2) + inner, 0, F.w);
        var x: i32 = 0;
        while (x < F.w) : (x += 1) {
            if (x == xa and xb > xa) x = xb;
            if (x >= F.w) break;
            const dx = (fl(x) + 0.5 - F.fw * 0.5) / (F.fw * 0.5);
            const d = dx * dx * 0.6 + dy2;
            if (d < 0.35) continue;
            const e = sat((d - 0.35) / 0.85);
            const k = 1.0 - 0.45 * e;
            const t = e * e * 0.5;
            const o = pidx(x, y);
            F.fb[o] = to8(fl(F.fb[o]) * k + tint[0] * t);
            F.fb[o + 1] = to8(fl(F.fb[o + 1]) * k + tint[1] * t);
            F.fb[o + 2] = to8(fl(F.fb[o + 2]) * k + tint[2] * t);
        }
    }
    // Drag start tree, big, while the lights run.
    const st = treeState();
    if (st.show) {
        const u = 1.3 * F.sc;
        const cx = F.fw * 0.5;
        const top = 6.0 * F.sc;
        drawTreeAt(cx, top, u, st, F.fh, 0, false);
    }
}

/// Draws the chase view of race car 'slot' into fb (RGBA, w x h, row-major).
pub fn draw(fb: []u8, w: u32, h: u32, race: *const sim.Race, slot: u8) void {
    assert(w <= MAX_W and h <= MAX_H);
    assert(fb.len >= @as(usize, w) * h * 4);
    if (w < 8 or h < 8) {
        @memset(fb[0 .. @as(usize, w) * h * 4], 255);
        return;
    }
    assert(race.car_count >= 1 and race.car_count <= sim.MAX_CARS);
    assert(race.track.count >= 1 and race.track.count <= track.MAX_SEGMENTS);
    setup(fb, w, h, race, slot);
    drawSky();
    drawStars();
    drawMoon();
    drawSkyline();
    project();
    collectLamps();
    collectCars();
    drawRoad();
    drawWorld();
    drawEffects();
}

// ---------------------------------------------------------------- tests

var test_race: sim.Race = undefined;
var test_fb: [MAX_W * MAX_H * 4 + 256]u8 = undefined;

fn fnv1a(bytes: []const u8) u32 {
    var hv: u32 = 0x811c9dc5;
    for (bytes) |b| {
        hv ^= b;
        hv *%= 0x01000193;
    }
    return hv;
}

fn runTo(ticks: u32) void {
    const inputs = [_]u8{0} ** sim.MAX_CARS;
    while (test_race.tick < ticks and test_race.phase != sim.PHASE_FINISHED) sim.tick(&test_race, &inputs);
}

test "same state gives the same frame, and drawing never changes the state" {
    sim.init(&test_race, 42, track.MODE_CIRCUIT, 1, 2, 0, 7);
    runTo(900);
    const n = 320 * 180 * 4;
    const before = sim.hash(&test_race);
    draw(test_fb[0..n], 320, 180, &test_race, 0);
    const a = fnv1a(test_fb[0..n]);
    @memset(test_fb[0..n], 0);
    draw(test_fb[0..n], 320, 180, &test_race, 0);
    try std.testing.expectEqual(a, fnv1a(test_fb[0..n]));
    try std.testing.expectEqual(before, sim.hash(&test_race));
    draw(test_fb[0..n], 320, 180, &test_race, 3);
    try std.testing.expect(a != fnv1a(test_fb[0..n]));
}

test "frames stay inside the buffer for every mode, track and many sizes" {
    const sizes = [_][2]u32{ .{ 320, 180 }, .{ 640, 360 }, .{ 8, 8 }, .{ 17, 9 }, .{ 639, 359 }, .{ 160, 90 }, .{ 400, 120 }, .{ 100, 300 } };
    var mode: u8 = 0;
    while (mode <= track.MODE_DRAG) : (mode += 1) {
        var tid: u8 = 0;
        while (tid < track.TRACK_COUNT) : (tid += 1) {
            sim.init(&test_race, 1000 + @as(u64, tid), mode, tid, 2, 1, 7);
            runTo(120 + @as(u32, tid) * 260 + @as(u32, mode) * 90);
            var j: usize = 0;
            while (j < 2) : (j += 1) {
                const sz = if (j == 0) sizes[0] else sizes[(@as(usize, mode) * 8 + tid) % sizes.len];
                const n: usize = sz[0] * sz[1] * 4;
                @memset(&test_fb, 0xA5);
                draw(test_fb[0..n], sz[0], sz[1], &test_race, tid % test_race.car_count);
                for (test_fb[n..]) |b| try std.testing.expectEqual(@as(u8, 0xA5), b);
                var i: usize = 3;
                while (i < n) : (i += 4) try std.testing.expectEqual(@as(u8, 255), test_fb[i]);
            }
        }
    }
}

test "crashes, nitrous and perfect shifts draw inside the frame" {
    sim.init(&test_race, 9, track.MODE_CIRCUIT, 5, 2, 1, 7);
    runTo(1300);
    var i: usize = 0;
    while (i < test_race.car_count) : (i += 1) {
        test_race.cars[i].nitro_on = i % 2 == 0;
        test_race.cars[i].crashed_ticks = if (i % 3 == 0) 40 else 0;
        test_race.cars[i].shift_flash = 5;
    }
    const sizes = [_][2]u32{ .{ 320, 180 }, .{ 640, 360 } };
    for (sizes) |sz| {
        const n: usize = sz[0] * sz[1] * 4;
        @memset(&test_fb, 0xA5);
        draw(test_fb[0..n], sz[0], sz[1], &test_race, 0);
        for (test_fb[n..]) |b| try std.testing.expectEqual(@as(u8, 0xA5), b);
        test_race.tick += 4; // the other flicker phase
        draw(test_fb[0..n], sz[0], sz[1], &test_race, 0);
    }
}

test {
    _ = font;
}
