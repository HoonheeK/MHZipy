// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime};
use sysinfo::Disks;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Window, WindowEvent,
};
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::unstable::write::FileOptionsExt;
use regex::RegexBuilder;

mod mft;
use mft::MftIndex;
mod license;
mod icon;
mod native_dnd;

#[derive(serde::Serialize)]
struct ZipEntry {
    name: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
    size: u64,
    #[serde(rename = "isEncrypted")]
    is_encrypted: bool,
}

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    total: u64,
    processed: u64,
    filename: String,
}

#[derive(serde::Serialize)]
struct DirectoryEntry {
    name: String,
    path: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    #[serde(rename = "isFile")]
    is_file: bool,
    #[serde(rename = "isSymlink")]
    is_symlink: bool,
    size: u64,
    mtime: Option<u64>,
    birthtime: Option<u64>,
    atime: Option<u64>,
    readonly: bool,
}

// Helper to convert SystemTime to millis
fn to_millis(time: std::io::Result<SystemTime>) -> Option<u64> {
    time.ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

// 앱 상태 관리
struct AppState {
    mft: Arc<MftIndex>,
}

/// 앱 데이터 디렉터리에 인덱스 파일 경로를 가져옵니다.
fn get_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get app config directory: {}", e))?;

    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create app config directory: {}", e))?;
    }
    Ok(dir.join("mft_index.bin"))
}

#[tauri::command]
async fn build_mft_index(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    let index_for_build = state.mft.clone();

    // build_index는 CPU 집약적이고 동기적인 함수이므로, 비동기 런타임이 차단되지 않도록 별도 스레드에서 실행합니다.
    let (count, next_usn, journal_id) =
        tauri::async_runtime::spawn_blocking(move || index_for_build.build_index())
            .await
            .map_err(|e| e.to_string())??; // JoinError 처리 후 build_index의 Result 처리

    // 인덱스 파일 저장 (이것도 I/O 작업이므로 spawn_blocking 사용)
    let index_for_save = state.mft.clone();
    let index_path = get_index_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        index_for_save.save_to_disk(&index_path, next_usn, journal_id)
    })
    .await
    .map_err(|e| e.to_string())??;

    // 모니터링은 무한 루프이므로 별도의 OS 스레드에서 실행합니다.
    let index_for_monitor = state.mft.clone();
    let app_for_monitor = app.clone();
    std::thread::spawn(move || {
        index_for_monitor.monitor(next_usn, journal_id, move |changes| {
            let _ = app_for_monitor.emit("file-changes", changes);
        });
    });

    Ok(count)
}

#[tauri::command]
async fn search_mft(
    state: tauri::State<'_, AppState>,
    query: String,
    use_regex: bool,
) -> Result<Vec<String>, String> {
    let paths = state.mft.search(&query, use_regex);
    // PathBuf를 String으로 변환하여 반환
    Ok(paths
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
fn toggle_maximize(window: Window) -> Result<bool, String> {
    let is_max = window.is_maximized().map_err(|e| e.to_string())?;
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn is_window_maximized(window: Window) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
fn minimize_window(window: Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn close_window(window: Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_fullscreen(window: Window) -> Result<bool, String> {
    let is_fs = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!is_fs).map_err(|e| e.to_string())?;
    Ok(!is_fs)
}

#[tauri::command]
fn is_window_fullscreen(window: Window) -> Result<bool, String> {
    window.is_fullscreen().map_err(|e| e.to_string())
}

const SUPPORTED_IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "bmp", "ico", "tiff", "tif", "gif", "svg", "avif",
];

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ImageFileInfo {
    pub path: String,
    pub file_name: String,
    pub file_size: u64,
    pub modified_millis: u64,
}

#[tauri::command]
async fn get_folder_images(folder_path: String) -> Result<Vec<ImageFileInfo>, String> {
    let p = std::path::PathBuf::from(&folder_path);
    tauri::async_runtime::spawn_blocking(move || {
        if !p.is_dir() {
            return Err(format!("'{}' is not a directory.", p.display()));
        }

        let read_dir = fs::read_dir(&p).map_err(|e| format!("Failed to read folder: {}", e))?;
        let mut list = Vec::new();

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if SUPPORTED_IMAGE_EXTS.contains(&ext_lower.as_str()) {
                        let metadata = entry.metadata().ok();
                        let file_size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                        let modified_millis = metadata
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);

                        let file_name = path
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string();

                        list.push(ImageFileInfo {
                            path: path.to_string_lossy().to_string(),
                            file_name,
                            file_size,
                            modified_millis,
                        });
                    }
                }
            }
        }

        list.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
        Ok(list)
    })
    .await
    .map_err(|e| e.to_string())?
}

const SUPPORTED_VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "webm", "mov", "avi", "wmv", "flv", "m4v", "3gp", "ts", "asf", "rmvb",
];

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct VideoFileInfo {
    pub path: String,
    pub file_name: String,
    pub file_size: u64,
    pub modified_millis: u64,
}

#[tauri::command]
async fn get_folder_videos(folder_path: String) -> Result<Vec<VideoFileInfo>, String> {
    let p = std::path::PathBuf::from(&folder_path);
    tauri::async_runtime::spawn_blocking(move || {
        if !p.is_dir() {
            return Err(format!("'{}' is not a directory.", p.display()));
        }

        let read_dir = fs::read_dir(&p).map_err(|e| format!("Failed to read folder: {}", e))?;
        let mut list = Vec::new();

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if SUPPORTED_VIDEO_EXTS.contains(&ext_lower.as_str()) {
                        let metadata = entry.metadata().ok();
                        let file_size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                        let modified_millis = metadata
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);

                        let file_name = path
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string();

                        list.push(VideoFileInfo {
                            path: path.to_string_lossy().to_string(),
                            file_name,
                            file_size,
                            modified_millis,
                        });
                    }
                }
            }
        }

        list.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
        Ok(list)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct TextFileContent {
    pub content: String,
    pub encoding: String,
}

#[tauri::command]
fn read_text_file_content(path: String, encoding: Option<String>) -> Result<TextFileContent, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;

    // If explicit encoding is requested
    if let Some(ref enc_name) = encoding {
        let enc_clean = enc_name.trim();
        if enc_clean.eq_ignore_ascii_case("UTF-8 with BOM") || enc_clean.eq_ignore_ascii_case("utf-8-bom") {
            let slice = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { &bytes[..] };
            let (cow, _, _) = encoding_rs::UTF_8.decode(slice);
            return Ok(TextFileContent {
                content: cow.to_string(),
                encoding: "UTF-8 with BOM".to_string(),
            });
        }
        if let Some(enc) = encoding_rs::Encoding::for_label(enc_clean.as_bytes()) {
            let (cow, _, _) = enc.decode(&bytes);
            return Ok(TextFileContent {
                content: cow.to_string(),
                encoding: enc.name().to_string(),
            });
        }
    }

    // Auto-detect BOM
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (cow, _, _) = encoding_rs::UTF_8.decode(&bytes[3..]);
        return Ok(TextFileContent {
            content: cow.to_string(),
            encoding: "UTF-8 with BOM".to_string(),
        });
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes);
        return Ok(TextFileContent {
            content: cow.to_string(),
            encoding: "UTF-16 LE".to_string(),
        });
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes);
        return Ok(TextFileContent {
            content: cow.to_string(),
            encoding: "UTF-16 BE".to_string(),
        });
    }

    // Try strict UTF-8
    match std::str::from_utf8(&bytes) {
        Ok(s) => Ok(TextFileContent {
            content: s.to_string(),
            encoding: "UTF-8".to_string(),
        }),
        Err(_) => {
            // Try EUC-KR (CP949)
            let (cow_euckr, had_errors) = encoding_rs::EUC_KR.decode_without_bom_handling(&bytes);
            if !had_errors {
                Ok(TextFileContent {
                    content: cow_euckr.to_string(),
                    encoding: "EUC-KR".to_string(),
                })
            } else {
                // Fallback to UTF-8 lossy
                Ok(TextFileContent {
                    content: String::from_utf8_lossy(&bytes).to_string(),
                    encoding: "UTF-8".to_string(),
                })
            }
        }
    }
}

#[tauri::command]
fn save_text_file_content(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    let enc_str = encoding.as_deref().unwrap_or("UTF-8").trim();

    let bytes_to_write: Vec<u8> = if enc_str.eq_ignore_ascii_case("UTF-8 with BOM") || enc_str.eq_ignore_ascii_case("utf-8-bom") {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(content.as_bytes());
        b
    } else if let Some(enc) = encoding_rs::Encoding::for_label(enc_str.as_bytes()) {
        let (encoded_bytes, _, _) = enc.encode(&content);
        encoded_bytes.into_owned()
    } else {
        content.into_bytes()
    };

    fs::write(&path, &bytes_to_write).map_err(|e| format!("Failed to save file: {}", e))
}

// 압축 명령어
#[tauri::command]
fn compress_files(
    window: Window,
    paths: Vec<String>,
    target_zip_path: String,
    method: Option<String>,
    password: Option<String>,
    encryption_mode: Option<String>,
) -> Result<(), String> {
    let path = Path::new(&target_zip_path);
    let file = File::create(&path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);

    let compression = match method.as_deref().unwrap_or("deflated") {
        "stored" => zip::CompressionMethod::Stored,
        _ => zip::CompressionMethod::Deflated,
    };

    let mut options = FileOptions::<()>::default()
        .compression_method(compression)
        .unix_permissions(0o755);

    if let Some(ref pass) = password {
        if encryption_mode.as_deref() == Some("aes256") {
            options = options.with_aes_encryption(zip::AesMode::Aes256, pass);
        } else {
            options = options.with_deprecated_encryption(pass.as_bytes());
        }
    }

    // 1. 전체 크기 계산 (진행률 표시용)
    let mut total_size = 0u64;
    for src_path_str in &paths {
        let src_path = Path::new(src_path_str);
        if src_path.is_dir() {
            for entry in WalkDir::new(src_path) {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_type().is_file() {
                    total_size += entry.metadata().map_err(|e| e.to_string())?.len();
                }
            }
        } else {
            total_size += fs::metadata(src_path).map_err(|e| e.to_string())?.len();
        }
    }

    let mut processed_size = 0u64;
    let mut last_emit = Instant::now();
    let mut buffer = [0u8; 65536]; // 64KB 버퍼

    for src_path_str in paths {
        let src_path = Path::new(&src_path_str);

        // 폴더인 경우 재귀적으로 추가
        if src_path.is_dir() {
            let walk = WalkDir::new(src_path);
            for entry in walk {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();

                // ZIP 내부 경로 계산 (상대 경로)
                let name = path
                    .strip_prefix(src_path.parent().unwrap_or(Path::new("/")))
                    .map_err(|e| e.to_string())?;
                let path_as_string = name.to_str().ok_or("Invalid path")?.replace("\\", "/");

                if path.is_dir() {
                    zip.add_directory(path_as_string, options)
                        .map_err(|e| e.to_string())?;
                } else {
                    zip.start_file(path_as_string.clone(), options)
                        .map_err(|e| e.to_string())?;
                    let f = File::open(path).map_err(|e| e.to_string())?;
                    let mut reader = BufReader::new(f);

                    loop {
                        let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
                        if n == 0 {
                            break;
                        }
                        zip.write_all(&buffer[..n]).map_err(|e| e.to_string())?;

                        processed_size += n as u64;
                        if last_emit.elapsed().as_millis() > 100 {
                            // 0.1초마다 이벤트 전송
                            window
                                .emit(
                                    "compress-progress",
                                    ProgressPayload {
                                        total: total_size,
                                        processed: processed_size,
                                        filename: path_as_string.to_string(),
                                    },
                                )
                                .map_err(|e| e.to_string())?;
                            last_emit = Instant::now();
                        }
                    }
                }
            }
        } else {
            // 단일 파일인 경우
            let name = src_path.file_name().unwrap().to_str().unwrap();
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            let f = File::open(src_path).map_err(|e| e.to_string())?;
            let mut reader = BufReader::new(f);

            loop {
                let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                zip.write_all(&buffer[..n]).map_err(|e| e.to_string())?;

                processed_size += n as u64;
                if last_emit.elapsed().as_millis() > 100 {
                    window
                        .emit(
                            "compress-progress",
                            ProgressPayload {
                                total: total_size,
                                processed: processed_size,
                                filename: name.to_string(),
                            },
                        )
                        .map_err(|e| e.to_string())?;
                    last_emit = Instant::now();
                }
            }
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

// 해제 명령어
#[tauri::command]
fn extract_zip(
    zip_path: String,
    target_dir: String,
    password: Option<String>,
) -> Result<(), String> {
    let file = File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let is_encrypted = {
            let file = archive.by_index(i).map_err(|e| e.to_string())?;
            file.encrypted()
        };

        let mut file = if is_encrypted {
            match password {
                Some(ref p) => archive
                    .by_index_decrypt(i, p.as_bytes())
                    .map_err(|e| e.to_string())?,
                None => return Err("Password required".to_string()),
            }
        } else {
            archive.by_index(i).map_err(|e| e.to_string())?
        };

        let outpath = match file.enclosed_name() {
            Some(path) => Path::new(&target_dir).join(path),
            None => continue,
        };

        if (*file.name()).ends_with('/') {
            fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
            }
            let mut outfile = File::create(&outpath).map_err(|e| e.to_string())?;
            io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ZIP 파일 내용 목록 조회 명령어
#[tauri::command]
fn list_zip_contents(zip_path: String, password: Option<String>) -> Result<Vec<ZipEntry>, String> {
    let file = File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    // 파일 이름 목록을 미리 수집 (암호 문제로 by_index 실패 시 사용)
    let names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();

    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let file_result = if let Some(ref p) = password {
            archive.by_index_decrypt(i, p.as_bytes())
        } else {
            archive.by_index(i)
        };

        match file_result {
            Ok(file) => {
                entries.push(ZipEntry {
                    name: file.name().to_string(),
                    is_dir: file.is_dir(),
                    size: file.size(),
                    is_encrypted: file.encrypted(),
                });
            }
            Err(e) => {
                let err_str = e.to_string();
                // 암호가 필요하거나 잘못된 경우, 파일 이름만이라도 표시
                if err_str.contains("Password required") || err_str.contains("Invalid password") {
                    let name = names
                        .get(i)
                        .cloned()
                        .unwrap_or_else(|| format!("Unknown_{}", i));
                    entries.push(ZipEntry {
                        name: name.clone(),
                        is_dir: name.ends_with('/'),
                        size: 0, // 암호 없이는 크기를 정확히 알 수 없는 경우가 있음
                        is_encrypted: true,
                    });
                } else {
                    return Err(err_str);
                }
            }
        }
    }
    Ok(entries)
}

// 선택된 ZIP 파일 내용 압축 해제 명령어
#[tauri::command]
fn extract_zip_files(
    window: Window,
    zip_path: String,
    files: Option<Vec<String>>,
    target_dir: String,
    overwrite: bool,
    password: Option<String>,
) -> Result<(), String> {
    let file = File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let target_path = Path::new(&target_dir);

    // 추출할 파일 인덱스 식별 및 전체 크기 계산
    // 먼저 파일 이름 목록을 확보한 뒤, 제공된 비밀번호로 항목을 열어보거나
    // 암호가 필요하면 크기를 알 수 없으므로 0으로 처리하여 진행합니다.
    let names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();
    let mut indices = Vec::new();
    let mut total_size = 0u64;
    for i in 0..archive.len() {
        let name = names
            .get(i)
            .cloned()
            .unwrap_or_else(|| format!("Unknown_{}", i));

        // Determine whether this entry is targeted
        let is_target = if let Some(ref target_files) = files {
            target_files.iter().any(|f| {
                if *f == name {
                    return true;
                }
                if f.ends_with('/') && name.starts_with(f) {
                    return true;
                }
                if name.starts_with(f) && name.chars().nth(f.len()) == Some('/') {
                    return true;
                }
                false
            })
        } else {
            true
        };

        if !is_target {
            continue;
        }

        // Try to open the entry using provided password if any, otherwise try without.
        let file_result = if let Some(ref p) = password {
            archive.by_index_decrypt(i, p.as_bytes())
        } else {
            archive.by_index(i)
        };

        match file_result {
            Ok(f) => {
                indices.push(i);
                if !f.is_dir() {
                    total_size += f.size();
                }
            }
            Err(e) => {
                let err_str = e.to_string();
                // If password is required or invalid, include the index but size unknown (0)
                if err_str.contains("Password required") || err_str.contains("Invalid password") {
                    indices.push(i);
                    // size unknown when encrypted and password not provided or invalid
                } else {
                    return Err(err_str);
                }
            }
        }
    }

    // 덮어쓰기 방지 체크 (overwrite가 false일 경우)
    if !overwrite {
        for &i in &indices {
            let file = if let Some(ref p) = password {
                archive
                    .by_index_decrypt(i, p.as_bytes())
                    .map_err(|e| e.to_string())?
            } else {
                archive.by_index(i).map_err(|e| e.to_string())?
            };
            if file.is_dir() {
                continue;
            } // 폴더는 체크 제외

            let outpath = match file.enclosed_name() {
                Some(path) => target_path.join(path),
                None => continue,
            };
            if outpath.exists() {
                return Err("FILE_EXISTS".to_string());
            }
        }
    }

    let mut processed_size = 0u64;
    let mut last_emit = Instant::now();
    let mut buffer = [0u8; 65536]; // 64KB 버퍼

    // 파일 추출 실행
    for &i in &indices {
        let mut file = if let Some(ref p) = password {
            archive
                .by_index_decrypt(i, p.as_bytes())
                .map_err(|e| e.to_string())?
        } else {
            archive.by_index(i).map_err(|e| e.to_string())?
        };
        let outpath = match file.enclosed_name() {
            Some(path) => target_path.join(path),
            None => continue,
        };

        let file_name = file.name().to_string();

        if file.is_dir() {
            fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
            }
            let mut outfile = File::create(&outpath).map_err(|e| e.to_string())?;

            loop {
                let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                outfile.write_all(&buffer[..n]).map_err(|e| e.to_string())?;

                processed_size += n as u64;
                if last_emit.elapsed().as_millis() > 100 {
                    window
                        .emit(
                            "extract-progress",
                            ProgressPayload {
                                total: total_size,
                                processed: processed_size,
                                filename: file_name.clone(),
                            },
                        )
                        .map_err(|e| e.to_string())?;
                    last_emit = Instant::now();
                }
            }
        }
    }
    // 완료 이벤트 전송
    window
        .emit(
            "extract-progress",
            ProgressPayload {
                total: total_size,
                processed: total_size,
                filename: "Complete".to_string(),
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    open::that(path).map_err(|e| e.to_string())
}

// 휴지통으로 이동 명령어
#[tauri::command]
fn delete_to_trash(paths: Vec<String>) -> Result<(), String> {
    trash::delete_all(&paths).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_available_drives() -> Vec<String> {
    let disks = Disks::new_with_refreshed_list();
    let mut drives: Vec<String> = disks
        .iter()
        .map(|disk| disk.mount_point().to_string_lossy().to_string())
        .collect();

    for key in [
        "OneDrive",
        "OneDriveConsumer",
        "OneDriveCommercial",
        "Google Drive",
        "Dropbox",
    ]
    .iter()
    {
        if let Ok(path) = std::env::var(key) {
            if !drives.contains(&path) {
                drives.push(path);
            }
        }
    }
    drives
}

#[tauri::command]
async fn read_directory(path: String) -> Result<Vec<DirectoryEntry>, String> {
    let path_buf = PathBuf::from(&path);
    let entries = tauri::async_runtime::spawn_blocking(move || {
        let mut result = Vec::new();
        if let Ok(read_dir) = fs::read_dir(&path_buf) {
            for entry in read_dir.filter_map(|e| e.ok()) {
                let metadata = entry.metadata().ok();
                let file_type = entry.file_type().ok();

                result.push(DirectoryEntry {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: entry.path().to_string_lossy().to_string(),
                    is_directory: file_type.as_ref().map(|ft| ft.is_dir()).unwrap_or(false),
                    is_file: file_type.as_ref().map(|ft| ft.is_file()).unwrap_or(false),
                    is_symlink: file_type
                        .as_ref()
                        .map(|ft| ft.is_symlink())
                        .unwrap_or(false),
                    size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
                    mtime: metadata.as_ref().and_then(|m| to_millis(m.modified())),
                    birthtime: metadata.as_ref().and_then(|m| to_millis(m.created())),
                    atime: metadata.as_ref().and_then(|m| to_millis(m.accessed())),
                    readonly: metadata
                        .as_ref()
                        .map(|m| m.permissions().readonly())
                        .unwrap_or(false),
                });
            }
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(entries)
}

#[tauri::command]
async fn search_directory(path: String, query: String, use_regex: bool) -> Result<Vec<String>, String> {
    // CPU 집약적이거나 I/O 작업이 많을 수 있으므로 spawn_blocking 사용
    let results = tauri::async_runtime::spawn_blocking(move || {
        let mut matches = Vec::new();
        
        let regex = if use_regex {
            RegexBuilder::new(&query)
                .case_insensitive(true)
                .build()
                .ok()
        } else {
            None
        };
        let query_lower = query.to_lowercase();

        for entry in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy();
            let is_match = if let Some(re) = &regex {
                re.is_match(&name)
            } else {
                name.to_lowercase().contains(&query_lower)
            };

            if is_match {
                matches.push(entry.path().to_string_lossy().to_string());
                if matches.len() >= 1000 {
                    // 결과 너무 많으면 제한
                    break;
                }
            }
        }
        matches
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(results)
}

#[tauri::command]
fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::mem;
        use std::os::windows::ffi::OsStrExt;
        use std::ptr;
        // HWND와 HANDLE 생성 방식을 수정합니다.
        use windows::Win32::Foundation::{HANDLE, HWND, POINT};
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };
        use windows::Win32::UI::Shell::DROPFILES;

        let mut wide_paths = Vec::new();
        for path in paths {
            wide_paths.extend(OsStr::new(&path).encode_wide());
            wide_paths.push(0);
        }
        wide_paths.push(0);

        let dropfiles_size = mem::size_of::<DROPFILES>();
        let paths_size = wide_paths.len() * 2;
        let total_size = dropfiles_size + paths_size;

        unsafe {
            let h_global = GlobalAlloc(GMEM_MOVEABLE, total_size).map_err(|e| e.to_string())?;
            let ptr = GlobalLock(h_global);
            if ptr.is_null() {
                return Err("GlobalLock failed".to_string());
            }

            // --- 데이터를 쓰는 동안은 Lock 상태 유지 ---
            let dropfiles = ptr as *mut DROPFILES;
            (*dropfiles).pFiles = dropfiles_size as u32;
            (*dropfiles).pt = POINT { x: 0, y: 0 };
            (*dropfiles).fNC = false.into();
            (*dropfiles).fWide = true.into();

            let paths_ptr = (ptr as *mut u8).add(dropfiles_size) as *mut u16;
            ptr::copy_nonoverlapping(wide_paths.as_ptr(), paths_ptr, wide_paths.len());
            // ---------------------------------------

            // 데이터 복사가 끝났으므로 이제 Unlock
            let _ = GlobalUnlock(h_global);

            if OpenClipboard(HWND::default()).is_ok() {
                let _ = EmptyClipboard();
                let handle = HANDLE(h_global.0 as isize);

                // SetClipboardData에 핸들을 넘기면, 이후 해당 메모리의 소유권은 시스템이 가집니다.
                if let Err(e) = SetClipboardData(15, handle) {
                    let _ = CloseClipboard();
                    return Err(format!("SetClipboardData failed: {}", e));
                }
                let _ = CloseClipboard();
            } else {
                // 클립보드 열기 실패 시 메모리 해제 고려가 필요할 수 있으나,
                // 일반적으로 GlobalAlloc된 핸들은 시스템에 등록되지 않으면 직접 해제해야 합니다.
                return Err("OpenClipboard failed".to_string());
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn get_files_from_clipboard() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
        use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
        use windows::Win32::Foundation::HWND;
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;

        unsafe {
            if OpenClipboard(HWND::default()).is_ok() {
                // CF_HDROP format is 15
                let handle = GetClipboardData(15);
                if let Ok(h_global) = handle {
                    let h_drop = HDROP(h_global.0);
                    let count = DragQueryFileW(h_drop, 0xFFFFFFFF, None);
                    let mut paths = Vec::new();

                    for i in 0..count {
                        let len = DragQueryFileW(h_drop, i, None);
                        let mut buffer = vec![0u16; (len + 1) as usize];
                        DragQueryFileW(h_drop, i, Some(&mut buffer));
                        
                        let path = OsString::from_wide(&buffer[..len as usize]);
                        paths.push(path.to_string_lossy().into_owned());
                    }
                    let _ = CloseClipboard();
                    return Ok(paths);
                }
                let _ = CloseClipboard();
            }
        }
    }
    Ok(Vec::new())
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::{Command, Stdio};
        println!("[DEBUG] Attempting to open in explorer: {}", path);

        // explorer.exe는 GUI 애플리케이션이므로, 부모 프로세스의 stdio를 상속하면
        // 예기치 않은 동작을 유발할 수 있습니다. stdio를 null로 리디렉션하여
        // 자식 프로세스를 완전히 분리하는 것이 안정적입니다.
        let result = Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();

        if let Err(e) = result {
            let error_message = format!("Failed to spawn explorer.exe for path '{}': {}", path, e);
            println!("[ERROR] {}", error_message);
            return Err(error_message);
        }
        
        println!("[DEBUG] Successfully spawned explorer.exe for path: {}", path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let path_buf = std::path::PathBuf::from(path);
        if path_buf.is_file() {
            if let Some(parent) = path_buf.parent() {
                open::that(parent).map_err(|e| e.to_string())?;
            }
        } else {
            open::that(path_buf).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
fn get_license_info(app: tauri::AppHandle) -> license::LicenseInfo {
    license::get_license_status(&app)
}

#[tauri::command]
fn activate_license(app: tauri::AppHandle, email: String, code: String) -> Result<license::LicenseInfo, String> {
    license::activate(&app, &email, &code)
}

#[tauri::command]
fn get_web_app_url() -> String {
    license::WEB_APP_URL.to_string()
}

#[tauri::command]
fn convert_pptx_to_pdf(
    window: tauri::Window,
    source_path: String,
    target_dir: Option<String>,
) -> Result<String, String> {
    let src_path = Path::new(&source_path);
    let mut tgt_dir_path = src_path.parent().unwrap().to_path_buf();
    
    if let Some(dir) = target_dir {
        if !dir.is_empty() {
            tgt_dir_path = PathBuf::from(dir);
        }
    }
    
    if !tgt_dir_path.exists() {
        fs::create_dir_all(&tgt_dir_path).map_err(|e| e.to_string())?;
    }

    let file_stem = src_path.file_stem().unwrap().to_string_lossy().to_string();
    let mut tgt_path = tgt_dir_path.join(format!("{}.pdf", file_stem));
    let mut counter = 1;
    while tgt_path.exists() {
        tgt_path = tgt_dir_path.join(format!("{} ({}).pdf", file_stem, counter));
        counter += 1;
    }
    
    let target_path_str = tgt_path.to_string_lossy().to_string();
    
    let window_clone = window.clone();
    let src_clone = source_path.clone();
    let tgt_clone = target_path_str.clone();
    
    std::thread::spawn(move || {
        // Report 10%
        let _ = window_clone.emit("pdf-conversion-progress", ProgressPayload {
            total: 100,
            processed: 10,
            filename: file_stem.clone()
        });

        // office2pdf doesn't have progress callbacks, so we just run it.
        // It might take a few seconds. We'll spawn another thread to simulate progress up to 90%.
        let w2 = window_clone.clone();
        let name_clone = file_stem.clone();
        
        use std::sync::atomic::{AtomicBool, Ordering};
        let is_done = Arc::new(AtomicBool::new(false));
        let is_done_clone = is_done.clone();
        
        std::thread::spawn(move || {
            for i in 2..=9 {
                std::thread::sleep(std::time::Duration::from_millis(600));
                if is_done_clone.load(Ordering::SeqCst) {
                    break;
                }
                let _ = w2.emit("pdf-conversion-progress", ProgressPayload {
                    total: 100,
                    processed: i * 10,
                    filename: name_clone.clone()
                });
            }
        });

        let ps_script = r#"
            param(
                [Parameter(Mandatory=$true)][string]$SourcePath,
                [Parameter(Mandatory=$true)][string]$TargetPath
            )

            $SourcePath = Resolve-Path -Path $SourcePath -ErrorAction Stop
            $TargetPath = [System.IO.Path]::GetFullPath($TargetPath)

            try {
                $ppSaveAsPDF = 32
                $ppt = New-Object -ComObject PowerPoint.Application
                $presentation = $ppt.Presentations.Open($SourcePath, $true, $false, $false)

                # Section 정보 추출
                $sections = @()
                $sectionCount = $presentation.SectionProperties.Count
                if ($sectionCount -gt 0) {
                    for ($i = 1; $i -le $sectionCount; $i++) {
                        $name = $presentation.SectionProperties.Name($i)
                        $firstSlide = $presentation.SectionProperties.FirstSlide($i)
                        $slideCount = $presentation.SectionProperties.SlidesCount($i)
                        $sections += @{
                            name = $name
                            firstSlide = $firstSlide
                            slideCount = $slideCount
                        }
                    }
                }

                # 슬라이드 제목 정보 추출
                $slideTitles = @()
                $totalSlides = $presentation.Slides.Count
                for ($s = 1; $s -le $totalSlides; $s++) {
                    $slide = $presentation.Slides.Item($s)
                    $title = ""
                    try {
                        if ($slide.Shapes.HasTitle) {
                            $rawTitle = $slide.Shapes.Title.TextFrame.TextRange.Text
                            if ($rawTitle) {
                                $title = ($rawTitle -replace "[\r\n]+", " ").Trim()
                            }
                        }
                    } catch {}
                    if ([string]::IsNullOrWhiteSpace($title)) {
                        $title = "Slide $s"
                    }
                    $slideTitles += $title
                }

                $presentation.SaveAs($TargetPath, $ppSaveAsPDF)
                $presentation.Close()

                # JSON 출력
                $result = @{
                    sections = $sections
                    slideTitles = $slideTitles
                    totalSlides = $totalSlides
                }
                Write-Output "SECTION_JSON_START"
                Write-Output ($result | ConvertTo-Json -Depth 5 -Compress)
                Write-Output "SECTION_JSON_END"
            } catch {
                Write-Error "Failed to convert PPTX to PDF: $_"
                exit 1
            } finally {
                if ($ppt) {
                    $ppt.Quit()
                    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ppt) | Out-Null
                    [System.GC]::Collect()
                    [System.GC]::WaitForPendingFinalizers()
                }
            }
        "#;

        let ps_result = std::process::Command::new("powershell")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(&format!(
                "& {{ {} }} -SourcePath '{}' -TargetPath '{}'",
                ps_script,
                src_clone.replace("'", "''"),
                tgt_clone.replace("'", "''")
            ))
            .output();

        let mut com_success = false;
        let mut section_json: Option<String> = None;
        if let Ok(output) = ps_result {
            if output.status.success() {
                com_success = true;
                // stdout에서 Section JSON 추출
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                if let Some(start) = stdout.find("SECTION_JSON_START") {
                    if let Some(end) = stdout.find("SECTION_JSON_END") {
                        let json_str = stdout[start + "SECTION_JSON_START".len()..end].trim();
                        section_json = Some(json_str.to_string());
                    }
                }
            } else {
                println!("COM automation failed: {:?}", String::from_utf8_lossy(&output.stderr));
            }
        }

        let update_metadata = |tgt: &str, src: &str| {
            use lopdf::{Document, Object, StringFormat, Dictionary};
            if let Ok(mut doc) = Document::load(tgt) {
                let (info_id, mut info_dict) = if let Ok(obj) = doc.trailer.get(b"Info") {
                    if let Ok(id) = obj.as_reference() {
                        if let Ok(Object::Dictionary(dict)) = doc.get_object(id) {
                            (id, dict.clone())
                        } else {
                            (doc.new_object_id(), Dictionary::new())
                        }
                    } else {
                        (doc.new_object_id(), Dictionary::new())
                    }
                } else {
                    (doc.new_object_id(), Dictionary::new())
                };

                let mut utf16_src = vec![0xFE, 0xFF];
                for u in src.encode_utf16() {
                    utf16_src.push((u >> 8) as u8);
                    utf16_src.push((u & 0xFF) as u8);
                }
                
                let mut utf16_subject = vec![0xFE, 0xFF];
                for u in format!("Source: {}", src).encode_utf16() {
                    utf16_subject.push((u >> 8) as u8);
                    utf16_subject.push((u & 0xFF) as u8);
                }
                
                info_dict.set("Source", Object::String(utf16_src.clone(), StringFormat::Literal));
                info_dict.set("Subject", Object::String(utf16_subject.clone(), StringFormat::Literal));
                info_dict.set("Keywords", Object::String(utf16_subject, StringFormat::Literal));
                
                doc.objects.insert(info_id, Object::Dictionary(info_dict));
                doc.trailer.set("Info", info_id);
                let _ = doc.save(tgt);
            }
        };

        // PDF에 Section Outline(북마크) 추가
        let add_outline = |tgt: &str, json: &str| {
            use lopdf::{Document, Object, StringFormat, Dictionary};

            #[derive(Debug)]
            struct SectionInfo {
                name: String,
                first_slide: i64,
                slide_count: i64,
            }

            // 간단한 JSON 파싱 (serde 없이)
            let mut sections: Vec<SectionInfo> = Vec::new();
            let mut slide_titles: Vec<String> = Vec::new();

            // serde_json을 사용하여 파싱
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json) {
                if let Some(secs) = parsed.get("sections").and_then(|v| v.as_array()) {
                    for sec in secs {
                        let name = sec.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let first_slide = sec.get("firstSlide").and_then(|v| v.as_i64()).unwrap_or(1);
                        let slide_count = sec.get("slideCount").and_then(|v| v.as_i64()).unwrap_or(0);
                        sections.push(SectionInfo { name, first_slide, slide_count });
                    }
                }
                if let Some(titles) = parsed.get("slideTitles").and_then(|v| v.as_array()) {
                    for t in titles {
                        slide_titles.push(t.as_str().unwrap_or("").to_string());
                    }
                }
            }

            if sections.is_empty() && slide_titles.is_empty() {
                return;
            }

            if let Ok(mut doc) = Document::load(tgt) {
                let make_utf16 = |s: &str| -> Vec<u8> {
                    let mut bytes = vec![0xFE, 0xFF];
                    for u in s.encode_utf16() {
                        bytes.push((u >> 8) as u8);
                        bytes.push((u & 0xFF) as u8);
                    }
                    bytes
                };

                // 각 페이지의 Object ID를 가져옴
                let page_ids: Vec<(u32, u16)> = doc.page_iter().collect();

                if !sections.is_empty() {
                    // Section이 있는 경우: Section → Slide 계층 구조
                    // 섹션별로 슬라이드 아이템 생성
                    let mut section_items: Vec<((u32, u16), Vec<(u32, u16)>)> = Vec::new();

                    for sec in &sections {
                        let first = sec.first_slide as usize;
                        let count = sec.slide_count as usize;

                        // 자식 슬라이드 아이템 생성
                        let mut child_ids: Vec<(u32, u16)> = Vec::new();
                        for slide_idx in first..first + count {
                            if slide_idx < 1 || slide_idx > page_ids.len() {
                                continue;
                            }
                            let page_id = page_ids[slide_idx - 1];
                            let title = if slide_idx - 1 < slide_titles.len() {
                                slide_titles[slide_idx - 1].clone()
                            } else {
                                format!("Slide {}", slide_idx)
                            };

                            let mut child_dict = Dictionary::new();
                            child_dict.set("Title", Object::String(make_utf16(&title), StringFormat::Literal));
                            // Dest: [pageRef /Fit]
                            child_dict.set("Dest", Object::Array(vec![
                                Object::Reference(page_id),
                                Object::Name(b"Fit".to_vec()),
                            ]));
                            child_dict.set("Count", Object::Integer(0));
                            let child_id = doc.add_object(Object::Dictionary(child_dict));
                            child_ids.push(child_id);
                        }

                        // 섹션 아이템 생성
                        let mut sec_dict = Dictionary::new();
                        sec_dict.set("Title", Object::String(make_utf16(&sec.name), StringFormat::Literal));
                        // 첫 슬라이드로 이동
                        if first >= 1 && first <= page_ids.len() {
                            sec_dict.set("Dest", Object::Array(vec![
                                Object::Reference(page_ids[first - 1]),
                                Object::Name(b"Fit".to_vec()),
                            ]));
                        }
                        // Count: 음수 = 기본적으로 접힌 상태, 양수 = 펼쳐진 상태
                        sec_dict.set("Count", Object::Integer(-(child_ids.len() as i64)));
                        let sec_id = doc.add_object(Object::Dictionary(sec_dict));
                        section_items.push((sec_id, child_ids));
                    }

                    // 2. 링크드 리스트 구성 (First/Last/Next/Prev/Parent)
                    // 섹션 간 연결
                    let section_count = section_items.len();
                    for i in 0..section_count {
                        let (sec_id, ref children) = section_items[i];

                        // 자식 간 연결
                        if !children.is_empty() {
                            // Parent 설정 및 First/Last
                            if let Ok(Object::Dictionary(ref mut sec_dict)) = doc.get_object_mut(sec_id) {
                                sec_dict.set("First", Object::Reference(children[0]));
                                sec_dict.set("Last", Object::Reference(*children.last().unwrap()));
                            }

                            for j in 0..children.len() {
                                if let Ok(Object::Dictionary(ref mut child_dict)) = doc.get_object_mut(children[j]) {
                                    child_dict.set("Parent", Object::Reference(sec_id));
                                    if j > 0 {
                                        child_dict.set("Prev", Object::Reference(children[j - 1]));
                                    }
                                    if j + 1 < children.len() {
                                        child_dict.set("Next", Object::Reference(children[j + 1]));
                                    }
                                }
                            }
                        }

                        // 섹션 간 Prev/Next
                        if i > 0 {
                            let prev_sec_id = section_items[i - 1].0;
                            if let Ok(Object::Dictionary(ref mut sec_dict)) = doc.get_object_mut(sec_id) {
                                sec_dict.set("Prev", Object::Reference(prev_sec_id));
                            }
                        }
                        if i + 1 < section_count {
                            let next_sec_id = section_items[i + 1].0;
                            if let Ok(Object::Dictionary(ref mut sec_dict)) = doc.get_object_mut(sec_id) {
                                sec_dict.set("Next", Object::Reference(next_sec_id));
                            }
                        }
                    }

                    // 3. Outlines Dictionary 생성
                    let mut outlines_dict = Dictionary::new();
                    outlines_dict.set("Type", Object::Name(b"Outlines".to_vec()));
                    outlines_dict.set("First", Object::Reference(section_items[0].0));
                    outlines_dict.set("Last", Object::Reference(section_items.last().unwrap().0));
                    outlines_dict.set("Count", Object::Integer(section_count as i64));
                    let outlines_id = doc.add_object(Object::Dictionary(outlines_dict));

                    // 각 섹션의 Parent를 Outlines로 설정
                    for (sec_id, _) in &section_items {
                        if let Ok(Object::Dictionary(ref mut sec_dict)) = doc.get_object_mut(*sec_id) {
                            sec_dict.set("Parent", Object::Reference(outlines_id));
                        }
                    }

                    // 4. Catalog에 Outlines 설정
                    if let Ok(catalog_id) = doc.trailer.get(b"Root").and_then(|o| o.as_reference()) {
                        if let Ok(Object::Dictionary(ref mut catalog)) = doc.get_object_mut(catalog_id) {
                            catalog.set("Outlines", Object::Reference(outlines_id));
                            catalog.set("PageMode", Object::Name(b"UseOutlines".to_vec()));
                        }
                    }
                } else if !slide_titles.is_empty() {
                    // Section 없이 슬라이드 제목만 있는 경우: 플랫 목록
                    let mut item_ids: Vec<(u32, u16)> = Vec::new();
                    for (i, title) in slide_titles.iter().enumerate() {
                        if i >= page_ids.len() { break; }
                        let mut item_dict = Dictionary::new();
                        item_dict.set("Title", Object::String(make_utf16(title), StringFormat::Literal));
                        item_dict.set("Dest", Object::Array(vec![
                            Object::Reference(page_ids[i]),
                            Object::Name(b"Fit".to_vec()),
                        ]));
                        item_dict.set("Count", Object::Integer(0));
                        let item_id = doc.add_object(Object::Dictionary(item_dict));
                        item_ids.push(item_id);
                    }

                    if !item_ids.is_empty() {
                        // 링크드 리스트 연결
                        let mut outlines_dict = Dictionary::new();
                        outlines_dict.set("Type", Object::Name(b"Outlines".to_vec()));
                        outlines_dict.set("First", Object::Reference(item_ids[0]));
                        outlines_dict.set("Last", Object::Reference(*item_ids.last().unwrap()));
                        outlines_dict.set("Count", Object::Integer(item_ids.len() as i64));
                        let outlines_id = doc.add_object(Object::Dictionary(outlines_dict));

                        for i in 0..item_ids.len() {
                            if let Ok(Object::Dictionary(ref mut d)) = doc.get_object_mut(item_ids[i]) {
                                d.set("Parent", Object::Reference(outlines_id));
                                if i > 0 { d.set("Prev", Object::Reference(item_ids[i - 1])); }
                                if i + 1 < item_ids.len() { d.set("Next", Object::Reference(item_ids[i + 1])); }
                            }
                        }

                        if let Ok(catalog_id) = doc.trailer.get(b"Root").and_then(|o| o.as_reference()) {
                            if let Ok(Object::Dictionary(ref mut catalog)) = doc.get_object_mut(catalog_id) {
                                catalog.set("Outlines", Object::Reference(outlines_id));
                            }
                        }
                    }
                }

                let _ = doc.save(tgt);
            }
        };

        let res = if com_success {
            is_done.store(true, Ordering::SeqCst);
            update_metadata(&tgt_clone, &src_clone);
            if let Some(ref json) = section_json {
                add_outline(&tgt_clone, json);
            }
            let _ = window_clone.emit("pdf-conversion-complete", tgt_clone.clone());
            Ok(())
        } else {
            println!("Falling back to office2pdf...");
            match office2pdf::convert(&src_clone) {
                Ok(result) => {
                    is_done.store(true, Ordering::SeqCst);
                    
                    if let Err(e) = std::fs::write(&tgt_clone, &result.pdf) {
                        Err(e.to_string())
                    } else {
                        update_metadata(&tgt_clone, &src_clone);
                        // office2pdf fallback에서는 section info 없음
                        let _ = window_clone.emit("pdf-conversion-complete", tgt_clone.clone());
                        Ok(())
                    }
                },
                Err(e) => {
                    is_done.store(true, Ordering::SeqCst);
                    Err(e.to_string())
                }
            }
        };
        
        if let Err(e) = res {
            // Emitting error back to frontend (can use complete with error or separate event)
            let _ = window_clone.emit("pdf-conversion-error", e);
        }
    });

    Ok(target_path_str)
}

/// Windows 시작 시 자동 실행 여부를 확인합니다.
fn is_auto_start_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run") {
            return key.get_value::<String, _>("MHZipy").is_ok();
        }
    }
    false
}

/// Windows 시작 시 자동 실행을 설정하거나 해제합니다.
fn set_auto_start(enable: bool) {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            KEY_SET_VALUE | KEY_QUERY_VALUE,
        ) {
            if enable {
                // 현재 실행 파일 경로를 레지스트리에 등록
                if let Ok(exe_path) = std::env::current_exe() {
                    let val = format!("\"{}\" --autostart", exe_path.to_string_lossy());
                    let _ = key.set_value("MHZipy", &val);
                }
            } else {
                let _ = key.delete_value("MHZipy");
            }
        }
    }
}

static PDF_VIEWER_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn open_pdf_windows_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static MAP: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    MAP.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn standby_pdf_window_slot() -> &'static std::sync::Mutex<Option<String>> {
    static SLOT: std::sync::OnceLock<std::sync::Mutex<Option<String>>> = std::sync::OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(None))
}

fn normalize_pdf_key(pdf_path: &str) -> String {
    let trimmed = pdf_path.trim().trim_matches('"');
    std::fs::canonicalize(trimmed)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| trimmed.replace('/', "\\"))
        .to_lowercase()
}

/// 윈도우를 최상단 포그라운드로 활성화합니다 (Tray 상주 상태에서 탐색기 더블클릭 시 포커스 보장).
fn focus_webview_window(win: &tauri::WebviewWindow) {
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    let _ = win.set_always_on_top(false);
    let _ = win.set_focus();

    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                BringWindowToTop, SetForegroundWindow, ShowWindow, SW_RESTORE,
            };
            let h = HWND(hwnd.0 as isize);
            let _ = ShowWindow(h, SW_RESTORE);
            let _ = BringWindowToTop(h);
            let _ = SetForegroundWindow(h);
        }
    }
}

/// Tray 상주 중 PDF를 즉시 열 수 있도록 백그라운드에서 숨겨진 PDF 뷰어 윈도우 1개를 미리 예열(Pre-warm)합니다.
fn prewarm_pdf_viewer(app: AppHandle) {
    std::thread::spawn(move || {
        // 기존 창 생성/렌더링과 경합하지 않도록 짧게 대기
        std::thread::sleep(std::time::Duration::from_millis(250));

        if let Ok(guard) = standby_pdf_window_slot().lock() {
            if let Some(ref existing_label) = *guard {
                if app.get_webview_window(existing_label).is_some() {
                    return;
                }
            }
        }

        let count = PDF_VIEWER_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let window_label = format!("pdf-viewer-{}", count);

        if tauri::WebviewWindowBuilder::new(
            &app,
            &window_label,
            tauri::WebviewUrl::App(std::path::PathBuf::from("viewer.html")),
        )
        .title("PDF Viewer")
        .inner_size(1100.0, 850.0)
        .min_inner_size(500.0, 400.0)
        .decorations(false)
        .visible(false)
        .build()
        .is_ok()
        {
            if let Ok(mut guard) = standby_pdf_window_slot().lock() {
                *guard = Some(window_label);
            }
        }
    });
}

/// CLI 인자 배열에서 PDF 경로 목록, 제목 옵션, autostart 플래그를 추출합니다.
fn parse_cli_args(args: &[String], cwd: Option<&str>) -> (Vec<String>, Option<String>, bool) {
    let mut pdf_paths = Vec::new();
    let mut pdf_title: Option<String> = None;
    let mut is_autostart = false;

    let resolve_path = |raw: &str| -> String {
        let cleaned = raw.trim().trim_matches('"').to_string();
        if cleaned.is_empty() {
            return cleaned;
        }
        let p = Path::new(&cleaned);
        if p.is_relative() {
            if let Some(base) = cwd {
                let base_trimmed = base.trim().trim_matches('"');
                if !base_trimmed.is_empty() {
                    return Path::new(base_trimmed)
                        .join(p)
                        .to_string_lossy()
                        .into_owned();
                }
            }
        }
        cleaned
    };

    let mut i = 1;
    while i < args.len() {
        let arg_trimmed = args[i].trim().trim_matches('"');
        if arg_trimmed == "--pdf-viewer" && i + 1 < args.len() {
            let resolved = resolve_path(&args[i + 1]);
            if !resolved.is_empty() {
                pdf_paths.push(resolved);
            }
            i += 1;
        } else if arg_trimmed == "--pdf-title" && i + 1 < args.len() {
            let t = args[i + 1].trim().trim_matches('"').to_string();
            if !t.is_empty() {
                pdf_title = Some(t);
            }
            i += 1;
        } else if arg_trimmed.eq_ignore_ascii_case("--autostart") {
            is_autostart = true;
        } else if arg_trimmed.to_lowercase().ends_with(".pdf") {
            let resolved = resolve_path(arg_trimmed);
            if !resolved.is_empty() {
                pdf_paths.push(resolved);
            }
        }
        i += 1;
    }

    (pdf_paths, pdf_title, is_autostart)
}

/// 이미 Tray에 상주 중인 MHZipy 인스턴스가 있으면 Tauri/WebView2를 초기화하기 전에
/// 즉시 WM_COPYDATA로 인자를 전달하고 현재 프로세스를 종료합니다.
#[cfg(target_os = "windows")]
fn try_forward_to_running_instance() -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, FindWindowW, GetWindowThreadProcessId, SendMessageW, WM_COPYDATA,
    };

    let encode_wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };

    let class_name = encode_wide("com.marho-soft.mhzipy-sic");
    let window_name = encode_wide("com.marho-soft.mhzipy-siw");

    unsafe {
        let hwnd = FindWindowW(PCWSTR(class_name.as_ptr()), PCWSTR(window_name.as_ptr()));
        if hwnd.0 == 0 {
            return false;
        }

        // Tray 상주 중인 MHZipy 프로세스가 포그라운드 포커스를 가져갈 수 있도록 권한 부여
        let mut target_pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut target_pid));
        if target_pid != 0 {
            let _ = AllowSetForegroundWindow(target_pid);
        }

        let cwd = std::env::current_dir().unwrap_or_default();
        let cwd_str = cwd.to_str().unwrap_or_default();
        let args = std::env::args().collect::<Vec<String>>().join("|");
        let data = format!("{cwd_str}|{args}\0");
        let bytes = data.as_bytes();

        let cds = COPYDATASTRUCT {
            dwData: 1542, // WMCOPYDATA_SINGLE_INSTANCE_DATA
            cbData: bytes.len() as u32,
            lpData: bytes.as_ptr() as *mut _,
        };

        let _ = SendMessageW(
            hwnd,
            WM_COPYDATA,
            WPARAM(0),
            LPARAM(&cds as *const _ as isize),
        );
        true
    }
}

/// 관리자 권한으로 Tray에 상주 중일 때도 일반 권한 탐색기(Explorer)에서 보낸 WM_COPYDATA를 수신할 수 있도록 허용합니다.
#[cfg(target_os = "windows")]
fn allow_single_instance_uipi() {
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            ChangeWindowMessageFilter, MSGFLT_ADD, WM_COPYDATA,
        };
        let _ = ChangeWindowMessageFilter(WM_COPYDATA, MSGFLT_ADD);
    }
}

/// PDF 뷰어 윈도우를 생성하거나 예열된(Pre-warmed) 윈도우를 즉시 활성화하는 헬퍼 함수.
/// 초기 실행 시와 single-instance 콜백 양쪽에서 재사용됩니다.
fn open_pdf_viewer(app: &AppHandle, pdf_path: &str, pdf_title: Option<&str>) {
    let clean_path = pdf_path.trim().trim_matches('"').to_string();
    if clean_path.is_empty() {
        return;
    }

    let title = match pdf_title {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => std::path::Path::new(&clean_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    };

    let norm_key = normalize_pdf_key(&clean_path);

    // 1. 이미 동일한 PDF 파일이 열려 있는 윈도우가 있으면 즉시 포커스만 이동
    if let Ok(mut map) = open_pdf_windows_map().lock() {
        if let Some(existing_label) = map.get(&norm_key).cloned() {
            if let Some(existing_win) = app.get_webview_window(&existing_label) {
                focus_webview_window(&existing_win);
                return;
            } else {
                map.remove(&norm_key);
            }
        }
    }

    // 2. 예열된(Pre-warmed) 대기 윈도우가 있으면 WebView2 재생성 없이 즉시 표시 및 로드
    let standby_win = standby_pdf_window_slot()
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
        .and_then(|label| app.get_webview_window(&label).map(|w| (label, w)));

    if let Some((label, win)) = standby_win {
        if let Ok(mut map) = open_pdf_windows_map().lock() {
            map.insert(norm_key, label);
        }

        let _ = win.set_title(&title);
        focus_webview_window(&win);

        let escaped_path = clean_path.replace('\\', "\\\\").replace('\'', "\\'");
        let escaped_title = title.replace('\\', "\\\\").replace('\'', "\\'");
        let eval_script = format!(
            "window.__PDF_PATH__ = '{}'; if (typeof window.__loadPdfInPrewarmedWindow === 'function') {{ window.__loadPdfInPrewarmedWindow('{}', '{}'); }} else {{ window.__PENDING_PREWARM_PDF__ = {{ path: '{}', title: '{}' }}; }}",
            escaped_path, escaped_path, escaped_title, escaped_path, escaped_title
        );
        let _ = win.eval(&eval_script);

        // 다음 PDF 더블클릭을 위해 새 대기 윈도우를 백그라운드에서 다시 예열
        prewarm_pdf_viewer(app.clone());
        return;
    }

    // 3. 예열된 윈도우가 아직 없는 경우: 메인 UI 스레드 데드락 방지를 위해 별도 스레드에서 생성
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let init_script = format!(
            "window.__PDF_PATH__ = '{}';",
            clean_path.replace('\\', "\\\\").replace('\'', "\\'")
        );

        let count = PDF_VIEWER_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let window_label = format!("pdf-viewer-{}", count);

        match tauri::WebviewWindowBuilder::new(
            &app_clone,
            &window_label,
            tauri::WebviewUrl::App(std::path::PathBuf::from("viewer.html")),
        )
        .initialization_script(&init_script)
        .title(&title)
        .inner_size(1100.0, 850.0)
        .min_inner_size(500.0, 400.0)
        .decorations(false)
        .visible(true)
        .focused(true)
        .build()
        {
            Ok(win) => {
                if let Ok(mut map) = open_pdf_windows_map().lock() {
                    map.insert(norm_key, window_label);
                }
                focus_webview_window(&win);
                println!("PDF viewer opened: {}", clean_path);
                // 이후 PDF 실행을 빠르게 하기 위해 대기 윈도우 예열
                prewarm_pdf_viewer(app_clone);
            }
            Err(e) => eprintln!("Failed to open PDF viewer: {}", e),
        }
    });
}

/// PDF 문서에서 특정 페이지만 추출하여 새 PDF 파일로 저장
#[tauri::command]
fn extract_pdf_pages(input_path: String, output_path: String, pages: Vec<u32>) -> Result<String, String> {
    if pages.is_empty() {
        return Err("추출할 페이지가 지정되지 않았습니다.".to_string());
    }

    let mut doc = lopdf::Document::load(&input_path)
        .map_err(|e| format!("PDF 문서를 읽을 수 없습니다: {}", e))?;

    let all_pages = doc.get_pages();
    let total_pages = all_pages.len() as u32;

    for &p in &pages {
        if p == 0 || p > total_pages {
            return Err(format!("유효하지 않은 페이지 번호입니다: {} (총 {}페이지)", p, total_pages));
        }
    }

    let pages_to_delete: Vec<u32> = all_pages
        .keys()
        .filter(|p| !pages.contains(p))
        .cloned()
        .collect();

    doc.delete_pages(&pages_to_delete);
    doc.save(&output_path)
        .map_err(|e| format!("새 PDF 파일 저장에 실패했습니다: {}", e))?;

    Ok(format!("{}개 페이지가 성공적으로 추출되어 저장되었습니다.", pages.len()))
}

/// PDF 문서를 AES-256으로 암호화하여 저장
#[tauri::command]
fn encrypt_pdf_file(input_path: String, output_path: String, password: String) -> Result<String, String> {
    if password.is_empty() {
        return Err("암호를 입력해 주세요.".to_string());
    }

    pdf_encrypt::encrypt_pdf(&input_path, &output_path, &password)
        .map_err(|e| format!("PDF 암호화에 실패했습니다: {}", e))?;

    Ok("PDF 파일이 암호화되어 성공적으로 저장되었습니다.".to_string())
}

/// 암호화된 PDF 문서의 암호를 해제하여 무암호 PDF로 저장
#[tauri::command]
fn decrypt_pdf_file(input_path: String, output_path: String, password: String) -> Result<String, String> {
    pdf_encrypt::decrypt_pdf(&input_path, &output_path, &password)
        .map_err(|e| format!("PDF 암호 해제에 실패했습니다 (비밀번호 확인 필요): {}", e))?;

    Ok("PDF 암호가 성공적으로 해제되어 저장되었습니다.".to_string())
}

/// PDF 문서가 암호화되어 있는지 확인
#[tauri::command]
fn check_pdf_encrypted(file_path: String) -> Result<bool, String> {
    match lopdf::Document::load(&file_path) {
        Ok(doc) => Ok(doc.is_encrypted()),
        Err(e) => {
            let err_str = e.to_string().to_lowercase();
            if err_str.contains("encrypt") || err_str.contains("password") {
                Ok(true)
            } else {
                Err(format!("PDF 확인 실패: {}", e))
            }
        }
    }
}

/// 바이너리 데이터(PDF 바이트)를 지정된 경로에 파일로 저장
#[tauri::command]
fn save_pdf_bytes(output_path: String, data: Vec<u8>) -> Result<String, String> {
    if data.is_empty() {
        return Err("저장할 데이터가 비어 있습니다.".to_string());
    }
    std::fs::write(&output_path, &data)
        .map_err(|e| format!("파일 저장 실패: {}", e))?;
    Ok("파일이 성공적으로 저장되었습니다.".to_string())
}

/// 바이너리 데이터(PDF 바이트 등)를 파일에서 읽기
#[tauri::command]
fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("파일 읽기 실패 {}: {}", path, e))
}

#[derive(serde::Serialize, Clone)]
struct PrinterInfo {
    name: String,
    is_default: bool,
    port: String,
}

/// 시스템에 설치된 프린터 목록 및 기본 프린터 조회
#[tauri::command]
fn get_system_printers() -> Result<Vec<PrinterInfo>, String> {
    let mut printers = Vec::new();
    let mut default_printer = String::new();

    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(win_key) =
            hkcu.open_subkey("Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows")
        {
            if let Ok(device_val) = win_key.get_value::<String, _>("Device") {
                if let Some(first) = device_val.split(',').next() {
                    default_printer = first.trim().to_string();
                }
            }
        }

        if let Ok(dev_key) =
            hkcu.open_subkey("Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices")
        {
            for item in dev_key.enum_values().flatten() {
                let name = item.0.trim().to_string();
                if name.is_empty() {
                    continue;
                }
                let val_str = dev_key.get_value::<String, _>(&name).unwrap_or_default();
                let is_def =
                    !default_printer.is_empty() && name.eq_ignore_ascii_case(&default_printer);
                printers.push(PrinterInfo {
                    name,
                    is_default: is_def,
                    port: val_str,
                });
            }
        }
    }

    printers.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.name.cmp(&b.name))
    });

    if printers.is_empty() {
        printers.push(PrinterInfo {
            name: "Microsoft Print to PDF".to_string(),
            is_default: true,
            port: "PORTPROMPT:".to_string(),
        });
    }

    if !printers.iter().any(|p| p.name == "Save as PDF") {
        printers.push(PrinterInfo {
            name: "Save as PDF".to_string(),
            is_default: false,
            port: "FILE:".to_string(),
        });
    }

    Ok(printers)
}

/// 선택한 Windows 프린터의 네이티브 속성(Properties) 다이얼로그 열기
#[tauri::command]
fn open_printer_properties(printer_name: String) -> Result<(), String> {
    let trimmed = printer_name.trim();
    if trimmed.is_empty() || trimmed == "Save as PDF" {
        return Err("Virtual printer does not support properties.".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32.exe")
            .args(["printui.dll,PrintUIEntry", "/p", "/n", trimmed])
            .spawn()
            .map_err(|e| format!("Failed to open printer properties: {}", e))?;
    }
    Ok(())
}

/// PDF Viewer에서 Ctrl+P 또는 인쇄 버튼 클릭 시 별도의 Modeless 인쇄 다이얼로그 윈도우를 엽니다.
#[tauri::command]
fn open_pdf_print_dialog(
    app: tauri::AppHandle,
    window: tauri::Window,
    pdf_path: String,
    storage_id: String,
    title: String,
    current_page: u32,
    total_pages: u32,
    password: Option<String>,
) -> Result<(), String> {
    let key_source = if !pdf_path.trim().is_empty() {
        pdf_path.trim().to_lowercase()
    } else if !storage_id.trim().is_empty() {
        storage_id.trim().to_string()
    } else {
        title.trim().to_string()
    };

    let mut hash: u64 = 5381;
    for b in key_source.bytes() {
        hash = ((hash << 5).wrapping_add(hash)).wrapping_add(b as u64);
    }
    let dialog_label = format!("pdf-print-dialog-{:x}", hash);

    if let Some(existing) = app.get_webview_window(&dialog_label) {
        focus_webview_window(&existing);
        let _ = existing.eval(&format!(
            "if (typeof window.__updateViewerCurrentPage === 'function') {{ window.__updateViewerCurrentPage({}); }}",
            current_page
        ));
        return Ok(());
    }

    let pos = window.outer_position().ok();
    let app_clone = app.clone();
    let pwd_str = password.unwrap_or_default();

    std::thread::spawn(move || {
        let query = format!(
            "print-dialog.html?pdfPath={}&storageId={}&title={}&currentPage={}&totalPages={}&pwd={}",
            urlencoding::encode(&pdf_path),
            urlencoding::encode(&storage_id),
            urlencoding::encode(&title),
            current_page,
            total_pages,
            urlencoding::encode(&pwd_str),
        );

        let mut builder = tauri::WebviewWindowBuilder::new(
            &app_clone,
            &dialog_label,
            tauri::WebviewUrl::App(std::path::PathBuf::from(query)),
        )
        .title(format!("Print - {}", title))
        .inner_size(960.0, 710.0)
        .min_inner_size(820.0, 580.0)
        .decorations(false)
        .resizable(true)
        .visible(true)
        .focused(true);

        if let Some(p) = pos {
            builder = builder.position((p.x + 60) as f64, (p.y + 45) as f64);
        }

        if let Ok(win) = builder.build() {
            focus_webview_window(&win);
        }
    });

    Ok(())
}

/// WebView2 네이티브 인쇄 API를 통해 지정된 프린터(또는 PDF 파일)로 즉시 인쇄 실행
#[tauri::command]
async fn execute_webview_print(
    window: tauri::WebviewWindow,
    printer_name: String,
    copies: i32,
    collate: bool,
    grayscale: bool,
    duplex: String,
    landscape: bool,
    page_width_mm: f64,
    page_height_mm: f64,
    save_to_pdf_path: Option<String>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Environment6, ICoreWebView2PrintSettings2, ICoreWebView2_16,
            ICoreWebView2_2, ICoreWebView2_7, COREWEBVIEW2_PRINT_COLLATION_COLLATED,
            COREWEBVIEW2_PRINT_COLLATION_UNCOLLATED, COREWEBVIEW2_PRINT_COLOR_MODE_COLOR,
            COREWEBVIEW2_PRINT_COLOR_MODE_GRAYSCALE, COREWEBVIEW2_PRINT_DUPLEX_ONE_SIDED,
            COREWEBVIEW2_PRINT_DUPLEX_TWO_SIDED_LONG_EDGE,
            COREWEBVIEW2_PRINT_DUPLEX_TWO_SIDED_SHORT_EDGE,
            COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
            COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE, COREWEBVIEW2_PRINT_STATUS_SUCCEEDED,
        };
        use webview2_com::{PrintCompletedHandler, PrintToPdfCompletedHandler};
        use windows61::core::{Interface, PCWSTR};

        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();

        let webview_res = window.with_webview(move |pw| unsafe {
            let controller = pw.controller();
            let Ok(core) = controller.CoreWebView2() else {
                let _ = tx.send(Err(
                    "CoreWebView2 인터페이스를 가져올 수 없습니다.".to_string()
                ));
                return;
            };

            let Ok(core2) = core.cast::<ICoreWebView2_2>() else {
                let _ = tx.send(Err("ICoreWebView2_2 캐스팅 실패".to_string()));
                return;
            };

            let Ok(env) = core2.Environment() else {
                let _ = tx.send(Err("WebView2 Environment 조회 실패".to_string()));
                return;
            };

            let Ok(env6) = env.cast::<ICoreWebView2Environment6>() else {
                let _ = tx.send(Err("ICoreWebView2Environment6 캐스팅 실패".to_string()));
                return;
            };

            let Ok(settings) = env6.CreatePrintSettings() else {
                let _ = tx.send(Err("PrintSettings 생성 실패".to_string()));
                return;
            };

            let w_in = (page_width_mm / 25.4).max(1.0);
            let h_in = (page_height_mm / 25.4).max(1.0);
            let _ = settings.SetOrientation(if landscape {
                COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
            } else {
                COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
            });
            let _ = settings.SetPageWidth(w_in);
            let _ = settings.SetPageHeight(h_in);
            let _ = settings.SetMarginTop(0.0);
            let _ = settings.SetMarginBottom(0.0);
            let _ = settings.SetMarginLeft(0.0);
            let _ = settings.SetMarginRight(0.0);
            let _ = settings.SetScaleFactor(1.0);
            let _ = settings.SetShouldPrintBackgrounds(true.into());
            let _ = settings.SetShouldPrintHeaderAndFooter(false.into());

            if let Some(pdf_out) = save_to_pdf_path {
                if !pdf_out.trim().is_empty() {
                    let Ok(core7) = core.cast::<ICoreWebView2_7>() else {
                        let _ = tx.send(Err("ICoreWebView2_7 캐스팅 실패".to_string()));
                        return;
                    };
                    let wide_path: Vec<u16> = std::ffi::OsStr::new(pdf_out.trim())
                        .encode_wide()
                        .chain(std::iter::once(0))
                        .collect();
                    let tx_clone = tx.clone();
                    let out_label = pdf_out.clone();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                        if hr.is_ok() && ok {
                            let _ = tx_clone.send(Ok(format!("Saved to PDF: {}", out_label)));
                        } else {
                            let _ = tx_clone
                                .send(Err(format!("Failed to save PDF (hr={:?}).", hr)));
                        }
                        Ok(())
                    }));
                    if let Err(e) =
                        core7.PrintToPdf(PCWSTR(wide_path.as_ptr()), &settings, &handler)
                    {
                        let _ = tx.send(Err(format!("PrintToPdf failed: {}", e)));
                    }
                    return;
                }
            }

            if let Ok(settings2) = settings.cast::<ICoreWebView2PrintSettings2>() {
                if !printer_name.trim().is_empty() {
                    let wide_printer: Vec<u16> = std::ffi::OsStr::new(printer_name.trim())
                        .encode_wide()
                        .chain(std::iter::once(0))
                        .collect();
                    let _ = settings2.SetPrinterName(PCWSTR(wide_printer.as_ptr()));
                }
                let _ = settings2.SetCopies(copies.max(1));
                let _ = settings2.SetCollation(if collate {
                    COREWEBVIEW2_PRINT_COLLATION_COLLATED
                } else {
                    COREWEBVIEW2_PRINT_COLLATION_UNCOLLATED
                });
                let _ = settings2.SetColorMode(if grayscale {
                    COREWEBVIEW2_PRINT_COLOR_MODE_GRAYSCALE
                } else {
                    COREWEBVIEW2_PRINT_COLOR_MODE_COLOR
                });
                let duplex_val = match duplex.as_str() {
                    "LongEdge" => COREWEBVIEW2_PRINT_DUPLEX_TWO_SIDED_LONG_EDGE,
                    "ShortEdge" => COREWEBVIEW2_PRINT_DUPLEX_TWO_SIDED_SHORT_EDGE,
                    _ => COREWEBVIEW2_PRINT_DUPLEX_ONE_SIDED,
                };
                let _ = settings2.SetDuplex(duplex_val);
            }

            let Ok(core16) = core.cast::<ICoreWebView2_16>() else {
                let _ = tx.send(Err("ICoreWebView2_16 캐스팅 실패".to_string()));
                return;
            };

            let tx_clone = tx.clone();
            let p_name = printer_name.clone();
            let handler = PrintCompletedHandler::create(Box::new(move |hr, status| {
                if hr.is_ok() && status == COREWEBVIEW2_PRINT_STATUS_SUCCEEDED {
                    let _ =
                        tx_clone.send(Ok(format!("Print job sent to '{}'.", p_name)));
                } else if status == COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE {
                    let _ = tx_clone.send(Err(format!(
                        "Printer '{}' is unavailable or offline.",
                        p_name
                    )));
                } else {
                    let _ = tx_clone.send(Err(format!(
                        "Printing failed or was canceled (status={:?}, hr={:?}).",
                        status, hr
                    )));
                }
                Ok(())
            }));

            if let Err(e) = core16.Print(&settings, &handler) {
                let _ = tx.send(Err(format!("Print call failed: {}", e)));
            }
        });

        if let Err(e) = webview_res {
            return Err(format!("Failed to access WebView: {}", e));
        }

        let res = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(120))
                .map_err(|_| "Print operation timed out.".to_string())?
        })
        .await
        .map_err(|e| format!("Print thread error: {}", e))?;

        res
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Direct printing is not supported on this OS.".to_string())
    }
}

/// 업로드 안전 잠금(Upload Lock)과 사전 파일 검수기(Pre-Upload Inspector)가 내장된 전용 WebView 창으로 웹 폴더(Box 등)를 엽니다.
#[tauri::command]
fn open_safe_web_folder_window(
    app: tauri::AppHandle,
    window: tauri::Window,
    id: String,
    name: String,
    url: String,
    linked_local_path: String,
    safety_level: String,
) -> Result<(), String> {
    let clean_id: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let label = format!(
        "web-folder-{}",
        if clean_id.is_empty() { "default" } else { &clean_id }
    );

    if let Some(existing) = app.get_webview_window(&label) {
        focus_webview_window(&existing);
        let _ = app.emit(
            "web-folder-live-state",
            serde_json::json!({
                "id": id,
                "label": label,
                "isOpen": true,
            }),
        );
        return Ok(());
    }

    let parsed_url: tauri::Url = url
        .trim()
        .parse()
        .map_err(|e| format!("Invalid Web Folder URL '{}': {}", url, e))?;

    let pos = window.outer_position().ok();
    let app_clone = app.clone();

    let name_json = serde_json::to_string(&name).unwrap_or_else(|_| "\"Web Folder\"".to_string());
    let local_json =
        serde_json::to_string(&linked_local_path).unwrap_or_else(|_| "\"\"".to_string());
    let level_json =
        serde_json::to_string(&safety_level).unwrap_or_else(|_| "\"caution\"".to_string());
    let root_url_json = serde_json::to_string(url.trim()).unwrap_or_else(|_| "\"\"".to_string());

    let init_script = format!(
        r#"
(function() {{
    if (window.__MHZIPY_WEB_GUARD_ACTIVE__) return;
    window.__MHZIPY_WEB_GUARD_ACTIVE__ = true;

    const FOLDER_NAME = {name_json};
    const LINKED_LOCAL = {local_json};
    const SAFETY_LEVEL = {level_json}; // 'download_only' | 'caution' | 'strict'
    const ROOT_URL = {root_url_json};

    let uploadUnlocked = false;
    let unlockExpireTime = 0;
    let countdownTimer = null;
    let inspectedFilesPass = false;

    // Hierarchy & Download State
    let relativeSubpath = [];
    let manualSubpathOverride = null; // null = auto-detect from web folder breadcrumbs
    let autoExtractZip = true;
    let rootBreadcrumbs = null;
    const navHistoryMap = new Map(); // pathname -> string[]

    function sanitizeSegment(seg) {{
        return (seg || '')
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^\.+|\.+$/g, '');
    }}

    function getActiveSubpath() {{
        return manualSubpathOverride !== null ? manualSubpathOverride : relativeSubpath;
    }}

    function syncDownloadStateToHost() {{
        try {{
            const rem = uploadUnlocked ? Math.max(0, Math.ceil((unlockExpireTime - Date.now()) / 1000)) : 0;
            if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {{
                window.chrome.webview.postMessage(JSON.stringify({{
                    type: 'mhzipy-web-folder-state',
                    subpath: getActiveSubpath(),
                    autoExtractZip: !!autoExtractZip,
                    uploadUnlocked: !!uploadUnlocked,
                    remainingSeconds: rem
                }}));
            }}
        }} catch (_) {{}}
    }}

    function scrapeBreadcrumbsFromDOM() {{
        const selectors = [
            '.ItemListBreadcrumb ol li a, .ItemListBreadcrumb ol li span[data-resin-target]',
            '.ItemListBreadcrumb a, .ItemListBreadcrumb span',
            '[data-resin-target="breadcrumb"] a, [data-resin-target="breadcrumb"] span',
            'nav[aria-label*="Breadcrumb" i] a, nav[aria-label*="Breadcrumb" i] button, nav[aria-label*="Breadcrumb" i] span',
            '[role="navigation"][aria-label*="breadcrumb" i] a, [role="navigation"][aria-label*="breadcrumb" i] button, [role="navigation"][aria-label*="breadcrumb" i] [role="listitem"]',
            '[data-automationid="breadcrumb"] a, [data-automationid="breadcrumb"] button, [data-automationid="breadcrumb"] span',
            '[class*="Breadcrumb" i] a, [class*="Breadcrumb" i] button, [class*="BreadcrumbItem" i]'
        ];

        const noiseSet = new Set(['...', '…', '>', '/', '\\', 'more', '더보기', 'all files', '모든 파일', 'box', 'home', '홈']);
        for (const sel of selectors) {{
            const nodes = Array.from(document.querySelectorAll(sel));
            if (nodes.length === 0) continue;
            const raw = [];
            for (const el of nodes) {{
                // Skip hidden elements or elements that wrap other matched children
                if (el.offsetParent === null) continue;
                if ( nodes.some(other => other !== el && el.contains(other)) ) continue;
                const txt = sanitizeSegment(el.textContent || '');
                if (!txt) continue;
                if (noiseSet.has(txt.toLowerCase())) continue;
                if (raw.length === 0 || raw[raw.length - 1] !== txt) {{
                    raw.push(txt);
                }}
            }}
            if (raw.length > 0) return raw;
        }}

        // Fallback: parse document.title (e.g., "SubFolderName | Powered by Box" or "SubFolderName - Box")
        const title = (document.title || '').trim();
        const boxMatch = title.match(/^(.+?)\s*(?:\|\s*Powered by Box|-\s*Box|-\s*Google Drive|-\s*OneDrive)$/i);
        if (boxMatch && boxMatch[1]) {{
            const tSeg = sanitizeSegment(boxMatch[1]);
            if (tSeg && !noiseSet.has(tSeg.toLowerCase())) {{
                return [tSeg];
            }}
        }}
        return [];
    }}

    function isAtRootUrl() {{
        try {{
            const rootU = new URL(ROOT_URL, window.location.origin);
            return window.location.pathname.replace(/\/+$/, '') === rootU.pathname.replace(/\/+$/, '');
        }} catch (_) {{
            return false;
        }}
    }}

    function updateDetectedHierarchy() {{
        if (!LINKED_LOCAL) return;
        const crumbs = scrapeBreadcrumbsFromDOM();
        const atRoot = isAtRootUrl();

        if (atRoot) {{
            if (crumbs.length > 0 && !rootBreadcrumbs) {{
                rootBreadcrumbs = crumbs.slice();
            }}
            relativeSubpath = [];
            navHistoryMap.set(window.location.pathname, []);
            syncDownloadStateToHost();
            updateSubpathBarUI();
            return;
        }}

        if (crumbs.length === 0) return;

        // 1. Check if FOLDER_NAME or linked local folder leaf name appears in the breadcrumbs
        const localLeaf = sanitizeSegment((LINKED_LOCAL.split(/[/\\]/).filter(Boolean).pop()) || '');
        const rootCandidates = [sanitizeSegment(FOLDER_NAME), localLeaf].filter(Boolean).map(s => s.toLowerCase());

        let computed = null;
        for (let i = crumbs.length - 1; i >= 0; i--) {{
            if (rootCandidates.includes(crumbs[i].toLowerCase())) {{
                computed = crumbs.slice(i + 1);
                break;
            }}
        }}

        // 2. Otherwise, if rootBreadcrumbs was captured at root URL, strip common prefix
        if (computed === null && rootBreadcrumbs && rootBreadcrumbs.length > 0) {{
            const rootLast = rootBreadcrumbs[rootBreadcrumbs.length - 1].toLowerCase();
            const idx = crumbs.findIndex(c => c.toLowerCase() === rootLast);
            if (idx >= 0) {{
                computed = crumbs.slice(idx + 1);
            }} else {{
                let common = 0;
                while (common < rootBreadcrumbs.length && common < crumbs.length &&
                       rootBreadcrumbs[common].toLowerCase() === crumbs[common].toLowerCase()) {{
                    common++;
                }}
                computed = crumbs.slice(common);
            }}
        }}

        // 3. Fallback: if we navigated from a known parent trail in navHistoryMap, stitch it
        if (computed === null) {{
            computed = crumbs;
        }}

        // Stitch with parent history if Box collapsed intermediate folders into "..."
        for (const [, prevSub] of navHistoryMap.entries()) {{
            if (prevSub.length > 0 && computed.length > 0) {{
                const overlapIdx = prevSub.findIndex(p => p.toLowerCase() === computed[0].toLowerCase());
                if (overlapIdx > 0) {{
                    computed = prevSub.slice(0, overlapIdx).concat(computed);
                    break;
                }}
            }}
        }}

        const cleaned = computed.map(sanitizeSegment).filter(Boolean);
        navHistoryMap.set(window.location.pathname, cleaned);

        const prevKey = relativeSubpath.join('/');
        const nextKey = cleaned.join('/');
        if (prevKey !== nextKey) {{
            relativeSubpath = cleaned;
            syncDownloadStateToHost();
            updateSubpathBarUI();
        }}
    }}

    function updateSubpathBarUI() {{
        const subEl = document.getElementById('mhzipy-subpath-badge');
        if (!subEl) return;
        const active = getActiveSubpath();
        const isManual = manualSubpathOverride !== null;
        if (active.length === 0) {{
            subEl.textContent = isManual ? '📁 [Root (Manual)]' : '📁 [Root]';
            subEl.style.color = '#94a3b8';
            subEl.style.borderColor = 'rgba(148,163,184,0.35)';
        }} else {{
            subEl.textContent = '📂 \\' + active.join('\\') + (isManual ? ' ✎' : '');
            subEl.style.color = '#34d399';
            subEl.style.borderColor = 'rgba(52,211,153,0.5)';
        }}
    }}

    window.__mhzipyNotifyDownloadStart = function(fileName, targetDir) {{
        showGuardToast('📥 Downloading "' + fileName + '" → ' + targetDir, false);
    }};

    window.__mhzipyNotifyDownloadDone = function(msg, isError) {{
        showGuardToast(msg, !!isError);
    }};

    const RISKY_KEYWORDS = ['초안', '임시', '복사본', '사본', '비밀', '대외비', 'temp', 'tmp', 'draft', 'copy', 'test', 'backup', '.bak', '~$'];

    function checkRiskyName(fileName) {{
        const lower = (fileName || '').toLowerCase();
        return RISKY_KEYWORDS.filter(k => lower.includes(k));
    }}

    function showGuardToast(msg, isError = true) {{
        let toast = document.getElementById('mhzipy-guard-toast');
        if (!toast) {{
            toast = document.createElement('div');
            toast.id = 'mhzipy-guard-toast';
            toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;padding:12px 18px;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;font-weight:600;color:#fff;box-shadow:0 10px 28px rgba(0,0,0,0.45);transition:opacity 0.2s,transform 0.2s;display:flex;align-items:center;gap:10px;max-width:440px;line-height:1.4;';
            document.documentElement.appendChild(toast);
        }}
        toast.style.background = isError ? 'linear-gradient(135deg, #dc2626, #991b1b)' : 'linear-gradient(135deg, #0284c7, #0369a1)';
        toast.style.border = isError ? '1px solid #f87171' : '1px solid #38bdf8';
        toast.textContent = msg;
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
        clearTimeout(toast.__timer);
        toast.__timer = setTimeout(() => {{
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(8px)';
        }}, 4000);
    }}

    // 1. Intercept Drag & Drop uploads when locked
    function isInsideInspector(target) {{
        return !!(target && target.closest && target.closest('#mhzipy-inspector-modal'));
    }}

    function hasFileTransfer(dt) {{
        if (!dt) return false;
        if (dt.files && dt.files.length > 0) return true;
        if (dt.types) {{
            const types = Array.from(dt.types);
            if (types.includes('Files') || types.includes('application/x-moz-file')) return true;
        }}
        return false;
    }}

    window.addEventListener('dragenter', (e) => {{
        if (isInsideInspector(e.target)) return;
        if (!uploadUnlocked && hasFileTransfer(e.dataTransfer)) {{
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            try {{ e.dataTransfer.dropEffect = 'none'; }} catch (_) {{}}
        }}
    }}, true);

    window.addEventListener('dragover', (e) => {{
        if (isInsideInspector(e.target)) return;
        if (!uploadUnlocked && hasFileTransfer(e.dataTransfer)) {{
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            try {{ e.dataTransfer.dropEffect = 'none'; }} catch (_) {{}}
        }}
    }}, true);

    window.addEventListener('drop', (e) => {{
        if (isInsideInspector(e.target)) {{
            return; // Allow dropping into our Pre-Upload Inspector
        }}
        const hasFiles = hasFileTransfer(e.dataTransfer);
        if (hasFiles && !uploadUnlocked) {{
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            showGuardToast('🔒 [Upload Locked] Drag & Drop upload was blocked to protect "' + FOLDER_NAME + '". Unlock upload in the top safety bar first.', true);
            return false;
        }}
        if (hasFiles && uploadUnlocked && e.dataTransfer && e.dataTransfer.files) {{
            // Do NOT call window.confirm() here because a synchronous modal loop inside 'drop'
            // invalidates transient DataTransfer / webkitGetAsEntry handles in WebView2 (breaking Box uploads).
            const risky = [];
            for (const f of e.dataTransfer.files) {{
                const hits = checkRiskyName(f.name);
                if (hits.length > 0) risky.push(f.name + ' (' + hits.join(', ') + ')');
            }}
            if (risky.length > 0) {{
                showGuardToast('⚠️ Caution: Uploaded file(s) contain caution keywords: ' + risky.join(', '), true);
            }} else {{
                showGuardToast('📤 Uploading ' + e.dataTransfer.files.length + ' item(s) to "' + FOLDER_NAME + '"...', false);
            }}
        }}
    }}, true);

    // 2. Intercept Paste (Ctrl+V) file uploads when locked
    window.addEventListener('paste', (e) => {{
        if (!uploadUnlocked && e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {{
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            showGuardToast('🔒 [Upload Locked] Clipboard file paste was blocked. Unlock upload in the top safety bar if you intend to upload.', true);
            return false;
        }}
    }}, true);

    // 3. Intercept <input type="file"> programmatic & user clicks when locked
    const origInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function() {{
        if (this.type === 'file' && !this.hasAttribute('data-mhzipy-inspector')) {{
            if (!uploadUnlocked) {{
                showGuardToast('🔒 [Upload Locked] File upload dialog blocked. Click "Unlock Upload" on the top bar after reviewing files.', true);
                openInspectorModal();
                return;
            }}
        }}
        return origInputClick.apply(this, arguments);
    }};

    window.addEventListener('click', (e) => {{
        const el = e.target;
        if (el && el.tagName === 'INPUT' && el.type === 'file' && !el.hasAttribute('data-mhzipy-inspector')) {{
            if (!uploadUnlocked) {{
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                showGuardToast('🔒 [Upload Locked] File upload is currently locked.', true);
                openInspectorModal();
                return false;
            }}
        }}
    }}, true);

    window.addEventListener('change', (e) => {{
        const el = e.target;
        if (el && el.tagName === 'INPUT' && el.type === 'file' && !el.hasAttribute('data-mhzipy-inspector') && el.files && el.files.length > 0) {{
            const risky = [];
            for (const f of el.files) {{
                const hits = checkRiskyName(f.name);
                if (hits.length > 0) risky.push(f.name + ' [' + hits.join(', ') + ']');
            }}
            if (risky.length > 0) {{
                const proceed = window.confirm('⚠️ Caution Keywords Detected in Selected Upload Files:\n\n' + risky.join('\n') + '\n\nDo you still want to proceed with uploading to "' + FOLDER_NAME + '"?');
                if (!proceed) {{
                    el.value = '';
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                }}
            }}
        }}
    }}, true);

    function setUploadLockState(unlocked, durationSeconds = 300) {{
        if (SAFETY_LEVEL === 'download_only') {{
            uploadUnlocked = false;
            showGuardToast('🟢 This web folder is set to DOWNLOAD ONLY mode. Uploading is permanently disabled.', true);
            return;
        }}
        uploadUnlocked = unlocked;
        clearInterval(countdownTimer);
        if (unlocked) {{
            unlockExpireTime = Date.now() + durationSeconds * 1000;
            countdownTimer = setInterval(() => {{
                const rem = Math.max(0, Math.ceil((unlockExpireTime - Date.now()) / 1000));
                if (rem <= 0) {{
                    setUploadLockState(false);
                    showGuardToast('🔒 Upload lock has been automatically re-enabled for safety.', false);
                }} else {{
                    updateBarUI(rem);
                    syncDownloadStateToHost();
                }}
            }}, 1000);
            updateBarUI(durationSeconds);
            syncDownloadStateToHost();
            showGuardToast('🔓 Upload unlocked for 5 minutes. Please upload carefully!', false);
        }} else {{
            updateBarUI(0);
            syncDownloadStateToHost();
        }}
    }}

    function formatSize(bytes) {{
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(2) + ' MB';
    }}

    function openInspectorModal() {{
        if (SAFETY_LEVEL === 'download_only') {{
            showGuardToast('🟢 This folder is configured as "Download Only". Change its safety level in MHZipy if you need to upload.', true);
            return;
        }}
        let modal = document.getElementById('mhzipy-inspector-modal');
        if (modal) modal.remove();

        modal = document.createElement('div');
        modal.id = 'mhzipy-inspector-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(2,6,23,0.75);backdrop-filter:blur(4px);z-index:2147483646;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f8fafc;';

        const isStrict = SAFETY_LEVEL === 'strict';
        const badgeColor = isStrict ? '#ef4444' : '#f59e0b';

        modal.innerHTML = `
            <div style="background:#0f172a;border:2px solid ${{badgeColor}};border-radius:12px;width:540px;max-width:94vw;box-shadow:0 20px 50px rgba(0,0,0,0.7);overflow:hidden;">
                <div style="padding:14px 18px;background:#1e293b;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;align-items:center;">
                    <div style="display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;">
                        <span>🛡️</span>
                        <span>Pre-Upload Safety Gate — ${{FOLDER_NAME}}</span>
                    </div>
                    <button id="mhzipy-modal-close" style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;">✕</button>
                </div>
                <div style="padding:16px 18px;display:flex;flex-direction:column;gap:14px;font-size:13px;">
                    <div style="padding:10px 12px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);border-radius:8px;color:#fcd34d;line-height:1.45;">
                        ⚠️ <b>Upload Caution:</b> You are about to unlock file uploading for <b>${{FOLDER_NAME}}</b>.<br>
                        Please inspect the files you plan to upload below to prevent accidental or draft file uploads.
                    </div>

                    <div id="mhzipy-inspect-dropzone" style="background:#1e293b;border:1px dashed #38bdf8;border-radius:8px;padding:12px;text-align:center;transition:background 0.15s,border-color 0.15s;">
                        <input type="file" id="mhzipy-file-inspector-input" data-mhzipy-inspector="true" multiple style="display:none;">
                        <button id="mhzipy-btn-pick-inspect" style="background:#0284c7;color:#fff;border:none;padding:7px 14px;border-radius:6px;font-weight:600;cursor:pointer;font-size:12.5px;">
                            🔍 Select or Drop Files Here to Inspect Before Uploading...
                        </button>
                        <div style="font-size:11.5px;color:#94a3b8;margin-top:6px;">Checks for draft/temp keywords (초안, 임시, 복사본, temp, ~$), file size, and last modified time</div>
                        <div id="mhzipy-inspect-results" style="margin-top:10px;text-align:left;max-height:150px;overflow-y:auto;display:none;background:#0f172a;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.08);"></div>
                    </div>

                    <div style="display:flex;flex-direction:column;gap:8px;background:#1e293b;padding:10px 12px;border-radius:8px;">
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                            <input type="checkbox" id="mhzipy-chk-1" style="width:15px;height:15px;accent-color:#3b82f6;">
                            <span>I have verified that the target web folder (<b>${{FOLDER_NAME}}</b>) is correct.</span>
                        </label>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                            <input type="checkbox" id="mhzipy-chk-2" style="width:15px;height:15px;accent-color:#3b82f6;">
                            <span>I have checked that the files are final versions and contain no sensitive/temporary data.</span>
                        </label>
                    </div>
                </div>
                <div style="padding:12px 18px;background:#131c2e;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:flex-end;gap:10px;">
                    <button id="mhzipy-btn-cancel-unlock" style="padding:7px 16px;border-radius:6px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#cbd5e1;cursor:pointer;font-weight:600;">Keep Locked</button>
                    <button id="mhzipy-btn-confirm-unlock" disabled style="padding:7px 18px;border-radius:6px;background:#dc2626;border:1px solid #ef4444;color:#fff;cursor:not-allowed;font-weight:700;opacity:0.45;">🔓 Unlock Upload (5 min)</button>
                </div>
            </div>
        `;

        document.documentElement.appendChild(modal);

        const close = () => modal.remove();
        modal.querySelector('#mhzipy-modal-close').onclick = close;
        modal.querySelector('#mhzipy-btn-cancel-unlock').onclick = close;

        const chk1 = modal.querySelector('#mhzipy-chk-1');
        const chk2 = modal.querySelector('#mhzipy-chk-2');
        const btnConfirm = modal.querySelector('#mhzipy-btn-confirm-unlock');
        const syncBtn = () => {{
            const ok = chk1.checked && chk2.checked;
            btnConfirm.disabled = !ok;
            btnConfirm.style.opacity = ok ? '1' : '0.45';
            btnConfirm.style.cursor = ok ? 'pointer' : 'not-allowed';
        }};
        chk1.onchange = syncBtn;
        chk2.onchange = syncBtn;

        const fileInput = modal.querySelector('#mhzipy-file-inspector-input');
        const resultsBox = modal.querySelector('#mhzipy-inspect-results');
        const dropzone = modal.querySelector('#mhzipy-inspect-dropzone');
        modal.querySelector('#mhzipy-btn-pick-inspect').onclick = () => fileInput.click();

        const renderInspectedFiles = (files) => {{
            if (!files || files.length === 0) return;
            resultsBox.style.display = 'block';
            resultsBox.innerHTML = files.map(f => {{
                const hits = checkRiskyName(f.name);
                const mtime = f.lastModified ? new Date(f.lastModified).toLocaleString() : '';
                const badge = hits.length > 0
                    ? `<span style="background:#dc2626;color:#fff;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:700;">⚠️ Caution: ${{hits.join(', ')}}</span>`
                    : `<span style="background:#059669;color:#fff;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:700;">✅ Clean</span>`;
                return `<div style="padding:5px 4px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;">
                    <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        <b style="color:${{hits.length > 0 ? '#fca5a5' : '#e2e8f0'}}">${{f.name}}</b>
                        <span style="color:#64748b;font-size:11px;margin-left:6px;">(${{formatSize(f.size)}} • ${{mtime}})</span>
                    </div>
                    ${{badge}}
                </div>`;
            }}).join('');
        }};

        fileInput.onchange = () => {{
            renderInspectedFiles(Array.from(fileInput.files || []));
        }};

        if (dropzone) {{
            dropzone.addEventListener('dragover', (e) => {{
                e.preventDefault();
                e.stopPropagation();
                dropzone.style.background = 'rgba(2,132,199,0.22)';
                dropzone.style.borderColor = '#7dd3fc';
            }});
            dropzone.addEventListener('dragleave', () => {{
                dropzone.style.background = '#1e293b';
                dropzone.style.borderColor = '#38bdf8';
            }});
            dropzone.addEventListener('drop', (e) => {{
                e.preventDefault();
                e.stopPropagation();
                dropzone.style.background = '#1e293b';
                dropzone.style.borderColor = '#38bdf8';
                if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {{
                    renderInspectedFiles(Array.from(e.dataTransfer.files));
                }}
            }});
        }}

        btnConfirm.onclick = () => {{
            if (chk1.checked && chk2.checked) {{
                close();
                setUploadLockState(true, 300);
            }}
        }};
    }}

    function updateBarUI(remSeconds = 0) {{
        const statusBtn = document.getElementById('mhzipy-lock-toggle-btn');
        const bar = document.getElementById('mhzipy-safety-bar');
        if (!statusBtn || !bar) return;

        if (SAFETY_LEVEL === 'download_only') {{
            statusBtn.innerHTML = '🟢 Download Only (Upload Disabled)';
            statusBtn.style.background = '#065f46';
            statusBtn.style.borderColor = '#10b981';
            return;
        }}

        if (uploadUnlocked) {{
            const m = String(Math.floor(remSeconds / 60)).padStart(2, '0');
            const s = String(remSeconds % 60).padStart(2, '0');
            statusBtn.innerHTML = `🔓 Upload UNLOCKED (${{m}}:${{s}}) — Click to Lock Now`;
            statusBtn.style.background = '#dc2626';
            statusBtn.style.borderColor = '#f87171';
            bar.style.borderBottom = '2px solid #ef4444';
        }} else {{
            statusBtn.innerHTML = '🔒 Upload Locked (Safe Mode) — Click to Unlock...';
            statusBtn.style.background = '#1e293b';
            statusBtn.style.borderColor = '#38bdf8';
            bar.style.borderBottom = SAFETY_LEVEL === 'strict' ? '2px solid #f59e0b' : '1px solid #334155';
        }}
    }}

    let barCollapsed = false;

    function ensureLayoutStyle() {{
        if (document.getElementById('mhzipy-layout-style')) return;
        const style = document.createElement('style');
        style.id = 'mhzipy-layout-style';
        style.textContent = `
            html.mhzipy-bar-expanded > body {{
                margin-top: 38px !important;
                height: calc(100vh - 38px) !important;
                max-height: calc(100vh - 38px) !important;
                transform: translateZ(0) !important;
                position: relative !important;
                box-sizing: border-box !important;
            }}
            html.mhzipy-bar-expanded > body > #app,
            html.mhzipy-bar-expanded > body > .react-container,
            html.mhzipy-bar-expanded > body > .bd,
            html.mhzipy-bar-expanded > body > main {{
                max-height: calc(100vh - 38px) !important;
            }}
        `;
        (document.head || document.documentElement).appendChild(style);
    }}

    function syncBarCollapseState() {{
        const bar = document.getElementById('mhzipy-safety-bar');
        const pill = document.getElementById('mhzipy-collapsed-pill');
        ensureLayoutStyle();
        if (barCollapsed) {{
            document.documentElement.classList.remove('mhzipy-bar-expanded');
            if (bar) bar.style.display = 'none';
            if (pill) pill.style.display = 'flex';
        }} else {{
            document.documentElement.classList.add('mhzipy-bar-expanded');
            if (bar) bar.style.display = 'flex';
            if (pill) pill.style.display = 'none';
        }}
    }}

    function mountSafetyBar() {{
        ensureLayoutStyle();
        if (document.getElementById('mhzipy-safety-bar')) {{
            syncBarCollapseState();
            return;
        }}
        const bar = document.createElement('div');
        bar.id = 'mhzipy-safety-bar';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:38px;background:#0f172a;color:#f8fafc;z-index:2147483645;display:flex;align-items:center;justify-content:space-between;padding:0 12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,0.35);border-bottom:1px solid #334155;user-select:none;box-sizing:border-box;';

        const levelBadge = SAFETY_LEVEL === 'strict'
            ? '<span style="background:#dc2626;color:#fff;padding:2px 7px;border-radius:4px;font-weight:700;font-size:11px;">🔴 STRICT OFFICIAL</span>'
            : (SAFETY_LEVEL === 'download_only'
                ? '<span style="background:#059669;color:#fff;padding:2px 7px;border-radius:4px;font-weight:700;font-size:11px;">🟢 DOWNLOAD ONLY</span>'
                : '<span style="background:#d97706;color:#fff;padding:2px 7px;border-radius:4px;font-weight:700;font-size:11px;">🟡 CAUTION GUARD</span>');

        bar.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;overflow:hidden;">
                ${{levelBadge}}
                <span style="font-weight:700;color:#38bdf8;white-space:nowrap;">🌐 ${{FOLDER_NAME}}</span>
                ${{LINKED_LOCAL ? `
                    <span style="color:#cbd5e1;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;" title="Linked Local Root Folder: ${{LINKED_LOCAL}}">📥 ${{LINKED_LOCAL}}</span>
                    <button id="mhzipy-subpath-badge" title="Auto-detected Web Folder hierarchy subpath. Click to customize or reset to auto-detect." style="background:rgba(15,23,42,0.9);border:1px solid rgba(148,163,184,0.35);color:#94a3b8;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">
                        📁 [Root]
                    </button>
                ` : `<span style="color:#64748b;font-size:11px;">(No linked local folder — downloads go to default Downloads)</span>`}}
            </div>
            <div style="display:flex;align-items:center;gap:7px;flex-shrink:0;">
                ${{LINKED_LOCAL ? `
                    <button id="mhzipy-auto-zip-btn" title="When ON, downloading a folder (.zip) from Box automatically extracts its folder hierarchy into the target local path." style="background:#065f46;border:1px solid #10b981;color:#ecfdf5;padding:3px 8px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">
                        📦 Auto-Unpack ZIP: ON
                    </button>
                ` : ''}}
                <button id="mhzipy-inspect-btn" style="background:#0284c7;border:1px solid #38bdf8;color:#fff;padding:3px 9px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">
                    🔍 Pre-Upload File Inspector
                </button>
                <button id="mhzipy-lock-toggle-btn" style="background:#1e293b;border:1px solid #38bdf8;color:#fff;padding:3px 10px;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;transition:all 0.15s;">
                    🔒 Upload Locked (Safe Mode) — Click to Unlock...
                </button>
                <button id="mhzipy-collapse-bar-btn" title="Minimize Safety Bar" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:#cbd5e1;padding:3px 7px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">
                    ▲ Hide
                </button>
            </div>
        `;

        document.documentElement.appendChild(bar);

        const pill = document.createElement('button');
        pill.id = 'mhzipy-collapsed-pill';
        pill.title = 'Click to expand MHZipy Web Folder Safety Bar';
        pill.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483645;background:#0f172a;border:1px solid #38bdf8;color:#f8fafc;padding:6px 12px;border-radius:999px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:11.5px;font-weight:700;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,0.5);display:none;align-items:center;gap:6px;opacity:0.9;';
        pill.innerHTML = '🛡️ Safe Guard ▼';
        pill.onclick = () => {{
            barCollapsed = false;
            syncBarCollapseState();
        }};
        document.documentElement.appendChild(pill);

        bar.querySelector('#mhzipy-collapse-bar-btn').onclick = () => {{
            barCollapsed = true;
            syncBarCollapseState();
        }};

        syncBarCollapseState();

        const subBadge = bar.querySelector('#mhzipy-subpath-badge');
        if (subBadge) {{
            subBadge.onclick = () => {{
                const cur = getActiveSubpath().join('\\');
                const input = window.prompt(
                    '📂 Relative Subfolder Path inside "' + LINKED_LOCAL + '":\n\n' +
                    '• Leave empty and click OK to reset to Auto-Detect from Web Folder breadcrumbs.\n' +
                    '• Or enter a custom subfolder path (e.g. 01_Specs\\Drafts):',
                    cur
                );
                if (input === null) return;
                const trimmed = input.trim();
                if (!trimmed) {{
                    manualSubpathOverride = null;
                    updateDetectedHierarchy();
                    showGuardToast('📂 Subfolder path set to Auto-Detect from Web Folder hierarchy.', false);
                }} else {{
                    manualSubpathOverride = trimmed.split(/[/\\]+/).map(sanitizeSegment).filter(Boolean);
                    syncDownloadStateToHost();
                    updateSubpathBarUI();
                    showGuardToast('📂 Custom download subpath set to: \\' + manualSubpathOverride.join('\\'), false);
                }}
            }};
        }}

        const autoZipBtn = bar.querySelector('#mhzipy-auto-zip-btn');
        if (autoZipBtn) {{
            autoZipBtn.onclick = () => {{
                autoExtractZip = !autoExtractZip;
                autoZipBtn.textContent = autoExtractZip ? '📦 Auto-Unpack ZIP: ON' : '📦 Auto-Unpack ZIP: OFF';
                autoZipBtn.style.background = autoExtractZip ? '#065f46' : '#334155';
                autoZipBtn.style.borderColor = autoExtractZip ? '#10b981' : '#64748b';
                syncDownloadStateToHost();
                showGuardToast(
                    autoExtractZip
                        ? '📦 Auto-Unpack ZIP enabled: Downloaded folder ZIPs will be automatically extracted with their full folder hierarchy.'
                        : '📦 Auto-Unpack ZIP disabled: Downloaded ZIP files will be saved as .zip archives.',
                    false
                );
            }};
        }}

        bar.querySelector('#mhzipy-inspect-btn').onclick = () => openInspectorModal();
        bar.querySelector('#mhzipy-lock-toggle-btn').onclick = () => {{
            if (uploadUnlocked) {{
                setUploadLockState(false);
                showGuardToast('🔒 Upload is now LOCKED.', false);
            }} else {{
                openInspectorModal();
            }}
        }};

        updateBarUI(0);
        updateSubpathBarUI();
        syncDownloadStateToHost();
    }}

    if (document.readyState === 'loading') {{
        window.addEventListener('DOMContentLoaded', mountSafetyBar);
    }} else {{
        mountSafetyBar();
    }}
    setTimeout(mountSafetyBar, 800);

    // Continuously track breadcrumb hierarchy changes as user navigates inside the Web Folder
    setInterval(() => {{
        mountSafetyBar();
        updateDetectedHierarchy();
    }}, 900);
    window.addEventListener('popstate', () => setTimeout(updateDetectedHierarchy, 200));
    window.addEventListener('click', () => {{
        updateDetectedHierarchy();
        setTimeout(updateDetectedHierarchy, 350);
    }}, true);
}})();
"#
    );

    let local_for_dl = linked_local_path.trim().to_string();

    std::thread::spawn(move || {
        let mut builder = tauri::WebviewWindowBuilder::new(
            &app_clone,
            &label,
            tauri::WebviewUrl::External(parsed_url),
        )
        .title(format!("🌐 {} — MHZipy Safe Web Folder", name))
        .inner_size(1220.0, 860.0)
        .min_inner_size(700.0, 500.0)
        .decorations(true)
        .resizable(true)
        .visible(true)
        .focused(true)
        .disable_drag_drop_handler()
        .initialization_script(&init_script);

        if let Some(p) = pos {
            builder = builder.position((p.x + 40) as f64, (p.y + 40) as f64);
        }

        if let Ok(win) = builder.build() {
            let _ = app_clone.emit(
                "web-folder-live-state",
                serde_json::json!({
                    "id": id,
                    "label": label,
                    "isOpen": true,
                    "subpath": Vec::<String>::new(),
                    "autoExtractZip": true,
                    "uploadUnlocked": false,
                    "remainingSeconds": 0,
                }),
            );
            #[cfg(target_os = "windows")]
            attach_web_folder_download_manager(&win, app_clone.clone(), id.clone(), local_for_dl);
            focus_webview_window(&win);
        }
    });

    Ok(())
}

#[cfg(target_os = "windows")]
struct WebFolderDownloadState {
    linked_local_path: String,
    relative_subpath: Vec<String>,
    auto_extract_zip: bool,
}

#[cfg(target_os = "windows")]
fn sanitize_windows_segment(seg: &str) -> String {
    let cleaned: String = seg
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    cleaned.trim().trim_matches('.').trim().to_string()
}

#[cfg(target_os = "windows")]
fn extract_downloaded_zip_preserving_hierarchy(
    zip_path: &Path,
    target_dir: &Path,
) -> Result<usize, String> {
    let file = File::open(zip_path).map_err(|e| format!("Failed to open ZIP: {}", e))?;
    let mut archive = zip::ZipArchive::new(BufReader::new(file))
        .map_err(|e| format!("Invalid ZIP archive: {}", e))?;

    let mut common_root: Option<String> = None;
    let mut all_share_root = true;

    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            if let Some(enclosed) = entry.enclosed_name() {
                let mut comps = enclosed.components();
                if let Some(first) = comps.next() {
                    let first_str = first.as_os_str().to_string_lossy().to_string();
                    if comps.next().is_none() && !entry.is_dir() {
                        all_share_root = false;
                        break;
                    }
                    if let Some(ref existing) = common_root {
                        if existing != &first_str {
                            all_share_root = false;
                            break;
                        }
                    } else {
                        common_root = Some(first_str);
                    }
                }
            }
        }
    }

    // Strip the ZIP's top-level folder prefix ONLY if target_dir ALREADY ends with that exact folder name
    // (e.g., user navigated inside "SubB" so target_dir is "...\SubB" and downloaded "SubB.zip").
    // If the user is in parent "...\SubA" and downloaded child folder "SubB.zip", keep "SubB/" so "...\SubA\SubB\..." is created!
    let strip_root = if all_share_root {
        if let Some(ref root) = common_root {
            target_dir
                .file_name()
                .and_then(|n| n.to_str())
                .map(|leaf| leaf.eq_ignore_ascii_case(root))
                .unwrap_or(false)
        } else {
            false
        }
    } else {
        false
    };

    let mut extracted_count = 0usize;
    let mut buffer = [0u8; 65536];

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };

        let rel_path: PathBuf = if strip_root {
            let mut comps = enclosed.components();
            let _ = comps.next();
            comps.as_path().to_path_buf()
        } else {
            enclosed.to_path_buf()
        };

        if rel_path.as_os_str().is_empty() {
            continue;
        }

        let dest_path = target_dir.join(&rel_path);
        if entry.is_dir() {
            fs::create_dir_all(&dest_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = dest_path.parent() {
                if !parent.exists() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
            }
            if let Ok(meta) = fs::metadata(&dest_path) {
                let mut perms = meta.permissions();
                if perms.readonly() {
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&dest_path, perms);
                }
            }
            let mut outfile = File::create(&dest_path).map_err(|e| e.to_string())?;
            loop {
                let n = entry.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                outfile.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
            }
            extracted_count += 1;
        }
    }

    Ok(extracted_count)
}

#[cfg(target_os = "windows")]
fn attach_web_folder_download_manager(
    win: &tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    wf_id: String,
    linked_local_path: String,
) {
    use std::os::windows::ffi::OsStrExt;
    use std::sync::Mutex;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_4, COREWEBVIEW2_DOWNLOAD_STATE, COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED,
    };
    use webview2_com::{
        DownloadStartingEventHandler, StateChangedEventHandler, WebMessageReceivedEventHandler,
    };
    use windows61::core::{Interface, PCWSTR, PWSTR};

    let state = Arc::new(Mutex::new(WebFolderDownloadState {
        linked_local_path,
        relative_subpath: Vec::new(),
        auto_extract_zip: true,
    }));

    let win_for_dl = win.clone();
    let state_for_msg = state.clone();
    let state_for_dl = state.clone();
    let app_for_msg = app_handle.clone();
    let wf_id_for_msg = wf_id.clone();
    let app_for_dl = app_handle.clone();
    let wf_id_for_dl = wf_id.clone();

    let _ = win.with_webview(move |pw| unsafe {
        let controller = pw.controller();
        let Ok(core) = controller.CoreWebView2() else {
            return;
        };

        // 1. Listen for hierarchy subpath & lock state updates from the injected Web Folder script
        let msg_handler = WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut raw = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut raw).is_err() {
                return Ok(());
            };
            let text = webview2_com::take_pwstr(raw);
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if json.get("type").and_then(|v| v.as_str()) == Some("mhzipy-web-folder-state") {
                    let unlocked = json
                        .get("uploadUnlocked")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let rem_sec = json
                        .get("remainingSeconds")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    if let Ok(mut st) = state_for_msg.lock() {
                        if let Some(arr) = json.get("subpath").and_then(|v| v.as_array()) {
                            st.relative_subpath = arr
                                .iter()
                                .filter_map(|v| v.as_str())
                                .map(sanitize_windows_segment)
                                .filter(|s| !s.is_empty())
                                .collect();
                        }
                        if let Some(auto_zip) = json.get("autoExtractZip").and_then(|v| v.as_bool())
                        {
                            st.auto_extract_zip = auto_zip;
                        }
                        let _ = app_for_msg.emit(
                            "web-folder-live-state",
                            serde_json::json!({
                                "id": wf_id_for_msg,
                                "isOpen": true,
                                "subpath": st.relative_subpath,
                                "autoExtractZip": st.auto_extract_zip,
                                "uploadUnlocked": unlocked,
                                "remainingSeconds": rem_sec,
                            }),
                        );
                    }
                }
            }
            Ok(())
        }));
        let mut msg_token: i64 = 0;
        let _ = core.add_WebMessageReceived(&msg_handler, &mut msg_token);

        // 2. Intercept WebView2 downloads and redirect to linked_local_path + relative_subpath
        let Ok(core4) = core.cast::<ICoreWebView2_4>() else {
            return;
        };

        let dl_handler = DownloadStartingEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };

            let mut default_pwstr = PWSTR::null();
            if args.ResultFilePath(&mut default_pwstr).is_err() {
                return Ok(());
            }
            let default_path_str = webview2_com::take_pwstr(default_pwstr);
            let file_name = Path::new(&default_path_str)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("downloaded_file")
                .to_string();

            let (base_dir, subpath, auto_extract_zip) = match state_for_dl.lock() {
                Ok(st) => (
                    st.linked_local_path.clone(),
                    st.relative_subpath.clone(),
                    st.auto_extract_zip,
                ),
                Err(_) => return Ok(()),
            };

            if base_dir.trim().is_empty() {
                return Ok(());
            }

            let mut target_dir = PathBuf::from(&base_dir);
            for seg in &subpath {
                let clean = sanitize_windows_segment(seg);
                if !clean.is_empty() {
                    target_dir.push(clean);
                }
            }

            // Create the full local folder hierarchy before saving the file
            let _ = fs::create_dir_all(&target_dir);

            let final_file_path = target_dir.join(&file_name);
            let final_path_str = final_file_path.to_string_lossy().to_string();
            let wide_path: Vec<u16> = std::ffi::OsStr::new(&final_path_str)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();

            let _ = args.SetResultFilePath(PCWSTR(wide_path.as_ptr()));

            // Notify UI that download started into the created hierarchy folder
            let target_dir_display = target_dir.to_string_lossy().to_string();
            if let (Ok(fn_json), Ok(td_json)) = (
                serde_json::to_string(&file_name),
                serde_json::to_string(&target_dir_display),
            ) {
                let _ = win_for_dl.eval(&format!(
                    "window.__mhzipyNotifyDownloadStart && window.__mhzipyNotifyDownloadStart({}, {});",
                    fn_json, td_json
                ));
            }

            // Monitor download completion to notify user (and auto-unpack folder ZIP if enabled)
            if let Ok(dl_op) = args.DownloadOperation() {
                let win_done = win_for_dl.clone();
                let app_done = app_for_dl.clone();
                let wf_id_done = wf_id_for_dl.clone();
                let saved_path = final_file_path.clone();
                let saved_dir = target_dir.clone();
                let saved_name = file_name.clone();
                let handled = Arc::new(std::sync::atomic::AtomicBool::new(false));

                let state_handler = StateChangedEventHandler::create(Box::new(move |op_sender, _| {
                    let Some(op) = op_sender else {
                        return Ok(());
                    };
                    let mut dl_state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                    if op.State(&mut dl_state).is_ok()
                        && dl_state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED
                    {
                        if handled.swap(true, std::sync::atomic::Ordering::SeqCst) {
                            return Ok(());
                        }
                        let is_zip = saved_path
                            .extension()
                            .and_then(|e| e.to_str())
                            .map(|e| e.eq_ignore_ascii_case("zip"))
                            .unwrap_or(false);

                        let win_notify = win_done.clone();
                        let app_notify = app_done.clone();
                        let wf_id_notify = wf_id_done.clone();
                        let sp = saved_path.clone();
                        let sd = saved_dir.clone();
                        let sn = saved_name.clone();

                        std::thread::spawn(move || {
                            if is_zip && auto_extract_zip {
                                match extract_downloaded_zip_preserving_hierarchy(&sp, &sd) {
                                    Ok(count) if count > 0 => {
                                        let _ = fs::remove_file(&sp);
                                        let msg = format!(
                                            "✅ Extracted {} file(s) with folder hierarchy from \"{}\" → {}",
                                            count,
                                            sn,
                                            sd.to_string_lossy()
                                        );
                                        if let Ok(m_json) = serde_json::to_string(&msg) {
                                            let _ = win_notify.eval(&format!(
                                                "window.__mhzipyNotifyDownloadDone && window.__mhzipyNotifyDownloadDone({}, false);",
                                                m_json
                                            ));
                                        }
                                        let _ = app_notify.emit(
                                            "web-folder-download-completed",
                                            serde_json::json!({
                                                "id": wf_id_notify,
                                                "targetDir": sd.to_string_lossy(),
                                                "fileName": format!("{} ({} files unpacked)", sn, count),
                                            }),
                                        );
                                        return;
                                    }
                                    Err(err) => {
                                        let msg = format!(
                                            "⚠️ Downloaded \"{}\" to {}, but auto-extract failed: {}",
                                            sn,
                                            sd.to_string_lossy(),
                                            err
                                        );
                                        if let Ok(m_json) = serde_json::to_string(&msg) {
                                            let _ = win_notify.eval(&format!(
                                                "window.__mhzipyNotifyDownloadDone && window.__mhzipyNotifyDownloadDone({}, true);",
                                                m_json
                                            ));
                                        }
                                        let _ = app_notify.emit(
                                            "web-folder-download-completed",
                                            serde_json::json!({
                                                "id": wf_id_notify,
                                                "targetDir": sd.to_string_lossy(),
                                                "fileName": sn,
                                            }),
                                        );
                                        return;
                                    }
                                    _ => {}
                                }
                            }

                            let msg = format!(
                                "✅ Saved \"{}\" → {}",
                                sn,
                                sp.to_string_lossy()
                            );
                            if let Ok(m_json) = serde_json::to_string(&msg) {
                                let _ = win_notify.eval(&format!(
                                    "window.__mhzipyNotifyDownloadDone && window.__mhzipyNotifyDownloadDone({}, false);",
                                    m_json
                                ));
                            }
                            let _ = app_notify.emit(
                                "web-folder-download-completed",
                                serde_json::json!({
                                    "id": wf_id_notify,
                                    "targetDir": sd.to_string_lossy(),
                                    "fileName": sn,
                                }),
                            );
                        });
                    }
                    Ok(())
                }));
                let mut st_token: i64 = 0;
                let _ = dl_op.add_StateChanged(&state_handler, &mut st_token);
            }

            Ok(())
        }));
        let mut dl_token: i64 = 0;
        let _ = core4.add_DownloadStarting(&dl_handler, &mut dl_token);
    });
}

#[derive(serde::Serialize, Clone)]
struct FileContentInspection {
    detected_kind: String,
    is_text: bool,
    is_image: bool,
    is_pdf: bool,
    is_video: bool,
    is_zip: bool,
}

/// 확장자가 아닌 실제 파일 헤더(Magic Bytes) 및 바이트 내용을 분석하여 파일 종류를 판별합니다.
#[tauri::command]
fn inspect_file_content_kind(path: String) -> Result<FileContentInspection, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    if p.is_dir() {
        return Err("Cannot inspect a directory as a file.".to_string());
    }

    let mut f = File::open(p).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut buf = vec![0u8; 8192];
    let n = f
        .read(&mut buf)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    buf.truncate(n);

    if n == 0 {
        return Ok(FileContentInspection {
            detected_kind: "Empty File (Text Compatible)".to_string(),
            is_text: true,
            is_image: false,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }

    // 1. PDF Check (%PDF- within first 1024 bytes)
    let pdf_scan_len = n.min(1024);
    if buf[..pdf_scan_len].windows(5).any(|w| w == b"%PDF-") {
        return Ok(FileContentInspection {
            detected_kind: "PDF Document (%PDF header)".to_string(),
            is_text: false,
            is_image: false,
            is_pdf: true,
            is_video: false,
            is_zip: false,
        });
    }

    // 2. ZIP Check (PK\x03\x04, PK\x05\x06, PK\x07\x08 + ZipArchive verification)
    if n >= 4
        && (&buf[0..4] == b"PK\x03\x04"
            || &buf[0..4] == b"PK\x05\x06"
            || &buf[0..4] == b"PK\x07\x08")
    {
        if let Ok(zf) = File::open(p) {
            if zip::ZipArchive::new(BufReader::new(zf)).is_ok() {
                return Ok(FileContentInspection {
                    detected_kind: "ZIP Archive (PK header)".to_string(),
                    is_text: false,
                    is_image: false,
                    is_pdf: false,
                    is_video: false,
                    is_zip: true,
                });
            }
        }
    }

    // 3. Raster Image Checks
    if n >= 8 && &buf[0..8] == b"\x89PNG\r\n\x1a\n" {
        return Ok(FileContentInspection {
            detected_kind: "PNG Image".to_string(),
            is_text: false,
            is_image: true,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }
    if n >= 3 && &buf[0..3] == b"\xFF\xD8\xFF" {
        return Ok(FileContentInspection {
            detected_kind: "JPEG Image".to_string(),
            is_text: false,
            is_image: true,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }
    if n >= 6 && (&buf[0..6] == b"GIF87a" || &buf[0..6] == b"GIF89a") {
        return Ok(FileContentInspection {
            detected_kind: "GIF Image".to_string(),
            is_text: false,
            is_image: true,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }
    if n >= 12 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        return Ok(FileContentInspection {
            detected_kind: "WebP Image".to_string(),
            is_text: false,
            is_image: true,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }
    if n >= 14 && &buf[0..2] == b"BM" {
        return Ok(FileContentInspection {
            detected_kind: "BMP Image".to_string(),
            is_text: false,
            is_image: true,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }
    if n >= 4 && (&buf[0..4] == b"II*\x00" || &buf[0..4] == b"MM\x00*") {
        return Ok(FileContentInspection {
            detected_kind: "TIFF Image".to_string(),
            is_text: false,
            is_image: true,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }
    if n >= 4 && (&buf[0..4] == b"\x00\x00\x01\x00" || &buf[0..4] == b"\x00\x00\x02\x00") {
        return Ok(FileContentInspection {
            detected_kind: "ICO / CUR Icon Image".to_string(),
            is_text: false,
            is_image: true,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }

    // 4. ISO Base Media File Format (ftyp at offset 4: AVIF/HEIF Image vs MP4/MOV/3GP/M4V Video)
    if n >= 12 && &buf[4..8] == b"ftyp" {
        let brand = &buf[8..12];
        if brand == b"avif"
            || brand == b"avis"
            || brand == b"heic"
            || brand == b"heix"
            || brand == b"mif1"
        {
            return Ok(FileContentInspection {
                detected_kind: "AVIF / HEIF Image".to_string(),
                is_text: false,
                is_image: true,
                is_pdf: false,
                is_video: false,
                is_zip: false,
            });
        } else {
            return Ok(FileContentInspection {
                detected_kind: "MP4 / MOV / ISO Media Video".to_string(),
                is_text: false,
                is_image: false,
                is_pdf: false,
                is_video: true,
                is_zip: false,
            });
        }
    }

    // Other Video Container Signatures
    if n >= 8
        && (&buf[4..8] == b"moov"
            || &buf[4..8] == b"mdat"
            || &buf[4..8] == b"wide"
            || &buf[4..8] == b"free")
    {
        return Ok(FileContentInspection {
            detected_kind: "QuickTime / MOV Video".to_string(),
            is_text: false,
            is_image: false,
            is_pdf: false,
            is_video: true,
            is_zip: false,
        });
    }
    if n >= 4 && &buf[0..4] == b"\x1A\x45\xDF\xA3" {
        return Ok(FileContentInspection {
            detected_kind: "MKV / WebM Video (EBML)".to_string(),
            is_text: false,
            is_image: false,
            is_pdf: false,
            is_video: true,
            is_zip: false,
        });
    }
    if n >= 12 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"AVI " {
        return Ok(FileContentInspection {
            detected_kind: "AVI Video".to_string(),
            is_text: false,
            is_image: false,
            is_pdf: false,
            is_video: true,
            is_zip: false,
        });
    }
    if n >= 16
        && &buf[0..16]
            == b"\x30\x26\xB2\x75\x8E\x66\xCF\x11\xA6\xD9\x00\xAA\x00\x62\xCE\x6C"
    {
        return Ok(FileContentInspection {
            detected_kind: "WMV / ASF Video".to_string(),
            is_text: false,
            is_image: false,
            is_pdf: false,
            is_video: true,
            is_zip: false,
        });
    }
    if n >= 4 && &buf[0..3] == b"FLV" && buf[3] == 0x01 {
        return Ok(FileContentInspection {
            detected_kind: "FLV Video".to_string(),
            is_text: false,
            is_image: false,
            is_pdf: false,
            is_video: true,
            is_zip: false,
        });
    }
    if n >= 4 && &buf[0..4] == b".RMF" {
        return Ok(FileContentInspection {
            detected_kind: "RealMedia (RMVB) Video".to_string(),
            is_text: false,
            is_image: false,
            is_pdf: false,
            is_video: true,
            is_zip: false,
        });
    }
    if (n >= 4 && (&buf[0..4] == b"\x00\x00\x01\xBA" || &buf[0..4] == b"\x00\x00\x01\xB3"))
        || (n >= 377 && buf[0] == 0x47 && buf[188] == 0x47 && buf[376] == 0x47)
    {
        return Ok(FileContentInspection {
            detected_kind: "MPEG / Transport Stream Video".to_string(),
            is_text: false,
            is_image: false,
            is_pdf: false,
            is_video: true,
            is_zip: false,
        });
    }

    // 5. Known non-text binary signatures (EXE/DLL, ELF, OLE2 Office, RAR, 7z)
    if n >= 2 && &buf[0..2] == b"MZ" {
        return Ok(FileContentInspection {
            detected_kind: "Windows Executable / Binary (PE)".to_string(),
            is_text: false,
            is_image: false,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }
    if n >= 8 && &buf[0..8] == b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" {
        return Ok(FileContentInspection {
            detected_kind: "OLE2 Compound Binary Document".to_string(),
            is_text: false,
            is_image: false,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }

    // 6. Text vs Binary Heuristic (UTF-16 BOM, UTF-8 BOM, SVG XML, or NUL-free printable content)
    let has_utf16_bom = n >= 2 && (&buf[0..2] == b"\xFF\xFE" || &buf[0..2] == b"\xFE\xFF");
    let has_utf8_bom = n >= 3 && &buf[0..3] == b"\xEF\xBB\xBF";

    let text_preview = String::from_utf8_lossy(&buf).to_lowercase();
    let is_svg = text_preview.contains("<svg") && !buf.contains(&0u8);

    if is_svg {
        return Ok(FileContentInspection {
            detected_kind: "SVG Vector Image (XML Text)".to_string(),
            is_text: true,
            is_image: true,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }

    if has_utf16_bom || has_utf8_bom {
        return Ok(FileContentInspection {
            detected_kind: "Plain Text (Unicode BOM)".to_string(),
            is_text: true,
            is_image: false,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }

    let nul_count = buf.iter().filter(|&&b| b == 0).count();
    let bad_ctrl_count = buf
        .iter()
        .filter(|&&b| b < 0x20 && b != b'\t' && b != b'\n' && b != b'\r' && b != 0x0C && b != 0x1B)
        .count();

    if nul_count == 0 && (bad_ctrl_count * 50 <= n) {
        return Ok(FileContentInspection {
            detected_kind: "Plain Text / Markdown Content".to_string(),
            is_text: true,
            is_image: false,
            is_pdf: false,
            is_video: false,
            is_zip: false,
        });
    }

    Ok(FileContentInspection {
        detected_kind: "Binary File Content".to_string(),
        is_text: false,
        is_image: false,
        is_pdf: false,
        is_video: false,
        is_zip: false,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    if try_forward_to_running_instance() {
        std::process::exit(0);
    }

    tauri::Builder::default()
        // single-instance 플러그인: 반드시 최우선으로 등록하여 두 번째 프로세스가 즉시 인자만 전달하고 종료되도록 함
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            println!("[single-instance] argv: {:?}, cwd: {}", argv, cwd);

            let (pdf_paths, pdf_title, is_autostart) = parse_cli_args(&argv, Some(&cwd));

            if !pdf_paths.is_empty() {
                for path in &pdf_paths {
                    open_pdf_viewer(app, path, pdf_title.as_deref());
                }
            } else if !is_autostart {
                // PDF가 아니면 기존 메인 윈도우를 보여줌
                if let Some(window) = app.get_webview_window("main") {
                    focus_webview_window(&window);
                }
            }
        }))
        .register_uri_scheme_protocol("pdf-data", |_app, request| {
            let uri = request.uri().to_string();
            let path_str = uri
                .replace("http://pdf-data.localhost/", "")
                .replace("https://pdf-data.localhost/", "")
                .replace("pdf-data://localhost/", "");
            let path_str = urlencoding::decode(&path_str).unwrap_or_default().into_owned();
            
            let buf = std::fs::read(&path_str).unwrap_or_default();
            
            tauri::http::Response::builder()
                .header("Access-Control-Allow-Origin", "*")
                .header("Content-Type", "application/pdf")
                .body(buf)
                .unwrap()
        })
        .setup(|app| {
            #[cfg(target_os = "windows")]
            allow_single_instance_uipi();

            // CLI 인자 파싱 — PDF 파일 경로가 있으면 뷰어 모드로 진입
            let args: Vec<String> = std::env::args().collect();
            let (pdf_paths, pdf_title, is_autostart) = parse_cli_args(&args, None);

            // PDF 경로가 있으면 뷰어 윈도우 열기
            if !pdf_paths.is_empty() {
                for path in &pdf_paths {
                    open_pdf_viewer(app.handle(), path, pdf_title.as_deref());
                }
            } else {
                // Tray 상주 상태에서 탐색기로 PDF 더블클릭 시 즉시 열리도록 대기 윈도우 예열
                prewarm_pdf_viewer(app.handle().clone());
            }

            // 항상 메인 윈도우와 Tray를 설정 (최초 실행 시)
            {
                if let Some(main_window) = app.get_webview_window("main") {
                    // PDF 파일을 직접 열어서 기동한 경우 메인 창은 띄우지 않고 Tray 상주 상태 유지
                    if !is_autostart && pdf_paths.is_empty() {
                        let _ = main_window.show();
                    }
                }

                // --- System Tray Setup ---
                let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let show_i = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
                let separator = PredefinedMenuItem::separator(app)?;
                
                let auto_start_enabled = is_auto_start_enabled();
                if auto_start_enabled {
                    set_auto_start(true); // Ensure registry has --autostart flag
                }

                let auto_start_i = CheckMenuItem::with_id(
                    app,
                    "auto_start",
                    "Launch at Windows Startup",
                    true,
                    auto_start_enabled,
                    None::<&str>,
                )?;
                let menu = Menu::with_items(app, &[&show_i, &separator, &auto_start_i, &quit_i])?;

                let auto_start_ref = auto_start_i.clone();
                let _tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .tooltip("MHZipy")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event| match event.id.as_ref() {
                        "quit" => {
                            app.exit(0);
                        }
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "auto_start" => {
                            // CheckMenuItem은 클릭 시 자동으로 체크 상태가 토글됨
                            // 토글된 후의 체크 상태를 읽어서 레지스트리에 반영
                            let is_checked = auto_start_ref.is_checked().unwrap_or(false);
                            set_auto_start(is_checked);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    })
                    .build(app)?;
            }

            let state = AppState {
                mft: Arc::new(MftIndex::new("C:".to_string())),
            };

            // 앱 시작 시 인덱스 로드 및 모니터링 시작
            let index_clone = state.mft.clone();
            let app_handle = app.handle().clone();
            let index_path =
                get_index_path(&app_handle).expect("Failed to get index path on setup");

            // 파일 로드는 I/O 작업이므로 별도 스레드에서 처리
            std::thread::spawn(move || {
                if index_path.exists() {
                    println!("Loading existing index from disk...");
                    if let Ok((next_usn, journal_id)) = index_clone.load_from_disk(&index_path) {
                        println!("Index loaded successfully. Starting USN journal monitoring...");

                        // 모니터링 스레드 시작
                        let monitor_index = index_clone.clone();
                        let monitor_app_handle = app_handle.clone();
                        std::thread::spawn(move || {
                            monitor_index.monitor(next_usn, journal_id, move |changes| {
                                let _ = monitor_app_handle.emit("file-changes", changes);
                            });
                        });

                        // 프론트엔드에 로드 완료 이벤트 전송
                        let _ = app_handle.emit("index-ready", true);
                    } else {
                        println!("Failed to load index file. Please re-index manually.");
                    }
                } else {
                    println!("No index file found. Please build the index.");
                }
            });

            app.manage(state);
            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Windows 탐색기 ↔ MHZipy 네이티브 Drag&Drop 브리지
        .plugin(native_dnd::init())
        // Hide window on close instead of quitting (tray background mode)
        // PDF viewer 창은 그냥 닫히고, Main 윈도우는 Tray 방향으로 축소 애니메이션 후 숨김
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label != "main" {
                    if label.starts_with("web-folder-") {
                        let _ = window.app_handle().emit(
                            "web-folder-window-closed",
                            serde_json::json!({ "label": label }),
                        );
                    }
                    // 닫히는 PDF 뷰어 윈도우를 열림 목록에서 제거
                    if let Ok(mut map) = open_pdf_windows_map().lock() {
                        map.retain(|_, v| v != label);
                    }
                    // Auxiliary windows (e.g., md-editor, pdf-viewer): simply close without tray animation
                    return;
                }
                // Main window: Tray로 축소되는 애니메이션 후 숨김
                api.prevent_close();
                let win = window.clone();
                std::thread::spawn(move || {
                    // 현재 윈도우 위치와 크기 저장
                    let Ok(pos) = win.outer_position() else { let _ = win.hide(); return; };
                    let Ok(size) = win.outer_size() else { let _ = win.hide(); return; };

                    // 모니터 정보로 Tray 영역(우하단) 좌표 계산
                    let (target_x, target_y) = if let Ok(Some(monitor)) = win.current_monitor() {
                        let mp = monitor.position();
                        let ms = monitor.size();
                        (
                            mp.x + ms.width as i32 - 100,
                            mp.y + ms.height as i32 - 50,
                        )
                    } else {
                        (pos.x + size.width as i32, pos.y + size.height as i32)
                    };

                    let steps = 6u32;
                    let delay = std::time::Duration::from_millis(8);

                    for i in 1..=steps {
                        let t = i as f64 / steps as f64;
                        let eased = t * t; // ease-in: 점점 빨라짐

                        let scale = 1.0 - eased * 0.95; // 5%까지 축소
                        let new_w = (size.width as f64 * scale).max(1.0) as u32;
                        let new_h = (size.height as f64 * scale).max(1.0) as u32;

                        let new_x = pos.x as f64 + (target_x as f64 - pos.x as f64) * eased;
                        let new_y = pos.y as f64 + (target_y as f64 - pos.y as f64) * eased;

                        let _ = win.set_size(tauri::Size::Physical(
                            tauri::PhysicalSize::new(new_w, new_h),
                        ));
                        let _ = win.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition::new(new_x as i32, new_y as i32),
                        ));
                        std::thread::sleep(delay);
                    }

                    // 숨기고 원래 크기/위치 복원 (다음에 show할 때 정상 표시되도록)
                    let _ = win.hide();
                    let _ = win.set_size(tauri::Size::Physical(size));
                    let _ = win.set_position(tauri::Position::Physical(pos));
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            compress_files,
            extract_zip,
            list_zip_contents,
            extract_zip_files,
            open_file,
            build_mft_index,
            search_mft,
            delete_to_trash,
            get_available_drives,
            read_directory,
            search_directory,
            copy_files_to_clipboard,
            open_in_explorer,
            get_files_from_clipboard,
            get_license_info,
            activate_license,
            get_web_app_url,
            convert_pptx_to_pdf,
            toggle_maximize,
            is_window_maximized,
            minimize_window,
            close_window,
            toggle_fullscreen,
            is_window_fullscreen,
            read_text_file_content,
            save_text_file_content,
            get_folder_images,
            get_folder_videos,
            icon::get_file_icons,
            native_dnd::start_native_file_drag,
            extract_pdf_pages,
            encrypt_pdf_file,
            decrypt_pdf_file,
            check_pdf_encrypted,
            save_pdf_bytes,
            read_binary_file,
            get_system_printers,
            open_printer_properties,
            open_pdf_print_dialog,
            execute_webview_print,
            open_safe_web_folder_window,
            inspect_file_content_kind
        ])
        // .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
