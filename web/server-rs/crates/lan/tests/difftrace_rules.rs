//! Differential trace replay for the switch's rules (test-only, for the Workers port in web/worker): like
//! difftrace_switch.rs (same trace format and fake browsers over in-memory duplex streams), with what the harness's
//! serve() adds to a connection (tests/harness/mod.rs: ?ident, ?refuse, ?gate, ?rename, ?norace and the keyphrase's
//! owner "owner-<claim>"), recording hosts on the Online address (10.77.0.1, listed) and the hub's (10.77.0.253) that
//! keep every call the switch makes of them (frame, peer_gone, blocks, page_name), the switch's tap, the operator's
//! set_races, and the peer view at the end.  web/worker/test/switch/rules_diff.test.mjs replays the same trace into the
//! JavaScript switch and compares.  Skipped (passes) when $DIFFTRACE_RULES_IN is not set.
//!
//! Trace: {"options": {snake_case LanOptions}, "hosts": true, "steps": [
//!   {"op":"connect","id":0,"resume":false,"queue":false,"group":"g0","site":null,"ident":null,"refuse":null,
//!    "gate":null,"rename":null,"norace":null},
//!   {"op":"text",...}, {"op":"binary",...}, {"op":"close",...}, {"op":"drop",...}, {"op":"expel",...} (as difftrace),
//!   {"op":"races","id":0,"off":true,"msg":"..."}, {"op":"wait","ms":10}]}

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use nfsu2_lan::{AttachOpts, HelloAnswer, LanOptions, LanSwitch};
use nfsu2_util::{FrameCtx, Host};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::oneshot;

#[derive(Default)]
struct Got {
    msgs: Vec<Value>,
    vip: u32,
    token: String,
    ticket: String,
    ended: bool,
}

struct Client {
    w: Arc<tokio::sync::Mutex<Option<WriteHalf<DuplexStream>>>>,
    got: Arc<Mutex<Got>>,
}

type Events = Arc<Mutex<Vec<Value>>>;

/// a host that keeps every call of the switch's
struct Rec {
    vip: u32,
    name: &'static str,
    listed: bool,
    tag: &'static str,
    ev: Events,
}

impl Host for Rec {
    fn vip(&self) -> u32 {
        self.vip
    }
    fn name(&self) -> &str {
        self.name
    }
    fn listed(&self) -> bool {
        self.listed
    }
    fn frame(&self, from: u32, data: Bytes, ctx: FrameCtx) {
        self.ev.lock().unwrap().push(json!({
            "h": self.tag, "ev": "frame", "from": from, "hex": hex(&data), "group": &*ctx.group,
            "site": ctx.site.as_deref(), "owner": ctx.owner.as_deref(), "no_races": ctx.no_races, "cause": ctx.cause.is_some(),
        }));
    }
    fn peer_gone(&self, vip: u32) {
        self.ev.lock().unwrap().push(json!({ "h": self.tag, "ev": "gone", "vip": vip }));
    }
    fn info(&self) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        let _ = tx.send(json!({}));
        rx
    }
    fn vips(&self) -> oneshot::Receiver<HashSet<u32>> {
        let (tx, rx) = oneshot::channel();
        let _ = tx.send(HashSet::new());
        rx
    }
    fn blocks(&self, vip: u32, names: Vec<String>) {
        self.ev.lock().unwrap().push(json!({ "h": self.tag, "ev": "blocks", "vip": vip, "names": names }));
    }
    fn page_name(&self, vip: u32, name: &str) {
        self.ev.lock().unwrap().push(json!({ "h": self.tag, "ev": "name", "vip": vip, "name": name }));
    }
    fn stop(&self) {}
}

fn opts_of(v: &Value) -> LanOptions {
    let mut o = LanOptions::default();
    let Some(m) = v.as_object() else { return o };
    macro_rules! u { ($($f:ident),*) => { $( if let Some(x) = m.get(stringify!($f)).and_then(Value::as_u64) { o.$f = x as _; } )* } }
    macro_rules! f { ($($f:ident),*) => { $( if let Some(x) = m.get(stringify!($f)).and_then(Value::as_f64) { o.$f = x; } )* } }
    macro_rules! b { ($($f:ident),*) => { $( if let Some(x) = m.get(stringify!($f)).and_then(Value::as_bool) { o.$f = x; } )* } }
    u!(max_peers, max_waiting, line_tell_ms, max_frame, max_bundle, max_text, shed_queue, roam_queue, stream_queue, stream_share,
       send_buffer, keepalive_ms, probe_ms, idle_ms, reserve_ms, group_reserve, site_reserve, resume_wait_ms, online_queue, peers_ms,
       bundle_ms, bundle_max_ms, bundle_budget, away_ms, lan_ms, send_buffer_os, max_payload);
    f!(frame_rate, byte_rate, group_frame_rate, group_byte_rate, site_frame_rate, site_byte_rate, text_rate, ctl_rate, stall_ms, bundle_jitter);
    b!(fpred, probe_echo);
    o
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// a masked client frame (mask key 0: the payload as it is)
fn frame(op: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = vec![0x80 | op];
    let n = payload.len();
    if n < 126 {
        f.push(0x80 | n as u8);
    } else if n < 65536 {
        f.push(0x80 | 126);
        f.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        f.push(0x80 | 127);
        f.extend_from_slice(&(n as u64).to_be_bytes());
    }
    f.extend_from_slice(&[0, 0, 0, 0]);
    f.extend_from_slice(payload);
    f
}

async fn read_loop(mut r: ReadHalf<DuplexStream>, w: Arc<tokio::sync::Mutex<Option<WriteHalf<DuplexStream>>>>, got: Arc<Mutex<Got>>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = vec![0u8; 65536];
    loop {
        loop {
            if buf.len() < 2 {
                break;
            }
            let op = buf[0] & 15;
            let mut len = (buf[1] & 127) as usize;
            let mut at = 2;
            if len == 126 {
                if buf.len() < 4 {
                    break;
                }
                len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
                at = 4;
            } else if len == 127 {
                if buf.len() < 10 {
                    break;
                }
                len = u64::from_be_bytes(buf[2..10].try_into().unwrap()) as usize;
                at = 10;
            }
            if buf.len() < at + len {
                break;
            }
            let p = buf[at..at + len].to_vec();
            buf.drain(..at + len);
            let reply: Option<(u8, Vec<u8>, bool)> = {
                let mut g = got.lock().unwrap();
                match op {
                    1 => {
                        let t = String::from_utf8_lossy(&p).to_string();
                        if let Ok(v) = serde_json::from_str::<Value>(&t) {
                            if v["t"] == "welcome" {
                                g.vip = v["vip"].as_u64().unwrap_or(0) as u32;
                                g.token = v["token"].as_str().unwrap_or("").to_string();
                            }
                            if v["t"] == "queue" {
                                if let Some(tk) = v["ticket"].as_str() {
                                    g.ticket = tk.to_string();
                                }
                            }
                        }
                        g.msgs.push(json!({"op": "text", "text": t}));
                        None
                    }
                    2 => {
                        g.msgs.push(json!({"op": "binary", "hex": hex(&p)}));
                        None
                    }
                    8 => {
                        let code = if p.len() >= 2 { u16::from_be_bytes([p[0], p[1]]) as u64 } else { 1005 };
                        let reason = String::from_utf8_lossy(p.get(2..).unwrap_or(&[])).to_string();
                        g.msgs.push(json!({"op": "close", "code": code, "reason": reason}));
                        Some((8, p.clone(), true))
                    }
                    9 => Some((10, p.clone(), false)),
                    _ => None,
                }
            };
            if let Some((rop, rp, end)) = reply {
                let mut wl = w.lock().await;
                if end {
                    if let Some(mut wh) = wl.take() {
                        let _ = wh.write_all(&frame(rop, &rp)).await;
                        let _ = wh.shutdown().await;
                    }
                } else if let Some(wh) = wl.as_mut() {
                    let _ = wh.write_all(&frame(rop, &rp)).await;
                }
            }
        }
        match r.read(&mut tmp).await {
            Ok(0) | Err(_) => {
                got.lock().unwrap().ended = true;
                return;
            }
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
    }
}

fn subst(s: &str, clients: &HashMap<u64, Client>) -> String {
    let mut out = s.to_string();
    for (id, c) in clients {
        let g = c.got.lock().unwrap();
        out = out.replace(&format!("@TOKEN{id}@"), &g.token);
        out = out.replace(&format!("@TICKET{id}@"), &g.ticket);
        out = out.replace(&format!("@VIPN{id}@"), &g.vip.to_string());
        out = out.replace(&format!("@VIP{id}@"), &nfsu2_util::vip_str(g.vip));
    }
    out
}

#[tokio::test]
async fn difftrace_rules() {
    let Ok(path) = std::env::var("DIFFTRACE_RULES_IN") else { return };
    let out_path = std::env::var("DIFFTRACE_RULES_OUT").expect("DIFFTRACE_RULES_OUT");
    let input: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let out = match &input {
        Value::Array(traces) => {
            let mut v = Vec::new();
            for t in traces {
                v.push(run_one(t).await);
            }
            Value::Array(v)
        }
        t => run_one(t).await,
    };
    std::fs::write(out_path, out.to_string()).unwrap();
}

async fn run_one(trace: &Value) -> Value {
    let ev: Events = Arc::new(Mutex::new(Vec::new()));
    let tapped: Events = Arc::new(Mutex::new(Vec::new()));
    let hosts = trace["hosts"].as_bool().unwrap_or(false);
    let online: Option<Arc<dyn Host>> =
        hosts.then(|| Arc::new(Rec { vip: 0x0A4D_0001, name: "NFSU2 Online", listed: true, tag: "online", ev: ev.clone() }) as Arc<dyn Host>);
    let roam: Option<Arc<dyn Host>> =
        hosts.then(|| Arc::new(Rec { vip: 0x0A4D_00FD, name: "hub", listed: false, tag: "roam", ev: ev.clone() }) as Arc<dyn Host>);
    let t2 = tapped.clone();
    let tap: nfsu2_util::host::Tap = Arc::new(move |b: &[u8]| t2.lock().unwrap().push(Value::String(hex(b))));
    let sw = LanSwitch::new(opts_of(&trace["options"]), "", online, roam, Some(tap), None);
    let mut clients: HashMap<u64, Client> = HashMap::new();
    let mut order: Vec<u64> = Vec::new();
    let settle = trace["settle_ms"].as_u64().unwrap_or(3);
    for st in trace["steps"].as_array().unwrap() {
        let id = st["id"].as_u64().unwrap_or(0);
        match st["op"].as_str().unwrap() {
            "connect" => {
                let (a, b) = tokio::io::duplex(1 << 20);
                let (sr, sw_) = tokio::io::split(a);
                let (cr, cw) = tokio::io::split(b);
                let w = Arc::new(tokio::sync::Mutex::new(Some(cw)));
                let got = Arc::new(Mutex::new(Got::default()));
                tokio::spawn(read_loop(cr, w.clone(), got.clone()));
                let s = |k: &str| st[k].as_str().map(str::to_string);
                // as the harness's serve() answers a hello
                let (gate, rename, norace) = (s("gate"), s("rename"), s("norace"));
                let on_hello: Option<nfsu2_lan::OnHello> = (gate.is_some() || rename.is_some() || norace.is_some()).then(|| {
                    Box::new(move |h: &nfsu2_lan::Hello| {
                        let mut a = HelloAnswer::default();
                        if let Some(hit) = gate.as_deref().and_then(|g| h.ids.iter().copied().chain(h.owner).find(|x| *x == g)) {
                            a.refuse = Some((Bytes::from(json!({ "t": "ban", "msg": hit, "ids": h.ids }).to_string()), nfsu2_lan::CLOSE_BANNED));
                        } else if rename.as_deref() == Some(h.name) {
                            a.refuse = Some((Bytes::from(json!({ "t": "rename", "name": h.name }).to_string()), nfsu2_lan::CLOSE_RENAME));
                        } else if norace.as_deref().is_some_and(|n| h.ids.contains(&n)) {
                            a.no_races = Some(Bytes::from(json!({ "t": "races", "msg": "no" }).to_string()));
                        }
                        a
                    }) as nfsu2_lan::OnHello
                });
                let on_claim: nfsu2_lan::OnClaim = Box::new(|c| Some(format!("owner-{c}").into()));
                sw.attach(sr, sw_, Bytes::new(), AttachOpts {
                    resume: st["resume"].as_bool().unwrap_or(false),
                    queue: st["queue"].as_bool().unwrap_or(false),
                    group: s("group"),
                    site: s("site"),
                    ident: s("ident"),
                    refuse: s("refuse").map(|v| Bytes::from(json!({ "t": "ban", "msg": v }).to_string())),
                    on_hello,
                    on_claim: Some(on_claim),
                    ..AttachOpts::default()
                });
                clients.insert(id, Client { w, got });
                order.push(id);
            }
            "text" => {
                let t = subst(st["text"].as_str().unwrap(), &clients);
                let c = &clients[&id];
                if let Some(wh) = c.w.lock().await.as_mut() {
                    let _ = wh.write_all(&frame(1, t.as_bytes())).await;
                }
            }
            "binary" => {
                let mut b = unhex(st["hex"].as_str().unwrap());
                if let Some(d) = st["dst"].as_array() {
                    for e in d {
                        let (off, who) = (e[0].as_u64().unwrap() as usize, e[1].as_u64().unwrap());
                        let v = clients.get(&who).map_or(0, |c| c.got.lock().unwrap().vip);
                        b[off..off + 4].copy_from_slice(&v.to_be_bytes());
                    }
                }
                let c = &clients[&id];
                if let Some(wh) = c.w.lock().await.as_mut() {
                    let _ = wh.write_all(&frame(2, &b)).await;
                }
            }
            "close" => {
                let code = st["code"].as_u64().unwrap_or(1000) as u16;
                let mut p = code.to_be_bytes().to_vec();
                p.extend_from_slice(st["reason"].as_str().unwrap_or("").as_bytes());
                let c = &clients[&id];
                if let Some(wh) = c.w.lock().await.as_mut() {
                    let _ = wh.write_all(&frame(8, &p)).await;
                }
            }
            "drop" => {
                let c = &clients[&id];
                if let Some(mut wh) = c.w.lock().await.take() {
                    let _ = wh.shutdown().await;
                }
            }
            "expel" => {
                let vip = clients[&id].got.lock().unwrap().vip;
                let msg = st["msg"].as_str().unwrap_or("").to_string();
                sw.expel(vip, Bytes::from(msg), st["code"].as_u64().unwrap_or(4001) as u16);
            }
            "races" => {
                let vip = clients[&id].got.lock().unwrap().vip;
                let msg = st["msg"].as_str().unwrap_or("").to_string();
                sw.set_races(vip, st["off"].as_bool().unwrap_or(true), Bytes::from(msg));
            }
            "wait" => {
                tokio::time::sleep(Duration::from_millis(st["ms"].as_u64().unwrap())).await;
                continue;
            }
            o => panic!("unknown op {o}"),
        }
        tokio::time::sleep(Duration::from_millis(settle)).await;
    }
    tokio::time::sleep(Duration::from_millis(trace["end_ms"].as_u64().unwrap_or(200))).await;
    let cl: Vec<Value> = order
        .iter()
        .map(|id| {
            let g = clients[id].got.lock().unwrap();
            json!({"id": id, "msgs": g.msgs, "ended": g.ended})
        })
        .collect();
    let mut info = sw.info().await;
    if let Some(m) = info.as_object_mut() {
        m.remove("online");
        m.remove("roam");
    }
    let peers: Vec<Value> = sw
        .peers_view()
        .iter()
        .map(|p| json!({ "vip": p.vip, "name": p.name, "hello": p.hello, "bundle": p.bundle, "lan": p.lan, "open": p.open }))
        .collect();
    let out = json!({
        "clients": cl, "info": info, "reserved": sw.reserved_view().len(), "peers": peers,
        "hosts": ev.lock().unwrap().clone(), "tap": tapped.lock().unwrap().clone(),
    });
    sw.stop();
    sw.terminate_all();
    tokio::time::sleep(Duration::from_millis(20)).await;
    out
}
