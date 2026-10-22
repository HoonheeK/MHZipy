//! Native drag & drop bridge between MHZipy windows and Windows File Explorer.
//!
//! * Outgoing (MHZipy -> Explorer): `start_native_file_drag` builds a real Shell
//!   data object (CF_HDROP etc.) from file paths and runs `SHDoDragDrop`, so
//!   Explorer (and any other app) treats the drag exactly like a drag from Explorer
//!   itself (move/copy decided by Explorer, Ctrl/Shift modifiers work).
//! * Incoming (Explorer -> MHZipy): the main/child windows run with
//!   `dragDropEnabled: false` so HTML5 DnD works, but HTML5 `File` objects don't
//!   expose a file system path. WebView2 provides
//!   `chrome.webview.postMessageWithAdditionalObjects`, which hands the dropped
//!   `File`s to the host as `ICoreWebView2File` (with `Path`). We hook
//!   `WebMessageReceived` on every webview, extract the paths and emit them back
//!   to the same webview as `mhz-external-drop-paths`.

#[cfg(windows)]
mod imp {
    use tauri::{Emitter, Runtime, Webview, WebviewWindow};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::WebMessageReceivedEventHandler;
    use windows61::core::{Interface, HSTRING, PWSTR};
    use windows61::Win32::Foundation::HWND;
    use windows61::Win32::System::Com::{CoTaskMemFree, IDataObject};
    use windows61::Win32::System::Ole::{
        DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE, DROPEFFECT_NONE,
    };
    use windows61::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows61::Win32::UI::Shell::{
        BHID_DataObject, IShellItemArray, SHCreateShellItemArrayFromIDLists, SHDoDragDrop,
        SHParseDisplayName,
    };

    pub const EXTERNAL_DROP_MESSAGE: &str = "mhz-external-drop";
    pub const EXTERNAL_DROP_EVENT: &str = "mhz-external-drop-paths";

    /// Register a WebMessageReceived handler that converts dropped HTML5 files to paths.
    pub fn attach_external_drop_handler<R: Runtime>(webview: &Webview<R>) {
        let target = webview.clone();
        let _ = webview.with_webview(move |pw| unsafe {
            let controller = pw.controller();
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            let target = target.clone();
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut raw = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut raw).is_err() {
                    return Ok(());
                }
                let text = webview2_com::take_pwstr(raw);
                if text != EXTERNAL_DROP_MESSAGE {
                    return Ok(());
                }

                let mut paths: Vec<String> = Vec::new();
                if let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() {
                    if let Ok(objects) = args2.AdditionalObjects() {
                        let mut count: u32 = 0;
                        let _ = objects.Count(&mut count);
                        for i in 0..count {
                            if let Ok(obj) = objects.GetValueAtIndex(i) {
                                if let Ok(file) = obj.cast::<ICoreWebView2File>() {
                                    let mut p = PWSTR::null();
                                    if file.Path(&mut p).is_ok() {
                                        let s = webview2_com::take_pwstr(p);
                                        if !s.is_empty() {
                                            paths.push(s);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                let _ = target.emit_to(target.label(), EXTERNAL_DROP_EVENT, paths);
                Ok(())
            }));
            let mut token: i64 = 0;
            let _ = core.add_WebMessageReceived(&handler, &mut token);
        });
    }

    /// Runs a modal Shell drag loop. Must be called on the UI (STA) thread.
    unsafe fn do_drag(hwnd: isize, paths: &[String]) -> Result<String, String> {
        let mut pidls: Vec<*mut ITEMIDLIST> = Vec::new();
        for p in paths {
            let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
            let name = HSTRING::from(p.as_str());
            if SHParseDisplayName(&name, None, &mut pidl, 0, None).is_ok() && !pidl.is_null() {
                pidls.push(pidl);
            }
        }
        if pidls.is_empty() {
            return Err("No valid paths to drag".into());
        }

        let const_pidls: Vec<*const ITEMIDLIST> =
            pidls.iter().map(|p| *p as *const ITEMIDLIST).collect();

        let result = (|| -> windows61::core::Result<DROPEFFECT> {
            let items: IShellItemArray = SHCreateShellItemArrayFromIDLists(&const_pidls)?;
            let data: IDataObject = items.BindToHandler(None, &BHID_DataObject)?;
            SHDoDragDrop(
                Some(HWND(hwnd as *mut core::ffi::c_void)),
                &data,
                None,
                DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK,
            )
        })();

        for p in pidls {
            CoTaskMemFree(Some(p as *const core::ffi::c_void));
        }

        match result {
            Ok(effect) => Ok(if effect.0 & DROPEFFECT_MOVE.0 != 0 {
                "move".into()
            } else if effect.0 & DROPEFFECT_COPY.0 != 0 {
                "copy".into()
            } else if effect.0 & DROPEFFECT_LINK.0 != 0 {
                "link".into()
            } else if effect == DROPEFFECT_NONE {
                "none".into()
            } else {
                "unknown".into()
            }),
            Err(e) => Err(e.to_string()),
        }
    }

    pub async fn start_native_file_drag<R: Runtime>(
        window: WebviewWindow<R>,
        paths: Vec<String>,
    ) -> Result<String, String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        window
            .run_on_main_thread(move || {
                let r = unsafe { do_drag(hwnd, &paths) };
                let _ = tx.send(r);
            })
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv().map_err(|e| e.to_string()).and_then(|r| r)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Start a native OS drag of the given files (Windows only).
#[tauri::command]
pub async fn start_native_file_drag(
    window: tauri::WebviewWindow,
    paths: Vec<String>,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        imp::start_native_file_drag(window, paths).await
    }
    #[cfg(not(windows))]
    {
        let _ = (window, paths);
        Err("Native file drag is only supported on Windows".into())
    }
}

/// Tauri plugin that wires the external-drop handler into every webview.
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("mhz-native-dnd")
        .on_webview_ready(|webview| {
            #[cfg(windows)]
            imp::attach_external_drop_handler(&webview);
            #[cfg(not(windows))]
            let _ = webview;
        })
        .build()
}
