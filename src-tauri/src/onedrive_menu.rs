//! OneDrive Windows Shell context menu integration.
//!
//! Queries and invokes the native OneDrive Shell context menu items
//! (Share, Copy link, Manage access, View online, Version history)
//! using their fixed language-independent GUID verbs while displaying
//! the user's native Windows localized labels.

#[derive(serde::Serialize, Clone, Debug)]
pub struct OneDriveMenuItem {
    pub verb: String,
    pub label: String,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::OneDriveMenuItem;
    use std::time::{Duration, Instant};
    use windows61::core::{HSTRING, PCSTR, PCWSTR, PSTR, PWSTR};
    use windows61::Win32::Foundation::{HWND, S_FALSE, S_OK};
    use windows61::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows61::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows61::Win32::UI::Shell::{
        IContextMenu, IShellFolder, SHBindToParent, SHParseDisplayName, CMF_EXPLORE, CMF_NORMAL,
        CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX, GCS_VERBW, SEE_MASK_UNICODE,
    };
    use windows61::Win32::UI::WindowsAndMessaging::{
        CreatePopupMenu, DestroyMenu, DispatchMessageW, GetMenuItemCount, GetMenuItemInfoW,
        PeekMessageW, TranslateMessage, MENUITEMINFOW, MFT_SEPARATOR, MIIM_FTYPE, MIIM_ID,
        MIIM_STRING, MSG, PM_REMOVE, SW_SHOWNORMAL,
    };
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const ID_FIRST: u32 = 1;
    const ID_LAST: u32 = 0x7FFF;

    const ONEDRIVE_VERBS: &[&str] = &[
        "{5250E46F-BB09-D602-5891-F476DC89B701}", // Share
        "{5250E46F-BB09-D602-5891-F476DC89B702}", // Copy link
        "{5250E46F-BB09-D602-5891-F476DC89B703}", // Manage access
        "{5250E46F-BB09-D602-5891-F476DC89B704}", // View online
        "{5250E46F-BB09-D602-5891-F476DC89B705}", // Version history
    ];

    fn normalize_path(path: &str) -> String {
        let mut s = path.trim_start_matches(r"\\?\").replace('/', "\\");
        while s.len() > 3 && s.ends_with('\\') {
            s.pop();
        }
        s
    }

    fn collect_onedrive_roots() -> Vec<String> {
        let mut roots = Vec::new();
        let mut push_root = |raw: String| {
            let norm = normalize_path(&raw).to_lowercase();
            if !norm.is_empty() && !roots.contains(&norm) {
                roots.push(norm);
            }
        };

        for key in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
            if let Ok(val) = std::env::var(key) {
                push_root(val);
            }
        }

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(providers) = hkcu.open_subkey(r"Software\SyncEngines\Providers\OneDrive") {
            for sub in providers.enum_keys().flatten() {
                if let Ok(k) = providers.open_subkey(&sub) {
                    if let Ok(mp) = k.get_value::<String, _>("MountPoint") {
                        push_root(mp);
                    }
                }
            }
        }
        if let Ok(accounts) = hkcu.open_subkey(r"Software\Microsoft\OneDrive\Accounts") {
            for sub in accounts.enum_keys().flatten() {
                if let Ok(k) = accounts.open_subkey(&sub) {
                    if let Ok(uf) = k.get_value::<String, _>("UserFolder") {
                        push_root(uf);
                    }
                }
            }
        }

        roots
    }

    fn is_inside_onedrive(path: &str) -> bool {
        let norm = normalize_path(path).to_lowercase();
        let roots = collect_onedrive_roots();
        roots.iter().any(|root| {
            norm == *root
                || (norm.starts_with(root) && norm.as_bytes().get(root.len()) == Some(&b'\\'))
        })
    }

    /// Removes Windows menu accelerator mnemonics like "(&S)" or "&" while preserving "&&" as "&".
    fn clean_menu_label(raw: &str) -> String {
        let mut s = raw.to_string();
        // Strip parenthesized accelerator such as "(&S)" or "(&V)"
        let bytes = s.as_bytes();
        if bytes.len() >= 4 {
            let mut out = String::with_capacity(s.len());
            let chars: Vec<char> = s.chars().collect();
            let mut i = 0;
            while i < chars.len() {
                if i + 3 < chars.len()
                    && chars[i] == '('
                    && chars[i + 1] == '&'
                    && chars[i + 2].is_ascii_alphanumeric()
                    && chars[i + 3] == ')'
                {
                    i += 4;
                } else {
                    out.push(chars[i]);
                    i += 1;
                }
            }
            s = out;
        }

        let mut result = String::with_capacity(s.len());
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '&' {
                if chars.peek() == Some(&'&') {
                    chars.next();
                    result.push('&');
                }
            } else {
                result.push(c);
            }
        }
        result.trim().to_string()
    }

    unsafe fn get_command_verb(cm: &IContextMenu, cmd_offset: u32) -> Option<String> {
        let mut buf = [0u16; 260];
        let hr = cm.GetCommandString(
            cmd_offset as usize,
            GCS_VERBW,
            None,
            PSTR(buf.as_mut_ptr() as *mut u8),
            buf.len() as u32,
        );
        if hr.is_ok() {
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            let s = String::from_utf16_lossy(&buf[..len]);
            if !s.is_empty() {
                return Some(s);
            }
        }
        None
    }

    unsafe fn with_context_menu<T, F>(path: &str, f: F) -> Result<T, String>
    where
        F: FnOnce(&IContextMenu, windows61::Win32::UI::WindowsAndMessaging::HMENU) -> Result<T, String>,
    {
        let clean_path = normalize_path(path);
        let hr_init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let should_uninit = hr_init == S_OK || hr_init == S_FALSE;

        let result = (|| -> Result<T, String> {
            let wide = HSTRING::from(&clean_path);
            let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
            SHParseDisplayName(&wide, None, &mut pidl, 0, None)
                .map_err(|e| format!("SHParseDisplayName failed: {}", e))?;

            let res = (|| -> Result<T, String> {
                let mut child_pidl: *mut ITEMIDLIST = std::ptr::null_mut();
                let folder: IShellFolder = SHBindToParent(pidl, Some(&mut child_pidl))
                    .map_err(|e| format!("SHBindToParent failed: {}", e))?;

                let apidl = [child_pidl as *const ITEMIDLIST];
                let cm: IContextMenu = folder
                    .GetUIObjectOf(HWND::default(), &apidl, None)
                    .map_err(|e| format!("GetUIObjectOf(IContextMenu) failed: {}", e))?;

                let hmenu =
                    CreatePopupMenu().map_err(|e| format!("CreatePopupMenu failed: {}", e))?;

                let inner = (|| -> Result<T, String> {
                    cm.QueryContextMenu(hmenu, 0, ID_FIRST, ID_LAST, CMF_NORMAL | CMF_EXPLORE)
                        .ok()
                        .map_err(|e| format!("QueryContextMenu failed: {}", e))?;
                    f(&cm, hmenu)
                })();

                let _ = DestroyMenu(hmenu);
                inner
            })();

            CoTaskMemFree(Some(pidl as *const _));
            res
        })();

        if should_uninit {
            CoUninitialize();
        }
        result
    }

    pub fn query_items(path: String) -> Result<Vec<OneDriveMenuItem>, String> {
        if !is_inside_onedrive(&path) {
            return Ok(Vec::new());
        }

        // Run on a dedicated STA thread so COM apartment never conflicts with Tokio workers
        std::thread::spawn(move || unsafe {
            with_context_menu(&path, |cm, hmenu| {
                let count = GetMenuItemCount(Some(hmenu));
                if count <= 0 {
                    return Ok(Vec::new());
                }

                let mut found: Vec<OneDriveMenuItem> = Vec::new();
                for i in 0..(count as u32) {
                    let mut mii = MENUITEMINFOW {
                        cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                        fMask: MIIM_ID | MIIM_FTYPE | MIIM_STRING,
                        ..Default::default()
                    };

                    if GetMenuItemInfoW(hmenu, i, true, &mut mii).is_err() {
                        continue;
                    }
                    if (mii.fType.0 & MFT_SEPARATOR.0) != 0 {
                        continue;
                    }
                    if mii.wID < ID_FIRST || mii.wID > ID_LAST {
                        continue;
                    }

                    let offset = mii.wID - ID_FIRST;
                    let Some(verb) = get_command_verb(cm, offset) else {
                        continue;
                    };

                    if !ONEDRIVE_VERBS
                        .iter()
                        .any(|v| v.eq_ignore_ascii_case(&verb))
                    {
                        continue;
                    }

                    let mut text_buf = vec![0u16; (mii.cch as usize) + 2];
                    mii.dwTypeData = PWSTR(text_buf.as_mut_ptr());
                    mii.cch = text_buf.len() as u32;
                    let label = if GetMenuItemInfoW(hmenu, i, true, &mut mii).is_ok() {
                        let len = text_buf
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(text_buf.len());
                        clean_menu_label(&String::from_utf16_lossy(&text_buf[..len]))
                    } else {
                        verb.clone()
                    };

                    found.push(OneDriveMenuItem { verb, label });
                }

                // Preserve canonical OneDrive order (Share, Copy link, Manage access, View online, Version history)
                found.sort_by_key(|item| {
                    ONEDRIVE_VERBS
                        .iter()
                        .position(|v| v.eq_ignore_ascii_case(&item.verb))
                        .unwrap_or(usize::MAX)
                });

                Ok(found)
            })
        })
        .join()
        .map_err(|_| "OneDrive menu thread panicked".to_string())?
    }

    pub fn invoke_item(path: String, target_verb: String) -> Result<(), String> {
        if !ONEDRIVE_VERBS
            .iter()
            .any(|v| v.eq_ignore_ascii_case(&target_verb))
        {
            return Err(format!("Unsupported OneDrive verb: {}", target_verb));
        }

        std::thread::spawn(move || unsafe {
            with_context_menu(&path, |cm, hmenu| {
                let count = GetMenuItemCount(Some(hmenu));
                if count <= 0 {
                    return Err("Context menu is empty".to_string());
                }

                let mut matched_offset: Option<u32> = None;
                for i in 0..(count as u32) {
                    let mut mii = MENUITEMINFOW {
                        cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                        fMask: MIIM_ID | MIIM_FTYPE,
                        ..Default::default()
                    };
                    if GetMenuItemInfoW(hmenu, i, true, &mut mii).is_err() {
                        continue;
                    }
                    if (mii.fType.0 & MFT_SEPARATOR.0) != 0 {
                        continue;
                    }
                    if mii.wID < ID_FIRST || mii.wID > ID_LAST {
                        continue;
                    }

                    let offset = mii.wID - ID_FIRST;
                    if let Some(verb) = get_command_verb(cm, offset) {
                        if verb.eq_ignore_ascii_case(&target_verb) {
                            matched_offset = Some(offset);
                            break;
                        }
                    }
                }

                let offset = matched_offset
                    .ok_or_else(|| format!("OneDrive command '{}' not found", target_verb))?;

                let ici = CMINVOKECOMMANDINFOEX {
                    cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
                    fMask: SEE_MASK_UNICODE,
                    hwnd: HWND::default(),
                    lpVerb: PCSTR(offset as usize as *const u8),
                    lpVerbW: PCWSTR(offset as usize as *const u16),
                    nShow: SW_SHOWNORMAL.0,
                    ..Default::default()
                };

                cm.InvokeCommand(&ici as *const CMINVOKECOMMANDINFOEX as *const CMINVOKECOMMANDINFO)
                    .map_err(|e| format!("InvokeCommand failed: {}", e))?;

                // Pump messages briefly so out-of-process OneDrive COM handoff finishes cleanly
                let start = Instant::now();
                let mut msg = MSG::default();
                while start.elapsed() < Duration::from_millis(250) {
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }

                Ok(())
            })
        })
        .join()
        .map_err(|_| "OneDrive invoke thread panicked".to_string())?
    }
}

#[tauri::command]
pub async fn get_onedrive_menu_items(path: String) -> Result<Vec<OneDriveMenuItem>, String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::query_items(path))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn invoke_onedrive_menu_item(path: String, verb: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::invoke_item(path, verb))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, verb);
        Err("OneDrive context menu is only supported on Windows".to_string())
    }
}
