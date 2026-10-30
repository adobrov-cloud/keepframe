use crate::emit;
use crate::util::*;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;

/// path → (size, mtime, sha256), so the library is hashed only once.
#[derive(Serialize, Deserialize, Default)]
pub struct HashCache {
    map: HashMap<String, (u64, i64, String)>,
}

impl HashCache {
    fn file(lib: &Path) -> std::path::PathBuf {
        state_dir(lib).join("hashes.json")
    }
    pub fn load(lib: &Path) -> Self {
        fs::read(Self::file(lib)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    pub fn save(&self, lib: &Path) {
        if let Ok(b) = serde_json::to_vec(self) {
            let _ = fs::write(Self::file(lib), b);
        }
    }
    pub fn get(&self, p: &Path, m: &fs::Metadata) -> Option<String> {
        let (s, t, h) = self.map.get(&p.to_string_lossy().to_string())?;
        (*s == m.len() && *t == mtime_secs(m)).then(|| h.clone())
    }
    pub fn put(&mut self, p: &Path, m: &fs::Metadata, h: String) {
        self.map.insert(p.to_string_lossy().to_string(), (m.len(), mtime_secs(m), h));
    }
}

#[derive(Serialize)]
pub struct Missing {
    pub path: String,
    pub size: u64,
}

#[derive(Serialize)]
pub struct Report {
    pub card_files: usize,
    pub card_bytes: u64,
    pub matched: usize,
    pub missing: Vec<Missing>,
    pub only_in_review: usize,
    pub checksum_file: String,
}

pub fn run<R: tauri::Runtime>(app: &AppHandle<R>, card: &str, lib: &str) -> Result<Report, String> {
    let card = Path::new(card);
    let lib = Path::new(lib);

    // 1. Card: every media file (including ones the camera put outside DCIM).
    let card_files = walk_media(card, true);
    let card_total: u64 = card_files.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum();
    let done = AtomicU64::new(0);
    let card_hashes: Vec<(String, u64, String)> = card_files
        .par_iter()
        .with_max_len(1)
        .filter_map(|p| {
            let size = fs::metadata(p).ok()?.len();
            let h = hash_file(p).ok()?;
            let d = done.fetch_add(size, Ordering::Relaxed) + size;
            emit(app, "verify", d, card_total, "Читаю карту");
            Some((p.to_string_lossy().to_string(), size, h))
        })
        .collect();
    if card_hashes.len() != card_files.len() {
        return Err("Не удалось прочитать часть файлов на карте".into());
    }

    // 2. Library: hash what is new since the last run.
    let mut cache = HashCache::load(lib);
    let lib_files: Vec<_> = walk_media(lib, true)
        .into_iter()
        .filter_map(|p| fs::metadata(&p).ok().map(|m| (p, m)))
        .collect();
    let todo: Vec<_> = lib_files.iter().filter(|(p, m)| cache.get(p, m).is_none()).collect();
    let todo_total: u64 = todo.iter().map(|(_, m)| m.len()).sum();
    let done = AtomicU64::new(0);
    let fresh: Vec<_> = todo
        .par_iter()
        .with_max_len(1)
        .filter_map(|(p, m)| {
            let h = hash_file(p).ok()?;
            let d = done.fetch_add(m.len(), Ordering::Relaxed) + m.len();
            emit(app, "verify", d, todo_total, "Читаю библиотеку");
            Some((p.clone(), (*m).clone(), h))
        })
        .collect();
    for (p, m, h) in fresh {
        cache.put(&p, &m, h);
    }
    cache.save(lib);

    let mut by_hash: HashMap<String, Vec<&Path>> = HashMap::new();
    for (p, m) in &lib_files {
        if let Some(h) = cache.get(p, m) {
            by_hash.entry(h).or_default().push(p.as_path());
        }
    }

    let mut missing = vec![];
    let mut only_in_review = 0;
    for (p, size, h) in &card_hashes {
        match by_hash.get(h) {
            None => missing.push(Missing { path: p.clone(), size: *size }),
            Some(ps) if ps.iter().all(|q| in_review(q)) => only_in_review += 1,
            _ => {}
        }
    }

    let sums_dir = state_dir(lib).join("checksums");
    let _ = fs::create_dir_all(&sums_dir);
    let sums = sums_dir.join(format!("card_{}.sha256", chrono::Local::now().format("%Y-%m-%d_%H%M")));
    let body: String = card_hashes.iter().map(|(p, _, h)| format!("{h}  {p}\n")).collect();
    fs::write(&sums, body).map_err(err)?;

    Ok(Report {
        card_files: card_hashes.len(),
        card_bytes: card_total,
        matched: card_hashes.len() - missing.len(),
        missing,
        only_in_review,
        checksum_file: sums.to_string_lossy().to_string(),
    })
}
