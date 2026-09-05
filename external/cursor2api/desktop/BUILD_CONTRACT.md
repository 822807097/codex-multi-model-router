# Windows Port — Build Contract (ground truth from the macOS app)

This is the SINGLE SOURCE OF TRUTH for the `desktop/` Tauri 2 port. Every value here was
original porting prompt disagrees with this file, **this file wins** (the prompt's premise was
partly wrong: there is no JS `/v1` server in `src/`; default port is 8787 not 39281;
`windows-credential-manager` crate does not exist; download domain is `api-for-composer`).

## 0. Repo layout context
- Repo root: `C:\Users\Diego Garcia\Desktop\composerwindows` (cloned `standardagents/composer-api`).
- We create everything under `desktop/` plus additive edits to `.github/workflows/release-windows.yml`,
  `worker/index.ts`, `wrangler.jsonc`. Touch NOTHING else (`src/` is the marketing website, not the API).
- Toolchain present: node 24, bun 1.3.14, rust 1.96, cargo-tauri 2.10.1, gh.

## 1. Identity / constants (use these LITERALLY)
| Thing | Value |
|---|---|
| Product / display name | `API for Cursor` |
| Tauri identifier | `ai.standardagents.api-for-cursor` |
| Windows Credential Manager target (service) | `ai.standardagents.apiforcursor` |
| Credential username/account | `cursor-api-key` |
| Legacy credential service (read+migrate) | `ai.standardagents.cursorapi` |
| Default server port | **8787** (NOT 39281) |
| Bind host | `127.0.0.1` (loopback only) |
| Base URL format | `http://127.0.0.1:{port}/v1` (default `http://127.0.0.1:8787/v1`) |
| Bridge port (optional SDK mode) | 8792 |
| App version | `0.1.0` (matches package.json + macOS) |
| Autostart Run-key value name | `APIforCursor` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, data = `"<exe>" --hidden` |
| Settings file | `%APPDATA%\API for Cursor\settings.json` (non-secret only) |
| Agent-config local API-key literal | `cursor-local` (NEVER the real key; NEVER an env var) |

## 2. Models (ORDER MATTERS: [0]=primary, [1]=fast)
```
composer-2.5       name "Composer 2.5"      input 0.5  output 2.5   context 200000 outputLimit 65536
composer-2.5-fast  name "Composer 2.5 Fast" input 3.0  output 15.0  context 200000 outputLimit 65536
```

## 3. Tauri commands (EXACT names — frontend invoke() ↔ Rust #[tauri::command])
All return JSON-serializable values; errors are `Result<T, String>`.
- `get_server_status() -> { running: bool, port: u16 }`
- `get_base_url() -> String`  (e.g. `http://127.0.0.1:8787/v1`)
- `start_server() -> { running: bool, port: u16 }`
- `stop_server() -> { running: bool, port: u16 }`
- `get_api_key() -> String`  (empty string if none; migrates legacy service)
- `set_api_key(key: String) -> ()`
- `delete_api_key() -> ()`
- `has_api_key() -> bool`
- `is_autostart_enabled() -> bool`
- `set_autostart_enabled(enabled: bool) -> ()`
- `get_supported_agents(base_url: String) -> Vec<AgentInfo>`  where `AgentInfo { id, name, status }`, status ∈ `configured|not_configured|not_installed`
- `configure_agent(agent_id: String, base_url: String, api_key: String) -> String`  (returns a human path/summary; api_key passed is ignored in favor of literal `cursor-local`)
- `get_settings() -> { port: u16, autostart: bool }`
- `set_port(port: u16) -> ()`  (persists; takes effect on next server start)
- `get_app_version() -> String`
- `copy_text(text: String) -> ()`  (optional; frontend may use clipboard plugin instead)

## 4. Sidecar (`sidecar/server.ts` at repo root)
- A standalone `node:http` (or `Bun.serve`) server at **`sidecar/server.ts`** (shared with Linux/macOS deploy). **Reuse the pure worker helpers** by importing from
  the repo `worker/` modules (relative path from `sidecar/`: `../worker/openai`, `../worker/cursor`,
  `../worker/http`, `../worker/sse`, `../worker/types`). These are import-clean (only `fetch` + each other).
  DO NOT import `worker/index.ts`, `worker/sdk-bridge-container.ts`, `worker/db.ts`, or `worker/cursor-sdk.ts`
  (Cloudflare/D1/Container coupling).
- Read `worker/index.ts` to replicate ONLY the standard (non-account, non-SDK) `/v1` glue for:
  - `GET /v1/models` and `GET /v1/models/{id}` → `openai.modelList()/modelObject()` (static; works with NO key).
  - `POST /v1/chat/completions` (stream + non-stream) → `openai.prepareChatRequest` → `cursor.createCursorCompletion`/`cursor.streamCursorText` → `openai.chatCompletionResponse`/stream SSE.
  - `POST /v1/responses` (+ `GET/DELETE /v1/responses/{id}` best-effort, in-memory store) → `openai.prepareResponsesRequest` → cursor → `openai.responseObject`/stream.
  - `GET /health` → `{ ok, service, host, models, baseUrl }` (smoke asserts service present, host=127.0.0.1, models[0]=composer-2.5).
- Construct a minimal `Env`/`Deps` for `cursor.ts` (real fetch; the Cursor backend base URL constant lives in `worker/cursor.ts` — reuse it, do not hardcode a private origin here). Resolve the API key from: incoming `Authorization: Bearer <key>` if it is a real key, else `process.env.CURSOR_API_KEY`. If the bearer is the literal `cursor-local`, substitute `process.env.CURSOR_API_KEY`.
- Env in: `PORT` (default 8787), `CURSOR_API_KEY`, optional `CURSOR_SDK_BRIDGE_URL`, `CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS`.
- Listen on `127.0.0.1:PORT`. Log a single line: `API for Cursor server running at http://127.0.0.1:{port}/v1`.
- Build target name (Tauri sidecar): base name `api-for-cursor-server`; release bundles
  `desktop/src-tauri/binaries/api-for-cursor-server-x86_64-pc-windows-msvc.exe` via
  `bun build ../sidecar/server.ts --compile --outfile ...`.
- It is OK if a request requiring the live Cursor backend fails without a real key; `/v1/models` and `/health` must always work offline.

## 5. Credentials (Rust, keyring crate — windows-credential-manager does NOT exist)
- Crate: `keyring = { version = "4", features = ["windows-native"] }`.
- `Entry::new("ai.standardagents.apiforcursor", "cursor-api-key")`.
- get: try default service; on NotFound try legacy `ai.standardagents.cursorapi` and, if found, re-save under default + delete legacy (migration parity). Return "" when absent (map NoEntry → Ok("")).
- set: `entry.set_password(&key.trim())`. delete: `entry.delete_credential()` (keyring v3+ name; verify via cargo).

## 6. Autostart (Rust, winreg crate — exact Run-key control)
- Crate: `winreg = "0.52"`.
- Key: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `APIforCursor`.
- enabled = value exists. set(true) writes `"\"<current_exe>\" --hidden"`; set(false) deletes the value.
- Use `std::env::current_exe()` for the path. Do NOT use tauri-plugin-autostart (naming mismatch).

## 7. Agent setup (Rust agent_setup.rs) — EXACT config shapes
Shared: brand `API for Cursor`; local apiKey literal `cursor-local`; baseUrl = the `base_url` arg
(e.g. `http://127.0.0.1:8787/v1`). All JSON written pretty (2-space) with sorted keys is fine.
Before overwriting an existing file whose content differs, copy it to `<name>.api-for-cursor-backup.<epoch_ms>` (best-effort).
Idempotent: re-running must not duplicate entries.

Path helpers (Windows):
- `home()` = `%USERPROFILE%` (dirs::home_dir).
- `config_home()` = `$XDG_CONFIG_HOME` if set & absolute, else `%USERPROFILE%\.config`.
- `appdata()` = `%APPDATA%` (dirs::config_dir on Windows = Roaming AppData).

### opencode  →  `{config_home}\opencode\opencode.json`  (merge JSON)
Read existing object (default `{}`). Take `provider` (default `{}`), DELETE keys `cursor` and `cursorsdk`, then set:
```json
"cursorapi": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "API for Cursor",
  "options": { "baseURL": "{baseUrl}", "apiKey": "cursor-local" },
  "models": {
    "composer-2.5":      { "name": "Composer 2.5",      "cost": { "input": 0.5, "output": 2.5 },  "limit": { "context": 200000, "output": 65536 } },
    "composer-2.5-fast": { "name": "Composer 2.5 Fast", "cost": { "input": 3.0, "output": 15.0 }, "limit": { "context": 200000, "output": 65536 } }
  }
}
```
Set root.provider = provider. Top-level `model`: if absent OR existing starts with `cursor/`/`cursorsdk/`, set `model = "cursorapi/composer-2.5-fast"` (note: FAST). Note key casing `baseURL` (capital URL).

### codex  →  `%USERPROFILE%\.codex\config.toml` (merge) + two profile files (overwrite)
In config.toml, remove existing blocks (regex, header line to next `[` or EOF, case-insensitive):
`[model_providers.cursorapi.auth]`, `[model_providers.cursorapi]`, `[profiles.cursorapi]`, `[profiles.cursorapi-fast]`. Trim, then append EXACTLY:
```toml
[model_providers.cursorapi]
name = "API for Cursor"
base_url = "{baseUrl}"
wire_api = "responses"

[model_providers.cursorapi.auth]
command = "cmd"
args = ["/c", "echo cursor-local"]
refresh_interval_ms = 300000
```
(macOS used `command="/bin/echo" args=["cursor-local"]`; Windows equivalent prints `cursor-local` to stdout via `cmd /c echo cursor-local`. Do NOT use env_key/CURSOR_API_KEY.)
Then OVERWRITE:
- `%USERPROFILE%\.codex\cursorapi.config.toml` →
  ```toml
  model_provider = "cursorapi"
  model = "composer-2.5"
  ```
- `%USERPROFILE%\.codex\cursorapi-fast.config.toml` →
  ```toml
  model_provider = "cursorapi"
  model = "composer-2.5-fast"
  ```

### vscode  →  `%APPDATA%\<App>\User\chatLanguageModels.json` (top-level ARRAY, merge)
`<App>` = first of `Code`, `Code - Insiders`, `VSCodium`, `Cursor`, `Windsurf` whose `%APPDATA%\<App>\User\` exists (else `Code`). Read array (default `[]`), remove elements whose `name` == `CursorAPI` or `API for Cursor`, append:
```json
{ "name": "API for Cursor", "provider": "openai-compatible", "baseUrl": "{baseUrl}", "models": ["composer-2.5", "composer-2.5-fast"] }
```
(key `baseUrl` lowercase u; no apiKey.)

### cline  →  `%USERPROFILE%\.cline\data\globalState.json` + `secrets.json` (merge each)
globalState.json set:
```json
{ "actModeApiProvider":"openai","planModeApiProvider":"openai",
  "actModeOpenAiModelId":"composer-2.5","planModeOpenAiModelId":"composer-2.5-fast",
  "actModeOpenAiModelInfo": <info composer-2.5>, "planModeOpenAiModelInfo": <info composer-2.5-fast>,
  "openAiHeaders": {}, "openAiBaseUrl":"{baseUrl}", "welcomeViewCompleted": true }
```
Set `remoteRulesToggles`/`remoteWorkflowToggles` to `{}` only if absent. modelInfo shape:
```json
{ "maxTokens":65536,"contextWindow":200000,"supportsImages":true,"supportsPromptCache":false,
  "inputPrice": <0.5|3.0>,"outputPrice": <2.5|15.0>,"temperature":0,"supportsTools":true,
  "supportsStreaming":true,"systemRole":"system" }
```
secrets.json set `{ "openAiApiKey": "cursor-local" }`.

### kilo  →  `{config_home}\kilo\kilo.jsonc` (merge; written as plain JSON)
Default object `{ "$schema": "https://app.kilo.ai/config.json" }`. provider.cursorapi:
```json
{ "options": { "baseURL": "{baseUrl}", "apiKey": "cursor-local" },
  "models": { "composer-2.5": {...same as opencode...}, "composer-2.5-fast": {...} } }
```
Top-level `model`: if absent set `model = "cursorapi/composer-2.5"` (NON-fast, unlike opencode).

### pi  →  `%USERPROFILE%\.pi\agent\models.json` (merge)
Default `{ "providers": {} }`. providers.cursorapi:
```json
{ "baseUrl":"{baseUrl}", "apiKey":"cursor-local", "authHeader":true, "api":"openai-completions",
  "models": [ <per-model objects> ] }
```
Each model object (composer-2.5 shown; fast uses 3.0/15.0 + id/name fast):
```json
{ "name":"Composer 2.5","cost":{"input":0.5,"output":2.5,"cacheRead":0,"cacheWrite":0},
  "limit":{"context":200000,"output":65536},"id":"composer-2.5","api":"openai-completions",
  "reasoning":false,"input":["text"],"contextWindow":200000,"maxTokens":65536,
  "compat":{"supportsUsageInStreaming":true,"maxTokensField":"max_tokens","requiresAssistantAfterToolResult":false} }
```
(`models` is an ARRAY here; baseUrl lowercase u.)

### get_supported_agents status detection
- not_installed: the agent's parent dir/app doesn't exist (e.g. no `%APPDATA%\Code`, no `%USERPROFILE%\.codex`). For opencode/kilo/pi/cline use presence of their config dir OR always allow (treat as not_configured if dir absent but creatable). Simplest acceptable rule: configured if our `cursorapi`/`API for Cursor` entry already present in the target file; not_configured otherwise; not_installed only for vscode when no VS Code-family dir exists.

## 8. tauri.conf.json essentials
- productName `API for Cursor`, version `0.1.0`, identifier `ai.standardagents.api-for-cursor`.
- `build.frontendDist` = `../dist`, `build.devUrl` = `http://localhost:1420`, beforeDevCommand `bun run dev`, beforeBuildCommand `bun run build`.
- one window label `main`, 380x560, resizable false, visible false, skipTaskbar true, decorations true.
- trayIcon id `main`, iconPath `icons/32x32.png`, tooltip `API for Cursor`, menuOnLeftClick false.
- bundle targets `["nsis"]`; nsis installMode `perMachine`; externalBin `["binaries/api-for-cursor-server"]`.
- plugins.updater: endpoints `["https://api-for-composer.standardagents.ai/releases/windows/appcast.json"]`, pubkey `${TAURI_PUBLIC_KEY}` (or placeholder; build must not fail when unset — use a committed dummy pubkey is NOT possible; instead make updater plugin present but endpoints fixed; pubkey read from env at build time via tauri signer — for `cargo check` it is irrelevant).
- A capabilities file (`capabilities/default.json`) granting the `main` window: core defaults, shell (sidecar execute), process, clipboard-manager, updater. Use `cargo tauri add` to wire plugins so versions/permissions match.

## 9. Release / R2 / Worker (additive only)
- Same bucket `api-for-composer-releases` (binding `RELEASES`), same public domain `api-for-composer.standardagents.ai`.
- Windows R2 keys: `releases/windows/API-for-Cursor-{version}-x64-setup.exe`, `releases/windows/API-for-Cursor-latest-x64-setup.exe`, `releases/windows/appcast.json` (Tauri updater JSON), plus the matching `.sig` next to the versioned exe.
- Tauri updater appcast.json shape:
  ```json
  { "version":"{ver}", "notes":"API for Cursor {ver}", "pub_date":"<ISO8601>",
    "platforms": { "windows-x86_64": { "signature":"<tauri .sig contents>", "url":"https://api-for-composer.standardagents.ai/releases/windows/API-for-Cursor-{ver}-x64-setup.exe" } } }
  ```
- Worker additive change (worker/index.ts): the existing `isReleaseRoute` already matches `/releases/*` (so `/releases/windows/*` is served from R2 unchanged). ADD ONLY:
  1. `/download/windows` → 302 redirect to `/releases/windows/API-for-Cursor-latest-x64-setup.exe`.
  2. content-type handling so `.exe` → `application/octet-stream` (or `application/vnd.microsoft.portable-executable`) and `.json` → `application/json` in `handleReleaseRoute`.
  Add `/download/windows` to `isReleaseRoute` predicate and to `wrangler.jsonc` assets `run_worker_first` list. Do not change existing route behavior.
- release-windows.yml: trigger on tags `v*.*.*-win` + workflow_dispatch; runner windows-latest; working-directory desktop; setup node 22 + rust msvc + bun; `bun install`; build sidecar via `bun build`; `bun tauri build`; sign NSIS with signtool (gated on cert secret present); upload artifact; publish to R2 via `desktop/scripts/publish-windows.ts` (gated on R2 secrets). All signing/publish steps must be conditional so the build still succeeds without secrets.
- publish-windows.ts: S3 client to R2, upload versioned + latest exe + appcast.json (reads the tauri `.sig`).

## 10. Verification bar (what "done" means here)
- `desktop/src-tauri` → `cargo check` passes (all modules compile).
- `desktop` frontend → `bun install` + `bun run build` (vite + tsc) passes.
- `sidecar/` → `bun build server.ts --compile` produces an exe; running it serves `GET /v1/models` and `/health` with NO API key.
- Root worker tests `npm test` still pass UNMODIFIED; `npm run typecheck` passes after the worker route addition.
- Conventional Commits for any commit: `feat(windows): ...`, `ci(windows): ...`, etc. (do not commit unless asked).

---

# PARITY ADDENDUM — SDK bridge (full macOS parity for chat/responses)

Goal: chat/responses work with ONLY the user's Cursor key (no private backend secrets), exactly
like the macOS app, by running the `@cursor/sdk` bridge — for distribution to end users.

## Verified facts
- ⚠️ CORRECTION (two findings that killed earlier drafts):
  1. `bun build ... --compile` of the bridge *compiles* but the exe **crashes at startup** — `@cursor/sdk` loads `sqlite3`'s native addon via `bindings`, which can't resolve its module root inside a bun standalone exe (native addons can't be embedded in `--compile`). So the bridge is NOT a compiled sidecar.
  2. The bridge must run under **NODE, not Bun**. `@cursor/sdk` talks to Cursor over gRPC/Connect (HTTP/2 via `@connectrpc/connect-node`); under Bun the chat call dies with `NGHTTP2_FRAME_SIZE_ERROR` (Bun's HTTP/2 client is incompatible). Under Node it works (and Node is what the prod Cloudflare container uses). `/health` works under Bun too because it makes no HTTP/2 call — only a real chat does, which is why this only surfaced with a valid key.
  THEREFORE the bridge ships like the macOS app / prod container: a bundled **`node` runtime** + the raw `cursor-sdk-local-agent-bridge.mjs` + an on-disk `node_modules` (installed via `npm install --omit=dev` so sqlite3 gets its prebuilt binary), under `src-tauri/bridge/`, bundled as a Tauri **resource** (`bundle.resources: ["bridge/**/*"]`). Rust runs it as `node <script>` via `std::process::Command`. Verified end-to-end: bundled `node.exe` + the staged bridge serves `/health`, and a real chat with a valid key returns a full `chat.completion`. The bundled `node.exe` major version MUST match the node that ran `npm install` (sqlite3 prebuilt ABI).
- `worker/cursor-sdk.ts` D1 usage (`env.DB`) is BEST-EFFORT: every `env.DB...` call is wrapped in try/catch with an in-memory `sdkSessions` Map fallback. Running with `env.DB` undefined is fine.
- `worker/index.ts` already contains the exact OpenAI shaping for the SDK path — MIRROR lines ~583–810: `createCursorSdkCompletion(env,deps,apiKey,{prompt,model,sessionKey,...})` → for non-stream `collectCursorSdkOutput(completion.stream)` then `chatCompletionResponse(...)` / `responseObject(...)`; for stream `streamOpenAiEvents(kind, streamCursorText(completion.stream), ...)` (or the existing SSE builders from `openai.ts`). `CursorTextEvent` is identical for cursor.ts and cursor-sdk.ts, so the openai.ts builders work unchanged.

## Two-process architecture (mirrors macOS)
- **Server A** = main sidecar `api-for-cursor-server` (node:http, port 8787, serves `/v1/*`). A `bun --compile` Tauri externalBin.
- **Server B** = bridge RUNTIME (NOT a compiled sidecar): bundled `node.exe` + `cursor-sdk-local-agent-bridge.mjs` + `node_modules` under `src-tauri/bridge/`, shipped via `bundle.resources`. Run as `node <script>`. Serves `/sdk`, `/health`, `/client-tool-call` (port from env).

## Bridge runtime assembly (local + CI)
In `src-tauri/bridge/` (committed: only `package.json` depending on `@cursor/sdk`):
`cp scripts/cursor-sdk-local-agent-bridge.mjs src-tauri/bridge/` ; `(cd src-tauri/bridge && npm install --omit=dev)` (npm, so sqlite3 fetches its prebuilt `.node`); `cp $(node path) src-tauri/bridge/node.exe`. `node.exe`, the copied `.mjs`, and `node_modules` are gitignored; CI regenerates them before `tauri build`.

## Env contract (Rust spawns BOTH; wires them together)
Rust (`server.rs`) at start: generate a random hex `TOKEN`; pick a free bridge port `BP` (default 8792, scan up to +100). Then:
- Spawn **Server B** via `std::process::Command` on the bundled `node.exe <script>` (cwd = the bridge resource dir, resolved via `resource_dir()/bridge` with a dev fallback to `CARGO_MANIFEST_DIR/bridge`; `CREATE_NO_WINDOW`), with env:
  `CURSOR_SDK_BRIDGE_HOST=127.0.0.1`, `CURSOR_SDK_BRIDGE_PORT=<BP>`, `CURSOR_SDK_BRIDGE_TOKEN=<TOKEN>`, `CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS=120000`. NON-FATAL if missing.
- Spawn **Server A** (`api-for-cursor-server` sidecar) with env:
  `PORT=<apiPort 8787>`, `CURSOR_API_KEY=<from credentials>`, and (only if the bridge started) `CURSOR_SDK_BRIDGE_URL=http://127.0.0.1:<BP>/sdk`, `CURSOR_SDK_BRIDGE_TOKEN=<TOKEN>`.
- Track BOTH child handles in ServerState (`CommandChild` for A, `std::process::Child` for B); stop_server/exit/Drop kills BOTH. Spawn B before A.

## Server A (sidecar/server.ts) routing
- `/v1/models`, `/v1/models/{id}`, `/health` → static (unchanged, no key).
- `/v1/chat/completions` and `/v1/responses`:
  - If `process.env.CURSOR_SDK_BRIDGE_URL` is set → route via `worker/cursor-sdk.ts` `createCursorSdkCompletion` (PRIMARY parity path). Build `env` = `{ CURSOR_SDK_BRIDGE_URL, CURSOR_SDK_BRIDGE_TOKEN, CURSOR_API_BASE? }` (NO DB). Build `deps` per `worker/types.ts` Deps (read it): at least `{ fetch: globalThis.fetch, now: () => new Date(), randomUUID: () => crypto.randomUUID() }`.
  - Else fall back to the existing `worker/cursor.ts` direct path.
  - Key resolution unchanged (bearer if real, else `process.env.CURSOR_API_KEY`; `cursor-local` → env key).
- Import `createCursorSdkCompletion`, `collectCursorSdkOutput` from `../../worker/cursor-sdk`; reuse `../../worker/openai` builders + `streamOpenAiEvents`/`streamCursorText` exactly as `worker/index.ts` does. DO import cursor-sdk.ts (it is NOT @cloudflare/containers-coupled; it only TYPE-references DurableObjectNamespace and uses env.DB in try/catch).

## tauri.conf.json / capabilities / CI
- `externalBin`: `["binaries/api-for-cursor-server", "binaries/cursor-sdk-bridge"]`.
- capabilities: grant sidecar execute for BOTH binaries.
- `release-windows.yml`: add a build step for the bridge exe (the `bun build --compile` above) before `tauri build`.

## Verification bar (parity)
- Bridge exe builds; running it (with HOST/PORT/TOKEN) answers `GET /health` → `{"ok":true,...}`.
- Server A `bun build --compile` succeeds; `/v1/models` + `/health` still work with no key.
- With both running + a bogus key, `POST /v1/chat/completions` reaches the bridge (Bearer token accepted) and returns a STRUCTURED error from the SDK auth step (not a crash / not "backend not configured") — proving the bridge path is wired. (Full success needs a real Cursor key.)
- `cargo check` passes with the two-sidecar spawn logic.
