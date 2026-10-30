//! A JPEG for every kind of photo, so analysis, thumbnails and zoom work the same for RAW-only and HEIF shooters:
//! JPEGs are used as they are, RAW files give up the full-size preview the camera embeds in them, and HEIF is
//! converted with the system's `sips` on macOS.

use crate::util::*;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

/// Path of a JPEG showing `p`, or None when the format can't be shown on this platform.
pub fn jpeg_for(cache: &Path, p: &Path) -> Option<PathBuf> {
    if is_jpeg(p) {
        return Some(p.to_path_buf());
    }
    if !is_raw(p) && !(is_heif(p) && cfg!(target_os = "macos")) {
        return None;
    }
    let meta = fs::metadata(p).ok()?;
    let mut h = Sha256::new();
    h.update(p.to_string_lossy().as_bytes());
    h.update(meta.len().to_le_bytes());
    h.update(mtime_secs(&meta).to_le_bytes());
    let dir = cache.join("previews");
    fs::create_dir_all(&dir).ok()?;
    let out = dir.join(format!("{}.jpg", &hex::encode(h.finalize())[..20]));
    if out.exists() {
        return Some(out);
    }
    let tmp = out.with_extension("part");
    if is_raw(p) {
        fs::write(&tmp, embedded_jpeg(&fs::read(p).ok()?)?).ok()?;
    } else {
        let ok = std::process::Command::new("sips")
            .args(["-s", "format", "jpeg", "-s", "formatOptions", "90"])
            .arg(p)
            .arg("--out")
            .arg(&tmp)
            .output()
            .ok()?
            .status
            .success();
        if !ok {
            let _ = fs::remove_file(&tmp);
            return None;
        }
    }
    fs::rename(&tmp, &out).ok()?;
    Some(out)
}

/// The largest colour JPEG stored inside a RAW file (the camera's preview).
fn embedded_jpeg(data: &[u8]) -> Option<Vec<u8>> {
    let mut best: Option<(u64, usize)> = None;
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF {
            let mut d = jpeg_decoder::Decoder::new(Cursor::new(&data[i..]));
            if d.read_info().is_ok() {
                if let Some(info) = d.info() {
                    let colour = info.pixel_format == jpeg_decoder::PixelFormat::RGB24
                        && info.coding_process != jpeg_decoder::CodingProcess::Lossless;
                    let area = info.width as u64 * info.height as u64;
                    if colour && best.map_or(true, |(a, _)| area > a) {
                        best = Some((area, i));
                    }
                }
            }
        }
        i += 1;
    }
    let (_, start) = best?;
    let end = jpeg_end(data, start)?;
    Some(data[start..end].to_vec())
}

/// Offset just past the EOI marker of the JPEG starting at `start`, walking its segments
/// (entropy-coded data after SOS is skipped up to the next real marker).
fn jpeg_end(data: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 2;
    loop {
        while *data.get(i)? != 0xFF {
            i += 1;
        }
        while *data.get(i)? == 0xFF {
            i += 1;
        }
        let m = *data.get(i)?;
        i += 1;
        match m {
            0xD9 => return Some(i),
            0xD0..=0xD7 | 0x01 => continue,
            _ => {
                let len = u16::from_be_bytes([*data.get(i)?, *data.get(i + 1)?]) as usize;
                i += len;
                if m == 0xDA {
                    // Scan data: stuffed 0xFF00 and restart markers belong to it.
                    loop {
                        if *data.get(i)? == 0xFF {
                            let n = *data.get(i + 1)?;
                            if n != 0x00 && !(0xD0..=0xD7).contains(&n) {
                                break;
                            }
                            i += 2;
                        } else {
                            i += 1;
                        }
                    }
                }
            }
        }
    }
}

/// EXIF for a shot: the file's own, falling back to its preview's (RAF and CR3 keep it in the embedded JPEG).
/// For HEIF the converted JPEG is the one the pixels come from, so its orientation is the one that applies.
pub fn exif_for(p: &Path, src: &Path) -> Option<exif::Exif> {
    if is_heif(p) {
        read_exif(src).or_else(|| read_exif(p))
    } else {
        read_exif(p).or_else(|| if src != p { read_exif(src) } else { None })
    }
}
