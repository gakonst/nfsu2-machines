//! Differential traces (test-only; web/worker/test/online/diff.test.mjs drives it): replays JSON traces of a fake
//! switch's events (clients, TCP segments to 10.77.0.1 as vhost.rs takes them, clock moves, browsers leaving, a
//! restart) into the core through the tests' World, and prints every frame the host sent, every console line and
//! error, the counts and the state folder's files, as JSON lines, for the JS port (web/worker/src/online) to be
//! compared with.  Inert unless DIFFTRACE_IN names a file of traces (a JSON array); DIFFTRACE_OUT is where the
//! results go.
//!
//! Randomness: built with RUSTFLAGS='--cfg getrandom_backend="custom"' the OS's random bytes are those of the JS
//! port's Prng (web/worker/src/util/prng.js: xoshiro128** seeded by splitmix64, bytes(n) a u32 per 4 bytes), seeded
//! per trace: the redirector's SESS and MASK, the LKEYs, a game's AUTH and SEED come out the same on both sides.
//!   CARGO_TARGET_DIR=~/.cache/nfsu2-rs/online-diff RUSTFLAGS='--cfg getrandom_backend="custom"' \
//!     cargo test -p nfsu2-online --target x86_64-unknown-linux-gnu --lib difftrace -- --nocapture

#![allow(unexpected_cfgs)]
// (the Prng is used only by the custom getrandom backend: dead code in a plain build)
#![allow(dead_code)]

use std::borrow::Cow;
use std::cell::RefCell;
use std::sync::Arc;

use serde_json::{Value, json};

use std::collections::HashMap;

use super::world::{C, M, Opts, World, ip};
use crate::aries::{V, encode_frame, encode_frame_text};
use crate::buddy::{BuddyLimits, FriendAsk, PageMail};
use crate::lobby::Limits;
use crate::vhost::lan_frame;

struct Prng {
    s: [u32; 4],
}

impl Prng {
    fn new(seed: u64) -> Prng {
        let mut x = seed;
        let mut sm = || {
            x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = x;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        };
        let mut s = [0u32; 4];
        for i in 0..2 {
            let z = sm();
            s[2 * i] = z as u32;
            s[2 * i + 1] = (z >> 32) as u32;
        }
        if s == [0; 4] {
            s[0] = 1;
        }
        Prng { s }
    }
    fn next32(&mut self) -> u32 {
        let s = &mut self.s;
        let r = s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = s[1] << 9;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = s[3].rotate_left(11);
        r
    }
    fn fill(&mut self, b: &mut [u8]) {
        let mut i = 0;
        while i < b.len() {
            let v = self.next32();
            for j in 0..4 {
                if i + j < b.len() {
                    b[i + j] = (v >> (8 * j)) as u8;
                }
            }
            i += 4;
        }
    }
}

thread_local! {
    static PRNG: RefCell<Prng> = RefCell::new(Prng::new(0));
}

#[cfg(getrandom_backend = "custom")]
#[unsafe(no_mangle)]
unsafe extern "Rust" fn __getrandom_v03_custom(dest: *mut u8, len: usize) -> Result<(), core::num::NonZeroI32> {
    let b = unsafe { std::slice::from_raw_parts_mut(dest, len) };
    PRNG.with(|p| p.borrow_mut().fill(b));
    Ok(())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}

fn vip_of(v: &Value) -> u32 {
    v.as_u64().map(|x| x as u32).unwrap_or_else(|| ip(v.as_str().unwrap()))
}

fn limits_of(v: Option<&Value>) -> Limits {
    let mut l = Limits::default();
    let Some(Value::Object(m)) = v else { return l };
    for (k, x) in m {
        let x = x.as_f64().unwrap();
        match k.as_str() {
            "sessions" => l.sessions = x,
            "perVip" => l.per_vip = x,
            "perGroup" => l.per_group = x,
            "perSite" => l.per_site = x,
            "msgRate" => l.msg_rate = x,
            "chatRate" => l.chat_rate = x,
            "games" => l.games = x,
            "openPerVip" => l.open_per_vip = x,
            "openPerGroup" => l.open_per_group = x,
            "startedPerVip" => l.started_per_vip = x,
            "startedPerGroup" => l.started_per_group = x,
            "idleMs" => l.idle_ms = x,
            "preLoginMs" => l.pre_login_ms = x,
            "raceMs" => l.race_ms = x,
            "orphanMs" => l.orphan_ms = x,
            "pingMs" => l.ping_ms = x,
            "createRate" => l.create_rate = x,
            "actRate" => l.act_rate = x,
            _ => panic!("limit {k}"),
        }
    }
    l
}

fn buddy_limits_of(v: Option<&Value>) -> BuddyLimits {
    let mut l = BuddyLimits::default();
    let Some(Value::Object(m)) = v else { return l };
    for (k, x) in m {
        let x = x.as_f64().unwrap();
        match k.as_str() {
            "lists" => l.lists = x,
            "listRate" => l.list_rate = x,
            "msgRate" => l.msg_rate = x,
            "heavyRate" => l.heavy_rate = x,
            "presenceMs" => l.presence_ms = x,
            _ => panic!("buddy limit {k}"),
        }
    }
    l
}

/// every file under dir, by its path relative to dir ("stats.json", "friends/ab/....json")
fn files_of(dir: &std::path::Path) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                todo.push(p);
            } else {
                let rel = p.strip_prefix(dir).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(rel, Value::String(String::from_utf8_lossy(&std::fs::read(&p).unwrap()).into_owned()));
            }
        }
    }
    out
}

struct Run {
    w: World,
    /// the streams of the worlds before a restart: what they got (a reference after the restart reads them)
    old: HashMap<(u32, u16), Vec<M>>,
    /// what the page-mail hook was handed: [name, from, body, t]
    mail: Arc<std::sync::Mutex<Vec<Value>>>,
    dir: Option<tempfile::TempDir>,
    tr: Value,
}

impl Run {
    fn world(tr: &Value, dir: Option<&std::path::Path>, t0: f64) -> World {
        let claims = tr.get("claims").and_then(Value::as_array).map(|a| {
            let c = Arc::new(nfsu2_claims::Claims::in_memory());
            for x in a {
                let name = x[0].as_str().unwrap();
                let owner = nfsu2_claims::owner_of_token(x[1].as_str().unwrap()).unwrap();
                let at = x.get(2).and_then(Value::as_f64).unwrap_or(t0) as i64;
                c.claim(name, &owner, at).unwrap();
            }
            c
        });
        let deny = tr.get("deny").and_then(Value::as_array).map(|a| {
            let d = Arc::new(nfsu2_names::Deny::default());
            d.set(a.iter().map(|x| x.as_str().unwrap().to_string()));
            d
        });
        World::new(Opts {
            limits: limits_of(tr.get("limits")),
            buddy: buddy_limits_of(tr.get("buddyLimits")),
            state_dir: dir.map(|d| d.to_path_buf()),
            t0: Some(t0),
            claims,
            deny,
        })
    }

    fn drain(&mut self) -> Value {
        let sent: Vec<Value> = self.w.sent.lock().drain(..).map(|(v, f, refused)| json!([v, hex(&f), refused])).collect();
        let dir = self.dir.as_ref().map(|d| d.path().display().to_string());
        let fix = |s: &str| match &dir {
            Some(d) => s.replace(d.as_str(), "online"),
            None => s.to_string(),
        };
        let log: Vec<Value> = self.w.lines.borrow_mut().drain(..).map(|(l, k)| json!([fix(&l), k])).collect();
        let err: Vec<Value> = self.w.core.errors.drain(..).map(|l| json!(fix(&l))).collect();
        let mail: Vec<Value> = self.mail.lock().unwrap().drain(..).collect();
        if mail.is_empty() {
            json!({ "sent": sent, "log": log, "err": err })
        } else {
            json!({ "sent": sent, "log": log, "err": err, "mail": mail })
        }
    }

    /// a field's value from the trace: a string, a number, or {"ref": [vip, port, kind, key]} (the last such message
    /// that stream got, its field)
    fn value(&self, v: &Value) -> V {
        match v {
            Value::String(s) => V::S(s.clone()),
            Value::Number(n) => V::N(n.as_f64().unwrap()),
            Value::Object(o) => {
                let r = o["ref"].as_array().unwrap();
                let c = C(vip_of(&r[0]), r[1].as_u64().unwrap() as u16);
                let (kind, key) = (r[2].as_str().unwrap(), r[3].as_str().unwrap());
                let held = self.w.clients.get(&c.0).and_then(|x| x.conns.get(&c.1)).map(|k| &k.msgs).or_else(|| self.old.get(&(c.0, c.1)));
                let got = match held {
                    Some(ms) => ms.iter().rev().find(|m| m.kind == kind).and_then(|m| m.get(key).map(str::to_string)),
                    None => self.w.c(c).last(kind).and_then(|m| m.get(key).map(str::to_string)),
                };
                V::S(got.unwrap_or_default())
            }
            _ => V::Null,
        }
    }

    fn step(&mut self, s: &Value) -> Value {
        let op = s["op"].as_str().unwrap();
        let vip = s.get("vip").map(vip_of).unwrap_or(0);
        let port = s.get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
        let mut extra = Value::Null;
        match op {
            "client" => {
                let v = self.w.client_of(&nfsu2_util::vip_str(vip), s["group"].as_str().unwrap());
                let c = self.w.clients.get_mut(&v).unwrap();
                c.owner = s.get("owner").and_then(Value::as_str).map(|t| nfsu2_claims::owner_of_token(t).unwrap());
                c.no_races = s.get("noRaces").and_then(Value::as_bool).unwrap_or(false);
            }
            "noRaces" => self.w.clients.get_mut(&vip).unwrap().no_races = s["on"].as_bool().unwrap(),
            "connect" => {
                self.w.connect_as(vip, s["dport"].as_u64().unwrap() as u16, port, s["cid"].as_u64().unwrap() as u32);
            }
            "send" => {
                let fields: Vec<(Cow<'static, str>, V)> = s["fields"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| (Cow::Owned(f[0].as_str().unwrap().to_string()), self.value(&f[1])))
                    .collect();
                let code = s.get("code").and_then(Value::as_str).unwrap_or("");
                let f = encode_frame(s["kind"].as_str().unwrap(), code, &fields).unwrap();
                self.w.send_raw(C(vip, port), &f);
            }
            "text" => {
                let code = s.get("code").and_then(Value::as_str).unwrap_or("");
                let f = encode_frame_text(s["kind"].as_str().unwrap(), code, s["text"].as_str().unwrap()).unwrap();
                self.w.send_raw(C(vip, port), &f);
            }
            "data" => self.w.send_raw(C(vip, port), &unhex(s["hex"].as_str().unwrap())),
            "fin" => self.w.close(C(vip, port)),
            "rst" => self.w.rst(C(vip, port)),
            "frame" => self.w.raw(vip, &unhex(s["hex"].as_str().unwrap())),
            "seg" => {
                // a TCP segment of any op, to any port (kind 4 unless given)
                let kind = s.get("kind").and_then(Value::as_u64).unwrap_or(4) as u8;
                let f = lan_frame(
                    kind,
                    vip,
                    crate::VHOST_VIP,
                    port,
                    s["dport"].as_u64().unwrap() as u16,
                    s["tcp"].as_u64().unwrap() as u8,
                    s["cid"].as_u64().unwrap() as u32,
                    &unhex(s.get("hex").and_then(Value::as_str).unwrap_or("")),
                );
                self.w.raw(vip, &f);
            }
            "advance" => self.w.advance(s["ms"].as_f64().unwrap()),
            "sleep" => self.w.sleep(s["ms"].as_f64().unwrap()),
            "gone" => self.w.peer_gone(vip),
            "slow" => {
                if s["on"].as_bool().unwrap() {
                    self.w.slow.lock().insert(vip);
                } else {
                    self.w.slow.lock().remove(&vip);
                }
            }
            "info" => {
                let mut i = self.w.core.info();
                let mut v: Vec<u32> = self.w.core.vips().into_iter().collect();
                v.sort();
                i["vips"] = json!(v);
                extra = i;
            }
            "stop" => {
                self.w.core.stop();
                self.w.deliver();
            }
            "restart" => {
                let t = self.w.t.get();
                for (vip, cl) in &self.w.clients {
                    for (port, k) in &cl.conns {
                        self.old.insert((*vip, *port), k.msgs.clone());
                    }
                }
                let d = self.dir.as_ref().map(|d| d.path().to_path_buf());
                self.w = Run::world(&self.tr, d.as_deref(), t);
            }
            "friends" => {
                let owner = nfsu2_claims::owner_of_token(s["owner"].as_str().unwrap()).unwrap();
                let a = &s["ask"];
                let name = || a.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                let ask = match a["k"].as_str().unwrap() {
                    "List" => FriendAsk::List,
                    "ListMail" => FriendAsk::ListMail,
                    "Ask" => FriendAsk::Ask(name()),
                    "AskByName" => FriendAsk::AskByName(name()),
                    "Answer" => FriendAsk::Answer(name(), a["yes"].as_bool().unwrap()),
                    "Remove" => FriendAsk::Remove(name()),
                    "Block" => FriendAsk::Block(name()),
                    "Send" => FriendAsk::Send(name(), a["body"].as_str().unwrap().to_string()),
                    "Discord" => FriendAsk::Discord(a["typed"].as_str().unwrap().to_string()),
                    k => panic!("ask {k}"),
                };
                let group: Arc<str> = Arc::from(s["group"].as_str().unwrap());
                let r = self.w.core.friends(&owner, &group, ask);
                self.w.deliver();
                extra = json!({
                    "me": r.me, "done": r.done,
                    "friends": r.friends.iter().map(|f| json!({"name": f.name, "mutual": f.mutual, "online": f.online, "contact": f.contact})).collect::<Vec<_>>(),
                    "asks": r.asks, "sent": r.sent,
                    "mail": r.mail.iter().map(|m| json!({"from": m.from, "body": m.body, "t": m.t})).collect::<Vec<_>>(),
                    "contact": r.contact,
                });
            }
            "pageMail" => {
                let on = s["on"].as_bool().unwrap();
                let got = self.mail.clone();
                self.w.core.set_page_mail(Box::new(move |name: &str, m: &PageMail| {
                    got.lock().unwrap().push(json!([name, m.from, m.body, m.t]));
                    on
                }));
            }
            "files" => {
                extra = Value::Object(self.dir.as_ref().map(|d| files_of(d.path())).unwrap_or_default());
            }
            _ => panic!("op {op}"),
        }
        let mut out = self.drain();
        if !extra.is_null() {
            out["x"] = extra;
        }
        out
    }
}

/// one trace: its steps' outputs
pub fn run_trace(tr: &Value) -> Value {
    let dir = tr.get("state").filter(|s| !s.is_null()).map(|st| {
        let d = tempfile::tempdir().unwrap();
        for (k, v) in st.as_object().unwrap() {
            let p = d.path().join(k);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, v.as_str().unwrap()).unwrap();
        }
        d
    });
    // (seeded after the folder is made: tempfile takes its names from the same random bytes)
    let seed = tr["seed"].as_u64().unwrap();
    PRNG.with(|p| *p.borrow_mut() = Prng::new(seed));
    let t0 = tr.get("t0").and_then(Value::as_f64).unwrap_or(1_000_000.0);
    let w = Run::world(tr, dir.as_ref().map(|d| d.path()), t0);
    let mut run = Run { w, old: HashMap::new(), mail: Arc::default(), dir, tr: tr.clone() };
    let mut outs = vec![run.drain()];
    for s in tr["steps"].as_array().unwrap() {
        outs.push(run.step(s));
    }
    json!(outs)
}

#[test]
fn difftrace() {
    let Ok(inp) = std::env::var("DIFFTRACE_IN") else { return };
    let out = std::env::var("DIFFTRACE_OUT").expect("DIFFTRACE_OUT");
    let traces: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(inp).unwrap()).unwrap();
    let mut lines = String::new();
    for tr in &traces {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_trace(tr)));
        let v = match r {
            Ok(v) => v,
            Err(e) => {
                let what =
                    e.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| e.downcast_ref::<String>().cloned()).unwrap_or_default();
                json!({ "panic": what })
            }
        };
        lines.push_str(&serde_json::to_string(&v).unwrap());
        lines.push('\n');
    }
    std::fs::write(out, lines).unwrap();
}
