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
    core::{w, Error},
    Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, POINT, RECT},
        Graphics::Gdi::{
            DeleteEnhMetaFile, DeleteMetaFile, DeleteObject, HENHMETAFILE, HGDIOBJ,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_MULTITHREADED,
            },
            DataExchange::{
                CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
                GetClipboardSequenceNumber, OpenClipboard, SetClipboardData, METAFILEPICT,
            },
            Memory::{GlobalLock, GlobalSize, GlobalUnlock, GLOBAL_ALLOC_FLAGS},
            Ole::{
                OleDuplicateData, CF_BITMAP, CF_DSPBITMAP, CF_DSPENHMETAFILE,
                CF_DSPMETAFILEPICT, CF_ENHMETAFILE, CF_GDIOBJFIRST, CF_GDIOBJLAST,
                CF_METAFILEPICT, CF_OWNERDISPLAY, CF_PALETTE, CF_PRIVATEFIRST,
                CF_PRIVATELAST, CF_UNICODETEXT, CLIPBOARD_FORMAT, SafeArrayAccessData,
                SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound,
                SafeArrayUnaccessData,
            },
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
                IUIAutomationTextRange, TextPatternRangeEndpoint_End,
                TextPatternRangeEndpoint_Start, UIA_CONTROLTYPE_ID, UIA_CustomControlTypeId,
                UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_GroupControlTypeId,
                UIA_ImageControlTypeId, UIA_PaneControlTypeId, UIA_TextControlTypeId,
                UIA_TextPatternId,
            },
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
                VK_CONTROL,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, GetAncestor, GetClassNameW,
                GetForegroundWindow, WindowFromPoint, GA_ROOT, GA_ROOTOWNER, HWND_MESSAGE,
                WINDOW_EX_STYLE, WINDOW_STYLE,
            },
        },
    },
};

use crate::selection_state::{Anchor, MAX_SELECTION_CHARACTERS};

const MAX_SELECTION_RANGES: i32 = 32;
const CAPTURE_HELPER_ARGUMENT: &str = "--selection-capture-helper";
const CAPTURE_HELPER_TIMEOUT: Duration = Duration::from_secs(2);
const CAPTURE_HELPER_POLL_DELAY: Duration = Duration::from_millis(10);
const CAPTURE_FAILURE_RETRY_DELAY: Duration = Duration::from_millis(40);
const CAPTURE_HELPER_STREAM_LIMIT: usize = 128 * 1024;
const MAX_UIA_ANCESTORS: usize = 16;
const SELECTION_START_TOLERANCE: i32 = 16;
const SELECTION_END_TOLERANCE: i32 = 96;
const CLIPBOARD_RETRIES: usize = 20;
const CLIPBOARD_RETRY_DELAY: Duration = Duration::from_millis(20);
const MAX_CLIPBOARD_FORMATS: usize = 128;
// A 4K bitmap can exceed 31 MiB and Windows may expose it in several formats.
const MAX_CLIPBOARD_SNAPSHOT_BYTES: usize = 128 * 1024 * 1024;
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
    NoTextSurface,
    PointMismatch,
    Unavailable,
    SelectionFailed(String),
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

pub fn capture_selection(point: POINT, start_point: POINT) -> CaptureOutcome {
    if native_window_is_terminal(point) {
        return CaptureOutcome::Empty;
    }

    #[cfg(debug_assertions)]
    let started = Instant::now();
    let outcome = match capture_with_helper_process(point, start_point) {
        Ok(first) => retry_failed_capture(first, || {
            thread::sleep(CAPTURE_FAILURE_RETRY_DELAY);
            capture_with_helper_process(point, start_point).unwrap_or_else(CaptureOutcome::Failed)
        }),
        Err(error) => CaptureOutcome::Failed(error),
    };
    #[cfg(debug_assertions)]
    eprintln!("selection-capture outcome={} elapsed_ms={}", capture_outcome_name(&outcome), started.elapsed().as_millis());
    outcome
}

#[cfg(debug_assertions)]
fn capture_outcome_name(outcome: &CaptureOutcome) -> &'static str {
    match outcome {
        CaptureOutcome::Detected(_) => "detected",
        CaptureOutcome::Empty => "empty",
        CaptureOutcome::TooLong { .. } => "too-long",
        CaptureOutcome::Failed(_) => "failed",
    }
}

fn retryable_capture_failure(error: &str) -> bool {
    !error.starts_with("clipboard snapshot exceeds the ")
        && !error.starts_with("clipboard contains too many formats")
        && !error.contains(" cannot be snapshotted safely")
        && !error.contains(" is not backed by global memory")
}

fn retry_failed_capture(
    first: CaptureOutcome,
    retry: impl FnOnce() -> CaptureOutcome,
) -> CaptureOutcome {
    if matches!(&first, CaptureOutcome::Failed(error) if retryable_capture_failure(error)) {
        retry()
    } else {
        first
    }
}

fn capture_selection_in_process(point: POINT, start_point: POINT) -> CaptureOutcome {
    trace_capture_phase("native-window-check");
    if native_window_is_terminal(point) {
        return CaptureOutcome::Empty;
    }

    trace_capture_phase("uia-start");
    let attempt = match capture_with_uia(point, start_point) {
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

    let outcome = helper_points_from_arguments(&mut arguments)
        .map(|(point, start_point)| capture_selection_in_process(point, start_point))
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

fn helper_points_from_arguments(
    arguments: &mut impl Iterator<Item = OsString>,
) -> Result<(POINT, POINT), String> {
    let parse_coordinate = |value: Option<OsString>, name: &str| {
        value
            .and_then(|value| value.into_string().ok())
            .ok_or_else(|| format!("missing {name} coordinate"))?
            .parse::<i32>()
            .map_err(|error| format!("invalid {name} coordinate: {error}"))
    };
    let x = parse_coordinate(arguments.next(), "x")?;
    let y = parse_coordinate(arguments.next(), "y")?;
    let start_x = parse_coordinate(arguments.next(), "start x")?;
    let start_y = parse_coordinate(arguments.next(), "start y")?;
    Ok((POINT { x, y }, POINT { x: start_x, y: start_y }))
}

fn capture_with_helper_process(point: POINT, start_point: POINT) -> Result<CaptureOutcome, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("could not locate selection helper executable: {error}"))?;
    let mut child = Command::new(executable)
        .arg(CAPTURE_HELPER_ARGUMENT)
        .arg(point.x.to_string())
        .arg(point.y.to_string())
        .arg(start_point.x.to_string())
        .arg(start_point.y.to_string())
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

fn capture_with_uia(point: POINT, start_point: POINT) -> Result<UiaAttempt, CaptureError> {
    trace_capture_phase("uia-initialize-mta");
    let _apartment = ComApartment::initialize()?;
    trace_capture_phase("uia-create-automation");
    let automation: IUIAutomation = unsafe {
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?
    };
    trace_capture_phase("uia-element-from-point");
    let element = unsafe { automation.ElementFromPoint(point)? };
    if unsafe { element.CurrentControlType() }.is_ok_and(is_image_control_type) {
        trace_capture_phase("uia-image-surface-ignored");
        return Ok(UiaAttempt::Ignored);
    }
    trace_capture_phase("uia-point-element");
    let point_attempt = capture_from_uia_element(&automation, &element, point, start_point)?;
    // A pan can end outside the image. Check where it began before a missing
    // text selection is allowed to trigger Ctrl+C in the image viewer.
    if matches!(
        &point_attempt,
        UiaAttempt::NoTextSurface
            | UiaAttempt::Unavailable
            | UiaAttempt::PointMismatch
            | UiaAttempt::SelectionFailed(_)
            | UiaAttempt::Outcome(CaptureOutcome::Empty)
    )
    {
        if (start_point.x != point.x || start_point.y != point.y)
            && unsafe { automation.ElementFromPoint(start_point) }.is_ok_and(|start_element| {
                unsafe { start_element.CurrentControlType() }.is_ok_and(is_image_control_type)
            })
        {
            trace_capture_phase("uia-image-surface-ignored");
            return Ok(UiaAttempt::Ignored);
        }
    }
    match &point_attempt {
        UiaAttempt::Ignored
        | UiaAttempt::PointMismatch
        | UiaAttempt::Outcome(CaptureOutcome::Detected(_))
        | UiaAttempt::Outcome(CaptureOutcome::TooLong { .. })
        | UiaAttempt::Outcome(CaptureOutcome::Failed(_))
        | UiaAttempt::SelectionFailed(_)
        | UiaAttempt::Failed(_) => return Ok(point_attempt),
        UiaAttempt::Outcome(CaptureOutcome::Empty)
        | UiaAttempt::Unavailable
        | UiaAttempt::NoTextSurface => {}
    }

    // Many Chromium and custom controls expose TextPattern on a focused
    // ancestor instead of the leaf below the mouse. Pot uses the focused UIA
    // element for this reason; keep the point-based lookup first so stale focus
    // cannot win over the surface that was actually dragged.
    trace_capture_phase("uia-focused-element");
    let focused = match unsafe { automation.GetFocusedElement() } {
        Ok(element) => element,
        Err(_) => return Ok(point_attempt),
    };
    let focused_attempt = capture_from_uia_element(&automation, &focused, point, start_point)?;
    Ok(prefer_focused_uia_attempt(point_attempt, focused_attempt))
}

fn prefer_focused_uia_attempt(point: UiaAttempt, focused: UiaAttempt) -> UiaAttempt {
    if matches!(point, UiaAttempt::NoTextSurface)
        && matches!(
            focused,
            UiaAttempt::NoTextSurface
                | UiaAttempt::Unavailable
                | UiaAttempt::PointMismatch
                | UiaAttempt::Outcome(CaptureOutcome::Empty)
        )
    {
        UiaAttempt::NoTextSurface
    } else if matches!(focused, UiaAttempt::NoTextSurface) {
        point
    } else {
        focused
    }
}

fn capture_from_uia_element(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
    point: POINT,
    start_point: POINT,
) -> Result<UiaAttempt, CaptureError> {
    trace_capture_phase("uia-ignored-surface-ancestors");
    if element_is_ignored_selection_surface(automation, element) {
        return Ok(UiaAttempt::Ignored);
    }

    trace_capture_phase("uia-text-pattern-ancestors");
    let (text_pattern, text_surface) =
        match text_pattern_from_element_or_ancestors(automation, element) {
            TextPatternSearch::Pattern(pattern, text_surface) => (pattern, text_surface),
            TextPatternSearch::TextSurface => return Ok(UiaAttempt::Unavailable),
            TextPatternSearch::Other => return Ok(UiaAttempt::NoTextSurface),
        };
    // At this point the target and its ancestors have already been checked for
    // terminals and code editors. Chromium's PDF UIA provider can expose a
    // TextPattern but fail individual selection/range calls. That is safe to
    // distinguish from failures before surface classification so the guarded
    // clipboard fallback still has a chance to retrieve the selection.
    let attempt = capture_from_text_pattern(&text_pattern, point, start_point)
        .unwrap_or_else(|error| UiaAttempt::SelectionFailed(error.to_string()));
    Ok(suppress_ambiguous_non_text_attempt(attempt, text_surface))
}

fn suppress_ambiguous_non_text_attempt(attempt: UiaAttempt, text_surface: bool) -> UiaAttempt {
    // A generic canvas can expose TextPattern without supporting selection.
    // Empty/failed reads alone do not justify sending Ctrl+C to that canvas.
    if !text_surface
        && matches!(
            attempt,
            UiaAttempt::Outcome(CaptureOutcome::Empty)
                | UiaAttempt::Unavailable
                | UiaAttempt::SelectionFailed(_)
        )
    {
        UiaAttempt::NoTextSurface
    } else {
        attempt
    }
}

enum TextPatternSearch {
    Pattern(IUIAutomationTextPattern, bool),
    TextSurface,
    Other,
}

fn text_pattern_from_element_or_ancestors(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
) -> TextPatternSearch {
    let walker = unsafe { automation.RawViewWalker() }.ok();
    let mut current = element.clone();
    let mut text_surface = false;

    for depth in 0..MAX_UIA_ANCESTORS {
        text_surface |= unsafe { current.CurrentControlType() }
            .is_ok_and(is_text_control_type);
        if let Ok(pattern) = unsafe { current.GetCurrentPatternAs(UIA_TextPatternId) } {
            return TextPatternSearch::Pattern(pattern, text_surface);
        }
        if depth + 1 == MAX_UIA_ANCESTORS {
            break;
        }
        let Some(walker) = walker.as_ref() else {
            break;
        };
        let Ok(parent) = (unsafe { walker.GetParentElement(&current) }) else {
            break;
        };
        current = parent;
    }

    if text_surface {
        TextPatternSearch::TextSurface
    } else {
        TextPatternSearch::Other
    }
}

fn is_text_control_type(control_type: UIA_CONTROLTYPE_ID) -> bool {
    [UIA_EditControlTypeId, UIA_DocumentControlTypeId, UIA_TextControlTypeId]
        .contains(&control_type)
}

/// Reads the bounding rectangles UIA reports for a selected range. The
/// returned SAFEARRAY contains plain VT_R8 doubles, four per rectangle in
/// left/top/width/height order, in screen coordinates. Providers that expose
/// no geometry yield `None`; geometry only validates the selected text.
fn selection_bounding_rects(range: &IUIAutomationTextRange) -> Option<Vec<RECT>> {
    let array = unsafe { range.GetBoundingRectangles() }.ok()?;
    if array.is_null() {
        return None;
    }
    let parsed = (|| {
        let upper = unsafe { SafeArrayGetUBound(array, 1) }.ok()?;
        let lower = unsafe { SafeArrayGetLBound(array, 1) }.ok()?;
        let count = upper.checked_sub(lower)?.checked_add(1)? as usize;
        if count == 0 || count % 4 != 0 {
            return None;
        }
        let mut data: *mut std::ffi::c_void = std::ptr::null_mut();
        unsafe { SafeArrayAccessData(array, &mut data) }.ok()?;
        let result = (|| {
            let doubles = unsafe { std::slice::from_raw_parts(data as *const f64, count) };
            let mut rects = Vec::with_capacity(count / 4);
            for chunk in doubles.chunks_exact(4) {
                if let Some(rect) = selection_rect_from_uia(chunk) {
                    rects.push(rect);
                }
            }
            Some(rects)
        })();
        unsafe { SafeArrayUnaccessData(array) }.ok()?;
        result
    })();
    let _ = unsafe { SafeArrayDestroy(array) };
    parsed
}

// RangeFromPoint maps whitespace to the nearest text position, which can lie
// outside a real selection. Check the gesture against the selected text bounds
// before treating that mismatch as stale selection.
fn selection_geometry_matches_drag(start: POINT, end: POINT, rects: &[RECT]) -> bool {
    rects.iter().any(|rect| point_near_selection_rect(start, rect, SELECTION_START_TOLERANCE))
        && rects.iter().any(|rect| point_near_selection_rect(end, rect, SELECTION_END_TOLERANCE))
}

fn is_image_control_type(control_type: UIA_CONTROLTYPE_ID) -> bool {
    control_type == UIA_ImageControlTypeId
}

fn selection_rect_from_uia(values: &[f64]) -> Option<RECT> {
    let [left, top, width, height] = values else {
        return None;
    };
    if !values.iter().all(|value| value.is_finite()) || *width <= 0.0 || *height <= 0.0 {
        return None;
    }
    Some(RECT {
        left: left.round() as i32,
        top: top.round() as i32,
        right: (left + width).round() as i32,
        bottom: (top + height).round() as i32,
    })
}

fn point_near_selection_rect(point: POINT, rect: &RECT, horizontal_tolerance: i32) -> bool {
    if rect.right <= rect.left || rect.bottom <= rect.top {
        return false;
    }
    let vertical_tolerance = ((rect.bottom - rect.top) / 2).clamp(4, 12);
    point.x >= rect.left.saturating_sub(horizontal_tolerance)
        && point.x <= rect.right.saturating_add(horizontal_tolerance)
        && point.y >= rect.top.saturating_sub(vertical_tolerance)
        && point.y <= rect.bottom.saturating_add(vertical_tolerance)
}

fn capture_from_text_pattern(
    text_pattern: &IUIAutomationTextPattern,
    point: POINT,
    start_point: POINT,
) -> Result<UiaAttempt, CaptureError> {

    trace_capture_phase("uia-get-selection");
    let ranges = unsafe { text_pattern.GetSelection()? };
    let range_count = unsafe { ranges.Length()? };
    if !(0..=MAX_SELECTION_RANGES).contains(&range_count) {
        return Ok(UiaAttempt::Unavailable);
    }
    let mut text = String::new();
    let point_range = unsafe { text_pattern.RangeFromPoint(point) }.ok();
    // `None` means the provider cannot map a screen point. `Some(false)` can
    // be either a stale UIA range or a valid release in line-end whitespace;
    // compare the full mouse gesture with the selection geometry below.
    let mut point_matches_selection = point_range.as_ref().map(|_| false);
    let mut selection_rects: Vec<RECT> = Vec::new();

    for index in 0..range_count {
        trace_capture_phase("uia-get-selected-range");
        let range = unsafe { ranges.GetElement(index)? };
        if let Some(mut rects) = selection_bounding_rects(&range) {
            selection_rects.append(&mut rects);
        }
        if let Some(point_range) = point_range.as_ref() {
            match range_contains_point(&range, point_range) {
                Some(true) => point_matches_selection = Some(true),
                None if point_matches_selection != Some(true) => {
                    point_matches_selection = None;
                }
                _ => {}
            }
        }

        if !matches!(classify_text(&text), TextClassification::TooLong(_)) {
            let remaining = MAX_SELECTION_CHARACTERS
                .saturating_add(1)
                .saturating_sub(text.chars().count())
                .max(1);
            trace_capture_phase("uia-get-bounded-text");
            text.push_str(&unsafe { range.GetText(remaining as i32)? }.to_string());
        }
    }

    let outcome = CapturedSelection::from_text_at_point(text, point);
    if point_matches_selection == Some(false)
        && !selection_geometry_matches_drag(start_point, point, &selection_rects)
        && matches!(
            outcome,
            CaptureOutcome::Detected(_) | CaptureOutcome::TooLong { .. }
        )
    {
        trace_capture_phase("uia-selection-point-mismatch");
        return Ok(UiaAttempt::PointMismatch);
    }

    trace_capture_phase("uia-complete");
    Ok(UiaAttempt::Outcome(outcome))
}

fn range_contains_point(
    selected_range: &IUIAutomationTextRange,
    point_range: &IUIAutomationTextRange,
) -> Option<bool> {
    let starts_before_or_at_point = unsafe {
        selected_range.CompareEndpoints(
            TextPatternRangeEndpoint_Start,
            point_range,
            TextPatternRangeEndpoint_Start,
        )
    }
    .ok()?
        <= 0;
    let ends_after_or_at_point = unsafe {
        selected_range.CompareEndpoints(
            TextPatternRangeEndpoint_End,
            point_range,
            TextPatternRangeEndpoint_Start,
        )
    }
    .ok()?
        >= 0;
    Some(endpoints_contain_point(
        starts_before_or_at_point,
        ends_after_or_at_point,
    ))
}

fn endpoints_contain_point(starts_before_or_at_point: bool, ends_after_or_at_point: bool) -> bool {
    starts_before_or_at_point && ends_after_or_at_point
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

fn element_is_ignored_selection_surface(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
) -> bool {
    let Ok(walker) = (unsafe { automation.RawViewWalker() }) else {
        return false;
    };
    let mut current = element.clone();

    // Chromium apps expose their DOM accessibility nodes through UIA. Walking
    // ancestors lets us reject non-prose surfaces before reading their selection.
    for _ in 0..MAX_UIA_ANCESTORS {
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

        if is_terminal_accessibility_node(&name, &automation_id, &class_name, control_type)
            || is_code_editor_accessibility_node(
                &name,
                &automation_id,
                &class_name,
                control_type,
            )
        {
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

fn is_code_editor_accessibility_node(
    name: &str,
    automation_id: &str,
    class_name: &str,
    control_type: UIA_CONTROLTYPE_ID,
) -> bool {
    let name = name.trim().to_lowercase();
    let structural = format!("{automation_id} {class_name}").to_lowercase();
    let code_editor_structure = [
        "monaco-editor",
        "monaco-mouse-cursor-text",
        "editor-instance",
        "code-editor",
        "view-lines",
    ]
    .iter()
    .any(|marker| structural.contains(marker));
    let code_editor_name = name.starts_with("editor content")
        || name.starts_with("diff editor content")
        || name.starts_with("编辑器内容")
        || name.starts_with("差异编辑器内容");
    let editor_control = [
        UIA_DocumentControlTypeId,
        UIA_CustomControlTypeId,
        UIA_EditControlTypeId,
        UIA_TextControlTypeId,
    ]
    .contains(&control_type);

    code_editor_structure || (code_editor_name && editor_control)
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
        // Never press Ctrl+C on explicitly ignored or non-text surfaces.
        UiaAttempt::Ignored => CaptureOutcome::Empty,
        UiaAttempt::NoTextSurface => {
            trace_capture_phase("uia-non-text-surface");
            CaptureOutcome::Empty
        }
        UiaAttempt::PointMismatch => {
            trace_capture_phase("uia-point-mismatch-fallback");
            fallback()
        }
        UiaAttempt::Outcome(CaptureOutcome::Empty) => {
            trace_capture_phase("uia-empty-fallback");
            fallback()
        }
        UiaAttempt::Unavailable => {
            trace_capture_phase("uia-unavailable-fallback");
            fallback()
        }
        UiaAttempt::SelectionFailed(error) => {
            eprintln!("selection-helper phase=uia-selection-fallback error={error}");
            fallback()
        }
        // A hard UIA failure happened before the target surface could be
        // classified. Failing closed avoids sending Ctrl+C to an unknown or
        // elevated window.
        UiaAttempt::Failed(error) => {
            CaptureOutcome::Failed(format!("UI Automation failed: {error}"))
        }
    }
}

fn copy_fallback(point: POINT) -> CaptureOutcome {
    if !point_belongs_to_foreground_window(point) {
        return CaptureOutcome::Empty;
    }

    trace_capture_phase("clipboard-snapshot");
    let mut original_clipboard = match snapshot_clipboard() {
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

    let copied = wait_for_clipboard_copy(
        before_sequence,
        CLIPBOARD_RETRY_DELAY,
        || unsafe { GetClipboardSequenceNumber() },
        || {
            trace_capture_phase("clipboard-read-copy");
            read_plain_text()
        },
    );
    let ClipboardCopyWait::Changed {
        sequence: copied_sequence,
        text: copied_text,
    } = copied
    else {
        return CaptureOutcome::Empty;
    };

    // Clipboard listeners and the source application can briefly reopen the
    // clipboard after Ctrl+C. Let that activity settle before restoring the
    // independent format snapshot, then verify that no newer copy replaced it.
    thread::sleep(CLIPBOARD_RESTORE_SETTLE_DELAY);
    trace_capture_phase("clipboard-restore");
    match restore_clipboard_if_unchanged(copied_sequence, &mut original_clipboard) {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("Selection clipboard restore skipped because the clipboard changed.");
        }
        Err(error) => {
            eprintln!("Selection clipboard restore failed: {error}");
        }
    }
    copied_text
        .map(|text| CapturedSelection::from_text_at_point(text, point))
        .unwrap_or(CaptureOutcome::Empty)
}

#[derive(Debug, PartialEq, Eq)]
enum ClipboardCopyWait {
    Unchanged,
    Changed { sequence: u32, text: Option<String> },
    Superseded,
}

fn wait_for_clipboard_copy(
    before_sequence: u32,
    delay: Duration,
    mut sequence_number: impl FnMut() -> u32,
    mut read_text: impl FnMut() -> Option<String>,
) -> ClipboardCopyWait {
    let mut copied_sequence = None;
    for _ in 0..CLIPBOARD_RETRIES {
        if !delay.is_zero() {
            thread::sleep(delay);
        }
        let observed_sequence = sequence_number();
        match copied_sequence {
            None if observed_sequence == before_sequence => continue,
            None => copied_sequence = Some(observed_sequence),
            Some(expected) if observed_sequence != expected => {
                // A second clipboard write is not ours to restore over. This is
                // usually a clipboard manager or another user action.
                return ClipboardCopyWait::Superseded;
            }
            Some(_) => {}
        }

        if let Some(text) = read_text() {
            return ClipboardCopyWait::Changed {
                sequence: copied_sequence.expect("a changed sequence is recorded before reading"),
                text: Some(text),
            };
        }
    }

    copied_sequence.map_or(ClipboardCopyWait::Unchanged, |sequence| {
        ClipboardCopyWait::Changed {
            sequence,
            text: None,
        }
    })
}

fn point_belongs_to_foreground_window(point: POINT) -> bool {
    let hit_window = unsafe { WindowFromPoint(point) };
    let foreground_window = unsafe { GetForegroundWindow() };
    if hit_window.is_invalid() || foreground_window.is_invalid() {
        return false;
    }
    let hit_root = unsafe { GetAncestor(hit_window, GA_ROOT) };
    let foreground_root = unsafe { GetAncestor(foreground_window, GA_ROOT) };
    if hit_root.is_invalid() || foreground_root.is_invalid() {
        return false;
    }

    // PDF readers commonly open a non-activating, owned toolbar above the
    // release point after text selection. GA_ROOT sees that toolbar as a
    // separate top-level window; GA_ROOTOWNER links it back to the document
    // window so the guarded Ctrl+C fallback can still read the selection.
    let hit_root_owner = unsafe { GetAncestor(hit_window, GA_ROOTOWNER) };
    let foreground_root_owner = unsafe { GetAncestor(foreground_window, GA_ROOTOWNER) };
    window_context_matches(
        hit_root.0 as isize,
        hit_root_owner.0 as isize,
        foreground_root.0 as isize,
        foreground_root_owner.0 as isize,
    )
}

fn window_context_matches(
    hit_root: isize,
    hit_root_owner: isize,
    foreground_root: isize,
    foreground_root_owner: isize,
) -> bool {
    hit_root != 0
        && foreground_root != 0
        && (hit_root == foreground_root
            || (hit_root_owner != 0
                && foreground_root_owner != 0
                && hit_root_owner == foreground_root_owner))
}

fn send_copy_shortcut() -> bool {
    let inputs = [
        keyboard_input(
            VK_CONTROL.0 as u16,
            windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0),
        ),
        keyboard_input(
            b'C' as u16,
            windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0),
        ),
        keyboard_input(b'C' as u16, KEYEVENTF_KEYUP),
        keyboard_input(VK_CONTROL.0 as u16, KEYEVENTF_KEYUP),
    ];
    unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) == inputs.len() as u32 }
}

fn keyboard_input(
    virtual_key: u16,
    flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS,
) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(virtual_key),
                dwFlags: flags,
                ..Default::default()
            },
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

struct ClipboardGuard;

impl ClipboardGuard {
    fn open(owner: Option<HWND>) -> Option<Self> {
        unsafe { OpenClipboard(owner).ok()? };
        Some(Self)
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

fn read_plain_text() -> Option<String> {
    let _clipboard = ClipboardGuard::open(None)?;
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
    let text = decode_bounded_clipboard_text(characters);
    let _ = unsafe { GlobalUnlock(global) };
    text
}

fn decode_bounded_clipboard_text(characters: &[u16]) -> Option<String> {
    let mut text = String::new();
    let mut character_count = 0;
    for character in char::decode_utf16(characters.iter().copied().take_while(|unit| *unit != 0)) {
        text.push(character.ok()?);
        character_count += 1;
        if character_count > MAX_SELECTION_CHARACTERS {
            break;
        }
    }
    Some(text)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClipboardHandleKind {
    GlobalMemory,
    GdiObject,
    EnhancedMetafile,
    MetafilePicture,
    Unsupported,
}

fn clipboard_handle_kind(format: u32) -> ClipboardHandleKind {
    let format_id = |format: CLIPBOARD_FORMAT| u32::from(format.0);
    if format == format_id(CF_OWNERDISPLAY)
        || (format_id(CF_PRIVATEFIRST)..=format_id(CF_PRIVATELAST)).contains(&format)
        || (format_id(CF_GDIOBJFIRST)..=format_id(CF_GDIOBJLAST)).contains(&format)
    {
        ClipboardHandleKind::Unsupported
    } else if [CF_BITMAP, CF_DSPBITMAP, CF_PALETTE]
        .into_iter()
        .map(format_id)
        .any(|candidate| candidate == format)
    {
        ClipboardHandleKind::GdiObject
    } else if [CF_ENHMETAFILE, CF_DSPENHMETAFILE]
        .into_iter()
        .map(format_id)
        .any(|candidate| candidate == format)
    {
        ClipboardHandleKind::EnhancedMetafile
    } else if [CF_METAFILEPICT, CF_DSPMETAFILEPICT]
        .into_iter()
        .map(format_id)
        .any(|candidate| candidate == format)
    {
        ClipboardHandleKind::MetafilePicture
    } else {
        ClipboardHandleKind::GlobalMemory
    }
}

struct OwnedClipboardFormat {
    format: u32,
    kind: ClipboardHandleKind,
    handle: Option<HANDLE>,
}

impl Drop for OwnedClipboardFormat {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };
        unsafe { free_clipboard_handle(self.kind, handle) };
    }
}

unsafe fn free_clipboard_handle(kind: ClipboardHandleKind, handle: HANDLE) {
    match kind {
        ClipboardHandleKind::GdiObject => {
            let _ = unsafe { DeleteObject(HGDIOBJ(handle.0)) };
        }
        ClipboardHandleKind::EnhancedMetafile => {
            let _ = unsafe { DeleteEnhMetaFile(Some(HENHMETAFILE(handle.0))) };
        }
        ClipboardHandleKind::MetafilePicture => {
            let global = HGLOBAL(handle.0);
            let data = unsafe { GlobalLock(global) }.cast::<METAFILEPICT>();
            if !data.is_null() {
                let metafile = unsafe { (*data).hMF };
                let _ = unsafe { GlobalUnlock(global) };
                if !metafile.is_invalid() {
                    let _ = unsafe { DeleteMetaFile(metafile) };
                }
            }
            let _ = unsafe { GlobalFree(Some(global)) };
        }
        ClipboardHandleKind::GlobalMemory => {
            let _ = unsafe { GlobalFree(Some(HGLOBAL(handle.0))) };
        }
        ClipboardHandleKind::Unsupported => {}
    }
}

// OleGetClipboard can return a short-lived forwarding IDataObject. Putting that
// proxy back with OleSetClipboard and flushing it can build/re-enter a provider
// chain during repeated captures. Keep independently owned native handles so
// restore never calls back through the source application's data object.
enum ClipboardSnapshot {
    Formats(Vec<OwnedClipboardFormat>),
    Empty,
}

fn clipboard_snapshot_size(format: u32, kind: ClipboardHandleKind, source: HANDLE) -> Result<usize, String> {
    use windows::Win32::Graphics::Gdi::{GetObjectW, GetEnhMetaFileBits, GetMetaFileBitsEx, GetPaletteEntries, BITMAP, HPALETTE};
    let bytes = match kind {
        ClipboardHandleKind::GlobalMemory => unsafe { GlobalSize(HGLOBAL(source.0)) },
        ClipboardHandleKind::EnhancedMetafile => unsafe { GetEnhMetaFileBits(HENHMETAFILE(source.0), None) as usize },
        ClipboardHandleKind::MetafilePicture => {
            if unsafe { GlobalSize(HGLOBAL(source.0)) } < size_of::<METAFILEPICT>() { return Err("Invalid clipboard metafile".into()); }
            let ptr = unsafe { GlobalLock(HGLOBAL(source.0)) };
            if ptr.is_null() { return Err("Could not inspect clipboard metafile".into()); }
            let metafile = unsafe { (*(ptr as *const METAFILEPICT)).hMF };
            let bytes = unsafe { GetMetaFileBitsEx(metafile, 0, None) as usize };
            let _ = unsafe { GlobalUnlock(HGLOBAL(source.0)) };
            bytes.saturating_add(size_of::<METAFILEPICT>())
        }
        ClipboardHandleKind::GdiObject if format == u32::from(CF_PALETTE.0) =>
            unsafe { GetPaletteEntries(HPALETTE(source.0), 0, None) as usize * 4 },
        ClipboardHandleKind::GdiObject => {
            let mut bitmap = BITMAP::default();
            if unsafe { GetObjectW(HGDIOBJ(source.0), size_of::<BITMAP>() as i32, Some((&mut bitmap as *mut BITMAP).cast())) } == 0 {
                return Err("Could not inspect clipboard bitmap".into());
            }
            (bitmap.bmWidthBytes.unsigned_abs() as usize)
                .saturating_mul(bitmap.bmHeight.unsigned_abs() as usize)
                .saturating_mul(usize::from(bitmap.bmPlanes))
        }
        ClipboardHandleKind::Unsupported => return Err("Unsupported clipboard format".into()),
    };
    if bytes == 0 { return Err("Clipboard format has an unknown size".into()); }
    Ok(bytes)
}

fn checked_clipboard_snapshot_bytes(current: usize, next: usize) -> Result<usize, String> {
    let total = current.saturating_add(next);
    if total > MAX_CLIPBOARD_SNAPSHOT_BYTES {
        Err("clipboard snapshot exceeds the 128 MiB safety budget".into())
    } else {
        Ok(total)
    }
}

fn snapshot_clipboard() -> Result<ClipboardSnapshot, String> {
    let _clipboard = ClipboardGuard::open(None)
        .ok_or_else(|| "could not snapshot the clipboard for fallback".to_string())?;
    let mut formats = Vec::new();
    let mut snapshot_bytes = 0usize;
    let mut format = unsafe { EnumClipboardFormats(0) };
    while format != 0 {
        if formats.len() >= MAX_CLIPBOARD_FORMATS {
            return Err("clipboard contains too many formats to snapshot safely".to_string());
        }
        let kind = clipboard_handle_kind(format);
        if kind == ClipboardHandleKind::Unsupported {
            return Err(format!(
                "clipboard format {format} cannot be snapshotted safely"
            ));
        }
        let source = unsafe { GetClipboardData(format) }.map_err(|error| {
            format!("could not read clipboard format {format} for snapshot: {error}")
        })?;
        if kind == ClipboardHandleKind::GlobalMemory
            && unsafe { GlobalSize(HGLOBAL(source.0)) } == 0
        {
            return Err(format!(
                "clipboard format {format} is not backed by global memory"
            ));
        }
        if kind == ClipboardHandleKind::MetafilePicture
            && unsafe { GlobalSize(HGLOBAL(source.0)) } < size_of::<METAFILEPICT>()
        {
            return Err(format!(
                "clipboard metafile format {format} is smaller than its header"
            ));
        }
        snapshot_bytes = checked_clipboard_snapshot_bytes(
            snapshot_bytes,
            clipboard_snapshot_size(format, kind, source)?,
        )?;
        let format_id = u16::try_from(format)
            .map_err(|_| format!("invalid clipboard format identifier {format}"))?;
        let duplicate = unsafe {
            OleDuplicateData(
                source,
                CLIPBOARD_FORMAT(format_id),
                GLOBAL_ALLOC_FLAGS(0),
            )
        };
        if duplicate.is_invalid() {
            return Err(format!(
                "could not duplicate clipboard format {format} for snapshot"
            ));
        }
        formats.push(OwnedClipboardFormat {
            format,
            kind,
            handle: Some(duplicate),
        });
        format = unsafe { EnumClipboardFormats(format) };
    }
    if formats.is_empty() {
        Ok(ClipboardSnapshot::Empty)
    } else {
        Ok(ClipboardSnapshot::Formats(formats))
    }
}

fn should_restore_clipboard(expected_sequence: u32, observed_sequence: u32) -> bool {
    expected_sequence == observed_sequence
}

struct ClipboardOwnerWindow(HWND);

impl ClipboardOwnerWindow {
    fn create() -> Result<Self, String> {
        let window = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!(""),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
        }
        .map_err(|error| format!("could not create clipboard owner window: {error}"))?;
        Ok(Self(window))
    }
}

impl Drop for ClipboardOwnerWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

fn open_clipboard_for_restore(owner: HWND) -> Result<ClipboardGuard, String> {
    let mut last_error = None;
    for attempt in 0..CLIPBOARD_RESTORE_RETRIES {
        if let Some(clipboard) = ClipboardGuard::open(Some(owner)) {
            return Ok(clipboard);
        }
        last_error = Some(Error::from_win32().to_string());
        if attempt + 1 < CLIPBOARD_RESTORE_RETRIES {
            thread::sleep(CLIPBOARD_RESTORE_RETRY_DELAY);
        }
    }
    Err(format!(
        "could not open the clipboard for restore: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    ))
}

fn restore_clipboard_if_unchanged(
    expected_sequence: u32,
    snapshot: &mut ClipboardSnapshot,
) -> Result<bool, String> {
    let owner = ClipboardOwnerWindow::create()?;
    let _clipboard = open_clipboard_for_restore(owner.0)?;
    let observed_sequence = unsafe { GetClipboardSequenceNumber() };
    if !should_restore_clipboard(expected_sequence, observed_sequence) {
        return Ok(false);
    }

    match snapshot {
        ClipboardSnapshot::Formats(formats) => {
            unsafe { EmptyClipboard() }.map_err(|error| error.to_string())?;
            for entry in formats {
                let handle = entry.handle.ok_or_else(|| {
                    format!("clipboard format {} was already restored", entry.format)
                })?;
                unsafe { SetClipboardData(entry.format, Some(handle)) }.map_err(|error| {
                    format!("could not restore clipboard format {}: {error}", entry.format)
                })?;
                // SetClipboardData transfers ownership to the system only after
                // it succeeds; prevent this snapshot from freeing the handle.
                entry.handle = None;
            }
        }
        ClipboardSnapshot::Empty => {
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
    fn transient_capture_failure_is_retried_once() {
        let retry_called = Cell::new(false);
        let recovered = CapturedSelection {
            text: "recovered".into(),
            anchor: Anchor { x: 1, y: 2 },
        };
        let outcome = retry_failed_capture(CaptureOutcome::Failed("UIA busy".into()), || {
            retry_called.set(true);
            CaptureOutcome::Detected(recovered.clone())
        });

        assert!(retry_called.get());
        assert_eq!(outcome, CaptureOutcome::Detected(recovered));
    }

    #[test]
    fn successful_capture_is_not_repeated() {
        let retry_called = Cell::new(false);
        let outcome = retry_failed_capture(CaptureOutcome::Empty, || {
            retry_called.set(true);
            CaptureOutcome::Failed("must not run".into())
        });

        assert!(!retry_called.get());
        assert_eq!(outcome, CaptureOutcome::Empty);
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
    fn unavailable_uia_selection_uses_clipboard_fallback() {
        let fallback_called = Cell::new(false);
        let outcome = resolve_uia_attempt(UiaAttempt::Unavailable, || {
            fallback_called.set(true);
            CaptureOutcome::Empty
        });

        assert!(fallback_called.get());
        assert_eq!(outcome, CaptureOutcome::Empty);
    }

    #[test]
    fn uia_selection_read_error_uses_clipboard_fallback_after_surface_check() {
        let fallback_called = Cell::new(false);
        let fallback_capture = CapturedSelection {
            text: "pdf selection".into(),
            anchor: Anchor { x: 5, y: 6 },
        };
        let outcome = resolve_uia_attempt(
            UiaAttempt::SelectionFailed("PDF range unavailable".into()),
            || {
                fallback_called.set(true);
                CaptureOutcome::Detected(fallback_capture.clone())
            },
        );

        assert!(fallback_called.get());
        assert_eq!(outcome, CaptureOutcome::Detected(fallback_capture));
    }

    #[test]
    fn ignored_surface_does_not_use_clipboard_fallback() {
        let fallback_called = Cell::new(false);
        let outcome = resolve_uia_attempt(UiaAttempt::Ignored, || {
            fallback_called.set(true);
            CaptureOutcome::Failed("fallback must not run".into())
        });

        assert!(!fallback_called.get());
        assert_eq!(outcome, CaptureOutcome::Empty);
    }

    #[test]
    fn permanent_clipboard_snapshot_failure_is_not_retried() {
        for error in [
            "clipboard snapshot exceeds the 128 MiB safety budget",
            "clipboard contains too many formats to snapshot safely",
            "clipboard format 8 cannot be snapshotted safely",
            "clipboard format 13 is not backed by global memory",
        ] {
            let retry_called = Cell::new(false);
            let outcome = retry_failed_capture(CaptureOutcome::Failed(error.into()), || {
                retry_called.set(true);
                CaptureOutcome::Empty
            });
            assert!(!retry_called.get(), "unexpected retry for {error}");
            assert_eq!(outcome, CaptureOutcome::Failed(error.into()));
        }
    }

    #[test]
    fn non_text_surface_does_not_send_copy_shortcut() {
        let fallback_called = Cell::new(false);
        let attempt = prefer_focused_uia_attempt(
            UiaAttempt::NoTextSurface,
            UiaAttempt::Outcome(CaptureOutcome::Empty),
        );
        let outcome = resolve_uia_attempt(attempt, || {
            fallback_called.set(true);
            CaptureOutcome::Empty
        });

        assert!(!fallback_called.get());
        assert_eq!(outcome, CaptureOutcome::Empty);
        assert!(!is_text_control_type(UIA_PaneControlTypeId));
        assert!(is_text_control_type(UIA_DocumentControlTypeId));
    }

    #[test]
    fn empty_text_pattern_on_generic_canvas_does_not_copy() {
        let attempt = suppress_ambiguous_non_text_attempt(
            UiaAttempt::Outcome(CaptureOutcome::Empty),
            false,
        );
        let fallback_called = Cell::new(false);
        let outcome = resolve_uia_attempt(attempt, || {
            fallback_called.set(true);
            CaptureOutcome::Empty
        });
        assert!(!fallback_called.get());
        assert_eq!(outcome, CaptureOutcome::Empty);
        assert!(matches!(
            suppress_ambiguous_non_text_attempt(UiaAttempt::Outcome(CaptureOutcome::Empty), true),
            UiaAttempt::Outcome(CaptureOutcome::Empty)
        ));
        assert!(matches!(
            suppress_ambiguous_non_text_attempt(UiaAttempt::SelectionFailed("busy".into()), false),
            UiaAttempt::NoTextSurface
        ));
        assert!(matches!(
            suppress_ambiguous_non_text_attempt(UiaAttempt::SelectionFailed("busy".into()), true),
            UiaAttempt::SelectionFailed(_)
        ));
    }

    #[test]
    fn focused_text_selection_is_used_on_custom_surface() {
        let captured = CapturedSelection {
            text: "selected text".into(),
            anchor: Anchor { x: 1, y: 2 },
        };
        let attempt = prefer_focused_uia_attempt(
            UiaAttempt::NoTextSurface,
            UiaAttempt::Outcome(CaptureOutcome::Detected(captured.clone())),
        );
        let outcome = resolve_uia_attempt(attempt, || CaptureOutcome::Empty);
        assert_eq!(outcome, CaptureOutcome::Detected(captured));
    }

    #[test]
    fn image_surface_does_not_send_copy_shortcut() {
        let fallback_called = Cell::new(false);
        let attempt = if is_image_control_type(UIA_ImageControlTypeId) {
            UiaAttempt::Ignored
        } else {
            UiaAttempt::Unavailable
        };
        let outcome = resolve_uia_attempt(attempt, || {
            fallback_called.set(true);
            CaptureOutcome::Empty
        });

        assert!(!fallback_called.get());
        assert_eq!(outcome, CaptureOutcome::Empty);
        assert!(!is_image_control_type(UIA_DocumentControlTypeId));
    }

    #[test]
    fn release_point_mismatch_uses_guarded_clipboard_fallback() {
        let fallback_called = Cell::new(false);
        let fallback_capture = CapturedSelection {
            text: "line ending selection".into(),
            anchor: Anchor { x: 20, y: 30 },
        };
        let outcome = resolve_uia_attempt(UiaAttempt::PointMismatch, || {
            fallback_called.set(true);
            CaptureOutcome::Detected(fallback_capture.clone())
        });

        assert!(fallback_called.get());
        assert_eq!(outcome, CaptureOutcome::Detected(fallback_capture));
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
    fn owned_selection_popup_matches_its_foreground_document() {
        assert!(window_context_matches(20, 10, 10, 10));
    }

    #[test]
    fn unrelated_popup_does_not_match_the_foreground_window() {
        assert!(!window_context_matches(20, 20, 10, 10));
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
    fn recognizes_vscode_monaco_editor_accessibility_markers() {
        assert!(is_code_editor_accessibility_node(
            "",
            "editor",
            "monaco-editor",
            UIA_DocumentControlTypeId
        ));
        assert!(is_code_editor_accessibility_node(
            "Editor content; Press Alt+F1 for Accessibility Options.",
            "",
            "textarea",
            UIA_EditControlTypeId
        ));
        assert!(is_code_editor_accessibility_node(
            "编辑器内容；按 Alt+F1 打开辅助功能选项。",
            "",
            "textarea",
            UIA_EditControlTypeId
        ));
    }

    #[test]
    fn prose_edit_control_is_not_mistaken_for_a_code_editor() {
        assert!(!is_terminal_accessibility_node(
            "terminal.rs",
            "editor",
            "monaco-editor",
            UIA_DocumentControlTypeId
        ));
        assert!(!is_code_editor_accessibility_node(
            "Article body",
            "editor",
            "textarea",
            UIA_EditControlTypeId
        ));
    }

    #[test]
    fn uia_error_is_reported_without_a_fallback() {
        let fallback_called = Cell::new(false);
        let outcome = resolve_uia_attempt(
            UiaAttempt::Failed("provider unavailable".into()),
            || {
                fallback_called.set(true);
                CaptureOutcome::Detected(CapturedSelection {
                    text: "must not be captured".into(),
                    anchor: Anchor { x: 0, y: 0 },
                })
            },
        );

        assert!(!fallback_called.get());
        assert!(matches!(outcome, CaptureOutcome::Failed(message) if message.contains("provider unavailable")));
    }

    #[test]
    fn selected_range_must_cover_the_release_point() {
        assert!(endpoints_contain_point(true, true));
        assert!(!endpoints_contain_point(false, true));
        assert!(!endpoints_contain_point(true, false));
    }

    #[test]
    fn line_end_whitespace_can_still_match_a_dragged_selection() {
        let rects = [RECT { left: 100, top: 20, right: 180, bottom: 40 }];
        assert!(selection_geometry_matches_drag(
            POINT { x: 100, y: 30 },
            POINT { x: 220, y: 30 },
            &rects,
        ));
    }

    #[test]
    fn uia_selection_rectangle_uses_width_and_height() {
        let rect = selection_rect_from_uia(&[100.0, 20.0, 80.0, 20.0]).unwrap();
        assert_eq!((rect.left, rect.top, rect.right, rect.bottom), (100, 20, 180, 40));
        assert!(selection_rect_from_uia(&[100.0, 20.0, 0.0, 20.0]).is_none());
    }

    #[test]
    fn unrelated_drag_does_not_accept_a_stale_selection() {
        let rects = [RECT { left: 100, top: 20, right: 180, bottom: 40 }];
        assert!(!selection_geometry_matches_drag(
            POINT { x: 100, y: 100 },
            POINT { x: 220, y: 100 },
            &rects,
        ));
        assert!(!selection_geometry_matches_drag(
            POINT { x: 100, y: 30 },
            POINT { x: 400, y: 30 },
            &rects,
        ));
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
        let mut valid = ["15", "-25", "5", "-25"].map(OsString::from).into_iter();
        assert_eq!(
            helper_points_from_arguments(&mut valid),
            Ok((POINT { x: 15, y: -25 }, POINT { x: 5, y: -25 }))
        );

        let mut invalid = ["15", "25", "x", "25"].map(OsString::from).into_iter();
        assert!(helper_points_from_arguments(&mut invalid).is_err());
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
    fn clipboard_formats_use_the_correct_owned_handle_kind() {
        assert_eq!(
            clipboard_handle_kind(u32::from(CF_UNICODETEXT.0)),
            ClipboardHandleKind::GlobalMemory
        );
        assert_eq!(
            clipboard_handle_kind(u32::from(CF_BITMAP.0)),
            ClipboardHandleKind::GdiObject
        );
        assert_eq!(
            clipboard_handle_kind(u32::from(CF_ENHMETAFILE.0)),
            ClipboardHandleKind::EnhancedMetafile
        );
        assert_eq!(
            clipboard_handle_kind(u32::from(CF_METAFILEPICT.0)),
            ClipboardHandleKind::MetafilePicture
        );
    }

    #[test]
    fn clipboard_snapshot_rejects_owner_managed_handles() {
        for format in [CF_OWNERDISPLAY, CF_PRIVATEFIRST, CF_GDIOBJFIRST] {
            assert_eq!(
                clipboard_handle_kind(u32::from(format.0)),
                ClipboardHandleKind::Unsupported
            );
        }
    }

    #[test]
    fn clipboard_snapshot_accepts_two_4k_bitmap_representations() {
        let bitmap_bytes = 3840 * 2160 * 4;
        let first = checked_clipboard_snapshot_bytes(0, bitmap_bytes).unwrap();
        assert!(checked_clipboard_snapshot_bytes(first, bitmap_bytes).is_ok());
    }

    #[test]
    fn clipboard_snapshot_still_rejects_oversized_data() {
        assert!(checked_clipboard_snapshot_bytes(MAX_CLIPBOARD_SNAPSHOT_BYTES, 1).is_err());
    }

    #[test]
    fn clipboard_text_decode_stops_at_the_selection_limit_without_splitting_surrogates() {
        let mut utf16: Vec<u16> = "🚀"
            .repeat(MAX_SELECTION_CHARACTERS + 2)
            .encode_utf16()
            .collect();
        utf16.push(0);
        let decoded = decode_bounded_clipboard_text(&utf16).unwrap();

        assert_eq!(decoded.chars().count(), MAX_SELECTION_CHARACTERS + 1);
        assert!(decoded.chars().all(|character| character == '🚀'));
    }

    #[test]
    fn clipboard_text_decode_ignores_storage_after_the_null_terminator() {
        assert_eq!(
            decode_bounded_clipboard_text(&[b'o' as u16, b'k' as u16, 0, 0xd800]),
            Some("ok".to_string())
        );
    }

    #[test]
    fn clipboard_text_read_retries_after_the_copy_sequence_changes() {
        let sequence_attempt = Cell::new(0);
        let read_attempt = Cell::new(0);
        let outcome = wait_for_clipboard_copy(
            10,
            Duration::ZERO,
            || {
                let attempt = sequence_attempt.get() + 1;
                sequence_attempt.set(attempt);
                if attempt == 1 {
                    10
                } else {
                    11
                }
            },
            || {
                let attempt = read_attempt.get() + 1;
                read_attempt.set(attempt);
                (attempt == 3).then(|| "selected text".to_string())
            },
        );

        assert_eq!(
            outcome,
            ClipboardCopyWait::Changed {
                sequence: 11,
                text: Some("selected text".into()),
            }
        );
        assert_eq!(read_attempt.get(), 3);
    }

    #[test]
    fn newer_clipboard_write_aborts_capture_and_restore() {
        let attempt = Cell::new(0);
        let outcome = wait_for_clipboard_copy(
            10,
            Duration::ZERO,
            || {
                let current = attempt.get() + 1;
                attempt.set(current);
                match current {
                    1 => 11,
                    _ => 12,
                }
            },
            || None,
        );

        assert_eq!(outcome, ClipboardCopyWait::Superseded);
    }

}
