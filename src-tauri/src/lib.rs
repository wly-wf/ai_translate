mod selection_state;
mod autostart;
mod translation_quality;
mod translation_runtime;
mod single_instance;
mod translation_api;
use translation_api::*;
#[cfg(test)]
mod translation_live_tests;
mod native_frame;
mod network;
mod api_response;
mod custom_providers;
use custom_providers::{is_custom_provider, custom_provider_ids, save_custom_provider_ids, new_custom_provider_id};
mod window_layout;
use window_layout::fit_settings_window;
use network::build_http_client;
pub mod mouse_hook;
pub mod windows_selection;

use native_frame::{
    configure_standard_window_frame, standard_window_background, window_uses_dark_theme,
};
use selection_state::{Anchor, SelectionController, StateChange};
use windows_selection::{capture_selection, CaptureOutcome};
use keyring::{Entry, Error as KeyringError};
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
    menu::{CheckMenuItemBuilder, Menu, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    webview::PageLoadEvent,
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Size, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

const KEYRING_SERVICE: &str = "ai-translate";
const KEYRING_ACCOUNT: &str = "deepseek-api-key";
const PREFERENCES_ACCOUNT: &str = "user-preferences";
const ACTIVE_PROVIDER_ACCOUNT: &str = "active-provider";
const ENABLED_PROVIDERS_ACCOUNT: &str = "enabled-providers";
const PROVIDER_KEYRING_PREFIX: &str = "provider-config:";
const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
const DEEPSEEK_MODEL: &str = "deepseek-v4-flash";
const THINKING_DISABLED: &str = "disabled";
const USER_PREFERENCES_VERSION: u8 = 3;
const DEFAULT_PROXY_BYPASS: &str = "localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1";
const FLOAT_BUTTON_SIZE: i32 = 28;
const FLOAT_SIZE: i32 = FLOAT_BUTTON_SIZE + 4;
pub(crate) const FLOAT_PADDING: i32 = (FLOAT_SIZE - FLOAT_BUTTON_SIZE) / 2;
const FLOAT_ANCHOR_GAP: i32 = 10;
const FLOAT_ANCHOR_VERTICAL_GAP: i32 = 18;
const TRANSLATION_WINDOW_WIDTH: f64 = 480.0;
const TRANSLATION_WINDOW_HEIGHT: f64 = 660.0;
pub(crate) const FLOAT_CORNER_RADIUS: i32 = 10;

static NEXT_TRANSLATION_REQUEST_ID: AtomicU64 = AtomicU64::new(0);

fn physical_float_metric(logical_pixels: i32, scale_factor: f64) -> i32 {
    (f64::from(logical_pixels) * scale_factor).round().max(1.0) as i32
}

fn shape_float_window_as_round_rect(
    hwnd: windows::Win32::Foundation::HWND,
    scale_factor: f64,
) -> Result<(), String> {
    use windows::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, HGDIOBJ, SetWindowRgn},
        UI::WindowsAndMessaging::{
            GetClientRect, GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_STYLE,
            SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER,
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
            physical_float_metric(FLOAT_SIZE, scale_factor),
            physical_float_metric(FLOAT_SIZE, scale_factor),
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOZORDER,
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
            physical_float_metric(FLOAT_CORNER_RADIUS * 2, scale_factor),
            physical_float_metric(FLOAT_CORNER_RADIUS * 2, scale_factor),
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
mod regression_tests;

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

struct EnabledProvidersUpdateLock(Mutex<()>);
struct PreferencesUpdateLock(Mutex<()>);

#[derive(Default)]
struct AddProviderWindowState {
    ready: bool,
    requested: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ProxyMode {
    #[default]
    System,
    Disabled,
    Custom,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProxyType {
    #[default]
    Http,
    Https,
    Socks4,
    Socks5,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ThemeMode {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum AccentColor {
    #[default]
    Blue,
    Purple,
    Green,
    Orange,
    Rose,
}

fn default_source_font_size() -> u8 { 14 }
fn default_translation_font_size() -> u8 { 16 }
fn default_proxy_host() -> String { "127.0.0.1".to_string() }
fn default_proxy_port() -> String { "7890".to_string() }
fn default_proxy_bypass() -> String { DEFAULT_PROXY_BYPASS.to_string() }
fn default_proxy_test_url() -> String { "https://www.google.com".to_string() }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserPreferences {
    auto_selection: bool,
    keep_on_top: bool,
    #[serde(default)]
    quick_translate_provider: Option<String>,
    #[serde(default)]
    quick_translate_model: Option<String>,
    #[serde(default)]
    theme_mode: ThemeMode,
    #[serde(default)]
    accent_color: AccentColor,
    #[serde(default = "default_source_font_size")]
    source_font_size: u8,
    #[serde(default = "default_translation_font_size")]
    translation_font_size: u8,
    #[serde(default)]
    proxy_mode: ProxyMode,
    #[serde(default)]
    proxy_url: String,
    #[serde(default)]
    proxy_type: ProxyType,
    #[serde(default = "default_proxy_host")]
    proxy_host: String,
    #[serde(default = "default_proxy_port")]
    proxy_port: String,
    #[serde(default)]
    proxy_username: String,
    #[serde(default)]
    proxy_password: String,
    #[serde(default = "default_proxy_bypass")]
    proxy_bypass: String,
    #[serde(default = "default_proxy_test_url")]
    proxy_test_url: String,
    #[serde(default)]
    provider_order: Vec<String>,
    #[serde(default)]
    preference_version: u8,
}

impl Default for UserPreferences {
    fn default() -> Self {
        Self {
            auto_selection: true,
            keep_on_top: false,
            quick_translate_provider: None,
            quick_translate_model: None,
            theme_mode: ThemeMode::System,
            accent_color: AccentColor::Blue,
            source_font_size: default_source_font_size(),
            translation_font_size: default_translation_font_size(),
            proxy_mode: ProxyMode::Disabled,
            proxy_url: String::new(),
            proxy_type: ProxyType::Http,
            proxy_host: default_proxy_host(),
            proxy_port: default_proxy_port(),
            proxy_username: String::new(),
            proxy_password: String::new(),
            proxy_bypass: default_proxy_bypass(),
            proxy_test_url: default_proxy_test_url(),
            provider_order: Vec::new(),
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
    #[serde(default)]
    vendor_name: String,
    api_key: String,
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    models: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigResponse {
    vendor_name: String,
    api_key: String,
    base_url: String,
    model: String,
    models: Vec<String>,
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
            .saturating_add(FLOAT_ANCHOR_GAP)
            .saturating_sub(FLOAT_PADDING)
            .clamp(work_x, max_x),
        y: anchor
            .y
            .saturating_sub(FLOAT_ANCHOR_VERTICAL_GAP)
            .saturating_sub(FLOAT_SIZE)
            .saturating_add(FLOAT_PADDING)
            .clamp(work_y, max_y),
    }
}

const TRANSLATION_WINDOW_GAP: i32 = 12;

#[derive(Clone, Copy, Debug)]
struct FloatPlacement {
    x: i32,
    y: i32,
    width: u32,
    scale_factor: f64,
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
                    dispatch_mouse_up(&app, request.generation, CaptureOutcome::Empty, false);
                    continue;
                }
                let outcome = capture_selection(request.point);
                dispatch_mouse_up(&app, request.generation, outcome, false);
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

fn point_hits_app_window(app: &AppHandle, point: windows::Win32::Foundation::POINT) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};

    let hit_window = unsafe { WindowFromPoint(point) };
    if hit_window.is_invalid() {
        return false;
    }
    let hit_root = unsafe { GetAncestor(hit_window, GA_ROOT) };
    let hit_root = if hit_root.is_invalid() {
        hit_window
    } else {
        hit_root
    };

    app.webview_windows().values().any(|window| {
        let Ok(app_window) = window.hwnd() else {
            return false;
        };
        let app_root = unsafe { GetAncestor(app_window, GA_ROOT) };
        let app_root = if app_root.is_invalid() {
            app_window
        } else {
            app_root
        };
        app_root == hit_root
    })
}

fn selection_gesture_hits_app_window(app: &AppHandle, event: &mouse_hook::MouseUpEvent) -> bool {
    event
        .start_point
        .is_some_and(|point| point_hits_app_window(app, point))
        || point_hits_app_window(app, event.point)
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

fn dispatch_mouse_up(
    app: &AppHandle,
    generation: u64,
    captured: CaptureOutcome,
    clicked_float: bool,
) {
    let callback_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        apply_mouse_up(&callback_app, generation, captured, clicked_float);
    }) {
        eprintln!("Could not dispatch selection result to the main thread: {error}");
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

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::SetWindowPos(
            hwnd,
            None,
            position.x,
            position.y,
            0,
            0,
            windows::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE
                | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE
                | windows::Win32::UI::WindowsAndMessaging::SWP_NOZORDER,
        )
    }
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
            let preferences = current_preferences(app);
            let appearance = current_window_appearance(app);
            if let Err(frame_error) = configure_standard_window_frame(
                &window,
                appearance.dark,
                appearance.follow_system,
            ) {
                eprintln!("Translation window frame refresh failed: {frame_error}");
            }
            if let Err(top_error) = window.set_always_on_top(preferences.keep_on_top) {
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

fn account_entry(account: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, account).map_err(|error| error.to_string())
}

fn load_preferences_sync() -> Result<UserPreferences, String> {
    let entry = account_entry(PREFERENCES_ACCOUNT)?;
    match entry.get_password() {
        Ok(password) => {
            let mut preferences: UserPreferences = serde_json::from_str(&password)
                .map_err(|error| format!("无法读取界面偏好：{error}"))?;
            if preferences.preference_version < 1 {
                // The previous version defaulted to always-on-top. Start the
                // new click-away behavior unpinned, while preserving future
                // pin choices across restarts.
                preferences.keep_on_top = false;
            }
            if preferences.preference_version < 2 {
                if preferences.proxy_mode == ProxyMode::Custom {
                    if let Some((proxy_type, host, port, username, password)) = proxy_details_from_url(&preferences.proxy_url) {
                        preferences.proxy_type = proxy_type;
                        preferences.proxy_host = host;
                        preferences.proxy_port = port;
                        preferences.proxy_username = username;
                        preferences.proxy_password = password;
                    }
                } else if preferences.proxy_mode == ProxyMode::System {
                    preferences.proxy_mode = ProxyMode::Disabled;
                }
                preferences.proxy_bypass = default_proxy_bypass();
                preferences.proxy_test_url = default_proxy_test_url();
            }
            if preferences.preference_version < 3
                && preferences.proxy_type == ProxyType::Https
                && preferences.proxy_host == default_proxy_host()
                && preferences.proxy_port == default_proxy_port()
                && preferences.proxy_username.is_empty()
                && preferences.proxy_password.is_empty()
            {
                // Version 2 accidentally used HTTPS for the common Clash/Mihomo
                // local mixed port. The proxy protocol is HTTP even when the
                // destination API uses HTTPS.
                preferences.proxy_type = ProxyType::Http;
            }
            preferences.source_font_size = preferences.source_font_size.clamp(12, 20);
            preferences.translation_font_size = preferences.translation_font_size.clamp(12, 20);
            preferences.preference_version = USER_PREFERENCES_VERSION;
            Ok(preferences)
        }
        Err(_) => Ok(UserPreferences::default()),
    }
}

fn save_preferences_sync(preferences: &UserPreferences) -> Result<(), String> {
    let serialized = serde_json::to_string(preferences)
        .map_err(|error| format!("无法序列化界面偏好：{error}"))?;
    account_entry(PREFERENCES_ACCOUNT)?
        .set_password(&serialized)
        .map_err(|error| format!("无法保存界面偏好：{error}"))
}

fn current_preferences(app: &AppHandle) -> UserPreferences {
    app.state::<Mutex<UserPreferences>>()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[derive(Clone, Copy)]
struct WindowAppearance {
    dark: bool,
    follow_system: bool,
}

fn current_window_appearance(app: &AppHandle) -> WindowAppearance {
    match current_preferences(app).theme_mode {
        ThemeMode::Dark => WindowAppearance {
            dark: true,
            follow_system: false,
        },
        ThemeMode::Light => WindowAppearance {
            dark: false,
            follow_system: false,
        },
        ThemeMode::System => WindowAppearance {
            dark: app
                .get_webview_window("main")
                .as_ref()
                .is_some_and(window_uses_dark_theme),
            follow_system: true,
        },
    }
}

fn normalized_proxy_url(proxy_url: &str) -> Result<String, String> {
    let proxy_url = proxy_url.trim();
    if proxy_url.is_empty() {
        return Err("自定义代理地址不能为空。".to_string());
    }
    let proxy_url = if proxy_url.contains("://") {
        proxy_url.to_string()
    } else {
        format!("http://{proxy_url}")
    };
    let parsed = reqwest::Url::parse(&proxy_url)
        .map_err(|_| "代理地址格式无效，请填写主机和端口。".to_string())?;
    if !matches!(
        parsed.scheme(),
        "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h"
    ) {
        return Err("代理地址仅支持 HTTP、HTTPS、SOCKS4 或 SOCKS5。".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("代理地址缺少主机名。".to_string());
    }
    Ok(proxy_url)
}

fn proxy_details_from_url(proxy_url: &str) -> Option<(ProxyType, String, String, String, String)> {
    let normalized = normalized_proxy_url(proxy_url).ok()?;
    let parsed = reqwest::Url::parse(&normalized).ok()?;
    let proxy_type = match parsed.scheme() {
        "http" => ProxyType::Http,
        "https" => ProxyType::Https,
        "socks4" | "socks4a" => ProxyType::Socks4,
        "socks5" | "socks5h" => ProxyType::Socks5,
        _ => return None,
    };
    Some((
        proxy_type,
        parsed.host_str()?.to_string(),
        parsed.port_or_known_default()?.to_string(),
        parsed.username().to_string(),
        parsed.password().unwrap_or_default().to_string(),
    ))
}

fn custom_proxy_url(preferences: &UserPreferences) -> Result<String, String> {
    let host = preferences.proxy_host.trim();
    if host.is_empty() {
        return normalized_proxy_url(&preferences.proxy_url);
    }
    let port = preferences.proxy_port.trim().parse::<u16>()
        .map_err(|_| "代理端口必须是 1 到 65535 之间的数字。".to_string())?;
    if port == 0 {
        return Err("代理端口必须是 1 到 65535 之间的数字。".to_string());
    }
    let scheme = match preferences.proxy_type {
        ProxyType::Http => "http",
        ProxyType::Https => "https",
        ProxyType::Socks4 => "socks4",
        ProxyType::Socks5 => "socks5h",
    };
    let formatted_host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let mut url = reqwest::Url::parse(&format!("{scheme}://{formatted_host}:{port}"))
        .map_err(|_| "代理服务器地址格式无效。".to_string())?;
    if !preferences.proxy_username.is_empty() {
        url.set_username(&preferences.proxy_username)
            .map_err(|_| "代理用户名格式无效。".to_string())?;
        url.set_password(Some(&preferences.proxy_password))
            .map_err(|_| "代理密码格式无效。".to_string())?;
    }
    Ok(url.to_string())
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
        "deepseek" | "xiaomi" | "qwen" | "zhipu" | "moonshot"
    ) || is_custom_provider(provider)
}

fn provider_keyring_entry(provider: &str) -> Result<Entry, String> {
    if !supported_provider(provider) {
        return Err(format!("不支持的 AI 提供商：{provider}"));
    }
    account_entry(&format!("{PROVIDER_KEYRING_PREFIX}{provider}"))
}

fn stored_provider_config(provider: &str) -> Result<StoredProviderConfig, String> {
    let password = provider_keyring_entry(provider)?
        .get_password()
        .map_err(|_| format!("请先保存 {provider} 的 API Key。"))?;
    serde_json::from_str(&password).map_err(|error| format!("无法读取 {provider} 配置：{error}"))
}

fn provider_api_key(provider: &str, api_key: &str) -> String {
    let value = api_key.trim();
    if !value.is_empty() {
        return value.to_string();
    }
    stored_provider_config(provider).map(|config| config.api_key).or_else(|error| {
        if provider == "deepseek" {
            legacy_api_key()
        } else {
            Err(error)
        }
    }).unwrap_or_default()
}

fn legacy_api_key() -> Result<String, String> {
    account_entry(KEYRING_ACCOUNT)?
        .get_password()
        .map_err(|_| "请先在设置中保存 DeepSeek API Key。".to_string())
}

fn active_provider_sync() -> String {
    account_entry(ACTIVE_PROVIDER_ACCOUNT)
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .ok()
        .filter(|provider| supported_provider(provider))
        .unwrap_or_else(|| "deepseek".to_string())
}

fn enabled_providers_sync() -> Vec<String> {
    account_entry(ENABLED_PROVIDERS_ACCOUNT)
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
    account_entry(ENABLED_PROVIDERS_ACCOUNT)?
        .set_password(&serialized)
        .map_err(|error| format!("无法保存启用模型列表：{error}"))
}

fn normalize_provider_order(value: &serde_json::Value) -> Result<Vec<String>, String> {
    value
        .as_array()
        .ok_or_else(|| "providerOrder must be an array of provider ids".to_string())?
        .iter()
        .try_fold(Vec::new(), |mut unique, provider| {
            let provider = provider
                .as_str()
                .ok_or_else(|| "providerOrder must contain only strings".to_string())?;
            if !unique.iter().any(|item| item == provider) {
                unique.push(provider.to_string());
            }
            Ok(unique)
        })
}

fn apply_provider_order(providers: Vec<String>, provider_order: &[String]) -> Vec<String> {
    let mut ordered = Vec::with_capacity(providers.len());
    for preferred in provider_order {
        if providers.iter().any(|provider| provider == preferred)
            && !ordered.iter().any(|provider| provider == preferred)
        {
            ordered.push(preferred.clone());
        }
    }
    for provider in providers {
        if !ordered.contains(&provider) {
            ordered.push(provider);
        }
    }
    ordered
}

fn normalize_models(primary_model: &str, models: &[String]) -> Vec<String> {
    std::iter::once(primary_model)
        .chain(models.iter().map(String::as_str))
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .fold(Vec::new(), |mut unique, model| {
            if !unique.iter().any(|item| item == model) {
                unique.push(model.to_string());
            }
            unique
        })
}

fn configured_provider(provider: &str) -> Result<StoredProviderConfig, String> {
    let mut config = match stored_provider_config(provider) {
        Ok(config) => config,
        Err(_) if provider == "deepseek" => {
            return Ok(StoredProviderConfig {
                vendor_name: String::new(),
                api_key: legacy_api_key()?,
                base_url: DEEPSEEK_BASE_URL.to_string(),
                model: DEEPSEEK_MODEL.to_string(),
                models: vec![DEEPSEEK_MODEL.to_string()],
            });
        }
        Err(error) => return Err(error),
    };
    if config.base_url.trim().is_empty() {
        return Err(format!("{provider} Base URL 不能为空。"));
    }
    validate_base_url(&config.base_url)?;
    config.models = normalize_models(&config.model, &config.models);
    config.model = config
        .models
        .first()
        .cloned()
        .ok_or_else(|| format!("{provider} 模型名称不能为空。"))?;
    Ok(config)
}

fn capture_float_placement(app: &AppHandle) -> Result<FloatPlacement, String> {
    let window = app.get_webview_window("selection-float")
        .ok_or_else(|| "Selection float window is unavailable.".to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let monitor = monitor_for_anchor(&window, &Anchor { x: position.x, y: position.y })?;
    let work_area = monitor.work_area();

    Ok(FloatPlacement {
        x: position.x,
        y: position.y,
        width: size.width,
        scale_factor,
        work_x: work_area.position.x,
        work_y: work_area.position.y,
        work_width: work_area.size.width,
        work_height: work_area.size.height,
    })
}

/// Computes the translation window position from the float placement and
/// applies it. The size used for the left/right decision is derived from the
/// locked logical window size and the float monitor's scale factor, so a
/// stale or hidden window state cannot skew the result.
fn position_translation_window(window: &WebviewWindow, placement: FloatPlacement) -> Result<(), String> {
    let width = (TRANSLATION_WINDOW_WIDTH * placement.scale_factor).round().max(1.0) as u32;
    let height = (TRANSLATION_WINDOW_HEIGHT * placement.scale_factor).round().max(1.0) as u32;
    let position = translation_window_position(placement, width, height);
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
        if let Some(result) = batch.results.iter_mut().find(|result| {
            result.provider_id == provider_result.provider_id
                && result.model == provider_result.model
        })
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
    requested_model: Option<String>,
    request_id: u64,
) -> Result<TranslationBatch, String> {
    let source = text.trim().to_string();
    if source.is_empty() { return Err("没有可翻译的文本。".to_string()); }
    if source.chars().count() > 12_000 {
        return Err("单次翻译最多支持 12,000 个字符。".to_string());
    }
    let request_preferences = current_preferences(&app);
    let enabled_providers = apply_provider_order(
        tauri::async_runtime::spawn_blocking(enabled_providers_sync).await.map_err(|error| error.to_string())?,
        &request_preferences.provider_order,
    );
    if enabled_providers.is_empty() {
        return Err("尚未配置并启用翻译供应商，请先前往设置完成配置。".to_string());
    }
    let providers = if let Some(provider) = requested_provider.as_ref() {
        if !enabled_providers.contains(provider) {
            return Err("所选模型未启用，请重新选择。".to_string());
        }
        vec![provider.clone()]
    } else {
        enabled_providers
    };
    // Credential access runs off the async workers and failures are isolated
    // to the affected provider, rather than cancelling healthy providers.
    let (targets, mut initial_results) = tauri::async_runtime::spawn_blocking(move || {
        let mut targets = Vec::new();
        let mut errors = Vec::new();
        for provider in providers {
            match configured_provider(&provider) {
                Ok(config) => {
                    let models = match requested_model.as_ref() {
                        Some(model) if config.models.contains(model) => vec![model.clone()],
                        Some(model) => {
                            errors.push(ProviderTranslation { provider_id: provider, model: model.clone(), translation: None, error: Some("所选模型未配置，请重新选择。".into()) });
                            continue;
                        }
                        None => config.models.clone(),
                    };
                    targets.extend(models.into_iter().map(|model| (provider.clone(), model, config.clone())));
                }
                Err(error) => errors.push(ProviderTranslation {
                    provider_id: provider, model: requested_model.clone().unwrap_or_default(),
                    translation: None, error: Some(error),
                }),
            }
        }
        (targets, errors)
    }).await.map_err(|error| error.to_string())?;
    initial_results.extend(targets.iter().map(|(provider, model, _)| ProviderTranslation {
        provider_id: provider.clone(), model: model.clone(), translation: None, error: None,
    }));
    let pending_result = TranslationBatch { source: source.clone(), request_id, results: initial_results };
    {
        let latest = app.state::<LatestTranslation>();
        let mut latest = latest.lock().unwrap_or_else(|error| error.into_inner());
        if !app.state::<translation_runtime::TranslationRuntime>().begin(request_id) {
            return Err("翻译已被更新的请求替代。".into());
        }
        *latest = Some(pending_result.clone());
    }
    let window = app.get_webview_window("main").ok_or_else(|| "未找到结果窗口。".to_string())?;
    lock_translation_window(&window)?;
    let appearance = current_window_appearance(&app);
    configure_standard_window_frame(&window, appearance.dark, appearance.follow_system)?;
    if let Some(placement) = float_placement {
        position_translation_window(&window, placement)?;
    }
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    window
        .set_always_on_top(request_preferences.keep_on_top)
        .map_err(|error| error.to_string())?;
    // Re-apply after showing: some Windows/WebView2 combinations adjust the
    // frame when the window becomes visible, which can move it away from the
    // float. Keeping the second application makes the side-of-button position
    // deterministic.
    if let Some(placement) = float_placement {
        position_translation_window(&window, placement)?;
    }
    app.emit("translation-started", &pending_result).map_err(|error| error.to_string())?;

    let mut pending = Vec::with_capacity(targets.len());
    for (provider, model, config) in targets {
        let request_text = source.clone();
        let task_provider = provider.clone();
        let task_model = model.clone();
        let identity = (provider.clone(), model.clone());
        let task_app = app.clone();
        let task_preferences = request_preferences.clone();
        let permits = app.state::<translation_runtime::TranslationRuntime>().permits.clone();
        let task = tokio::spawn(async move {
            let _permit = permits.acquire_owned().await.map_err(|error| error.to_string())?;
            let result = match request_translation_with_config(
                task_provider, task_model, request_text, task_preferences, config,
            ).await {
                Ok(result) => result,
                Err(error) => ProviderTranslation {
                    provider_id: provider, model, translation: None, error: Some(error),
                },
            };
            publish_provider_result(&task_app, request_id, &result);
            Ok::<_, String>(result)
        });
        app.state::<translation_runtime::TranslationRuntime>().track(request_id, task.abort_handle());
        pending.push((identity, task));
    }
    // Retain per-provider configuration errors alongside completed requests.
    let mut results: Vec<_> = pending_result.results.into_iter().filter(|result| result.error.is_some()).collect();
    for ((provider, model), task) in pending {
        match task.await {
            Ok(Ok(result)) => results.push(result),
            Ok(Err(error)) => {
                let result = ProviderTranslation { provider_id: provider, model, translation: None, error: Some(error) };
                publish_provider_result(&app, request_id, &result);
                results.push(result);
            },
            Err(error) if error.is_cancelled() => return Err("翻译已被更新的请求替代。".into()),
            Err(error) => {
                let result = ProviderTranslation { provider_id: provider, model, translation: None, error: Some(format!("翻译任务失败：{error}")) };
                publish_provider_result(&app, request_id, &result);
                results.push(result);
            },
        }
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
async fn translate_text(app: AppHandle, text: String, provider: Option<String>, model: Option<String>) -> Result<TranslationBatch, String> {
    translate_and_display(app, text, None, provider, model, next_translation_request_id()).await
}

#[tauri::command]
async fn retranslate_model(app: AppHandle, request_id: u64, provider: String, model: String) -> Result<TranslationBatch, String> {
    let config = tauri::async_runtime::spawn_blocking({
        let provider = provider.clone();
        move || {
            if !enabled_providers_sync().contains(&provider) {
                return Err("所选模型未启用，请重新选择。".into());
            }
            configured_provider(&provider)
        }
    }).await.map_err(|error| error.to_string())??;
    if !config.models.contains(&model) {
        return Err("所选模型未配置，请重新选择。".into());
    }
    let new_request_id = next_translation_request_id();
    let pending = {
        let latest = app.state::<LatestTranslation>();
        let mut latest = latest.lock().unwrap_or_else(|error| error.into_inner());
        let batch = latest.as_ref().filter(|batch| batch.request_id == request_id)
            .ok_or("翻译结果已更新，请重试。")?;
        let mut pending = batch.clone();
        let target = pending.results.iter_mut().find(|result| result.provider_id == provider && result.model == model)
            .ok_or("未找到要重新翻译的模型。")?;
        target.translation = None;
        target.error = None;
        pending.request_id = new_request_id;
        if !app.state::<translation_runtime::TranslationRuntime>().begin(new_request_id) {
            return Err("翻译已被更新的请求替代。".into());
        }
        *latest = Some(pending.clone());
        pending
    };
    app.emit("translation-started", &pending).map_err(|error| error.to_string())?;
    let source = pending.source.clone();
    let preferences = current_preferences(&app);
    let translated = request_translation_with_config(provider.clone(), model.clone(), source, preferences, config).await
        .unwrap_or_else(|error| ProviderTranslation { provider_id: provider, model, translation: None, error: Some(error) });
    publish_provider_result(&app, new_request_id, &translated);
    get_latest_translation(app).filter(|batch| batch.request_id == new_request_id)
        .ok_or_else(|| "翻译已被更新的请求替代。".into())
}

#[tauri::command]
fn get_latest_translation(app: AppHandle) -> Option<TranslationBatch> {
    app.state::<LatestTranslation>()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn save_provider_config_sync(
    provider: String,
    vendor_name: Option<String>,
    api_key: String,
    base_url: String,
    model: String,
    models: Option<Vec<String>>,
) -> Result<(), String> {
    if !supported_provider(&provider) {
        return Err(format!("不支持的 AI 提供商：{provider}"));
    }
    let models = normalize_models(&model, models.as_deref().unwrap_or_default());
    if base_url.trim().is_empty() || models.is_empty() {
        return Err("Base URL 不能为空，并且至少需要配置一个模型。".to_string());
    }
    validate_base_url(&base_url)?;
    let key = provider_api_key(&provider, &api_key);
    let config = StoredProviderConfig {
        vendor_name: vendor_name.unwrap_or_default().trim().to_string(),
        api_key: key.clone(),
        base_url: normalize_provider_base_url(&provider, &base_url),
        model: models[0].clone(),
        models,
    };
    let serialized = serde_json::to_string(&config).map_err(|error| format!("无法序列化配置：{error}"))?;
    provider_keyring_entry(&provider)?.set_password(&serialized)
        .map_err(|error| format!("无法保存 {provider} 配置：{error}"))?;
    if provider == "deepseek" {
        account_entry(KEYRING_ACCOUNT)?.set_password(&key)
            .map_err(|error| format!("无法同步保存 DeepSeek API Key：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn save_provider_config(
    app: AppHandle,
    provider: String,
    vendor_name: Option<String>,
    api_key: String,
    base_url: String,
    model: String,
    models: Option<Vec<String>>,
) -> Result<(), String> {
    let saved_provider = provider.clone();
    let update_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let update_lock = update_app.state::<EnabledProvidersUpdateLock>();
        let _guard = update_lock.0.lock().unwrap_or_else(|error| error.into_inner());
        if is_custom_provider(&provider) {
            provider_keyring_entry(&provider)?.get_password()
                .map_err(|_| "自定义供应商已删除，请重新添加。".to_string())?;
        }
        save_provider_config_sync(provider, vendor_name, api_key, base_url, model, models)
    })
    .await
    .map_err(|error| format!("保存配置任务失败：{error}"))??;
    let provider_order = current_preferences(&app).provider_order;
    let enabled_providers = apply_provider_order(enabled_providers_sync(), &provider_order);
    if enabled_providers.contains(&saved_provider) {
        app.emit("enabled-providers-changed", enabled_providers)
        .map_err(|error| error.to_string())?;
    }
    app.emit("provider-config-saved", &saved_provider)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_custom_providers(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let update_lock = app.state::<EnabledProvidersUpdateLock>();
        let _guard = update_lock.0.lock().unwrap_or_else(|error| error.into_inner());
        custom_provider_ids()
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn create_custom_provider(
    app: AppHandle, vendor_name: String, api_key: String, base_url: String,
    model: String, models: Vec<String>,
) -> Result<String, String> {
    if vendor_name.trim().is_empty() { return Err("供应商名称不能为空。".into()); }
    let update_app = app.clone();
    let provider = tauri::async_runtime::spawn_blocking(move || {
        let update_lock = update_app.state::<EnabledProvidersUpdateLock>();
        let _guard = update_lock.0.lock().unwrap_or_else(|error| error.into_inner());
        let mut custom = custom_provider_ids()?;
        let provider = new_custom_provider_id()?;
        save_provider_config_sync(provider.clone(), Some(vendor_name), api_key, base_url, model, Some(models))?;
        custom.push(provider.clone());
        if let Err(error) = save_custom_provider_ids(&custom) {
            provider_keyring_entry(&provider)?.delete_credential().map_err(|rollback| format!("{error}; rollback: {rollback}"))?;
            return Err(error);
        }
        // Registration is durable before enabling. If enabling fails, keep the
        // provider visible and editable instead of orphaning its credentials.
        let mut providers = enabled_providers_sync();
        providers.push(provider.clone());
        let enabled = save_enabled_providers_sync(&providers);
        Ok::<_, String>((provider, enabled))
    }).await.map_err(|error| error.to_string())??;
    let providers = get_enabled_providers(app.clone()).await;
    app.emit("enabled-providers-changed", providers).map_err(|error| error.to_string())?;
    app.emit("provider-config-created", &provider.0).map_err(|error| error.to_string())?;
    // A saved provider is a successful creation even if it could not be enabled.
    // The settings toggle reflects persisted state and permits retrying enable.
    if let Err(error) = provider.1 { eprintln!("Custom provider saved but enable failed: {error}"); }
    Ok(provider.0)
}

#[tauri::command]
async fn get_provider_config(provider: String) -> Result<Option<ProviderConfigResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = provider_keyring_entry(&provider)?;
        let Ok(password) = entry.get_password() else {
            if provider == "deepseek" {
                if let Ok(api_key) = legacy_api_key() {
                    return Ok(Some(ProviderConfigResponse {
                        vendor_name: String::new(),
                        api_key,
                        base_url: DEEPSEEK_BASE_URL.to_string(),
                        model: DEEPSEEK_MODEL.to_string(),
                        models: vec![DEEPSEEK_MODEL.to_string()],
                    }));
                }
            }
            return Ok(None);
        };
        let config: StoredProviderConfig = serde_json::from_str(&password)
            .map_err(|error| format!("无法读取 {provider} 配置：{error}"))?;
        let models = normalize_models(&config.model, &config.models);
        let model = models.first().cloned().unwrap_or_default();
        Ok(Some(ProviderConfigResponse {
            vendor_name: config.vendor_name,
            api_key: config.api_key,
            base_url: normalize_provider_base_url(&provider, &config.base_url),
            model,
            models,
        }))
    })
    .await
    .map_err(|error| format!("读取配置任务失败：{error}"))?
}

#[tauri::command]
async fn delete_custom_provider(app: AppHandle, provider: String) -> Result<Vec<String>, String> {
    if !is_custom_provider(&provider) {
        return Err("只能删除用户添加的自定义供应商。".to_string());
    }
    let removed_provider = provider.clone();
    let update_app = app.clone();
    let provider_order = current_preferences(&app).provider_order;
    let (providers, reset_active_provider) = tauri::async_runtime::spawn_blocking(move || {
        let update_lock = update_app.state::<EnabledProvidersUpdateLock>();
        let _guard = update_lock.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut custom = custom_provider_ids()?;
        custom.retain(|id| id != &provider);
        match provider_keyring_entry(&provider)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => return Err(format!("无法删除自定义供应商配置：{error}")),
        }
        let mut providers = enabled_providers_sync();
        providers.retain(|item| item != &provider);
        let providers = apply_provider_order(providers, &provider_order);
        save_enabled_providers_sync(&providers)?;
        save_custom_provider_ids(&custom)?;
        let reset_active_provider = active_provider_sync() == provider;
        if reset_active_provider {
            account_entry(ACTIVE_PROVIDER_ACCOUNT)?
                .set_password("deepseek")
                .map_err(|error| format!("无法重置当前翻译模型：{error}"))?;
        }
        Ok((providers, reset_active_provider))
    })
    .await
    .map_err(|error| format!("删除自定义供应商任务失败：{error}"))??;
    app.emit("enabled-providers-changed", &providers)
        .map_err(|error| error.to_string())?;
    app.emit("provider-config-deleted", &removed_provider)
        .map_err(|error| error.to_string())?;
    if reset_active_provider {
        app.emit("active-provider-changed", serde_json::json!({
            "providerId": "deepseek",
            "model": DEEPSEEK_MODEL,
        }))
        .map_err(|error| error.to_string())?;
    }
    Ok(providers)
}

#[tauri::command]
async fn test_provider_connection(
    app: AppHandle,
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
) -> Result<ConnectionTestResult, String> {
    if !supported_provider(&provider) {
        return Err(format!("不支持的 AI 提供商：{provider}"));
    }
    let key = provider_api_key(&provider, &api_key);
    let started = Instant::now();
    let preferences = current_preferences(&app);
    send_connection_test(&provider, &key, &base_url, &model, &preferences).await?;
    Ok(ConnectionTestResult {
        latency_ms: started.elapsed().as_millis(),
        message: "连接成功".to_string(),
    })
}

#[tauri::command]
async fn fetch_provider_models(
    app: AppHandle,
    provider: String,
    api_key: String,
    base_url: String,
    use_stored_key: Option<bool>,
) -> Result<Vec<String>, String> {
    if !supported_provider(&provider) {
        return Err(format!("不支持的 AI 提供商：{provider}"));
    }
    let key = if use_stored_key.unwrap_or(true) {
        provider_api_key(&provider, &api_key)
    } else {
        api_key.trim().to_string()
    };
    let preferences = current_preferences(&app);
    fetch_models(&provider, &key, &base_url, &preferences).await
}

#[tauri::command]
async fn get_enabled_providers(app: AppHandle) -> Vec<String> {
    let provider_order = current_preferences(&app).provider_order;
    tauri::async_runtime::spawn_blocking(move || {
        apply_provider_order(enabled_providers_sync(), &provider_order)
    })
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn set_provider_enabled(
    app: AppHandle,
    provider: String,
    enabled: bool,
) -> Result<Vec<String>, String> {
    let update_app = app.clone();
    let provider_order = current_preferences(&app).provider_order;
    let providers = tauri::async_runtime::spawn_blocking(move || {
        let update_lock = update_app.state::<EnabledProvidersUpdateLock>();
        let _guard = update_lock.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
        }
        let providers = apply_provider_order(providers, &provider_order);
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
fn get_preferences(app: AppHandle) -> UserPreferences {
    current_preferences(&app)
}

#[tauri::command]
async fn test_proxy_connection(app: AppHandle, url: String) -> Result<String, String> {
    let target = url.trim();
    let parsed = reqwest::Url::parse(target)
        .map_err(|_| "测试地址格式无效。".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("测试地址必须是有效的 HTTP 或 HTTPS 地址。".to_string());
    }
    let preferences = current_preferences(&app);
    if preferences.proxy_mode == ProxyMode::Disabled {
        return Err("请先选择系统或自定义代理。".to_string());
    }
    let client = build_http_client(&preferences, Duration::from_secs(15))?;
    let response = client.get(parsed).send().await
        .map_err(|error| format!("代理连接失败：{error}"))?;
    let status = response.status();
    match status.as_u16() {
        407 => Err("代理服务器要求身份验证，请检查用户名和密码。".to_string()),
        502..=504 => Err(format!("代理未能连接目标地址（HTTP {}）。", status.as_u16())),
        400..=499 => Ok(format!(
            "代理连接成功，目标地址返回 HTTP {}（目标可能需要身份验证）。",
            status.as_u16()
        )),
        _ if status.is_server_error() => Err(format!(
            "已连接代理，但目标地址返回 HTTP {}。",
            status.as_u16()
        )),
        _ => Ok(format!("代理连接成功（HTTP {}）", status.as_u16())),
    }
}

#[tauri::command]
async fn set_user_preference(
    app: AppHandle,
    preference: String,
    value: serde_json::Value,
) -> Result<UserPreferences, String> {
    let updates_provider_order = preference == "providerOrder";
    let updates_auto_selection = matches!(preference.as_str(), "autoSelection" | "toggleAutoSelection");
    let update_app = app.clone();
    let preferences = tauri::async_runtime::spawn_blocking(move || {
        let update_lock = update_app.state::<PreferencesUpdateLock>();
        let _guard = update_lock.0.lock().unwrap_or_else(|error| error.into_inner());
        let mut updated = current_preferences(&update_app);
        match preference.as_str() {
            "toggleAutoSelection" => updated.auto_selection = !updated.auto_selection,
            "autoSelection" => {
                updated.auto_selection = value.as_bool()
                    .ok_or_else(|| "autoSelection must be a boolean".to_string())?;
            }
            "keepOnTop" => {
                updated.keep_on_top = value.as_bool()
                    .ok_or_else(|| "keepOnTop must be a boolean".to_string())?;
            }
            "quickTranslateProvider" => {
                updated.quick_translate_provider = if value.is_null() {
                    None
                } else {
                    let provider = value.as_str()
                        .ok_or_else(|| "quickTranslateProvider must be a provider id or null".to_string())?;
                    if !supported_provider(provider) {
                        return Err(format!("Unsupported AI provider: {provider}"));
                    }
                    Some(provider.to_string())
                };
            }
            "quickTranslateModel" => {
                updated.quick_translate_model = if value.is_null() {
                    None
                } else {
                    let model = value.as_str()
                        .ok_or_else(|| "quickTranslateModel must be a model name or null".to_string())?
                        .trim();
                    if model.is_empty() {
                        return Err("quickTranslateModel must not be empty".to_string());
                    }
                    Some(model.to_string())
                };
            }
            "themeMode" => {
                updated.theme_mode = match value.as_str() {
                    Some("light") => ThemeMode::Light,
                    Some("dark") => ThemeMode::Dark,
                    Some("system") => ThemeMode::System,
                    _ => return Err("themeMode must be light, dark, or system".to_string()),
                };
            }
            "accentColor" => {
                updated.accent_color = match value.as_str() {
                    Some("blue") => AccentColor::Blue,
                    Some("purple") => AccentColor::Purple,
                    Some("green") => AccentColor::Green,
                    Some("orange") => AccentColor::Orange,
                    Some("rose") => AccentColor::Rose,
                    _ => {
                        return Err(
                            "accentColor must be blue, purple, green, orange, or rose".to_string(),
                        )
                    }
                };
            }
            "sourceFontSize" => {
                let size = value.as_u64()
                    .ok_or_else(|| "sourceFontSize must be an integer".to_string())?;
                if !(12..=20).contains(&size) {
                    return Err("sourceFontSize must be between 12 and 20".to_string());
                }
                updated.source_font_size = size as u8;
            }
            "translationFontSize" => {
                let size = value.as_u64()
                    .ok_or_else(|| "translationFontSize must be an integer".to_string())?;
                if !(12..=20).contains(&size) {
                    return Err("translationFontSize must be between 12 and 20".to_string());
                }
                updated.translation_font_size = size as u8;
            }
            "proxyMode" => {
                updated.proxy_mode = match value.as_str() {
                    Some("system") => ProxyMode::System,
                    Some("disabled") => ProxyMode::Disabled,
                    Some("custom") => ProxyMode::Custom,
                    _ => {
                        return Err(
                            "proxyMode must be system, disabled, or custom".to_string(),
                        )
                    }
                };
            }
            "proxyUrl" => {
                updated.proxy_url = value
                    .as_str()
                    .ok_or_else(|| "proxyUrl must be a string".to_string())?
                    .to_string();
            }
            "proxyType" => {
                updated.proxy_type = match value.as_str() {
                    Some("http") => ProxyType::Http,
                    Some("https") => ProxyType::Https,
                    Some("socks4") => ProxyType::Socks4,
                    Some("socks5") => ProxyType::Socks5,
                    _ => return Err("proxyType must be http, https, socks4, or socks5".to_string()),
                };
            }
            "proxyHost" => {
                updated.proxy_host = value.as_str()
                    .ok_or_else(|| "proxyHost must be a string".to_string())?
                    .trim().to_string();
            }
            "proxyPort" => {
                updated.proxy_port = value.as_str()
                    .ok_or_else(|| "proxyPort must be a string".to_string())?
                    .trim().to_string();
            }
            "proxyUsername" => {
                updated.proxy_username = value.as_str()
                    .ok_or_else(|| "proxyUsername must be a string".to_string())?
                    .to_string();
            }
            "proxyPassword" => {
                updated.proxy_password = value.as_str()
                    .ok_or_else(|| "proxyPassword must be a string".to_string())?
                    .to_string();
            }
            "proxyBypass" => {
                updated.proxy_bypass = value.as_str()
                    .ok_or_else(|| "proxyBypass must be a string".to_string())?
                    .trim().to_string();
            }
            "proxyTestUrl" => {
                updated.proxy_test_url = value.as_str()
                    .ok_or_else(|| "proxyTestUrl must be a string".to_string())?
                    .trim().to_string();
            }
            "providerOrder" => {
                updated.provider_order = normalize_provider_order(&value)?;
            }
            _ => return Err(format!("Unsupported user preference: {preference}")),
        }
        updated.preference_version = USER_PREFERENCES_VERSION;
        save_preferences_sync(&updated)?;
        *update_app.state::<Mutex<UserPreferences>>().lock()
            .unwrap_or_else(|error| error.into_inner()) = updated.clone();
        Ok(updated)
    })
        .await
        .map_err(|error| format!("Preference update task failed: {error}"))??;

    let window_result = if let Some(window) = app.get_webview_window("main") {
        window
            .set_always_on_top(preferences.keep_on_top)
            .map_err(|error| error.to_string())
    } else {
        Ok(())
    };
    if !preferences.auto_selection {
        if let Err(error) = hide_float(&app) {
            eprintln!("Selection float hide failed after disabling auto selection: {error}");
        }
    }
    app.emit("preferences-changed", &preferences)
        .map_err(|error| error.to_string())?;
    if updates_auto_selection {
        let tray_app = app.clone();
        let callback_app = tray_app.clone();
        if let Err(error) = tray_app.run_on_main_thread(move || {
            if is_auto_selection_enabled(&callback_app) {
                if let Err(error) = initialize_selection_float(&callback_app) {
                    eprintln!("Selection float initialization failed: {error}");
                }
            }
            if let Err(error) = refresh_tray_auto_selection(&callback_app) {
                eprintln!(
                    "Tray menu refresh failed after auto selection preference change: {error}"
                );
            }
        }) {
            eprintln!("Could not schedule tray menu refresh: {error}");
        }
    }
    if updates_provider_order {
        let provider_order = preferences.provider_order.clone();
        if let Ok(providers) = tauri::async_runtime::spawn_blocking(move || {
            apply_provider_order(enabled_providers_sync(), &provider_order)
        })
        .await
        {
            app.emit("enabled-providers-changed", providers)
                .map_err(|error| error.to_string())?;
        }
    }
    window_result?;
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

#[tauri::command]
fn set_window_appearance(
    window: WebviewWindow,
    dark: bool,
    follow_system: bool,
) -> Result<(), String> {
    configure_standard_window_frame(&window, dark, follow_system)
}

fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    let appearance = current_window_appearance(app);
    let dark = appearance.dark;
    let follow_system = appearance.follow_system;
    if let Some(window) = app.get_webview_window("settings") {
        fit_settings_window(&window, 1120.0, 760.0)?;
        window.set_resizable(false).map_err(|error| error.to_string())?;
        window.set_minimizable(true).map_err(|error| error.to_string())?;
        configure_standard_window_frame(&window, dark, follow_system)?;
        window.set_always_on_top(false).map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        prewarm_add_provider_window(app);
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .inner_size(1120.0, 760.0)
        .min_inner_size(900.0, 620.0)
        .title("AI Translate 设置")
        .decorations(false)
        .shadow(true)
        .transparent(false)
        .background_color(standard_window_background(dark))
        .theme(if follow_system {
            None
        } else {
            Some(if dark { Theme::Dark } else { Theme::Light })
        })
        .always_on_top(false)
        .skip_taskbar(false)
        .minimizable(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let resolved_dark = if follow_system {
                    window_uses_dark_theme(&window)
                } else {
                    dark
                };
                if let Err(error) = configure_standard_window_frame(
                    &window,
                    resolved_dark,
                    follow_system,
                ) {
                    eprintln!("Settings custom frame refresh failed: {error}");
                }
                if let Err(error) = fit_settings_window(&window, 1120.0, 760.0) {
                    eprintln!("Settings window sizing failed: {error}");
                }
                if let Err(error) = window.set_always_on_top(false) {
                    eprintln!("Settings window topmost reset after page load failed: {error}");
                }
                if let Err(error) = window.show() {
                    eprintln!("Settings window show after page load failed: {error}");
                }
                if let Err(error) = window.set_focus() {
                    eprintln!("Settings window focus after page load failed: {error}");
                }
                prewarm_add_provider_window(window.app_handle());
            }
        })
        .build()
        .map_err(|error| error.to_string())?;
    configure_standard_window_frame(&window, dark, follow_system)
}

fn center_child_window(child: &WebviewWindow, parent: &WebviewWindow) -> Result<(), String> {
    let parent_position = parent.outer_position().map_err(|error| error.to_string())?;
    let parent_size = parent.outer_size().map_err(|error| error.to_string())?;
    let child_size = child.outer_size().map_err(|error| error.to_string())?;
    let x = parent_position.x
        + (parent_size.width.saturating_sub(child_size.width) / 2) as i32;
    let y = parent_position.y
        + (parent_size.height.saturating_sub(child_size.height) / 2) as i32;
    child
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|error| error.to_string())
}

fn prewarm_add_provider_window(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        if let Err(error) = show_add_provider_window(&app, false) {
            eprintln!("Add-provider window preload failed: {error}");
        }
    });
}

fn show_add_provider_window(app: &AppHandle, requested: bool) -> Result<(), String> {
    let state = app.state::<Mutex<AddProviderWindowState>>();
    let mut state = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(window) = app.get_webview_window("add-provider") {
        if requested {
            state.requested = true;
            if state.ready {
                reveal_add_provider_window(app, &window)?;
            }
        }
        return Ok(());
    }
    *state = AddProviderWindowState { ready: false, requested };
    let appearance = current_window_appearance(app);
    let dark = appearance.dark;
    let follow_system = appearance.follow_system;

    let settings_parent = app.get_webview_window("settings");
    let builder = WebviewWindowBuilder::new(app, "add-provider", WebviewUrl::App("index.html".into()))
        .inner_size(640.0, 600.0)
        .min_inner_size(560.0, 580.0)
        .title("添加自定义供应商")
        .decorations(false)
        .shadow(true)
        .transparent(false)
        .background_color(standard_window_background(dark))
        .theme(if follow_system {
            None
        } else {
            Some(if dark { Theme::Dark } else { Theme::Light })
        })
        .always_on_top(false)
        .skip_taskbar(true)
        .minimizable(false)
        .resizable(false)
        .focused(false)
        .visible(false);
    let builder = if let Some(parent) = settings_parent.as_ref() {
        builder.parent(parent).map_err(|error| error.to_string())?
    } else {
        builder
    };
    let window = builder
        .build()
        .map_err(|error| error.to_string())?;
    configure_standard_window_frame(&window, dark, follow_system)
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
async fn open_add_provider_window(app: AppHandle) -> Result<(), String> {
    show_add_provider_window(&app, true)
}

#[tauri::command]
async fn add_provider_window_ready(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != "add-provider" {
        return Err("仅添加供应商窗口可以报告就绪。".to_string());
    }
    let state = app.state::<Mutex<AddProviderWindowState>>();
    let mut state = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.ready = true;
    if state.requested {
        reveal_add_provider_window(&app, &window)?;
    }
    Ok(())
}

fn reveal_add_provider_window(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let appearance = current_window_appearance(app);
    configure_standard_window_frame(window, appearance.dark, appearance.follow_system)?;
    if let Some(parent) = app.get_webview_window("settings") {
        center_child_window(window, &parent)?;
    } else {
        window.center().map_err(|error| error.to_string())?;
    }
    fit_settings_window(window, 640.0, 600.0)?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
async fn return_to_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("add-provider") {
        let state = app.state::<Mutex<AddProviderWindowState>>();
        let mut state = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        window.hide().map_err(|error| error.to_string())?;
        *state = AddProviderWindowState::default();
        // Reset drafts and pending frontend work while retaining the native WebView.
        window.reload().map_err(|error| error.to_string())?;
    }
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
    let float_placement = match capture_float_placement(&app) {
        Ok(placement) => Some(placement),
        Err(error) => {
            eprintln!("Selection float placement capture failed: {error}");
            None
        }
    };
    if let Err(error) = hide_float(&app) {
        eprintln!("Selection float hide failed before translation: {error}");
    }
    match translate_and_display(app.clone(), text, float_placement, None, None, request_id).await {
        Ok(_) => Ok(()),
        Err(error) => {
            if NEXT_TRANSLATION_REQUEST_ID.load(Ordering::Relaxed) != request_id {
                return Ok(());
            }
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
            // The error window is shown without a translation request, so it
            // never reaches translate_and_display; position it next to the
            // float here so every float-initiated window opens beside the
            // button, including failures.
            if let (Some(placement), Some(window)) = (float_placement, app.get_webview_window("main")) {
                if let Err(position_error) = position_translation_window(&window, placement) {
                    eprintln!("Translation error window positioning failed: {position_error}");
                }
            }
            report_translation_error(&app, request_id, &error);
            Err(error)
        }
    }
}

fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let auto_selection_item = CheckMenuItemBuilder::with_id("toggle-auto-selection", "划词翻译")
        .checked(is_auto_selection_enabled(app))
        .build(app)
        .map_err(|error| error.to_string())?;
    let settings_item = MenuItemBuilder::with_id("settings", "设置")
        .build(app)
        .map_err(|error| error.to_string())?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出")
        .build(app)
        .map_err(|error| error.to_string())?;
    Menu::with_items(app, &[&auto_selection_item, &settings_item, &quit_item])
        .map_err(|error| error.to_string())
}

fn refresh_tray_auto_selection(app: &AppHandle) -> Result<(), String> {
    let tray = app
        .tray_by_id("ai-translate-tray")
        .ok_or_else(|| "Tray icon is unavailable.".to_string())?;
    let menu = build_tray_menu(app)?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

fn toggle_auto_selection(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = set_user_preference(app, "toggleAutoSelection".into(), serde_json::Value::Null).await {
            eprintln!("Auto selection preference save failed: {error}");
        }
    });
}

fn is_tray_primary_activation(button: MouseButton, button_state: MouseButtonState) -> bool {
    button == MouseButton::Left && button_state == MouseButtonState::Down
}

fn initialize_tray_icon(app: &tauri::App) -> Result<(), String> {
    let icon = TauriImage::from_bytes(include_bytes!("../icons/tray-icon.png"))
        .map_err(|error| format!("Could not load the tray icon asset: {error}"))?;
    let menu = build_tray_menu(app.handle())?;

    TrayIconBuilder::with_id("ai-translate-tray")
        .icon(icon)
        .tooltip("AI Translate")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "toggle-auto-selection" => toggle_auto_selection(app),
                "settings" => spawn_settings_window(app),
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if is_tray_primary_activation(button, button_state) {
                    show_translation_window(tray.app_handle(), true);
                }
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn initialize_selection_float(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("selection-float").is_some() { return Ok(()); }
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
        let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
        shape_float_window_as_round_rect(float_window, scale_factor)?;
        let mouse_app = app.clone();
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
            if selection_gesture_hits_app_window(&mouse_app, &event) {
                dispatch_mouse_up(&mouse_app, generation, CaptureOutcome::Empty, false);
                return;
            }
            if !is_auto_selection_enabled(&mouse_app) {
                dispatch_mouse_up(&mouse_app, generation, CaptureOutcome::Empty, false);
                return;
            }
            if !event.selection_gesture {
                dispatch_mouse_up(&mouse_app, generation, CaptureOutcome::Empty, false);
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
    let _instance = match single_instance::acquire() {
        Ok(Some(guard)) => guard,
        Ok(None) => return,
        Err(error) => { eprintln!("{error}"); return; }
    };
    let preferences = load_preferences_sync().unwrap_or_else(|error| {
        eprintln!("Could not load interface preferences, using defaults: {error}");
        UserPreferences::default()
    });
    tauri::Builder::default()
        .manage(Mutex::<SelectionController>::default())
        .manage(Mutex::new(preferences))
        .manage(Mutex::new(None::<TranslationBatch>))
        .manage(EnabledProvidersUpdateLock(Mutex::new(())))
        .manage(PreferencesUpdateLock(Mutex::new(())))
        .manage(Mutex::<AddProviderWindowState>::default())
        .manage(translation_runtime::TranslationRuntime::default())
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let appearance = current_window_appearance(app.handle());
                configure_standard_window_frame(
                    &window,
                    appearance.dark,
                    appearance.follow_system,
                )?;
            }
            initialize_tray_icon(app)?;
            if is_auto_selection_enabled(app.handle()) {
                if let Err(error) = initialize_selection_float(app.handle()) {
                    eprintln!("Selection float disabled: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            autostart::get_autostart,
            autostart::set_autostart,
            translate_text,
            retranslate_model,
            get_latest_translation,
            translate_selection_float,
            save_provider_config,
            create_custom_provider,
            get_custom_providers,
            get_provider_config,
            delete_custom_provider,
            test_provider_connection,
            fetch_provider_models,
            get_enabled_providers,
            set_provider_enabled,
            get_preferences,
            test_proxy_connection,
            set_user_preference,
            hide_window,
            minimize_window,
            set_window_appearance,
            open_settings_window,
            open_add_provider_window,
            add_provider_window_ready,
            return_to_settings_window,
            hide_settings_window,
        ])
        .run(tauri::generate_context!())
        .expect("启动 AI Translate 失败");
}
