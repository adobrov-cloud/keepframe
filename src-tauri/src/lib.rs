mod analyze;
mod import;
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
        Settings { library: if fugi.is_dir() { fugi } else { pics }.to_string_lossy().into() }
    });
    allow_assets(&app, &s.library);
    s
}

#[tauri::command]
fn set_library(app: AppHandle, library: String) -> Result<Settings, String> {
    if !Path::new(&library).is_dir() {
        return Err("@err_no_folder".into());
    }
    let s = Settings { library };
    fs::write(settings_file(&app), serde_json::to_vec(&s).map_err(err)?).map_err(err)?;
    allow_assets(&app, &s.library);
    Ok(s)
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
async fn scan_import(app: AppHandle, card: String, library: String) -> Result<import::Plan, String> {
    blocking(move || import::scan(&app, &card, &library)).await
}

#[tauri::command]
async fn run_import(app: AppHandle, items: Vec<import::Item>, library: String) -> Result<import::Report, String> {
    blocking(move || import::run(&app, items, &library)).await
}

#[tauri::command]
async fn verify_card(app: AppHandle, card: String, library: String) -> Result<verify::Report, String> {
    blocking(move || verify::run(&app, &card, &library)).await
}

#[tauri::command]
async fn analyze(app: AppHandle, library: String) -> Result<Vec<analyze::Rec>, String> {
    blocking(move || analyze::run(&app, &library)).await
}

#[tauri::command]
async fn thumb(app: AppHandle, path: String, size: u32) -> Result<String, String> {
    let cache = app.path().app_cache_dir().map_err(err)?;
    blocking(move || analyze::thumb(&cache, Path::new(&path), size)).await
}

#[tauri::command]
async fn photo_info(path: String) -> Result<analyze::Info, String> {
    blocking(move || Ok(analyze::info(Path::new(&path)))).await
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
            photo_info
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

        let plan = crate::import::scan(h, &card, &lib).unwrap();
        println!("scan: total={} already={} new={} days={:?}", plan.total, plan.already, plan.items.len(),
            plan.days.iter().map(|d| (&d.folder, d.photos, d.raws, d.videos)).collect::<Vec<_>>());
        let rep = crate::import::run(h, plan.items, &lib).unwrap();
        println!("import: copied={} skipped={} failed={:?} folders={:?}", rep.copied, rep.skipped, rep.failed, rep.folders);
        let again = crate::import::scan(h, &card, &lib).unwrap();
        assert_eq!(again.items.len(), 0, "rescan after import must find nothing new");

        let v = crate::verify::run(h, &card, &lib).unwrap();
        println!("verify: files={} matched={} missing={} only_review={}", v.card_files, v.matched, v.missing.len(), v.only_in_review);
        assert!(v.missing.is_empty());

        let t0 = std::time::Instant::now();
        let recs = crate::analyze::run(h, &lib).unwrap();
        println!("analyze: {} recs in {:?}", recs.len(), t0.elapsed());
        let r = &recs[0];
        println!("sample: {} sharp_at={:?},{:?} iso={:?} f={:?} t={:?} fl={:?} ts={:?} orient={} vert={} sharp={} dhash={}",
            r.name, r.sharp_u, r.sharp_v, r.iso, r.f, r.t, r.fl, r.ts, r.orient, r.vertical, r.sharp, r.dhash);
        let t0 = std::time::Instant::now();
        let th = crate::analyze::thumb(Path::new(&lib).join(".thumbcache").as_path(), Path::new(&r.path), 1400).unwrap();
        println!("thumb: {th} in {:?}", t0.elapsed());

        let n = crate::review::move_to_review(&lib, "_review (duplicates)", vec![r.path.clone()]).unwrap();
        println!("moved {n}");
        assert!(!Path::new(&r.path).exists());
        let v2 = crate::verify::run(h, &card, &lib).unwrap();
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
    }
}
