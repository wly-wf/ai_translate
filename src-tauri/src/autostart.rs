use std::{os::windows::ffi::OsStrExt, path::Path};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::ERROR_FILE_NOT_FOUND,
        System::Registry::{
            RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER,
            REG_SZ, RRF_RT_REG_SZ,
        },
    },
};

const RUN_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const VALUE_NAME: PCWSTR = w!("AI Translate");

fn startup_command(path: &Path) -> Result<Vec<u16>, String> {
    let mut command = vec![b'"' as u16];
    command.extend(path.as_os_str().encode_wide());
    command.push(b'"' as u16);
    // Windows Run entries have a 260-character command-line limit.
    if command.len() > 260 || command[1..command.len() - 1].contains(&0) {
        return Err("程序路径过长或无效，无法设置开机自启动。".into());
    }
    command.push(0);
    Ok(command)
}

fn current_command() -> Result<Vec<u16>, String> {
    let path = std::env::current_exe().map_err(|error| format!("无法获取程序路径：{error}"))?;
    startup_command(&path)
}

#[tauri::command]
pub fn get_autostart() -> Result<bool, String> {
    let expected = current_command()?;
    let mut command = [0u16; 261];
    let mut bytes = std::mem::size_of_val(&command) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER, RUN_KEY, VALUE_NAME, RRF_RT_REG_SZ, None,
            Some(command.as_mut_ptr().cast()), Some(&mut bytes),
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(false);
    }
    status.ok().map_err(|error| format!("读取开机自启动设置失败：{error}"))?;
    Ok(command[..bytes as usize / 2] == expected)
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    let status = if enabled {
        let command = current_command()?;
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER, RUN_KEY, VALUE_NAME, REG_SZ.0,
                Some(command.as_ptr().cast()), (command.len() * 2) as u32,
            )
        }
    } else {
        // Delete only this application's value, preserving other startup apps.
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, VALUE_NAME) }
    };
    if !enabled && status == ERROR_FILE_NOT_FOUND {
        return Ok(false);
    }
    status.ok().map_err(|error| format!("保存开机自启动设置失败：{error}"))?;
    get_autostart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_paths_with_spaces_and_unicode() {
        let command = startup_command(Path::new(r"C:\翻译工具\AI Translate.exe")).unwrap();
        assert_eq!(String::from_utf16(&command[..command.len() - 1]).unwrap(),
            "\"C:\\翻译工具\\AI Translate.exe\"");
        assert_eq!(command.last(), Some(&0));
    }

    #[test]
    fn rejects_commands_exceeding_windows_run_limit() {
        assert!(startup_command(Path::new(&"a".repeat(259))).is_err());
        assert!(startup_command(Path::new(&"a".repeat(258))).is_ok());
    }
}
