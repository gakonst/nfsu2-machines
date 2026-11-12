//! Reads a trace (test/roam/difftrace_watch.mjs writes it: one op a line, floats as their bits in hex, strings as
//! 's' and their UTF-8 in hex) and prints what the server's watch.rs and results.rs make of it, a JSON array a line.
#![allow(dead_code)]

#[path = "../../../../../server-rs/crates/roam/src/jumps.rs"]
mod jumps;
#[path = "../../../../../server-rs/crates/roam/src/results.rs"]
mod results;
#[path = "../../../../../server-rs/crates/roam/src/watch.rs"]
mod watch;
mod wire;

use std::collections::HashMap;
use std::io::{BufRead, BufWriter, Write};
use std::sync::Arc;

use results::{OwnGame, Results, Verdict, jump_line, line as verdict_line, result_line};
use watch::{Near, Seen, Watch};
use wire::{LOBBY_PLAYERS, RaceRes, ResRow};

fn f(x: f64) -> String {
    if x.is_nan() { "\"NaN\"".into() } else { format!("\"{:016x}\"", x.to_bits()) }
}

fn of(x: Option<f64>) -> String {
    x.map_or("null".into(), f)
}

fn js(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o += "\\\"",
            '\\' => o += "\\\\",
            c if (c as u32) < 0x20 => o += &format!("\\u{:04x}", c as u32),
            c => o.push(c),
        }
    }
    o + "\""
}

fn p3(p: &[f64; 3]) -> String {
    format!("[{},{},{}]", f(p[0]), f(p[1]), f(p[2]))
}

fn seen(s: &Option<Seen>) -> String {
    match s {
        None => "null".into(),
        Some(Seen::Jump { from, to, d, ms, over }) => format!("[\"jump\",{},{},{},{},{}]", p3(from), p3(to), f(*d), f(*ms), f(*over)),
        Some(Seen::Fast { from, to, mps, ms }) => format!("[\"fast\",{},{},{},{}]", p3(from), p3(to), f(*mps), f(*ms)),
        Some(Seen::Clock { rate, ms }) => format!("[\"clock\",{},{}]", f(*rate), f(*ms)),
    }
}

fn names(m: &HashMap<u32, String>) -> String {
    let mut v: Vec<(&u32, &String)> = m.iter().collect();
    v.sort();
    format!("[{}]", v.iter().map(|(k, n)| format!("[{k},{}]", js(n))).collect::<Vec<_>>().join(","))
}

struct Toks<'a>(std::str::SplitAsciiWhitespace<'a>);

impl Toks<'_> {
    fn t(&mut self) -> &str {
        self.0.next().expect("a token")
    }
    fn u(&mut self) -> u64 {
        self.t().parse().expect("an integer")
    }
    fn f(&mut self) -> f64 {
        f64::from_bits(u64::from_str_radix(self.t(), 16).expect("bits"))
    }
    fn s(&mut self) -> String {
        let t = self.t();
        let h = t.strip_prefix('s').expect("a string");
        let b: Vec<u8> = (0..h.len() / 2).map(|k| u8::from_str_radix(&h[2 * k..2 * k + 2], 16).unwrap()).collect();
        String::from_utf8(b).expect("utf-8")
    }
    fn opt_s(&mut self) -> Option<String> {
        if self.0.clone().next() == Some("-") {
            self.t();
            None
        } else {
            Some(self.s())
        }
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("the trace's path");
    let file = std::io::BufReader::new(std::fs::File::open(path).expect("the trace"));
    let out = std::io::stdout();
    let mut o = BufWriter::new(out.lock());
    let mut watches: HashMap<u64, Watch> = HashMap::new();
    let mut res = Results::default();
    let mut who: HashMap<u32, String> = HashMap::new();
    for l in file.lines() {
        let l = l.unwrap();
        let mut t = Toks(l.split_ascii_whitespace());
        let Some(op) = t.0.next() else { continue };
        match op {
            "case" => {
                let seed = t.u();
                watches.clear();
                res = Results::default();
                who.clear();
                writeln!(o, "[\"case\",{seed}]").unwrap();
            }
            "wnew" => {
                let i = t.u();
                let now = t.f();
                watches.insert(i, Watch::new(now));
            }
            "reset" => watches.get_mut(&t.u()).unwrap().reset(),
            // a SNAP, and as the hub does with what it showed: a line if one may tell it (the near ones given)
            "snap" => {
                let i = t.u();
                let (now, p) = (t.f(), [t.f(), t.f(), t.f()]);
                let (t_us, clock, beside) = (t.u() as u32, t.u() as u8, t.u() != 0);
                let (vip, name, all, lobby) = (t.u() as u32, t.s(), t.u() as usize, t.opt_s());
                let np = t.u();
                let players: Vec<(f64, String, u32)> = (0..np).map(|_| (t.f(), t.s(), t.u() as u32)).collect();
                let w = watches.get_mut(&i).unwrap();
                let got = w.snap(now, p, t_us, clock, beside);
                writeln!(o, "[\"snap\",{i},{},{}]", seen(&got[0]), seen(&got[1])).unwrap();
                for s in got.iter().flatten() {
                    if matches!(s, Seen::Jump { .. }) && !players.is_empty() {
                        w.landed_near();
                    }
                    let may = w.line(now);
                    writeln!(o, "[\"may\",{}]", may.map_or("null".into(), |b| b.to_string())).unwrap();
                    if let Some(last) = may {
                        let near = Near { players: &players, all, lobby: lobby.as_deref() };
                        writeln!(o, "[\"line\",{}]", js(&watch::line(vip, &name, s, &near, w.jumps, last))).unwrap();
                    }
                }
            }
            "sum" => {
                let i = t.u();
                let (vip, name, now, left) = (t.u() as u32, t.s(), t.f(), t.u() != 0);
                let w = watches.get_mut(&i).unwrap();
                let s = w.summary(vip, &name, now, left);
                writeln!(o, "[\"sum\",{i},{},{}]", s.map_or("null".into(), |s| js(&s)), w.jumps).unwrap();
            }
            "wline" => {
                let i = t.u();
                let now = t.f();
                let may = watches.get_mut(&i).unwrap().line(now);
                writeln!(o, "[\"wline\",{}]", may.map_or("null".into(), |b| b.to_string())).unwrap();
            }
            "dist" => {
                let (a, b) = ([t.f(), t.f(), t.f()], [t.f(), t.f(), t.f()]);
                writeln!(o, "[\"dist\",{}]", f(watch::distance(&a, &b))).unwrap();
            }
            "who" => {
                let id = t.u() as u32;
                match t.opt_s() {
                    Some(n) => who.insert(id, n),
                    None => who.remove(&id),
                };
            }
            "add" => {
                let (now, reporter, client) = (t.f(), t.u() as u32, t.s());
                let (lobby, race, mode, laps, heat, heats, n) =
                    (t.u() as u32, t.u() as u32, t.u() as u8, t.u() as u8, t.u() as u8, t.u() as u8, t.u() as usize);
                let mut rows = [ResRow::default(); LOBBY_PLAYERS];
                for r in &mut rows {
                    *r = ResRow { id: t.u() as u32, flags: t.u() as u8, time: t.f(), done: t.f(), dist: t.f(), jump: t.f() };
                }
                let rr = RaceRes { lobby, race, mode, laps, heat, heats, n, rows };
                let ok = res.add(now, reporter, Arc::from(client.as_str()), rr, &|id| who.get(&id).cloned());
                writeln!(o, "[\"add\",{ok}]").unwrap();
            }
            "judged" => {
                let now = t.f();
                let j = res.judged(now);
                writeln!(o, "[\"judged\",{}]", j.len()).unwrap();
                for (oc, v) in &j {
                    let by = |id: u32| oc.names.get(&id).cloned().unwrap_or_else(|| format!("{id:08x}"));
                    let order: Vec<String> = oc.order.iter().map(|(id, t)| format!("[{id},{}]", of(*t))).collect();
                    let jumps: Vec<String> = oc
                        .jumps
                        .iter()
                        .map(|x| {
                            let s: Vec<String> = x.seen.iter().map(|m| f(*m)).collect();
                            format!("[{},[{}],{},{}]", x.id, s.join(","), x.others, x.place.map_or("null".into(), |p| p.to_string()))
                        })
                        .collect();
                    writeln!(
                        o,
                        "[\"outcome\",{},{},{},{},{},{},[{}],{:?},{},{},{},[{}]]",
                        oc.lobby,
                        oc.race,
                        oc.mode,
                        oc.laps,
                        oc.heat,
                        oc.heats,
                        order.join(","),
                        oc.silent,
                        oc.reports,
                        oc.racers,
                        names(&oc.names),
                        jumps.join(",")
                    )
                    .unwrap();
                    writeln!(o, "[\"race\",{}]", js(&result_line(oc, &by))).unwrap();
                    for x in &oc.jumps {
                        writeln!(o, "[\"jumpline\",{}]", js(&jump_line(oc, x, &by))).unwrap();
                    }
                    if let Some(v) = v {
                        writeln!(o, "{}", verdict(v)).unwrap();
                        let vb = |id: u32| v.names.get(&id).cloned().unwrap_or_else(|| format!("{id:08x}"));
                        writeln!(o, "[\"cheat\",{}]", js(&verdict_line(v, &vb))).unwrap();
                    }
                }
            }
            x => panic!("an op {x}"),
        }
    }
}

fn verdict(v: &Verdict) -> String {
    let own = match v.own {
        None => "null".into(),
        Some(OwnGame::First(t)) => format!("[\"first\",{}]", f(t)),
        Some(OwnGame::Finished(t)) => format!("[\"finished\",{}]", f(t)),
        Some(OwnGame::Out) => "[\"out\",null]".into(),
    };
    format!(
        "[\"verdict\",{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}]",
        v.lobby,
        v.race,
        v.mode,
        v.laps,
        v.heat,
        v.heats,
        v.winner,
        f(v.time),
        of(v.length),
        of(v.avg),
        v.next.map_or("null".into(), |(id, t)| format!("[{id},{}]", f(t))),
        of(v.drove),
        of(v.quickest),
        v.third.map_or("null".into(), |(t, w)| format!("[{},{w}]", f(t))),
        own,
        v.seen,
        v.reports,
        names(&v.names)
    )
}
