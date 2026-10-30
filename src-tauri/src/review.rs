use crate::util::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// One reversible batch of moves: (from, to).
type Batch = Vec<(String, String)>;

#[derive(Serialize, Deserialize, Default)]
struct Journal {
    batches: Vec<Batch>,
}

fn journal_file(lib: &Path) -> PathBuf {
    state_dir(lib).join("journal.json")
}

fn load(lib: &Path) -> Journal {
    fs::read(journal_file(lib)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(lib: &Path, j: &Journal) -> Result<(), String> {
    fs::write(journal_file(lib), serde_json::to_vec(j).map_err(err)?).map_err(err)
}

pub fn review_dir(lib: &Path, kind: &str) -> PathBuf {
    lib.join(format!("{REVIEW_PREFIX} ({kind})"))
}

/// Move the given photos — plus RAW/sidecar files with the same name in the sibling "<folder> RAW" — into the review folder.
pub fn move_to_review(lib: &str, kind: &str, paths: Vec<String>) -> Result<usize, String> {
    let lib = Path::new(lib);
    let root = review_dir(lib, kind);
    let mut batch: Batch = vec![];
    for p in paths {
        let src = PathBuf::from(&p);
        let Ok(rel) = src.strip_prefix(lib) else { continue };
        let Some(parent_rel) = rel.parent() else { continue };
        let mut pairs = vec![(src.clone(), root.join(rel))];

        let raw_dir_name = format!("{} RAW", parent_rel.file_name().map(|s| s.to_string_lossy()).unwrap_or_default());
        let raw_rel = parent_rel.with_file_name(&raw_dir_name);
        let st = stem(&src);
        if let Ok(rd) = fs::read_dir(lib.join(&raw_rel)) {
            for e in rd.flatten() {
                let q = e.path();
                if stem(&q) == st && is_raw(&q) {
                    pairs.push((q.clone(), root.join(&raw_rel).join(e.file_name())));
                }
            }
        }
        for (from, to) in pairs {
            if !from.exists() {
                continue;
            }
            let dir = to.parent().unwrap();
            fs::create_dir_all(dir).map_err(err)?;
            let to = free_path(dir, &to.file_name().unwrap().to_string_lossy());
            fs::rename(&from, &to).map_err(err)?;
            batch.push((from.to_string_lossy().into(), to.to_string_lossy().into()));
        }
    }
    let n = batch.len();
    if n > 0 {
        let mut j = load(lib);
        j.batches.push(batch);
        save(lib, &j)?;
    }
    Ok(n)
}

pub fn undo_last(lib: &str) -> Result<usize, String> {
    let lib = Path::new(lib);
    let mut j = load(lib);
    let Some(batch) = j.batches.pop() else { return Ok(0) };
    let mut n = 0;
    for (from, to) in batch.iter().rev() {
        let (from, to) = (Path::new(from), Path::new(to));
        if to.exists() && !from.exists() {
            if let Some(d) = from.parent() {
                fs::create_dir_all(d).map_err(err)?;
            }
            fs::rename(to, from).map_err(err)?;
            n += 1;
        }
    }
    save(lib, &j)?;
    Ok(n)
}

pub fn undo_count(lib: &str) -> usize {
    load(Path::new(lib)).batches.len()
}
