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
fn tray_opens_quick_translate_on_left_button_down() {
    assert!(is_tray_primary_activation(
        MouseButton::Left,
        MouseButtonState::Down,
    ));
    assert!(!is_tray_primary_activation(
        MouseButton::Left,
        MouseButtonState::Up,
    ));
    assert!(!is_tray_primary_activation(
        MouseButton::Right,
        MouseButtonState::Down,
    ));
}

#[test]
fn float_position_uses_the_upper_right_of_the_selection_anchor() {
    assert_eq!(
        clamp_float_position(Anchor { x: 100, y: 100 }, 0, 0, 500, 500),
        Anchor { x: 108, y: 52 },
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
        scale_factor: 1.0,
        work_x: 0,
        work_y: 0,
        work_width: 1200,
        work_height: 800,
    };

    assert_eq!(translation_window_position(placement, 420, 330), Anchor { x: 140, y: 200 });
}

#[test]
fn translation_window_moves_left_when_the_right_side_is_too_small() {
    let placement = FloatPlacement {
        x: 1100,
        y: 200,
        width: 28,
        scale_factor: 1.0,
        work_x: 0,
        work_y: 0,
        work_width: 1200,
        work_height: 800,
    };

    assert_eq!(translation_window_position(placement, 420, 330), Anchor { x: 668, y: 200 });
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
        start_point: windows::Win32::Foundation::POINT { x: 0, y: 2 },
    });
    pending.submit(CaptureRequest {
        generation: 2,
        point: windows::Win32::Foundation::POINT { x: 3, y: 4 },
        start_point: windows::Win32::Foundation::POINT { x: 2, y: 4 },
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
fn vendor_supported_thinking_options_are_sent() {
    let mut xiaomi = serde_json::json!({});
    disable_thinking_for_openai_compatible("xiaomi", &mut xiaomi);
    assert_eq!(
        xiaomi["thinking"],
        serde_json::json!({ "type": "disabled" })
    );

    for provider in ["zhipu", "moonshot"] {
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
fn xiaomi_translation_requests_are_short_and_deterministic() {
    let mut payload = serde_json::json!({});
    configure_translation_request("xiaomi", "Chirp", &mut payload);

    assert_eq!(
        payload["thinking"],
        serde_json::json!({ "type": "disabled" })
    );
    assert_eq!(payload["temperature"], 0);
    assert_eq!(payload["max_completion_tokens"], 128);
}

#[test]
fn xiaomi_translation_output_limit_scales_with_source_length() {
    assert_eq!(translation_output_token_limit("Chirp"), 128);
    assert_eq!(translation_output_token_limit(&"a".repeat(1_000)), 4_064);
    assert_eq!(translation_output_token_limit(&"a".repeat(12_000)), 32_768);
}

#[test]
fn translation_prompt_uses_context_without_a_fixed_name_mapping() {
    let source = "大家好，我是飞出金陵的烤鸭，是25届的应届毕业生。";
    let prompt = translation_prompt(source, "English");
    assert!(prompt.contains("Use the surrounding context to decide how to render names and nicknames"));
    assert!(prompt.contains("<source_text>\n"));
    assert!(prompt.contains(source));
    assert!(!prompt.contains("do not leave Chinese characters"));
    assert!(prompt.contains("Preserve quotation marks that belong to the translated text"));
    assert!(!prompt.contains("never answer in the source language"));
    assert!(translation_prompt("Chirp", "Simplified Chinese")
        .contains("translate its ordinary dictionary meaning"));
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
    let request = authenticated_request(reqwest::Client::new().get(endpoint), "openai", "", endpoint)
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
fn chat_completion_text_accepts_multi_part_content() {
    let chat = serde_json::json!({
        "choices": [{ "message": { "content": [{ "type": "text", "text": "你好" }] } }]
    });
    assert_eq!(
        extract_chat_completion_text(&chat).as_deref(),
        Some("你好")
    );
}

#[test]
fn translation_rejects_incomplete_results_even_when_text_is_present() {
    for (reason, expected) in [
        ("length", "截断"),
        ("content_filter", "内容过滤"),
        ("tool_calls", "工具调用"),
        ("function_call", "工具调用"),
    ] {
        let payload = serde_json::json!({ "choices": [{
            "finish_reason": reason,
            "message": { "content": "部分译文" }
        }] });
        assert!(validated_translation_text(&payload).unwrap_err().contains(expected));
    }
}

#[test]
fn translation_rejects_refusals_and_empty_results() {
    let refusal = serde_json::json!({ "choices": [{
        "finish_reason": "stop",
        "message": { "content": "无法帮助", "refusal": "Request refused" }
    }] });
    assert!(validated_translation_text(&refusal).unwrap_err().contains("拒绝"));
    for content in [serde_json::Value::Null, serde_json::json!("  "), serde_json::json!([])] {
        let payload = serde_json::json!({ "choices": [{ "message": { "content": content } }] });
        assert_eq!(validated_translation_text(&payload).unwrap_err(), "没有返回翻译结果。");
    }
}

#[test]
fn translation_accepts_complete_and_compatible_results() {
    for reason in [serde_json::json!("stop"), serde_json::Value::Null, serde_json::json!("eos")] {
        let payload = serde_json::json!({ "choices": [{
            "finish_reason": reason,
            "message": { "content": "你好", "refusal": null }
        }] });
        assert_eq!(validated_translation_text(&payload).unwrap(), "你好");
    }
    let payload = serde_json::json!({ "choices": [{ "message": {
        "content": [{ "type": "text", "text": "第一段" }, { "type": "text", "text": "第二段" }]
    } }] });
    assert_eq!(validated_translation_text(&payload).unwrap(), "第一段第二段");
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
    assert_eq!(preferences.proxy_type, ProxyType::Http);
    assert_eq!(preferences.proxy_host, "127.0.0.1");
    assert_eq!(preferences.proxy_port, "7890");
    assert_eq!(preferences.proxy_bypass, DEFAULT_PROXY_BYPASS);
    assert_eq!(preferences.theme_mode, ThemeMode::System);
    assert_eq!(preferences.accent_color, AccentColor::Blue);
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
    assert_eq!(value["proxyType"], "http");
    assert_eq!(value["proxyHost"], "127.0.0.1");
    assert_eq!(value["accentColor"], "blue");
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
    preferences.proxy_type = ProxyType::Http;
    preferences.proxy_host = "127.0.0.1".into();
    preferences.proxy_port = "7890".into();
    assert!(build_http_client(&preferences, Duration::from_secs(1)).is_ok());

    preferences.proxy_host.clear();
    preferences.proxy_url.clear();
    assert!(build_http_client(&preferences, Duration::from_secs(1)).is_err());
}

#[test]
fn detailed_proxy_preferences_build_an_authenticated_url() {
    let preferences = UserPreferences {
        proxy_mode: ProxyMode::Custom,
        proxy_type: ProxyType::Socks5,
        proxy_host: "proxy.example.com".into(),
        proxy_port: "1080".into(),
        proxy_username: "user".into(),
        proxy_password: "secret".into(),
        ..UserPreferences::default()
    };
    let url = custom_proxy_url(&preferences).unwrap();
    assert_eq!(url, "socks5h://user:secret@proxy.example.com:1080");
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
