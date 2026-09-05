//! Non-secret application settings persisted to
//! `%APPDATA%\API for Cursor\settings.json`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const DEFAULT_PORT: u16 = 8787;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub autostart: bool,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            port: DEFAULT_PORT,
            autostart: false,
        }
    }
}

/// Directory holding the settings file: `%APPDATA%\API for Cursor`.
fn settings_dir() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or_else(|| "could not resolve %APPDATA%".to_string())?;
    Ok(base.join("API for Cursor"))
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(settings_dir()?.join("settings.json"))
}

/// Load settings from disk, falling back to defaults when the file is missing
/// or unparsable.
pub fn load() -> Settings {
    let path = match settings_path() {
        Ok(p) => p,
        Err(_) => return Settings::default(),
    };
    let contents = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Settings::default(),
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

/// Persist settings to disk (pretty-printed), creating the directory if needed.
fn save(settings: &Settings) -> Result<(), String> {
    let dir = settings_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Convenience accessor for the configured port (defaults to 8787).
pub fn port() -> u16 {
    load().port
}

#[tauri::command]
pub fn get_settings() -> Result<Settings, String> {
    Ok(load())
}

#[tauri::command]
pub fn set_port(port: u16) -> Result<(), String> {
    let mut settings = load();
    settings.port = port;
    save(&settings)
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
