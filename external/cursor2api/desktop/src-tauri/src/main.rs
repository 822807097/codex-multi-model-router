// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_setup;
mod autostart;
mod credentials;
mod server;
mod settings;
mod tray;

use std::sync::{Arc, Mutex};

use tauri::{Manager, RunEvent, WindowEvent};

use server::{ServerState, SharedServerState};

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    // The frontend may prefer the clipboard plugin; this is provided for parity
    // with the macOS app's command surface.
    let _ = text;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage::<SharedServerState>(Arc::new(Mutex::new(ServerState::default())))
        .on_window_event(|window, event| {
            // Closing the popup window (the X) only hides it — the app keeps running in
            // the system tray. The only way to actually quit is the tray "Quit" item.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let handle = app.handle();
            // Register the Windows credential store before any keyring use.
            if let Err(err) = credentials::init() {
                eprintln!("[credentials] failed to initialize store: {err}");
            }
            tray::setup(handle)?;
            server::start_sidecar(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            server::get_server_status,
            server::get_base_url,
            server::start_server,
            server::stop_server,
            credentials::get_api_key,
            credentials::set_api_key,
            credentials::delete_api_key,
            credentials::has_api_key,
            autostart::is_autostart_enabled,
            autostart::set_autostart_enabled,
            agent_setup::get_supported_agents,
            agent_setup::configure_agent,
            settings::get_settings,
            settings::set_port,
            settings::get_app_version,
            copy_text,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // The tray "Quit" item calls app.exit(); we do NOT prevent it (that was the
            // bug that made Quit do nothing). We only make sure the spawned server +
            // bridge processes are killed before the app goes away. Staying alive when
            // the popup is closed is handled by the window CloseRequested handler above.
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<SharedServerState>() {
                    if let Ok(mut guard) = state.lock() {
                        guard.kill_all();
                    }
                }
            }
        });
}
