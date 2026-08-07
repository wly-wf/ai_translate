use std::{
    mem::size_of,
    ptr::null_mut,
    thread,
    time::Duration,
};

use windows::{
    core::Error,
    Win32::{
        Foundation::{HGLOBAL, POINT, RECT},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            DataExchange::{
                CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
                GetClipboardSequenceNumber, OpenClipboard,
            },
            Memory::{GlobalLock, GlobalSize, GlobalUnlock},
            Ole::{
                OleFlushClipboard, OleGetClipboard, OleInitialize, OleSetClipboard,
                OleUninitialize,
                SafeArrayDestroy, CF_UNICODETEXT,
            },
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
                IUIAutomationTextRange, UIA_TextPatternId,
            },
            Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL},
            WindowsAndMessaging::{GetAncestor, GetClassNameW, WindowFromPoint, GA_ROOT},
        },
    },
};

use crate::selection_state::Anchor;

const MAX_SELECTION_CHARACTERS: usize = 12_000;
const CLIPBOARD_RETRIES: usize = 8;
const CLIPBOARD_RETRY_DELAY: Duration = Duration::from_millis(15);
const CLIPBOARD_RESTORE_RETRIES: usize = 8;
const CLIPBOARD_RESTORE_RETRY_DELAY: Duration = Duration::from_millis(20);
const CLIPBOARD_RESTORE_SETTLE_DELAY: Duration = Duration::from_millis(20);

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
    Ignored,
    Unavailable,
    Failed(String),
}

impl CapturedSelection {
    fn from_parts(text: String, rectangles: Vec<RECT>, point: POINT) -> CaptureOutcome {
        match classify_text(&text) {
            TextClassification::Empty => return CaptureOutcome::Empty,
            TextClassification::TooLong(characters) => {
                return CaptureOutcome::TooLong { characters };
            }
            TextClassification::Usable => {}
        }

        if !rectangles.iter().any(is_visible_rectangle) {
            return CaptureOutcome::Empty;
        }
        CaptureOutcome::Detected(Self {
            text,
            anchor: Anchor { x: point.x, y: point.y },
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
    if native_window_is_terminal(point) {
        return CaptureOutcome::Empty;
    }

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
    if element_is_terminal_surface(&automation, &element) {
        return Ok(UiaAttempt::Ignored);
    }
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

    Ok(UiaAttempt::Outcome(CapturedSelection::from_parts(
        text, rectangles, point,
    )))
}

fn native_window_is_terminal(point: POINT) -> bool {
    let hit_window = unsafe { WindowFromPoint(point) };
    if hit_window.is_invalid() {
        return false;
    }

    let root_window = unsafe { GetAncestor(hit_window, GA_ROOT) };
    [hit_window, root_window]
        .into_iter()
        .filter(|window| !window.is_invalid())
        .filter_map(window_class_name)
        .any(|class_name| is_native_terminal_class(&class_name))
}

fn window_class_name(window: windows::Win32::Foundation::HWND) -> Option<String> {
    let mut buffer = [0_u16; 256];
    let length = unsafe { GetClassNameW(window, &mut buffer) };
    (length > 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
}

fn is_native_terminal_class(class_name: &str) -> bool {
    let class_name = class_name.trim().to_ascii_lowercase();
    matches!(
        class_name.as_str(),
        "consolewindowclass"
            | "cascadia_hosting_window_class"
            | "pseudoconsolewindow"
            | "virtualconsoleclass"
            | "conemumain"
            | "mintty"
            | "putty"
            | "alacritty"
            | "org.wezfurlong.wezterm"
            | "wezterm"
    )
}

fn element_is_terminal_surface(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
) -> bool {
    let Ok(walker) = (unsafe { automation.RawViewWalker() }) else {
        return false;
    };
    let mut current = element.clone();

    // Chromium apps expose their DOM accessibility nodes through UIA. Walking
    // ancestors distinguishes VS Code's integrated terminal from its editor.
    for _ in 0..16 {
        let name = unsafe { current.CurrentName() }
            .map(|value| value.to_string())
            .unwrap_or_default();
        let automation_id = unsafe { current.CurrentAutomationId() }
            .map(|value| value.to_string())
            .unwrap_or_default();
        let class_name = unsafe { current.CurrentClassName() }
            .map(|value| value.to_string())
            .unwrap_or_default();
        let control_type = unsafe { current.CurrentLocalizedControlType() }
            .map(|value| value.to_string())
            .unwrap_or_default();

        if is_terminal_accessibility_node(&name, &automation_id, &class_name, &control_type) {
            return true;
        }

        let Ok(parent) = (unsafe { walker.GetParentElement(&current) }) else {
            break;
        };
        current = parent;
    }

    false
}

fn is_terminal_accessibility_node(
    name: &str,
    automation_id: &str,
    class_name: &str,
    control_type: &str,
) -> bool {
    let name = name.trim().to_lowercase();
    let control_type = control_type.trim().to_lowercase();
    let structural = format!("{automation_id} {class_name}").to_lowercase();

    if [
        "xterm",
        "terminal-wrapper",
        "terminal-xterm",
        "integrated-terminal",
        "terminal-editor",
        "terminal-view",
    ]
    .iter()
    .any(|marker| structural.contains(marker))
    {
        return true;
    }

    let terminal_name = name == "terminal"
        || name == "终端"
        || name.starts_with("terminal ")
        || name.starts_with("terminal:")
        || name.starts_with("终端 ")
        || name.starts_with("终端:");
    let terminal_container = [
        "pane", "group", "document", "custom", "edit", "text", "窗格", "组", "文档", "编辑",
        "文本",
    ]
    .iter()
    .any(|kind| control_type.contains(kind));

    terminal_name && terminal_container
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
        UiaAttempt::Ignored => CaptureOutcome::Empty,
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
    let Ok(_apartment) = OleApartment::initialize() else {
        return CaptureOutcome::Failed(
            "could not initialize OLE for clipboard fallback".to_string(),
        );
    };
    let original_clipboard = match snapshot_clipboard() {
        Ok(snapshot) => snapshot,
        Err(error) => return CaptureOutcome::Failed(error),
    };
    let before_sequence = unsafe { GetClipboardSequenceNumber() };
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
        // Clipboard listeners and the source application can briefly reopen the
        // clipboard after Ctrl+C. Let that activity settle before restoring the
        // user's original data object, then verify that no newer copy replaced it.
        thread::sleep(CLIPBOARD_RESTORE_SETTLE_DELAY);
        match restore_clipboard_if_unchanged(copied_sequence, &original_clipboard) {
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

struct OleApartment;

impl OleApartment {
    fn initialize() -> Result<Self, CaptureError> {
        unsafe { OleInitialize(None)? };
        Ok(Self)
    }
}

impl Drop for OleApartment {
    fn drop(&mut self) {
        unsafe { OleUninitialize() };
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

enum ClipboardSnapshot {
    DataObject(windows::Win32::System::Com::IDataObject),
    Empty,
}

fn snapshot_clipboard() -> Result<ClipboardSnapshot, String> {
    if let Ok(data_object) = unsafe { OleGetClipboard() } {
        return Ok(ClipboardSnapshot::DataObject(data_object));
    }

    let _clipboard = ClipboardGuard::open()
        .ok_or_else(|| "could not snapshot the clipboard for fallback".to_string())?;
    let has_formats = unsafe { EnumClipboardFormats(0) } != 0;
    if has_formats {
        return Err("could not snapshot the clipboard for fallback".to_string());
    }
    Ok(ClipboardSnapshot::Empty)
}

fn should_restore_clipboard(expected_sequence: u32, observed_sequence: u32) -> bool {
    expected_sequence == observed_sequence
}

fn retry_clipboard_operation(
    delay: Duration,
    mut operation: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let mut last_error = None;
    for attempt in 0..CLIPBOARD_RESTORE_RETRIES {
        match operation() {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < CLIPBOARD_RESTORE_RETRIES {
            thread::sleep(delay);
        }
    }
    Err(last_error.unwrap_or_else(|| "clipboard operation failed".to_string()))
}

fn restore_clipboard_if_unchanged(
    expected_sequence: u32,
    snapshot: &ClipboardSnapshot,
) -> Result<bool, String> {
    let observed_sequence = unsafe { GetClipboardSequenceNumber() };
    if !should_restore_clipboard(expected_sequence, observed_sequence) {
        return Ok(false);
    }

    match snapshot {
        ClipboardSnapshot::DataObject(data_object) => {
            retry_clipboard_operation(CLIPBOARD_RESTORE_RETRY_DELAY, || unsafe {
                OleSetClipboard(data_object).map_err(|error| error.to_string())
            })?;
            // The capture worker uninitializes OLE after this operation. Flush
            // delayed-rendered formats so the restored clipboard remains valid.
            retry_clipboard_operation(CLIPBOARD_RESTORE_RETRY_DELAY, || unsafe {
                OleFlushClipboard().map_err(|error| error.to_string())
            })?;
        }
        ClipboardSnapshot::Empty => {
            let _clipboard = ClipboardGuard::open()
                .ok_or_else(|| "could not open the clipboard for restore".to_string())?;
            unsafe { EmptyClipboard() }.map_err(|error| error.to_string())?;
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn empty_selection_is_not_a_capture() {
        assert_eq!(
            CapturedSelection::from_parts("  ".into(), vec![], POINT { x: 1, y: 2 }),
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
    fn ignored_terminal_does_not_use_clipboard_fallback() {
        let fallback_called = Cell::new(false);
        let outcome = resolve_uia_attempt(UiaAttempt::Ignored, || {
            fallback_called.set(true);
            CaptureOutcome::Failed("fallback must not run".into())
        });

        assert!(!fallback_called.get());
        assert_eq!(outcome, CaptureOutcome::Empty);
    }

    #[test]
    fn recognizes_native_terminal_window_classes() {
        for class_name in [
            "ConsoleWindowClass",
            "CASCADIA_HOSTING_WINDOW_CLASS",
            "mintty",
            "org.wezfurlong.wezterm",
        ] {
            assert!(is_native_terminal_class(class_name), "{class_name}");
        }
        assert!(!is_native_terminal_class("Chrome_WidgetWin_1"));
    }

    #[test]
    fn recognizes_integrated_terminal_accessibility_markers() {
        assert!(is_terminal_accessibility_node(
            "",
            "terminal-wrapper",
            "xterm-screen",
            "custom"
        ));
        assert!(is_terminal_accessibility_node(
            "Terminal 1, PowerShell",
            "",
            "",
            "pane"
        ));
        assert!(is_terminal_accessibility_node("终端", "", "", "窗格"));
    }

    #[test]
    fn ordinary_editor_named_after_terminal_is_not_excluded() {
        assert!(!is_terminal_accessibility_node(
            "terminal.rs",
            "editor",
            "monaco-editor",
            "document"
        ));
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
    fn mouse_release_point_sets_the_anchor() {
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
            POINT { x: 25, y: 35 },
        );

        assert_eq!(
            outcome,
            CaptureOutcome::Detected(CapturedSelection {
                text: "selected".into(),
                anchor: Anchor { x: 25, y: 35 },
            })
        );
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

    #[test]
    fn transient_clipboard_failures_are_retried() {
        let attempts = Cell::new(0);
        let result = retry_clipboard_operation(Duration::ZERO, || {
            let attempt = attempts.get() + 1;
            attempts.set(attempt);
            if attempt < 3 {
                Err("clipboard busy".to_string())
            } else {
                Ok(())
            }
        });

        assert_eq!(result, Ok(()));
        assert_eq!(attempts.get(), 3);
    }
}
