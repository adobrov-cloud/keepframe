use crate::util::*;
use crate::verify::HashCache;
use crate::emit;
use chrono::NaiveDateTime;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone)]
pub struct Item {
    pub src: String,
    pub name: String,
    pub size: u64,
    pub date: String,
    pub dest_dir: String,
    pub kind: String,
}

#[derive(Serialize, Default)]
pub struct Day {
    pub date: String,
    pub folder: String,
    pub photos: usize,
    pub raws: usize,
    pub videos: usize,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct Plan {
    pub total: usize,
    pub already: usize,
    pub bytes: u64,
    pub items: Vec<Item>,
    pub days: Vec<Day>,
}

#[derive(Serialize)]
pub struct Report {
    pub copied: usize,
    pub skipped: usize,
    pub bytes: u64,
    pub failed: Vec<String>,
    pub folders: Vec<String>,
    /// Imported JPEGs in shooting order, for the swipe pass.
    pub photos: Vec<String>,
}

fn card_root(card: &Path) -> PathBuf {
    let d = card.join("DCIM");
    if d.is_dir() { d } else { card.to_path_buf() }
}

pub fn scan<R: tauri::Runtime>(app: &AppHandle<R>, card: &str, lib: &str) -> Result<Plan, String> {
    let card = Path::new(card);
    let lib = Path::new(lib);
    emit(app, "scan", 0, 0, "@scan_card");
    let files = walk_media(&card_root(card), false);

    emit(app, "scan", 0, 0, "@scan_lib");
    let have: HashSet<(String, u64)> = walk_media(lib, true)
        .into_iter()
        .filter_map(|p| {
            let size = fs::metadata(&p).ok()?.len();
            Some((p.file_name()?.to_string_lossy().to_lowercase(), size))
        })
        .collect();

    // Capture time: EXIF of the JPEG; RAW/sidecars borrow it from the JPEG with the same stem.
    let jpg_dates: HashMap<String, NaiveDateTime> = files
        .par_iter()
        .filter(|p| is_jpeg(p))
        .filter_map(|p| {
            let d = read_exif(p).and_then(|e| exif_datetime(&e)).or_else(|| mtime_local(p))?;
            Some((stem(p), d))
        })
        .collect();

    let mut items = Vec::new();
    let mut already = 0;
    for p in &files {
        let size = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if have.contains(&(name.to_lowercase(), size)) {
            already += 1;
            continue;
        }
        let dt = jpg_dates.get(&stem(p)).cloned().or_else(|| mtime_local(p));
        let Some(dt) = dt else { continue };
        let kind = if is_raw(p) { "raw" } else if is_video(p) { "video" } else { "photo" };
        let folder = day_folder(dt.date());
        items.push(Item {
            src: p.to_string_lossy().to_string(),
            name,
            size,
            date: dt.format("%Y-%m-%d").to_string(),
            dest_dir: if kind == "raw" { format!("{folder} RAW") } else { folder },
            kind: kind.into(),
        });
    }
    items.sort_by(|a, b| (&a.date, &a.name).cmp(&(&b.date, &b.name)));

    let mut days: Vec<Day> = Vec::new();
    for it in &items {
        if days.last().map(|d| d.date != it.date).unwrap_or(true) {
            days.push(Day {
                date: it.date.clone(),
                folder: it.dest_dir.trim_end_matches(" RAW").to_string(),
                ..Default::default()
            });
        }
        let d = days.last_mut().unwrap();
        match it.kind.as_str() {
            "raw" => d.raws += 1,
            "video" => d.videos += 1,
            _ => d.photos += 1,
        }
        d.bytes += it.size;
    }
    Ok(Plan {
        total: files.len(),
        already,
        bytes: items.iter().map(|i| i.size).sum(),
        items,
        days,
    })
}

/// Copy src→dst while hashing, then re-read dst and compare. Returns the hash.
fn copy_verified(src: &Path, dst: &Path) -> Result<String, String> {
    let tmp = dst.with_file_name(format!(".{}.part", dst.file_name().unwrap().to_string_lossy()));
    let res = (|| {
        let mut r = File::open(src).map_err(err)?;
        let mut w = File::create(&tmp).map_err(err)?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 8 << 20];
        loop {
            let n = r.read(&mut buf).map_err(err)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            w.write_all(&buf[..n]).map_err(err)?;
        }
        w.sync_all().map_err(err)?;
        drop(w);
        let want = hex::encode(h.finalize());
        let got = hash_file(&tmp).map_err(err)?;
        if want != got {
            return Err("@err_checksum".to_string());
        }
        let meta = fs::metadata(src).map_err(err)?;
        let _ = filetime::set_file_mtime(&tmp, filetime::FileTime::from_last_modification_time(&meta));
        fs::rename(&tmp, dst).map_err(err)?;
        Ok(want)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

pub fn run<R: tauri::Runtime>(app: &AppHandle<R>, items: Vec<Item>, lib: &str) -> Result<Report, String> {
    let lib = Path::new(lib);
    let total: u64 = items.iter().map(|i| i.size).sum();
    let mut cache = HashCache::load(lib);
    let mut done = 0u64;
    let mut rep = Report { copied: 0, skipped: 0, bytes: 0, failed: vec![], folders: vec![], photos: vec![] };
    let mut folders = HashSet::new();
    for it in &items {
        emit(app, "import", done, total, &it.name);
        let dir = lib.join(&it.dest_dir);
        if let Err(e) = fs::create_dir_all(&dir) {
            rep.failed.push(format!("{}: {e}", it.name));
            continue;
        }
        let mut dst = dir.join(&it.name);
        if dst.exists() {
            if fs::metadata(&dst).map(|m| m.len()).unwrap_or(0) == it.size {
                rep.skipped += 1;
                done += it.size;
                continue;
            }
            dst = free_path(&dir, &it.name);
        }
        match copy_verified(Path::new(&it.src), &dst) {
            Ok(hash) => {
                if let Ok(m) = fs::metadata(&dst) {
                    cache.put(&dst, &m, hash);
                }
                rep.copied += 1;
                rep.bytes += it.size;
                folders.insert(it.dest_dir.trim_end_matches(" RAW").to_string());
                if is_jpeg(&dst) {
                    rep.photos.push(dst.to_string_lossy().into());
                }
            }
            Err(e) => rep.failed.push(format!("{}: {e}", it.name)),
        }
        done += it.size;
    }
    cache.save(lib);
    emit(app, "import", total, total, "@done");
    let mut f: Vec<String> = folders.into_iter().collect();
    f.sort();
    rep.folders = f;
    Ok(rep)
}
