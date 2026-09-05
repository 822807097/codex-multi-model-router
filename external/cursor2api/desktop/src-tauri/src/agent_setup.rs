//! Per-agent configuration writers.
//!
//! Each agent has an exact config shape (see BUILD_CONTRACT.md section 7). JSON
//! configs are deep-merged; the codex TOML config is edited as a string. All
//! writers are idempotent and back up any pre-existing file whose content differs
//! before overwriting it. The local API key literal `cursor-local` is always used
//! (never the real key), and the provided `api_key` argument is intentionally
//! ignored.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};

const LOCAL_API_KEY: &str = "cursor-local";
const BRAND: &str = "API for Cursor";

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    /// One of `configured`, `not_configured`, `not_installed`.
    pub status: String,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// `$XDG_CONFIG_HOME` if set and absolute, else `%USERPROFILE%\.config`.
fn config_home() -> Option<PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        let p = PathBuf::from(&xdg);
        if !xdg.is_empty() && p.is_absolute() {
            return Some(p);
        }
    }
    home().map(|h| h.join(".config"))
}

/// Roaming AppData (`%APPDATA%`).
fn appdata() -> Option<PathBuf> {
    dirs::config_dir()
}

// ---------------------------------------------------------------------------
// File IO helpers
// ---------------------------------------------------------------------------

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Back up `path` to `<name>.api-for-cursor-backup.<epoch_ms>` when the file
/// already exists and its content differs from `new_content` (best-effort).
fn backup_if_changed(path: &Path, new_content: &str) {
    if let Ok(existing) = fs::read_to_string(path) {
        if existing != new_content {
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "config".to_string());
            let backup_name = format!("{file_name}.api-for-cursor-backup.{}", epoch_ms());
            if let Some(parent) = path.parent() {
                let _ = fs::copy(path, parent.join(backup_name));
            }
        }
    }
}

fn write_pretty_json(path: &Path, value: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    backup_if_changed(path, &content);
    fs::write(path, content).map_err(|e| e.to_string())
}

fn write_text(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    backup_if_changed(path, content);
    fs::write(path, content).map_err(|e| e.to_string())
}

fn read_json_or(path: &Path, default: Value) -> Value {
    match fs::read_to_string(path) {
        Ok(c) => serde_json::from_str(&c).unwrap_or(default),
        Err(_) => default,
    }
}

// ---------------------------------------------------------------------------
// Shared model definitions
// ---------------------------------------------------------------------------

/// Model block used by opencode and kilo (`cost`/`limit` shape).
fn cost_limit_models() -> Value {
    json!({
        "composer-2.5": {
            "name": "Composer 2.5",
            "cost": { "input": 0.5, "output": 2.5 },
            "limit": { "context": 200000, "output": 65536 }
        },
        "composer-2.5-fast": {
            "name": "Composer 2.5 Fast",
            "cost": { "input": 3.0, "output": 15.0 },
            "limit": { "context": 200000, "output": 65536 }
        }
    })
}

/// cline modelInfo shape for a single model.
fn cline_model_info(input: f64, output: f64) -> Value {
    json!({
        "maxTokens": 65536,
        "contextWindow": 200000,
        "supportsImages": true,
        "supportsPromptCache": false,
        "inputPrice": input,
        "outputPrice": output,
        "temperature": 0,
        "supportsTools": true,
        "supportsStreaming": true,
        "systemRole": "system"
    })
}

/// pi model object.
fn pi_model(id: &str, name: &str, input: f64, output: f64) -> Value {
    json!({
        "name": name,
        "cost": { "input": input, "output": output, "cacheRead": 0, "cacheWrite": 0 },
        "limit": { "context": 200000, "output": 65536 },
        "id": id,
        "api": "openai-completions",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 200000,
        "maxTokens": 65536,
        "compat": {
            "supportsUsageInStreaming": true,
            "maxTokensField": "max_tokens",
            "requiresAssistantAfterToolResult": false
        }
    })
}

/// Ensure `value` is an object, returning a mutable map. Replaces non-object
/// values with a fresh empty object.
fn as_object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

fn opencode_path() -> Option<PathBuf> {
    config_home().map(|c| c.join("opencode").join("opencode.json"))
}

fn configure_opencode(base_url: &str) -> Result<String, String> {
    let path = opencode_path().ok_or_else(|| "cannot resolve opencode path".to_string())?;
    let mut root = as_object(read_json_or(&path, json!({})));

    let mut provider = as_object(root.get("provider").cloned().unwrap_or(json!({})));
    provider.remove("cursor");
    provider.remove("cursorsdk");
    provider.insert(
        "cursorapi".to_string(),
        json!({
            "npm": "@ai-sdk/openai-compatible",
            "name": BRAND,
            "options": { "baseURL": base_url, "apiKey": LOCAL_API_KEY },
            "models": cost_limit_models()
        }),
    );
    root.insert("provider".to_string(), Value::Object(provider));

    let needs_model = match root.get("model").and_then(|m| m.as_str()) {
        None => true,
        Some(m) => m.starts_with("cursor/") || m.starts_with("cursorsdk/"),
    };
    if needs_model {
        root.insert(
            "model".to_string(),
            Value::String("cursorapi/composer-2.5-fast".to_string()),
        );
    }

    write_pretty_json(&path, &Value::Object(root))?;
    Ok(path.to_string_lossy().to_string())
}

fn opencode_status() -> String {
    match opencode_path() {
        Some(path) => {
            let root = read_json_or(&path, json!({}));
            if root
                .get("provider")
                .and_then(|p| p.get("cursorapi"))
                .is_some()
            {
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        None => "not_configured".to_string(),
    }
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

fn codex_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".codex"))
}

/// Remove a TOML block beginning with `[header]` up to (but not including) the
/// next top-level `[` header or EOF. Header match is case-insensitive on the
/// exact bracketed header line.
fn remove_toml_block(content: &str, header: &str) -> String {
    let target = format!("[{header}]").to_lowercase();
    let lines: Vec<&str> = content.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed.to_lowercase() == target {
            // Skip this header and everything until the next `[` header or EOF.
            i += 1;
            while i < lines.len() {
                let t = lines[i].trim_start();
                if t.starts_with('[') {
                    break;
                }
                i += 1;
            }
        } else {
            out.push(lines[i].to_string());
            i += 1;
        }
    }
    out.join("\n")
}

fn configure_codex(base_url: &str) -> Result<String, String> {
    let dir = codex_dir().ok_or_else(|| "cannot resolve .codex path".to_string())?;
    let config_path = dir.join("config.toml");

    let mut content = fs::read_to_string(&config_path).unwrap_or_default();

    // Remove existing managed blocks (auth sub-table first).
    for header in [
        "model_providers.cursorapi.auth",
        "model_providers.cursorapi",
        "profiles.cursorapi",
        "profiles.cursorapi-fast",
    ] {
        content = remove_toml_block(&content, header);
    }

    let mut trimmed = content.trim_end().to_string();
    if !trimmed.is_empty() {
        trimmed.push_str("\n\n");
    }
    trimmed.push_str(&format!(
        "[model_providers.cursorapi]\n\
         name = \"{BRAND}\"\n\
         base_url = \"{base_url}\"\n\
         wire_api = \"responses\"\n\
         \n\
         [model_providers.cursorapi.auth]\n\
         command = \"cmd\"\n\
         args = [\"/c\", \"echo cursor-local\"]\n\
         refresh_interval_ms = 300000\n"
    ));

    write_text(&config_path, &trimmed)?;

    // Profile files (overwrite).
    let profile = dir.join("cursorapi.config.toml");
    write_text(
        &profile,
        "model_provider = \"cursorapi\"\nmodel = \"composer-2.5\"\n",
    )?;
    let profile_fast = dir.join("cursorapi-fast.config.toml");
    write_text(
        &profile_fast,
        "model_provider = \"cursorapi\"\nmodel = \"composer-2.5-fast\"\n",
    )?;

    Ok(config_path.to_string_lossy().to_string())
}

fn codex_status() -> String {
    let dir = match codex_dir() {
        Some(d) => d,
        None => return "not_configured".to_string(),
    };
    if !dir.exists() {
        return "not_installed".to_string();
    }
    let config_path = dir.join("config.toml");
    match fs::read_to_string(&config_path) {
        Ok(c) if c.contains("[model_providers.cursorapi]") => "configured".to_string(),
        _ => "not_configured".to_string(),
    }
}

// ---------------------------------------------------------------------------
// vscode
// ---------------------------------------------------------------------------

const VSCODE_APPS: [&str; 5] = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];

/// Resolve the VS Code-family app directory under `%APPDATA%`, returning the app
/// name and whether any family directory exists.
fn vscode_app() -> Option<(PathBuf, String, bool)> {
    let base = appdata()?;
    for app in VSCODE_APPS {
        if base.join(app).join("User").exists() {
            return Some((base.join(app).join("User"), app.to_string(), true));
        }
    }
    // None present; fall back to `Code`.
    Some((base.join("Code").join("User"), "Code".to_string(), false))
}

fn configure_vscode(base_url: &str) -> Result<String, String> {
    let (user_dir, _app, _installed) =
        vscode_app().ok_or_else(|| "cannot resolve VS Code path".to_string())?;
    let path = user_dir.join("chatLanguageModels.json");

    let existing = read_json_or(&path, json!([]));
    let mut array: Vec<Value> = match existing {
        Value::Array(a) => a,
        _ => Vec::new(),
    };
    array.retain(|item| {
        let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("");
        name != "CursorAPI" && name != BRAND
    });
    array.push(json!({
        "name": BRAND,
        "provider": "openai-compatible",
        "baseUrl": base_url,
        "models": ["composer-2.5", "composer-2.5-fast"]
    }));

    write_pretty_json(&path, &Value::Array(array))?;
    Ok(path.to_string_lossy().to_string())
}

fn vscode_status() -> String {
    match vscode_app() {
        Some((user_dir, _app, installed)) => {
            if !installed {
                return "not_installed".to_string();
            }
            let path = user_dir.join("chatLanguageModels.json");
            let existing = read_json_or(&path, json!([]));
            if let Value::Array(array) = existing {
                let present = array.iter().any(|item| {
                    let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    name == BRAND
                });
                if present {
                    return "configured".to_string();
                }
            }
            "not_configured".to_string()
        }
        None => "not_installed".to_string(),
    }
}

// ---------------------------------------------------------------------------
// cline
// ---------------------------------------------------------------------------

fn cline_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".cline").join("data"))
}

fn configure_cline(base_url: &str) -> Result<String, String> {
    let dir = cline_dir().ok_or_else(|| "cannot resolve .cline path".to_string())?;
    let global_path = dir.join("globalState.json");
    let secrets_path = dir.join("secrets.json");

    let mut global = as_object(read_json_or(&global_path, json!({})));
    global.insert("actModeApiProvider".into(), json!("openai"));
    global.insert("planModeApiProvider".into(), json!("openai"));
    global.insert("actModeOpenAiModelId".into(), json!("composer-2.5"));
    global.insert("planModeOpenAiModelId".into(), json!("composer-2.5-fast"));
    global.insert("actModeOpenAiModelInfo".into(), cline_model_info(0.5, 2.5));
    global.insert(
        "planModeOpenAiModelInfo".into(),
        cline_model_info(3.0, 15.0),
    );
    global.insert("openAiHeaders".into(), json!({}));
    global.insert("openAiBaseUrl".into(), json!(base_url));
    global.insert("welcomeViewCompleted".into(), json!(true));
    if !global.contains_key("remoteRulesToggles") {
        global.insert("remoteRulesToggles".into(), json!({}));
    }
    if !global.contains_key("remoteWorkflowToggles") {
        global.insert("remoteWorkflowToggles".into(), json!({}));
    }
    write_pretty_json(&global_path, &Value::Object(global))?;

    let mut secrets = as_object(read_json_or(&secrets_path, json!({})));
    secrets.insert("openAiApiKey".into(), json!(LOCAL_API_KEY));
    write_pretty_json(&secrets_path, &Value::Object(secrets))?;

    Ok(global_path.to_string_lossy().to_string())
}

fn cline_status() -> String {
    match cline_dir() {
        Some(dir) => {
            let global_path = dir.join("globalState.json");
            let global = read_json_or(&global_path, json!({}));
            if global
                .get("openAiBaseUrl")
                .and_then(|v| v.as_str())
                .is_some()
                && global.get("actModeOpenAiModelId").and_then(|v| v.as_str())
                    == Some("composer-2.5")
            {
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        None => "not_configured".to_string(),
    }
}

// ---------------------------------------------------------------------------
// kilo
// ---------------------------------------------------------------------------

fn kilo_path() -> Option<PathBuf> {
    config_home().map(|c| c.join("kilo").join("kilo.jsonc"))
}

fn configure_kilo(base_url: &str) -> Result<String, String> {
    let path = kilo_path().ok_or_else(|| "cannot resolve kilo path".to_string())?;
    let default = json!({ "$schema": "https://app.kilo.ai/config.json" });
    let mut root = as_object(read_json_or(&path, default));

    let mut provider = as_object(root.get("provider").cloned().unwrap_or(json!({})));
    provider.insert(
        "cursorapi".to_string(),
        json!({
            "options": { "baseURL": base_url, "apiKey": LOCAL_API_KEY },
            "models": cost_limit_models()
        }),
    );
    root.insert("provider".to_string(), Value::Object(provider));

    if !root.contains_key("model") {
        root.insert(
            "model".to_string(),
            Value::String("cursorapi/composer-2.5".to_string()),
        );
    }

    write_pretty_json(&path, &Value::Object(root))?;
    Ok(path.to_string_lossy().to_string())
}

fn kilo_status() -> String {
    match kilo_path() {
        Some(path) => {
            let root = read_json_or(&path, json!({}));
            if root
                .get("provider")
                .and_then(|p| p.get("cursorapi"))
                .is_some()
            {
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        None => "not_configured".to_string(),
    }
}

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

fn pi_path() -> Option<PathBuf> {
    home().map(|h| h.join(".pi").join("agent").join("models.json"))
}

fn configure_pi(base_url: &str) -> Result<String, String> {
    let path = pi_path().ok_or_else(|| "cannot resolve pi path".to_string())?;
    let default = json!({ "providers": {} });
    let mut root = as_object(read_json_or(&path, default));

    let mut providers = as_object(root.get("providers").cloned().unwrap_or(json!({})));
    providers.insert(
        "cursorapi".to_string(),
        json!({
            "baseUrl": base_url,
            "apiKey": LOCAL_API_KEY,
            "authHeader": true,
            "api": "openai-completions",
            "models": [
                pi_model("composer-2.5", "Composer 2.5", 0.5, 2.5),
                pi_model("composer-2.5-fast", "Composer 2.5 Fast", 3.0, 15.0)
            ]
        }),
    );
    root.insert("providers".to_string(), Value::Object(providers));

    write_pretty_json(&path, &Value::Object(root))?;
    Ok(path.to_string_lossy().to_string())
}

fn pi_status() -> String {
    match pi_path() {
        Some(path) => {
            let root = read_json_or(&path, json!({}));
            if root
                .get("providers")
                .and_then(|p| p.get("cursorapi"))
                .is_some()
            {
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        None => "not_configured".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn agent_status(id: &str) -> String {
    match id {
        "opencode" => opencode_status(),
        "codex" => codex_status(),
        "vscode" => vscode_status(),
        "cline" => cline_status(),
        "kilo" => kilo_status(),
        "pi" => pi_status(),
        _ => "not_configured".to_string(),
    }
}

fn agent_name(id: &str) -> &'static str {
    match id {
        "opencode" => "opencode",
        "codex" => "Codex",
        "vscode" => "VS Code",
        "cline" => "Cline",
        "kilo" => "Kilo Code",
        "pi" => "pi",
        _ => "Unknown",
    }
}

#[tauri::command]
pub fn get_supported_agents(_base_url: String) -> Result<Vec<AgentInfo>, String> {
    let ids = ["opencode", "codex", "vscode", "cline", "kilo", "pi"];
    let agents = ids
        .iter()
        .map(|id| AgentInfo {
            id: (*id).to_string(),
            name: agent_name(id).to_string(),
            status: agent_status(id),
        })
        .collect();
    Ok(agents)
}

#[tauri::command]
pub fn configure_agent(
    agent_id: String,
    base_url: String,
    _api_key: String,
) -> Result<String, String> {
    match agent_id.as_str() {
        "opencode" => configure_opencode(&base_url),
        "codex" => configure_codex(&base_url),
        "vscode" => configure_vscode(&base_url),
        "cline" => configure_cline(&base_url),
        "kilo" => configure_kilo(&base_url),
        "pi" => configure_pi(&base_url),
        other => Err(format!("unknown agent: {other}")),
    }
}
