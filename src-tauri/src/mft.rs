use dashmap::DashMap;
use rayon::prelude::*;
use std::mem::size_of;
use std::path::{Path, PathBuf};
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::sync::RwLock;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, ERROR_HANDLE_EOF, GENERIC_READ, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Ioctl::{
    FSCTL_ENUM_USN_DATA, FSCTL_READ_USN_JOURNAL, FSCTL_QUERY_USN_JOURNAL, MFT_ENUM_DATA_V0,
    READ_USN_JOURNAL_DATA_V0, USN_JOURNAL_DATA_V0, USN_REASON_FILE_CREATE,
    USN_REASON_FILE_DELETE, USN_REASON_RENAME_NEW_NAME, USN_REASON_RENAME_OLD_NAME,
    USN_RECORD_COMMON_HEADER, USN_RECORD_V2,
};
use windows::Win32::System::IO::DeviceIoControl;

// 파일 정보를 담을 구조체 (메모리 최적화)
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct FileEntry {
    pub parent_frn: u64,
    pub name: String,
    pub is_dir: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PersistentData {
    entries: Vec<(u64, FileEntry)>,
    next_usn: i64,
    journal_id: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct FileChange {
    pub action: String,
    pub path: String,
    pub is_dir: bool,
}

// 전역 인덱스 저장소 (FRN -> FileEntry)
pub struct MftIndex {
    pub entries: DashMap<u64, FileEntry>,
    search_index: RwLock<Vec<(u64, String)>>,
    pub drive_letter: String,
}

impl MftIndex {
    pub fn new(drive_letter: String) -> Self {
        Self {
            entries: DashMap::new(),
            search_index: RwLock::new(Vec::new()),
            drive_letter,
        }
    }

    // 1. 볼륨 핸들 획득
    fn get_volume_handle(&self) -> Result<HANDLE, String> {
        let drive = &self.drive_letter;
        // \\.\C: 형식으로 변환
        let path_str = format!("\\\\.\\{}", drive.trim_end_matches('\\'));
        let mut path_wide: Vec<u16> = path_str.encode_utf16().collect();
        path_wide.push(0);

        unsafe {
            CreateFileW(
                PCWSTR(path_wide.as_ptr()),
                GENERIC_READ.0, // GENERIC_READ 등이 필요할 수 있음
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                HANDLE(0),
            )
            .map_err(|e| {
                format!(
                    "Failed to open volume handle: {}. Admin rights required?",
                    e
                )
            })
        }
    }

    // 인덱스를 파일에 저장
    pub fn save_to_disk(&self, path: &Path, next_usn: i64, journal_id: u64) -> Result<(), String> {
        let persistent_data = PersistentData {
            entries: self.entries.iter().map(|r| (*r.key(), r.value().clone())).collect(),
            next_usn,
            journal_id,
        };

        let file = File::create(path).map_err(|e| format!("Failed to create index file: {}", e))?;
        let writer = BufWriter::new(file);
        // bincode는 빠르고 간결한 직렬화/역직렬화 라이브러리입니다.
        bincode::serialize_into(writer, &persistent_data)
            .map_err(|e| format!("Failed to serialize index: {}", e))?;
        Ok(())
    }

    // 파일에서 인덱스를 로드
    pub fn load_from_disk(&self, path: &Path) -> Result<(i64, u64), String> {
        let file = File::open(path).map_err(|e| format!("Failed to open index file: {}", e))?;
        let reader = BufReader::new(file);
        let persistent_data: PersistentData = bincode::deserialize_from(reader)
            .map_err(|e| format!("Failed to deserialize index: {}", e))?;

        self.entries.clear();
        for (k, v) in persistent_data.entries {
            self.entries.insert(k, v);
        }

        self.rebuild_search_index()?;
        
        Ok((persistent_data.next_usn, persistent_data.journal_id))
    }

    // 2. MFT 인덱싱 (FSCTL_ENUM_USN_DATA)
    pub fn build_index(&self) -> Result<(usize, i64, u64), String> {
        let handle = self.get_volume_handle()?;
        self.entries.clear();

        // 1. 현재 USN 저널 상태 조회 (모니터링 시작점 확보)
        let mut journal_data = USN_JOURNAL_DATA_V0::default();
        let mut bytes_returned = 0u32;
        unsafe {
            DeviceIoControl(
                handle,
                FSCTL_QUERY_USN_JOURNAL,
                None,
                0,
                Some(&mut journal_data as *mut _ as *mut _),
                size_of::<USN_JOURNAL_DATA_V0>() as u32,
                Some(&mut bytes_returned),
                None,
            ).map_err(|e| format!("Failed to query USN journal: {}", e))?;
        }

        // MFT 열거 설정
        let mut mft_enum_data = MFT_ENUM_DATA_V0 {
            StartFileReferenceNumber: 0,
            LowUsn: 0,
            HighUsn: journal_data.NextUsn, // 스냅샷 시점 고정
        };

        let mut buffer = vec![0u8; 1024 * 1024]; // 1MB 버퍼
        let mut bytes_returned = 0u32;

        loop {
            let result = unsafe {
                DeviceIoControl(
                    handle,
                    FSCTL_ENUM_USN_DATA,
                    Some(&mft_enum_data as *const _ as *const _),
                    size_of::<MFT_ENUM_DATA_V0>() as u32,
                    Some(buffer.as_mut_ptr() as *mut _),
                    buffer.len() as u32,
                    Some(&mut bytes_returned),
                    None,
                )
            };

            if let Err(err) = result {
                if err.code() == ERROR_HANDLE_EOF.into() {
                    break; // 모든 데이터를 다 읽음
                }
                let _ = unsafe { CloseHandle(handle) };
                return Err(format!("DeviceIoControl failed: {:?}", err));
            }

            if bytes_returned == 0 {
                break;
            }

            // 출력 버퍼의 첫 8바이트는 다음 시작 FRN입니다.
            if bytes_returned < 8 {
                break;
            }
            let next_frn = unsafe { *(buffer.as_ptr() as *const u64) };
            mft_enum_data.StartFileReferenceNumber = next_frn;

            // 레코드 파싱
            let mut offset = 8;
            while offset < bytes_returned as usize {
                // 공통 헤더를 읽어 레코드 길이를 확인
                let record_header =
                    unsafe { &*(buffer.as_ptr().add(offset) as *const USN_RECORD_COMMON_HEADER) };
                let record_len = record_header.RecordLength as usize;

                if offset + record_len > bytes_returned as usize {
                    break;
                }

                // V2 레코드로 변환
                let record = unsafe { &*(buffer.as_ptr().add(offset) as *const USN_RECORD_V2) };

                let name_len = record.FileNameLength as usize;
                let name_offset = record.FileNameOffset as usize;

                if name_len > 0 {
                    let name_ptr =
                        unsafe { (record as *const _ as *const u8).add(name_offset) as *const u16 };
                    let name_slice = unsafe { std::slice::from_raw_parts(name_ptr, name_len / 2) };
                    let name = String::from_utf16_lossy(name_slice);

                    let frn = record.FileReferenceNumber;
                    let parent_frn = record.ParentFileReferenceNumber;
                    let is_dir = (record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0) != 0;

                    self.entries.insert(
                        frn,
                        FileEntry {
                            parent_frn,
                            name,
                            is_dir,
                        },
                    );
                }

                offset += record_len;
            }
        }

        let _ = unsafe { CloseHandle(handle) };

        self.rebuild_search_index()?;

        Ok((self.entries.len(), journal_data.NextUsn, journal_data.UsnJournalID))
    }

    // 4. USN 저널 모니터링 (실시간 업데이트)
    pub fn monitor<F>(&self, start_usn: i64, journal_id: u64, on_change: F)
    where
        F: Fn(Vec<FileChange>) + Send + Sync + 'static,
    {
        if let Ok(handle) = self.get_volume_handle() {
            let mut read_data = READ_USN_JOURNAL_DATA_V0 {
                StartUsn: start_usn,
                ReasonMask: 0xFFFFFFFF,
                ReturnOnlyOnClose: 0,
                Timeout: 1, // 0 is busy-wait, use a timeout
                BytesToWaitFor: 0,
                UsnJournalID: journal_id,
            };

            let mut buffer = vec![0u8; 64 * 1024];
            let mut bytes_returned = 0u32;

            loop {
                let result = unsafe {
                    DeviceIoControl(
                        handle,
                        FSCTL_READ_USN_JOURNAL,
                        Some(&read_data as *const _ as *const _),
                        size_of::<READ_USN_JOURNAL_DATA_V0>() as u32,
                        Some(buffer.as_mut_ptr() as *mut _),
                        buffer.len() as u32,
                        Some(&mut bytes_returned),
                        None,
                    )
                };

                if result.is_ok() && bytes_returned > 8 {
                    let next_usn = unsafe { *(buffer.as_ptr() as *const i64) };
                    read_data.StartUsn = next_usn;

                    let mut changes = Vec::new();
                    let mut offset = 8; // First 8 bytes are the next USN
                    while offset < bytes_returned as usize {
                        let record_header = unsafe {
                            &*(buffer.as_ptr().add(offset) as *const USN_RECORD_COMMON_HEADER)
                        };
                        let record_len = record_header.RecordLength as usize;

                        if record_len == 0 || offset + record_len > bytes_returned as usize {
                            break;
                        }

                        let record =
                            unsafe { &*(buffer.as_ptr().add(offset) as *const USN_RECORD_V2) };
                        let frn = record.FileReferenceNumber;
                        let name_len = record.FileNameLength as usize;
                        let name_offset = record.FileNameOffset as usize;

                        if name_len > 0 {
                            let name_ptr = unsafe {
                                (record as *const _ as *const u8).add(name_offset) as *const u16
                            };
                            let name_slice =
                                unsafe { std::slice::from_raw_parts(name_ptr, name_len / 2) };
                            let name = String::from_utf16_lossy(name_slice);

                            // Handle different reasons
                            if (record.Reason & (USN_REASON_FILE_DELETE | USN_REASON_RENAME_OLD_NAME)) != 0 {
                                if let Some(entry) = self.entries.get(&frn) {
                                    if let Some(parent_path) = self.reconstruct_path(&entry.parent_frn) {
                                        let full_path = parent_path.join(&entry.name);
                                        changes.push(FileChange {
                                            action: "delete".to_string(),
                                            path: full_path.to_string_lossy().to_string(),
                                            is_dir: entry.is_dir,
                                        });
                                    }
                                }
                                self.entries.remove(&frn);
                                if let Ok(mut search_idx) = self.search_index.write() {
                                    search_idx.retain(|(entry_frn, _)| *entry_frn != frn);
                                }
                            } else if (record.Reason & (USN_REASON_FILE_CREATE | USN_REASON_RENAME_NEW_NAME)) != 0 {
                                let parent_frn = record.ParentFileReferenceNumber;
                                let is_dir = (record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0) != 0;
                                self.entries.insert(frn, FileEntry { parent_frn, name: name.clone(), is_dir });
                                if let Ok(mut search_idx) = self.search_index.write() {
                                    search_idx.retain(|(entry_frn, _)| *entry_frn != frn); // Remove old entry if it was a rename
                                    search_idx.push((frn, name.clone()));
                                }
                                
                                if let Some(parent_path) = self.reconstruct_path(&parent_frn) {
                                    let full_path = parent_path.join(&name);
                                    changes.push(FileChange {
                                        action: "create".to_string(),
                                        path: full_path.to_string_lossy().to_string(),
                                        is_dir,
                                    });
                                }
                            }
                        }

                        offset += record_len;
                    }
                    if !changes.is_empty() {
                        on_change(changes);
                    }
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
        }
    }

    // 3. 검색 및 경로 재구성
    pub fn search(&self, query: &str) -> Vec<PathBuf> {
        let query = query.to_lowercase();
        let search_idx = self.search_index.read().unwrap();

        // Rayon을 사용한 병렬 검색 (초고속 검색의 핵심)
        search_idx
            .par_iter()
            .filter(|(_, name)| name.to_lowercase().contains(&query))
            .filter_map(|(frn, _)| self.reconstruct_path(frn))
            .collect::<Vec<_>>() // 일단 병렬로 수집
            .into_iter() // 일반 Iterator로 변환
            .take(500)
            .collect()
    }

    // 부모 FRN을 타고 올라가며 경로 완성
    fn reconstruct_path(&self, frn: &u64) -> Option<PathBuf> {
        let mut path_parts = Vec::new();
        let mut current_frn = *frn;

        // 무한 루프 방지 (최대 깊이 제한)
        for _ in 0..50 {
            if let Some(entry) = self.entries.get(&current_frn) {
                path_parts.push(entry.name.clone());
                let parent = entry.parent_frn;

                // 루트 도달 체크 (자신이 부모인 경우 등)
                // 일반적으로 루트 디렉터리의 부모는 자기 자신이거나 특정 고정값입니다.
                if parent == current_frn || parent == 0 {
                    break;
                }

                // NTFS 루트 디렉터리 (Index 5) 체크
                if (parent & 0x0000_FFFF_FFFF_FFFF) == 5 {
                    break;
                }

                current_frn = parent;
            } else {
                // 부모가 없지만 루트(Index 5)인 경우
                if (current_frn & 0x0000_FFFF_FFFF_FFFF) == 5 {
                    break;
                }
                return None; // 부모 정보 유실 (삭제된 파일 등)
            }
        }

        path_parts.reverse();
        let mut path = PathBuf::from(&self.drive_letter);
        if !self.drive_letter.ends_with('\\') {
            path.push("\\");
        }
        for part in path_parts {
            path.push(part);
        }
        Some(path)
    }

    // 검색 최적화를 위한 인덱스 재생성
    fn rebuild_search_index(&self) -> Result<(), String> {
        let mut search_idx = self.search_index.write().map_err(|e| e.to_string())?;
        *search_idx = self
            .entries
            .par_iter() // rayon을 사용해 병렬로 처리
            .map(|r| (*r.key(), r.value().name.clone()))
            .collect();
        Ok(())
    }
}
