//! Test only: the LAN switch's datagram codecs, its own source files included as they are (crates/lan/src/compact.rs,
//! fpred.rs, mix.rs, their unit tests with them), behind shims for the few crate items they name.  The ignored test
//! `difftrace` reads JSON lines from $DIFFTRACE_IN and writes one JSON line of answers each to $DIFFTRACE_OUT, for
//! web/worker/test/switch/codecs_diff.test.mjs to replay the same inputs into the JS port and compare.
//!
//!   cargo test --release -p nfsu2-lan-diff-codecs --lib -- --ignored --exact difftrace::difftrace
#![allow(dead_code, unused_imports)]

/// lib.rs's
pub(crate) const BASE: u32 = (10 << 24) | (77 << 16);
pub const BROADCAST: u32 = 0xFFFF_FFFF;
const KIND_UDP: u8 = 1;

/// lib.rs KindMsgs
pub struct KindMsgs {
    pub kind: &'static str,
    pub players: usize,
    pub msgs_in: u64,
    pub msgs_out: u64,
}

pub(crate) mod conn {
    /// conn.rs with_addrs, as it is
    pub(crate) fn with_addrs(buf: &mut Vec<u8>, data: &[u8], src: u32, dst: u32) {
        buf.extend_from_slice(&[data[0], 0, 0, 0]);
        buf.extend_from_slice(&src.to_be_bytes());
        buf.extend_from_slice(&dst.to_be_bytes());
        buf.extend_from_slice(&data[12..]);
    }
}

#[path = "../../lan/src/compact.rs"]
pub(crate) mod compact;
#[path = "../../lan/src/fpred.rs"]
pub mod fpred;
#[path = "../../lan/src/mix.rs"]
pub mod mix;

#[cfg(test)]
mod difftrace;
