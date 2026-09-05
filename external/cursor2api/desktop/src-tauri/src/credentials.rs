//! Windows Credential Manager access via the `keyring` crate (v4 / keyring-core 1).
//!
//! Storage target (service): `ai.standardagents.apiforcursor`, account `cursor-api-key`.
//! On read, if the default service has no entry we fall back to the legacy service
//! `ai.standardagents.cursorapi`; if found there we migrate it to the default service.
//!
//! keyring 4 split the credential API into `keyring-core` (the `Entry` type) and
//! per-platform store crates registered through `keyring::use_*_store`. We register
//! the Windows native store once at startup via [`init`]; the `Entry` API itself
//! (`Entry::new` / `get_password` / `set_password` / `delete_credential`) comes from
//! `keyring-core`.

use keyring_core::{Entry, Error};

const SERVICE: &str = "ai.standardagents.apiforcursor";
const LEGACY_SERVICE: &str = "ai.standardagents.cursorapi";
const ACCOUNT: &str = "cursor-api-key";

/// Register the platform credential store. Call once during app setup before any
/// credential operation. Best-effort: a failure is reported to the caller but does
/// not panic.
pub fn init() -> Result<(), String> {
    keyring::use_native_store(false).map_err(|e| e.to_string())
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

fn legacy_entry() -> Result<Entry, String> {
    Entry::new(LEGACY_SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

/// Read the stored API key, migrating from the legacy service if necessary.
/// Returns an empty string when no key is present. Used internally (e.g. by the
/// server module) and by the `get_api_key` command.
pub fn read_api_key() -> Result<String, String> {
    let entry = entry()?;
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(Error::NoEntry) => {
            // Try the legacy service and migrate if present.
            let legacy = legacy_entry()?;
            match legacy.get_password() {
                Ok(key) => {
                    // Re-save under the default service and remove the legacy entry.
                    let _ = entry.set_password(&key);
                    let _ = legacy.delete_credential();
                    Ok(key)
                }
                Err(Error::NoEntry) => Ok(String::new()),
                Err(e) => Err(e.to_string()),
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn get_api_key() -> Result<String, String> {
    read_api_key()
}

#[tauri::command]
pub fn set_api_key(key: String) -> Result<(), String> {
    let entry = entry()?;
    entry.set_password(key.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_api_key() -> Result<(), String> {
    let entry = entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn has_api_key() -> Result<bool, String> {
    Ok(!read_api_key()?.is_empty())
}
