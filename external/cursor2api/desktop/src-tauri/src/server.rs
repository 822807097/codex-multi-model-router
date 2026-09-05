//! Sidecar lifecycle management for the two-process architecture (macOS parity).
//!
//! Two local processes are spawned and wired together per the BUILD_CONTRACT parity addendum:
//!   * Server B — the `@cursor/sdk` bridge. It is NOT a Tauri `--compile` sidecar because
//!     `@cursor/sdk` loads a native addon (`sqlite3`/`node_sqlite3.node`) that cannot be
//!     embedded in a standalone binary. It is also run under **Node**, NOT Bun: the SDK talks
//!     to Cursor over gRPC/Connect (HTTP/2) and Bun's HTTP/2 client fails with
//!     `NGHTTP2_FRAME_SIZE_ERROR`, whereas Node works (and is what the production container
//!     uses). So — like the macOS app — we ship a bundled `node` runtime + the raw
//!     `cursor-sdk-local-agent-bridge.mjs` + an on-disk `node_modules` as Tauri resources, and
//!     run `node <script>`. Spawned FIRST.
//!     Env: `CURSOR_SDK_BRIDGE_HOST`, `CURSOR_SDK_BRIDGE_PORT`, `CURSOR_SDK_BRIDGE_TOKEN`,
//!     `CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS`.
//!   * Server A — the main `api-for-cursor-server` Tauri sidecar (node:http, serves `/v1/*`).
//!     Env: `PORT`, `CURSOR_API_KEY`, `CURSOR_SDK_BRIDGE_URL`, `CURSOR_SDK_BRIDGE_TOKEN`.
//!
//! A random hex token authenticates Server A to the bridge; a free bridge port is probed
//! starting at 8792. If the bridge runtime is unavailable, Server A still starts (so
//! `/v1/models` and `/health` keep working) and chat/responses degrade gracefully. Both child
//! handles live in [`ServerState`]; stopping the server (or dropping the state on app exit)
//! kills BOTH.

use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child as StdChild, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;

use crate::credentials;
use crate::settings;

/// Main HTTP server sidecar (`/v1/*`).
const SERVER_SIDECAR_NAME: &str = "api-for-cursor-server";
/// Bundled bridge runtime files (under the `bridge/` resource directory).
/// Node (not Bun) — Bun's HTTP/2 client breaks @cursor/sdk's gRPC calls to Cursor.
const BRIDGE_RUNTIME_EXE: &str = "node.exe";
const BRIDGE_SCRIPT: &str = "cursor-sdk-local-agent-bridge.mjs";

/// Default bridge port; we scan upward from here for a free one.
const DEFAULT_BRIDGE_PORT: u16 = 8792;
/// How many ports above the default to probe before giving up.
const BRIDGE_PORT_SCAN: u16 = 100;
/// Bridge per-run timeout (milliseconds), forwarded as an env var.
const BRIDGE_RUN_TIMEOUT_MS: u32 = 120000;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Shared, mutable state describing the running processes.
#[derive(Default)]
pub struct ServerState {
    /// Main `api-for-cursor-server` sidecar child handle.
    pub child: Option<CommandChild>,
    /// `@cursor/sdk` bridge child handle (a plain OS process: bun + script).
    pub bridge_child: Option<StdChild>,
    pub port: u16,
    pub running: bool,
}

impl ServerState {
    /// Kill both child processes if present, clearing their handles. Used by
    /// `stop_server`, the terminate handler, the app-exit handler, and on drop.
    pub fn kill_all(&mut self) {
        if let Some(child) = self.child.take() {
            let _ = child.kill();
        }
        if let Some(mut bridge) = self.bridge_child.take() {
            let _ = bridge.kill();
        }
        self.running = false;
    }
}

impl Drop for ServerState {
    fn drop(&mut self) {
        // Ensure no orphaned processes survive app exit.
        self.kill_all();
    }
}

pub type SharedServerState = Arc<Mutex<ServerState>>;

/// JSON-serializable status returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
}

fn snapshot(state: &ServerState) -> ServerStatus {
    ServerStatus {
        running: state.running,
        port: state.port,
    }
}

/// Probe for a free TCP port on `127.0.0.1`, starting at [`DEFAULT_BRIDGE_PORT`] and
/// scanning upward up to `+BRIDGE_PORT_SCAN`. Falls back to the default if none bind.
fn pick_bridge_port() -> u16 {
    for offset in 0..=BRIDGE_PORT_SCAN {
        let candidate = DEFAULT_BRIDGE_PORT.saturating_add(offset);
        if TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return candidate;
        }
    }
    DEFAULT_BRIDGE_PORT
}

/// Strip the Windows verbatim (`\\?\`) prefix from a path. Tauri's `resource_dir()`
/// returns verbatim paths, but Node's main-module resolver chokes on a `\\?\C:\...`
/// script argument (`EISDIR: ... lstat 'C:'`), so the bridge crashes at startup unless
/// we hand it a plain path.
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// Resolve the bundled `bridge/` directory. In a packaged install it lives under the
/// Tauri resource dir; in `tauri dev` we fall back to the source `src-tauri/bridge/`.
fn resolve_bridge_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let candidate = strip_verbatim(&res.join("bridge"));
        if candidate.join(BRIDGE_RUNTIME_EXE).exists() {
            return Some(candidate);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bridge");
    if dev.join(BRIDGE_RUNTIME_EXE).exists() {
        return Some(dev);
    }
    None
}

/// Forward a reader's lines to the frontend `server-log` channel on a background thread.
fn pipe_to_log<R: Read + Send + 'static>(app: &AppHandle, reader: R, label: &'static str) {
    let app = app.clone();
    std::thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines() {
            match line {
                Ok(text) => {
                    let _ = app.emit("server-log", format!("[{label}] {text}"));
                }
                Err(_) => break,
            }
        }
    });
}

/// Spawn the `@cursor/sdk` bridge as `bun <script>` from the bundled runtime directory.
/// Returns `None` (non-fatal) if the runtime is missing or fails to launch.
fn spawn_bridge(app: &AppHandle, port: u16, token: &str) -> Option<StdChild> {
    let dir = match resolve_bridge_dir(app) {
        Some(dir) => dir,
        None => {
            let _ = app.emit(
                "server-log",
                "[bridge] runtime not found; chat will be unavailable".to_string(),
            );
            return None;
        }
    };

    let bun = dir.join(BRIDGE_RUNTIME_EXE);
    let script = dir.join(BRIDGE_SCRIPT);

    let mut cmd = Command::new(&bun);
    cmd.arg(&script)
        .current_dir(&dir)
        .env("CURSOR_SDK_BRIDGE_HOST", "127.0.0.1")
        .env("CURSOR_SDK_BRIDGE_PORT", port.to_string())
        .env("CURSOR_SDK_BRIDGE_TOKEN", token.to_string())
        .env(
            "CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS",
            BRIDGE_RUN_TIMEOUT_MS.to_string(),
        )
        // CRITICAL: this app is `windows_subsystem = "windows"` (no console), so an
        // inherited stdin is an INVALID handle and Node crashes at startup initializing
        // process.stdin. Give the child a valid stdin (NUL). The bridge does not read
        // stdin in server mode, so a closed/NUL stdin is safe.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Prevent a console window from flashing for the bridge process.
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn() {
        Ok(mut child) => {
            if let Some(out) = child.stdout.take() {
                pipe_to_log(app, out, "bridge");
            }
            if let Some(err) = child.stderr.take() {
                pipe_to_log(app, err, "bridge");
            }
            Some(child)
        }
        Err(err) => {
            let _ = app.emit("server-log", format!("[bridge] failed to start: {err}"));
            None
        }
    }
}

/// Forward the main sidecar's output events to the frontend `server-log` channel, and on
/// termination tear down both processes and mark the server as stopped.
fn forward_events(app: &AppHandle, mut rx: tauri::async_runtime::Receiver<CommandEvent>) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    let _ = app_handle.emit("server-log", format!("[server] {line}"));
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    let _ = app_handle.emit("server-log", format!("[server] {line}"));
                }
                CommandEvent::Terminated(_) => {
                    if let Some(state) = app_handle.try_state::<SharedServerState>() {
                        if let Ok(mut guard) = state.lock() {
                            guard.kill_all();
                        }
                    }
                    let _ = app_handle.emit("server-log", "[server] process terminated".to_string());
                }
                _ => {}
            }
        }
    });
}

/// Spawn both processes and wire them together. Internal helper shared by
/// `start_sidecar` (called at setup) and the `start_server` command.
fn spawn(app: &AppHandle) -> Result<ServerStatus, String> {
    let state: State<SharedServerState> = app.state();
    let mut guard = state.lock().map_err(|e| e.to_string())?;

    if guard.running {
        return Ok(snapshot(&guard));
    }

    let port = settings::port();
    let api_key = credentials::read_api_key().unwrap_or_default();

    // Random hex token shared between the bridge and the main server.
    let token = Uuid::new_v4().simple().to_string();
    // Free bridge port (default 8792, scanning upward).
    let bridge_port = pick_bridge_port();

    // --- Server B: the @cursor/sdk bridge (bundled bun + script). Spawned FIRST. ---
    // Non-fatal: if it does not start, the main server still serves /v1/models + /health.
    let bridge_child = spawn_bridge(app, bridge_port, &token);

    // --- Server A: the main /v1 server. Wired to the bridge only if it started. ---
    let mut command = app
        .shell()
        .sidecar(SERVER_SIDECAR_NAME)
        .map_err(|e| e.to_string())?
        .env("PORT", port.to_string())
        .env("CURSOR_API_KEY", api_key);

    if bridge_child.is_some() {
        command = command
            .env(
                "CURSOR_SDK_BRIDGE_URL",
                format!("http://127.0.0.1:{bridge_port}/sdk"),
            )
            .env("CURSOR_SDK_BRIDGE_TOKEN", token);
    }

    let (server_rx, server_child) = command.spawn().map_err(|e| e.to_string())?;
    forward_events(app, server_rx);

    guard.bridge_child = bridge_child;
    guard.child = Some(server_child);
    guard.port = port;
    guard.running = true;

    Ok(snapshot(&guard))
}

/// Called from `setup()` to start the processes on launch. Errors are logged but do
/// not abort startup so the tray UI can still recover.
pub fn start_sidecar(app: &AppHandle) {
    if let Err(err) = spawn(app) {
        let _ = app.emit("server-log", format!("[server] failed to start: {err}"));
    }
}

#[tauri::command]
pub fn get_server_status(state: State<SharedServerState>) -> Result<ServerStatus, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    Ok(snapshot(&guard))
}

#[tauri::command]
pub fn get_base_url(state: State<SharedServerState>) -> Result<String, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let port = if guard.port != 0 {
        guard.port
    } else {
        settings::port()
    };
    Ok(format!("http://127.0.0.1:{port}/v1"))
}

#[tauri::command]
pub fn start_server(app: AppHandle) -> Result<ServerStatus, String> {
    spawn(&app)
}

#[tauri::command]
pub fn stop_server(state: State<SharedServerState>) -> Result<ServerStatus, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    guard.kill_all();
    Ok(snapshot(&guard))
}
