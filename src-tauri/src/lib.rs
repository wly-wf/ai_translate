mod selection_state;
mod native_frame;
pub mod mouse_hook;
pub mod windows_selection;

use native_frame::{
    configure_standard_window_frame, standard_window_background, window_uses_dark_theme,
};
use selection_state::{Anchor, SelectionController, StateChange};
use windows_selection::{capture_selection, CaptureOutcome};
use keyring::{Entry, Error as KeyringError};
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
const DEEPSEEK_THINKING_DISABLED: &str = "disabled";
const USER_PREFERENCES_VERSION: u8 = 1;
const LOOPBACK_PROXY_BYPASS: &str = "localhost,127.0.0.1,::1";
const FLOAT_BUTTON_SIZE: i32 = 28;
const FLOAT_SIZE: i32 = FLOAT_BUTTON_SIZE + 4;
pub(crate) const FLOAT_PADDING: i32 = (FLOAT_SIZE - FLOAT_BUTTON_SIZE) / 2;
const FLOAT_ANCHOR_GAP: i32 = 6;
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
    fn float_position_uses_the_upper_right_of_the_selection_anchor() {
        assert_eq!(
            clamp_float_position(Anchor { x: 100, y: 100 }, 0, 0, 500, 500),
            Anchor { x: 104, y: 64 },
        );
    }

    #[test]
    fn float_position_stays_inside_the_monitor_work_area() {
        assert_eq!(
            clamp_float_position(Anchor { x: 188, y: 4 }, 0, 0, 200, 100),
            Anchor { x: 168, y: 0 },
        );
    }

    #[test]
    fn float_native_size_respects_monitor_scale_factor() {
        assert_eq!(physical_float_metric(FLOAT_SIZE, 1.0), 32);
        assert_eq!(physical_float_metric(FLOAT_SIZE, 1.5), 48);
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
    fn only_vendor_supported_thinking_options_are_sent() {
        for provider in ["xiaomi", "zhipu", "moonshot"] {
            let mut payload = serde_json::json!({});
            disable_thinking_for_openai_compatible(provider, &mut payload);
            assert_eq!(payload, serde_json::json!({}));
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
    fn remote_http_provider_urls_are_rejected_but_loopback_is_allowed() {
        assert!(validate_base_url("https://api.example.com/v1").is_ok());
        assert!(validate_base_url("http://localhost:8080/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:8080/v1").is_ok());
        assert!(validate_base_url("http://api.example.com/v1").is_err());
    }

    #[test]
    fn complete_api_urls_are_rebased_without_duplicate_resources() {
        assert_eq!(
            api_endpoint("https://api.example.com", "chat/completions").unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            api_endpoint("https://api.example.com/v1/chat/completions", "models").unwrap(),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            api_endpoint("https://api.example.com/v1/models", "chat/completions").unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            api_endpoint("https://api.example.com/v1?tenant=one", "chat/completions").unwrap(),
            "https://api.example.com/v1/chat/completions?tenant=one"
        );
    }

    #[test]
    fn empty_api_keys_create_anonymous_requests() {
        let endpoint = "https://api.example.com/v1/models";
        let request = authenticated_request(Client::new().get(endpoint), "openai", "", endpoint)
            .build()
            .unwrap();
        assert!(request.headers().get(reqwest::header::AUTHORIZATION).is_none());
        assert!(request.headers().get("api-key").is_none());
    }

    #[test]
    fn simple_v1_vendor_urls_are_normalized_but_custom_paths_are_preserved() {
        assert_eq!(
            normalize_provider_base_url("xiaomi", "https://api.xiaomimimo.com/v1"),
            "https://api.xiaomimimo.com"
        );
        assert_eq!(
            normalize_provider_base_url("moonshot", "https://api.moonshot.cn/v1/"),
            "https://api.moonshot.cn"
        );
        assert_eq!(
            normalize_provider_base_url("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
        );
        assert_eq!(
            normalize_provider_base_url("zhipu", "https://open.bigmodel.cn/api/paas/v4"),
            "https://open.bigmodel.cn/api/paas/v4"
        );
    }

    #[test]
    fn azure_endpoints_use_api_key_auth_and_preserve_api_version() {
        let endpoint = api_endpoint(
            "https://demo.openai.azure.com/openai/deployments/translator/chat/completions?api-version=2024-10-21",
            "chat/completions",
        )
        .unwrap();
        assert!(uses_azure_api_key("openai", &endpoint));
        assert!(endpoint.contains("api-version=2024-10-21"));
    }

    #[test]
    fn model_lists_accept_common_compatible_shapes() {
        let named = serde_json::json!({ "models": [{ "name": "llama3.2" }] });
        assert_eq!(
            parse_model_ids("openai", &named).unwrap(),
            vec!["llama3.2"]
        );

        let strings = serde_json::json!(["model-b", "model-a"]);
        assert_eq!(
            parse_model_ids("openai", &strings).unwrap(),
            vec!["model-a", "model-b"]
        );
    }

    #[test]
    fn response_text_accepts_chat_responses_and_multi_part_content() {
        let chat = serde_json::json!({
            "choices": [{ "message": { "content": [{ "type": "text", "text": "你好" }] } }]
        });
        assert_eq!(
            extract_response_text(&chat, "openai").as_deref(),
            Some("你好")
        );

        let responses = serde_json::json!({
            "output": [{ "content": [{ "type": "output_text", "text": "第一段" }, { "type": "output_text", "text": "第二段" }] }]
        });
        assert_eq!(
            extract_response_text(&responses, "openai").as_deref(),
            Some("第一段第二段")
        );
    }

    #[test]
    fn multiple_models_are_trimmed_deduplicated_and_keep_primary_first() {
        assert_eq!(
            normalize_models(
                " deepseek-v4-flash ",
                &["deepseek-v4-pro".into(), "deepseek-v4-flash".into(), " ".into()],
            ),
            vec!["deepseek-v4-flash", "deepseek-v4-pro"]
        );
    }

    #[test]
    fn legacy_single_model_provider_config_still_deserializes() {
        let config: StoredProviderConfig = serde_json::from_value(serde_json::json!({
            "api_key": "secret",
            "base_url": "https://api.example.com",
            "model": "legacy-model"
        }))
        .unwrap();

        assert_eq!(
            normalize_models(&config.model, &config.models),
            vec!["legacy-model"]
        );
    }

    #[test]
    fn legacy_preferences_default_to_the_system_proxy() {
        let preferences: UserPreferences = serde_json::from_value(serde_json::json!({
            "autoSelection": true,
            "keepOnTop": false
        }))
        .unwrap();

        assert_eq!(preferences.proxy_mode, ProxyMode::System);
        assert!(preferences.proxy_url.is_empty());
        assert_eq!(preferences.theme_mode, ThemeMode::System);
        assert_eq!(preferences.source_font_size, 14);
        assert_eq!(preferences.translation_font_size, 16);
        assert!(preferences.provider_order.is_empty());
    }

    #[test]
    fn proxy_preferences_use_frontend_field_names() {
        let preferences = UserPreferences {
            proxy_mode: ProxyMode::Custom,
            proxy_url: "http://127.0.0.1:7890".into(),
            ..UserPreferences::default()
        };
        let value = serde_json::to_value(preferences).unwrap();

        assert_eq!(value["proxyMode"], "custom");
        assert_eq!(value["proxyUrl"], "http://127.0.0.1:7890");
    }

    #[test]
    fn proxy_urls_accept_common_http_and_socks_forms() {
        assert_eq!(
            normalized_proxy_url("127.0.0.1:7890").unwrap(),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            normalized_proxy_url("socks5h://127.0.0.1:1080").unwrap(),
            "socks5h://127.0.0.1:1080"
        );
        assert!(normalized_proxy_url("ftp://127.0.0.1:21").is_err());
        assert!(normalized_proxy_url("http://").is_err());
    }

    #[test]
    fn http_client_builder_supports_all_proxy_modes() {
        let mut preferences = UserPreferences::default();
        assert!(build_http_client(&preferences, Duration::from_secs(1)).is_ok());

        preferences.proxy_mode = ProxyMode::Disabled;
        assert!(build_http_client(&preferences, Duration::from_secs(1)).is_ok());

        preferences.proxy_mode = ProxyMode::Custom;
        preferences.proxy_url = "http://127.0.0.1:7890".into();
        assert!(build_http_client(&preferences, Duration::from_secs(1)).is_ok());

        preferences.proxy_url.clear();
        assert!(build_http_client(&preferences, Duration::from_secs(1)).is_err());
    }

    #[test]
    fn provider_order_accepts_unknown_ids_and_removes_duplicates() {
        let order = normalize_provider_order(&serde_json::json!([
            "openai",
            "future-custom-provider",
            "openai",
            "deepseek"
        ]))
        .unwrap();

        assert_eq!(
            order,
            vec!["openai", "future-custom-provider", "deepseek"]
        );
        assert!(normalize_provider_order(&serde_json::json!(["deepseek", 42])).is_err());

        let preferences = UserPreferences {
            provider_order: order,
            ..UserPreferences::default()
        };
        let value = serde_json::to_value(preferences).unwrap();
        assert_eq!(
            value["providerOrder"],
            serde_json::json!(["openai", "future-custom-provider", "deepseek"])
        );
    }

    #[test]
    fn provider_order_sorts_matches_and_stably_appends_unlisted_providers() {
        let providers = vec![
            "deepseek".into(),
            "xiaomi".into(),
            "openai".into(),
            "qwen".into(),
        ];
        let order = vec![
            "future-custom-provider".into(),
            "openai".into(),
            "deepseek".into(),
        ];

        assert_eq!(
            apply_provider_order(providers, &order),
            vec!["openai", "deepseek", "xiaomi", "qwen"]
        );
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

struct EnabledProvidersUpdateLock(Mutex<()>);

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ProxyMode {
    #[default]
    System,
    Disabled,
    Custom,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ThemeMode {
    Light,
    Dark,
    #[default]
    System,
}

fn default_source_font_size() -> u8 { 14 }
fn default_translation_font_size() -> u8 { 16 }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserPreferences {
    auto_selection: bool,
    keep_on_top: bool,
    #[serde(default)]
    quick_translate_provider: Option<String>,
    #[serde(default)]
    theme_mode: ThemeMode,
    #[serde(default = "default_source_font_size")]
    source_font_size: u8,
    #[serde(default = "default_translation_font_size")]
    translation_font_size: u8,
    #[serde(default)]
    proxy_mode: ProxyMode,
    #[serde(default)]
    proxy_url: String,
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
            theme_mode: ThemeMode::System,
            source_font_size: default_source_font_size(),
            translation_font_size: default_translation_font_size(),
            proxy_mode: ProxyMode::System,
            proxy_url: String::new(),
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
            .saturating_sub(FLOAT_ANCHOR_GAP)
            .saturating_sub(FLOAT_SIZE)
            .saturating_add(FLOAT_PADDING)
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

fn build_http_client(
    preferences: &UserPreferences,
    timeout: Duration,
) -> Result<Client, String> {
    let mut builder = Client::builder().timeout(timeout);
    builder = match preferences.proxy_mode {
        ProxyMode::System => builder,
        ProxyMode::Disabled => builder.no_proxy(),
        ProxyMode::Custom => {
            let proxy_url = normalized_proxy_url(&preferences.proxy_url)?;
            let proxy = reqwest::Proxy::all(&proxy_url)
                .map_err(|_| "无法使用该代理地址，请检查协议、主机和端口。".to_string())?
                .no_proxy(reqwest::NoProxy::from_string(LOOPBACK_PROXY_BYPASS));
            builder.proxy(proxy)
        }
    };
    builder
        .build()
        .map_err(|error| format!("无法初始化网络连接：{error}"))
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
        "deepseek" | "xiaomi" | "qwen" | "zhipu" | "moonshot" | "openai"
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

fn disable_thinking_for_openai_compatible(provider: &str, body: &mut serde_json::Value) {
    match provider {
        "qwen" => body["enable_thinking"] = serde_json::json!(false),
        "deepseek" => {
            body["thinking"] = serde_json::json!({ "type": DEEPSEEK_THINKING_DISABLED });
        }
        // Other OpenAI-compatible models do not enable extended reasoning
        // unless a reasoning/thinking option is explicitly sent.
        _ => {}
    }
}

async fn request_translation(
    provider: String,
    model: String,
    text: String,
    preferences: UserPreferences,
) -> Result<ProviderTranslation, String> {
    let config = configured_provider(&provider)?;
    let model = model.trim().to_string();
    if !config.models.contains(&model) {
        return Err(format!("{provider} 模型 {model} 未配置。"));
    }
    let target = translation_target(&text);
    let prompt = format!(
        "Translate the following text into natural {target}. The target language is fixed by the application; do not answer in the source language, even when the input mixes Chinese and English terms. Preserve product names, model names, acronyms, and technical notation. Return only the translation, without notes or quotation marks.\n\n{text}"
    );
    let client = build_http_client(&preferences, Duration::from_secs(30))?;
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "You are a precise translation engine." },
            { "role": "user", "content": prompt }
        ],
        "stream": false
    });
    disable_thinking_for_openai_compatible(&provider, &mut body);
    let endpoint = api_endpoint(&config.base_url, "chat/completions")?;
    if uses_azure_api_key(&provider, &endpoint) {
        body.as_object_mut().map(|body| body.remove("model"));
    }
    let response = authenticated_request(client.post(&endpoint), &provider, &config.api_key, &endpoint)
        .json(&body)
        .send()
        .await
    .map_err(|error| format!("无法连接 {provider}：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default().chars().take(400).collect::<String>();
        return Ok(ProviderTranslation {
            provider_id: provider,
            model,
            translation: None,
            error: Some(format!("请求失败（{status}）：{detail}")),
        });
    }
    let payload: serde_json::Value = match response.json().await {
        Ok(payload) => payload,
        Err(error) => return Ok(ProviderTranslation {
            provider_id: provider,
            model,
            translation: None,
            error: Some(format!("无法解析响应：{error}")),
        }),
    };
    let translation = extract_response_text(&payload, &provider);
    Ok(ProviderTranslation {
        provider_id: provider,
        model,
        error: translation.is_none().then(|| "没有返回翻译结果。".to_string()),
        translation,
    })
}

fn api_endpoint(base_url: &str, endpoint: &str) -> Result<String, String> {
    validate_base_url(base_url)?;
    let mut url = reqwest::Url::parse(base_url.trim())
        .map_err(|_| "Base URL 必须是有效的 HTTPS URL。".to_string())?;
    let endpoint = endpoint.trim_matches('/');
    let path = url.path().trim_end_matches('/');
    if path.ends_with(&format!("/{endpoint}")) {
        return Ok(url.to_string());
    }

    // Users frequently paste a complete endpoint. Replace a known API
    // resource instead of producing paths such as /chat/completions/models.
    let known_suffixes = ["/chat/completions", "/responses", "/models"];
    let mut root = known_suffixes
        .iter()
        .find_map(|suffix| path.strip_suffix(suffix))
        .unwrap_or(path)
        .trim_end_matches('/')
        .to_string();
    if root.is_empty() {
        root.push_str("/v1");
    }
    url.set_path(&format!("{root}/{endpoint}"));
    Ok(url.to_string())
}

fn normalize_provider_base_url(provider: &str, base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if !matches!(provider, "xiaomi" | "moonshot") {
        return trimmed.to_string();
    }
    let Ok(mut url) = reqwest::Url::parse(trimmed) else {
        return trimmed.to_string();
    };
    if url.path().trim_end_matches('/') != "/v1" || url.query().is_some() || url.fragment().is_some() {
        return trimmed.to_string();
    }
    url.set_path("");
    url.to_string().trim_end_matches('/').to_string()
}

fn uses_azure_api_key(provider: &str, endpoint: &str) -> bool {
    provider == "openai" && reqwest::Url::parse(endpoint).ok().is_some_and(|url| {
        url.host_str().is_some_and(|host| host.ends_with(".openai.azure.com"))
            || url.path().contains("/openai/deployments/")
    })
}

fn authenticated_request(
    request: reqwest::RequestBuilder,
    provider: &str,
    api_key: &str,
    endpoint: &str,
) -> reqwest::RequestBuilder {
    if api_key.trim().is_empty() {
        request
    } else if uses_azure_api_key(provider, endpoint) {
        request.header("api-key", api_key)
    } else {
        request.bearer_auth(api_key)
    }
}

fn text_from_content(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return (!text.trim().is_empty()).then(|| text.trim().to_string());
    }
    let parts = value
        .as_array()?
        .iter()
        .filter(|part| {
            part.get("thought").and_then(serde_json::Value::as_bool) != Some(true)
                && !matches!(
                    part.get("type").and_then(serde_json::Value::as_str),
                    Some("reasoning" | "thinking")
                )
        })
        .filter_map(|part| {
            part.get("text")
                .and_then(|text| text.as_str().or_else(|| text.get("value")?.as_str()))
                .or_else(|| part.get("content")?.as_str())
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join(""))
}

fn extract_response_text(payload: &serde_json::Value, _provider: &str) -> Option<String> {
    let direct = payload
        .pointer("/choices/0/message/content")
        .or_else(|| payload.pointer("/choices/0/text"))
        .or_else(|| payload.get("output_text"));
    if let Some(text) = direct.and_then(text_from_content) {
        return Some(text);
    }

    // OpenAI Responses-compatible gateways return output[].content[].text.
    payload
        .get("output")?
        .as_array()?
        .iter()
        .filter_map(|item| item.get("content"))
        .filter_map(text_from_content)
        .next()
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
    preferences: &UserPreferences,
) -> Result<(), String> {
    validate_base_url(base_url)?;
    if model.trim().is_empty() {
        return Err("模型名称不能为空。".to_string());
    }

    let client = build_http_client(preferences, Duration::from_secs(20))?;

    let endpoint = api_endpoint(base_url, "chat/completions")?;
    let mut body = serde_json::json!({
        "model": model.trim(),
        "messages": [{ "role": "user", "content": "Reply with OK only." }],
        "stream": false
    });
    disable_thinking_for_openai_compatible(provider, &mut body);
    if uses_azure_api_key(provider, &endpoint) {
        body.as_object_mut().map(|body| body.remove("model"));
    }
    let response = authenticated_request(client.post(&endpoint), provider, api_key, &endpoint)
        .json(&body)
        .send()
        .await
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

fn model_entry_supports_translation(entry: &serde_json::Value, model: &str) -> bool {
    if modality_list_supports(entry, &["input_modalities", "supported_input_modalities"], "text") == Some(false)
        || modality_list_supports(entry, &["output_modalities", "supported_output_modalities"], "text") == Some(false)
    {
        return false;
    }

    model_id_is_suitable_for_translation(model)
}

fn parse_model_ids(_provider: &str, payload: &serde_json::Value) -> Result<Vec<String>, String> {
    let entries = payload
        .get("data")
        .or_else(|| payload.get("models"))
        .and_then(serde_json::Value::as_array)
        .or_else(|| payload.as_array())
    .ok_or_else(|| "接口没有返回可识别的模型列表。".to_string())?;
    let mut models = entries.iter().filter_map(|entry| {
        let model = if let Some(model) = entry.as_str() {
            model
        } else {
            entry
                .get("id")
                .or_else(|| entry.get("name"))
                .or_else(|| entry.get("model"))?
                .as_str()?
        };
        (!model.trim().is_empty() && model_entry_supports_translation(entry, model))
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
    preferences: &UserPreferences,
) -> Result<Vec<String>, String> {
    validate_base_url(base_url)?;
    let client = build_http_client(preferences, Duration::from_secs(20))?;
    let endpoint = api_endpoint(base_url, "models")?;
    let response = authenticated_request(client.get(&endpoint), provider, api_key, &endpoint)
        .send()
        .await
    .map_err(|error| format!("获取模型列表失败：{error}"))?;

    let status = response.status();
    if !status.is_success() {
        if matches!(status.as_u16(), 401 | 403) {
            return Err(format!("获取模型列表失败（{status}）：接口需要 API Key，请填写后重试。"));
        }
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
    request_id: u64,
) -> Result<TranslationBatch, String> {
    let source = text.trim().to_string();
    if source.is_empty() { return Err("没有可翻译的文本。".to_string()); }
    if source.chars().count() > 12_000 {
        return Err("单次翻译最多支持 12,000 个字符。".to_string());
    }
    let request_preferences = current_preferences(&app);
    let enabled_providers = apply_provider_order(
        enabled_providers_sync(),
        &request_preferences.provider_order,
    );
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
    let mut targets = Vec::new();
    for provider in providers {
        let config = configured_provider(&provider)?;
        targets.extend(
            config
                .models
                .into_iter()
                .map(|model| (provider.clone(), model)),
        );
    }
    let pending_result = TranslationBatch {
        source: source.clone(),
        request_id,
        results: targets.iter().map(|(provider, model)| ProviderTranslation {
            provider_id: provider.clone(),
            model: model.clone(),
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
    app.emit("translation-started", &pending_result).map_err(|error| error.to_string())?;

    let mut pending = Vec::with_capacity(targets.len());
    for (provider, model) in targets {
        let request_text = source.clone();
        let task_provider = provider.clone();
        let task_model = model.clone();
        let task_app = app.clone();
        let task_preferences = request_preferences.clone();
        pending.push((
            (provider.clone(), model.clone()),
            tauri::async_runtime::spawn(async move {
                let result = match request_translation(
                    task_provider,
                    task_model,
                    request_text,
                    task_preferences,
                )
                .await
                {
                    Ok(result) => result,
                    Err(error) => ProviderTranslation {
                        provider_id: provider,
                        model,
                        translation: None,
                        error: Some(error),
                    },
                };
                publish_provider_result(&task_app, request_id, &result);
                result
            }),
        ));
    }
    let mut results = Vec::with_capacity(pending.len());
    for ((provider, model), task) in pending {
        let result = match task.await {
            Ok(result) => result,
            Err(error) => ProviderTranslation {
                provider_id: provider,
                model,
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
        keyring_entry()?.set_password(&key)
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
    tauri::async_runtime::spawn_blocking(move || {
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
    if provider != "openai" {
        return Err("只能删除用户添加的自定义供应商。".to_string());
    }
    let removed_provider = provider.clone();
    let update_app = app.clone();
    let provider_order = current_preferences(&app).provider_order;
    let (providers, reset_active_provider) = tauri::async_runtime::spawn_blocking(move || {
        let update_lock = update_app.state::<EnabledProvidersUpdateLock>();
        let _guard = update_lock.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match provider_keyring_entry(&provider)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => return Err(format!("无法删除自定义供应商配置：{error}")),
        }
        let mut providers = enabled_providers_sync();
        providers.retain(|item| item != &provider);
        let providers = apply_provider_order(providers, &provider_order);
        save_enabled_providers_sync(&providers)?;
        let reset_active_provider = active_provider_sync() == provider;
        if reset_active_provider {
            active_provider_entry()?
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
) -> Result<Vec<String>, String> {
    if !supported_provider(&provider) {
        return Err(format!("不支持的 AI 提供商：{provider}"));
    }
    let key = provider_api_key(&provider, &api_key);
    let preferences = current_preferences(&app);
    fetch_models(&provider, &key, &base_url, &preferences).await
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
            if providers.is_empty() {
                return Err("至少需要保留一个启用的翻译模型。".to_string());
            }
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
async fn set_user_preference(
    app: AppHandle,
    preference: String,
    value: serde_json::Value,
) -> Result<UserPreferences, String> {
    let updates_provider_order = preference == "providerOrder";
    let update_app = app.clone();
    let preferences = tauri::async_runtime::spawn_blocking(move || {
        let state = update_app.state::<Mutex<UserPreferences>>();
        let mut current = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut updated = current.clone();
        match preference.as_str() {
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
            "themeMode" => {
                updated.theme_mode = match value.as_str() {
                    Some("light") => ThemeMode::Light,
                    Some("dark") => ThemeMode::Dark,
                    Some("system") => ThemeMode::System,
                    _ => return Err("themeMode must be light, dark, or system".to_string()),
                };
            }
            "sourceFontSize" => {
                let size = value.as_u64()
                    .ok_or_else(|| "sourceFontSize must be an integer".to_string())?;
                if !(12..=24).contains(&size) {
                    return Err("sourceFontSize must be between 12 and 24".to_string());
                }
                updated.source_font_size = size as u8;
            }
            "translationFontSize" => {
                let size = value.as_u64()
                    .ok_or_else(|| "translationFontSize must be an integer".to_string())?;
                if !(12..=28).contains(&size) {
                    return Err("translationFontSize must be between 12 and 28".to_string());
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
            "providerOrder" => {
                updated.provider_order = normalize_provider_order(&value)?;
            }
            _ => return Err(format!("Unsupported user preference: {preference}")),
        }
        updated.preference_version = USER_PREFERENCES_VERSION;
        save_preferences_sync(&updated)?;
        *current = updated.clone();
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
        window.set_size(Size::Logical(LogicalSize::new(1120.0, 760.0))).map_err(|error| error.to_string())?;
        window.set_resizable(false).map_err(|error| error.to_string())?;
        window.set_minimizable(true).map_err(|error| error.to_string())?;
        configure_standard_window_frame(&window, dark, follow_system)?;
        window.set_always_on_top(false).map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
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

fn show_add_provider_window(app: &AppHandle) -> Result<(), String> {
    let appearance = current_window_appearance(app);
    let dark = appearance.dark;
    let follow_system = appearance.follow_system;
    if let Some(window) = app.get_webview_window("add-provider") {
        window.set_size(Size::Logical(LogicalSize::new(640.0, 600.0))).map_err(|error| error.to_string())?;
        window.set_resizable(false).map_err(|error| error.to_string())?;
        configure_standard_window_frame(&window, dark, follow_system)?;
        if let Some(parent) = app.get_webview_window("settings") {
            center_child_window(&window, &parent)?;
        } else {
            window.center().map_err(|error| error.to_string())?;
        }
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let settings_parent = app.get_webview_window("settings");
    let center_parent = settings_parent.clone();
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
                    eprintln!("Add-provider custom frame refresh failed: {error}");
                }
                let position_result = if let Some(parent) = center_parent.as_ref() {
                    center_child_window(&window, parent)
                } else {
                    window.center().map_err(|error| error.to_string())
                };
                if let Err(error) = position_result {
                    eprintln!("Add-provider window centering failed: {error}");
                }
                if let Err(error) = window.show() {
                    eprintln!("Add-provider window show after page load failed: {error}");
                }
                if let Err(error) = window.set_focus() {
                    eprintln!("Add-provider window focus after page load failed: {error}");
                }
            }
        })
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
    show_add_provider_window(&app)
}

#[tauri::command]
async fn return_to_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("add-provider") {
        window.close().map_err(|error| error.to_string())?;
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
        let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
        shape_float_window_as_round_rect(float_window, scale_factor)?;
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
    let preferences = load_preferences_sync().unwrap_or_else(|error| {
        eprintln!("Could not load interface preferences, using defaults: {error}");
        UserPreferences::default()
    });
    tauri::Builder::default()
        .manage(Mutex::<SelectionController>::default())
        .manage(Mutex::new(preferences))
        .manage(Mutex::new(None::<TranslationBatch>))
        .manage(EnabledProvidersUpdateLock(Mutex::new(())))
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
            delete_custom_provider,
            test_provider_connection,
            fetch_provider_models,
            get_active_provider,
            set_active_provider,
            get_enabled_providers,
            set_provider_enabled,
            has_api_key,
            get_preferences,
            set_user_preference,
            hide_window,
            minimize_window,
            set_window_appearance,
            open_settings_window,
            open_add_provider_window,
            return_to_settings_window,
            hide_settings_window,
        ])
        .run(tauri::generate_context!())
        .expect("启动 AI Translate 失败");
}
