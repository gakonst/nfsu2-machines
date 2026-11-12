//! Test only: the switch's timing and stat modules, unchanged (included by #[path] from crates/lan/src and
//! crates/util/src), driven by JSON cases on stdin, one per line; one JSON line out for each.  web/worker's
//! differential tests (web/worker/test/switch/timing-diff.test.mjs) send the same cases to the JavaScript port and
//! compare.  Floats travel as the hex of their bits ("3ff0000000000000"), bytes as hex.
//!
//! The crate:: items the modules use are small stand-ins here (lib.rs's constants and slot(), a Peer with only its
//! address, a LanSwitch that records what the impairment delivers); nfsu2_util is lan-diff-timing-shim (the real
//! crate with a clock and a seed the driver sets); members.rs's private store_list is copied verbatim below.

#![allow(dead_code, unused_imports, unused_variables, clippy::all)]

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU32, Ordering::Relaxed};
use std::sync::{Arc, Weak};
use std::time::Duration;

use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::{Value, json};

#[path = "../../lan/src/away.rs"]
mod away;
#[path = "../../util/src/bucket.rs"]
mod bucket;
#[path = "../../lan/src/impair.rs"]
mod impair;
#[path = "../../lan/src/lag.rs"]
mod lag;
#[path = "../../lan/src/paths.rs"]
mod paths;
#[path = "../../lan/src/store.rs"]
mod store;
#[path = "../../lan/src/text.rs"]
mod text;

// ---- stand-ins for the crate:: items the modules use (lib.rs) ----

pub(crate) const BASE: u32 = (10 << 24) | (77 << 16);
pub const NETS: usize = 96;
pub(crate) const KIND_UDP: u8 = 1;
pub(crate) const KIND_LAN_UDP: u8 = 3;
pub(crate) const KIND_STREAM: u8 = 4;
pub(crate) const KIND_LAN_ICMP: u8 = 5;
pub use text::vip_num;

/// lib.rs slot(), verbatim
fn slot(vip: u32) -> Option<usize> {
    let host = vip & 255;
    let net = ((vip >> 8) & 255) as usize;
    if vip & 0xFFFF_0000 != BASE || net >= NETS || !(2..=251).contains(&host) {
        return None;
    }
    Some(net + NETS * (host as usize - 2))
}

/// bucket.rs's crate::clock: the driver's clock
mod clock {
    use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
    static MONO: AtomicU64 = AtomicU64::new(0);
    pub fn mono_ms() -> f64 {
        f64::from_bits(MONO.load(Relaxed))
    }
    pub fn set(v: f64) {
        MONO.store(v.to_bits(), Relaxed);
    }
}

pub(crate) struct Peer {
    pub(crate) vip: u32,
}

pub(crate) struct Stats {
    pub(crate) lost: nfsu2_util::Counter,
}

pub(crate) struct LanSwitch {
    pub(crate) impair: Option<impair::Impair>,
    t0: tokio::time::Instant,
    log: Mutex<Vec<Value>>,
}

impl LanSwitch {
    pub(crate) fn deliver_now(&self, from: &Arc<Peer>, p: &Arc<Peer>, data: &Bytes, dst: u32) {
        let t = (tokio::time::Instant::now() - self.t0).as_nanos() as u64;
        self.log.lock().push(json!([t, from.vip, p.vip, dst, hex(data)]));
    }
}

/// members.rs store_list, verbatim but for its input: the peers' addresses and hashes (in the peers' order), the
/// reservations' (address, until, hash) in theirs
fn store_list(peers: &[(u32, [u8; 32])], reserved: &[(u32, i64, [u8; 32])], now: i64) -> String {
    let mut s = String::from("[");
    let mut first = true;
    let mut one = |s: &mut String, v: u32, h: &[u8; 32]| {
        if !first {
            s.push(',');
        }
        first = false;
        s.push_str(r#"{"v":""#);
        s.push_str(&nfsu2_util::vip_str(v));
        s.push_str(r#"","h":""#);
        s.push_str(&nfsu2_util::js::base64url(h));
        s.push_str(r#""}"#);
    };
    let held: std::collections::HashSet<u32> = peers.iter().map(|p| p.0).collect();
    for p in peers {
        one(&mut s, p.0, &p.1);
    }
    for (v, until, hash) in reserved {
        if *until > now && !held.contains(v) {
            one(&mut s, *v, hash);
        }
    }
    s.push(']');
    s
}

// ---- helpers ----

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}
fn f(v: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v.as_str().expect("float bits"), 16).unwrap())
}
fn b(x: f64) -> Value {
    Value::String(format!("{:016x}", x.to_bits()))
}
fn ob(x: Option<f64>) -> Value {
    x.map_or(Value::Null, b)
}
fn u(v: &Value) -> u64 {
    v.as_u64().expect("integer")
}
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn hash32(v: &Value) -> [u8; 32] {
    unhex(s(v)).try_into().expect("32 bytes")
}

fn run(c: &Value) -> Value {
    match s(&c["k"]) {
        "bucket" => {
            let ops = c["ops"].as_array().unwrap();
            let mut bk: Option<bucket::Bucket> = None;
            let mut out = Vec::new();
            for o in ops {
                let r = match s(&o["op"]) {
                    "new" => {
                        bk = Some(bucket::Bucket::new_at(f(&o["rate"]), f(&o["now"])));
                        Value::Null
                    }
                    "burst" => {
                        bk = Some(bucket::Bucket::with_burst_at(f(&o["rate"]), f(&o["burst"]), f(&o["now"])));
                        Value::Null
                    }
                    "level" => b(bk.as_ref().unwrap().level_at(f(&o["now"]))),
                    "has" => json!(bk.as_mut().unwrap().has_at(f(&o["now"]), f(&o["n"]))),
                    "take" => json!(bk.as_mut().unwrap().take_at(f(&o["now"]), f(&o["n"]))),
                    "spend" => json!(bk.as_mut().unwrap().spend_at(f(&o["now"]), f(&o["n"]))),
                    x => panic!("bucket op {x}"),
                };
                let k = bk.as_ref().unwrap();
                out.push(json!([r, b(k.rate), b(k.cap), b(k.v), b(k.t)]));
            }
            Value::Array(out)
        }
        "budget" => {
            let total = c["total"].as_u64().map_or(usize::MAX, |t| t as usize);
            let bg = bucket::Budget::new(u(&c["per"]) as usize, u(&c["per_site"]) as usize, total, f(&c["free"]));
            let out: Vec<Value> = c["ops"]
                .as_array()
                .unwrap()
                .iter()
                .map(|o| {
                    let (k, st) = (s(&o["key"]), s(&o["site"]));
                    let r = match s(&o["op"]) {
                        "take" => json!(bg.take(k, st)),
                        "room" => json!(bg.room(k, st)),
                        "give" => {
                            bg.give(k, st);
                            Value::Null
                        }
                        "held" => json!(bg.held(k)),
                        x => panic!("budget op {x}"),
                    };
                    json!([r, bg.count()])
                })
                .collect();
            Value::Array(out)
        }
        "rate" => {
            let rt = bucket::Rate::new(f(&c["burst"]), f(&c["rate"]));
            let out: Vec<Value> = c["ops"]
                .as_array()
                .unwrap()
                .iter()
                .map(|o| {
                    clock::set(f(&o["now"]));
                    let (k, st) = (s(&o["key"]), s(&o["site"]));
                    match s(&o["op"]) {
                        "take" => json!(rt.take(k, st)),
                        "check" => json!(rt.check(k, st)),
                        "prune" => {
                            rt.prune();
                            Value::Null
                        }
                        x => panic!("rate op {x}"),
                    }
                })
                .collect();
            Value::Array(out)
        }
        "lag" => {
            let share = AtomicU32::new(u(&c["share"]) as u32);
            let mut p = lag::Probe::new(f(&c["now"]));
            let mut sent: Vec<[u8; 8]> = Vec::new();
            let mut out = Vec::new();
            for o in c["ops"].as_array().unwrap() {
                let now = f(&o["now"]);
                let r = match s(&o["op"]) {
                    "ping" => {
                        let d = p.ping(now);
                        sent.push(d);
                        json!(hex(&d))
                    }
                    "tick" => {
                        p.tick(now);
                        Value::Null
                    }
                    "pong" => {
                        let d = match o.get("j").and_then(Value::as_u64) {
                            Some(j) => sent[j as usize].to_vec(),
                            None => unhex(s(&o["d"])),
                        };
                        json!(p.pong(&d, now, &share))
                    }
                    "lag" => b(p.lag(now)),
                    x => panic!("lag op {x}"),
                };
                out.push(json!([r, share.load(Relaxed), ob(p.rtt()), ob(p.base())]));
            }
            Value::Array(out)
        }
        "pick" => {
            let seed = s(&c["seed"]).parse::<u64>().unwrap();
            let shares: Vec<u32> = c["shares"].as_array().unwrap().iter().map(|v| u(v) as u32).collect();
            // a thread of its own: lag.rs's RNG is per thread, seeded on its first pick
            let bits = std::thread::spawn(move || {
                nfsu2_util::set_seed(seed);
                shares.iter().map(|&sh| if lag::pick(sh) { '1' } else { '0' }).collect::<String>()
            })
            .join()
            .unwrap();
            json!(bits)
        }
        "frames" => {
            let out: Vec<Value> = c["frames"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| {
                    let fr = unhex(s(h));
                    json!([lag::is_snap(&fr), away::status(&fr)])
                })
                .collect();
            let aw: Vec<bool> = (0..=255u8).map(away::away).collect();
            json!({"frames": out, "away": aw})
        }
        "regions" => {
            let out: Vec<Value> = c["codes"].as_array().unwrap().iter().map(|v| json!(paths::region(u(v) as u16))).collect();
            Value::Array(out)
        }
        "paths" => {
            let players: Vec<paths::Seen> = c["players"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| paths::Seen { vip: u(&p[0]) as u32, country: u(&p[1]) as u16, base: (!p[2].is_null()).then(|| f(&p[2])) })
                .collect();
            let pairs = |v: &Value| -> Vec<(u32, u32)> {
                v.as_array().unwrap().iter().map(|p| (u(&p[0]) as u32, u(&p[1]) as u32)).collect()
            };
            json!(paths::lines(&players, &pairs(&c["roam"]), &pairs(&c["lan"])))
        }
        "race" => {
            let to: [AtomicU32; paths::LAN_TO] = Default::default();
            let mut out = Vec::new();
            for o in c["ops"].as_array().unwrap() {
                if o.is_null() {
                    let mut got = Vec::new();
                    paths::take(&to, &mut got);
                    out.push(json!(got));
                } else {
                    paths::race_with(&to, u(o) as u32);
                }
            }
            Value::Array(out)
        }
        "num" => {
            let out: Vec<Value> = c["s"].as_array().unwrap().iter().map(|v| b(text::to_number(s(v)))).collect();
            Value::Array(out)
        }
        "spec" => match impair::Impair::parse(s(&c["spec"])) {
            Some(im) => json!(nfsu2_util::json::stringify(&im.spec_json())),
            None => Value::Null,
        },
        "impair" => impair_run(c),
        "store" => {
            let dir = std::env::temp_dir().join(format!("lan-diff-timing-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("lan-addresses.json");
            let st = store::Store::new(path.clone());
            let r = if let Some(h) = c.get("bytes") {
                std::fs::write(&path, unhex(s(h))).unwrap();
                st.load()
            } else {
                let _ = std::fs::remove_file(&path);
                st.load()
            };
            let _ = std::fs::remove_file(&path);
            json!(r.iter().map(|(v, h)| json!([v, hex(h)])).collect::<Vec<_>>())
        }
        "storelist" => {
            let peers: Vec<(u32, [u8; 32])> = c["peers"].as_array().unwrap().iter().map(|p| (u(&p[0]) as u32, hash32(&p[1]))).collect();
            let res: Vec<(u32, i64, [u8; 32])> = c["reserved"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| (u(&p[0]) as u32, p[1].as_i64().unwrap(), hash32(&p[2])))
                .collect();
            json!(store_list(&peers, &res, c["now"].as_i64().unwrap()))
        }
        x => panic!("case kind {x}"),
    }
}

/// The impairment on tokio's paused clock: each event at its time (ms from the start, whole), after the delivery
/// task's timers due by then ran; what LanSwitch::deliver_now got, with the time it ran at (ns from the start).
fn impair_run(c: &Value) -> Value {
    let rt = tokio::runtime::Builder::new_current_thread().enable_time().start_paused(true).build().unwrap();
    rt.block_on(async {
        let Some(im) = impair::Impair::parse(s(&c["spec"])) else { return Value::Null };
        let t0 = tokio::time::Instant::now();
        let sw = Arc::new(LanSwitch { impair: Some(im), t0, log: Mutex::new(Vec::new()) });
        sw.impair.as_ref().unwrap().start(Arc::downgrade(&sw));
        let stats = Stats { lost: nfsu2_util::Counter::new() };
        let mut peers: HashMap<u32, Arc<Peer>> = HashMap::new();
        let mut lost = String::new();
        let settle = || async {
            for _ in 0..32 {
                tokio::task::yield_now().await;
            }
        };
        for e in c["events"].as_array().unwrap() {
            let t = u(&e["t"]);
            tokio::time::sleep_until(t0 + Duration::from_millis(t)).await;
            settle().await;
            nfsu2_util::set_now_ms(t as i64);
            let im = sw.impair.as_ref().unwrap();
            match s(&e["op"]) {
                "d" => {
                    let mut peer = |v: u32| peers.entry(v).or_insert_with(|| Arc::new(Peer { vip: v })).clone();
                    let (from, to) = (peer(u(&e["from"]) as u32), peer(u(&e["to"]) as u32));
                    let before = stats.lost.get();
                    im.deliver(&stats, &from, &to, &Bytes::from(unhex(s(&e["data"]))), u(&e["dst"]) as u32);
                    lost.push(if stats.lost.get() > before { '1' } else { '0' });
                }
                "f" => im.forget(u(&e["vip"]) as u32),
                x => panic!("impair op {x}"),
            }
        }
        tokio::time::sleep_until(t0 + Duration::from_millis(u(&c["end"]))).await;
        settle().await;
        let log = std::mem::take(&mut *sw.log.lock());
        json!({"lost": lost, "out": log})
    })
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout());
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let c: Value = serde_json::from_str(&line).expect("a JSON case");
        let r = run(&c);
        writeln!(out, "{}", serde_json::to_string(&r).unwrap()).unwrap();
    }
    out.flush().unwrap();
}
