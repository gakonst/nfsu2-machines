const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // zig build wasm: the game for browsers and the Worker.
    const wasm_exe = b.addExecutable(.{
        .name = "machines",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/wasm.zig"),
            .target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding }),
            .optimize = .ReleaseSmall,
        }),
    });
    wasm_exe.entry = .disabled;
    wasm_exe.rdynamic = true;
    const install_wasm = b.addInstallArtifact(wasm_exe, .{});
    const copy_wasm = b.addUpdateSourceFiles();
    copy_wasm.addCopyFileToSource(wasm_exe.getEmittedBin(), "web/machines.wasm");
    const wasm_step = b.step("wasm", "Build zig-out/bin/machines.wasm and web/machines.wasm");
    wasm_step.dependOn(&install_wasm.step);
    wasm_step.dependOn(&copy_wasm.step);
    b.getInstallStep().dependOn(wasm_step);

    // zig build test: every unit test (wasm.zig imports the rest, dst.zig included).
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/wasm.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);

    // zig build dst [-- --seed N --seeds K]: deterministic simulation testing. ReleaseSafe keeps asserts.
    const dst_exe = b.addExecutable(.{
        .name = "dst",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/dst.zig"),
            .target = target,
            .optimize = if (optimize == .Debug) .ReleaseSafe else optimize,
        }),
    });
    const run_dst = b.addRunArtifact(dst_exe);
    if (b.args) |args| run_dst.addArgs(args);
    const dst_step = b.step("dst", "Run the deterministic simulator");
    dst_step.dependOn(&run_dst.step);

    // zig build frames [-- track mode w h seed] (alias: preview): the renderer's native frame dump (src/render_png.zig).
    const preview_exe = b.addExecutable(.{
        .name = "render_png",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/render_png.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    const run_preview = b.addRunArtifact(preview_exe);
    if (b.args) |args| run_preview.addArgs(args);
    b.step("frames", "Render preview frames to /tmp/mm-frames [-- track mode w h seed]").dependOn(&run_preview.step);
    b.step("preview", "Same as frames").dependOn(&run_preview.step);
}
