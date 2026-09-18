//! Explicit opt-in only: uses the app's saved credentials and incurs API usage.
//! Never prints credentials, endpoint URLs, or raw provider errors.
use super::*;

const SCREENSHOT_SOURCE: &str = "第一个提交的信息首字符带了一个 UTF-8 BOM（git log 里 feat: 前有个零宽字符），是 PowerShell 写消息文件时加的。它不影响代码、测试、提交哈希或后续推送，只在 git log 显示时有点碍眼。修它需要 git commit --amend + rebase 重排（会改掉两个哈希）——我不想再为这点小事折腾你的历史，所以先停在这里。你要的话我可以用安全的方式（先打 tag 备份）单独处理。";

#[test]
#[ignore = "live API requests using saved Agnes configuration; run explicitly with --ignored --nocapture"]
fn live_agnes_translation_regression() {
    run_live_regression(false);
}

#[test]
#[ignore = "live baseline reproduction; uses saved Agnes credentials and incurs API usage"]
fn live_agnes_baseline_reproduction() {
    run_live_regression(true);
}

fn run_live_regression(baseline: bool) {
    let preferences = load_preferences_sync().expect("Unable to load app preferences");
    let mut models = Vec::new();
    for provider in ["deepseek", "xiaomi", "qwen", "zhipu", "moonshot", "openai"] {
        if let Ok(config) = configured_provider(provider) {
            for model in config.models {
                if model.contains("agnes-2.0-flash") || model.contains("agnes-2.5-flash") {
                    models.push((provider.to_string(), model));
                }
            }
        }
    }
    assert!(!models.is_empty(), "No saved Agnes 2.0/2.5 Flash models found");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let mut failures = 0;
    for (provider, model) in models {
        for attempt in 1..=3 {
            // Avoid bursts against low-rate-limit model endpoints.
            if attempt > 1 { std::thread::sleep(Duration::from_secs(20)); }
            let result = runtime.block_on(async {
                if baseline {
                    baseline_translation(&provider, &model, &preferences).await
                } else {
                    request_translation_with_config(provider.clone(), model.clone(), SCREENSHOT_SOURCE.to_string(), preferences.clone(), configured_provider(&provider)?).await
                        .and_then(|result| result.translation.ok_or_else(|| result.error.unwrap_or_default()))
                }
            });
            match result {
                Ok(text) => {
                    let residual = text.chars().any(is_cjk_character);
                    println!("model={model} attempt={attempt} residual_cjk={residual}\n{text}\n");
                    failures += usize::from(residual);
                }
                Err(error) => {
                    let category = if error.contains("自动纠正") { "quality_guard" }
                        else if error.contains("429") { "rate_limit" }
                        else if error.contains("无法连接") { "connection_or_timeout" }
                        else { "provider_or_response_error" };
                    println!("model={model} attempt={attempt} request_failed category={category} (details suppressed)");
                    failures += 1;
                }
            }
        }
    }
    assert_eq!(failures, 0, "Live requests failed or returned untranslated Chinese");
}

async fn baseline_translation(provider: &str, model: &str, preferences: &UserPreferences) -> Result<String, String> {
    let config = configured_provider(provider)?;
    let endpoint = api_endpoint(&config.base_url, "chat/completions")?;
    let client = build_http_client(preferences, Duration::from_secs(30))?;
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/translation_prompt_baseline.json")).unwrap();
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": fixture["system"].as_str().unwrap().replace("{target}", "English")},
            {"role": "user", "content": fixture["user"].as_str().unwrap().replace("{target}", "English").replace("{text}", SCREENSHOT_SOURCE)}
        ],
        "stream": false
    });
    configure_translation_request(provider, SCREENSHOT_SOURCE, &mut body);
    if uses_azure_api_key(provider, &endpoint) { body.as_object_mut().unwrap().remove("model"); }
    let response = authenticated_request(client.post(&endpoint), provider, &config.api_key, &endpoint)
        .json(&body).send().await.map_err(|_| "无法连接".to_string())?;
    if !response.status().is_success() { return Err(format!("HTTP {}", response.status().as_u16())); }
    let payload = response.json().await.map_err(|_| "Invalid JSON".to_string())?;
    validated_translation_text(&payload)
}
