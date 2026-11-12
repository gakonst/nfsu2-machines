//! Test only (lan-diff-timing): nfsu2-util re-exported, with `now_ms()` read from a clock the driver sets and
//! `rand::u64()` from a seed it sets (lag.rs seeds its pick RNG with it), so impair.rs and lag.rs replay the same
//! way every time.  Nothing else changes.

use std::cell::Cell;
use std::sync::atomic::{AtomicI64, Ordering::Relaxed};

pub use nfsu2_util::*;

static NOW: AtomicI64 = AtomicI64::new(0);

/// the driver's clock (whole ms) in place of Date.now()
pub fn now_ms() -> i64 {
    NOW.load(Relaxed)
}

pub fn set_now_ms(v: i64) {
    NOW.store(v, Relaxed);
}

thread_local! {
    static SEED: Cell<u64> = const { Cell::new(1) };
}

/// what this thread's next `rand::u64()` returns
pub fn set_seed(v: u64) {
    SEED.with(|s| s.set(v));
}

pub mod rand {
    pub use nfsu2_util::rand::*;
    /// the seed the driver set (lag.rs's pick RNG starts from it)
    pub fn u64() -> u64 {
        super::SEED.with(|s| s.get())
    }
}
