//! Sharing: the system Share menu, copying files to the clipboard, revealing several files at once.

use std::path::Path;

fn existing(paths: &[String]) -> Result<Vec<String>, String> {
    let v: Vec<String> = paths.iter().filter(|p| Path::new(p).exists()).cloned().collect();
    if v.is_empty() { Err("no files".into()) } else { Ok(v) }
}

/// Button rectangle in CSS pixels, relative to the webview; the picker pops up next to it.
#[derive(serde::Deserialize, Clone, Copy)]
pub struct Anchor { x: f64, y: f64, w: f64, h: f64 }

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting, NSSharingServicePicker, NSView, NSWorkspace};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};

    fn urls(paths: &[String]) -> Vec<Retained<NSURL>> {
        paths.iter().map(|p| NSURL::fileURLWithPath(&NSString::from_str(p))).collect()
    }

    pub fn share(view: &NSView, paths: &[String], a: super::Anchor) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Some(content) = view.window().and_then(|w| w.contentView()) else { return };
        let items: Vec<Retained<AnyObject>> = urls(paths).into_iter().map(|u| u.into()).collect();
        let items = NSArray::from_retained_slice(&items);
        let b = content.bounds();
        let y = if content.isFlipped() { a.y } else { b.size.height - a.y - a.h };
        let rect = NSRect::new(NSPoint::new(a.x, y), NSSize::new(a.w, a.h));
        let picker = unsafe { NSSharingServicePicker::initWithItems(mtm.alloc(), &items) };
        picker.showRelativeToRect_ofView_preferredEdge(rect, &content, NSRectEdge::MinY);
        // The picker must outlive this call while its menu is open; it's tiny, so keep it.
        std::mem::forget(picker);
    }

    pub fn copy(paths: &[String]) -> bool {
        let objs: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> =
            urls(paths).into_iter().map(ProtocolObject::from_retained).collect();
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        pb.writeObjects(&NSArray::from_retained_slice(&objs))
    }

    pub fn reveal(paths: &[String]) {
        NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&urls(paths)));
    }
}

#[tauri::command]
pub fn share_files(window: tauri::WebviewWindow, paths: Vec<String>, anchor: Anchor) -> Result<(), String> {
    let paths = existing(&paths)?;
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        return window
            .run_on_main_thread(move || {
                if let Ok(v) = w.ns_view() {
                    mac::share(unsafe { &*(v as *const objc2_app_kit::NSView) }, &paths, anchor);
                }
            })
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, anchor);
        reveal_files(paths)
    }
}

#[tauri::command]
pub fn copy_files(window: tauri::WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    let paths = existing(&paths)?;
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        window.run_on_main_thread(move || { let _ = tx.send(mac::copy(&paths)); }).map_err(|e| e.to_string())?;
        return if rx.recv().unwrap_or(false) { Ok(()) } else { Err("clipboard".into()) };
    }
    #[cfg(target_os = "windows")]
    {
        let _ = window;
        // Set-Clipboard -LiteralPath puts real files on the clipboard (paste into Explorer, chats, mail).
        let list = paths.iter().map(|p| format!("'{}'", p.replace('\'', "''"))).collect::<Vec<_>>().join(",");
        let ok = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &format!("Set-Clipboard -LiteralPath {list}")])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        return if ok { Ok(()) } else { Err("clipboard".into()) };
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        use std::io::Write;
        let _ = window;
        // File managers and most apps on Linux accept a text/uri-list.
        let uris: String = paths.iter().map(|p| format!("file://{p}\r\n")).collect();
        let run = |cmd: &str, args: &[&str]| -> bool {
            std::process::Command::new(cmd).args(args).stdin(std::process::Stdio::piped()).spawn()
                .and_then(|mut c| { c.stdin.take().unwrap().write_all(uris.as_bytes())?; c.wait() })
                .map(|s| s.success()).unwrap_or(false)
        };
        if run("wl-copy", &["--type", "text/uri-list"]) || run("xclip", &["-selection", "clipboard", "-t", "text/uri-list"]) {
            Ok(())
        } else {
            Err("clipboard".into())
        }
    }
}

#[tauri::command]
pub fn reveal_files(paths: Vec<String>) -> Result<(), String> {
    let paths = existing(&paths)?;
    #[cfg(target_os = "macos")]
    {
        mac::reveal(&paths);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri_plugin_opener::reveal_items_in_dir(&paths).map_err(|e| e.to_string())
    }
}

