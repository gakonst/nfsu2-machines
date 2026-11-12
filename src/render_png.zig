//! Native preview tool: runs a bots-only race and writes chase-cam frames as PPM files to /tmp/mm-frames.
//! Usage: render_png [track 0..7] [mode 0..2] [width] [height] [seed]
//! Build: ./zig/zig build-exe -OReleaseFast src/render_png.zig (or the build step in docs/RENDER.md).
const std = @import("std");
const sim = @import("sim.zig");
const render = @import("render.zig");
const track = @import("track.zig");

const OUT_DIR = "/tmp/mm-frames";
const CAPTURE_TICKS = [_]u32{ 30, 175, 240, 420, 900, 1500, 2400, 3600, 5000, 7000 };

var race: sim.Race = undefined;
var fb: [render.MAX_W * render.MAX_H * 4]u8 = undefined;
var out: [64 + render.MAX_W * render.MAX_H * 3]u8 = undefined;

fn arg(args: []const [:0]const u8, i: usize, default: u32) u32 {
    if (i >= args.len) return default;
    return std.fmt.parseInt(u32, args[i], 10) catch default;
}

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    const track_id = arg(args, 1, 0);
    const mode = arg(args, 2, 0);
    const w = std.math.clamp(arg(args, 3, 320), 8, render.MAX_W);
    const h = std.math.clamp(arg(args, 4, 180), 8, render.MAX_H);
    const seed = arg(args, 5, 7);
    const want = arg(args, 6, 255); // optional: capture only where this scenery is just ahead
    const repeat = std.math.clamp(arg(args, 7, 1), 1, 1000); // draws per frame, for timing

    try std.Io.Dir.cwd().createDirPath(io, OUT_DIR);
    sim.init(&race, seed, mode, track_id, 3, 0, 7);
    const inputs = [_]u8{0} ** sim.MAX_CARS;
    var total_ns: i96 = 0;
    var frames: u32 = 0;
    for (CAPTURE_TICKS, 0..) |target_in, ci| {
        var target = target_in;
        if (want != 255) {
            // Run until the scenery 25 m ahead of car 0 is the wanted kind, then a few frames apart.
            var guard: u32 = 0;
            if (ci > 0) target = race.tick + 25;
            while (guard < 40000 and race.phase != sim.PHASE_FINISHED) : (guard += 1) {
                const seg = race.track.segments[track.segment_index(&race.track, race.cars[0].progress_mm + 25_000)];
                if (race.tick >= target and @intFromEnum(seg.scenery) == want) break;
                sim.tick(&race, &inputs);
            }
            if (ci >= 4) break;
        }
        while (race.tick < target and race.phase != sim.PHASE_FINISHED) sim.tick(&race, &inputs);
        const frame = fb[0 .. w * h * 4];
        const t0 = std.Io.Clock.awake.now(io);
        var rep_i: u32 = 0;
        while (rep_i < repeat) : (rep_i += 1) render.draw(frame, w, h, &race, 0);
        const t1 = std.Io.Clock.awake.now(io);
        total_ns += @divTrunc(t0.durationTo(t1).toNanoseconds(), repeat);
        frames += 1;

        const head = try std.fmt.bufPrint(&out, "P6\n{d} {d}\n255\n", .{ w, h });
        var n: usize = head.len;
        var i: usize = 0;
        while (i < w * h) : (i += 1) {
            out[n] = frame[i * 4];
            out[n + 1] = frame[i * 4 + 1];
            out[n + 2] = frame[i * 4 + 2];
            n += 3;
        }
        var name_buf: [128]u8 = undefined;
        const name = try std.fmt.bufPrint(&name_buf, OUT_DIR ++ "/t{d}_m{d}_{d}x{d}_{d:0>5}.ppm", .{ track_id, mode, w, h, race.tick });
        try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = name, .data = out[0..n] });
        std.debug.print("{s} phase={d} speed={d}\n", .{ name, race.phase, race.cars[0].speed });
        if (race.phase == sim.PHASE_FINISHED) break;
    }
    std.debug.print("avg draw {d} us over {d} frames\n", .{ @divTrunc(total_ns, @as(i96, frames) * 1000), frames });
}
