//! Windows autostart control via the HKCU Run key.
//!
//! Key: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
//! Value: `APIforCursor` = `"<current_exe>" --hidden`

use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "APIforCursor";

fn run_key(access: u32) -> Result<RegKey, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey_with_flags(RUN_KEY_PATH, access)
        .map_err(|e| e.to_string())
}

fn current_exe_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy().to_string();
    Ok(format!("\"{exe}\" --hidden"))
}

#[tauri::command]
pub fn is_autostart_enabled() -> Result<bool, String> {
    let key = run_key(KEY_READ)?;
    match key.get_value::<String, _>(VALUE_NAME) {
        Ok(_) => Ok(true),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn set_autostart_enabled(enabled: bool) -> Result<(), String> {
    let key = run_key(KEY_READ | KEY_WRITE)?;
    if enabled {
        let cmd = current_exe_command()?;
        key.set_value(VALUE_NAME, &cmd).map_err(|e| e.to_string())
    } else {
        match key.delete_value(VALUE_NAME) {
            Ok(()) => Ok(()),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
