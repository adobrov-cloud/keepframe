use crate::emit;
use crate::preview::{exif_for, jpeg_for};
use crate::util::*;
use image::{imageops, GrayImage, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone)]
pub struct Rec {
    pub path: String,
    pub folder: String,
    pub name: String,
    pub size: u64,
    pub mtime: i64,
    pub model: Option<String>,
    pub iso: Option<f64>,
    pub f: Option<f64>,
    pub t: Option<f64>,
    pub fl: Option<f64>,
    pub ev: Option<f64>,
    /// Capture time as naive seconds (only differences matter).
    pub ts: Option<i64>,
    pub orient: u32,
    pub vertical: bool,
    pub mean: f32,
    pub hi: f32,
    pub lo: f32,
    /// Max local edge variance over a 4×4 grid — high when anything in frame is sharp.
    pub sharp: f32,
    /// Centre of the sharpest tile, 0..1 in the displayed (EXIF-rotated) frame.
    #[serde(default)]
    pub sharp_u: Option<f32>,
    #[serde(default)]
    pub sharp_v: Option<f32>,
    pub dhash: String,
    /// [latitude, longitude] from EXIF GPS, when the camera recorded it.
    #[serde(default)]
    pub gps: Option<[f64; 2]>,
    /// Record format version; older cached records are recomputed.
    #[serde(default)]
    pub ver: u32,
}

const REC_VER: u32 = 2;

fn gps(ex: &exif::Exif) -> Option<[f64; 2]> {
    let coord = |tag, rtag, neg: &str| {
        let f = ex.get_field(tag, exif::In::PRIMARY)?;
        let exif::Value::Rational(v) = &f.value else { return None };
        let d = v.first()?.to_f64() + v.get(1).map_or(0.0, |r| r.to_f64()) / 60.0 + v.get(2).map_or(0.0, |r| r.to_f64()) / 3600.0;
        let r = ex.get_field(rtag, exif::In::PRIMARY).map(|f| f.display_value().to_string()).unwrap_or_default();
        Some(if r.contains(neg) { -d } else { d })
    };
    let lat = coord(exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, "S")?;
    let lon = coord(exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef, "W")?;
    (lat.is_finite() && lon.is_finite() && (lat != 0.0 || lon != 0.0)).then_some([lat, lon])
}

#[derive(Serialize)]
pub struct Info {
    pub model: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<f64>,
    pub f: Option<f64>,
    pub t: Option<f64>,
    pub fl: Option<f64>,
    pub ev: Option<f64>,
}

pub fn info(cache: &Path, p: &Path) -> Info {
    let ex = jpeg_for(cache, p).and_then(|src| exif_for(p, &src)).or_else(|| read_exif(p));
    let ex = ex.as_ref();
    Info {
        model: ex.and_then(|e| text(e, exif::Tag::Model)),
        lens: ex.and_then(|e| text(e, exif::Tag::LensModel)),
        iso: ex.and_then(|e| num(e, exif::Tag::PhotographicSensitivity)),
        f: ex.and_then(|e| num(e, exif::Tag::FNumber)),
        t: ex.and_then(|e| num(e, exif::Tag::ExposureTime)),
        fl: ex.and_then(|e| num(e, exif::Tag::FocalLength)),
        ev: ex.and_then(|e| num(e, exif::Tag::ExposureBiasValue)),
    }
}

/// Decode a JPEG using DCT scaling so the longest side is at least `max_side`, then shrink to it.
pub fn decode_jpeg(p: &Path, max_side: u32) -> Result<RgbImage, String> {
    let mut d = jpeg_decoder::Decoder::new(BufReader::new(File::open(p).map_err(err)?));
    d.read_info().map_err(err)?;
    let info = d.info().ok_or("нет данных JPEG")?;
    let (w, h) = (info.width as u32, info.height as u32);
    let k = (max_side as f32 / w.max(h) as f32).min(1.0);
    d.scale(((w as f32 * k).ceil() as u16).max(1), ((h as f32 * k).ceil() as u16).max(1)).map_err(err)?;
    let px = d.decode().map_err(err)?;
    let info = d.info().unwrap();
    let (w, h) = (info.width as u32, info.height as u32);
    let img = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => RgbImage::from_raw(w, h, px),
        jpeg_decoder::PixelFormat::L8 => RgbImage::from_raw(w, h, px.iter().flat_map(|&v| [v, v, v]).collect()),
        jpeg_decoder::PixelFormat::L16 => RgbImage::from_raw(w, h, px.chunks(2).flat_map(|c| [c[0], c[0], c[0]]).collect()),
        jpeg_decoder::PixelFormat::CMYK32 => RgbImage::from_raw(
            w,
            h,
            px.chunks(4)
                .flat_map(|c| {
                    let k = 255 - c[3] as u32;
                    [c[0], c[1], c[2]].map(|v| ((255 - v as u32) * k / 255) as u8)
                })
                .collect(),
        ),
    }
    .ok_or("не удалось разобрать пиксели")?;
    Ok(if w.max(h) > max_side { imageops::thumbnail(&img, w * max_side / w.max(h), h * max_side / w.max(h)) } else { img })
}

fn num(ex: &exif::Exif, tag: exif::Tag) -> Option<f64> {
    let f = ex.get_field(tag, exif::In::PRIMARY)?;
    match &f.value {
        exif::Value::Rational(v) => v.first().map(|r| r.to_f64()),
        exif::Value::SRational(v) => v.first().map(|r| r.to_f64()),
        v => v.get_uint(0).map(|x| x as f64),
    }
    .filter(|x| x.is_finite())
}

fn text(ex: &exif::Exif, tag: exif::Tag) -> Option<String> {
    let f = ex.get_field(tag, exif::In::PRIMARY)?;
    if let exif::Value::Ascii(v) = &f.value {
        Some(String::from_utf8_lossy(v.first()?).trim_end_matches('\0').trim().to_string())
    } else {
        None
    }
}

fn metrics(g: &GrayImage) -> (f32, f32, f32, f32, (f32, f32), String) {
    let (w, h) = g.dimensions();
    let n = (w * h) as f32;
    let px = g.as_raw();
    let mean = px.iter().map(|&v| v as f32).sum::<f32>() / n;
    let hi = px.iter().filter(|&&v| v >= 250).count() as f32 / n;
    let lo = px.iter().filter(|&&v| v <= 5).count() as f32 / n;

    // Laplacian variance per tile; the sharpest tile decides.
    let mut sharp = 0f32;
    let mut at = (0.5f32, 0.5f32);
    for ty in 0..4 {
        for tx in 0..4 {
            let (x0, x1) = ((tx * w / 4).max(1), ((tx + 1) * w / 4).min(w - 1));
            let (y0, y1) = ((ty * h / 4).max(1), ((ty + 1) * h / 4).min(h - 1));
            let (mut s, mut s2, mut c) = (0f64, 0f64, 0f64);
            for y in y0..y1 {
                for x in x0..x1 {
                    let at = |x: u32, y: u32| px[(y * w + x) as usize] as f64;
                    let l = 4.0 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1);
                    s += l;
                    s2 += l * l;
                    c += 1.0;
                }
            }
            let var = if c > 0.0 { (s2 / c - (s / c).powi(2)) as f32 } else { 0.0 };
            if var > sharp {
                sharp = var;
                at = ((tx as f32 + 0.5) / 4.0, (ty as f32 + 0.5) / 4.0);
            }
        }
    }

    let small = imageops::resize(g, 9, 8, imageops::FilterType::Triangle);
    let mut bits: u64 = 0;
    for y in 0..8 {
        for x in 0..8 {
            if small.get_pixel(x, y)[0] > small.get_pixel(x + 1, y)[0] {
                bits |= 1 << (y * 8 + x);
            }
        }
    }
    (mean, hi, lo, sharp, at, format!("{bits:016x}"))
}

fn analyze_one(cache: &Path, p: &Path, lib: &Path, meta: &fs::Metadata) -> Option<Rec> {
    let src = jpeg_for(cache, p)?;
    let ex = exif_for(p, &src);
    let orient = ex.as_ref().and_then(|e| num(e, exif::Tag::Orientation)).unwrap_or(1.0) as u32;
    let img = decode_jpeg(&src, 800).ok()?;
    let gray = imageops::grayscale(&img);
    let (mean, hi, lo, sharp, (u, v), dhash) = metrics(&gray);
    // Same rotation the viewer applies, so the point lands on the displayed image.
    let (u, v) = match orient {
        3 | 4 => (1.0 - u, 1.0 - v),
        5 | 6 => (1.0 - v, u),
        7 | 8 => (v, 1.0 - u),
        _ => (u, v),
    };
    let rel_parent = p.parent()?.strip_prefix(lib).ok()?.to_string_lossy().to_string();
    let (w, h) = img.dimensions();
    let rotated = matches!(orient, 5..=8);
    Some(Rec {
        path: p.to_string_lossy().to_string(),
        folder: rel_parent,
        name: p.file_name()?.to_string_lossy().to_string(),
        size: meta.len(),
        mtime: mtime_secs(meta),
        model: ex.as_ref().and_then(|e| text(e, exif::Tag::Model)),
        iso: ex.as_ref().and_then(|e| num(e, exif::Tag::PhotographicSensitivity)),
        f: ex.as_ref().and_then(|e| num(e, exif::Tag::FNumber)),
        t: ex.as_ref().and_then(|e| num(e, exif::Tag::ExposureTime)),
        fl: ex.as_ref().and_then(|e| num(e, exif::Tag::FocalLength)),
        ev: ex.as_ref().and_then(|e| num(e, exif::Tag::ExposureBiasValue)),
        ts: ex.as_ref().and_then(exif_datetime).map(|d| d.and_utc().timestamp()),
        orient,
        vertical: (h > w) != rotated,
        mean,
        hi,
        lo,
        sharp,
        sharp_u: Some(u),
        sharp_v: Some(v),
        gps: ex.as_ref().and_then(gps),
        ver: REC_VER,
        dhash,
    })
}

/// One file per shot: the JPEG (or HEIF where it can be shown), else the RAW for RAW-only shots.
fn shots(lib: &Path) -> Vec<PathBuf> {
    let all = walk_media(lib, false);
    let viewable = |p: &Path| is_jpeg(p) || (is_heif(p) && cfg!(target_os = "macos"));
    let key = |dir: &Path, p: &Path| (dir.to_path_buf(), stem(p));
    let have: HashSet<(PathBuf, String)> = all.iter().filter(|p| viewable(p)).map(|p| key(p.parent().unwrap(), p)).collect();
    all.iter()
        .filter(|p| {
            if viewable(p) {
                return true;
            }
            if !is_raw(p) {
                return false;
            }
            let dir = p.parent().unwrap();
            let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let base = name.strip_suffix(" RAW").map(|b| dir.with_file_name(b)).unwrap_or_else(|| dir.to_path_buf());
            !have.contains(&key(&base, p)) && !have.contains(&key(dir, p))
        })
        .cloned()
        .collect()
}

pub fn run<R: tauri::Runtime>(app: &AppHandle<R>, cache_dir: &Path, lib: &str) -> Result<Vec<Rec>, String> {
    let lib = Path::new(lib);
    let cache_file = state_dir(lib).join("analysis.json");
    let cache: HashMap<String, Rec> =
        fs::read(&cache_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();

    let files: Vec<(PathBuf, fs::Metadata)> = shots(lib)
        .into_iter()
        .filter_map(|p| fs::metadata(&p).ok().map(|m| (p, m)))
        .collect();
    let total = files.len() as u64;
    let done = AtomicU64::new(0);
    let recs: Vec<Rec> = files
        .par_iter()
        .filter_map(|(p, m)| {
            let key = p.to_string_lossy().to_string();
            let r = match cache.get(&key) {
                Some(r) if r.size == m.len() && r.mtime == mtime_secs(m) && r.ver >= REC_VER => Some(r.clone()),
                _ => analyze_one(cache_dir, p, lib, m),
            };
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            if d % 10 == 0 || d == total {
                emit(app, "analyze", d, total, "@analyze");
            }
            r
        })
        .collect();

    let map: HashMap<String, Rec> = recs.iter().map(|r| (r.path.clone(), r.clone())).collect();
    if let Ok(b) = serde_json::to_vec(&map) {
        let _ = fs::write(&cache_file, b);
    }
    Ok(recs)
}

#[derive(Serialize)]
pub struct Video {
    pub path: String,
    pub folder: String,
    pub name: String,
    pub size: u64,
    pub mtime: i64,
}

pub fn videos(lib: &str) -> Vec<Video> {
    let lib = Path::new(lib);
    walk_media(lib, false)
        .into_iter()
        .filter(|p| is_video(p))
        .filter_map(|p| {
            let m = fs::metadata(&p).ok()?;
            Some(Video {
                folder: p.parent()?.strip_prefix(lib).ok()?.to_string_lossy().to_string(),
                name: p.file_name()?.to_string_lossy().to_string(),
                path: p.to_string_lossy().to_string(),
                size: m.len(),
                mtime: mtime_secs(&m),
            })
        })
        .collect()
}

/// Video poster frame via Quick Look (macOS only); returns a PNG.
fn video_thumb(dir: &Path, p: &Path, key: &str, size: u32) -> Result<PathBuf, String> {
    if !cfg!(target_os = "macos") {
        return Err("no video thumbnails on this platform".into());
    }
    let out = dir.join(format!("{key}_{size}.png"));
    if out.exists() {
        return Ok(out);
    }
    let tmp = dir.join(format!("{key}_{size}.ql"));
    fs::create_dir_all(&tmp).map_err(err)?;
    std::process::Command::new("qlmanage")
        .args(["-t", "-s", &size.to_string(), "-o"])
        .arg(&tmp)
        .arg(p)
        .output()
        .map_err(err)?;
    let made = fs::read_dir(&tmp).map_err(err)?.flatten().map(|e| e.path()).find(|q| ext(q) == "png");
    let res = match made {
        Some(q) => fs::rename(&q, &out).map_err(err).map(|_| out),
        None => Err("no poster frame".into()),
    };
    let _ = fs::remove_dir_all(&tmp);
    res
}

/// Cached, EXIF-rotated preview; returns its path for the asset protocol.
pub fn thumb(cache_dir: &Path, p: &Path, size: u32) -> Result<String, String> {
    let meta = fs::metadata(p).map_err(err)?;
    let mut h = Sha256::new();
    h.update(p.to_string_lossy().as_bytes());
    h.update(meta.len().to_le_bytes());
    h.update(mtime_secs(&meta).to_le_bytes());
    let dir = cache_dir.join("thumbs");
    fs::create_dir_all(&dir).map_err(err)?;
    let key = hex::encode(h.finalize())[..20].to_string();
    if is_video(p) {
        return video_thumb(&dir, p, &key, size).map(|q| q.to_string_lossy().to_string());
    }
    let out = dir.join(format!("{key}_{size}.jpg"));
    if !out.exists() {
        let src = jpeg_for(cache_dir, p).ok_or("no preview")?;
        let img = decode_jpeg(&src, size)?;
        let orient = exif_for(p, &src).and_then(|e| num(&e, exif::Tag::Orientation)).unwrap_or(1.0) as u32;
        let img = match orient {
            3 | 4 => imageops::rotate180(&img),
            5 | 6 => imageops::rotate90(&img),
            7 | 8 => imageops::rotate270(&img),
            _ => img,
        };
        let tmp = out.with_extension("part");
        let f = File::create(&tmp).map_err(err)?;
        image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(f), 82)
            .encode_image(&img)
            .map_err(err)?;
        fs::rename(&tmp, &out).map_err(err)?;
    }
    Ok(out.to_string_lossy().to_string())
}
