use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{
    Builder as GlobalShortcutBuilder, Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

const KEYRING_SERVICE: &str = "ai-translate";
const KEYRING_ACCOUNT: &str = "deepseek-api-key";
const DEEPSEEK_URL: &str = "https://api.deepseek.com/chat/completions";

#[derive(Clone, Debug, Serialize)]
struct Translation {
    source: String,
    translation: String,
}

#[derive(Serialize)]
struct ChatMessage<'a> { role: &'a str, content: &'a str }
#[derive(Serialize)]
struct Thinking { #[serde(rename = "type")] mode: &'static str }
#[derive(Serialize)]
struct DeepSeekRequest<'a> {
    model: &'static str,
    messages: Vec<ChatMessage<'a>>,
    thinking: Thinking,
    stream: bool,
    temperature: f32,
}
#[derive(Deserialize)]
struct DeepSeekResponse { choices: Vec<DeepSeekChoice> }
#[derive(Deserialize)]
struct DeepSeekChoice { message: DeepSeekMessage }
#[derive(Deserialize)]
struct DeepSeekMessage { content: Option<String> }

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())
}

fn api_key() -> Result<String, String> {
    keyring_entry()?.get_password().map_err(|_| "请先在设置中保存 DeepSeek API Key。".to_string())
}

async fn request_translation(text: &str) -> Result<String, String> {
    let key = api_key()?;
    let prompt = format!(
        "Translate the following text. Detect its language and translate it into natural Simplified Chinese if it is not Chinese; otherwise translate it into natural English. Return only the translation, without notes or quotation marks.\n\n{text}"
    );
    let body = DeepSeekRequest {
        model: "deepseek-v4-flash",
        messages: vec![
            ChatMessage { role: "system", content: "You are a precise translation engine." },
            ChatMessage { role: "user", content: &prompt },
        ],
        thinking: Thinking { mode: "disabled" },
        stream: false,
        temperature: 0.2,
    };
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("无法初始化网络连接：{error}"))?;
    let response = client.post(DEEPSEEK_URL).bearer_auth(key).json(&body).send().await
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

async fn translate_and_display(app: AppHandle, text: String) -> Result<Translation, String> {
    let source = text.trim().to_string();
    if source.is_empty() { return Err("没有可翻译的文本。".to_string()); }
    if source.chars().count() > 12_000 {
        return Err("单次翻译最多支持 12,000 个字符。".to_string());
    }
    let result = Translation { translation: request_translation(&source).await?, source };
    let window = app.get_webview_window("main").ok_or_else(|| "未找到结果窗口。".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_always_on_top(true).map_err(|error| error.to_string())?;
    app.emit("translation-result", &result).map_err(|error| error.to_string())?;
    Ok(result)
}

#[tauri::command]
async fn translate_text(app: AppHandle, text: String) -> Result<Translation, String> { translate_and_display(app, text).await }

#[tauri::command]
fn save_api_key(api_key: String) -> Result<(), String> {
    let value = api_key.trim();
    if value.is_empty() { return Err("API Key 不能为空。".to_string()); }
    keyring_entry()?.set_password(value).map_err(|error| format!("无法保存 API Key：{error}"))
}

#[tauri::command]
fn has_api_key() -> bool { api_key().is_ok() }

#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|error| format!("无法写入剪贴板：{error}"))
}

#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main").ok_or_else(|| "未找到结果窗口。".to_string())?
        .hide().map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyT);
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(GlobalShortcutBuilder::new().with_handler(move |app, pressed, event| {
            if pressed == &shortcut && event.state() == ShortcutState::Pressed {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let text = app.clipboard().read_text().unwrap_or_default();
                    if let Err(error) = translate_and_display(app.clone(), text).await {
                        let _ = app.emit("translation-error", error);
                        if let Some(window) = app.get_webview_window("main") { let _ = window.show(); }
                    }
                });
            }
        }).build())
        .setup(move |app| {
            app.global_shortcut().register(shortcut).map_err(|error| format!("无法注册 Alt+T：{error}"))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![translate_text, save_api_key, has_api_key, copy_text, hide_window])
        .run(tauri::generate_context!())
        .expect("启动 AI Translate 失败");
}
