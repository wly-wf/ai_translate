use std::{
    env,
    ffi::{OsStr, OsString},
    io::{Read, Write},
    mem::size_of,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use windows::{
    core::Error,
    Win32::{
        Foundation::{HGLOBAL, POINT},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
            },
            DataExchange::{
                CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
                GetClipboardSequenceNumber, OpenClipboard,
            },
            Memory::{GlobalLock, GlobalSize, GlobalUnlock},
            Ole::{
                OleFlushClipboard, OleGetClipboard, OleInitialize, OleSetClipboard,
                OleUninitialize, CF_UNICODETEXT,
            },
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
                UIA_CONTROLTYPE_ID, UIA_CustomControlTypeId,
                UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_GroupControlTypeId,
                UIA_PaneControlTypeId, UIA_TextControlTypeId, UIA_TextPatternId,
            },
            Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL},
            WindowsAndMessaging::{GetAncestor, GetClassNameW, WindowFromPoint, GA_ROOT},
        },
    },
};

use crate::selection_state::Anchor;

const MAX_SELECTION_CHARACTERS: usize = 12_000;
const MAX_SELECTION_RANGES: i32 = 32;
const CAPTURE_HELPER_ARGUMENT: &str = "--selection-capture-helper";
const CAPTURE_HELPER_TIMEOUT: Duration = Duration::from_secs(2);
const CAPTURE_HELPER_POLL_DELAY: Duration = Duration::from_millis(10);
const CAPTURE_HELPER_STREAM_LIMIT: usize = 128 * 1024;
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum CaptureHelperOutcome {
    Detected { text: String, x: i32, y: i32 },
    Empty,
    TooLong { characters: usize },
    Failed { error: String },
}

impl From<CaptureOutcome> for CaptureHelperOutcome {
    fn from(outcome: CaptureOutcome) -> Self {
        match outcome {
            CaptureOutcome::Detected(captured) => Self::Detected {
                text: captured.text,
                x: captured.anchor.x,
                y: captured.anchor.y,
            },
            CaptureOutcome::Empty => Self::Empty,
            CaptureOutcome::TooLong { characters } => Self::TooLong { characters },
            CaptureOutcome::Failed(error) => Self::Failed { error },
        }
    }
}

impl From<CaptureHelperOutcome> for CaptureOutcome {
    fn from(outcome: CaptureHelperOutcome) -> Self {
        match outcome {
            CaptureHelperOutcome::Detected { text, x, y } => {
                CaptureOutcome::Detected(CapturedSelection {
                    text,
                    anchor: Anchor { x, y },
                })
            }
            CaptureHelperOutcome::Empty => CaptureOutcome::Empty,
            CaptureHelperOutcome::TooLong { characters } => {
                CaptureOutcome::TooLong { characters }
            }
            CaptureHelperOutcome::Failed { error } => CaptureOutcome::Failed(error),
        }
    }
}

impl CapturedSelection {
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

    capture_with_helper_process(point).unwrap_or_else(CaptureOutcome::Failed)
}

fn capture_selection_in_process(point: POINT) -> CaptureOutcome {
    trace_capture_phase("native-window-check");
    if native_window_is_terminal(point) {
        return CaptureOutcome::Empty;
    }

    trace_capture_phase("uia-start");
    let attempt = match capture_with_uia(point) {
        Ok(attempt) => attempt,
        Err(error) => UiaAttempt::Failed(error.to_string()),
    };
    trace_capture_phase("uia-resolved");
    resolve_uia_attempt(attempt, || copy_fallback(point))
}

pub fn run_capture_helper_if_requested() -> bool {
    let mut arguments = env::args_os().skip(1);
    if arguments.next().as_deref() != Some(OsStr::new(CAPTURE_HELPER_ARGUMENT)) {
        return false;
    }

    let outcome = helper_point_from_arguments(&mut arguments)
        .map(capture_selection_in_process)
        .unwrap_or_else(CaptureOutcome::Failed);
    let response = CaptureHelperOutcome::from(outcome);
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    if let Err(error) = serde_json::to_writer(&mut output, &response) {
        eprintln!("selection-helper phase=serialize-error error={error}");
    }
    let _ = output.flush();
    true
}

fn helper_point_from_arguments(
    arguments: &mut impl Iterator<Item = OsString>,
) -> Result<POINT, String> {
    let parse_coordinate = |value: Option<OsString>, name: &str| {
        value
            .and_then(|value| value.into_string().ok())
            .ok_or_else(|| format!("missing {name} coordinate"))?
            .parse::<i32>()
            .map_err(|error| format!("invalid {name} coordinate: {error}"))
    };
    let x = parse_coordinate(arguments.next(), "x")?;
    let y = parse_coordinate(arguments.next(), "y")?;
    Ok(POINT { x, y })
}

fn capture_with_helper_process(point: POINT) -> Result<CaptureOutcome, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("could not locate selection helper executable: {error}"))?;
    let mut child = Command::new(executable)
        .arg(CAPTURE_HELPER_ARGUMENT)
        .arg(point.x.to_string())
        .arg(point.y.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start selection helper: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "selection helper stdout was unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "selection helper stderr was unavailable".to_string())?;
    let stdout_reader = thread::spawn(move || read_limited_stream(stdout));
    let stderr_reader = thread::spawn(move || read_limited_stream(stderr));
    let started = Instant::now();

    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("could not poll selection helper: {error}"))?
        {
            break status;
        }
        if started.elapsed() >= CAPTURE_HELPER_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let stderr = join_capture_stream(stderr_reader)?;
            return Err(format_helper_failure(
                "selection helper timed out after 2 seconds",
                &stderr,
            ));
        }
        thread::sleep(CAPTURE_HELPER_POLL_DELAY);
    };

    let stdout = join_capture_stream(stdout_reader)?;
    let stderr = join_capture_stream(stderr_reader)?;
    if !status.success() {
        return Err(format_helper_failure(
            &format!("selection helper exited unexpectedly ({status})"),
            &stderr,
        ));
    }
    let response: CaptureHelperOutcome = serde_json::from_slice(&stdout).map_err(|error| {
        format_helper_failure(
            &format!("selection helper returned invalid data: {error}"),
            &stderr,
        )
    })?;
    Ok(response.into())
}

fn read_limited_stream(mut stream: impl Read) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 4096];
    let mut exceeded_limit = false;
    loop {
        let count = stream
            .read(&mut buffer)
            .map_err(|error| format!("could not read selection helper output: {error}"))?;
        if count == 0 {
            break;
        }
        let remaining = CAPTURE_HELPER_STREAM_LIMIT.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..count.min(remaining)]);
        exceeded_limit |= count > remaining;
    }
    if exceeded_limit {
        Err("selection helper output exceeded the safety limit".to_string())
    } else {
        Ok(output)
    }
}

fn join_capture_stream(
    reader: thread::JoinHandle<Result<Vec<u8>, String>>,
) -> Result<Vec<u8>, String> {
    reader
        .join()
        .map_err(|_| "selection helper output reader panicked".to_string())?
}

fn format_helper_failure(message: &str, stderr: &[u8]) -> String {
    let diagnostic = String::from_utf8_lossy(stderr);
    let diagnostic = diagnostic.trim();
    if diagnostic.is_empty() {
        message.to_string()
    } else {
        format!("{message}; diagnostic: {diagnostic}")
    }
}

fn trace_capture_phase(phase: &str) {
    eprintln!("selection-helper phase={phase}");
}

fn capture_with_uia(point: POINT) -> Result<UiaAttempt, CaptureError> {
    trace_capture_phase("uia-initialize-mta");
    let _apartment = ComApartment::initialize()?;
    trace_capture_phase("uia-create-automation");
    let automation: IUIAutomation = unsafe {
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?
    };
    trace_capture_phase("uia-element-from-point");
    let element = unsafe { automation.ElementFromPoint(point)? };
    trace_capture_phase("uia-terminal-ancestors");
    if element_is_terminal_surface(&automation, &element) {
        return Ok(UiaAttempt::Ignored);
    }
    trace_capture_phase("uia-text-pattern");
    let text_pattern: IUIAutomationTextPattern = match unsafe {
        element.GetCurrentPatternAs(UIA_TextPatternId)
    } {
        Ok(pattern) => pattern,
        Err(_) => return Ok(UiaAttempt::Unavailable),
    };

    trace_capture_phase("uia-get-selection");
    let ranges = unsafe { text_pattern.GetSelection()? };
    let range_count = unsafe { ranges.Length()? };
    if range_count > MAX_SELECTION_RANGES {
        return Ok(UiaAttempt::Unavailable);
    }
    let mut text = String::new();

    for index in 0..range_count {
        trace_capture_phase("uia-get-selected-range");
        let range = unsafe { ranges.GetElement(index)? };
        let remaining = MAX_SELECTION_CHARACTERS
            .saturating_add(1)
            .saturating_sub(text.chars().count())
            .max(1);
        trace_capture_phase("uia-get-bounded-text");
        text.push_str(&unsafe { range.GetText(remaining as i32)? }.to_string());
        if let TextClassification::TooLong(characters) = classify_text(&text) {
            return Ok(UiaAttempt::Outcome(CaptureOutcome::TooLong { characters }));
        }
    }

    trace_capture_phase("uia-complete");
    Ok(UiaAttempt::Outcome(CapturedSelection::from_text_at_point(text, point)))
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
        let control_type = unsafe { current.CurrentControlType() }.unwrap_or_default();

        if is_terminal_accessibility_node(&name, &automation_id, &class_name, control_type) {
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
    control_type: UIA_CONTROLTYPE_ID,
) -> bool {
    let name = name.trim().to_lowercase();
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
        || name == "终端输入"
        || name.starts_with("terminal ")
        || name.starts_with("terminal:")
        || name.starts_with("终端 ")
        || name.starts_with("终端:");
    let terminal_container = [
        UIA_PaneControlTypeId,
        UIA_GroupControlTypeId,
        UIA_DocumentControlTypeId,
        UIA_CustomControlTypeId,
        UIA_EditControlTypeId,
        UIA_TextControlTypeId,
    ]
    .contains(&control_type);

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

fn copy_fallback(point: POINT) -> CaptureOutcome {
    trace_capture_phase("clipboard-initialize-ole");
    let Ok(_apartment) = OleApartment::initialize() else {
        return CaptureOutcome::Failed(
            "could not initialize OLE for clipboard fallback".to_string(),
        );
    };
    trace_capture_phase("clipboard-snapshot");
    let original_clipboard = match snapshot_clipboard() {
        Ok(snapshot) => snapshot,
        Err(error) => return CaptureOutcome::Failed(error),
    };
    let before_sequence = unsafe { GetClipboardSequenceNumber() };
    trace_capture_phase("clipboard-send-copy");
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

        trace_capture_phase("clipboard-read-copy");
        let copied_text = read_plain_text();
        // Clipboard listeners and the source application can briefly reopen the
        // clipboard after Ctrl+C. Let that activity settle before restoring the
        // user's original data object, then verify that no newer copy replaced it.
        thread::sleep(CLIPBOARD_RESTORE_SETTLE_DELAY);
        trace_capture_phase("clipboard-restore");
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
        // Microsoft requires desktop-wide UI Automation clients to use a
        // windowless MTA worker. An STA without a message pump can re-enter
        // accessibility providers unpredictably and exhaust the thread stack.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
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
            CapturedSelection::from_text_at_point("  ".into(), POINT { x: 1, y: 2 }),
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
            UIA_CustomControlTypeId
        ));
        assert!(is_terminal_accessibility_node(
            "Terminal 1, PowerShell",
            "",
            "",
            UIA_PaneControlTypeId
        ));
        assert!(is_terminal_accessibility_node(
            "Terminal input",
            "",
            "textarea",
            UIA_EditControlTypeId
        ));
        assert!(is_terminal_accessibility_node(
            "终端输入",
            "",
            "textarea",
            UIA_EditControlTypeId
        ));
    }

    #[test]
    fn ordinary_editor_named_after_terminal_is_not_excluded() {
        assert!(!is_terminal_accessibility_node(
            "terminal.rs",
            "editor",
            "monaco-editor",
            UIA_DocumentControlTypeId
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
        let outcome = CapturedSelection::from_text_at_point(
            "selected".into(),
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
    fn capture_helper_protocol_round_trips_detected_text() {
        let outcome = CaptureOutcome::Detected(CapturedSelection {
            text: "helper text".into(),
            anchor: Anchor { x: 15, y: 25 },
        });
        let json = serde_json::to_vec(&CaptureHelperOutcome::from(outcome.clone())).unwrap();
        let decoded: CaptureHelperOutcome = serde_json::from_slice(&json).unwrap();

        assert_eq!(CaptureOutcome::from(decoded), outcome);
    }

    #[test]
    fn capture_helper_coordinates_are_validated() {
        let mut valid = [OsString::from("15"), OsString::from("-25")].into_iter();
        assert_eq!(helper_point_from_arguments(&mut valid), Ok(POINT { x: 15, y: -25 }));

        let mut invalid = [OsString::from("x"), OsString::from("25")].into_iter();
        assert!(helper_point_from_arguments(&mut invalid).is_err());
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
