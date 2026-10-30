use chrono::{Datelike, NaiveDate, NaiveDateTime};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};

pub const RAW_EXT: &[&str] = &["raf", "fp2", "dng", "cr2", "cr3", "nef", "arw", "orf", "rw2"];
pub const IMG_EXT: &[&str] = &["jpg", "jpeg", "hif", "heic", "png"];
pub const VID_EXT: &[&str] = &["mov", "mp4", "avi", "mts"];
/// Review folders are named "<prefix> (<kind>)"; both UI languages are recognised.
pub const REVIEW_PREFIXES: &[&str] = &["_на проверку", "_review"];
pub const STATE_DIR: &str = ".photo-sorter";

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

pub fn ext(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

pub fn stem(p: &Path) -> String {
    p.file_stem().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

pub fn is_raw(p: &Path) -> bool {
    RAW_EXT.contains(&ext(p).as_str())
}

pub fn is_jpeg(p: &Path) -> bool {
    matches!(ext(p).as_str(), "jpg" | "jpeg")
}

pub fn is_video(p: &Path) -> bool {
    VID_EXT.contains(&ext(p).as_str())
}

pub fn is_media(p: &Path) -> bool {
    let e = ext(p);
    RAW_EXT.contains(&e.as_str()) || IMG_EXT.contains(&e.as_str()) || VID_EXT.contains(&e.as_str())
}

/// All media files under `root`, skipping hidden entries and (optionally) review folders.
pub fn walk_media(root: &Path, include_review: bool) -> Vec<PathBuf> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let n = e.file_name().to_string_lossy();
            if n.starts_with('.') {
                return false;
            }
            include_review || !(e.file_type().is_dir() && is_review_name(&n))
        })
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_media(e.path()))
        .map(|e| e.into_path())
        .collect()
}

pub fn is_review_name(n: &str) -> bool {
    REVIEW_PREFIXES.iter().any(|p| n.starts_with(p))
}

pub fn in_review(p: &Path) -> bool {
    p.components().any(|c| is_review_name(&c.as_os_str().to_string_lossy()))
}

pub fn read_exif(p: &Path) -> Option<exif::Exif> {
    let f = File::open(p).ok()?;
    exif::Reader::new().read_from_container(&mut BufReader::new(f)).ok()
}

pub fn exif_datetime(ex: &exif::Exif) -> Option<NaiveDateTime> {
    let f = ex.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)?;
    if let exif::Value::Ascii(ref v) = f.value {
        let s = std::str::from_utf8(v.first()?).ok()?;
        NaiveDateTime::parse_from_str(s.trim_end_matches('\0').trim(), "%Y:%m:%d %H:%M:%S").ok()
    } else {
        None
    }
}

pub fn mtime_local(p: &Path) -> Option<NaiveDateTime> {
    let m = fs::metadata(p).ok()?.modified().ok()?;
    Some(chrono::DateTime::<chrono::Local>::from(m).naive_local())
}

pub fn mtime_secs(meta: &fs::Metadata) -> i64 {
    filetime::FileTime::from_last_modification_time(meta).unix_seconds()
}

/// Folder name for a shooting day, e.g. "25 Oct".
pub fn day_folder(d: NaiveDate) -> String {
    format!("{} {}", d.day(), MONTHS[d.month0() as usize])
}

pub fn hash_file(p: &Path) -> io::Result<String> {
    let mut f = File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 8 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

pub fn state_dir(lib: &Path) -> PathBuf {
    let d = lib.join(STATE_DIR);
    let _ = fs::create_dir_all(&d);
    d
}

/// A path in `dir` named like `name` that does not exist yet (adds _1, _2… before the extension).
pub fn free_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let path = Path::new(name);
    let st = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ex = path.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (1..)
        .map(|i| dir.join(format!("{st}_{i}{ex}")))
        .find(|p| !p.exists())
        .unwrap()
}

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
