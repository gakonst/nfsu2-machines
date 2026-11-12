//! Seeded deterministic PRNG (SplitMix64). The only randomness the simulation may use.
const std = @import("std");
const assert = std.debug.assert;

pub const Prng = struct {
    state: u64,

    pub fn init(seed: u64) Prng {
        return .{ .state = seed ^ 0x6A09_E667_F3BC_C908 };
    }

    pub fn next(self: *Prng) u64 {
        self.state +%= 0x9E37_79B9_7F4A_7C15;
        return mix(self.state);
    }

    /// Uniform in [0, n). n > 0.
    pub fn below(self: *Prng, n: u32) u32 {
        assert(n > 0);
        // Multiply-shift: unbiased enough for gameplay and tests, and branch free.
        const r: u64 = self.next() >> 32;
        return @intCast((r * n) >> 32);
    }

    /// Uniform in [lo, hi]. lo <= hi.
    pub fn range(self: *Prng, lo: i32, hi: i32) i32 {
        assert(lo <= hi);
        const span: u32 = @intCast(@as(i64, hi) - @as(i64, lo) + 1);
        return lo + @as(i32, @intCast(self.below(span)));
    }

    /// True with probability num/den.
    pub fn chance(self: *Prng, num: u32, den: u32) bool {
        assert(den > 0);
        return self.below(den) < num;
    }
};

/// Stateless 64-bit finalizer (SplitMix64), used for per-tick bot noise without mutating state.
pub fn mix(x0: u64) u64 {
    var x = x0;
    x = (x ^ (x >> 30)) *% 0xBF58_476D_1CE4_E5B9;
    x = (x ^ (x >> 27)) *% 0x94D0_49BB_1331_11EB;
    return x ^ (x >> 31);
}

test "prng is deterministic and in range" {
    var a = Prng.init(42);
    var b = Prng.init(42);
    var i: u32 = 0;
    while (i < 1000) : (i += 1) {
        const x = a.range(-5, 7);
        try std.testing.expectEqual(x, b.range(-5, 7));
        try std.testing.expect(x >= -5 and x <= 7);
    }
    var c = Prng.init(43);
    try std.testing.expect(c.next() != Prng.init(42).state);
}
