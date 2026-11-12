//! Test-only: crates/lan/src/text.rs and plates.rs (private to the crate: included here by their paths) and the
//! nfsu2-util pieces they use, for the differential tests of their JavaScript ports (web/worker/src/switch/text.js,
//! plates.js, web/worker/src/util/json.js, js.js).  stdin: one JSON request per line ({"op": ..., ...}); stdout: one
//! JSON answer per line, {"r": ...}.  Bytes go as lowercase hex, doubles as the hex of their bits ("nan" for a NaN).

#![allow(dead_code)]

use std::io::{BufRead, Write};

use serde_json::{Value, json};

/// the switch's frame kind of a UDP datagram (lib.rs KIND_UDP), for plates.rs
const KIND_UDP: u8 = 1;
/// lib.rs slot, for text.rs's vip_num (the answers use nfsu2_lan::vip_num itself)
fn slot(vip: u32) -> Option<usize> {
    let host = vip & 255;
    let net = ((vip >> 8) & 255) as usize;
    if vip & 0xFFFF_0000 != (10 << 24) | (77 << 16) || net >= 96 || !(2..=251).contains(&host) {
        return None;
    }
    Some(net + 96 * (host as usize - 2))
}

#[path = "../src/plates.rs"]
mod plates;
#[path = "../src/text.rs"]
mod text;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex")).collect()
}

fn bits(f: f64) -> String {
    if f.is_nan() { "nan".into() } else { format!("{:016x}", f.to_bits()) }
}

/// a parsed value with nothing lost: numbers as their doubles' bits, strings and keys as their UTF-8, objects as
/// their entries in order
fn enc(v: &Value) -> Value {
    match v {
        Value::Null => Value::Null,
        Value::Bool(b) => json!(b),
        Value::Number(n) => json!({ "f": bits(n.as_f64().unwrap_or(f64::NAN)) }),
        Value::String(s) => json!({ "s": hex(s.as_bytes()) }),
        Value::Array(a) => Value::Array(a.iter().map(enc).collect()),
        Value::Object(m) => json!({ "o": m.iter().map(|(k, x)| json!([hex(k.as_bytes()), enc(x)])).collect::<Vec<_>>() }),
    }
}

fn found(f: &Option<plates::Found<'_>>) -> Value {
    match f {
        None => Value::Null,
        Some(plates::Found::Broken) => json!({ "kind": "broken" }),
        Some(plates::Found::Plate { at, plate, name }) => json!({ "kind": "plate", "at": at, "plate": hex(plate), "name": hex(name) }),
    }
}

fn verdict(v: &plates::Verdict) -> Value {
    match v {
        plates::Verdict::Go => json!({ "kind": "go" }),
        plates::Verdict::New => json!({ "kind": "new" }),
        plates::Verdict::Last(p) => json!({ "kind": "last", "last": hex(p) }),
        plates::Verdict::Slur { tell } => json!({ "kind": "slur", "tell": tell }),
    }
}

fn answer(q: &Value) -> Value {
    let s = || q["s"].as_str().expect("s").to_string();
    let b = || unhex(q["b"].as_str().expect("b"));
    match q["op"].as_str().expect("op") {
        "clean" => json!(nfsu2_lan::clean_name(&s())),
        "vip" => json!(nfsu2_lan::vip_num(&s())),
        "number" => json!(bits(text::to_number(&s()))),
        "hash" => json!(hex(&text::token_hash(&s()))),
        "fits" => {
            let h: [u8; 32] = unhex(q["h"].as_str().expect("h")).try_into().expect("32 bytes");
            json!(text::token_fits(&s(), &h))
        }
        "parse" => {
            let v = text::parse_json(&b());
            let js = v.as_ref().map(|v| text::js_string(Some(v)));
            let st = v.as_ref().map(nfsu2_util::json::stringify);
            let safe = v.as_ref().map(nfsu2_util::json::safe_integer);
            json!({ "v": v.as_ref().map(enc), "js": js, "json": st, "safe": safe })
        }
        "trim" => json!(nfsu2_util::js::trim(&s())),
        "collapse" => json!(nfsu2_util::js::collapse_space(&s(), q["rep"].as_str().unwrap_or(" "))),
        "utf16" => json!(nfsu2_util::js::utf16_len(&s())),
        "printable" => json!(nfsu2_util::js::printable(&s(), q["n"].as_u64().expect("n") as usize)),
        "numstr" => json!(nfsu2_util::js::number_to_string(f64::from_bits(u64::from_str_radix(q["f"].as_str().expect("f"), 16).expect("bits")))),
        "fixed" => json!(nfsu2_util::js::to_fixed(
            f64::from_bits(u64::from_str_radix(q["f"].as_str().expect("f"), 16).expect("bits")),
            q["d"].as_u64().expect("d") as usize
        )),
        "num" => {
            let v = nfsu2_util::json::num(f64::from_bits(u64::from_str_radix(q["f"].as_str().expect("f"), 16).expect("bits")));
            json!({ "v": enc(&v), "json": nfsu2_util::json::stringify(&v) })
        }
        "iso" => json!(nfsu2_util::js::iso_string(q["ms"].as_i64().expect("ms"))),
        "b64" => json!(nfsu2_util::js::base64url(&b())),
        "unb64" => json!(hex(&nfsu2_util::js::from_base64url(&s()))),
        "vipstr" => json!(nfsu2_util::vip_str(q["v"].as_u64().expect("v") as u32)),
        "writestr" => {
            let mut o = String::new();
            nfsu2_util::json::write_str(&mut o, &s());
            json!(o)
        }
        "plate" => {
            let f = b();
            let p = plates::hello_plate(&f);
            let at = match &p {
                Some(plates::Found::Plate { at, .. }) => Some(*at),
                _ => None,
            };
            let other = q["p"].as_str().map(unhex);
            let rw = |at: Option<usize>, pl: Option<&[u8]>| plates::rewrite(&f, at, pl).map(|x| hex(&x));
            json!({
                "found": found(&p),
                "intact": plates::intact(&f),
                "ok": plates::ok(f.get(16..).unwrap_or(&[])),
                "same": rw(at, other.as_deref()),
                "none": rw(at, None),
                "empty": rw(at, Some(&[])),
                "bare": rw(None, None),
                "atq": q["at"].as_u64().map(|a| rw(Some(a as usize), other.as_deref())),
            })
        }
        "judge" => {
            let seen = parking_lot::Mutex::new(plates::Seen::default());
            let out: Vec<Value> = q["seq"]
                .as_array()
                .expect("seq")
                .iter()
                .map(|x| verdict(&plates::judge(&seen, &unhex(x[0].as_str().expect("plate")), x[1].as_i64().expect("now"))))
                .collect();
            json!(out)
        }
        op => panic!("no op {op}"),
    }
}

fn main() {
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        if line.is_empty() {
            continue;
        }
        let q: Value = serde_json::from_str(&line).expect("a JSON request per line");
        writeln!(out, "{}", json!({ "r": answer(&q) })).expect("stdout");
    }
}

