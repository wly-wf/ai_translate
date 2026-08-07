mod selection_state;
pub mod mouse_hook;
pub mod windows_selection;

use selection_state::{Anchor, SelectionController, StateChange};
use windows_selection::{capture_selection, CaptureOutcome};
use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    image::Image as TauriImage,
    menu::{Menu, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    webview::PageLoadEvent,
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const KEYRING_SERVICE: &str = "ai-translate";
const KEYRING_ACCOUNT: &str = "deepseek-api-key";
const PREFERENCES_ACCOUNT: &str = "user-preferences";
const ACTIVE_PROVIDER_ACCOUNT: &str = "active-provider";
const ENABLED_PROVIDERS_ACCOUNT: &str = "enabled-providers";
const PROVIDER_KEYRING_PREFIX: &str = "provider-config:";
const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
const DEEPSEEK_MODEL: &str = "deepseek-v4-flash";
const DEEPSEEK_THINKING_DISABLED: &str = "disabled";
const USER_PREFERENCES_VERSION: u8 = 1;
const FLOAT_BUTTON_SIZE: i32 = 28;
const FLOAT_SIZE: i32 = FLOAT_BUTTON_SIZE + 4;
pub(crate) const FLOAT_PADDING: i32 = (FLOAT_SIZE - FLOAT_BUTTON_SIZE) / 2;
const TRANSLATION_WINDOW_WIDTH: f64 = 500.0;
const TRANSLATION_WINDOW_HEIGHT: f64 = 700.0;
pub(crate) const FLOAT_CORNER_RADIUS: i32 = 10;

static NEXT_TRANSLATION_REQUEST_ID: AtomicU64 = AtomicU64::new(0);

fn shape_float_window_as_round_rect(hwnd: windows::Win32::Foundation::HWND) -> Result<(), String> {
    use windows::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, HGDIOBJ, SetWindowRgn},
        UI::WindowsAndMessaging::{
            GetClientRect, GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_STYLE,
            SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
            WINDOW_STYLE, WS_CAPTION, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU,
            WS_THICKFRAME,
        },
    };

    // Tauri already requests an undecorated window, but some Windows/WebView2
    // combinations restore the normal non-client frame when this tiny window
    // is shown. Strip it again at the native handle so the only visible and
    // clickable surface is the icon's rounded-rectangle region.
    let mut style = WINDOW_STYLE(unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32);
    style &= !(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
    unsafe { SetWindowLongW(hwnd, GWL_STYLE, style.0 as i32) };
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
        )
    }
    .map_err(|error| error.to_string())?;

    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) }.map_err(|error| error.to_string())?;

    let region = unsafe {
        CreateRoundRectRgn(
            client.left,
            client.top,
            client.right,
            client.bottom,
            FLOAT_CORNER_RADIUS * 2,
            FLOAT_CORNER_RADIUS * 2,
        )
    };
    if region.is_invalid() {
        return Err("Could not create the rounded selection-float region.".into());
    }

    if unsafe { SetWindowRgn(hwnd, Some(region), true) } == 0 {
        let _ = unsafe { DeleteObject(HGDIOBJ(region.0)) };
        return Err("Could not apply the rounded selection-float region.".into());
    }

    Ok(())
}

// MinGW links Muda's unused About-dialog object into the unit-test executable,
// but that executable does not receive Tauri's Common Controls v6 manifest.
// The production application is unaffected; tests never invoke this entry point.
#[cfg(test)]
#[no_mangle]
unsafe extern "system" fn TaskDialogIndirect(
    _config: *const std::ffi::c_void,
    _button: *mut i32,
    _radio_button: *mut i32,
    _verification_checked: *mut i32,
) -> i32 {
    0x8000_4001_u32 as i32
}

#[cfg(test)]
mod selection_float_tests {
    use super::*;
    use crate::{
        selection_state::{SelectionController, StateChange},
        windows_selection::CapturedSelection,
    };

    fn visible_controller(text: &str) -> SelectionController {
        let mut controller = SelectionController::default();
        let generation = controller.begin_mouse_up();
        controller.replace_selection(generation, text.into(), Anchor { x: 0, y: 0 });
        controller
    }

    #[test]
    fn connection_test_result_uses_frontend_field_names() {
        let result = serde_json::to_value(ConnectionTestResult {
            latency_ms: 42,
            message: "连接成功".into(),
        })
        .unwrap();

        assert_eq!(result["latencyMs"], 42);
        assert!(result.get("latency_ms").is_none());
    }

    #[test]
    fn float_position_stays_inside_the_monitor_work_area() {
        assert_eq!(
            clamp_float_position(Anchor { x: 188, y: 4 }, 0, 0, 200, 100),
            Anchor { x: 168, y: 8 },
        );
    }

    #[test]
    fn translation_window_prefers_the_right_side_of_the_float() {
        let placement = FloatPlacement {
            x: 100,
            y: 200,
            width: 28,
            work_x: 0,
            work_y: 0,
            work_width: 1200,
            work_height: 800,
        };

        assert_eq!(translation_window_position(placement, 420, 330), Anchor { x: 136, y: 200 });
    }

    #[test]
    fn translation_window_moves_left_when_the_right_side_is_too_small() {
        let placement = FloatPlacement {
            x: 1100,
            y: 200,
            width: 28,
            work_x: 0,
            work_y: 0,
            work_width: 1200,
            work_height: 800,
        };

        assert_eq!(translation_window_position(placement, 420, 330), Anchor { x: 672, y: 200 });
    }

    #[test]
    fn plain_click_after_a_visible_selection_hides_the_float() {
        let mut controller = visible_controller("one");
        let generation = controller.begin_mouse_up();

        assert_eq!(
            handle_mouse_up(&mut controller, generation, CaptureOutcome::Empty, false),
            StateChange::Hide
        );
    }

    #[test]
    fn replacement_selection_keeps_the_float_visible() {
        let mut controller = visible_controller("one");
        let generation = controller.begin_mouse_up();
        let captured = CapturedSelection {
            text: "two".into(),
            anchor: Anchor { x: 20, y: 30 },
        };

        assert!(matches!(
            handle_mouse_up(
                &mut controller,
                generation,
                CaptureOutcome::Detected(captured),
                false,
            ),
            StateChange::Show(_)
        ));
    }

    #[test]
    fn newest_capture_request_replaces_an_older_pending_request() {
        let pending = PendingCapture::default();
        pending.submit(CaptureRequest {
            generation: 1,
            point: windows::Win32::Foundation::POINT { x: 1, y: 2 },
        });
        pending.submit(CaptureRequest {
            generation: 2,
            point: windows::Win32::Foundation::POINT { x: 3, y: 4 },
        });

        let request = pending.take().unwrap();
        assert_eq!(request.generation, 2);
        assert_eq!((request.point.x, request.point.y), (3, 4));
    }

    #[test]
    fn over_limit_capture_hides_a_visible_float() {
        let mut controller = visible_controller("one");
        let generation = controller.begin_mouse_up();

        assert_eq!(
            handle_mouse_up(
                &mut controller,
                generation,
                CaptureOutcome::TooLong { characters: 12_001 },
                false,
            ),
            StateChange::Hide
        );
    }

    #[test]
    fn capture_failure_hides_the_last_valid_selection() {
        let mut controller = visible_controller("one");
        let generation = controller.begin_mouse_up();

        assert_eq!(
            handle_mouse_up(
                &mut controller,
                generation,
                CaptureOutcome::Failed("UIA unavailable".into()),
                false,
            ),
            StateChange::Hide
        );
        assert_eq!(controller.take_for_translation(), None);
    }

    #[test]
    fn translation_target_is_english_when_text_contains_chinese() {
        assert_eq!(translation_target("Xilinx针对7系列FPGA"), "English");
    }

    #[test]
    fn translation_target_is_simplified_chinese_for_non_chinese_text() {
        assert_eq!(translation_target("Physical meaning of poles and zeros"), "Simplified Chinese");
    }

    #[test]
    fn deepseek_thinking_is_explicitly_disabled() {
        let mut payload = serde_json::json!({});
        disable_thinking_for_openai_compatible("deepseek", &mut payload);

        assert_eq!(payload["thinking"], serde_json::json!({ "type": "disabled" }));
    }

    #[test]
    fn vendor_specific_thinking_is_disabled_for_translation() {
        for provider in ["xiaomi", "zhipu", "moonshot"] {
            let mut payload = serde_json::json!({});
            disable_thinking_for_openai_compatible(provider, &mut payload);
            assert_eq!(payload["thinking"], serde_json::json!({ "type": "disabled" }));
        }

        let mut qwen = serde_json::json!({});
        disable_thinking_for_openai_compatible("qwen", &mut qwen);
        assert_eq!(qwen["enable_thinking"], serde_json::json!(false));

        let mut openai = serde_json::json!({});
        disable_thinking_for_openai_compatible("openai", &mut openai);
        assert_eq!(openai, serde_json::json!({}));
    }

    #[test]
    fn openai_compatible_model_ids_keep_only_text_generation_models() {
        let payload = serde_json::json!({
            "data": [
                { "id": "qwen-plus" },
                { "id": "qwen-vl-max" },
                { "id": "qwen-plus" },
                { "id": "text-embedding-v3" },
                { "id": "gte-multilingual-base" },
                { "id": "gte-rerank-v2" },
                { "id": "qwen-image" },
                { "id": "paraformer-asr" },
                { "id": "gpt-4o-realtime-preview" },
                { "id": "creative-v1", "output_modalities": ["image"] }
            ]
        });

        assert_eq!(
            parse_model_ids("qwen", &payload).unwrap(),
            vec!["qwen-plus", "qwen-vl-max"]
        );
    }

    #[test]
    fn google_model_ids_are_normalized_and_non_generation_models_are_filtered() {
        let payload = serde_json::json!({
            "models": [
                { "name": "models/gemini-flash", "supportedGenerationMethods": ["generateContent"] },
                { "name": "models/gemini-image-generation", "supportedGenerationMethods": ["generateContent"] },
                { "name": "models/embedding-001", "supportedGenerationMethods": ["embedContent"] }
            ]
        });

        assert_eq!(parse_model_ids("google", &payload).unwrap(), vec!["gemini-flash"]);
    }

    #[test]
    fn remote_http_provider_urls_are_rejected_but_loopback_is_allowed() {
        assert!(validate_base_url("https://api.example.com/v1").is_ok());
        assert!(validate_base_url("http://localhost:8080/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:8080/v1").is_ok());
        assert!(validate_base_url("http://api.example.com/v1").is_err());
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslationBatch {
    source: String,
    request_id: u64,
    results: Vec<ProviderTranslation>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderTranslation {
    provider_id: String,
    model: String,
    translation: Option<String>,
    error: Option<String>,
}

type LatestTranslation = Mutex<Option<TranslationBatch>>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserPreferences {
    auto_selection: bool,
    keep_on_top: bool,
    #[serde(default)]
    quick_translate_provider: Option<String>,
    #[serde(default)]
    preference_version: u8,
}

impl Default for UserPreferences {
    fn default() -> Self {
        Self {
            auto_selection: true,
            keep_on_top: false,
            quick_translate_provider: None,
            preference_version: USER_PREFERENCES_VERSION,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslationError {
    request_id: u64,
    message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoredProviderConfig {
    api_key: String,
    base_url: String,
    model: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigResponse {
    api_key: String,
    base_url: String,
    model: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionTestResult {
    latency_ms: u128,
    message: String,
}

fn clamp_float_position(
    anchor: Anchor,
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
) -> Anchor {
    let max_x = (work_x + work_width as i32 - FLOAT_SIZE).max(work_x);
    let max_y = (work_y + work_height as i32 - FLOAT_SIZE).max(work_y);
    Anchor {
        x: anchor
            .x
            .saturating_add(6)
            .saturating_sub(FLOAT_PADDING)
            .clamp(work_x, max_x),
        y: anchor
            .y
            .saturating_add(6)
            .saturating_sub(FLOAT_PADDING)
            .clamp(work_y, max_y),
    }
}

const TRANSLATION_WINDOW_GAP: i32 = 8;

#[derive(Clone, Copy, Debug)]
struct FloatPlacement {
    x: i32,
    y: i32,
    width: u32,
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
}

fn translation_window_position(placement: FloatPlacement, window_width: u32, window_height: u32) -> Anchor {
    let work_right = placement.work_x + placement.work_width as i32;
    let max_x = (work_right - window_width as i32).max(placement.work_x);
    let max_y = (placement.work_y + placement.work_height as i32 - window_height as i32)
        .max(placement.work_y);
    let right_x = placement.x
        .saturating_add(placement.width as i32)
        .saturating_add(TRANSLATION_WINDOW_GAP);
    let left_x = placement.x
        .saturating_sub(window_width as i32)
        .saturating_sub(TRANSLATION_WINDOW_GAP);
    let x = if right_x.saturating_add(window_width as i32) <= work_right {
        right_x
    } else {
        left_x
    };

    Anchor {
        x: x.clamp(placement.work_x, max_x),
        y: placement.y.clamp(placement.work_y, max_y),
    }
}

fn handle_mouse_up(
    controller: &mut SelectionController,
    generation: u64,
    captured: CaptureOutcome,
    clicked_float: bool,
) -> StateChange {
    if clicked_float {
        return controller.clear_after_plain_click(generation, true);
    }
    match captured {
        CaptureOutcome::Detected(captured) => {
            controller.replace_selection(generation, captured.text, captured.anchor)
        }
        CaptureOutcome::Empty | CaptureOutcome::TooLong { .. } => {
            controller.clear_after_plain_click(generation, false)
        }
        CaptureOutcome::Failed(_) => controller.clear_after_plain_click(generation, false),
    }
}

#[derive(Clone, Copy, Debug)]
struct CaptureRequest {
    generation: u64,
    point: windows::Win32::Foundation::POINT,
}

#[derive(Default)]
struct PendingCapture {
    request: Mutex<Option<CaptureRequest>>,
    ready: Condvar,
}

impl PendingCapture {
    fn submit(&self, request: CaptureRequest) {
        let mut pending = self
            .request
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *pending = Some(request);
        self.ready.notify_one();
    }

    #[cfg(test)]
    fn take(&self) -> Option<CaptureRequest> {
        self.request
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }

    fn wait(&self) -> CaptureRequest {
        let mut pending = self
            .request
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if let Some(request) = pending.take() {
                return request;
            }
            pending = self
                .ready
                .wait(pending)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

#[derive(Clone)]
struct CaptureScheduler {
    pending: Arc<PendingCapture>,
}

impl CaptureScheduler {
    fn start(app: AppHandle) -> Result<Self, String> {
        let pending = Arc::new(PendingCapture::default());
        let worker_pending = Arc::clone(&pending);
        thread::Builder::new()
            .name("selection-capture".into())
            .spawn(move || loop {
                let request = worker_pending.wait();
                thread::sleep(Duration::from_millis(120));
                if !is_latest_generation(&app, request.generation) {
                    continue;
                }
                if !is_auto_selection_enabled(&app) {
                    apply_mouse_up(&app, request.generation, CaptureOutcome::Empty, false);
                    continue;
                }
                let outcome = capture_selection(request.point);
                apply_mouse_up(&app, request.generation, outcome, false);
            })
            .map_err(|error| format!("could not start selection capture worker: {error}"))?;
        Ok(Self { pending })
    }

    fn submit(&self, request: CaptureRequest) {
        self.pending.submit(request);
    }
}

fn is_latest_generation(app: &AppHandle, generation: u64) -> bool {
    let controller = app.state::<Mutex<SelectionController>>();
    let controller = controller
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    controller.is_latest_generation(generation)
}

fn apply_mouse_up(
    app: &AppHandle,
    generation: u64,
    captured: CaptureOutcome,
    clicked_float: bool,
) {
    let captured = if is_auto_selection_enabled(app) {
        captured
    } else {
        CaptureOutcome::Empty
    };
    let (change, current) = {
        let controller = app.state::<Mutex<SelectionController>>();
        let mut controller = controller.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = controller.is_latest_generation(generation);
        let change = handle_mouse_up(&mut controller, generation, captured.clone(), clicked_float);
        (change, current)
    };

    if !current {
        return;
    }
    match captured {
        CaptureOutcome::TooLong { characters } => eprintln!(
            "Selection ignored: {characters} characters exceeds the 12,000-character limit."
        ),
        CaptureOutcome::Failed(error) => eprintln!("Selection capture failed: {error}"),
        CaptureOutcome::Detected(_) | CaptureOutcome::Empty => {}
    }

    match change {
        StateChange::Show(selection) => {
            if let Err(error) = show_float(app, selection.anchor, selection.generation) {
                eprintln!("Selection float show failed: {error}");
            }
        }
        StateChange::Hide => {
            if let Err(error) = hide_float(app) {
                eprintln!("Selection float hide failed: {error}");
            }
        }
        StateChange::Unchanged => {}
    }
}

fn monitor_for_anchor(window: &WebviewWindow, anchor: &Anchor) -> Result<tauri::Monitor, String> {
    let monitors = window.available_monitors().map_err(|error| error.to_string())?;
    if let Some(monitor) = monitors.iter().find(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        anchor.x >= position.x
            && anchor.x < position.x + size.width as i32
            && anchor.y >= position.y
            && anchor.y < position.y + size.height as i32
    }) {
        return Ok(monitor.clone());
    }

    window.current_monitor().map_err(|error| error.to_string())?
        .or_else(|| monitors.into_iter().next())
        .ok_or_else(|| "No monitor is available for the selection float.".to_string())
}

pub fn show_float(app: &AppHandle, anchor: Anchor, generation: u64) -> Result<(), String> {
    let window = app.get_webview_window("selection-float")
        .ok_or_else(|| "Selection float window is unavailable.".to_string())?;
    let monitor = monitor_for_anchor(&window, &anchor)?;
    let work_area = monitor.work_area();
    let position = clamp_float_position(
        anchor,
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height,
    );

    window.set_position(Position::Physical(PhysicalPosition::new(position.x, position.y)))
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.emit("selection-float:show", serde_json::json!({ "generation": generation }))
        .map_err(|error| error.to_string())
}

pub fn hide_float(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("selection-float")
        .ok_or_else(|| "Selection float window is unavailable.".to_string())?;
    window.hide().map_err(|error| error.to_string())?;
    window.emit("selection-float:hide", ()).map_err(|error| error.to_string())
}

fn show_translation_window(app: &AppHandle, open_quick_translate: bool) {
    match app.get_webview_window("main") {
        Some(window) => {
            if let Err(lock_error) = lock_translation_window(&window) {
                eprintln!("Translation window size lock failed: {lock_error}");
            }
            if let Err(top_error) = window.set_always_on_top(current_preferences(app).keep_on_top) {
                eprintln!("Translation window topmost state update failed: {top_error}");
            }
            if let Err(unminimize_error) = window.unminimize() {
                eprintln!("Translation window restore failed: {unminimize_error}");
            }
            if let Err(show_error) = window.show() {
                eprintln!("Translation window show failed: {show_error}");
            }
            if let Err(focus_error) = window.set_focus() {
                eprintln!("Translation window focus failed: {focus_error}");
            }
            let event_name = if open_quick_translate {
                "quick-translate:open"
            } else {
                "translation-window:open"
            };
            if let Err(event_error) = window.emit(event_name, ()) {
                eprintln!("Translation window open event failed: {event_error}");
            }
        }
        None => eprintln!("Translation error window is unavailable."),
    }
}

fn report_translation_error(app: &AppHandle, request_id: u64, error: &str) {
    show_translation_window(app, false);
    let payload = TranslationError {
        request_id,
        message: error.to_string(),
    };
    if let Err(emit_error) = app.emit("translation-error", payload) {
        eprintln!("Translation error event emission failed: {emit_error}");
    }
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())
}

fn preferences_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, PREFERENCES_ACCOUNT).map_err(|error| error.to_string())
}

fn active_provider_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, ACTIVE_PROVIDER_ACCOUNT).map_err(|error| error.to_string())
}

fn enabled_providers_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, ENABLED_PROVIDERS_ACCOUNT).map_err(|error| error.to_string())
}

fn load_preferences_sync() -> Result<UserPreferences, String> {
    let entry = preferences_entry()?;
    match entry.get_password() {
        Ok(password) => {
            let mut preferences: UserPreferences = serde_json::from_str(&password)
                .map_err(|error| format!("无法读取界面偏好：{error}"))?;
            if preferences.preference_version < USER_PREFERENCES_VERSION {
                // The previous version defaulted to always-on-top. Start the
                // new click-away behavior unpinned, while preserving future
                // pin choices across restarts.
                preferences.keep_on_top = false;
                preferences.preference_version = USER_PREFERENCES_VERSION;
            }
            Ok(preferences)
        }
        Err(_) => Ok(UserPreferences::default()),
    }
}

fn save_preferences_sync(preferences: &UserPreferences) -> Result<(), String> {
    let serialized = serde_json::to_string(preferences)
        .map_err(|error| format!("无法序列化界面偏好：{error}"))?;
    preferences_entry()?
        .set_password(&serialized)
        .map_err(|error| format!("无法保存界面偏好：{error}"))
}

fn current_preferences(app: &AppHandle) -> UserPreferences {
    app.state::<Mutex<UserPreferences>>()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn is_auto_selection_enabled(app: &AppHandle) -> bool {
    current_preferences(app).auto_selection
}

fn next_translation_request_id() -> u64 {
    NEXT_TRANSLATION_REQUEST_ID.fetch_add(1, Ordering::Relaxed) + 1
}

fn supported_provider(provider: &str) -> bool {
    matches!(
        provider,
        "deepseek" | "xiaomi" | "qwen" | "zhipu" | "moonshot" | "openai" | "google" | "anthropic"
    )
}

fn provider_keyring_entry(provider: &str) -> Result<Entry, String> {
    if !supported_provider(provider) {
        return Err(format!("不支持的 AI 提供商：{provider}"));
    }
    Entry::new(KEYRING_SERVICE, &format!("{PROVIDER_KEYRING_PREFIX}{provider}"))
        .map_err(|error| error.to_string())
}

fn stored_provider_config(provider: &str) -> Result<StoredProviderConfig, String> {
    let password = provider_keyring_entry(provider)?
        .get_password()
        .map_err(|_| format!("请先保存 {provider} 的 API Key。"))?;
    serde_json::from_str(&password).map_err(|error| format!("无法读取 {provider} 配置：{error}"))
}

fn provider_api_key(provider: &str, api_key: &str) -> Result<String, String> {
    let value = api_key.trim();
    if !value.is_empty() {
        return Ok(value.to_string());
    }
    stored_provider_config(provider).map(|config| config.api_key).or_else(|error| {
        if provider == "deepseek" {
            legacy_api_key()
        } else {
            Err(error)
        }
    })
}

fn legacy_api_key() -> Result<String, String> {
    keyring_entry()?.get_password().map_err(|_| "请先在设置中保存 DeepSeek API Key。".to_string())
}

fn active_provider_sync() -> String {
    active_provider_entry()
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .ok()
        .filter(|provider| supported_provider(provider))
        .unwrap_or_else(|| "deepseek".to_string())
}

fn enabled_providers_sync() -> Vec<String> {
    enabled_providers_entry()
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .ok()
        .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .map(|providers| {
            providers
                .into_iter()
                .filter(|provider| supported_provider(provider))
                .fold(Vec::new(), |mut unique, provider| {
                    if !unique.contains(&provider) {
                        unique.push(provider);
                    }
                    unique
                })
        })
        .unwrap_or_else(|| {
            let provider = active_provider_sync();
            configured_provider(&provider)
                .is_ok()
                .then_some(vec![provider])
                .unwrap_or_default()
        })
}

fn save_enabled_providers_sync(providers: &[String]) -> Result<(), String> {
    let serialized = serde_json::to_string(providers)
        .map_err(|error| format!("无法序列化启用模型列表：{error}"))?;
    enabled_providers_entry()?
        .set_password(&serialized)
        .map_err(|error| format!("无法保存启用模型列表：{error}"))
}

fn configured_provider(provider: &str) -> Result<StoredProviderConfig, String> {
    let config = match stored_provider_config(provider) {
        Ok(config) => config,
        Err(_) if provider == "deepseek" => {
            return Ok(StoredProviderConfig {
                api_key: legacy_api_key()?,
                base_url: DEEPSEEK_BASE_URL.to_string(),
                model: DEEPSEEK_MODEL.to_string(),
            });
        }
        Err(error) => return Err(error),
    };
    if config.api_key.trim().is_empty() {
        return Err(format!("{provider} API Key 不能为空。"));
    }
    if config.base_url.trim().is_empty() {
        return Err(format!("{provider} Base URL 不能为空。"));
    }
    validate_base_url(&config.base_url)?;
    if config.model.trim().is_empty() {
        return Err(format!("{provider} 模型名称不能为空。"));
    }
    Ok(config)
}

fn disable_thinking_for_openai_compatible(provider: &str, body: &mut serde_json::Value) {
    match provider {
        "qwen" => body["enable_thinking"] = serde_json::json!(false),
        "deepseek" | "xiaomi" | "zhipu" | "moonshot" => {
            body["thinking"] = serde_json::json!({ "type": DEEPSEEK_THINKING_DISABLED });
        }
        // OpenAI chat models and Anthropic Messages do not enable extended
        // reasoning unless a reasoning/thinking option is explicitly sent.
        _ => {}
    }
}

async fn request_translation(provider: String, text: String) -> Result<ProviderTranslation, String> {
    let config = configured_provider(&provider)?;
    let target = translation_target(&text);
    let prompt = format!(
        "Translate the following text into natural {target}. The target language is fixed by the application; do not answer in the source language, even when the input mixes Chinese and English terms. Preserve product names, model names, acronyms, and technical notation. Return only the translation, without notes or quotation marks.\n\n{text}"
    );
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("无法初始化网络连接：{error}"))?;
    let response = match provider.as_str() {
        "google" => {
            let endpoint = format!(
                "{}/models/{}:generateContent",
                config.base_url.trim().trim_end_matches('/'),
                config.model.trim()
            );
            client.post(endpoint)
                .header("x-goog-api-key", &config.api_key)
                .json(&serde_json::json!({
                    "systemInstruction": { "parts": [{ "text": "You are a precise translation engine." }] },
                    "contents": [{ "parts": [{ "text": prompt }] }],
                    "generationConfig": {
                        "temperature": 0.2,
                        "thinkingConfig": { "thinkingBudget": 0 }
                    }
                }))
                .send().await
        }
        "anthropic" => client
            .post(append_endpoint(&config.base_url, "messages"))
            .header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&serde_json::json!({
                "model": config.model.trim(),
                "max_tokens": 4096,
                "system": "You are a precise translation engine.",
                "messages": [{ "role": "user", "content": prompt }],
                "temperature": 0.2
            }))
            .send().await,
        _ => {
            let mut body = serde_json::json!({
                "model": config.model.trim(),
                "messages": [
                    { "role": "system", "content": "You are a precise translation engine." },
                    { "role": "user", "content": prompt }
                ],
                "stream": false,
                "temperature": 0.2
            });
            disable_thinking_for_openai_compatible(&provider, &mut body);
            client.post(append_endpoint(&config.base_url, "chat/completions"))
                .bearer_auth(&config.api_key).json(&body).send().await
        }
    }
    .map_err(|error| format!("无法连接 {provider}：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default().chars().take(400).collect::<String>();
        return Ok(ProviderTranslation {
            provider_id: provider,
            model: config.model,
            translation: None,
            error: Some(format!("请求失败（{status}）：{detail}")),
        });
    }
    let payload: serde_json::Value = match response.json().await {
        Ok(payload) => payload,
        Err(error) => return Ok(ProviderTranslation {
            provider_id: provider,
            model: config.model,
            translation: None,
            error: Some(format!("无法解析响应：{error}")),
        }),
    };
    let translation = match provider.as_str() {
        "google" => payload.pointer("/candidates/0/content/parts/0/text"),
        "anthropic" => payload.pointer("/content/0/text"),
        _ => payload.pointer("/choices/0/message/content"),
    }
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string);
    Ok(ProviderTranslation {
        provider_id: provider,
        model: config.model,
        error: translation.is_none().then(|| "没有返回翻译结果。".to_string()),
        translation,
    })
}

fn append_endpoint(base_url: &str, endpoint: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with(endpoint) {
        base.to_string()
    } else {
        format!("{base}/{endpoint}")
    }
}

fn validate_base_url(base_url: &str) -> Result<(), String> {
    let base_url = base_url.trim();
    if base_url.is_empty() {
        return Err("Base URL 不能为空。".to_string());
    }
    let url = reqwest::Url::parse(base_url)
        .map_err(|_| "Base URL 必须是有效的 HTTPS URL。".to_string())?;
    match url.scheme() {
        "https" => Ok(()),
        "http" if matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")) => Ok(()),
        "http" => Err("出于安全原因，远程 HTTP Base URL 不被允许，请改用 HTTPS。".to_string()),
        _ => Err("Base URL 必须使用 HTTPS；本机服务可使用 HTTP。".to_string()),
    }
}

async fn send_connection_test(
    provider: &str,
    api_key: &str,
    base_url: &str,
    model: &str,
) -> Result<(), String> {
    validate_base_url(base_url)?;
    if model.trim().is_empty() {
        return Err("模型名称不能为空。".to_string());
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("无法初始化网络连接：{error}"))?;

    let response = match provider {
        "google" => {
            let endpoint = format!(
                "{}/models/{}:generateContent",
                base_url.trim().trim_end_matches('/'),
                model.trim()
            );
            client
                .post(endpoint)
                .header("x-goog-api-key", api_key)
                .json(&serde_json::json!({
                    "contents": [{ "parts": [{ "text": "Reply with OK only." }] }],
                    "generationConfig": { "maxOutputTokens": 8 }
                }))
                .send()
                .await
        }
        "anthropic" => {
            let endpoint = append_endpoint(base_url, "messages");
            client
                .post(endpoint)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&serde_json::json!({
                    "model": model.trim(),
                    "max_tokens": 8,
                    "messages": [{ "role": "user", "content": "Reply with OK only." }]
                }))
                .send()
                .await
        }
        _ => {
            let endpoint = append_endpoint(base_url, "chat/completions");
            let mut body = serde_json::json!({
                "model": model.trim(),
                "messages": [{ "role": "user", "content": "Reply with OK only." }],
                "max_tokens": 8,
                "temperature": 0,
                "stream": false
            });
            if provider == "deepseek" {
                body["thinking"] = serde_json::json!({ "type": DEEPSEEK_THINKING_DISABLED });
            }
            client.post(endpoint).bearer_auth(api_key).json(&body).send().await
        }
    }
    .map_err(|error| format!("网络请求失败：{error}"))?;

    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let detail = response.text().await.unwrap_or_default();
    let detail = detail.chars().take(400).collect::<String>();
    Err(format!("请求失败（{status}）：{detail}"))
}

fn modality_list_supports(entry: &serde_json::Value, keys: &[&str], modality: &str) -> Option<bool> {
    keys.iter().find_map(|key| {
        entry.get(key).and_then(serde_json::Value::as_array).map(|modalities| {
            modalities.iter().any(|value| {
                value.as_str().is_some_and(|value| value.eq_ignore_ascii_case(modality))
            })
        })
    })
}

fn model_id_is_suitable_for_translation(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    const NON_TEXT_MODEL_MARKERS: &[&str] = &[
        "embedding", "embed-", "-embed", "rerank", "moderation", "classifier",
        "guard", "bge-", "gte-", "text2vec", "whisper", "transcri", "speech",
        "tts", "-asr", "audio", "voice", "realtime", "computer-use",
        "dall-e", "image", "imagen", "stable-diffusion", "cogview", "flux",
        "video", "sora", "veo-", "wanx", "-t2v", "-i2v", "cogvideo", "ocr",
    ];

    !NON_TEXT_MODEL_MARKERS.iter().any(|marker| model.contains(marker))
}

fn model_entry_supports_translation(provider: &str, entry: &serde_json::Value, model: &str) -> bool {
    if provider == "google" {
        let supports_generate = entry.get("supportedGenerationMethods")
            .and_then(serde_json::Value::as_array)
            .map(|methods| methods.iter().any(|method| method.as_str() == Some("generateContent")))
            .unwrap_or(false);
        if !supports_generate {
            return false;
        }
    }

    if modality_list_supports(entry, &["input_modalities", "supported_input_modalities"], "text") == Some(false)
        || modality_list_supports(entry, &["output_modalities", "supported_output_modalities"], "text") == Some(false)
    {
        return false;
    }

    model_id_is_suitable_for_translation(model)
}

fn parse_model_ids(provider: &str, payload: &serde_json::Value) -> Result<Vec<String>, String> {
    let entries = if provider == "google" {
        payload.get("models").and_then(serde_json::Value::as_array)
    } else {
        payload.get("data").and_then(serde_json::Value::as_array)
    }
    .ok_or_else(|| "接口没有返回可识别的模型列表。".to_string())?;
    let mut models = entries.iter().filter_map(|entry| {
        let model = if provider == "google" {
            entry.get("name")?.as_str()?.trim_start_matches("models/")
        } else {
            entry.get("id")?.as_str()?
        };
        (!model.trim().is_empty() && model_entry_supports_translation(provider, entry, model))
            .then(|| model.to_string())
    }).collect::<Vec<_>>();
    models.sort_unstable();
    models.dedup();
    if models.is_empty() {
        return Err("接口没有返回可用于文本翻译的模型。".to_string());
    }
    Ok(models)
}

async fn fetch_models(
    provider: &str,
    api_key: &str,
    base_url: &str,
) -> Result<Vec<String>, String> {
    validate_base_url(base_url)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("无法初始化网络连接：{error}"))?;
    let endpoint = append_endpoint(base_url, "models");
    let response = match provider {
        "google" => client
            .get(format!("{endpoint}?pageSize=1000"))
            .header("x-goog-api-key", api_key)
            .send()
            .await,
        "anthropic" => client
            .get(format!("{endpoint}?limit=1000"))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .send()
            .await,
        _ => client.get(endpoint).bearer_auth(api_key).send().await,
    }
    .map_err(|error| format!("获取模型列表失败：{error}"))?;

    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default().chars().take(400).collect::<String>();
        return Err(format!("获取模型列表失败（{status}）：{detail}"));
    }
    let payload: serde_json::Value = response.json().await
        .map_err(|error| format!("无法解析模型列表：{error}"))?;
    parse_model_ids(provider, &payload)
}

fn translation_target(text: &str) -> &'static str {
    if text.chars().any(is_cjk_character) {
        "English"
    } else {
        "Simplified Chinese"
    }
}

fn is_cjk_character(character: char) -> bool {
    matches!(
        character,
        '\u{3400}'..='\u{4DBF}'
            | '\u{4E00}'..='\u{9FFF}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{20000}'..='\u{2FA1F}'
    )
}

fn capture_float_placement(app: &AppHandle) -> Result<FloatPlacement, String> {
    let window = app.get_webview_window("selection-float")
        .ok_or_else(|| "Selection float window is unavailable.".to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let monitor = monitor_for_anchor(&window, &Anchor { x: position.x, y: position.y })?;
    let work_area = monitor.work_area();

    Ok(FloatPlacement {
        x: position.x,
        y: position.y,
        width: size.width,
        work_x: work_area.position.x,
        work_y: work_area.position.y,
        work_width: work_area.size.width,
        work_height: work_area.size.height,
    })
}

fn position_translation_window(window: &WebviewWindow, placement: FloatPlacement) -> Result<(), String> {
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let position = translation_window_position(placement, size.width, size.height);
    window.set_position(Position::Physical(PhysicalPosition::new(position.x, position.y)))
        .map_err(|error| error.to_string())
}

fn lock_translation_window(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_size(Size::Logical(LogicalSize::new(
            TRANSLATION_WINDOW_WIDTH,
            TRANSLATION_WINDOW_HEIGHT,
        )))
        .map_err(|error| error.to_string())?;
    window.set_resizable(false).map_err(|error| error.to_string())?;
    window.set_minimizable(true).map_err(|error| error.to_string())
}

fn publish_provider_result(
    app: &AppHandle,
    request_id: u64,
    provider_result: &ProviderTranslation,
) {
    let snapshot = {
        let latest = app.state::<LatestTranslation>();
        let mut latest = latest.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(batch) = latest.as_mut().filter(|batch| batch.request_id == request_id) else {
            return;
        };
        if let Some(result) = batch.results.iter_mut()
            .find(|result| result.provider_id == provider_result.provider_id)
        {
            *result = provider_result.clone();
        }
        batch.clone()
    };
    if let Err(error) = app.emit("translation-result", snapshot) {
        eprintln!("Incremental translation result emission failed: {error}");
    }
}

async fn translate_and_display(
    app: AppHandle,
    text: String,
    float_placement: Option<FloatPlacement>,
    requested_provider: Option<String>,
    request_id: u64,
) -> Result<TranslationBatch, String> {
    let source = text.trim().to_string();
    if source.is_empty() { return Err("没有可翻译的文本。".to_string()); }
    if source.chars().count() > 12_000 {
        return Err("单次翻译最多支持 12,000 个字符。".to_string());
    }
    let enabled_providers = enabled_providers_sync();
    if enabled_providers.is_empty() {
        return Err("请先在设置中启用至少一个翻译模型。".to_string());
    }
    let providers = if let Some(provider) = requested_provider {
        if !enabled_providers.contains(&provider) {
            return Err("所选模型未启用，请重新选择。".to_string());
        }
        vec![provider]
    } else {
        enabled_providers
    };
    let pending_result = TranslationBatch {
        source: source.clone(),
        request_id,
        results: providers.iter().map(|provider| ProviderTranslation {
            provider_id: provider.clone(),
            model: configured_provider(provider).map(|config| config.model).unwrap_or_default(),
            translation: None,
            error: None,
        }).collect(),
    };
    {
        let latest = app.state::<LatestTranslation>();
        *latest.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(pending_result.clone());
    }
    let window = app.get_webview_window("main").ok_or_else(|| "未找到结果窗口。".to_string())?;
    lock_translation_window(&window)?;
    if let Some(placement) = float_placement {
        position_translation_window(&window, placement)?;
    }
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    window
        .set_always_on_top(current_preferences(&app).keep_on_top)
        .map_err(|error| error.to_string())?;
    app.emit("translation-started", &pending_result).map_err(|error| error.to_string())?;

    let mut pending = Vec::with_capacity(providers.len());
    for provider in providers {
        let request_text = source.clone();
        let task_provider = provider.clone();
        let task_app = app.clone();
        pending.push((provider.clone(), tauri::async_runtime::spawn(async move {
            let result = match request_translation(task_provider, request_text).await {
                Ok(result) => result,
                Err(error) => ProviderTranslation {
                    provider_id: provider,
                    model: String::new(),
                    translation: None,
                    error: Some(error),
                },
            };
            publish_provider_result(&task_app, request_id, &result);
            result
        })));
    }
    let mut results = Vec::with_capacity(pending.len());
    for (provider, task) in pending {
        let result = match task.await {
            Ok(result) => result,
            Err(error) => ProviderTranslation {
                provider_id: provider,
                model: String::new(),
                translation: None,
                error: Some(format!("翻译任务失败：{error}")),
            },
        };
        results.push(result);
    }
    let result = TranslationBatch { source, request_id, results };
    let is_current = {
        let latest = app.state::<LatestTranslation>();
        let mut latest = latest.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if latest.as_ref().is_some_and(|batch| batch.request_id == request_id) {
            *latest = Some(result.clone());
            true
        } else {
            false
        }
    };
    if is_current {
        app.emit("translation-result", &result).map_err(|error| error.to_string())?;
    }
    Ok(result)
}

#[tauri::command]
async fn translate_text(app: AppHandle, text: String, provider: Option<String>) -> Result<TranslationBatch, String> {
    translate_and_display(app, text, None, provider, next_translation_request_id()).await
}

#[tauri::command]
fn get_latest_translation(app: AppHandle) -> Option<TranslationBatch> {
    app.state::<LatestTranslation>()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[tauri::command]
fn save_api_key(api_key: String) -> Result<(), String> {
    let value = api_key.trim();
    if value.is_empty() { return Err("API Key 不能为空。".to_string()); }
    keyring_entry()?.set_password(value).map_err(|error| format!("无法保存 API Key：{error}"))
}

fn save_provider_config_sync(
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
) -> Result<(), String> {
    if !supported_provider(&provider) {
        return Err(format!("不支持的 AI 提供商：{provider}"));
    }
    if base_url.trim().is_empty() || model.trim().is_empty() {
        return Err("Base URL 和模型名称不能为空。".to_string());
    }
    validate_base_url(&base_url)?;
    let key = if api_key.trim().is_empty() {
        stored_provider_config(&provider).map(|config| config.api_key).or_else(|error| {
            if provider == "deepseek" {
                legacy_api_key()
            } else {
                Err(error)
            }
        })?
    } else {
        api_key.trim().to_string()
    };
    if key.is_empty() {
        return Err("API Key 不能为空。".to_string());
    }
    let config = StoredProviderConfig {
        api_key: key.clone(),
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        model: model.trim().to_string(),
    };
    let serialized = serde_json::to_string(&config).map_err(|error| format!("无法序列化配置：{error}"))?;
    provider_keyring_entry(&provider)?.set_password(&serialized)
        .map_err(|error| format!("无法保存 {provider} 配置：{error}"))?;
    if provider == "deepseek" {
        keyring_entry()?.set_password(&key)
            .map_err(|error| format!("无法同步保存 DeepSeek API Key：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn save_provider_config(
    app: AppHandle,
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
) -> Result<(), String> {
    let saved_provider = provider.clone();
    tauri::async_runtime::spawn_blocking(move || {
        save_provider_config_sync(provider, api_key, base_url, model)
    })
    .await
    .map_err(|error| format!("保存配置任务失败：{error}"))??;
    if enabled_providers_sync().contains(&saved_provider) {
        app.emit("enabled-providers-changed", enabled_providers_sync())
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn get_provider_config(provider: String) -> Result<Option<ProviderConfigResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = provider_keyring_entry(&provider)?;
        let Ok(password) = entry.get_password() else {
            if provider == "deepseek" {
                if let Ok(api_key) = legacy_api_key() {
                    return Ok(Some(ProviderConfigResponse {
                        api_key,
                        base_url: DEEPSEEK_BASE_URL.to_string(),
                        model: DEEPSEEK_MODEL.to_string(),
                    }));
                }
            }
            return Ok(None);
        };
        let config: StoredProviderConfig = serde_json::from_str(&password)
            .map_err(|error| format!("无法读取 {provider} 配置：{error}"))?;
        Ok(Some(ProviderConfigResponse {
            api_key: config.api_key,
            base_url: config.base_url,
            model: config.model,
        }))
    })
    .await
    .map_err(|error| format!("读取配置任务失败：{error}"))?
}

#[tauri::command]
async fn test_provider_connection(
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
) -> Result<ConnectionTestResult, String> {
    if !supported_provider(&provider) {
        return Err(format!("不支持的 AI 提供商：{provider}"));
    }
    let key = provider_api_key(&provider, &api_key)?;
    let started = Instant::now();
    send_connection_test(&provider, &key, &base_url, &model).await?;
    Ok(ConnectionTestResult {
        latency_ms: started.elapsed().as_millis(),
        message: "连接成功".to_string(),
    })
}

#[tauri::command]
async fn fetch_provider_models(
    provider: String,
    api_key: String,
    base_url: String,
) -> Result<Vec<String>, String> {
    if !supported_provider(&provider) {
        return Err(format!("不支持的 AI 提供商：{provider}"));
    }
    let key = provider_api_key(&provider, &api_key)?;
    fetch_models(&provider, &key, &base_url).await
}

#[tauri::command]
async fn get_active_provider() -> String {
    tauri::async_runtime::spawn_blocking(active_provider_sync)
        .await
        .unwrap_or_else(|_| "deepseek".to_string())
}

#[tauri::command]
async fn set_active_provider(app: AppHandle, provider: String) -> Result<String, String> {
    let selected_provider = provider.clone();
    let model = tauri::async_runtime::spawn_blocking(move || {
        if !supported_provider(&provider) {
            return Err(format!("不支持的 AI 提供商：{provider}"));
        }
        let config = configured_provider(&provider)?;
        active_provider_entry()?
            .set_password(&provider)
            .map_err(|error| format!("无法保存当前翻译模型：{error}"))?;
        Ok(config.model)
    })
    .await
    .map_err(|error| format!("切换翻译模型任务失败：{error}"))??;
    app.emit("active-provider-changed", serde_json::json!({
        "providerId": selected_provider,
        "model": model,
    }))
    .map_err(|error| error.to_string())?;
    Ok(selected_provider)
}

#[tauri::command]
async fn get_enabled_providers() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(enabled_providers_sync)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn set_provider_enabled(
    app: AppHandle,
    provider: String,
    enabled: bool,
) -> Result<Vec<String>, String> {
    let providers = tauri::async_runtime::spawn_blocking(move || {
        if !supported_provider(&provider) {
            return Err(format!("不支持的 AI 提供商：{provider}"));
        }
        let mut providers = enabled_providers_sync();
        if enabled {
            configured_provider(&provider)?;
            if !providers.contains(&provider) {
                providers.push(provider);
            }
        } else {
            providers.retain(|item| item != &provider);
            if providers.is_empty() {
                return Err("至少需要保留一个启用的翻译模型。".to_string());
            }
        }
        save_enabled_providers_sync(&providers)?;
        Ok(providers)
    })
    .await
    .map_err(|error| format!("更新启用模型任务失败：{error}"))??;
    app.emit("enabled-providers-changed", &providers)
        .map_err(|error| error.to_string())?;
    Ok(providers)
}

#[tauri::command]
async fn has_api_key() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        enabled_providers_sync()
            .iter()
            .any(|provider| configured_provider(provider).is_ok())
    })
        .await
        .unwrap_or(false)
}

#[tauri::command]
fn get_preferences(app: AppHandle) -> UserPreferences {
    current_preferences(&app)
}

#[tauri::command]
async fn save_preferences(
    app: AppHandle,
    auto_selection: bool,
    keep_on_top: bool,
    quick_translate_provider: Option<String>,
) -> Result<UserPreferences, String> {
    let preferences = UserPreferences {
        auto_selection,
        keep_on_top,
        quick_translate_provider,
        preference_version: USER_PREFERENCES_VERSION,
    };
    let saved_preferences = preferences.clone();
    tauri::async_runtime::spawn_blocking(move || save_preferences_sync(&saved_preferences))
        .await
        .map_err(|error| format!("保存偏好任务失败：{error}"))??;

    {
        let state = app.state::<Mutex<UserPreferences>>();
        *state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = preferences.clone();
    }
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_always_on_top(preferences.keep_on_top)
            .map_err(|error| error.to_string())?;
    }
    if !preferences.auto_selection {
        if let Err(error) = hide_float(&app) {
            eprintln!("Selection float hide failed after disabling auto selection: {error}");
        }
    }
    Ok(preferences)
}

#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main").ok_or_else(|| "未找到结果窗口。".to_string())?
        .hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn minimize_window(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.set_size(Size::Logical(LogicalSize::new(1120.0, 760.0))).map_err(|error| error.to_string())?;
        window.set_resizable(false).map_err(|error| error.to_string())?;
        window.set_minimizable(true).map_err(|error| error.to_string())?;
        window.set_always_on_top(false).map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .inner_size(1120.0, 760.0)
        .min_inner_size(900.0, 620.0)
        .title("AI Translate 设置")
        .decorations(false)
        .shadow(true)
        .transparent(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .minimizable(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                if let Err(error) = window.set_always_on_top(false) {
                    eprintln!("Settings window topmost reset after page load failed: {error}");
                }
                if let Err(error) = window.show() {
                    eprintln!("Settings window show after page load failed: {error}");
                }
                if let Err(error) = window.set_focus() {
                    eprintln!("Settings window focus after page load failed: {error}");
                }
            }
        })
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn spawn_settings_window(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        if let Err(error) = show_settings_window(&app) {
            eprintln!("Could not open settings window from the tray menu: {error}");
        }
    });
}

#[tauri::command]
async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    show_settings_window(&app)
}

#[tauri::command]
fn hide_settings_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("settings")
        .ok_or_else(|| "未找到设置窗口".to_string())?
        .hide()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn translate_selection_float(app: AppHandle) -> Result<(), String> {
    let request_id = next_translation_request_id();
    let selection = {
        let controller = app.state::<Mutex<SelectionController>>();
        let mut controller = controller.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        controller.take_for_translation()
    };
    let Some(selection) = selection else {
        let error = "没有待翻译的选中文本。".to_string();
        report_translation_error(&app, request_id, &error);
        return Err(error);
    };

    let text = selection.text.clone();
    let float_placement = capture_float_placement(&app).ok();
    if let Err(error) = hide_float(&app) {
        eprintln!("Selection float hide failed before translation: {error}");
    }
    match translate_and_display(app.clone(), text, float_placement, None, request_id).await {
        Ok(_) => Ok(()),
        Err(error) => {
            let restored = {
                let controller = app.state::<Mutex<SelectionController>>();
                let mut controller = controller.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                controller.restore_after_translation_failure(selection.clone())
            };
            if restored {
                if let Err(show_error) = show_float(&app, selection.anchor, selection.generation) {
                    eprintln!("Selection float restore failed after translation error: {show_error}");
                }
            }
            report_translation_error(&app, request_id, &error);
            Err(error)
        }
    }
}

fn initialize_tray_icon(app: &tauri::App) -> Result<(), String> {
    let icon = TauriImage::from_bytes(include_bytes!("../icons/tray-icon.png"))
        .map_err(|error| format!("Could not load the tray icon asset: {error}"))?;
    let settings_item = MenuItemBuilder::with_id("settings", "设置")
        .build(app)
        .map_err(|error| error.to_string())?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出")
        .build(app)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&settings_item, &quit_item])
        .map_err(|error| error.to_string())?;

    TrayIconBuilder::with_id("ai-translate-tray")
        .icon(icon)
        .tooltip("AI Translate")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "settings" => spawn_settings_window(app),
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_translation_window(tray.app_handle(), true);
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn initialize_selection_float(app: &tauri::App) -> Result<(), String> {
    let window =
        WebviewWindowBuilder::new(app, "selection-float", WebviewUrl::App("index.html".into()))
            .inner_size(FLOAT_SIZE as f64, FLOAT_SIZE as f64)
            .min_inner_size(FLOAT_SIZE as f64, FLOAT_SIZE as f64)
            .max_inner_size(FLOAT_SIZE as f64, FLOAT_SIZE as f64)
            .title("")
            .decorations(false)
            .shadow(false)
            .transparent(true)
            .background_color(Color(0, 0, 0, 0))
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .focusable(false)
            .visible(false)
            .build()
            .map_err(|error| error.to_string())?;

    let result = (|| {
        let float_window = window.hwnd().map_err(|error| error.to_string())?;
        shape_float_window_as_round_rect(float_window)?;
        let mouse_app = app.handle().clone();
        let scheduler = CaptureScheduler::start(mouse_app.clone())?;
        mouse_hook::start_mouse_hook(float_window, move |event| {
            let generation = {
                let controller = mouse_app.state::<Mutex<SelectionController>>();
                let mut controller = controller
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if event.selection_gesture && !event.clicked_float {
                    controller.begin_selection_capture()
                } else {
                    controller.begin_mouse_up()
                }
            };
            if event.clicked_float {
                return;
            }
            if !is_auto_selection_enabled(&mouse_app) {
                apply_mouse_up(&mouse_app, generation, CaptureOutcome::Empty, false);
                return;
            }
            if !event.selection_gesture {
                apply_mouse_up(&mouse_app, generation, CaptureOutcome::Empty, false);
                return;
            }
            if let Err(error) = hide_float(&mouse_app) {
                eprintln!("Previous selection float hide failed before capture: {error}");
            }
            scheduler.submit(CaptureRequest {
                generation,
                point: event.point,
            });
        })
        .map_err(|error| error.to_string())
    })();

    if let Err(error) = result {
        if let Err(close_error) = window.close() {
            eprintln!("Partially initialized selection float could not be closed: {close_error}");
        }
        return Err(error);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let preferences = load_preferences_sync().unwrap_or_else(|error| {
        eprintln!("Could not load interface preferences, using defaults: {error}");
        UserPreferences::default()
    });
    tauri::Builder::default()
        .manage(Mutex::<SelectionController>::default())
        .manage(Mutex::new(preferences))
        .manage(Mutex::new(None::<TranslationBatch>))
        .setup(move |app| {
            initialize_tray_icon(app)?;
            if let Err(error) = initialize_selection_float(app) {
                eprintln!("Selection float disabled: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            translate_text,
            get_latest_translation,
            translate_selection_float,
            save_api_key,
            save_provider_config,
            get_provider_config,
            test_provider_connection,
            fetch_provider_models,
            get_active_provider,
            set_active_provider,
            get_enabled_providers,
            set_provider_enabled,
            has_api_key,
            get_preferences,
            save_preferences,
            hide_window,
            minimize_window,
            open_settings_window,
            hide_settings_window,
        ])
        .run(tauri::generate_context!())
        .expect("启动 AI Translate 失败");
}
