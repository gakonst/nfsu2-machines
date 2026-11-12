//! Test-only: the names crate's answers for the differential tests of its JavaScript port (web/worker/src/names).
//! stdin: one JSON string per line; stdout: one JSON line per name, {"n": blocked_name, "p": blocked_plate, "c":
//! chat_slur (null for none), "l": letters}.  With --tables: the general categories the crate reads (its
//! unicode-general-category's Unicode) as ranges of code points, for web/worker/src/util/unicode-tables.js.

use std::io::{BufRead, Write};

use nfsu2_names::{blocked_name, blocked_plate, chat_slur, letters};
use unicode_general_category::{GeneralCategory as G, get_general_category};

/// appends cp to the ranges, joining it to the last one where it follows on
fn push(ranges: &mut Vec<[u32; 2]>, cp: u32) {
    match ranges.last_mut() {
        Some(r) if r[1] + 1 == cp => r[1] = cp,
        _ => ranges.push([cp, cp]),
    }
}

fn tables() -> serde_json::Value {
    let (mut unassigned, mut marks, mut control) = (Vec::new(), Vec::new(), Vec::new());
    for cp in 0..=0x10_ffff_u32 {
        let Some(c) = char::from_u32(cp) else { continue };
        match get_general_category(c) {
            G::Unassigned => push(&mut unassigned, cp),
            G::NonspacingMark | G::SpacingMark | G::EnclosingMark => push(&mut marks, cp),
            G::Control | G::Format => push(&mut control, cp),
            _ => {}
        }
    }
    serde_json::json!({ "unassigned": unassigned, "marks": marks, "controlFormat": control })
}

fn main() {
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    if std::env::args().nth(1).as_deref() == Some("--tables") {
        writeln!(out, "{}", tables()).expect("stdout");
        return;
    }
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        if line.is_empty() {
            continue;
        }
        let s: String = serde_json::from_str(&line).expect("a JSON string per line");
        let r = serde_json::json!({ "n": blocked_name(&s), "p": blocked_plate(&s), "c": chat_slur(&s), "l": letters(&s) });
        writeln!(out, "{r}").expect("stdout");
    }
}

