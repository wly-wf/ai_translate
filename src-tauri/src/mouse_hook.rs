use std::{
    sync::{mpsc, Arc, OnceLock},
    thread,
    time::Duration,
};

use windows::{
    core::Error,
    Win32::{
        Foundation::{LPARAM, LRESULT, POINT, WPARAM},
        UI::WindowsAndMessaging::{
            CallNextHookEx, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
            MSLLHOOKSTRUCT, MSG, WH_MOUSE_LL, WM_LBUTTONUP,
        },
    },
};

type MouseUpCallback = dyn Fn(POINT) + Send + Sync + 'static;

static CALLBACK: OnceLock<Arc<MouseUpCallback>> = OnceLock::new();

#[derive(Debug)]
pub enum HookError {
    Windows(Error),
    AlreadyStarted,
    StartupChannelClosed,
}

impl From<Error> for HookError {
    fn from(error: Error) -> Self {
        Self::Windows(error)
    }
}

impl std::fmt::Display for HookError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Windows(error) => error.fmt(formatter),
            Self::AlreadyStarted => formatter.write_str("mouse hook has already started"),
            Self::StartupChannelClosed => formatter.write_str("mouse hook thread ended before startup"),
        }
    }
}

impl std::error::Error for HookError {}

pub fn start_mouse_hook(
    on_mouse_up: impl Fn(POINT) + Send + Sync + 'static,
) -> Result<(), HookError> {
    let callback = Arc::new(on_mouse_up);
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);

    thread::Builder::new()
        .name("selection-mouse-hook".into())
        .spawn(move || {
            if CALLBACK.set(callback).is_err() {
                let _ = ready_sender.send(Err(HookError::AlreadyStarted));
                return;
            }

            let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0) };
            match hook {
                Ok(hook) => {
                    let _ = ready_sender.send(Ok(()));
                    let mut message = MSG::default();
                    while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {}
                    let _ = unsafe { UnhookWindowsHookEx(hook) };
                }
                Err(error) => {
                    let _ = ready_sender.send(Err(error.into()));
                }
            }
        })
        .map_err(|_| HookError::StartupChannelClosed)?;

    ready_receiver.recv().map_err(|_| HookError::StartupChannelClosed)?
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && wparam.0 as u32 == WM_LBUTTONUP && lparam.0 != 0 {
        let point = unsafe { (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt };
        if let Some(callback) = CALLBACK.get() {
            let callback = Arc::clone(callback);
            tauri::async_runtime::spawn(async move {
                thread::sleep(Duration::from_millis(120));
                callback(point);
            });
        }
    }

    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
