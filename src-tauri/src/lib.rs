mod analyze;
mod import;
mod meta;
mod preview;
mod review;
mod util;
mod verify;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use util::err;

#[derive(Clone, Serialize)]
pub struct Progress {
    task: String,
    done: u64,
    total: u64,
    label: String,
}

pub fn emit<R: tauri::Runtime>(app: &AppHandle<R>, task: &str, done: u64, total: u64, label: &str) {
    let _ = app.emit("progress", Progress { task: task.into(), done, total, label: label.into() });
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

// ---------- settings ----------

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    library: String,
    /// Second-copy folder (external drive, NAS); imports copy there too.
    #[serde(default)]
    backup: Option<String>,
}

fn write_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    fs::write(settings_file(app), serde_json::to_vec(s).map_err(err)?).map_err(err)
}

fn settings_file(app: &AppHandle) -> PathBuf {
    let d = app.path().app_config_dir().unwrap();
    let _ = fs::create_dir_all(&d);
    d.join("settings.json")
}

/// Lets the webview load full-size originals from the library (for zoom).
fn allow_assets(app: &AppHandle, lib: &str) {
    let _ = app.asset_protocol_scope().allow_directory(lib, true);
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    let s = fs::read(settings_file(&app)).ok().and_then(|b| serde_json::from_slice::<Settings>(&b).ok()).unwrap_or_else(|| {
        let pics = app.path().picture_dir().unwrap_or_else(|_| PathBuf::from("."));
        let fugi = pics.join("Fugi");
        Settings { library: if fugi.is_dir() { fugi } else { pics }.to_string_lossy().into(), backup: None }
    });
    allow_assets(&app, &s.library);
    s
}

#[tauri::command]
fn set_library(app: AppHandle, library: String) -> Result<Settings, String> {
    if !Path::new(&library).is_dir() {
        return Err("@err_no_folder".into());
    }
    let s = Settings { library, ..get_settings(app.clone()) };
    write_settings(&app, &s)?;
    allow_assets(&app, &s.library);
    Ok(s)
}

#[tauri::command]
fn set_backup(app: AppHandle, backup: Option<String>) -> Result<Settings, String> {
    if let Some(b) = &backup {
        let s = get_settings(app.clone());
        if !Path::new(b).is_dir() {
            return Err("@err_no_folder".into());
        }
        if Path::new(b).starts_with(&s.library) || Path::new(&s.library).starts_with(b) {
            return Err("@err_backup_inside".into());
        }
    }
    let s = Settings { backup, ..get_settings(app.clone()) };
    write_settings(&app, &s)?;
    Ok(s)
}

#[tauri::command]
async fn backup_sync(app: AppHandle, library: String) -> Result<import::SyncReport, String> {
    let backup = get_settings(app.clone()).backup.ok_or("@err_no_backup")?;
    blocking(move || import::backup_sync(&app, &library, &backup)).await
}

#[tauri::command]
fn get_meta(library: String) -> std::collections::HashMap<String, meta::Meta> {
    meta::load(Path::new(&library))
}

#[tauri::command]
async fn set_meta(library: String, paths: Vec<String>, rating: Option<i32>, label: Option<String>) -> Result<std::collections::HashMap<String, meta::Meta>, String> {
    blocking(move || meta::set(&library, &paths, rating, label)).await
}

#[tauri::command]
async fn shift_time(app: AppHandle, library: String, paths: Vec<String>, seconds: i64) -> Result<usize, String> {
    let cache = app.path().app_cache_dir().map_err(err)?;
    blocking(move || meta::shift_time(&cache, &library, &paths, seconds)).await
}

// ---------- cards ----------

#[derive(Serialize)]
struct Card {
    path: String,
    name: String,
}

#[tauri::command]
fn list_cards() -> Vec<Card> {
    let mut roots: Vec<PathBuf> = vec![];
    if cfg!(target_os = "macos") {
        if let Ok(rd) = fs::read_dir("/Volumes") {
            roots.extend(rd.flatten().map(|e| e.path()));
        }
    } else if cfg!(windows) {
        roots.extend((b'D'..=b'Z').map(|c| PathBuf::from(format!("{}:\\", c as char))));
    } else {
        let user = std::env::var("USER").unwrap_or_default();
        for base in [format!("/media/{user}"), format!("/run/media/{user}"), "/media".into()] {
            if let Ok(rd) = fs::read_dir(base) {
                roots.extend(rd.flatten().map(|e| e.path()));
            }
        }
    }
    roots
        .into_iter()
        .filter(|r| r.join("DCIM").is_dir())
        .map(|r| Card {
            name: r.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| r.to_string_lossy().to_string()),
            path: r.to_string_lossy().into(),
        })
        .collect()
}

#[derive(Serialize)]
struct CardInfo {
    total: u64,
    free: u64,
}

#[tauri::command]
fn card_info(card: String) -> Result<CardInfo, String> {
    Ok(CardInfo { total: fs2::total_space(&card).map_err(err)?, free: fs2::available_space(&card).map_err(err)? })
}

#[tauri::command]
async fn eject_card(card: String) -> Result<(), String> {
    blocking(move || {
        let out = if cfg!(target_os = "macos") {
            std::process::Command::new("diskutil").args(["eject", &card]).output()
        } else if cfg!(windows) {
            let drive = card.trim_end_matches(['\\', '/']).to_string();
            let ps = format!("(New-Object -comObject Shell.Application).Namespace(17).ParseName('{drive}').InvokeVerb('Eject')");
            std::process::Command::new("powershell").args(["-NoProfile", "-Command", &ps]).output()
        } else {
            std::process::Command::new("umount").arg(&card).output()
        }
        .map_err(err)?;
        if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
    })
    .await
}

// ---------- commands ----------

#[tauri::command]
async fn scan_import(app: AppHandle, card: String, library: String, offset: Option<i64>) -> Result<import::Plan, String> {
    blocking(move || import::scan(&app, &card, &library, offset.unwrap_or(0))).await
}

#[tauri::command]
async fn run_import(app: AppHandle, items: Vec<import::Item>, library: String, offset: Option<i64>) -> Result<import::Report, String> {
    let backup = get_settings(app.clone()).backup;
    blocking(move || import::run(&app, items, &library, backup, offset.unwrap_or(0))).await
}

#[tauri::command]
async fn verify_card(app: AppHandle, card: String, library: String) -> Result<verify::Report, String> {
    let backup = get_settings(app.clone()).backup;
    blocking(move || verify::run(&app, &card, &library, backup)).await
}

#[tauri::command]
async fn analyze(app: AppHandle, library: String) -> Result<Vec<analyze::Rec>, String> {
    let cache = app.path().app_cache_dir().map_err(err)?;
    blocking(move || analyze::run(&app, &cache, &library)).await
}

#[tauri::command]
async fn thumb(app: AppHandle, path: String, size: u32) -> Result<String, String> {
    let cache = app.path().app_cache_dir().map_err(err)?;
    blocking(move || analyze::thumb(&cache, Path::new(&path), size)).await
}

#[tauri::command]
async fn photo_info(app: AppHandle, path: String) -> Result<analyze::Info, String> {
    let cache = app.path().app_cache_dir().map_err(err)?;
    blocking(move || Ok(analyze::info(&cache, Path::new(&path)))).await
}

#[tauri::command]
async fn move_to_review(library: String, folder: String, paths: Vec<String>) -> Result<usize, String> {
    blocking(move || review::move_to_review(&library, &folder, paths)).await
}

#[tauri::command]
async fn undo_last(library: String) -> Result<usize, String> {
    blocking(move || review::undo_last(&library)).await
}

#[tauri::command]
async fn list_review(library: String) -> Result<Vec<review::ReviewItem>, String> {
    blocking(move || Ok(review::list_review(&library))).await
}

#[tauri::command]
async fn restore_from_review(library: String, paths: Vec<String>) -> Result<usize, String> {
    blocking(move || review::restore(&library, paths)).await
}

#[tauri::command]
async fn list_videos(library: String) -> Result<Vec<analyze::Video>, String> {
    blocking(move || Ok(analyze::videos(&library))).await
}

#[tauri::command]
fn get_stars(library: String) -> Vec<String> {
    review::stars(&library)
}

#[tauri::command]
fn set_stars(library: String, paths: Vec<String>, on: bool) -> Result<Vec<String>, String> {
    review::set_stars(&library, &paths, on)
}

#[tauri::command]
fn undo_count(library: String) -> usize {
    review::undo_count(&library)
}

#[tauri::command]
fn review_dir(library: String, folder: String) -> Result<String, String> {
    Ok(review::review_dir(Path::new(&library), &folder)?.to_string_lossy().into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_library,
            list_cards,
            scan_import,
            run_import,
            verify_card,
            analyze,
            thumb,
            move_to_review,
            undo_last,
            undo_count,
            review_dir,
            list_review,
            restore_from_review,
            card_info,
            eject_card,
            photo_info,
            list_videos,
            get_stars,
            set_stars,
            set_backup,
            backup_sync,
            get_meta,
            set_meta,
            shift_time
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// End-to-end on real files: PS_CARD (folder with DCIM) and PS_LIB (scratch library).
    #[test]
    fn pipeline() {
        let (Ok(card), Ok(lib)) = (std::env::var("PS_CARD"), std::env::var("PS_LIB")) else { return };
        let app = tauri::test::mock_app();
        let h = app.handle();

        let mut on_card: Vec<_> = crate::util::card_files(Path::new(&card))
            .iter().map(|p| p.strip_prefix(&card).unwrap().to_string_lossy().to_string()).collect();
        on_card.sort();
        println!("card files: {on_card:?}");
        let backup = format!("{lib}-backup");
        std::fs::create_dir_all(&backup).unwrap();
        let plan = crate::import::scan(h, &card, &lib, 0).unwrap();
        println!("scan: total={} already={} new={} days={:?}", plan.total, plan.already, plan.items.len(),
            plan.days.iter().map(|d| (&d.folder, d.photos, d.raws, d.videos, d.others)).collect::<Vec<_>>());
        let rep = crate::import::run(h, plan.items, &lib, Some(backup.clone()), 0).unwrap();
        println!("backup: copied={} failed={:?} unavailable={}", rep.backup_copied, rep.backup_failed, rep.backup_unavailable);
        assert_eq!(rep.backup_copied, rep.copied);
        println!("import: copied={} skipped={} failed={:?} folders={:?} photos={:?}", rep.copied, rep.skipped, rep.failed, rep.folders,
            rep.photos.iter().map(|p| Path::new(p).file_name().unwrap().to_string_lossy().to_string()).collect::<Vec<_>>());
        let again = crate::import::scan(h, &card, &lib, 0).unwrap();
        assert_eq!(again.items.len(), 0, "rescan after import must find nothing new");

        let v = crate::verify::run(h, &card, &lib, Some(backup.clone())).unwrap();
        let b = v.backup.as_ref().unwrap();
        println!("verify backup: matched={} missing={}", b.matched, b.missing.len());
        assert!(b.missing.is_empty());
        println!("verify: files={} matched={} missing={} only_review={}", v.card_files, v.matched, v.missing.len(), v.only_in_review);
        assert!(v.missing.is_empty());

        let t0 = std::time::Instant::now();
        let recs = crate::analyze::run(h, &Path::new(&lib).join(".thumbcache"), &lib).unwrap();
        println!("analyze: {} recs in {:?}", recs.len(), t0.elapsed());
        for raw in recs.iter().filter(|r| crate::util::is_raw(Path::new(&r.path))) {
            let t0 = std::time::Instant::now();
            let th = crate::analyze::thumb(Path::new(&lib).join(".thumbcache").as_path(), Path::new(&raw.path), 1400).unwrap();
            let dims = image::image_dimensions(&th).unwrap();
            println!("raw-only shot: {} iso={:?} t={:?} orient={} sharp={} thumb={dims:?} in {:?}", raw.name, raw.iso, raw.t, raw.orient, raw.sharp, t0.elapsed());
        }
        let r = &recs[0];
        println!("sample: {} sharp_at={:?},{:?} iso={:?} f={:?} t={:?} fl={:?} ts={:?} orient={} vert={} sharp={} dhash={}",
            r.name, r.sharp_u, r.sharp_v, r.iso, r.f, r.t, r.fl, r.ts, r.orient, r.vertical, r.sharp, r.dhash);
        let t0 = std::time::Instant::now();
        let th = crate::analyze::thumb(Path::new(&lib).join(".thumbcache").as_path(), Path::new(&r.path), 1400).unwrap();
        println!("thumb: {th} in {:?}", t0.elapsed());

        let n = crate::review::move_to_review(&lib, "_review (duplicates)", vec![r.path.clone()]).unwrap();
        println!("moved {n}");
        assert!(!Path::new(&r.path).exists());
        let v2 = crate::verify::run(h, &card, &lib, None).unwrap();
        println!("verify after move: matched={} only_review={}", v2.matched, v2.only_in_review);
        let back = crate::review::undo_last(&lib).unwrap();
        println!("undo {back}");
        assert_eq!(n, back);
        assert!(Path::new(&r.path).exists());

        crate::review::move_to_review(&lib, "_на проверку (смазанные)", vec![r.path.clone()]).unwrap();
        let items = crate::review::list_review(&lib);
        println!("review list: {:?}", items.iter().map(|i| (&i.kind, &i.dir, &i.folder, &i.name, i.raws)).collect::<Vec<_>>());
        assert_eq!(items.len(), 1);
        let back = crate::review::restore(&lib, vec![items[0].path.clone()]).unwrap();
        println!("restored {back}");
        assert!(Path::new(&r.path).exists());
        assert!(crate::review::list_review(&lib).is_empty());

        let vids = crate::analyze::videos(&lib);
        println!("videos: {:?}", vids.iter().map(|v| (&v.folder, &v.name)).collect::<Vec<_>>());
        let poster = crate::analyze::thumb(Path::new(&lib).join(".thumbcache").as_path(), Path::new(&vids[0].path), 480);
        println!("video poster: {poster:?}");
        // Ratings and labels land in the RAW's XMP sidecar.
        let jpg_with_raw = recs.iter().find(|r| r.name.ends_with(".JPG") && !crate::meta::raws_of(Path::new(&r.path)).is_empty()).unwrap();
        crate::meta::set(&lib, &[jpg_with_raw.path.clone()], Some(4), Some("Red".into())).unwrap();
        let sc = crate::meta::sidecars(Path::new(&jpg_with_raw.path));
        let xmp = std::fs::read_to_string(&sc[0]).unwrap();
        println!("xmp {}: rating4={} red={}", sc[0].display(), xmp.contains("xmp:Rating=\"4\""), xmp.contains("xmp:Label=\"Red\""));
        assert!(xmp.contains("xmp:Rating=\"4\"") && xmp.contains("xmp:Label=\"Red\""));
        crate::meta::set(&lib, &[jpg_with_raw.path.clone()], Some(0), None).unwrap();
        assert!(!std::fs::read_to_string(&sc[0]).unwrap().contains("xmp:Rating"));
        crate::meta::set(&lib, &[jpg_with_raw.path.clone()], Some(5), None).unwrap();

        // Shifting by a day moves the shot, its RAW and sidecar to the next day folder; undo brings them back.
        let cache = Path::new(&lib).join(".thumbcache");
        let moved = crate::meta::shift_time(&cache, &lib, &[jpg_with_raw.path.clone()], 24 * 3600).unwrap();
        let old = Path::new(&jpg_with_raw.path);
        let day = old.parent().unwrap().file_name().unwrap().to_string_lossy().to_string();
        println!("shift: moved {moved} files out of {day}");
        assert!(moved >= 3 && !old.exists());
        let m = crate::meta::load(Path::new(&lib));
        let (k, v) = m.iter().find(|(_, v)| v.shift == 24 * 3600).unwrap();
        println!("meta after shift: {k} rating={} label={:?} shift={}", v.rating, v.label, v.shift);
        assert!(!k.starts_with(&day) && v.rating == 5);
        let new_sc = Path::new(&lib).join(k);
        let new_xmp = std::fs::read_to_string(crate::meta::sidecars(&new_sc)[0].clone()).unwrap();
        assert!(new_xmp.contains("exif:DateTimeOriginal") && new_xmp.contains("xmp:Rating=\"5\""));
        crate::review::undo_last(&lib).unwrap();
        assert!(old.exists());
        let back = crate::meta::load(Path::new(&lib));
        let bm = back.get(&crate::meta::rel(Path::new(&lib), old)).unwrap();
        println!("after undo: shift={} rating={}", bm.shift, bm.rating);
        assert_eq!(bm.shift, 0);
        assert!(!std::fs::read_to_string(&sc[0]).unwrap().contains("DateTimeOriginal"));
        assert_eq!(crate::meta::load(Path::new(&lib)).get(&crate::meta::rel(Path::new(&lib), old)).map(|v| v.rating), Some(5));

        let sync = crate::import::backup_sync(h, &lib, &backup).unwrap();
        println!("backup sync: copied={} skipped={} failed={:?}", sync.copied, sync.skipped, sync.failed);
        assert!(sync.failed.is_empty());

        let st = crate::review::set_stars(&lib, &[r.path.clone()], true).unwrap();
        assert_eq!(crate::review::stars(&lib), st);
        assert!(crate::review::set_stars(&lib, &[r.path.clone()], false).unwrap().is_empty());
    }
}
