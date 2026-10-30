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
    pub fn load(lib: &Path) -> Self {
        Self::load_named(lib, "hashes.json")
    }
    pub fn save(&self, lib: &Path) {
        self.save_named(lib, "hashes.json")
    }
    /// The backup's hashes live in the library's state folder too, under their own name.
    pub fn load_named(lib: &Path, name: &str) -> Self {
        fs::read(state_dir(lib).join(name)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    pub fn save_named(&self, lib: &Path, name: &str) {
        if let Ok(b) = serde_json::to_vec(self) {
            let _ = fs::write(state_dir(lib).join(name), b);
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
    pub backup: Option<BackupCheck>,
}

#[derive(Serialize)]
pub struct BackupCheck {
    pub path: String,
    pub unavailable: bool,
    pub matched: usize,
    pub missing: Vec<Missing>,
}

/// Hashes of every file under `root`, cached by path/size/mtime in `cache_name`.
fn hash_tree<R: tauri::Runtime>(app: &AppHandle<R>, lib: &Path, root: &Path, cache_name: &str, label: &str) -> HashMap<String, Vec<std::path::PathBuf>> {
    let mut cache = HashCache::load_named(lib, cache_name);
    let files: Vec<_> = walk_files(root, true).into_iter().filter_map(|p| fs::metadata(&p).ok().map(|m| (p, m))).collect();
    let todo: Vec<_> = files.iter().filter(|(p, m)| cache.get(p, m).is_none()).collect();
    let total: u64 = todo.iter().map(|(_, m)| m.len()).sum();
    let done = AtomicU64::new(0);
    let fresh: Vec<_> = todo
        .par_iter()
        .with_max_len(1)
        .filter_map(|(p, m)| {
            let h = hash_file(p).ok()?;
            let d = done.fetch_add(m.len(), Ordering::Relaxed) + m.len();
            emit(app, "verify", d, total, label);
            Some((p.clone(), (*m).clone(), h))
        })
        .collect();
    for (p, m, h) in fresh {
        cache.put(&p, &m, h);
    }
    cache.save_named(lib, cache_name);
    let mut by: HashMap<String, Vec<std::path::PathBuf>> = HashMap::new();
    for (p, m) in files {
        if let Some(h) = cache.get(&p, &m) {
            by.entry(h).or_default().push(p);
        }
    }
    by
}

pub fn run<R: tauri::Runtime>(app: &AppHandle<R>, card: &str, lib: &str, backup: Option<String>) -> Result<Report, String> {
    let card = Path::new(card);
    let lib = Path::new(lib);

    // 1. Card: everything the import takes, i.e. all of the user's files, not only known formats.
    let card_files = card_files(card);
    let card_total: u64 = card_files.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum();
    let done = AtomicU64::new(0);
    let card_hashes: Vec<(String, u64, String)> = card_files
        .par_iter()
        .with_max_len(1)
        .filter_map(|p| {
            let size = fs::metadata(p).ok()?.len();
            let h = hash_file(p).ok()?;
            let d = done.fetch_add(size, Ordering::Relaxed) + size;
            emit(app, "verify", d, card_total, "@verify_card");
            Some((p.to_string_lossy().to_string(), size, h))
        })
        .collect();
    if card_hashes.len() != card_files.len() {
        return Err("@err_card_read".into());
    }

    // 2. Library: hash what is new since the last run.
    let mut cache = HashCache::load(lib);
    let lib_files: Vec<_> = walk_files(lib, true)
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
            emit(app, "verify", d, todo_total, "@verify_lib");
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

    let backup = backup.map(|b| {
        let root = Path::new(&b);
        if !root.is_dir() {
            return BackupCheck { path: b.clone(), unavailable: true, matched: 0, missing: vec![] };
        }
        let in_b = hash_tree(app, lib, root, "hashes_backup.json", "@verify_backup");
        let missing: Vec<Missing> = card_hashes
            .iter()
            .filter(|(_, _, h)| !in_b.contains_key(h))
            .map(|(p, size, _)| Missing { path: p.clone(), size: *size })
            .collect();
        BackupCheck { path: b.clone(), unavailable: false, matched: card_hashes.len() - missing.len(), missing }
    });

    Ok(Report {
        backup,
        card_files: card_hashes.len(),
        card_bytes: card_total,
        matched: card_hashes.len() - missing.len(),
        missing,
        only_in_review,
        checksum_file: sums.to_string_lossy().to_string(),
    })
}

#[derive(Serialize)]
pub struct CopyGroup {
    pub size: u64,
    pub paths: Vec<String>,
}

/// Byte-identical photos and videos imported more than once (outside review folders), biggest first.
pub fn exact_copies<R: tauri::Runtime>(app: &AppHandle<R>, lib: &str) -> Vec<CopyGroup> {
    let lib = Path::new(lib);
    let by = hash_tree(app, lib, lib, "hashes.json", "@hash_lib");
    let mut groups: Vec<CopyGroup> = by
        .into_values()
        .map(|ps| ps.into_iter().filter(|p| is_media(p) && !in_review(p)).collect::<Vec<_>>())
        .filter(|ps| ps.len() > 1)
        .map(|mut ps| {
            ps.sort();
            CopyGroup { size: fs::metadata(&ps[0]).map(|m| m.len()).unwrap_or(0), paths: ps.iter().map(|p| p.to_string_lossy().to_string()).collect() }
        })
        .filter(|g| g.size > 0)
        .collect();
    groups.sort_by(|a, b| (b.size * b.paths.len() as u64).cmp(&(a.size * a.paths.len() as u64)));
    groups
}
