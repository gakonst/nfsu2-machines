//! A test tool, not part of the server: replays a JSON-lines trace of the hub's inputs into the Rust hub (nfsu2_roam::Hub,
//! with a clock and a busy measure of the trace's own) and prints everything the hub does as JSON lines: every frame it
//! sends (as hex, or a digest), every console line, and the answers of the queries.  web/worker/test/roam/difftrace.mjs
//! replays the same trace into the Worker's port (web/worker/src/roam/hub.js) and compares the two outputs line by line.
//!
//!   cargo run --release -p nfsu2-roam --example difftrace -- [--hex] < trace.jsonl > out.jsonl
//!
//! A trace line: {"t": ms, "op": ...}; ops: new {options, id}, claims (in-memory claims on), claim {name, owner},
//! frame {from, hex, owner?, client?}, tick {busy?}, gone {vip}, blocks {vip, names}, page {vip, name},
//! friends {vip, me, owners}, room_name {vip, name}, flew {vip, secs}, thread_busy {busy}, info, links, pairs,
//! linked {vip, name}, hosted {vip}, where {owners}, crews {crews}, counts.

use std::cell::RefCell;
use std::io::{BufRead, Write};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use nfsu2_roam::{Hub, RoamOptions};
use serde_json::{Value, json};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex")).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// a frame's digest: its CRC-32 (zlib's), its FNV-1a 32 and its length
fn digest(b: &[u8]) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for &c in b {
        h = (h ^ c as u32).wrapping_mul(0x0100_0193);
    }
    format!("{:08x}{h:08x}:{}", crc32fast::hash(b), b.len())
}

fn options(v: &Value) -> RoamOptions {
    let mut o = RoamOptions::default();
    let f = |k: &str| v.get(k).and_then(Value::as_f64);
    let u = |k: &str| v.get(k).and_then(Value::as_u64).map(|x| x as usize);
    if let Some(x) = u("degree") { o.degree = x; }
    if let Some(x) = v.get("tick_ms").and_then(Value::as_u64) { o.tick_ms = x; }
    if let Some(x) = f("stale_ms") { o.stale_ms = x; }
    if let Some(x) = f("gone_ms") { o.gone_ms = x; }
    if let Some(x) = f("keep") { o.keep = x; }
    if let Some(x) = f("hold_ms") { o.hold_ms = x; }
    if let Some(x) = u("max_per_vip") { o.max_per_vip = x; }
    if let Some(x) = u("max_players") { o.max_players = x; }
    if let Some(x) = u("exact_room") { o.exact_room = x; }
    if let Some(x) = u("min_degree") { o.min_degree = x; }
    if let Some(x) = f("busy_high") { o.busy_high = x; }
    if let Some(x) = f("busy_low") { o.busy_low = x; }
    if let Some(x) = f("cap_down_ms") { o.cap_down_ms = x; }
    if let Some(x) = f("cap_up_ms") { o.cap_up_ms = x; }
    if let Some(x) = u("ask_cap") { o.ask_cap = x; }
    if let Some(x) = f("soon_ms") { o.soon_ms = x; }
    if let Some(x) = f("look_ms") { o.look_ms = x; }
    if let Some(x) = f("away_m") { o.away_m = x; }
    if let Some(x) = f("view_m") { o.view_m = x; }
    if let Some(x) = u("sends") { o.sends = x; }
    if let Some(x) = f("near_m") { o.near_m = x; }
    if let Some(x) = f("near_hold_ms") { o.near_hold_ms = x; }
    if let Some(x) = f("near_fast") { o.near_fast = x; }
    if let Some(x) = f("level_slack_m") { o.level_slack_m = x; }
    if let Some(x) = f("level_grade") { o.level_grade = x; }
    if let Some(x) = f("level_k") { o.level_k = x; }
    if let Some(x) = u("map_max") { o.map_max = x; }
    if let Some(x) = f("map_gap_ms") { o.map_gap_ms = x; }
    if let Some(x) = f("map_fresh_ms") { o.map_fresh_ms = x; }
    if let Some(x) = f("near_gap_ms") { o.near_gap_ms = x; }
    o.link_threads = u("link_threads").unwrap_or(1);
    o
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn main() {
    let full = std::env::args().any(|a| a == "--hex");
    let now = Rc::new(RefCell::new(0.0f64));
    let busy = Arc::new(Mutex::new(0.0f64));
    let out: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut hub: Option<Hub> = None;
    let mut claims: Option<Arc<nfsu2_claims::Claims>> = None;
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut w = std::io::BufWriter::new(stdout.lock());
    // (the hub's clock is a Send closure: the trace's time goes through an Arc too)
    let clock = Arc::new(Mutex::new(0.0f64));
    for (i, line) in stdin.lock().lines().enumerate() {
        let line = line.expect("line");
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line).expect("json");
        let t = v.get("t").and_then(Value::as_f64).unwrap_or(*now.borrow());
        *now.borrow_mut() = t;
        *clock.lock().unwrap() = t;
        let op = s(&v, "op");
        let mut answer: Option<Value> = None;
        match op.as_str() {
            "new" => {
                let o = options(v.get("options").unwrap_or(&Value::Null));
                let id = v.get("id").and_then(Value::as_u64).unwrap_or(0xB0B) as u32;
                let (c, b, l, f) = (clock.clone(), busy.clone(), out.clone(), out.clone());
                let mut h = Hub::new(
                    o,
                    Box::new(move || *c.lock().unwrap()),
                    Box::new(move || *b.lock().unwrap()),
                    Box::new(move |line: &str| l.lock().unwrap().push(json!({ "log": line }).to_string())),
                    Box::new(move |vip, frame| {
                        let e = if full { json!({ "vip": vip, "hex": hex(&frame) }) } else { json!({ "vip": vip, "d": digest(&frame) }) };
                        f.lock().unwrap().push(e.to_string());
                        true
                    }),
                    id,
                );
                h.set_claims(claims.clone());
                hub = Some(h);
            }
            "claims" => {
                claims = Some(Arc::new(nfsu2_claims::Claims::in_memory()));
                if let Some(h) = hub.as_mut() {
                    h.set_claims(claims.clone());
                }
            }
            "claim" => {
                if let Some(c) = &claims {
                    let owner: Arc<str> = Arc::from(s(&v, "owner").as_str());
                    let r = c.claim(&s(&v, "name"), &owner, t as i64);
                    answer = Some(json!(r.is_ok()));
                }
            }
            _ => {
                let Some(h) = hub.as_mut() else { continue };
                match op.as_str() {
                    "frame" => {
                        let from = v["from"].as_u64().unwrap_or(0) as u32;
                        let data = unhex(&s(&v, "hex"));
                        let owner: Option<Arc<str>> = v.get("owner").and_then(Value::as_str).map(Arc::from);
                        let client: Option<Arc<str>> = v.get("client").and_then(Value::as_str).map(Arc::from);
                        h.frame_of(from, &data, owner.as_ref(), client.as_ref());
                    }
                    "tick" => {
                        if let Some(b) = v.get("busy").and_then(Value::as_f64) {
                            *busy.lock().unwrap() = b;
                        }
                        h.tick();
                    }
                    "gone" => h.peer_gone(v["vip"].as_u64().unwrap_or(0) as u32),
                    "blocks" => {
                        let names = v["names"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                        h.blocks(v["vip"].as_u64().unwrap_or(0) as u32, names);
                    }
                    "page" => h.page_name(v["vip"].as_u64().unwrap_or(0) as u32, s(&v, "name")),
                    "friends" => {
                        let owners: Vec<Arc<str>> =
                            v["owners"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(Arc::from)).collect()).unwrap_or_default();
                        h.friends(v["vip"].as_u64().unwrap_or(0) as u32, Arc::from(s(&v, "me").as_str()), owners);
                    }
                    "room_name" => h.room_name(v["vip"].as_u64().unwrap_or(0) as u32, s(&v, "name")),
                    "flew" => h.flew(v["vip"].as_u64().unwrap_or(0) as u32, v["secs"].as_f64().unwrap_or(0.0)),
                    "thread_busy" => h.set_thread_busy(v["busy"].as_f64().unwrap_or(0.0)),
                    "info" => {
                        let mut j = h.info();
                        j["tickMsMax"] = json!(0);
                        answer = Some(j);
                    }
                    "links" => answer = Some(json!(h.links())),
                    "pairs" => answer = Some(json!(h.link_pairs())),
                    "linked" => {
                        answer = Some(match h.linked_with(v["vip"].as_u64().unwrap_or(0) as u32, &s(&v, "name")) {
                            Some((vip, owner)) => json!([vip, owner.map(|o| o.to_string())]),
                            None => Value::Null,
                        })
                    }
                    "hosted" => {
                        answer = Some(match h.hosted(v["vip"].as_u64().unwrap_or(0) as u32) {
                            Some(x) => json!({"host": x.host, "lobby": x.lobby, "race": x.race, "n": x.n, "max": x.max, "room": x.room}),
                            None => Value::Null,
                        })
                    }
                    "where" => {
                        let owners: Vec<Arc<str>> =
                            v["owners"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(Arc::from)).collect()).unwrap_or_default();
                        let r: Vec<Value> = h
                            .whereabouts(&owners)
                            .into_iter()
                            .map(|x| x.map_or(Value::Null, |w| json!({"room": w.room, "roomName": w.room_name})))
                            .collect();
                        answer = Some(json!(r));
                    }
                    "crews" => {
                        let crews: Vec<u32> = v["crews"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|c| c as u32)).collect()).unwrap_or_default();
                        answer = Some(json!(h.in_crews(&crews)));
                    }
                    "counts" => {
                        let mut rooms: Vec<(u32, usize)> = h.in_rooms().into_iter().collect();
                        rooms.sort();
                        let mut vips: Vec<u32> = h.vips().into_iter().collect();
                        vips.sort();
                        answer = Some(json!({"crowded": h.crowded(), "inRoam": h.in_roam(), "coop": h.coop_seats(), "rooms": rooms, "vips": vips}));
                    }
                    _ => panic!("unknown op {op}"),
                }
            }
        }
        for e in out.lock().unwrap().drain(..) {
            writeln!(w, "{{\"i\":{i},\"e\":{e}}}").unwrap();
        }
        if let Some(a) = answer {
            writeln!(w, "{{\"i\":{i},\"a\":{a}}}").unwrap();
        }
    }
}
