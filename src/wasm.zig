//! WASM exports (SPEC.md "WASM interface"). All state lives in static buffers.
const std = @import("std");
const sim = @import("sim.zig");
const track = @import("track.zig");
const lockstep = @import("lockstep.zig");
const render = @import("render.zig");

pub const FB_W: u32 = 640;
pub const FB_H: u32 = 360;

var race: sim.Race = undefined;
var ready: bool = false;
var inputs: [sim.MAX_CARS]u8 = [_]u8{0} ** sim.MAX_CARS;
var state: [sim.STATE_WORDS]i32 = [_]i32{0} ** sim.STATE_WORDS;
var fb: [FB_W * FB_H * 4]u8 = [_]u8{0} ** (FB_W * FB_H * 4);
var net: lockstep.Lockstep = undefined;
var net_buf: [lockstep.FRAME_BYTES]u8 = [_]u8{0} ** lockstep.FRAME_BYTES;

fn addr(p: *const anyopaque) u32 {
    return @truncate(@intFromPtr(p)); // wasm32 pointers are 32-bit
}

export fn mm_init(seed_lo: u32, seed_hi: u32, mode: u32, track_id: u32, laps: u32, humans: u32, bots: u32) void {
    const seed = (@as(u64, seed_hi) << 32) | seed_lo;
    sim.init(&race, seed, mode, track_id, laps, humans, bots);
    @memset(&inputs, 0);
    net.reset(race.humans);
    ready = true;
    sim.write_state(&race, &state);
}

export fn mm_input_ptr() u32 {
    return addr(&inputs);
}

export fn mm_tick() void {
    if (!ready) return;
    sim.tick(&race, &inputs);
    sim.write_state(&race, &state);
}

export fn mm_hash() u32 {
    if (!ready) return 0;
    return sim.hash(&race);
}

export fn mm_state_ptr() u32 {
    return addr(&state);
}

export fn mm_fuel(slot: u32, on: u32, paid_m: u32) void {
    if (!ready) return;
    sim.set_fuel(&race, slot, on != 0, paid_m);
    sim.write_state(&race, &state);
}

export fn mm_render(slot: u32, w: u32, h: u32) void {
    if (!ready) return;
    const cw = @min(w, FB_W);
    const ch = @min(h, FB_H);
    if (cw == 0 or ch == 0) return;
    const s: u8 = @intCast(@min(slot, race.car_count - 1));
    render.draw(fb[0 .. @as(usize, cw) * ch * 4], cw, ch, &race, s);
}

export fn mm_fb_ptr() u32 {
    return addr(&fb);
}

export fn mm_track_name_ptr() u32 {
    if (!ready) return addr(track.names[0].ptr);
    return addr(race.track.name.ptr);
}

export fn mm_net_reset() void {
    net.reset(if (ready) race.humans else 0);
}

export fn mm_net_buf_ptr() u32 {
    return addr(&net_buf);
}

export fn mm_net_push(n: u32) i32 {
    if (!ready) return lockstep.PUSH_OLD;
    return net.push(n, net_buf[0..net.frame_len()]);
}

export fn mm_net_pump(max_ticks: u32) u32 {
    if (!ready) return 0;
    const done = net.pump(&race, &inputs, max_ticks);
    sim.write_state(&race, &state);
    return done;
}

export fn mm_net_next() u32 {
    return net.next_needed();
}

test {
    _ = @import("dst.zig");
    _ = @import("render.zig");
}

test "wasm exports drive a race through the lockstep path" {
    mm_init(1, 0, 0, 0, 1, 1, 3);
    try std.testing.expectEqual(@as(u32, 0), mm_net_next());
    var n: u32 = 0;
    while (n < 100) : (n += 1) {
        @memset(&net_buf, sim.IN_THROTTLE);
        try std.testing.expectEqual(lockstep.PUSH_STORED, mm_net_push(n));
        try std.testing.expectEqual(@as(u32, 3), mm_net_pump(3));
    }
    try std.testing.expectEqual(@as(i32, 300), state[1]);
    try std.testing.expectEqual(sim.PHASE_RACING, @as(u8, @intCast(state[0])));
    try std.testing.expect(state[sim.STATE_HEADER_WORDS + 3] > 0); // car 0 moving
    mm_render(0, 320, 180);
    const name: [*:0]const u8 = @ptrFromInt(@intFromPtr(race.track.name.ptr));
    try std.testing.expectEqualStrings("Harbor Loop", std.mem.span(name));
}
