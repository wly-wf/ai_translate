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
const PROVIDER_KEYRING_PREFIX: &str = "provider-config:";
const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
const DEEPSEEK_URL: &str = "https://api.deepseek.com/chat/completions";
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
        let payload = serde_json::to_value(ThinkingConfig {
            mode: DEEPSEEK_THINKING_DISABLED,
        })
        .unwrap();

        assert_eq!(payload, serde_json::json!({ "type": "disabled" }));
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
struct Translation {
    source: String,
    translation: String,
    request_id: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserPreferences {
    auto_selection: bool,
    keep_on_top: bool,
    #[serde(default)]
    preference_version: u8,
}

impl Default for UserPreferences {
    fn default() -> Self {
        Self {
            auto_selection: true,
            keep_on_top: false,
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
struct ConnectionTestResult {
    latency_ms: u128,
    message: String,
}

#[derive(Serialize)]
struct ChatMessage<'a> { role: &'a str, content: &'a str }
#[derive(Serialize)]
struct ThinkingConfig { #[serde(rename = "type")] mode: &'static str }
#[derive(Serialize)]
struct DeepSeekRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    // DeepSeek defaults thinking to enabled, so disable it explicitly for translation.
    thinking: ThinkingConfig,
    stream: bool,
    temperature: f32,
}
#[derive(Deserialize)]
struct DeepSeekResponse { choices: Vec<DeepSeekChoice> }
#[derive(Deserialize)]
struct DeepSeekChoice { message: DeepSeekMessage }
#[derive(Deserialize)]
struct DeepSeekMessage { content: Option<String> }

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

fn configured_deepseek() -> Result<(String, String, String), String> {
    let config = match stored_provider_config("deepseek") {
        Ok(config) => config,
        Err(_) => {
            return Ok((
                legacy_api_key()?,
                DEEPSEEK_URL.to_string(),
                DEEPSEEK_MODEL.to_string(),
            ));
        }
    };
    if config.api_key.trim().is_empty() {
        return Err("DeepSeek API Key 不能为空。".to_string());
    }
    if config.base_url.trim().is_empty() {
        return Err("DeepSeek Base URL 不能为空。".to_string());
    }
    validate_base_url(&config.base_url)?;
    if config.model.trim().is_empty() {
        return Err("DeepSeek 模型名称不能为空。".to_string());
    }
    Ok((
        config.api_key,
        append_endpoint(&config.base_url, "chat/completions"),
        config.model,
    ))
}

async fn request_translation(text: &str) -> Result<String, String> {
    let (key, endpoint, model) = configured_deepseek()?;
    let target = translation_target(text);
    let prompt = format!(
        "Translate the following text into natural {target}. The target language is fixed by the application; do not answer in the source language, even when the input mixes Chinese and English terms. Preserve product names, model names, acronyms, and technical notation. Return only the translation, without notes or quotation marks.\n\n{text}"
    );
    let body = DeepSeekRequest {
        model: model.trim(),
        messages: vec![
            ChatMessage { role: "system", content: "You are a precise translation engine." },
            ChatMessage { role: "user", content: &prompt },
        ],
        thinking: ThinkingConfig { mode: DEEPSEEK_THINKING_DISABLED },
        stream: false,
        temperature: 0.2,
    };
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("无法初始化网络连接：{error}"))?;
    let response = client.post(endpoint).bearer_auth(key).json(&body).send().await
        .map_err(|error| format!("无法连接 DeepSeek：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("DeepSeek 请求失败（{status}）：{detail}"));
    }
    let payload: DeepSeekResponse = response.json().await
        .map_err(|error| format!("无法解析 DeepSeek 响应：{error}"))?;
    payload.choices.into_iter().next().and_then(|choice| choice.message.content)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "DeepSeek 没有返回翻译结果。".to_string())
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

async fn translate_and_display(
    app: AppHandle,
    text: String,
    float_placement: Option<FloatPlacement>,
    request_id: u64,
) -> Result<Translation, String> {
    let source = text.trim().to_string();
    if source.is_empty() { return Err("没有可翻译的文本。".to_string()); }
    if source.chars().count() > 12_000 {
        return Err("单次翻译最多支持 12,000 个字符。".to_string());
    }
    let result = Translation {
        translation: request_translation(&source).await?,
        source,
        request_id,
    };
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
    app.emit("translation-result", &result).map_err(|error| error.to_string())?;
    Ok(result)
}

#[tauri::command]
async fn translate_text(app: AppHandle, text: String) -> Result<Translation, String> {
    translate_and_display(app, text, None, next_translation_request_id()).await
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
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_provider_config_sync(provider, api_key, base_url, model)
    })
    .await
    .map_err(|error| format!("保存配置任务失败：{error}"))?
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
async fn has_api_key() -> bool {
    tauri::async_runtime::spawn_blocking(|| legacy_api_key().is_ok())
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
) -> Result<UserPreferences, String> {
    let preferences = UserPreferences {
        auto_selection,
        keep_on_top,
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

fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.set_size(Size::Logical(LogicalSize::new(1120.0, 760.0))).map_err(|error| error.to_string())?;
        window.set_resizable(false).map_err(|error| error.to_string())?;
        window.set_minimizable(true).map_err(|error| error.to_string())?;
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
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(false)
        .minimizable(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
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
    match translate_and_display(app.clone(), text, float_placement, request_id).await {
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
                controller.begin_mouse_up()
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
        .setup(move |app| {
            initialize_tray_icon(app)?;
            if let Err(error) = initialize_selection_float(app) {
                eprintln!("Selection float disabled: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            translate_text,
            translate_selection_float,
            save_api_key,
            save_provider_config,
            get_provider_config,
            test_provider_connection,
            has_api_key,
            get_preferences,
            save_preferences,
            hide_window,
            open_settings_window,
            hide_settings_window,
        ])
        .run(tauri::generate_context!())
        .expect("启动 AI Translate 失败");
}
