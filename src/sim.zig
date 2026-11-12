//! Deterministic race simulation. Integer and fixed point only: no floats, no clock, and no
//! randomness except prng.zig seeded from the race seed. Units: mm, mm per tick, ticks (60 Hz).
const std = @import("std");
const assert = std.debug.assert;
const track = @import("track.zig");
const prng = @import("prng.zig");

pub const MAX_CARS = 8;
pub const MAX_HUMANS = 4;
pub const MAX_LAPS = 9;
pub const TICK_HZ = 60;
pub const COUNTDOWN_TICKS: u16 = 3 * TICK_HZ;
pub const FINISH_GRACE_TICKS: u32 = 5 * 60 * TICK_HZ;
pub const CRASH_TICKS: u16 = 90; // 1.5 s
/// The start line, after the flat grid segments.
pub const START_MM: i64 = @as(i64, track.START_SEGMENTS) * track.SEGMENT_MM;

pub const IN_THROTTLE: u8 = 1;
pub const IN_BRAKE: u8 = 2;
pub const IN_LEFT: u8 = 4;
pub const IN_RIGHT: u8 = 8;
pub const IN_NITRO: u8 = 16;
pub const IN_SHIFT_UP: u8 = 32;
pub const IN_SHIFT_DOWN: u8 = 64;

pub const PHASE_COUNTDOWN: u8 = 0;
pub const PHASE_RACING: u8 = 1;
pub const PHASE_FINISHED: u8 = 2;

pub const SHIFT_NONE: u8 = 0;
pub const SHIFT_PERFECT: u8 = 1;
pub const SHIFT_GOOD: u8 = 2;
pub const SHIFT_EARLY: u8 = 3;
pub const SHIFT_LATE: u8 = 4;

// Engine. The shift light comes on at RPM_SHIFT_LIGHT, the start of the perfect window.
pub const RPM_IDLE: i32 = 900;
pub const RPM_SHIFT_LIGHT: i32 = 6800;
pub const RPM_PERFECT_HI: i32 = 7300;
pub const RPM_GOOD_LO: i32 = 6200;
pub const RPM_GOOD_HI: i32 = 7700;
pub const RPM_REDLINE: i32 = 7500;
pub const RPM_LIMIT: i32 = 8000;
pub const GEARS: u8 = 6;
/// Road speed (mm/tick) at RPM_REDLINE in gears 1..6: 60, 95, 135, 175, 215, 255 km/h.
pub const gear_top = [GEARS + 1]i32{ 0, 278, 440, 625, 810, 995, 1181 };
/// Torque in per-mille of peak at 0, 1000, ... 9000 rpm: builds to a peak at 6000, falls past redline.
const torque_curve = [10]i32{ 300, 450, 600, 750, 880, 970, 1000, 930, 780, 600 };

pub const MAX_SPEED: i32 = 1500; // mm/tick, about 324 km/h; a hard bound
pub const FUEL_SPEED: i32 = 92; // 20 km/h in mm/tick
const Q8: i32 = 256; // speed_q8 is mm/tick * 256
const DRIVE_K: i64 = 165_000; // wheel force scale: accel_q8 = torque_pm * DRIVE_K * power_pm / (gear_top * 1e6)
const DRAG_DIV: i32 = 10_500; // aero drag_q8 = v * v / DRAG_DIV
const ROLLING_Q8: i32 = 6;
const ENGINE_BRAKE_Q8: i32 = 24;
const BRAKE_Q8: i32 = 700; // about 1 g
const NITRO_Q8: i32 = 110;
const BOOST_Q8: i32 = 90; // perfect shift
const BOOST_TICKS: u8 = 40;
const CENTRIFUGAL_DIV: i64 = 460_000; // outward drift per tick = curve * v * v / CENTRIFUGAL_DIV
const STEER_RATE: i32 = 14; // lateral velocity change per tick
const STEER_CAP: i32 = 140;
pub const BARRIER_MM: i32 = 11_000;
pub const CAR_LENGTH_MM: i32 = 4500;
pub const CAR_WIDTH_MM: i32 = 2000;
const CRASH_SPEED: i32 = 700; // barrier hit above ~151 km/h with real side speed
const CRASH_SIDE: i32 = 50;
const CRASH_CLOSING: i32 = 330; // rear-ending at ~71 km/h closing speed
const CRUISE_SPEED: i32 = 650; // finished cars' autopilot

pub const STATE_HEADER_WORDS = 8;
pub const STATE_CAR_WORDS = 16;
pub const STATE_WORDS = STATE_HEADER_WORDS + MAX_CARS * STATE_CAR_WORDS;

pub const Car = struct {
    progress_mm: i64, // along the track including the grid lead-in and all laps; never decreases
    lateral_mm: i32, // 0 = centre, > 0 right
    speed: i32, // mm per tick (speed_q8 >> 8)
    rpm: i32,
    gear: u8,
    nitro: i32, // 0..1000
    nitro_on: bool,
    colour: u8,
    crashed_ticks: u16,
    finished_tick: u32, // absolute tick (same base as Race.tick), 0 = racing
    human: bool,
    fuel_limited: bool,

    speed_q8: i32,
    lat_vel: i32,
    lap: u8, // 1-based
    place: u8, // 1-based
    lap_start_tick: u32,
    best_lap_ticks: u32,
    distance_mm: i64, // driven, for Tempo fuel
    fuel_on: bool,
    paid_m: u32,
    input_prev: u8,
    shift_ticks: u8, // no drive while the clutch is out
    boost_ticks: u8,
    shift_flash: u8, // ticks left of the "perfect shift just now" flag
    last_shift: u8,
    skill: u16, // bots: 550..1000
    power: u16, // per-mille engine power
    start_delay: u8, // bots: reaction ticks at the green light
    bot_lane: i32,
};

pub const Race = struct {
    track: track.Track,
    cars: [MAX_CARS]Car,
    car_count: u8,
    phase: u8,
    tick: u32,
    mode: u8,
    laps: u8,
    humans: u8,
    countdown_left: u16,
    first_finish_tick: u32,
    seed: u64,
    lap_mm: i64, // circuit: one lap; open tracks: the race distance
    finish_mm: i64, // progress_mm at the finish line
};

/// Starts a race. Arguments are clamped: humans 0..4 (0 = bots only), cars 1..8, drag at most 4 cars,
/// laps 1..9 for circuit (1 otherwise).
pub fn init(race: *Race, seed: u64, mode_in: u32, track_in: u32, laps_in: u32, humans_in: u32, bots_in: u32) void {
    const mode: u8 = @intCast(@min(mode_in, track.MODE_DRAG));
    const track_id: u8 = @intCast(@min(track_in, track.TRACK_COUNT - 1));
    const humans: u8 = @intCast(@min(humans_in, MAX_HUMANS));
    var bots: u8 = @intCast(@min(bots_in, MAX_CARS - humans));
    if (humans + bots == 0) bots = 1;
    var count: u8 = humans + bots;
    if (mode == track.MODE_DRAG) count = @min(count, 4);
    assert(count >= 1 and count <= MAX_CARS);

    track.build(&race.track, track_id, seed, mode);
    if (mode == track.MODE_DRAG) race.track.lanes = @max(2, count);
    race.car_count = count;
    race.phase = PHASE_COUNTDOWN;
    race.tick = 0;
    race.mode = mode;
    race.laps = if (mode == track.MODE_CIRCUIT) @intCast(std.math.clamp(laps_in, 1, MAX_LAPS)) else 1;
    race.humans = @min(humans, count);
    race.countdown_left = COUNTDOWN_TICKS;
    race.first_finish_tick = 0;
    race.seed = seed;
    race.lap_mm = switch (mode) {
        track.MODE_CIRCUIT => track.length_mm(&race.track),
        track.MODE_SPRINT => @as(i64, race.track.count - track.START_SEGMENTS - track.RUNOFF_SEGMENTS) * track.SEGMENT_MM,
        else => track.DRAG_MM,
    };
    race.finish_mm = START_MM + race.lap_mm * race.laps;

    var rng = prng.Prng.init(seed ^ 0xB075_5EED);
    for (&race.cars, 0..) |*car, i| {
        car.* = std.mem.zeroes(Car);
        if (i >= count) continue;
        const slot: u8 = @intCast(i);
        car.human = slot < race.humans;
        car.colour = slot;
        car.gear = 1;
        car.rpm = RPM_IDLE;
        car.nitro = 1000;
        car.lap = 1;
        car.place = slot + 1;
        if (mode == track.MODE_DRAG) {
            const lane_w: i32 = @divTrunc(2 * track.ROAD_HALF_WIDTH_MM, race.track.lanes);
            car.lateral_mm = -track.ROAD_HALF_WIDTH_MM + lane_w * @as(i32, slot) + @divTrunc(lane_w, 2);
            car.progress_mm = START_MM - 2500;
        } else {
            const row: i64 = slot / 2;
            const col: i64 = slot % 2;
            car.lateral_mm = if (col == 0) -2000 else 2000;
            car.progress_mm = START_MM - 3000 - row * 8000 - col * 3000;
        }
        car.bot_lane = ([4]i32{ -4500, 1500, -1500, 4500 })[slot % 4];
        if (car.human) {
            car.skill = 1000;
            car.power = 1000;
        } else {
            car.skill = @intCast(550 + rng.below(451));
            car.power = 960 + car.skill / 25;
            car.start_delay = @intCast(2 + (1000 - car.skill) / 40);
        }
        assert(car.progress_mm >= 0);
    }
}

/// Tempo fuel: when on, a car that has driven paid_m metres is limited to 20 km/h.
pub fn set_fuel(race: *Race, slot: u32, on: bool, paid_m: u32) void {
    if (slot >= race.car_count) return;
    race.cars[slot].fuel_on = on;
    race.cars[slot].paid_m = paid_m;
}

/// One 1/60 s tick. inputs holds one byte per slot; bots and finished cars ignore theirs.
pub fn tick(race: *Race, inputs: *const [MAX_CARS]u8) void {
    assert(race.car_count >= 1 and race.car_count <= MAX_CARS);
    race.tick += 1;
    if (race.phase == PHASE_COUNTDOWN) {
        countdown(race, inputs);
        return;
    }
    var i: u8 = 0;
    while (i < race.car_count) : (i += 1) {
        const car = &race.cars[i];
        const auto = !car.human or car.finished_tick != 0;
        const b: u8 = if (auto) bot_input(race, i) else inputs[i];
        step_car(race, i, b);
    }
    collide(race);
    i = 0;
    while (i < race.car_count) : (i += 1) update_lap(race, i);
    update_places(race);
    check_end(race);
}

fn countdown(race: *Race, inputs: *const [MAX_CARS]u8) void {
    assert(race.countdown_left > 0);
    var i: u8 = 0;
    while (i < race.car_count) : (i += 1) {
        const car = &race.cars[i];
        // Bots blip the throttle in the last second; humans rev freely. Nothing moves yet.
        const b: u8 = if (car.human) inputs[i] else if (race.countdown_left < 60) IN_THROTTLE else 0;
        car.rpm = if (b & IN_THROTTLE != 0) @min(car.rpm + 180, RPM_LIMIT - 200) else @max(car.rpm - 150, RPM_IDLE);
        car.input_prev = b;
    }
    race.countdown_left -= 1;
    if (race.countdown_left == 0) {
        race.phase = PHASE_RACING;
        i = 0;
        while (i < race.car_count) : (i += 1) race.cars[i].lap_start_tick = race.tick;
    }
}

fn torque(rpm: i32) i32 {
    assert(rpm >= 0);
    const r = @min(rpm, 8999);
    const k: usize = @intCast(@divTrunc(r, 1000));
    const f = @mod(r, 1000);
    return torque_curve[k] + @divTrunc((torque_curve[k + 1] - torque_curve[k]) * f, 1000);
}

fn wheel_rpm(speed: i32, gear: u8) i32 {
    assert(gear >= 1 and gear <= GEARS);
    return @divTrunc(speed * RPM_REDLINE, gear_top[gear]);
}

pub fn shift_quality(rpm: i32) u8 {
    if (rpm >= RPM_SHIFT_LIGHT and rpm <= RPM_PERFECT_HI) return SHIFT_PERFECT;
    if (rpm >= RPM_GOOD_LO and rpm <= RPM_GOOD_HI) return SHIFT_GOOD;
    if (rpm < RPM_GOOD_LO) return SHIFT_EARLY;
    return SHIFT_LATE;
}

fn crash(car: *Car) void {
    car.crashed_ticks = CRASH_TICKS;
    car.speed_q8 = 0;
    car.speed = 0;
    car.lat_vel = 0;
    car.nitro_on = false;
    car.boost_ticks = 0;
    car.shift_ticks = 0;
}

fn step_car(race: *Race, i: u8, b: u8) void {
    const car = &race.cars[i];
    const drag_mode = race.mode == track.MODE_DRAG;
    const pressed = b & ~car.input_prev;
    car.input_prev = b;
    if (car.shift_flash > 0) car.shift_flash -= 1;

    if (car.crashed_ticks > 0) {
        car.crashed_ticks -= 1;
        car.speed_q8 = 0;
        car.speed = 0;
        car.rpm = RPM_IDLE;
        if (car.crashed_ticks == 0) {
            // Back on the road, inside the edge, in first gear.
            car.lateral_mm = std.math.clamp(car.lateral_mm, -6000, 6000);
            car.gear = 1;
        }
        return;
    }

    // Gears: manual shifts are graded by rpm; circuit and sprint also shift automatically.
    if (pressed & IN_SHIFT_UP != 0 and car.gear < GEARS) {
        const q = shift_quality(car.rpm);
        car.last_shift = q;
        car.shift_ticks = switch (q) {
            SHIFT_PERFECT => 3,
            SHIFT_GOOD => 7,
            else => 14,
        };
        if (q == SHIFT_PERFECT) {
            car.boost_ticks = BOOST_TICKS;
            car.shift_flash = BOOST_TICKS;
        }
        car.gear += 1;
    } else if (pressed & IN_SHIFT_DOWN != 0 and car.gear > 1) {
        car.gear -= 1;
        car.shift_ticks = 6;
    }
    const v0: i32 = car.speed_q8 >> 8;
    if (!drag_mode and car.shift_ticks == 0) {
        if (car.gear < GEARS and wheel_rpm(v0, car.gear) >= 7200) {
            car.gear += 1;
            car.shift_ticks = 8;
        } else if (car.gear > 1 and wheel_rpm(v0, car.gear) < 3600 and wheel_rpm(v0, car.gear - 1) < 6800) {
            car.gear -= 1;
            car.shift_ticks = 4;
        }
    }

    const throttle = b & IN_THROTTLE != 0;
    const wheel = wheel_rpm(v0, car.gear);
    var rpm = wheel;
    if (car.gear == 1 and throttle) rpm = @max(rpm, 3200); // clutch slip at launch
    rpm = std.math.clamp(rpm, RPM_IDLE, RPM_LIMIT);
    car.rpm = rpm;
    const limiter = wheel >= RPM_LIMIT;

    var accel: i32 = 0;
    if (throttle and !limiter and car.shift_ticks == 0) {
        const t: i64 = torque(rpm);
        accel += @intCast(@divTrunc(t * DRIVE_K * car.power, @as(i64, gear_top[car.gear]) * 1_000_000));
    } else if (!throttle) {
        accel -= ENGINE_BRAKE_Q8;
    }
    if (car.shift_ticks > 0) car.shift_ticks -= 1;

    car.nitro_on = b & IN_NITRO != 0 and throttle and car.nitro > 0;
    if (car.nitro_on) {
        accel += NITRO_Q8;
        car.nitro = @max(0, car.nitro - @as(i32, if (drag_mode) 6 else 4));
    } else if (!drag_mode and race.tick % 3 == 0) {
        car.nitro = @min(1000, car.nitro + 1); // slow refill; drag has one bottle
    }
    if (car.boost_ticks > 0) {
        accel += BOOST_Q8;
        car.boost_ticks -= 1;
    }
    if (v0 > 0) accel -= @divTrunc(v0 * v0, DRAG_DIV) + ROLLING_Q8;
    if (b & IN_BRAKE != 0) accel -= BRAKE_Q8;
    const off_road = @abs(car.lateral_mm) > track.ROAD_HALF_WIDTH_MM;
    if (off_road) accel -= @divTrunc(car.speed_q8, 96) + 8;

    car.speed_q8 = std.math.clamp(car.speed_q8 + accel, 0, MAX_SPEED * Q8);
    const distance_m: i64 = @divTrunc(car.distance_mm, 1000);
    car.fuel_limited = car.fuel_on and distance_m >= car.paid_m;
    if (car.fuel_limited and car.speed_q8 > FUEL_SPEED * Q8) {
        car.speed_q8 = @max(FUEL_SPEED * Q8, car.speed_q8 - 2 * BRAKE_Q8);
    }
    const v: i32 = car.speed_q8 >> 8;
    car.speed = v;

    if (!drag_mode) {
        const steer_max: i32 = @min(@min(v, 30 + @divTrunc(v, 12)), STEER_CAP);
        const left = b & IN_LEFT != 0;
        const right = b & IN_RIGHT != 0;
        const dir: i32 = if (right and !left) 1 else if (left and !right) -1 else 0;
        const target = dir * steer_max;
        if (car.lat_vel < target) car.lat_vel = @min(target, car.lat_vel + STEER_RATE);
        if (car.lat_vel > target) car.lat_vel = @max(target, car.lat_vel - STEER_RATE);
        const side = car.lat_vel + drift(race, car.progress_mm, v);
        const next = car.lateral_mm + side;
        if (@abs(next) > BARRIER_MM) {
            if (v > CRASH_SPEED and @abs(side) > CRASH_SIDE) {
                crash(car);
            } else {
                car.speed_q8 -= @divTrunc(car.speed_q8, 24); // scrape along the wall
                car.speed = car.speed_q8 >> 8;
                car.lat_vel = 0;
            }
            car.lateral_mm = std.math.clamp(next, -BARRIER_MM, BARRIER_MM);
        } else {
            car.lateral_mm = next;
        }
    }

    car.progress_mm += car.speed;
    car.distance_mm += car.speed;
    assert(car.speed >= 0 and car.speed <= MAX_SPEED);
}

/// Outward (centrifugal) lateral drift per tick at a track position and speed.
pub fn drift(race: *const Race, pos_mm: i64, v: i32) i32 {
    const c: i64 = race.track.segments[track.segment_index(&race.track, pos_mm)].curve;
    const vv: i64 = @as(i64, v) * v;
    return @intCast(@divTrunc(-c * vv, CENTRIFUGAL_DIV));
}

fn ghost(car: *const Car) bool {
    return car.crashed_ticks > 0 or car.finished_tick != 0;
}

/// Signed distance from a to b along the track (shortest way round on a circuit).
pub fn delta_mm(race: *const Race, from: i64, to: i64) i64 {
    const d = to - from;
    if (!race.track.closed) return d;
    const half = @divTrunc(race.lap_mm, 2);
    return @mod(d + half, race.lap_mm) - half;
}

fn collide(race: *Race) void {
    if (race.mode == track.MODE_DRAG) return; // drag lanes never touch
    var i: u8 = 0;
    while (i < race.car_count) : (i += 1) {
        var j: u8 = i + 1;
        while (j < race.car_count) : (j += 1) {
            const a = &race.cars[i];
            const b = &race.cars[j];
            if (ghost(a) or ghost(b)) continue;
            const d = delta_mm(race, a.progress_mm, b.progress_mm);
            if (@abs(d) >= CAR_LENGTH_MM) continue;
            const dl = b.lateral_mm - a.lateral_mm;
            if (@abs(dl) >= CAR_WIDTH_MM) continue;
            const rear = if (d >= 0) a else b;
            const front = if (d >= 0) b else a;
            const closing = rear.speed - front.speed;
            if (closing > CRASH_CLOSING) {
                crash(rear);
                front.speed_q8 -= @divTrunc(front.speed_q8, 8);
                front.speed = front.speed_q8 >> 8;
                continue;
            }
            // Bump: push apart sideways, the rear car gives up speed to the front one.
            const s: i32 = if (dl > 0) 1 else if (dl < 0) -1 else if (j % 2 == 0) 1 else -1;
            const push: i32 = @divTrunc(CAR_WIDTH_MM - @as(i32, @intCast(@abs(dl))), 2) + 20;
            a.lateral_mm = std.math.clamp(a.lateral_mm - s * push, -BARRIER_MM, BARRIER_MM);
            b.lateral_mm = std.math.clamp(b.lateral_mm + s * push, -BARRIER_MM, BARRIER_MM);
            a.lat_vel = -s * 25;
            b.lat_vel = s * 25;
            if (closing > 0) {
                rear.speed_q8 = @max(0, rear.speed_q8 - closing * (Q8 / 2));
                if (!front.fuel_limited) front.speed_q8 = @min(MAX_SPEED * Q8, front.speed_q8 + closing * (Q8 / 4));
            }
            rear.speed_q8 -= @divTrunc(rear.speed_q8, 256);
            front.speed_q8 -= @divTrunc(front.speed_q8, 256);
            rear.speed = rear.speed_q8 >> 8;
            front.speed = front.speed_q8 >> 8;
        }
    }
}

fn update_lap(race: *Race, i: u8) void {
    const car = &race.cars[i];
    if (car.finished_tick != 0) return;
    if (race.phase != PHASE_RACING) return; // no results after the race ended
    if (car.progress_mm >= race.finish_mm) {
        car.finished_tick = race.tick;
        const lap_ticks = race.tick - car.lap_start_tick;
        if (car.best_lap_ticks == 0 or lap_ticks < car.best_lap_ticks) car.best_lap_ticks = lap_ticks;
        car.lap = race.laps;
        if (race.first_finish_tick == 0) race.first_finish_tick = race.tick;
        return;
    }
    if (!race.track.closed or car.progress_mm < START_MM) return;
    const completed: i64 = @divTrunc(car.progress_mm - START_MM, race.lap_mm);
    const lap: u8 = @intCast(@min(completed + 1, race.laps));
    if (lap > car.lap) {
        const lap_ticks = race.tick - car.lap_start_tick;
        if (car.best_lap_ticks == 0 or lap_ticks < car.best_lap_ticks) car.best_lap_ticks = lap_ticks;
        car.lap_start_tick = race.tick;
        car.lap = lap;
    }
}

fn ahead(race: *const Race, a: u8, b: u8) bool {
    const ca = &race.cars[a];
    const cb = &race.cars[b];
    const fa = ca.finished_tick != 0;
    const fb = cb.finished_tick != 0;
    if (fa != fb) return fa;
    if (fa and ca.finished_tick != cb.finished_tick) return ca.finished_tick < cb.finished_tick;
    if (ca.progress_mm != cb.progress_mm) return ca.progress_mm > cb.progress_mm;
    return a < b;
}

fn update_places(race: *Race) void {
    var order: [MAX_CARS]u8 = undefined;
    const n = race.car_count;
    var i: u8 = 0;
    while (i < n) : (i += 1) {
        // Insertion sort, at most 8 cars.
        var k: u8 = i;
        while (k > 0 and ahead(race, i, order[k - 1])) : (k -= 1) order[k] = order[k - 1];
        order[k] = i;
    }
    i = 0;
    while (i < n) : (i += 1) race.cars[order[i]].place = i + 1;
}

fn check_end(race: *Race) void {
    if (race.phase != PHASE_RACING) return;
    var all = true;
    var i: u8 = 0;
    while (i < race.car_count) : (i += 1) {
        const car = &race.cars[i];
        const counts = race.humans == 0 or car.human;
        if (counts and car.finished_tick == 0) all = false;
    }
    const timed_out = race.first_finish_tick != 0 and race.tick - race.first_finish_tick >= FINISH_GRACE_TICKS;
    if (all or timed_out) race.phase = PHASE_FINISHED;
}

/// Highest speed at which a bot can hold a curve, using grip_pm of its steering authority.
fn safe_speed(curve_abs: i64, grip_pm: i64) i32 {
    assert(curve_abs > 0);
    const steer_ref: i64 = 105; // steer_max near 200 km/h
    const x: u64 = @intCast(@divTrunc(grip_pm * steer_ref * CENTRIFUGAL_DIV, 1000 * curve_abs));
    return @intCast(std.math.sqrt(x));
}

fn noise(race: *const Race, i: u8, salt: u64) u64 {
    return prng.mix(race.seed ^ (@as(u64, i) << 56) ^ (salt *% 0x9E37_79B9_7F4A_7C15));
}

/// The bots' (and finished cars') driver. Pure: reads state, returns an input byte.
pub fn bot_input(race: *const Race, i: u8) u8 {
    const car = &race.cars[i];
    if (race.phase == PHASE_COUNTDOWN or car.crashed_ticks > 0) return 0;
    const since_go: u32 = race.tick -| COUNTDOWN_TICKS;
    if (car.finished_tick == 0 and since_go <= car.start_delay) return 0;
    if (race.mode == track.MODE_DRAG) return bot_drag(race, i);

    const v = car.speed;
    const skill: i64 = car.skill;
    const grip_pm: i64 = 600 + @divTrunc(skill * 3, 10);
    const decel_milli: i64 = 1900 + @divTrunc(skill * 7, 10);
    const pos = car.progress_mm;
    const offset: i64 = @mod(pos, track.SEGMENT_MM);
    var brake = false;
    var coast = false;
    var straight = true;
    var k: i64 = 0;
    while (k < 24) : (k += 1) {
        const seg = race.track.segments[track.segment_index(&race.track, pos + k * track.SEGMENT_MM)];
        const c: i64 = @abs(seg.curve);
        if (k < 14 and c >= 12) straight = false;
        if (c < 8) continue;
        const vs = safe_speed(c, grip_pm);
        if (v <= vs) continue;
        const d: i64 = @max(0, k * track.SEGMENT_MM - offset);
        if (k == 0) {
            if (v > vs + 40) brake = true else coast = true;
            continue;
        }
        const vv: i64 = @as(i64, v) * v - @as(i64, vs) * vs;
        if (vv * 1000 > 2 * decel_milli * d) brake = true;
    }
    var b: u8 = 0;
    if (brake) {
        b |= IN_BRAKE;
    } else if (!coast and !(car.finished_tick != 0 and v > CRUISE_SPEED)) {
        b |= IN_THROTTLE;
    }
    const nitro_floor: i32 = if (car.skill > 800) 150 else 400;
    if (b == IN_THROTTLE and straight and v > 450 and car.nitro > nitro_floor and car.finished_tick == 0) {
        b |= IN_NITRO;
    }

    // Line: the inside of the next bend, else a lane; go round slower cars ahead.
    const c_near: i32 = race.track.segments[track.segment_index(&race.track, pos + 3 * track.SEGMENT_MM)].curve;
    var target: i32 = car.bot_lane;
    if (@abs(c_near) >= 10) {
        const inside: i32 = @min(@as(i32, @intCast(@abs(c_near))) * 90, 5500);
        target = if (c_near > 0) inside else -inside;
    }
    var nearest: i64 = std.math.maxInt(i64);
    var j: u8 = 0;
    while (j < race.car_count) : (j += 1) {
        if (j == i) continue;
        const o = &race.cars[j];
        if (ghost(o)) continue;
        const d = delta_mm(race, pos, o.progress_mm);
        if (d > -CAR_LENGTH_MM - 1500 and d <= CAR_LENGTH_MM and @abs(o.lateral_mm - car.lateral_mm) < 3000) {
            // Alongside: hold our side of it, which wins over everything else.
            target = if (car.lateral_mm >= o.lateral_mm) o.lateral_mm + 3000 else o.lateral_mm - 3000;
            nearest = std.math.minInt(i64);
            continue;
        }
        const reach: i64 = 6000 + @as(i64, @max(0, v - o.speed)) * 30;
        if (d <= CAR_LENGTH_MM or d >= reach or d >= nearest) continue;
        if (@abs(o.lateral_mm - target) >= 2600) continue;
        nearest = d;
        target = if (o.lateral_mm > 0) o.lateral_mm - 3300 else o.lateral_mm + 3300;
    }
    target = std.math.clamp(target, -6500, 6500);
    const side = car.lat_vel + drift(race, pos, v);
    const predicted = car.lateral_mm + side * 10;
    const deadband: i32 = 250 + @divTrunc(1000 - @as(i32, car.skill), 2);
    if (predicted < target - deadband) b |= IN_RIGHT else if (predicted > target + deadband) b |= IN_LEFT;
    return b;
}

fn bot_drag(race: *const Race, i: u8) u8 {
    const car = &race.cars[i];
    if (car.finished_tick != 0) return if (car.speed > 150) IN_BRAKE else 0;
    var b: u8 = IN_THROTTLE;
    // Shift near the perfect window; lower skill means a wider spread.
    const err: i64 = 80 + @divTrunc((1000 - @as(i64, car.skill)) * 7, 10);
    const jitter: i64 = @as(i64, @intCast(noise(race, i, car.gear) % @as(u64, @intCast(2 * err + 1)))) - err;
    const target: i32 = @intCast(7050 + jitter);
    if (car.gear < GEARS and car.shift_ticks == 0 and car.rpm >= target and car.input_prev & IN_SHIFT_UP == 0) {
        b |= IN_SHIFT_UP;
    }
    const nitro_gear: u8 = if (car.skill > 800) 2 else 3;
    if (car.gear >= nitro_gear and car.nitro > 0) b |= IN_NITRO;
    return b;
}

/// HUD and results words (see SPEC.md "State words").
pub fn write_state(race: *const Race, out: *[STATE_WORDS]i32) void {
    out[0] = race.phase;
    out[1] = @intCast(race.tick);
    out[2] = race.car_count;
    out[3] = race.laps;
    out[4] = race.countdown_left;
    out[5] = @intCast(@divTrunc(race.lap_mm, 1000));
    out[6] = race.mode;
    out[7] = @intCast(race.first_finish_tick);
    for (race.cars, 0..) |car, i| {
        const w = out[STATE_HEADER_WORDS + i * STATE_CAR_WORDS ..][0..STATE_CAR_WORDS];
        if (i >= race.car_count) {
            @memset(w, 0);
            continue;
        }
        var flags: i32 = 0;
        if (car.human) flags |= 1;
        if (car.fuel_limited) flags |= 2;
        if (car.shift_flash > 0) flags |= 4;
        if (car.nitro_on) flags |= 8;
        if (car.crashed_ticks > 0) flags |= 16;
        w[0] = @intCast(car.progress_mm);
        w[1] = car.lap;
        w[2] = car.place;
        w[3] = speed_kmh_x10(car.speed);
        w[4] = car.rpm;
        w[5] = car.gear;
        w[6] = car.nitro;
        w[7] = @intCast(car.finished_tick);
        w[8] = car.lateral_mm;
        w[9] = flags;
        w[10] = @intCast(@divTrunc(car.distance_mm, 1000));
        w[11] = car.last_shift;
        w[12] = @intCast(car.best_lap_ticks);
        w[13] = car.colour;
        w[14] = 0;
        w[15] = 0;
    }
}

pub fn speed_kmh_x10(speed: i32) i32 {
    return @divTrunc(speed * 216, 100); // mm/tick * 60 * 3600 / 1e6 * 10
}

const Fnv = struct {
    h: u32 = 0x811C_9DC5,

    fn byte(self: *Fnv, b: u8) void {
        self.h = (self.h ^ b) *% 0x0100_0193;
    }

    fn value(self: *Fnv, v: anytype) void {
        const T = @TypeOf(v);
        switch (@typeInfo(T)) {
            .int => |info| {
                const U = std.meta.Int(.unsigned, info.bits);
                var x: U = @bitCast(v);
                inline for (0..(info.bits + 7) / 8) |_| {
                    self.byte(@truncate(x));
                    if (info.bits > 8) x >>= 8;
                }
            },
            .bool => self.byte(@intFromBool(v)),
            .@"enum" => self.value(@intFromEnum(v)),
            .array => for (v) |e| self.value(e),
            .@"struct" => |info| inline for (info.fields) |f| self.value(@field(v, f.name)),
            else => @compileError("unhashed type " ++ @typeName(T)),
        }
    }
};

/// FNV-1a over the whole simulation state. The track is derived from (id, seed, mode), so only its
/// header is hashed; every other field of Race and every car slot is.
pub fn hash(race: *const Race) u32 {
    var f: Fnv = .{};
    inline for (std.meta.fields(Race)) |field| {
        if (comptime std.mem.eql(u8, field.name, "track")) {
            f.value(race.track.count);
            f.value(race.track.closed);
            f.value(race.track.lanes);
            f.value(race.track.id);
        } else {
            f.value(@field(race, field.name));
        }
    }
    return f.h;
}

// Tests.

const testing = std.testing;

fn run_bots(race: *Race, max_ticks: u32) void {
    const none = [_]u8{0} ** MAX_CARS;
    var t: u32 = 0;
    while (t < max_ticks and race.phase != PHASE_FINISHED) : (t += 1) tick(race, &none);
}

test "bots finish a circuit race" {
    var race: Race = undefined;
    init(&race, 1, 0, 0, 2, 0, 6);
    run_bots(&race, 40_000);
    try testing.expectEqual(PHASE_FINISHED, race.phase);
    for (race.cars[0..race.car_count]) |car| try testing.expect(car.finished_tick != 0);
}

test "drag: a perfect shifter beats a no-shifter" {
    var race: Race = undefined;
    init(&race, 7, 2, 0, 1, 2, 0);
    var inputs = [_]u8{0} ** MAX_CARS;
    var t: u32 = 0;
    while (t < 5000 and race.phase != PHASE_FINISHED) : (t += 1) {
        inputs[0] = IN_THROTTLE;
        const c = &race.cars[0];
        if (c.rpm >= 6900 and c.input_prev & IN_SHIFT_UP == 0 and c.shift_ticks == 0) inputs[0] |= IN_SHIFT_UP;
        inputs[1] = IN_THROTTLE; // never shifts: stuck on the limiter in first
        tick(&race, &inputs);
    }
    try testing.expect(race.cars[0].finished_tick != 0);
    try testing.expectEqual(@as(u8, 1), race.cars[0].place);
    try testing.expectEqual(SHIFT_PERFECT, race.cars[0].last_shift);
}

test "torque curve and shift grading" {
    try testing.expectEqual(@as(i32, 1000), torque(6000));
    try testing.expect(torque(3500) < torque(5500));
    try testing.expect(torque(8000) < torque(7000));
    try testing.expectEqual(SHIFT_PERFECT, shift_quality(7000));
    try testing.expectEqual(SHIFT_GOOD, shift_quality(6500));
    try testing.expectEqual(SHIFT_EARLY, shift_quality(5000));
    try testing.expectEqual(SHIFT_LATE, shift_quality(7900));
}

test "fuel limit caps speed at 20 km/h" {
    var race: Race = undefined;
    init(&race, 3, 1, 1, 1, 1, 0);
    set_fuel(&race, 0, true, 50);
    var inputs = [_]u8{0} ** MAX_CARS;
    inputs[0] = IN_THROTTLE;
    var t: u32 = 0;
    while (t < 1200) : (t += 1) tick(&race, &inputs);
    try testing.expect(race.cars[0].fuel_limited);
    try testing.expect(race.cars[0].speed <= FUEL_SPEED);
    set_fuel(&race, 0, true, 100_000);
    t = 0;
    while (t < 300) : (t += 1) tick(&race, &inputs);
    try testing.expect(!race.cars[0].fuel_limited);
    try testing.expect(race.cars[0].speed > FUEL_SPEED * 3);
}

test "hash covers inputs" {
    var a: Race = undefined;
    var b: Race = undefined;
    init(&a, 9, 0, 2, 1, 1, 3);
    init(&b, 9, 0, 2, 1, 1, 3);
    try testing.expectEqual(hash(&a), hash(&b));
    var ia = [_]u8{IN_THROTTLE} ** MAX_CARS;
    var t: u32 = 0;
    while (t < 400) : (t += 1) {
        tick(&a, &ia);
        tick(&b, &ia);
    }
    try testing.expectEqual(hash(&a), hash(&b));
    ia[0] = IN_THROTTLE | IN_LEFT;
    tick(&a, &ia);
    ia[0] = IN_THROTTLE;
    tick(&b, &ia);
    try testing.expect(hash(&a) != hash(&b));
}

test "race ends 5 minutes after the first finisher when a human never finishes" {
    var race: Race = undefined;
    init(&race, 4, 2, 0, 1, 1, 1); // drag: the bot finishes in seconds, the human never moves
    const none = [_]u8{0} ** MAX_CARS;
    var t: u32 = 0;
    while (t < 30_000 and race.phase != PHASE_FINISHED) : (t += 1) tick(&race, &none);
    try testing.expectEqual(PHASE_FINISHED, race.phase);
    try testing.expect(race.first_finish_tick != 0);
    try testing.expectEqual(race.first_finish_tick + FINISH_GRACE_TICKS, race.tick);
    try testing.expectEqual(@as(u32, 0), race.cars[0].finished_tick);
    try testing.expectEqual(@as(u8, 2), race.cars[0].place);
}
