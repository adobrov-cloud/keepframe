//! Ratings, colour labels and capture-time corrections.
//!
//! Kept in `<library>/.photo-sorter/meta.json` (keyed by library-relative path) and mirrored into XMP sidecars, so
//! Lightroom, Capture One and Bridge see the same ratings. Photos themselves are never modified: the sidecar sits
//! next to the RAW (`DSCF1746.xmp` beside `DSCF1746.RAF`, as Lightroom expects), or next to the JPEG when there is
//! no RAW.

use crate::preview::{exif_for, jpeg_for};
use crate::util::*;
use chrono::{Duration, NaiveDateTime};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct Meta {
    #[serde(default)]
    pub rating: i32,
    /// Lightroom label name: Red, Yellow, Green, Blue, Purple; empty for none.
    #[serde(default)]
    pub label: String,
    /// Correction to the camera's capture time, in seconds.
    #[serde(default)]
    pub shift: i64,
}

pub const LABELS: &[&str] = &["Red", "Yellow", "Green", "Blue", "Purple"];
pub const SHIFT_MARK: &str = "@shift:";

/// Undo of a time shift: put back the previous correction; drop the corrected time from the sidecars when none is left.
pub fn restore_shift(lib: &Path, rel_path: &str, prev: i64) -> Result<(), String> {
    let mut m = load(lib);
    m.entry(rel_path.to_string()).or_default().shift = prev;
    save(lib, &m)?;
    if prev == 0 {
        for sc in sidecars(&lib.join(rel_path)) {
            if sc.exists() {
                write_xmp(&sc, &[("exif", "DateTimeOriginal", None)])?;
            }
        }
    }
    Ok(())
}

fn file(lib: &Path) -> PathBuf {
    state_dir(lib).join("meta.json")
}

pub fn load(lib: &Path) -> HashMap<String, Meta> {
    fs::read(file(lib)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(lib: &Path, m: &HashMap<String, Meta>) -> Result<(), String> {
    let m: HashMap<_, _> = m.iter().filter(|(_, v)| **v != Meta::default()).collect();
    fs::write(file(lib), serde_json::to_vec(&m).map_err(err)?).map_err(err)
}

pub fn rel(lib: &Path, p: &Path) -> String {
    p.strip_prefix(lib).unwrap_or(p).to_string_lossy().to_string()
}

/// A file moved inside the library: its rating, label, time shift and favourite follow it.
pub fn rekey(lib: &Path, from: &Path, to: &Path) {
    let (a, b) = (rel(lib, from), rel(lib, to));
    let mut m = load(lib);
    if let Some(v) = m.remove(&a) {
        m.insert(b.clone(), v);
        let _ = save(lib, &m);
    }
    let stars = crate::review::stars(lib.to_str().unwrap_or_default());
    if stars.contains(&a) {
        let next: Vec<String> = stars.into_iter().map(|s| if s == a { b.clone() } else { s }).collect();
        let _ = fs::write(state_dir(lib).join("stars.json"), serde_json::to_vec(&next).unwrap_or_default());
    }
}

/// RAW files shot together with `p` (same name, in "<folder> RAW" or next to it).
pub fn raws_of(p: &Path) -> Vec<PathBuf> {
    if is_raw(p) {
        return vec![p.to_path_buf()];
    }
    let dir = p.parent().unwrap();
    let raw_dir = dir.with_file_name(format!("{} RAW", dir.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
    let st = stem(p);
    [raw_dir, dir.to_path_buf()]
        .iter()
        .flat_map(|d| fs::read_dir(d).into_iter().flatten().flatten().map(|e| e.path()))
        .filter(|q| is_raw(q) && stem(q) == st)
        .collect()
}

/// Where this shot's XMP sidecars live.
pub fn sidecars(p: &Path) -> Vec<PathBuf> {
    let raws = raws_of(p);
    if raws.is_empty() { vec![p.with_extension("xmp")] } else { raws.iter().map(|r| r.with_extension("xmp")).collect() }
}

const NS: &[(&str, &str)] = &[("xmp", "http://ns.adobe.com/xap/1.0/"), ("exif", "http://ns.adobe.com/exif/1.0/")];

/// Set (or remove, with None) one `prefix:name` property in an XMP packet, in either attribute or element form,
/// leaving everything else (e.g. Lightroom develop settings) untouched.
fn upsert(x: &mut String, prefix: &str, name: &str, value: Option<&str>) {
    let tag = format!("{prefix}:{name}");
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    if let (Some(a), Some(b)) = (x.find(&open), x.find(&close)) {
        if b > a {
            match value {
                Some(v) => x.replace_range(a + open.len()..b, v),
                None => x.replace_range(a..b + close.len(), ""),
            }
            return;
        }
    }
    let attr = format!(" {tag}=\"");
    if let Some(a) = x.find(&attr) {
        if let Some(len) = x[a + attr.len()..].find('"') {
            let end = a + attr.len() + len + 1;
            match value {
                Some(v) => x.replace_range(a..end, &format!(" {tag}=\"{v}\"")),
                None => x.replace_range(a..end, ""),
            }
            return;
        }
    }
    let Some(v) = value else { return };
    let Some(d) = x.find("<rdf:Description") else { return };
    let at = d + "<rdf:Description".len();
    let decl = format!("xmlns:{prefix}=");
    let ns = NS.iter().find(|(p, _)| *p == prefix).map(|(_, u)| *u).unwrap_or_default();
    let mut ins = format!(" {tag}=\"{v}\"");
    if !x.contains(&decl) {
        ins = format!(" xmlns:{prefix}=\"{ns}\"{ins}");
    }
    x.insert_str(at, &ins);
}

const EMPTY_XMP: &str = "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Keepframe\">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  <rdf:Description rdf:about=\"\"/>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>\n";

fn write_xmp(path: &Path, props: &[(&str, &str, Option<String>)]) -> Result<(), String> {
    let mut x = fs::read_to_string(path).unwrap_or_else(|_| EMPTY_XMP.to_string());
    for (p, n, v) in props {
        upsert(&mut x, p, n, v.as_deref());
    }
    let tmp = path.with_extension("xmp.part");
    fs::write(&tmp, x).map_err(err)?;
    fs::rename(&tmp, path).map_err(err)
}

/// Set rating (0–5, None = unchanged) and/or label (Some("") clears) on several shots.
pub fn set(lib: &str, paths: &[String], rating: Option<i32>, label: Option<String>) -> Result<HashMap<String, Meta>, String> {
    let lib = Path::new(lib);
    let mut m = load(lib);
    for p in paths {
        let p = Path::new(p);
        let e = m.entry(rel(lib, p)).or_default();
        if let Some(r) = rating {
            e.rating = r.clamp(0, 5);
        }
        if let Some(l) = &label {
            e.label = LABELS.iter().find(|x| x.eq_ignore_ascii_case(l)).map(|x| x.to_string()).unwrap_or_default();
        }
        let (r, l) = (e.rating, e.label.clone());
        for sc in sidecars(p) {
            write_xmp(&sc, &[
                ("xmp", "Rating", (r > 0).then(|| r.to_string())),
                ("xmp", "Label", (!l.is_empty()).then(|| l.clone())),
            ])?;
        }
    }
    save(lib, &m)?;
    Ok(m)
}

fn xmp_time(t: NaiveDateTime) -> String {
    t.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Record a capture-time correction for freshly imported files (the camera clock was off by `secs`).
pub fn record_import_shift(lib: &Path, files: &[PathBuf], secs: i64) -> Result<(), String> {
    if secs == 0 || files.is_empty() {
        return Ok(());
    }
    let mut m = load(lib);
    for f in files {
        m.entry(rel(lib, f)).or_default().shift = secs;
        if is_raw(f) {
            let t = read_exif(f).and_then(|e| exif_datetime(&e)).or_else(|| mtime_local(f));
            if let Some(t) = t {
                write_xmp(&f.with_extension("xmp"), &[("exif", "DateTimeOriginal", Some(xmp_time(t + Duration::seconds(secs))))])?;
            }
        }
    }
    save(lib, &m)
}

fn is_day_folder(name: &str) -> bool {
    let mut it = name.split(' ');
    matches!((it.next().and_then(|d| d.parse::<u32>().ok()), it.next(), it.next()),
        (Some(1..=31), Some(m), None) if ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].contains(&m))
}

/// Shift the capture time of shots by `secs`. Shots in a day folder ("25 Oct") whose day changes move — with their
/// RAW and sidecars — to the right day folder; custom-named folders stay as they are. Undoable like any move.
pub fn shift_time(cache: &Path, lib: &str, paths: &[String], secs: i64) -> Result<usize, String> {
    let lib_p = Path::new(lib);
    let mut m = load(lib_p);
    let mut batch: Vec<(String, String)> = vec![];
    let mut rekeys: Vec<(PathBuf, PathBuf)> = vec![];
    let mut done: Vec<(PathBuf, NaiveDateTime)> = vec![];
    for p in paths {
        let p = PathBuf::from(p);
        let src = jpeg_for(cache, &p).unwrap_or_else(|| p.clone());
        let Some(shot) = exif_for(&p, &src).and_then(|e| exif_datetime(&e)).or_else(|| mtime_local(&p)) else { continue };
        let prev = m.get(&rel(lib_p, &p)).map(|x| x.shift).unwrap_or(0);
        let shift = prev + secs;
        // Journal marker so undo restores the previous correction too (undo walks the batch backwards,
        // so this runs after the files are back and their metadata re-keyed).
        batch.push((format!("{SHIFT_MARK}{}", rel(lib_p, &p)), prev.to_string()));
        m.entry(rel(lib_p, &p)).or_default().shift = shift;
        let when = shot + Duration::seconds(shift);
        let dir = p.parent().unwrap().to_path_buf();
        let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let (base, in_raw) = match name.strip_suffix(" RAW") {
            Some(b) => (b.to_string(), true),
            None => (name.clone(), false),
        };
        let target = day_folder(when.date());
        let mut files: Vec<(PathBuf, PathBuf)> = vec![];
        if is_day_folder(&base) && target != base && dir.parent() == Some(lib_p) {
            let new_dir = lib_p.join(if in_raw { format!("{target} RAW") } else { target.clone() });
            files.push((p.clone(), new_dir.clone()));
            let st = stem(&p);
            for sc in fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path()) {
                if sc != p && stem(&sc) == st && ext(&sc) == "xmp" {
                    files.push((sc, new_dir.clone()));
                }
            }
            if !in_raw {
                let raw_new = lib_p.join(format!("{target} RAW"));
                for r in raws_of(&p) {
                    let r_dir = r.parent().unwrap().to_path_buf();
                    let to = if r_dir == dir { new_dir.clone() } else { raw_new.clone() };
                    let x = r.with_extension("xmp");
                    files.push((r, to.clone()));
                    if x.exists() {
                        files.push((x, to));
                    }
                }
            }
        }
        let mut final_path = p.clone();
        for (from, to_dir) in files {
            fs::create_dir_all(&to_dir).map_err(err)?;
            let to = free_path(&to_dir, &from.file_name().unwrap().to_string_lossy());
            fs::rename(&from, &to).map_err(err)?;
            if from == p {
                final_path = to.clone();
            }
            batch.push((from.to_string_lossy().into(), to.to_string_lossy().into()));
            rekeys.push((from, to));
        }
        done.push((final_path, when));
    }
    save(lib_p, &m)?;
    for (from, to) in &rekeys {
        rekey(lib_p, from, to);
    }
    // Corrected time into the sidecars at their (possibly new) place, for Lightroom & co.
    for (p, when) in &done {
        for sc in sidecars(p) {
            write_xmp(&sc, &[("exif", "DateTimeOriginal", Some(xmp_time(*when)))])?;
        }
    }
    let n = batch.iter().filter(|(f, _)| !f.starts_with(SHIFT_MARK)).count();
    crate::review::record(lib_p, batch)?;
    Ok(n)
}
