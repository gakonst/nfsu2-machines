//! The items results.rs takes from wire.rs (web/server-rs/crates/roam/src/wire.rs), as they are there: wire.rs itself
//! is the hub's whole protocol.

pub(crate) const RS_FINISHED: u8 = 0x01;
pub(crate) const RS_OURS: u8 = 0x02;
pub(crate) const LOBBY_PLAYERS: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RaceRes {
    pub lobby: u32,
    pub race: u32,
    pub mode: u8,
    pub laps: u8,
    pub heat: u8,
    pub heats: u8,
    pub n: usize,
    pub rows: [ResRow; LOBBY_PLAYERS],
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct ResRow {
    pub id: u32,
    pub flags: u8,
    pub time: f64,
    pub done: f64,
    pub dist: f64,
    pub jump: f64,
}
