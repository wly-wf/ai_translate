//! A session-local mutex prevents duplicate hooks and clipboard capture workers.
use windows::{core::w, Win32::{
    Foundation::{CloseHandle, GetLastError, HANDLE, ERROR_ALREADY_EXISTS},
    System::Threading::CreateMutexW,
    UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE},
}};

pub(crate) struct InstanceGuard(HANDLE);

impl Drop for InstanceGuard {
    fn drop(&mut self) { let _ = unsafe { CloseHandle(self.0) }; }
}

pub(crate) fn acquire() -> Result<Option<InstanceGuard>, String> {
    let handle = unsafe { CreateMutexW(None, false, w!("Local\\AITranslate.Desktop.Instance")) }
        .map_err(|error| format!("无法检查运行实例：{error}"))?;
    let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let guard = InstanceGuard(handle);
    if exists {
        if let Ok(window) = unsafe { FindWindowW(None, w!("AI Translate")) } {
            unsafe { let _ = ShowWindow(window, SW_RESTORE); let _ = SetForegroundWindow(window); }
        }
        return Ok(None);
    }
    Ok(Some(guard))
}
