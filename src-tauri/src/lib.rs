mod selection_state;
pub mod mouse_hook;
pub mod windows_selection;

use selection_state::{Anchor, SelectionController, StateChange};
use windows_selection::{capture_selection, CaptureOutcome};
use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Condvar, Mutex},
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{
    Builder as GlobalShortcutBuilder, Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

const KEYRING_SERVICE: &str = "ai-translate";
const KEYRING_ACCOUNT: &str = "deepseek-api-key";
const DEEPSEEK_URL: &str = "https://api.deepseek.com/chat/completions";
const FLOAT_SIZE: i32 = 24;

fn shape_float_window_as_circle(hwnd: windows::Win32::Foundation::HWND) -> Result<(), String> {
    use windows::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{CreateEllipticRgn, DeleteObject, HGDIOBJ, SetWindowRgn},
        UI::WindowsAndMessaging::GetClientRect,
    };

    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) }.map_err(|error| error.to_string())?;

    let region = unsafe { CreateEllipticRgn(client.left, client.top, client.right, client.bottom) };
    if region.is_invalid() {
        return Err("Could not create the circular selection-float region.".into());
    }

    if unsafe { SetWindowRgn(hwnd, Some(region), true) } == 0 {
        let _ = unsafe { DeleteObject(HGDIOBJ(region.0)) };
        return Err("Could not apply the circular selection-float region.".into());
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
            Anchor { x: 176, y: 0 },
        );
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
    fn optional_selection_startup_failure_does_not_abort_shortcut_setup() {
        let steps = Mutex::new(Vec::new());

        let result = initialize_required_then_optional(
            || {
                steps.lock().unwrap().push("shortcut");
                Ok(())
            },
            || {
                steps.lock().unwrap().push("selection-float");
                Err("hook unavailable".to_string())
            },
        );

        assert_eq!(result, Ok(()));
        assert_eq!(
            *steps.lock().unwrap(),
            vec!["shortcut", "selection-float"]
        );
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
    fn capture_failure_keeps_the_last_valid_selection() {
        let mut controller = visible_controller("one");
        let generation = controller.begin_mouse_up();

        assert_eq!(
            handle_mouse_up(
                &mut controller,
                generation,
                CaptureOutcome::Failed("UIA unavailable".into()),
                false,
            ),
            StateChange::Unchanged
        );
        assert_eq!(controller.take_for_translation(), Some("one".into()));
    }
}

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
        x: anchor.x.saturating_add(8).clamp(work_x, max_x),
        y: anchor.y.saturating_sub(8).clamp(work_y, max_y),
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
        CaptureOutcome::Failed(_) => StateChange::Unchanged,
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

fn report_translation_error(app: &AppHandle, error: &str) {
    match app.get_webview_window("main") {
        Some(window) => {
            if let Err(show_error) = window.show() {
                eprintln!("Translation error window show failed: {show_error}");
            }
        }
        None => eprintln!("Translation error window is unavailable."),
    }
    if let Err(emit_error) = app.emit("translation-error", error) {
        eprintln!("Translation error event emission failed: {emit_error}");
    }
}

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

#[tauri::command]
async fn translate_selection_float(app: AppHandle) -> Result<(), String> {
    let text = {
        let controller = app.state::<Mutex<SelectionController>>();
        let mut controller = controller.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        controller.take_for_translation()
    };
    let Some(text) = text else {
        let error = "没有待翻译的选中文本。".to_string();
        report_translation_error(&app, &error);
        return Err(error);
    };

    if let Err(error) = hide_float(&app) {
        eprintln!("Selection float hide failed before translation: {error}");
    }
    match translate_and_display(app.clone(), text).await {
        Ok(_) => Ok(()),
        Err(error) => {
            report_translation_error(&app, &error);
            Err(error)
        }
    }
}

fn initialize_required_then_optional(
    required: impl FnOnce() -> Result<(), String>,
    optional: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    required()?;
    if let Err(error) = optional() {
        eprintln!("Selection float disabled: {error}");
    }
    Ok(())
}

fn initialize_tray_icon(app: &tauri::App) -> Result<(), String> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "AI Translate does not have a tray icon asset.".to_string())?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出")
        .build(app)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&quit_item]).map_err(|error| error.to_string())?;

    TrayIconBuilder::with_id("ai-translate-tray")
        .icon(icon)
        .tooltip("AI Translate")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                app.exit(0);
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
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
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
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .build()
            .map_err(|error| error.to_string())?;

    let result = (|| {
        let float_window = window.hwnd().map_err(|error| error.to_string())?;
        shape_float_window_as_circle(float_window)?;
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
    let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyT);
    tauri::Builder::default()
        .manage(Mutex::<SelectionController>::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(GlobalShortcutBuilder::new().with_handler(move |app, pressed, event| {
            if pressed == &shortcut && event.state() == ShortcutState::Pressed {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let text = app.clipboard().read_text().unwrap_or_default();
                    if let Err(error) = translate_and_display(app.clone(), text).await {
                        report_translation_error(&app, &error);
                    }
                });
            }
        }).build())
        .setup(move |app| {
            initialize_tray_icon(app)?;
            initialize_required_then_optional(
                || {
                    app.global_shortcut()
                        .register(shortcut)
                        .map_err(|error| format!("无法注册 Alt+T：{error}"))
                },
                || initialize_selection_float(app),
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            translate_text,
            translate_selection_float,
            save_api_key,
            has_api_key,
            copy_text,
            hide_window,
        ])
        .run(tauri::generate_context!())
        .expect("启动 AI Translate 失败");
}
