//! Keep settings windows inside the current monitor's usable desktop area.
use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, WebviewWindow};

fn fit_axis(position: i32, size: u32, origin: i32, available: u32) -> (i32, u32) {
    let margin = 8_u32.min(available.saturating_sub(1) / 2);
    let size = size.max(1).min(available.saturating_sub(margin * 2).max(1));
    let start = i64::from(origin) + i64::from(margin);
    let end = (i64::from(origin) + i64::from(available) - i64::from(margin)
        - i64::from(size)).max(start);
    (i64::from(position).clamp(start, end) as i32, size)
}

pub(crate) fn fit_settings_window(
    window: &WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let monitor = window.current_monitor().map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or_else(|| "No monitor is available for the settings window.".to_string())?;
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let frame_width = outer.width.saturating_sub(inner.width);
    let frame_height = outer.height.saturating_sub(inner.height);
    let (x, width) = fit_axis(position.x, (width * scale).round() as u32 + frame_width,
        work.position.x, work.size.width);
    let (y, height) = fit_axis(position.y, (height * scale).round() as u32 + frame_height,
        work.position.y, work.size.height);
    // A fixed minimum larger than the work area would override our fitted size.
    window.set_min_size(Some(LogicalSize::new(1.0, 1.0))).map_err(|e| e.to_string())?;
    window.set_size(PhysicalSize::new(width.saturating_sub(frame_width).max(1),
        height.saturating_sub(frame_height).max(1))).map_err(|e| e.to_string())?;
    window.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::fit_axis;

    #[test]
    fn fits_scaled_window_and_keeps_taskbar_area_clear() {
        assert_eq!(fit_axis(0, 1140, 0, 1040), (8, 1024));
        assert_eq!(fit_axis(1500, 960, 0, 1920), (952, 960));
    }

    #[test]
    fn handles_negative_monitor_origins_and_tiny_work_areas() {
        assert_eq!(fit_axis(0, 640, -1920, 1920), (-648, 640));
        assert_eq!(fit_axis(-3000, 640, -1920, 1920), (-1912, 640));
        assert_eq!(fit_axis(0, 640, 0, 1), (0, 1));
        assert_eq!(fit_axis(200, 100, 0, 0), (0, 1));
    }
}
