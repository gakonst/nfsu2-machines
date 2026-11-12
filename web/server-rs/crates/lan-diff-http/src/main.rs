//! Test only (web/worker/test/http-diff.test.mjs): reads JSON lines on stdin, one call each ({"fn": ..., args}), and
//! writes one JSON line per call with what the Rust code returns.  The server's own files are included as they are
//! (src/app/url.rs, etag.rs, settings_days.rs, manifest.rs), with the few crate items they name as shims; nothing of
//! theirs is changed.

#![allow(dead_code, unused_imports)]

use std::io::{BufRead, Write};

use serde_json::{Value, json};

/// shims for what the included files name as crate::...
mod options {
    /// options.rs within, as it is
    pub fn within(a: &str, b: &str) -> bool {
        let x = a.to_lowercase();
        let y = b.to_lowercase();
        x == y || x.starts_with(&if y.ends_with('/') { y.clone() } else { format!("{y}/") })
    }
}

mod blocks {
    /// blocks.rs V2, as it is
    pub const V2: &str = "/v2";
}
#[path = "../../../src/app/url.rs"]
mod url;
#[path = "../../../src/app/etag.rs"]
mod etag;
#[path = "../../../src/app/settings_days.rs"]
mod settings_days;
#[path = "../../../src/app/manifest.rs"]
mod manifest;

/// the included files as the calls below name them
mod app {
    pub(crate) use super::{etag, manifest, settings_days, url};
}

/// a request as nfsu2-headers reads it: from this machine (a trusted proxy), with these headers
struct FakeReq {
    headers: Vec<(String, String)>,
}

impl nfsu2_headers::Req for FakeReq {
    fn peer(&self) -> &str {
        "127.0.0.1"
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    fn encrypted(&self) -> bool {
        false
    }
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_string()
}
fn os(v: &Value, k: &str) -> Option<String> {
    v[k].as_str().map(str::to_string)
}
fn strs(v: &Value, k: &str) -> Vec<String> {
    v[k].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default()
}
fn pairs(h: Vec<(&str, String)>) -> Value {
    Value::Array(h.into_iter().map(|(k, v)| json!([k, v])).collect())
}

fn call(v: &Value) -> Value {
    match v["fn"].as_str().unwrap_or("") {
        "pick_encoding" => {
            let have = strs(v, "have");
            let have: Vec<&str> = have.iter().map(String::as_str).collect();
            json!(nfsu2_headers::pick_encoding(os(v, "header").as_deref(), &have))
        }
        "etag_matches" => json!(nfsu2_headers::etag_matches(os(v, "header").as_deref(), &s(v, "etag"))),
        "host_name" => json!(nfsu2_headers::host_name(&s(v, "h"))),
        "host_check" => {
            let c = nfsu2_headers::HostCheck::new(&strs(v, "names"));
            json!({ "check": c.check(os(v, "host").as_deref()), "names": c.names() })
        }
        "is_local_or_ip" => json!(nfsu2_headers::is_local_or_ip(os(v, "h").as_deref())),
        "address_key" => json!(nfsu2_headers::address_key(&s(v, "ip"))),
        "site_key" => json!(nfsu2_headers::site_key(&s(v, "ip"))),
        "bare_ip" => json!(nfsu2_headers::bare_ip(&s(v, "ip"))),
        "is_ip" => json!(nfsu2_headers::is_ip(&s(v, "ip"))),
        "security_headers" => pairs(nfsu2_headers::security_headers(v["hsts"].as_bool().unwrap_or(false), v["noindex"].as_bool().unwrap_or(false))),
        "cache_headers" => {
            let c = match v["kind"].as_str() {
                Some("store") => nfsu2_headers::Cache::Store,
                Some("revalidate") => nfsu2_headers::Cache::Revalidate,
                _ => nfsu2_headers::Cache::Immutable,
            };
            pairs(nfsu2_headers::cache_headers(c).into_iter().map(|(k, v)| (k, v.to_string())).collect())
        }
        "csp" => {
            let (a, b) = (strs(v, "script"), strs(v, "style"));
            let a: Vec<&str> = a.iter().map(String::as_str).collect();
            let b: Vec<&str> = b.iter().map(String::as_str).collect();
            json!({ "csp": nfsu2_headers::content_security_policy(&a, &b), "default": nfsu2_headers::CSP, "turnstile": nfsu2_headers::CSP_TURNSTILE, "pp": nfsu2_headers::PERMISSIONS_POLICY })
        }
        "client_country" => {
            let trust = nfsu2_headers::ProxyTrust::parse("").expect("loopback");
            let headers = os(v, "value").map(|c| vec![("cf-ipcountry".to_string(), c)]).unwrap_or_default();
            json!(nfsu2_headers::client_country(&FakeReq { headers }, &trust).map(|c| String::from_utf8_lossy(&c).into_owned()))
        }
        "pick_protocol" => match nfsu2_ws::pick_protocol(os(v, "header").as_deref()) {
            Ok(p) => json!({ "ok": true, "protocol": p }),
            Err(()) => json!({ "ok": false }),
        },
        "accept_key" => json!(nfsu2_ws::accept_key(&s(v, "key"))),
        "parse_target" => match app::url::parse_target(&s(v, "target")) {
            Some(u) => json!({ "host": u.host, "pathname": u.pathname, "query": u.query }),
            None => Value::Null,
        },
        "parse_absolute" => match app::url::parse_absolute(&s(v, "input")) {
            Some(u) => json!({ "host": u.host, "pathname": u.pathname, "query": u.query }),
            None => Value::Null,
        },
        "decode_uri_component" => json!(app::url::decode_uri_component(&s(v, "s"))),
        "params" => {
            let u = app::url::parse_target(&s(v, "target"));
            let names = strs(v, "names");
            json!(names.iter().map(|n| json!({ "get": u.as_ref().and_then(|u| u.param(n)), "has": u.as_ref().is_some_and(|u| u.has_param(n)) })).collect::<Vec<_>>())
        }
        "etag_of" => {
            let key: Vec<u8> = v["key"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
            let parts = strs(v, "parts");
            let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
            json!(app::etag::etag_of(&key, &parts))
        }
        // (the double's bits as a decimal string: serde_json's float parsing is not always the nearest double)
        "num" => json!(app::etag::num(f64::from_bits(s(v, "bits").parse::<u64>().expect("bits")))),
        "report" => json!(app::settings_days::Report::parse(os(v, "k").as_deref(), os(v, "s").as_deref()).map(|r| format!("{r:?}"))),
        "game_entry" => json!(app::manifest::game_entry(&s(v, "name"))),
        "manifest" => {
            let key: Vec<u8> = v["key"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
            match app::manifest::build(&s(v, "dir"), "/nonexistent-state", &key) {
                Ok(m) => json!({ "body": String::from_utf8_lossy(&m.body), "etag": m.etag, "count": m.count, "files": m.files }),
                Err(e) => json!({ "error": e.to_string() }),
            }
        }
        "budget" => {
            // a run of take/give/room on one Budget: each op's result
            let b = nfsu2_util::Budget::new(
                v["per"].as_u64().unwrap() as usize,
                v["per_site"].as_u64().unwrap() as usize,
                v["total"].as_u64().map_or(usize::MAX, |t| t as usize),
                v["free"].as_f64().unwrap(),
            );
            let out: Vec<Value> = v["ops"]
                .as_array()
                .unwrap()
                .iter()
                .map(|op| {
                    let (k, st) = (op[1].as_str().unwrap(), op[2].as_str().unwrap());
                    match op[0].as_str().unwrap() {
                        "take" => json!(b.take(k, st)),
                        "room" => json!(b.room(k, st)),
                        "give" => {
                            b.give(k, st);
                            json!([b.held(k), b.count()])
                        }
                        _ => Value::Null,
                    }
                })
                .collect();
            json!(out)
        }
        "bucket" => {
            let mut b = nfsu2_util::Bucket::with_burst_at(v["rate"].as_f64().unwrap(), v["burst"].as_f64().unwrap(), v["t0"].as_f64().unwrap());
            let out: Vec<Value> = v["ops"]
                .as_array()
                .unwrap()
                .iter()
                .map(|op| {
                    let (now, n) = (op[1].as_f64().unwrap(), op[2].as_f64().unwrap());
                    let r = match op[0].as_str().unwrap() {
                        "take" => b.take_at(now, n),
                        "spend" => b.spend_at(now, n),
                        _ => b.has_at(now, n),
                    };
                    json!([r, b.v, b.level_at(now + 250.0)])
                })
                .collect();
            json!(out)
        }
        f => json!({ "error": format!("no such fn: {f}") }),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line.expect("a line");
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line).expect("a JSON line");
        writeln!(out, "{}", nfsu2_util::json::stringify(&call(&v))).expect("write");
    }
    out.flush().expect("flush");
}
