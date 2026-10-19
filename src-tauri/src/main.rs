// Always hide console window on Windows (both debug and release)
#![windows_subsystem = "windows"]

#[cfg(all(windows, not(debug_assertions)))]
fn is_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_ok() {
            let mut elevation = TOKEN_ELEVATION::default();
            let mut returned_size = 0u32;
            let success = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elevation as *mut _ as *mut _),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned_size,
            );
            let _ = CloseHandle(token);
            if success.is_ok() {
                return elevation.TokenIsElevated != 0;
            }
        }
    }
    false
}

#[cfg(all(windows, not(debug_assertions)))]
fn try_elevate_if_needed() {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // 이미 관리자 권한이면 승격 불필요
    if is_elevated() {
        return;
    }

    // 환경 변수 또는 인자로 승격 비활성화가 요청된 경우 스킵
    if std::env::var("MHZIPY_NO_ELEVATE").is_ok() {
        return;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--no-elevate") {
        return;
    }

    let exe_path = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return,
    };

    let file_wide: Vec<u16> = exe_path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let verb_wide: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();

    let args_str = args
        .iter()
        .map(|s| {
            if s.contains(' ') {
                format!("\"{}\"", s)
            } else {
                s.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    let params_wide: Vec<u16> = args_str.encode_utf16().chain(std::iter::once(0)).collect();

    let mut sei = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC | SEE_MASK_NOCLOSEPROCESS,
        hwnd: HWND(0),
        lpVerb: PCWSTR(verb_wide.as_ptr()),
        lpFile: PCWSTR(file_wide.as_ptr()),
        lpParameters: if args.is_empty() {
            PCWSTR::null()
        } else {
            PCWSTR(params_wide.as_ptr())
        },
        lpDirectory: PCWSTR::null(),
        nShow: SW_SHOWNORMAL.0 as i32,
        ..Default::default()
    };

    unsafe {
        // UAC 창을 띄워 관리자 권한 실행 시도
        // 사용자가 '예'를 누르면 성공 -> 새 관리자 프로세스가 시작되고 현재 일반 권한 프로세스는 종료
        // 사용자가 '아니요'를 누르면 실패 -> 에러를 무시하고 현재 일반 권한 모드로 계속 실행
        if ShellExecuteExW(&mut sei).is_ok() && !sei.hProcess.is_invalid() {
            let _ = CloseHandle(sei.hProcess);
            std::process::exit(0);
        }
    }
}

fn main() {
    #[cfg(all(windows, not(debug_assertions)))]
    try_elevate_if_needed();

    mhzipy_lib::run()
}
