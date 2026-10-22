use dashmap::DashMap;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
pub struct IconRequest {
    pub key: String,
    pub path: Option<String>,
    pub extension: Option<String>,
    pub is_dir: bool,
}

static ICON_CACHE: OnceLock<DashMap<String, String>> = OnceLock::new();

fn get_cache() -> &'static DashMap<String, String> {
    ICON_CACHE.get_or_init(DashMap::new)
}

#[cfg(target_os = "windows")]
mod win_icon {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC,
        BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES,
    };
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    fn to_wide_null(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn get_icon_base64(path: Option<&str>, ext: Option<&str>, is_dir: bool) -> Option<String> {
        let mut shfi = SHFILEINFOW::default();
        let shfi_size = std::mem::size_of::<SHFILEINFOW>() as u32;

        let hicon: HICON = if is_dir {
            let wide = to_wide_null("folder");
            let res = unsafe {
                SHGetFileInfoW(
                    PCWSTR(wide.as_ptr()),
                    FILE_ATTRIBUTE_DIRECTORY,
                    Some(&mut shfi),
                    shfi_size,
                    SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES,
                )
            };
            if res == 0 || shfi.hIcon.is_invalid() {
                return None;
            }
            shfi.hIcon
        } else {
            // 특수 확장자(.exe, .lnk, .ico)이면서 실제 파일 경로가 주어진 경우 실제 파일에서 아이콘 추출
            let is_special_ext = ext.map(|e| {
                let lower = e.to_lowercase();
                lower == "exe" || lower == "lnk" || lower == "ico"
            }).unwrap_or(false);

            if is_special_ext && path.is_some() {
                let wide = to_wide_null(path.unwrap());
                let res = unsafe {
                    SHGetFileInfoW(
                        PCWSTR(wide.as_ptr()),
                        FILE_FLAGS_AND_ATTRIBUTES(0),
                        Some(&mut shfi),
                        shfi_size,
                        SHGFI_ICON | SHGFI_SMALLICON,
                    )
                };
                if res != 0 && !shfi.hIcon.is_invalid() {
                    shfi.hIcon
                } else {
                    // 실패 시 확장자 기반 fallback
                    let fake_name = format!(".{}", ext.unwrap_or(""));
                    let wide = to_wide_null(&fake_name);
                    let res = unsafe {
                        SHGetFileInfoW(
                            PCWSTR(wide.as_ptr()),
                            FILE_ATTRIBUTE_NORMAL,
                            Some(&mut shfi),
                            shfi_size,
                            SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES,
                        )
                    };
                    if res == 0 || shfi.hIcon.is_invalid() {
                        return None;
                    }
                    shfi.hIcon
                }
            } else {
                // 일반 확장자 기반 조회 (가장 빠르고 파일 I/O 없음)
                let fake_name = match ext {
                    Some(e) if !e.is_empty() => {
                        if e.starts_with('.') {
                            e.to_string()
                        } else {
                            format!(".{}", e)
                        }
                    }
                    _ => ".txt".to_string(),
                };
                let wide = to_wide_null(&fake_name);
                let res = unsafe {
                    SHGetFileInfoW(
                        PCWSTR(wide.as_ptr()),
                        FILE_ATTRIBUTE_NORMAL,
                        Some(&mut shfi),
                        shfi_size,
                        SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES,
                    )
                };
                if res == 0 || shfi.hIcon.is_invalid() {
                    return None;
                }
                shfi.hIcon
            }
        };

        let result = hicon_to_png_base64(hicon);
        unsafe {
            let _ = DestroyIcon(hicon);
        }
        result
    }

    fn hicon_to_png_base64(hicon: HICON) -> Option<String> {
        unsafe {
            let mut icon_info = ICONINFO::default();
            if GetIconInfo(hicon, &mut icon_info).is_err() {
                return None;
            }

            let mut bm = BITMAP::default();
            let bm_size = std::mem::size_of::<BITMAP>() as i32;
            if GetObjectW(
                icon_info.hbmColor,
                bm_size,
                Some(&mut bm as *mut _ as *mut _),
            ) == 0
            {
                let _ = DeleteObject(icon_info.hbmColor);
                let _ = DeleteObject(icon_info.hbmMask);
                return None;
            }

            let width = bm.bmWidth as u32;
            let height = bm.bmHeight.abs() as u32;

            if width == 0 || height == 0 {
                let _ = DeleteObject(icon_info.hbmColor);
                let _ = DeleteObject(icon_info.hbmMask);
                return None;
            }

            let hdc_screen = GetDC(HWND(0));
            let hdc_mem = CreateCompatibleDC(hdc_screen);

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width as i32,
                    biHeight: -(height as i32), // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                ..Default::default()
            };

            let mut pixels = vec![0u8; (width * height * 4) as usize];
            let lines = GetDIBits(
                hdc_mem,
                icon_info.hbmColor,
                0,
                height,
                Some(pixels.as_mut_ptr() as *mut _),
                &mut bmi,
                DIB_RGB_COLORS,
            );

            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(HWND(0), hdc_screen);
            let _ = DeleteObject(icon_info.hbmColor);
            let _ = DeleteObject(icon_info.hbmMask);

            if lines == 0 {
                return None;
            }

            // BGRA -> RGBA 변환 및 알파 채널 검사
            let mut has_alpha = false;
            for chunk in pixels.chunks_exact_mut(4) {
                let b = chunk[0];
                let r = chunk[2];
                let a = chunk[3];
                chunk[0] = r;
                chunk[2] = b;
                if a > 0 {
                    has_alpha = true;
                }
            }

            // 알파 채널이 전부 0인 레거시 24비트 아이콘의 경우 완전 불투명(255)으로 설정
            if !has_alpha {
                for chunk in pixels.chunks_exact_mut(4) {
                    chunk[3] = 255;
                }
            }

            // PNG로 인코딩
            let mut png_data = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut png_data, width, height);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().ok()?;
                writer.write_image_data(&pixels).ok()?;
            }

            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&png_data);
            Some(format!("data:image/png;base64,{}", b64))
        }
    }
}

pub fn get_icon(path: Option<&str>, ext: Option<&str>, is_dir: bool) -> Option<String> {
    let cache_key = if is_dir {
        "__dir__".to_string()
    } else {
        let is_special_ext = ext.map(|e| {
            let lower = e.to_lowercase();
            lower == "exe" || lower == "lnk" || lower == "ico"
        }).unwrap_or(false);

        if is_special_ext && path.is_some() {
            format!("file:{}", path.unwrap().to_lowercase())
        } else {
            format!("ext:{}", ext.unwrap_or("").to_lowercase())
        }
    };

    let cache = get_cache();
    if let Some(cached) = cache.get(&cache_key) {
        return Some(cached.clone());
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(icon_b64) = win_icon::get_icon_base64(path, ext, is_dir) {
            cache.insert(cache_key, icon_b64.clone());
            return Some(icon_b64);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, ext, is_dir);
    }

    None
}

#[tauri::command]
pub fn get_file_icons(requests: Vec<IconRequest>) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for req in requests {
        if let Some(icon) = get_icon(req.path.as_deref(), req.extension.as_deref(), req.is_dir) {
            result.insert(req.key, icon);
        }
    }
    result
}
