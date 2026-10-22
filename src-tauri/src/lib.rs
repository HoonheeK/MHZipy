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

/// PDF 뷰어 윈도우를 생성하는 헬퍼 함수.
/// 초기 실행 시와 single-instance 콜백 양쪽에서 재사용됩니다.
fn open_pdf_viewer(app: &AppHandle, pdf_path: &str, pdf_title: Option<&str>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    let title = match pdf_title {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => std::path::Path::new(pdf_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    };

    let init_script = format!(
        "window.__PDF_PATH__ = '{}';",
        pdf_path.replace("\\", "\\\\").replace("'", "\\'")
    );

    // 고유한 윈도우 라벨 생성 (동시에 여러 PDF를 열 수 있도록)
    let count = COUNTER.fetch_add(1, Ordering::SeqCst);
    let window_label = format!("pdf-viewer-{}", count);

    match tauri::WebviewWindowBuilder::new(
        app,
        &window_label,
        tauri::WebviewUrl::App(std::path::PathBuf::from("viewer.html")),
    )
    .initialization_script(&init_script)
    .title(&title)
    .inner_size(1000.0, 800.0)
    .decorations(false)
    .build()
    {
        Ok(_) => println!("PDF viewer opened: {}", pdf_path),
        Err(e) => eprintln!("Failed to open PDF viewer: {}", e),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            // CLI 인자 파싱 — PDF 파일 경로가 있으면 뷰어 모드로 진입
            let args: Vec<String> = std::env::args().collect();
            let mut pdf_path = String::new();
            let mut pdf_title = String::new();
            let mut is_autostart = false;

            let mut i = 1;
            while i < args.len() {
                if args[i] == "--pdf-viewer" && i + 1 < args.len() {
                    pdf_path = args[i + 1].clone();
                    i += 1;
                } else if args[i] == "--pdf-title" && i + 1 < args.len() {
                    pdf_title = args[i + 1].clone();
                    i += 1;
                } else if args[i].trim().to_lowercase() == "--autostart" {
                    is_autostart = true;
                } else if args[i].to_lowercase().ends_with(".pdf") {
                    pdf_path = args[i].clone();
                }
                i += 1;
            }

            // PDF 경로가 있으면 뷰어 윈도우 열기
            if !pdf_path.is_empty() {
                let title_opt = if pdf_title.is_empty() { None } else { Some(pdf_title.as_str()) };
                open_pdf_viewer(app.handle(), &pdf_path, title_opt);
            }

            // 항상 메인 윈도우와 Tray를 설정 (최초 실행 시)
            {
                if let Some(main_window) = app.get_webview_window("main") {
                    if !is_autostart {
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
        // single-instance 플러그인: 두 번째 프로세스가 실행되면 기존 인스턴스로 인자 전달
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            println!("[single-instance] argv: {:?}", argv);

            // argv에서 .pdf 파일 경로를 찾아 PDF 뷰어로 열기
            let mut pdf_path = String::new();
            let mut pdf_title = String::new();
            let mut i = 1;
            let mut is_autostart = false;
            while i < argv.len() {
                if argv[i] == "--pdf-viewer" && i + 1 < argv.len() {
                    pdf_path = argv[i + 1].clone();
                    i += 1;
                } else if argv[i] == "--pdf-title" && i + 1 < argv.len() {
                    pdf_title = argv[i + 1].clone();
                    i += 1;
                } else if argv[i].trim().to_lowercase() == "--autostart" {
                    is_autostart = true;
                } else if argv[i].to_lowercase().ends_with(".pdf") {
                    pdf_path = argv[i].clone();
                }
                i += 1;
            }

            if !pdf_path.is_empty() {
                let title_opt = if pdf_title.is_empty() { None } else { Some(pdf_title.as_str()) };
                open_pdf_viewer(app, &pdf_path, title_opt);
            } else if !is_autostart {
                // PDF가 아니면 기존 메인 윈도우를 보여줌
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }))
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
            icon::get_file_icons,
            native_dnd::start_native_file_drag
        ])
        // .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
