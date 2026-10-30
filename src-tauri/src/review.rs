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

/// Append one undoable batch of moves to the journal.
pub fn record(lib: &Path, batch: Batch) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }
    let mut j = load(lib);
    j.batches.push(batch);
    save(lib, &j)
}

/// Move a file and let its rating/label/favourite follow.
fn move_file(lib: &Path, from: &Path, dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(err)?;
    let to = free_path(dir, &from.file_name().unwrap().to_string_lossy());
    fs::rename(from, &to).map_err(err)?;
    crate::meta::rekey(lib, from, &to);
    Ok(to)
}

pub fn review_dir(lib: &Path, folder: &str) -> Result<PathBuf, String> {
    if !is_review_name(folder) || folder.contains(['/', '\\']) {
        return Err(format!("not a review folder: {folder}"));
    }
    Ok(lib.join(folder))
}

/// Move the given photos — plus RAW/sidecar files with the same name in the sibling "<folder> RAW" — into the review folder.
pub fn move_to_review(lib: &str, folder: &str, paths: Vec<String>) -> Result<usize, String> {
    let lib = Path::new(lib);
    let root = review_dir(lib, folder)?;
    let mut batch: Batch = vec![];
    for p in paths {
        let src = PathBuf::from(&p);
        let Ok(rel) = src.strip_prefix(lib) else { continue };
        let Some(parent_rel) = rel.parent() else { continue };
        let mut pairs = vec![(src.clone(), root.join(rel))];

        let raw_dir_name = format!("{} RAW", parent_rel.file_name().map(|s| s.to_string_lossy()).unwrap_or_default());
        let raw_rel = parent_rel.with_file_name(&raw_dir_name);
        let st = stem(&src);
        // RAW files and XMP sidecars travel with the photo.
        for (dir_rel, raw_only) in [(raw_rel.clone(), false), (parent_rel.to_path_buf(), true)] {
            if let Ok(rd) = fs::read_dir(lib.join(&dir_rel)) {
                for e in rd.flatten() {
                    let q = e.path();
                    let companion = if raw_only { ext(&q) == "xmp" } else { is_raw(&q) || ext(&q) == "xmp" };
                    if q != src && stem(&q) == st && companion {
                        pairs.push((q.clone(), root.join(&dir_rel).join(e.file_name())));
                    }
                }
            }
        }
        for (from, to) in pairs {
            if !from.exists() {
                continue;
            }
            let to = move_file(lib, &from, to.parent().unwrap())?;
            batch.push((from.to_string_lossy().into(), to.to_string_lossy().into()));
        }
    }
    let n = batch.len();
    record(lib, batch)?;
    Ok(n)
}

pub fn undo_last(lib: &str) -> Result<usize, String> {
    let lib = Path::new(lib);
    let mut j = load(lib);
    let Some(batch) = j.batches.pop() else { return Ok(0) };
    let mut n = 0;
    for (from, to) in batch.iter().rev() {
        if let Some(rel) = from.strip_prefix(crate::meta::SHIFT_MARK) {
            crate::meta::restore_shift(lib, rel, to.parse().unwrap_or(0))?;
            continue;
        }
        let (from, to) = (Path::new(from), Path::new(to));
        if to.exists() && !from.exists() {
            if let Some(d) = from.parent() {
                fs::create_dir_all(d).map_err(err)?;
            }
            fs::rename(to, from).map_err(err)?;
            crate::meta::rekey(lib, to, from);
            n += 1;
        }
    }
    save(lib, &j)?;
    Ok(n)
}

pub fn undo_count(lib: &str) -> usize {
    load(Path::new(lib)).batches.len()
}

#[derive(Serialize)]
pub struct ReviewItem {
    pub path: String,
    pub kind: String,
    /// Name of the review folder itself, e.g. "_review (duplicates)".
    pub dir: String,
    /// Library folder the photo came from.
    pub folder: String,
    pub name: String,
    pub size: u64,
    /// RAW files waiting next to it in "<folder> RAW".
    pub raws: u32,
    pub raw_size: u64,
}

fn review_roots(lib: &Path) -> Vec<(String, PathBuf)> {
    let kind_of = |n: &str| {
        let p = REVIEW_PREFIXES.iter().find(|p| n.starts_with(*p))?;
        Some(n[p.len()..].trim().trim_start_matches('(').trim_end_matches(')').to_string())
    };
    let Ok(rd) = fs::read_dir(lib) else { return vec![] };
    let mut v: Vec<_> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            let kind = kind_of(&n)?;
            Some((kind, e.path()))
        })
        .collect();
    v.sort();
    v
}

fn raws_for(dir: &Path, st: &str) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|q| is_raw(q) && stem(q) == st).collect())
        .unwrap_or_default()
}

fn sidecars_in(dir: &Path, st: &str, except: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|q| ext(q) == "xmp" && stem(q) == st && q != except).collect())
        .unwrap_or_default()
}

fn raw_sibling(dir: &Path) -> PathBuf {
    dir.with_file_name(format!("{} RAW", dir.file_name().map(|s| s.to_string_lossy()).unwrap_or_default()))
}

/// Everything sitting in "_на проверку (…)" folders, photos and videos first-class, RAWs attached to their JPG.
pub fn list_review(lib: &str) -> Vec<ReviewItem> {
    let lib = Path::new(lib);
    let mut out = vec![];
    for (kind, root) in review_roots(lib) {
        let files = walk_media(&root, true);
        let photos: std::collections::HashSet<(PathBuf, String)> =
            files.iter().filter(|p| !is_raw(p)).map(|p| (p.parent().unwrap().to_path_buf(), stem(p))).collect();
        for p in files.iter().cloned() {
            // A RAW rides along with its photo; only RAW-only shots are listed on their own.
            if is_raw(&p) {
                let dir = p.parent().unwrap();
                let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let base = name.strip_suffix(" RAW").map(|b| dir.with_file_name(b)).unwrap_or_else(|| dir.to_path_buf());
                if photos.contains(&(base, stem(&p))) || photos.contains(&(dir.to_path_buf(), stem(&p))) {
                    continue;
                }
            }
            let Ok(rel) = p.strip_prefix(&root) else { continue };
            let parent = p.parent().unwrap();
            let raws = raws_for(&raw_sibling(parent), &stem(&p));
            out.push(ReviewItem {
                path: p.to_string_lossy().into(),
                kind: kind.clone(),
                dir: root.file_name().unwrap().to_string_lossy().into(),
                folder: rel.parent().map(|r| r.to_string_lossy().to_string()).unwrap_or_default(),
                name: p.file_name().unwrap().to_string_lossy().into(),
                size: fs::metadata(&p).map(|m| m.len()).unwrap_or(0),
                raws: raws.len() as u32,
                raw_size: raws.iter().filter_map(|q| fs::metadata(q).ok()).map(|m| m.len()).sum(),
            });
        }
    }
    out
}

/// Library folder for a review-relative folder; tolerates names that differ only by surrounding spaces.
fn lib_folder(lib: &Path, rel: &Path) -> PathBuf {
    let direct = lib.join(rel);
    if direct.exists() || rel.components().count() != 1 {
        return direct;
    }
    let want = rel.to_string_lossy().trim().to_string();
    fs::read_dir(lib)
        .ok()
        .and_then(|rd| rd.flatten().find(|e| e.path().is_dir() && e.file_name().to_string_lossy().trim() == want))
        .map(|e| e.path())
        .unwrap_or(direct)
}

/// Move photos (and their RAWs) from review folders back to where they came from. Undoable.
pub fn restore(lib: &str, paths: Vec<String>) -> Result<usize, String> {
    let lib = Path::new(lib);
    let roots = review_roots(lib);
    let mut batch: Batch = vec![];
    for p in paths {
        let src = PathBuf::from(&p);
        let Some((_, root)) = roots.iter().find(|(_, r)| src.starts_with(r)) else { continue };
        let rel_dir = src.parent().unwrap().strip_prefix(root).map_err(err)?.to_path_buf();
        let dest_dir = lib_folder(lib, &rel_dir);
        let mut pairs = vec![(src.clone(), dest_dir.clone())];
        let raw_src = raw_sibling(src.parent().unwrap());
        for q in sidecars_in(src.parent().unwrap(), &stem(&src), &src) {
            pairs.push((q, dest_dir.clone()));
        }
        for q in raws_for(&raw_src, &stem(&src)).into_iter().chain(sidecars_in(&raw_src, &stem(&src), &src)) {
            pairs.push((q, raw_sibling(&dest_dir)));
        }
        for (from, dir) in pairs {
            if !from.exists() {
                continue;
            }
            let to = move_file(lib, &from, &dir)?;
            batch.push((from.to_string_lossy().into(), to.to_string_lossy().into()));
        }
    }
    let n = batch.len();
    record(lib, batch)?;
    Ok(n)
}

fn stars_file(lib: &Path) -> PathBuf {
    state_dir(lib).join("stars.json")
}

/// Favourite shots, as library-relative paths (so they survive a trip to review and back).
pub fn stars(lib: &str) -> Vec<String> {
    fs::read(stars_file(Path::new(lib))).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn set_stars(lib: &str, paths: &[String], on: bool) -> Result<Vec<String>, String> {
    let mut v = stars(lib);
    for path in paths {
        let rel = Path::new(path).strip_prefix(lib).map_err(err)?.to_string_lossy().to_string();
        v.retain(|r| r != &rel);
        if on {
            v.push(rel);
        }
    }
    fs::write(stars_file(Path::new(lib)), serde_json::to_vec(&v).map_err(err)?).map_err(err)?;
    Ok(v)
}
