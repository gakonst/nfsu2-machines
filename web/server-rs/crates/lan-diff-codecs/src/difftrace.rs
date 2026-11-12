//! The driver: one JSON line in, one out (see lib.rs).
use std::collections::HashMap;
use std::io::{BufRead, Write};

use serde_json::{Value, json};

use crate::compact::{self, Refs, TIMED_MAX};
use crate::fpred::{self, Fpred, NF};
use crate::mix;

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "odd hex");
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn u32_of(v: &Value) -> u32 {
    v.as_u64().expect("a u32") as u32
}
fn f64_bits(v: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v.as_str().expect("f64 bits as hex"), 16).unwrap())
}
fn u64s(v: &Value) -> Vec<u64> {
    v.as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect()
}
fn opt_u32(v: &Value) -> Option<u32> {
    v.as_u64().map(|x| x as u32)
}

fn one(q: &Value) -> Value {
    match q["op"].as_str().unwrap() {
        "frame" => {
            let f = unhex(q["f"].as_str().unwrap());
            let (src, dst, own, us) = (u32_of(&q["src"]), u32_of(&q["dst"]), u32_of(&q["own"]), u32_of(&q["us"]));
            let raw = json!({
                "kr": mix::of_entry(&f, src, dst),
                "kp": mix::of_page(&f, dst),
                "kh": mix::of_host(&f, opt_u32(&q["roam"]), opt_u32(&q["online"])),
            });
            if f.len() < 2 {
                return raw;
            }
            let m = compact::mark(&f);
            let mut into = [0u8; TIMED_MAX];
            let w = compact::waited(&m, us, &mut into).to_vec();
            // (a frame under 12 bytes goes whole, and with_addrs panics on it: the reader never takes one)
            let plain = (f.len() >= 12).then(|| {
                let mut plain = Vec::new();
                compact::entry(&mut plain, &m, src, dst, own, None);
                hex(&plain)
            });
            let mut r = raw;
            r["m"] = json!(hex(&m));
            r["timed"] = json!(compact::timed(&m));
            r["w"] = json!(hex(&w));
            r["len"] = json!(compact::entry_len(&m, src, dst, own));
            r["e"] = json!(plain);
            r["k"] = json!(mix::of_entry(&m, src, dst));
            r
        }
        "stream" => {
            let own = u32_of(&q["own"]);
            let (use_refs, use_fp, others) = (q["refs"].as_bool().unwrap(), q["fp"].as_bool().unwrap(), q["others"].as_bool().unwrap());
            let cut = q["cut"].as_u64().unwrap() as usize;
            let (mut refs, mut fp) = (Refs::default(), Fpred::default());
            let mut into = [0u8; TIMED_MAX];
            let mut entries = Vec::new();
            let mut kinds = Vec::new();
            let mut bundles = Vec::new();
            let mut b = vec![compact::KIND_COMPACT, 0, 0, 0];
            for it in q["frames"].as_array().unwrap() {
                let f = unhex(it[0].as_str().unwrap());
                let (src, dst, us) = (u32_of(&it[1]), u32_of(&it[2]), u32_of(&it[3]));
                let m = compact::mark(&f);
                let d = compact::waited(&m, us, &mut into).to_vec();
                let at = b.len();
                compact::entry_fp(
                    &mut b,
                    &d,
                    src,
                    dst,
                    own,
                    use_refs.then_some(&mut refs),
                    use_fp.then_some(&mut fp),
                    others,
                );
                entries.push(hex(&b[at..]));
                kinds.push(mix::of_entry(&d, src, dst));
                if b.len() > cut {
                    bundles.push(std::mem::replace(&mut b, vec![compact::KIND_COMPACT, 0, 0, 0]));
                }
            }
            bundles.push(b);
            let (mut page, mut page_fp, mut page_others) = (HashMap::new(), Fpred::default(), HashMap::new());
            let mut got = Vec::new();
            for b in &bundles {
                for f in compact::tests::unpack_all(
                    b,
                    own,
                    use_refs.then_some(&mut page),
                    use_fp.then_some(&mut page_fp),
                    others.then_some(&mut page_others),
                ) {
                    got.push(hex(&f));
                }
            }
            json!({ "entries": entries, "kinds": kinds, "unpacked": got })
        }
        "fpred" => {
            let (mut enc, mut dec) = (Fpred::default(), Fpred::default());
            let out: Vec<Value> = q["bodies"]
                .as_array()
                .unwrap()
                .iter()
                .map(|it| {
                    let src = it[0].as_u64().unwrap() as u16;
                    let b = unhex(it[1].as_str().unwrap());
                    let Some(v) = fpred::fields(&b) else { return json!({ "fields": null, "rounded": fpred::rounded(&b).map(|r| hex(&r)) }) };
                    let mut buf = Vec::new();
                    let ok = enc.encode(&mut buf, src, &v);
                    let dec_body = if ok { dec.decode(src, &buf[4..]).map(|d| hex(&d)) } else { None };
                    json!({
                        "fields": v.to_vec(),
                        "rounded": fpred::rounded(&b).map(|r| hex(&r)),
                        "enc": ok.then(|| hex(&buf)),
                        "dec": dec_body,
                    })
                })
                .collect();
            json!(out)
        }
        "fpenc" => {
            let mut enc = Fpred::default();
            let out: Vec<Value> = q["states"]
                .as_array()
                .unwrap()
                .iter()
                .map(|it| {
                    let src = it[0].as_u64().unwrap() as u16;
                    let vs: Vec<i64> = it[1].as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
                    let mut v = [0i64; NF];
                    v.copy_from_slice(&vs);
                    let mut buf = vec![0xEE];
                    let ok = enc.encode(&mut buf, src, &v);
                    let mut w = Vec::new();
                    let wrote = fpred::write(&v, &mut w);
                    json!({ "enc": ok.then(|| hex(&buf[1..])), "write": wrote.then(|| hex(&w)) })
                })
                .collect();
            json!(out)
        }
        "fpdec" => {
            let mut dec = Fpred::default();
            let out: Vec<Value> = q["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|it| {
                    let src = it[0].as_u64().unwrap() as u16;
                    let e = unhex(it[1].as_str().unwrap());
                    json!(dec.decode(src, &e).map(|d| hex(&d)))
                })
                .collect();
            json!(out)
        }
        "names" => json!((0..mix::KINDS).map(mix::name).collect::<Vec<_>>()),
        "line" => json!(mix::line(&u64s(&q["now"]), &u64s(&q["was"]), f64_bits(&q["secs"]))),
        "msgline" => json!(mix::msg_line(&u64s(&q["now"]), &u64s(&q["was"]), f64_bits(&q["secs"]))),
        "kindsline" => {
            let kinds: Vec<crate::KindMsgs> = q["kinds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| crate::KindMsgs {
                    kind: Box::leak(k[0].as_str().unwrap().to_string().into_boxed_str()),
                    players: k[1].as_u64().unwrap() as usize,
                    msgs_in: k[2].as_u64().unwrap(),
                    msgs_out: k[3].as_u64().unwrap(),
                })
                .collect();
            json!(mix::kinds_line(&kinds, f64_bits(&q["secs"])))
        }
        "fmt" => {
            // Rust's {:.0} and {:.1} of f64s, as mix.rs's lines use them
            let xs: Vec<Value> = q["xs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| {
                    let x = f64_bits(x);
                    json!([format!("{x:.0}"), format!("{x:.1}")])
                })
                .collect();
            json!(xs)
        }
        op => panic!("unknown op {op}"),
    }
}

#[test]
#[ignore]
fn difftrace() {
    let (Ok(inp), Ok(outp)) = (std::env::var("DIFFTRACE_IN"), std::env::var("DIFFTRACE_OUT")) else {
        panic!("DIFFTRACE_IN and DIFFTRACE_OUT: the files of JSON lines")
    };
    let r = std::io::BufReader::new(std::fs::File::open(inp).unwrap());
    let mut w = std::io::BufWriter::new(std::fs::File::create(outp).unwrap());
    for line in r.lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let q: Value = serde_json::from_str(&line).unwrap();
        writeln!(w, "{}", one(&q)).unwrap();
    }
    w.flush().unwrap();
}
