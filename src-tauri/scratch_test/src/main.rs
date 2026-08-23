use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, GENERIC_READ, GENERIC_WRITE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Ioctl::{FSCTL_QUERY_USN_JOURNAL, USN_JOURNAL_DATA_V0};
use windows::Win32::System::IO::DeviceIoControl;
use std::mem::size_of;

fn main() {
    let drive = "C:";
    let path_str = format!("\\\\.\\{}", drive);
    let mut path_wide: Vec<u16> = path_str.encode_utf16().collect();
    path_wide.push(0);

    let handle = unsafe {
        CreateFileW(
            PCWSTR(path_wide.as_ptr()),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            HANDLE(0),
        )
    };
    
    match handle {
        Ok(h) => {
            println!("CreateFileW (0) Success.");
            let mut journal_data = USN_JOURNAL_DATA_V0::default();
            let mut bytes_returned = 0u32;
            let result = unsafe {
                DeviceIoControl(
                    h,
                    FSCTL_QUERY_USN_JOURNAL,
                    None,
                    0,
                    Some(&mut journal_data as *mut _ as *mut _),
                    size_of::<USN_JOURNAL_DATA_V0>() as u32,
                    Some(&mut bytes_returned),
                    None,
                )
            };
            println!("DeviceIoControl: {:?}", result.map_err(|e| e.to_string()));
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(h) };
        }
        Err(e) => println!("CreateFileW failed: {}", e),
    }
}
