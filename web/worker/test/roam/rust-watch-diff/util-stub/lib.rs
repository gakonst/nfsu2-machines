//! nfsu2-util's vip_str (web/server-rs/crates/util/src/lib.rs), the one item watch.rs takes from it.

pub fn vip_str(v: u32) -> String {
    format!("{}.{}.{}.{}", v >> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255)
}
