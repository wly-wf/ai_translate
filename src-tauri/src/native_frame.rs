use tauri::{window::Color, Theme, WebviewWindow};

const STANDARD_WINDOW_LABELS: [&str; 3] = ["main", "settings", "add-provider"];

fn is_standard_window(label: &str) -> bool {
    STANDARD_WINDOW_LABELS.contains(&label)
}

pub(crate) fn standard_window_background(dark: bool) -> Color {
    if dark {
        Color(23, 27, 35, 255)
    } else {
        Color(255, 255, 255, 255)
    }
}

pub(crate) fn window_uses_dark_theme(window: &WebviewWindow) -> bool {
    matches!(window.theme(), Ok(Theme::Dark))
}

#[cfg(target_os = "windows")]
const STANDARD_FRAME_SUBCLASS_ID: usize = 0x4149_5452;

#[cfg(target_os = "windows")]
unsafe extern "system" fn standard_frame_subclass_proc(
    hwnd: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    subclass_id: usize,
    _reference_data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::{
        Foundation::LRESULT,
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass},
            WindowsAndMessaging::{WM_NCCALCSIZE, WM_NCDESTROY},
        },
    };

    // Tao reserves the full resize-frame thickness on every side when an
    // undecorated window has a shadow. That non-client inset is the light band
    // visible around a dark WebView. The DWM frame is extended separately below,
    // so the client can occupy the complete window without losing its shadow.
    if message == WM_NCCALCSIZE && wparam.0 != 0 {
        return LRESULT(0);
    }

    if message == WM_NCDESTROY {
        let _ = unsafe {
            RemoveWindowSubclass(hwnd, Some(standard_frame_subclass_proc), subclass_id)
        };
    }

    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(target_os = "windows")]
fn apply_windows_custom_frame(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    use windows::Win32::{
        Graphics::Dwm::{
            DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMWA_BORDER_COLOR,
            DWMWA_CAPTION_COLOR, DWMWA_COLOR_NONE, DWMWA_USE_IMMERSIVE_DARK_MODE,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        },
        UI::{
            Controls::MARGINS,
            Shell::SetWindowSubclass,
            WindowsAndMessaging::{
                SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
                SWP_NOZORDER,
            },
        },
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    if window.label() == "add-provider" {
        // This reused window reloads immediately after hiding. Do not let DWM
        // animate its old surface while the WebView is being reset.
        let disable_transitions = 1_i32; // Win32 BOOL is a 32-bit integer.
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                std::ptr::from_ref(&disable_transitions).cast(),
                std::mem::size_of_val(&disable_transitions) as u32,
            )
        }
        .map_err(|error| error.to_string())?;
    }
    if !unsafe {
        SetWindowSubclass(
            hwnd,
            Some(standard_frame_subclass_proc),
            STANDARD_FRAME_SUBCLASS_ID,
            0,
        )
    }
    .as_bool()
    {
        return Err("Could not install the custom Windows frame handler.".into());
    }

    // A one-pixel extended DWM frame is the documented way to retain the native
    // shadow for a custom frame. DWMWCP_ROUND keeps the Windows 11 system radius,
    // while COLOR_NONE removes only its visible border stroke.
    let margins = MARGINS {
        cxLeftWidth: 1,
        cxRightWidth: 1,
        cyTopHeight: 1,
        cyBottomHeight: 1,
    };
    unsafe { DwmExtendFrameIntoClientArea(hwnd, &margins) }
        .map_err(|error| error.to_string())?;

    let border_color = DWMWA_COLOR_NONE;
    let corner_preference = DWMWCP_ROUND;
    let immersive_dark = i32::from(dark);
    let background = standard_window_background(dark);
    let caption_color = u32::from(background.0)
        | (u32::from(background.1) << 8)
        | (u32::from(background.2) << 16);

    unsafe {
        // These attributes are available on Windows 11. The extended custom
        // frame above remains valid on earlier Windows versions, so unsupported
        // cosmetic attributes are intentionally best-effort.
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            std::ptr::from_ref(&border_color).cast(),
            std::mem::size_of_val(&border_color) as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR,
            std::ptr::from_ref(&caption_color).cast(),
            std::mem::size_of_val(&caption_color) as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            std::ptr::from_ref(&immersive_dark).cast(),
            std::mem::size_of_val(&immersive_dark) as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&corner_preference).cast(),
            std::mem::size_of_val(&corner_preference) as u32,
        );
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

    Ok(())
}

pub(crate) fn configure_standard_window_frame(
    window: &WebviewWindow,
    dark: bool,
    follow_system: bool,
) -> Result<(), String> {
    if !is_standard_window(window.label()) {
        return Err(format!(
            "window {} is not a standard application window",
            window.label()
        ));
    }

    window
        .set_decorations(false)
        .map_err(|error| error.to_string())?;
    window.set_shadow(true).map_err(|error| error.to_string())?;
    window
        .set_background_color(Some(standard_window_background(dark)))
        .map_err(|error| error.to_string())?;
    window
        .set_theme(if follow_system {
            None
        } else {
            Some(if dark { Theme::Dark } else { Theme::Light })
        })
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    {
        let native_window = window.clone();
        window
            .run_on_main_thread(move || {
                if let Err(error) = apply_windows_custom_frame(&native_window, dark) {
                    eprintln!("Could not apply the custom Windows frame: {error}");
                }
            })
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_frame_is_limited_to_standard_application_windows() {
        for label in STANDARD_WINDOW_LABELS {
            assert!(is_standard_window(label));
        }
        assert!(!is_standard_window("selection-float"));
        assert!(!is_standard_window("future-overlay"));
    }

    #[test]
    fn main_window_keeps_native_shadow_for_the_custom_frame() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &config["app"]["windows"][0];

        assert_eq!(main["label"], "main");
        assert_eq!(main["decorations"], false);
        assert_eq!(main["shadow"], true);
        assert_eq!(main["transparent"], false);
    }

    #[test]
    fn standard_window_background_matches_the_css_canvas() {
        assert_eq!(standard_window_background(true), Color(23, 27, 35, 255));
        assert_eq!(standard_window_background(false), Color(255, 255, 255, 255));
    }
}
