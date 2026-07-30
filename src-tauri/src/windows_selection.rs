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

impl CapturedSelection {
    fn from_parts(text: String, rectangles: Vec<RECT>) -> Option<Self> {
        if !is_usable_text(&text) {
            return None;
        }

        let rectangle = rectangles.into_iter().rev().find(is_visible_rectangle)?;
        Some(Self {
            text,
            anchor: Anchor { x: rectangle.right, y: rectangle.top },
        })
    }

    fn from_text_at_point(text: String, point: POINT) -> Option<Self> {
        is_usable_text(&text).then_some(Self {
            text,
            anchor: Anchor { x: point.x, y: point.y },
        })
    }
}

pub fn capture_selection(point: POINT) -> Result<Option<CapturedSelection>, CaptureError> {
    let _apartment = ComApartment::initialize()?;
    let automation: IUIAutomation = unsafe {
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?
    };
    let element = unsafe { automation.ElementFromPoint(point)? };
    let text_pattern: IUIAutomationTextPattern = match unsafe {
        element.GetCurrentPatternAs(UIA_TextPatternId)
    } {
        Ok(pattern) => pattern,
        Err(_) => return Ok(copy_fallback(point)),
    };

    let ranges = unsafe { text_pattern.GetSelection()? };
    let mut text = String::new();
    let mut rectangles = Vec::new();

    for index in 0..unsafe { ranges.Length()? } {
        let range = unsafe { ranges.GetElement(index)? };
        text.push_str(&unsafe { range.GetText(-1)? }.to_string());
        rectangles.extend(rectangles_for_range(&automation, &range)?);
    }

    Ok(CapturedSelection::from_parts(text, rectangles))
}

fn is_usable_text(text: &str) -> bool {
    !text.trim().is_empty() && text.chars().count() <= MAX_SELECTION_CHARACTERS
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

fn copy_fallback(point: POINT) -> Option<CapturedSelection> {
    let before_sequence = unsafe { GetClipboardSequenceNumber() };
    let original_text = read_plain_text();
    if !send_copy_shortcut() {
        return None;
    }

    for _ in 0..CLIPBOARD_RETRIES {
        thread::sleep(CLIPBOARD_RETRY_DELAY);
        let copied_sequence = unsafe { GetClipboardSequenceNumber() };
        if copied_sequence == before_sequence {
            continue;
        }

        let copied_text = read_plain_text();
        if unsafe { GetClipboardSequenceNumber() } == copied_sequence {
            if let Some(original_text) = original_text.as_deref() {
                let _ = write_plain_text(original_text);
            }
        }
        return copied_text.and_then(|text| CapturedSelection::from_text_at_point(text, point));
    }

    None
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

fn write_plain_text(text: &str) -> Option<()> {
    let _clipboard = ClipboardGuard::open()?;
    unsafe { EmptyClipboard().ok()? };

    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide.len().checked_mul(size_of::<u16>())?;
    let global = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes).ok()? };
    let data = unsafe { GlobalLock(global) }.cast::<u16>();
    if data.is_null() {
        let _ = unsafe { GlobalFree(global) };
        return None;
    }
    unsafe { copy_nonoverlapping(wide.as_ptr(), data, wide.len()) };
    let _ = unsafe { GlobalUnlock(global) };

    if unsafe { SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(global.0))).is_err() } {
        let _ = unsafe { GlobalFree(global) };
        return None;
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_selection_is_not_a_capture() {
        assert!(CapturedSelection::from_parts("  ".into(), vec![]).is_none());
    }
}
