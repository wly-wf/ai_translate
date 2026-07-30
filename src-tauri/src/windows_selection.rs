use std::{
    mem::size_of,
    ptr::{copy_nonoverlapping, null_mut},
    thread,
    time::Duration,
};

use windows::{
    core::Error,
    Win32::{
        Foundation::{HANDLE, HGLOBAL, POINT, RECT},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            DataExchange::{
                CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
                OpenClipboard, SetClipboardData,
            },
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
            Ole::{SafeArrayDestroy, CF_UNICODETEXT},
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationTextPattern, IUIAutomationTextRange,
                UIA_TextPatternId,
            },
            Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL},
        },
    },
};

use crate::selection_state::Anchor;

const MAX_SELECTION_CHARACTERS: usize = 12_000;
const CLIPBOARD_RETRIES: usize = 8;
const CLIPBOARD_RETRY_DELAY: Duration = Duration::from_millis(15);

#[link(name = "kernel32")]
extern "system" {
    fn GlobalFree(memory: HGLOBAL) -> HGLOBAL;
}

#[derive(Debug)]
pub struct CaptureError(Error);

impl From<Error> for CaptureError {
    fn from(error: Error) -> Self {
        Self(error)
    }
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::error::Error for CaptureError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedSelection {
    pub text: String,
    pub anchor: Anchor,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureOutcome {
    Detected(CapturedSelection),
    Empty,
    TooLong { characters: usize },
    Failed(String),
}

enum UiaAttempt {
    Outcome(CaptureOutcome),
    PointOutsideSelection,
    Unavailable,
    Failed(String),
}

impl CapturedSelection {
    fn from_parts(text: String, rectangles: Vec<RECT>) -> CaptureOutcome {
        match classify_text(&text) {
            TextClassification::Empty => return CaptureOutcome::Empty,
            TextClassification::TooLong(characters) => {
                return CaptureOutcome::TooLong { characters };
            }
            TextClassification::Usable => {}
        }

        let Some(rectangle) = rectangles.into_iter().rev().find(is_visible_rectangle) else {
            return CaptureOutcome::Empty;
        };
        CaptureOutcome::Detected(Self {
            text,
            anchor: Anchor { x: rectangle.right, y: rectangle.top },
        })
    }

    fn from_text_at_point(text: String, point: POINT) -> CaptureOutcome {
        match classify_text(&text) {
            TextClassification::Empty => CaptureOutcome::Empty,
            TextClassification::TooLong(characters) => CaptureOutcome::TooLong { characters },
            TextClassification::Usable => CaptureOutcome::Detected(Self {
                text,
                anchor: Anchor { x: point.x, y: point.y },
            }),
        }
    }
}

pub fn capture_selection(point: POINT) -> CaptureOutcome {
    let attempt = match capture_with_uia(point) {
        Ok(attempt) => attempt,
        Err(error) => UiaAttempt::Failed(error.to_string()),
    };
    resolve_uia_attempt(attempt, || copy_fallback(point))
}

fn capture_with_uia(point: POINT) -> Result<UiaAttempt, CaptureError> {
    let _apartment = ComApartment::initialize()?;
    let automation: IUIAutomation = unsafe {
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?
    };
    let element = unsafe { automation.ElementFromPoint(point)? };
    let text_pattern: IUIAutomationTextPattern = match unsafe {
        element.GetCurrentPatternAs(UIA_TextPatternId)
    } {
        Ok(pattern) => pattern,
        Err(_) => return Ok(UiaAttempt::Unavailable),
    };

    let ranges = unsafe { text_pattern.GetSelection()? };
    let mut text = String::new();
    let mut rectangles = Vec::new();

    for index in 0..unsafe { ranges.Length()? } {
        let range = unsafe { ranges.GetElement(index)? };
        text.push_str(&unsafe { range.GetText(-1)? }.to_string());
        rectangles.extend(rectangles_for_range(&automation, &range)?);
    }

    let outcome = CapturedSelection::from_parts(text, rectangles.clone());
    if matches!(outcome, CaptureOutcome::Detected(_))
        && !point_is_on_selection(point, &rectangles)
    {
        // A plain click does not necessarily clear an application's previous
        // selection.  In that case UI Automation still reports the old range;
        // treating it as a new selection makes the float reappear at the click.
        return Ok(UiaAttempt::PointOutsideSelection);
    }

    Ok(UiaAttempt::Outcome(outcome))
}

enum TextClassification {
    Empty,
    Usable,
    TooLong(usize),
}

fn classify_text(text: &str) -> TextClassification {
    if text.trim().is_empty() {
        return TextClassification::Empty;
    }
    let characters = text.chars().count();
    if characters > MAX_SELECTION_CHARACTERS {
        TextClassification::TooLong(characters)
    } else {
        TextClassification::Usable
    }
}

fn resolve_uia_attempt(
    attempt: UiaAttempt,
    fallback: impl FnOnce() -> CaptureOutcome,
) -> CaptureOutcome {
    match attempt {
        UiaAttempt::Outcome(CaptureOutcome::Detected(captured)) => {
            CaptureOutcome::Detected(captured)
        }
        UiaAttempt::Outcome(CaptureOutcome::TooLong { characters }) => {
            CaptureOutcome::TooLong { characters }
        }
        UiaAttempt::Outcome(CaptureOutcome::Failed(error)) => CaptureOutcome::Failed(error),
        UiaAttempt::PointOutsideSelection => CaptureOutcome::Empty,
        UiaAttempt::Outcome(CaptureOutcome::Empty) | UiaAttempt::Unavailable => fallback(),
        UiaAttempt::Failed(uia_error) => match fallback() {
            CaptureOutcome::Empty => CaptureOutcome::Failed(format!(
                "UI Automation failed ({uia_error}); clipboard fallback found no selection"
            )),
            CaptureOutcome::Failed(fallback_error) => CaptureOutcome::Failed(format!(
                "UI Automation failed ({uia_error}); clipboard fallback failed ({fallback_error})"
            )),
            outcome => outcome,
        },
    }
}

fn point_is_on_selection(point: POINT, rectangles: &[RECT]) -> bool {
    // UI Automation rounds selection rectangles while the low-level mouse hook
    // reports physical pixels, so permit a small edge tolerance.
    const EDGE_TOLERANCE: i32 = 3;

    rectangles.iter().filter(|rectangle| is_visible_rectangle(rectangle)).any(|rectangle| {
        point.x >= rectangle.left.saturating_sub(EDGE_TOLERANCE)
            && point.x <= rectangle.right.saturating_add(EDGE_TOLERANCE)
            && point.y >= rectangle.top.saturating_sub(EDGE_TOLERANCE)
            && point.y <= rectangle.bottom.saturating_add(EDGE_TOLERANCE)
    })
}

fn is_visible_rectangle(rectangle: &RECT) -> bool {
    rectangle.right > rectangle.left && rectangle.bottom > rectangle.top
}

fn rectangles_for_range(
    automation: &IUIAutomation,
    range: &IUIAutomationTextRange,
) -> Result<Vec<RECT>, CaptureError> {
    let safe_array = unsafe { range.GetBoundingRectangles()? };
    if safe_array.is_null() {
        return Ok(Vec::new());
    }

    let mut native_rectangles = null_mut();
    let count = unsafe { automation.SafeArrayToRectNativeArray(safe_array, &mut native_rectangles) };
    unsafe { SafeArrayDestroy(safe_array)? };
    let count = count?;
    if count <= 0 || native_rectangles.is_null() {
        return Ok(Vec::new());
    }

    let rectangles = unsafe {
        std::slice::from_raw_parts(native_rectangles, count as usize).to_vec()
    };
    unsafe { CoTaskMemFree(Some(native_rectangles.cast())) };
    Ok(rectangles)
}

fn copy_fallback(point: POINT) -> CaptureOutcome {
    let before_sequence = unsafe { GetClipboardSequenceNumber() };
    let original_text = read_plain_text();
    if !send_copy_shortcut() {
        return CaptureOutcome::Failed(
            "could not send Ctrl+C for clipboard fallback".to_string(),
        );
    }

    for _ in 0..CLIPBOARD_RETRIES {
        thread::sleep(CLIPBOARD_RETRY_DELAY);
        let copied_sequence = unsafe { GetClipboardSequenceNumber() };
        if copied_sequence == before_sequence {
            continue;
        }

        let copied_text = read_plain_text();
        if let Some(original_text) = original_text.as_deref() {
            match restore_plain_text_if_unchanged(copied_sequence, original_text) {
                Ok(true) => {}
                Ok(false) => {
                    eprintln!(
                        "Selection clipboard restore skipped because the clipboard changed."
                    );
                }
                Err(error) => {
                    eprintln!("Selection clipboard restore failed: {error}");
                }
            }
        }
        return copied_text
            .map(|text| CapturedSelection::from_text_at_point(text, point))
            .unwrap_or(CaptureOutcome::Empty);
    }

    CaptureOutcome::Empty
}

fn send_copy_shortcut() -> bool {
    let inputs = [
        keyboard_input(VK_CONTROL.0 as u16, windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0)),
        keyboard_input(b'C' as u16, windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0)),
        keyboard_input(b'C' as u16, KEYEVENTF_KEYUP),
        keyboard_input(VK_CONTROL.0 as u16, KEYEVENTF_KEYUP),
    ];
    unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) == inputs.len() as u32 }
}

fn keyboard_input(virtual_key: u16, flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(virtual_key), dwFlags: flags, ..Default::default() },
        },
    }
}

struct ComApartment;

impl ComApartment {
    fn initialize() -> Result<Self, CaptureError> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct ClipboardGuard;

impl ClipboardGuard {
    fn open() -> Option<Self> {
        unsafe { OpenClipboard(None).ok()? };
        Some(Self)
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

fn read_plain_text() -> Option<String> {
    let _clipboard = ClipboardGuard::open()?;
    let handle = unsafe { GetClipboardData(CF_UNICODETEXT.0 as u32).ok()? };
    let global = HGLOBAL(handle.0);
    let bytes = unsafe { GlobalSize(global) };
    if bytes < size_of::<u16>() {
        return None;
    }

    let data = unsafe { GlobalLock(global) }.cast::<u16>();
    if data.is_null() {
        return None;
    }
    let characters = unsafe { std::slice::from_raw_parts(data, bytes / size_of::<u16>()) };
    let length = characters.iter().position(|character| *character == 0).unwrap_or(characters.len());
    let text = String::from_utf16(&characters[..length]).ok();
    let _ = unsafe { GlobalUnlock(global) };
    text
}

fn should_restore_clipboard(expected_sequence: u32, observed_sequence: u32) -> bool {
    expected_sequence == observed_sequence
}

fn restore_plain_text_if_unchanged(
    expected_sequence: u32,
    text: &str,
) -> Result<bool, String> {
    let _clipboard =
        ClipboardGuard::open().ok_or_else(|| "could not open the clipboard".to_string())?;
    let observed_sequence = unsafe { GetClipboardSequenceNumber() };
    if !should_restore_clipboard(expected_sequence, observed_sequence) {
        return Ok(false);
    }

    write_plain_text_to_open_clipboard(text)?;
    Ok(true)
}

fn write_plain_text_to_open_clipboard(text: &str) -> Result<(), String> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide
        .len()
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| "clipboard text allocation overflowed".to_string())?;
    let global =
        unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) }.map_err(|error| error.to_string())?;
    let data = unsafe { GlobalLock(global) }.cast::<u16>();
    if data.is_null() {
        let _ = unsafe { GlobalFree(global) };
        return Err("could not lock clipboard text memory".to_string());
    }
    unsafe { copy_nonoverlapping(wide.as_ptr(), data, wide.len()) };
    let _ = unsafe { GlobalUnlock(global) };

    if let Err(error) = unsafe { EmptyClipboard() } {
        let _ = unsafe { GlobalFree(global) };
        return Err(error.to_string());
    }
    if let Err(error) =
        unsafe { SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(global.0))) }
    {
        let _ = unsafe { GlobalFree(global) };
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn empty_selection_is_not_a_capture() {
        assert_eq!(
            CapturedSelection::from_parts("  ".into(), vec![]),
            CaptureOutcome::Empty
        );
    }

    #[test]
    fn uia_empty_selection_uses_clipboard_fallback() {
        let fallback_called = Cell::new(false);
        let fallback_capture = CapturedSelection {
            text: "clipboard".into(),
            anchor: Anchor { x: 5, y: 6 },
        };

        let outcome = resolve_uia_attempt(UiaAttempt::Outcome(CaptureOutcome::Empty), || {
            fallback_called.set(true);
            CaptureOutcome::Detected(fallback_capture.clone())
        });

        assert!(fallback_called.get());
        assert_eq!(outcome, CaptureOutcome::Detected(fallback_capture));
    }

    #[test]
    fn retained_selection_away_from_the_click_does_not_use_clipboard_fallback() {
        let fallback_called = Cell::new(false);

        let outcome = resolve_uia_attempt(UiaAttempt::PointOutsideSelection, || {
            fallback_called.set(true);
            CaptureOutcome::Detected(CapturedSelection {
                text: "stale clipboard text".into(),
                anchor: Anchor { x: 5, y: 6 },
            })
        });

        assert!(!fallback_called.get());
        assert_eq!(outcome, CaptureOutcome::Empty);
    }

    #[test]
    fn uia_error_uses_clipboard_fallback() {
        let fallback_capture = CapturedSelection {
            text: "clipboard".into(),
            anchor: Anchor { x: 5, y: 6 },
        };

        let outcome = resolve_uia_attempt(UiaAttempt::Failed("UIA failed".into()), || {
            CaptureOutcome::Detected(fallback_capture.clone())
        });

        assert_eq!(outcome, CaptureOutcome::Detected(fallback_capture));
    }

    #[test]
    fn uia_error_remains_visible_when_clipboard_fallback_is_empty() {
        let outcome = resolve_uia_attempt(UiaAttempt::Failed("UIA failed".into()), || {
            CaptureOutcome::Empty
        });

        assert!(matches!(outcome, CaptureOutcome::Failed(message) if message.contains("UIA failed")));
    }

    #[test]
    fn last_visible_rectangle_sets_the_anchor() {
        let outcome = CapturedSelection::from_parts(
            "selected".into(),
            vec![
                RECT {
                    left: 1,
                    top: 2,
                    right: 11,
                    bottom: 12,
                },
                RECT {
                    left: 20,
                    top: 30,
                    right: 20,
                    bottom: 40,
                },
                RECT {
                    left: 50,
                    top: 60,
                    right: 70,
                    bottom: 80,
                },
            ],
        );

        assert_eq!(
            outcome,
            CaptureOutcome::Detected(CapturedSelection {
                text: "selected".into(),
                anchor: Anchor { x: 70, y: 60 },
            })
        );
    }

    #[test]
    fn point_hit_test_accepts_the_selection_and_rejects_a_nearby_click() {
        let rectangles = [RECT {
            left: 20,
            top: 30,
            right: 60,
            bottom: 50,
        }];

        assert!(point_is_on_selection(POINT { x: 63, y: 53 }, &rectangles));
        assert!(!point_is_on_selection(POINT { x: 64, y: 54 }, &rectangles));
    }

    #[test]
    fn capture_classifies_the_character_limit_boundary() {
        assert!(matches!(
            CapturedSelection::from_text_at_point(
                "x".repeat(12_000),
                POINT { x: 1, y: 2 },
            ),
            CaptureOutcome::Detected(_)
        ));
        assert_eq!(
            CapturedSelection::from_text_at_point(
                "x".repeat(12_001),
                POINT { x: 1, y: 2 },
            ),
            CaptureOutcome::TooLong { characters: 12_001 }
        );
    }

    #[test]
    fn clipboard_restore_is_skipped_after_an_external_change() {
        assert!(should_restore_clipboard(41, 41));
        assert!(!should_restore_clipboard(41, 42));
    }
}
