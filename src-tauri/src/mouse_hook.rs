use std::{
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
};

use windows::{
    core::Error,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        UI::WindowsAndMessaging::{
            CallNextHookEx, GetMessageW, GetWindowRect, IsWindowVisible, SetWindowsHookExW,
            UnhookWindowsHookEx, MSLLHOOKSTRUCT, MSG, WH_MOUSE_LL, WM_LBUTTONUP,
        },
    },
};

type MouseUpCallback = dyn Fn(POINT) + Send + Sync + 'static;
type CallbackSlot = Mutex<Option<Arc<MouseUpCallback>>>;

static CALLBACK: OnceLock<CallbackSlot> = OnceLock::new();

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

#[derive(Clone, Copy, Debug)]
pub struct MouseUpEvent {
    pub point: POINT,
    pub clicked_float: bool,
}

pub fn start_mouse_hook(
    float_window: HWND,
    on_mouse_up: impl Fn(MouseUpEvent) + Send + Sync + 'static,
) -> Result<(), HookError> {
    let float_window = float_window.0 as isize;
    let callback = Arc::new(move |point| {
        on_mouse_up(MouseUpEvent {
            point,
            clicked_float: clicked_float_at_event(HWND(float_window as *mut _), point),
        });
    });
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);

    thread::Builder::new()
        .name("selection-mouse-hook".into())
        .spawn(move || {
            let _callback_reservation = match reserve_callback(callback_slot(), callback) {
                Ok(reservation) => reservation,
                Err(error) => {
                    let _ = ready_sender.send(Err(error));
                    return;
                }
            };

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

fn callback_slot() -> &'static CallbackSlot {
    CALLBACK.get_or_init(|| Mutex::new(None))
}

fn clicked_float_at_event(float_window: HWND, point: POINT) -> bool {
    if !unsafe { IsWindowVisible(float_window) }.as_bool() {
        return false;
    }
    let mut rectangle = RECT::default();
    if unsafe { GetWindowRect(float_window, &mut rectangle) }.is_err() {
        return false;
    }
    point_inside_circle(point, rectangle)
}

fn point_inside_circle(point: POINT, rectangle: RECT) -> bool {
    let radius_x = (rectangle.right - rectangle.left) as i64;
    let radius_y = (rectangle.bottom - rectangle.top) as i64;
    if radius_x <= 0 || radius_y <= 0 {
        return false;
    }

    let offset_x = (point.x - rectangle.left) as i64 * 2 - radius_x;
    let offset_y = (point.y - rectangle.top) as i64 * 2 - radius_y;

    offset_x * offset_x * radius_y * radius_y + offset_y * offset_y * radius_x * radius_x
        <= radius_x * radius_x * radius_y * radius_y
}

fn reserve_callback<'a>(
    slot: &'a CallbackSlot,
    callback: Arc<MouseUpCallback>,
) -> Result<CallbackReservation<'a>, HookError> {
    let mut stored_callback = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if stored_callback.is_some() {
        return Err(HookError::AlreadyStarted);
    }
    *stored_callback = Some(callback);
    Ok(CallbackReservation { slot })
}

struct CallbackReservation<'a> {
    slot: &'a CallbackSlot,
}

impl Drop for CallbackReservation<'_> {
    fn drop(&mut self) {
        let mut stored_callback = self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *stored_callback = None;
    }
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && wparam.0 as u32 == WM_LBUTTONUP && lparam.0 != 0 {
        let point = unsafe { (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt };
        let callback = callback_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(Arc::clone);
        if let Some(callback) = callback {
            callback(point);
        }
    }

    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn callback_slot_can_retry_after_failed_startup() {
        let slot = Mutex::new(None);
        let first_callback: Arc<MouseUpCallback> = Arc::new(|_| {});

        let reservation = reserve_callback(&slot, first_callback).unwrap();
        drop(reservation);

        let second_callback: Arc<MouseUpCallback> = Arc::new(|_| {});
        assert!(reserve_callback(&slot, second_callback).is_ok());
    }

    #[test]
    fn point_hit_test_excludes_transparent_corners_of_the_float_window() {
        let rectangle = windows::Win32::Foundation::RECT {
            left: 10,
            top: 20,
            right: 34,
            bottom: 44,
        };

        assert!(point_inside_circle(POINT { x: 22, y: 32 }, rectangle));
        assert!(!point_inside_circle(POINT { x: 10, y: 20 }, rectangle));
        assert!(!point_inside_circle(POINT { x: 33, y: 43 }, rectangle));
    }
}
