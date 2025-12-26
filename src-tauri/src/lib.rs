// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, Window};
use walkdir::WalkDir;
use zip::write::FileOptions;

mod mft;
use mft::MftIndex;

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

// 앱 상태 관리
struct AppState {
    mft: Arc<MftIndex>,
}

/// 앱 데이터 디렉터리에 인덱스 파일 경로를 가져옵니다.
fn get_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get app config directory: {}", e))?;

    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app config directory: {}", e))?;
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
async fn search_mft(state: tauri::State<'_, AppState>, query: String) -> Result<Vec<String>, String> {
    let paths = state.mft.search(&query);
    // PathBuf를 String으로 변환하여 반환
    Ok(paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

// 압축 명령어
#[tauri::command]
fn compress_files(
    window: Window,
    paths: Vec<String>,
    target_zip_path: String,
    method: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    let path = Path::new(&target_zip_path);
    let file = File::create(&path).map_err(|e| e.to_string())?;
    let buf_writer = BufWriter::new(file); // 성능 향상을 위한 BufWriter
    let mut zip = zip::ZipWriter::new(buf_writer);

    let compression = match method.as_deref().unwrap_or("deflated") {
        "stored" => zip::CompressionMethod::Stored,
        _ => zip::CompressionMethod::Deflated,
    };

    let mut options = FileOptions::<()>::default()
        .compression_method(compression)
        .unix_permissions(0o755);

    if let Some(ref pass) = password {
        options = options.with_aes_encryption(zip::AesMode::Aes128, pass);
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
    let mut indices = Vec::new();
    let mut total_size = 0u64;
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_string();

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
            true // files가 None이면 모든 파일 대상
        };

        if is_target {
            indices.push(i);
            if !file.is_dir() {
                total_size += file.size();
            }
        }
    }

    // 덮어쓰기 방지 체크 (overwrite가 false일 경우)
    if !overwrite {
        for &i in &indices {
            let file = archive.by_index(i).map_err(|e| e.to_string())?;
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
                filename: "완료".to_string(),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = AppState {
                mft: Arc::new(MftIndex::new("C:".to_string())),
            };

            // 앱 시작 시 인덱스 로드 및 모니터링 시작
            let index_clone = state.mft.clone();
            let app_handle = app.handle().clone();
            let index_path = get_index_path(&app_handle).expect("Failed to get index path on setup");

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
        .invoke_handler(tauri::generate_handler![
            compress_files,
            extract_zip,
            list_zip_contents,
            extract_zip_files,
            open_file,
            build_mft_index,
            search_mft,
            delete_to_trash
        ])
        // .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
