# Renderer (owner C)

src/render.zig draws one car's chase view of the race into an RGBA frame buffer, in software, every pixel in code.
It only reads 'sim.Race'; it may use floats and never writes simulation state (a unit test checks 'sim.hash' is
unchanged by a draw). All scratch memory is static (projected segments, light list, one row buffer); every loop is
bounded by the frame size or a constant.

    render.draw(fb: []u8, w: u32, h: u32, race: *const sim.Race, slot: u8) void   // w <= 640, h <= 360
    render.text(fb, w, h, x, y, "24H", 0xRRGGBBAA)                                // 5x7 bitmap font (src/font.zig)
    render.textScaled(fb, w, h, x, y, str, rgba, scale)

Files: src/render.zig (everything drawn), src/font.zig (5x7 font, 'glyph', 'measure', 'text'), src/palette.zig (car
colours 0..7, the same hex values as the web HUD), src/render_png.zig (native preview tool).

## How a frame is built

1. Sky: per-track gradient (8 palettes by track id) with a sodium/neon haze at the horizon, 150 stars and a moon
   (none on Foundry Row) placed on a 360-degree panorama that scrolls with the track's accumulated bend.
2. Skyline: three parallax layers of silhouettes, building heights and lit windows hashed from (track id, layer,
   cell), so they are stable frame to frame; antennas with blinking red lights.
3. Projection: classic segment projection. 200 segments (1 km) ahead of a camera 8.2 m behind and 2.5 m above the
   car, 84 degree horizontal field of view, following 80% of the car's lateral offset. 'curve' (per-mille of a
   segment) accumulates into the road's lateral shift, 'hill' (mm) into height. Nearer road clips farther rows
   (hill crests).
4. Road, row by row with perspective-correct depth: asphalt grain near the camera, lane lines from 'track.lanes'
   (solid in drag), edge lines, red/white kerbs, sidewalk / quay / water / gravel by scenery. Lighting per pixel:
   ambient, street-lamp pools, every car's headlight cone and underglow. Wet look: sky sheen growing with distance,
   and a vertical reflection streak under every visible light (lamps, tunnel lights, neon signs, tail lights).
   Water mirrors the skyline with a ripple. Exponential depth fog to the horizon colour. Checkered finish line at
   'race.finish_mm', a start line at 'sim.START_MM' on open tracks.
5. World, far to near per segment: walls drawn column by column with textures in world units (downtown facades
   with windows and shop fronts, neon shop rows with tubes, harbour container stacks, tunnel tiles with a ceiling
   and light strips, bridge railings, industrial fences), tunnel portals, harbour cranes, bridge pylons with
   cables and lights, smoke stacks with drifting smoke, sodium/mercury/neon lamp posts with light cones and halos,
   neon signs with made-up words (NITE, 24H, DINER, ARCADE, MOTEL, ...), the FINISH gantry, the drag start tree;
   cars sorted back to front in between.
6. Cars: 3D-ish boxes projected along the road (they follow curves and hills): shadow, underglow in the car's
   colour, visible side with neon skirt and wheels, roof, rear window, deck, rear face with plate and exhausts,
   four tail-light styles and spoilers (by slot). Brake lights brighten on the brake input ('input_prev & BRAKE',
   and during the countdown). Nitrous: flickering blue flame cones. Perfect shift: an exhaust flash. Crashed cars
   flicker and throw sparks.
7. Effects: camera shake (speed, nitrous, crashes; from the tick, deterministic), speed lines from 45% of top speed
   (more and blue with nitrous), vignette tinted blue on nitrous, and in drag mode a large start tree at the top
   during the countdown (stage, three ambers on 'countdown_left' 135/90/45, green for 1.5 s). No HUD text: the web
   client draws the HUD.

## Speed

wasm32 ReleaseSmall in node 24: about 2.3 to 2.7 ms per 320x180 frame and 9 to 10 ms at 640x360 (bots race, 8
cars). Native ReleaseFast: about 1.2 to 1.6 ms at 320x180.

## Tests

In src/render.zig: the same state gives the same frame hash and drawing leaves 'sim.hash' unchanged; every mode
and track at 8 sizes (320x180, 640x360, 8x8, 17x9, 639x359, 160x90, 400x120, 100x300) writes nothing past w*h*4
and fills every alpha byte; crashed / nitrous / perfect-shift cars draw in bounds. Run with
'./zig/zig test src/render.zig' (and under 'zig build test' once wasm.zig's test block imports render.zig).

## Preview frames

    ./zig/zig build-exe -OReleaseFast src/render_png.zig -femit-bin=/tmp/render_png
    /tmp/render_png [track 0..7] [mode 0..2] [w] [h] [seed] [scenery 0..5] [repeat]

runs a bots-only race and writes PPM frames to /tmp/mm-frames (countdown, start, then through the race), printing
the average draw time. 'scenery' waits until that scenery kind (0 downtown .. 5 industrial) is 25 m ahead;
'repeat' draws each frame N times for timing. Suggested build step (build.zig is owner A's):

    const frames_exe = b.addExecutable(.{ .name = "render_png", .root_module = b.createModule(.{
        .root_source_file = b.path("src/render_png.zig"), .target = target, .optimize = .ReleaseFast }) });
    const run_frames = b.addRunArtifact(frames_exe);
    if (b.args) |args| run_frames.addArgs(args);
    b.step("frames", "Render preview frames to /tmp/mm-frames").dependOn(&run_frames.step);
