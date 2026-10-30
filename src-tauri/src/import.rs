use crate::util::*;
use crate::verify::HashCache;
use crate::emit;
use chrono::{Duration, NaiveDateTime};
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
    /// Sidecars and formats the app doesn't know: copied next to the day's photos all the same.
    pub others: usize,
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
    /// One viewable file per imported shot (JPEG/HEIF, or the RAW when shot RAW-only), in shooting order.
    pub photos: Vec<String>,
    /// Second copy: where it went, how many files, what failed; `backup_unavailable` when the folder wasn't reachable.
    pub backup: Option<String>,
    pub backup_copied: usize,
    pub backup_failed: Vec<String>,
    pub backup_unavailable: bool,
}

/// `offset`: seconds to add to the camera's clock (it was set wrong, or to another time zone).
pub fn scan<R: tauri::Runtime>(app: &AppHandle<R>, card: &str, lib: &str, offset: i64) -> Result<Plan, String> {
    let card = Path::new(card);
    let lib = Path::new(lib);
    emit(app, "scan", 0, 0, "@scan_card");
    let files = card_files(card);

    emit(app, "scan", 0, 0, "@scan_lib");
    let have: HashSet<(String, u64)> = walk_files(lib, true)
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
        let Some(dt) = dt.map(|d| d + Duration::seconds(offset)) else { continue };
        let kind = if is_raw(p) {
            "raw"
        } else if is_video(p) {
            "video"
        } else if is_media(p) {
            "photo"
        } else {
            "other"
        };
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
            "other" => d.others += 1,
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
pub(crate) fn copy_verified(src: &Path, dst: &Path) -> Result<String, String> {
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

pub fn run<R: tauri::Runtime>(app: &AppHandle<R>, items: Vec<Item>, lib: &str, backup: Option<String>, offset: i64) -> Result<Report, String> {
    let lib = Path::new(lib);
    let total: u64 = items.iter().map(|i| i.size).sum();
    let mut cache = HashCache::load(lib);
    let mut done = 0u64;
    let mut rep = Report {
        copied: 0, skipped: 0, bytes: 0, failed: vec![], folders: vec![], photos: vec![],
        backup: backup.clone(), backup_copied: 0, backup_failed: vec![], backup_unavailable: false,
    };
    let backup = backup.map(PathBuf::from);
    if backup.as_ref().is_some_and(|b| !b.is_dir()) {
        rep.backup_unavailable = true;
    }
    let mut imported: Vec<PathBuf> = vec![];
    let mut folders = HashSet::new();
    let mut shots: Vec<(String, PathBuf)> = vec![];
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
                    cache.put(&dst, &m, hash.clone());
                }
                imported.push(dst.clone());
                // Second copy, made from the fresh library copy so the card is read only once.
                if let Some(b) = backup.as_ref().filter(|b| b.is_dir()) {
                    let bdir = b.join(&it.dest_dir);
                    let bdst = bdir.join(dst.file_name().unwrap());
                    let same = fs::metadata(&bdst).map(|m| m.len() == it.size).unwrap_or(false);
                    let res = if same {
                        Ok(())
                    } else {
                        fs::create_dir_all(&bdir).map_err(err).and_then(|_| copy_verified(&dst, &bdst)).and_then(|h| {
                            if h == hash { Ok(()) } else { Err("@err_checksum".to_string()) }
                        })
                    };
                    match res {
                        Ok(()) => rep.backup_copied += 1,
                        Err(e) => rep.backup_failed.push(format!("{}: {e}", it.name)),
                    }
                }
                rep.copied += 1;
                rep.bytes += it.size;
                folders.insert(it.dest_dir.trim_end_matches(" RAW").to_string());
                if it.kind == "photo" || it.kind == "raw" {
                    shots.push((it.date.clone(), dst.clone()));
                }
            }
            Err(e) => rep.failed.push(format!("{}: {e}", it.name)),
        }
        done += it.size;
    }
    cache.save(lib);
    crate::meta::record_import_shift(lib, &imported, offset)?;
    // A RAW stands in for its shot only when no JPEG/HEIF of the same name came with it.
    let viewable = |p: &Path| is_jpeg(p) || is_heif(p);
    let with_photo: HashSet<(String, String)> =
        shots.iter().filter(|(_, p)| viewable(p)).map(|(d, p)| (d.clone(), stem(p))).collect();
    rep.photos = shots
        .iter()
        .filter(|(d, p)| viewable(p) || (is_raw(p) && !with_photo.contains(&(d.clone(), stem(p)))))
        .map(|(_, p)| p.to_string_lossy().into())
        .collect();
    emit(app, "import", total, total, "@done");
    let mut f: Vec<String> = folders.into_iter().collect();
    f.sort();
    rep.folders = f;
    Ok(rep)
}

#[derive(Serialize, Default)]
pub struct SyncReport {
    pub copied: usize,
    pub skipped: usize,
    pub bytes: u64,
    pub failed: Vec<String>,
}

/// Bring the backup folder up to date with the whole library (review folders included), verifying every copy.
/// Files already there with the same size are left alone; nothing in the backup is ever deleted.
pub fn backup_sync<R: tauri::Runtime>(app: &AppHandle<R>, lib: &str, backup: &str) -> Result<SyncReport, String> {
    let (lib, backup) = (Path::new(lib), Path::new(backup));
    if !backup.is_dir() {
        return Err("@err_no_backup".into());
    }
    let todo: Vec<(PathBuf, PathBuf, u64)> = walk_files(lib, true)
        .into_iter()
        .filter_map(|p| {
            let size = fs::metadata(&p).ok()?.len();
            let dst = backup.join(p.strip_prefix(lib).ok()?);
            let same = fs::metadata(&dst).map(|m| m.len() == size).unwrap_or(false);
            Some((p, dst, if same { u64::MAX } else { size }))
        })
        .collect();
    let mut rep = SyncReport::default();
    let total: u64 = todo.iter().filter(|t| t.2 != u64::MAX).map(|t| t.2).sum();
    let mut done = 0u64;
    for (src, dst, size) in todo {
        if size == u64::MAX {
            rep.skipped += 1;
            continue;
        }
        emit(app, "backup", done, total, &src.file_name().unwrap().to_string_lossy());
        match dst.parent().map(fs::create_dir_all).transpose().map_err(err).and_then(|_| copy_verified(&src, &dst)) {
            Ok(_) => { rep.copied += 1; rep.bytes += size; }
            Err(e) => rep.failed.push(format!("{}: {e}", src.strip_prefix(lib).unwrap_or(&src).display())),
        }
        done += size;
    }
    emit(app, "backup", total, total, "@done");
    Ok(rep)
}
