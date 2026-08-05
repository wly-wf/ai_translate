use std::{
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
};

use windows::{
    core::Error,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::ScreenToClient,
        UI::WindowsAndMessaging::{
            CallNextHookEx, GetClientRect, GetMessageW, GetWindowRect, IsWindowVisible,
            SetWindowsHookExW, UnhookWindowsHookEx, WindowFromPoint, MSLLHOOKSTRUCT, MSG,
            WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP,
        },
    },
};

type MouseUpCallback = dyn Fn(RawMouseUp) + Send + Sync + 'static;
type CallbackSlot = Mutex<Option<Arc<MouseUpCallback>>>;

static CALLBACK: OnceLock<CallbackSlot> = OnceLock::new();
static BUTTON_DOWN: OnceLock<Mutex<Option<MouseDown>>> = OnceLock::new();

#[derive(Clone, Copy, Debug)]
struct RawMouseUp {
    point: POINT,
    selection_gesture: bool,
}

#[derive(Clone, Copy, Debug)]
struct MouseDown {
    point: POINT,
    started_in_client_area: bool,
}

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
    pub selection_gesture: bool,
}

pub fn start_mouse_hook(
    float_window: HWND,
    on_mouse_up: impl Fn(MouseUpEvent) + Send + Sync + 'static,
) -> Result<(), HookError> {
    let float_window = float_window.0 as isize;
    let callback = Arc::new(move |event: RawMouseUp| {
        on_mouse_up(MouseUpEvent {
            point: event.point,
            clicked_float: clicked_float_at_event(HWND(float_window as *mut _), event.point),
            selection_gesture: event.selection_gesture,
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

fn button_down_slot() -> &'static Mutex<Option<MouseDown>> {
    BUTTON_DOWN.get_or_init(|| Mutex::new(None))
}

fn remember_button_down(point: POINT) {
    *button_down_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(MouseDown {
        point,
        started_in_client_area: point_is_in_client_area(point),
    });
}

fn take_selection_gesture(point: POINT) -> bool {
    let start = button_down_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    let Some(start) = start else {
        // Preserve selection capture if a hook event was missed rather than
        // incorrectly dismissing a newly selected range.
        return true;
    };

    is_selection_gesture(start, point)
}

fn is_selection_gesture(start: MouseDown, point: POINT) -> bool {
    const DRAG_THRESHOLD: i64 = 3;
    if !start.started_in_client_area {
        return false;
    }
    let delta_x = i64::from(point.x) - i64::from(start.point.x);
    let delta_y = i64::from(point.y) - i64::from(start.point.y);
    delta_x * delta_x + delta_y * delta_y >= DRAG_THRESHOLD * DRAG_THRESHOLD
}

fn point_is_in_client_area(screen_point: POINT) -> bool {
    let window = unsafe { WindowFromPoint(screen_point) };
    if window.is_invalid() {
        return false;
    }

    let mut client_point = screen_point;
    if !unsafe { ScreenToClient(window, &mut client_point) }.as_bool() {
        return false;
    }
    let mut client = RECT::default();
    if unsafe { GetClientRect(window, &mut client) }.is_err() {
        return false;
    }
    point_is_inside_rectangle(client_point, client)
}

fn point_is_inside_rectangle(point: POINT, rectangle: RECT) -> bool {
    point.x >= rectangle.left
        && point.x < rectangle.right
        && point.y >= rectangle.top
        && point.y < rectangle.bottom
}

fn clicked_float_at_event(float_window: HWND, point: POINT) -> bool {
    if !unsafe { IsWindowVisible(float_window) }.as_bool() {
        return false;
    }
    let mut rectangle = RECT::default();
    if unsafe { GetWindowRect(float_window, &mut rectangle) }.is_err() {
        return false;
    }
    point_inside_round_rect(point, rectangle)
}

fn point_inside_round_rect(point: POINT, rectangle: RECT) -> bool {
    let width = (rectangle.right - rectangle.left) as i64;
    let height = (rectangle.bottom - rectangle.top) as i64;
    let radius = crate::FLOAT_CORNER_RADIUS as i64;
    if width <= 0 || height <= 0 {
        return false;
    }

    let x = (point.x - rectangle.left) as i64;
    let y = (point.y - rectangle.top) as i64;
    if x < 0 || x >= width || y < 0 || y >= height {
        return false;
    }

    if (x < radius || x >= width - radius) && (y < radius || y >= height - radius) {
        let center_x = if x < radius { radius } else { width - radius - 1 };
        let center_y = if y < radius { radius } else { height - radius - 1 };
        let dx = x - center_x;
        let dy = y - center_y;
        dx * dx + dy * dy <= radius * radius
    } else {
        true
    }
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
    if code >= 0 && lparam.0 != 0 {
        let point = unsafe { (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt };
        match wparam.0 as u32 {
            WM_LBUTTONDOWN => remember_button_down(point),
            WM_LBUTTONUP => {
                let callback = callback_slot()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .as_ref()
                    .map(Arc::clone);
                if let Some(callback) = callback {
                    callback(RawMouseUp {
                        point,
                        selection_gesture: take_selection_gesture(point),
                    });
                }
            }
            _ => {}
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
    fn simple_click_is_not_a_selection_gesture() {
        remember_button_down(POINT { x: 20, y: 30 });
        assert!(!take_selection_gesture(POINT { x: 22, y: 31 }));
    }

    #[test]
    fn drag_is_a_selection_gesture() {
        let start = MouseDown {
            point: POINT { x: 20, y: 30 },
            started_in_client_area: true,
        };
        assert!(is_selection_gesture(start, POINT { x: 24, y: 31 }));
    }

    #[test]
    fn title_bar_drag_is_not_a_selection_gesture() {
        let start = MouseDown {
            point: POINT { x: 20, y: 30 },
            started_in_client_area: false,
        };

        assert!(!is_selection_gesture(start, POINT { x: 80, y: 30 }));
    }

    #[test]
    fn client_area_hit_test_excludes_the_window_frame() {
        let client = RECT {
            left: 0,
            top: 0,
            right: 100,
            bottom: 50,
        };

        assert!(point_is_inside_rectangle(POINT { x: 0, y: 0 }, client));
        assert!(!point_is_inside_rectangle(POINT { x: -1, y: 20 }, client));
        assert!(!point_is_inside_rectangle(POINT { x: 100, y: 20 }, client));
    }

    #[test]
    fn point_hit_test_excludes_transparent_corners_of_the_float_window() {
        let rectangle = windows::Win32::Foundation::RECT {
            left: 10,
            top: 20,
            right: 34,
            bottom: 44,
        };

        assert!(point_inside_round_rect(POINT { x: 22, y: 32 }, rectangle));
        assert!(!point_inside_round_rect(POINT { x: 10, y: 20 }, rectangle));
        assert!(!point_inside_round_rect(POINT { x: 33, y: 43 }, rectangle));
    }
}
