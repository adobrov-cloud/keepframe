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

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    if let Some(s) = fs::read(settings_file(&app)).ok().and_then(|b| serde_json::from_slice::<Settings>(&b).ok()) {
        return s;
    }
    let pics = app.path().picture_dir().unwrap_or_else(|_| PathBuf::from("."));
    let fugi = pics.join("Fugi");
    Settings { library: if fugi.is_dir() { fugi } else { pics }.to_string_lossy().into() }
}

#[tauri::command]
fn set_library(app: AppHandle, library: String) -> Result<Settings, String> {
    if !Path::new(&library).is_dir() {
        return Err("Папка не найдена".into());
    }
    let s = Settings { library };
    fs::write(settings_file(&app), serde_json::to_vec(&s).map_err(err)?).map_err(err)?;
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
async fn move_to_review(library: String, kind: String, paths: Vec<String>) -> Result<usize, String> {
    blocking(move || review::move_to_review(&library, &kind, paths)).await
}

#[tauri::command]
async fn undo_last(library: String) -> Result<usize, String> {
    blocking(move || review::undo_last(&library)).await
}

#[tauri::command]
fn undo_count(library: String) -> usize {
    review::undo_count(&library)
}

#[tauri::command]
fn review_dir(library: String, kind: String) -> String {
    review::review_dir(Path::new(&library), &kind).to_string_lossy().into()
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
            review_dir
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
        println!("sample: {} iso={:?} f={:?} t={:?} fl={:?} ts={:?} orient={} vert={} sharp={} dhash={}",
            r.name, r.iso, r.f, r.t, r.fl, r.ts, r.orient, r.vertical, r.sharp, r.dhash);
        let t0 = std::time::Instant::now();
        let th = crate::analyze::thumb(Path::new(&lib).join(".thumbcache").as_path(), Path::new(&r.path), 1400).unwrap();
        println!("thumb: {th} in {:?}", t0.elapsed());

        let n = crate::review::move_to_review(&lib, "дубли", vec![r.path.clone()]).unwrap();
        println!("moved {n}");
        assert!(!Path::new(&r.path).exists());
        let v2 = crate::verify::run(h, &card, &lib).unwrap();
        println!("verify after move: matched={} only_review={}", v2.matched, v2.only_in_review);
        let back = crate::review::undo_last(&lib).unwrap();
        println!("undo {back}");
        assert_eq!(n, back);
        assert!(Path::new(&r.path).exists());
    }
}
