# desktop — Windows 托盘应用（可选）

本目录是 **可选的 Windows 桌面壳**，不是 Linux 部署所需。跨平台 API 网关在仓库根目录 [`sidecar/`](../sidecar/)，Linux 服务器用 [`server.mjs`](../server.mjs) 启动即可。

Tauri 2 系统托盘：Credential Manager 存 Key、一键配置 Agent、自动更新。默认 `http://127.0.0.1:8787/v1`。

| | |
|---|---|
| Product name | `API for Cursor` |
| Default base URL | `http://127.0.0.1:8787/v1` (loopback only) |
| Models | `composer-2.5`, `composer-2.5-fast` |
| Installer | NSIS `.exe` (per-machine) |
| Requirements | Windows 10/11 x64 + [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Win11) |

---

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Using the app](#using-the-app)
- [Point an OpenAI-compatible client at it](#point-an-openai-compatible-client-at-it)
- [Configure agents (one-click)](#configure-agents-one-click)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Build from source](#build-from-source)
- [Release pipeline (CI)](#release-pipeline-ci)
- [Where things are stored](#where-things-are-stored)
- [Security notes](#security-notes)

---

## Install

1. Download the latest **`API for Cursor_<version>_x64-setup.exe`** from the
   [Releases page](../../releases).
2. Run it. Because the build is not (yet) signed with an EV certificate, **SmartScreen**
   may warn you → click **More info → Run anyway**.
3. It installs to `%ProgramFiles%\API for Cursor\` and launches into the **system tray**
   (the icon may be in the hidden-icons overflow `^` next to the clock).

> WebView2 ships with Windows 11. On older Windows 10 it installs automatically if missing.

## Quick start

1. **Click the tray icon** to open the popup.
2. Paste your **Cursor API key** (`crsr_…`) and click **Save**.
3. Click **Stop → Start** once (so the server picks up the freshly saved key — see the
   [first-run note](#first-run-the-server-reads-the-key-at-start)).
4. Wait **~10–15 s** the first time (the SDK bridge has a cold start).
5. Use the local API from any OpenAI client at `http://127.0.0.1:8787/v1` with model
   `composer-2.5`, or click **Configure** next to an agent to wire it up automatically.

Verify it's alive (PowerShell):

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
# -> ok=True ... models composer-2.5, composer-2.5-fast
```

## Using the app

The tray popup shows:

- **Server status** — running/stopped, the local base URL, and a **Copy** button.
- **Start / Stop** — toggles the local server (and the SDK bridge).
- **Cursor API key** — masked input with a show/hide toggle; **Save** stores it in the
  Windows Credential Manager.
- **Configure Agents** — one-click setup for OpenCode, Codex, VS Code, Cline, Kilo Code, pi.
- **Settings** — port override (default `8787`), **Start with Windows** toggle,
  **Check for updates**, and a live server-log viewer.

Right-clicking the tray icon gives **Show / Hide / Quit**. Closing the popup window only
hides it — the app keeps running in the tray. **Quit** fully exits and stops the server
+ bridge.

### First run: the server reads the key at start

The server reads your Cursor API key **when it starts**. If you save (or change) the key
while the server is already running, click **Stop → Start** (or reopen the app) so the
new key takes effect. Agents that send the placeholder key `cursor-local` rely on this.

## Point an OpenAI-compatible client at it

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1`  — use **`127.0.0.1`**, not `localhost` (see troubleshooting) |
| API key | your real Cursor key (`crsr_…`), or `cursor-local` if you saved the key in the app |
| Model | `composer-2.5` (default) or `composer-2.5-fast` |

Example (PowerShell):

```powershell
$body = '{"model":"composer-2.5","messages":[{"role":"user","content":"hello"}]}'
Invoke-RestMethod -Method POST -Uri http://127.0.0.1:8787/v1/chat/completions `
  -Headers @{ Authorization = "Bearer crsr_YOUR_KEY" } `
  -ContentType "application/json" -Body $body
```

Endpoints served: `GET /v1/models`, `POST /v1/chat/completions` (streaming + non-stream),
`POST /v1/responses`, and `GET /health`.

> **Claude Code:** set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` (no `/v1`) and use
> `/v1/messages`. The bundled sidecar exposes both OpenAI and Anthropic surfaces.

## Configure agents (one-click)

In **Configure Agents**, click an agent to write its config (pointing it at
`http://127.0.0.1:8787/v1`, with the local key `cursor-local`). Re-running is idempotent,
and the previous file is backed up to `<name>.api-for-cursor-backup.<epoch>` if it changed.

| Agent | Config written (Windows) |
|---|---|
| **OpenCode** | `%USERPROFILE%\.config\opencode\opencode.json` (provider `cursorapi`) |
| **Codex** | `%USERPROFILE%\.codex\config.toml` + `cursorapi.config.toml` + `cursorapi-fast.config.toml` |
| **VS Code** | `%APPDATA%\<Code\|Code - Insiders\|VSCodium\|Cursor\|Windsurf>\User\chatLanguageModels.json` |
| **Cline** | `%USERPROFILE%\.cline\data\globalState.json` + `secrets.json` |
| **Kilo Code** | `%USERPROFILE%\.config\kilo\kilo.jsonc` |
| **pi** | `%USERPROFILE%\.pi\agent\models.json` |

For OpenCode, after configuring, pick the model **`cursorapi/composer-2.5`** (or
`cursorapi/composer-2.5-fast`).

## How it works

The Tauri (Rust) backend manages **two local processes** and wires them together:

1. **API server** (`api-for-cursor-server`) — a `bun --compile` sidecar exe that serves
   the OpenAI-compatible `/v1/*` surface (reusing the repo's `worker/openai.ts` shaping
   and `worker/cursor-sdk.ts` client). Listens on `127.0.0.1:8787`.
2. **SDK bridge** — runs the official `@cursor/sdk` agent and talks to Cursor's backend.
   It ships as a bundled **Node runtime + `cursor-sdk-local-agent-bridge.mjs` + `node_modules`**
   under `src-tauri/bridge/` (a Tauri *resource*), launched as `node <script>` on a private
   loopback port with a per-launch shared token.

```
OpenAI client ──HTTP──▶ api-for-cursor-server (8787, Bun)
                              │  CURSOR_SDK_BRIDGE_URL + token
                              ▼
                        SDK bridge (Node, @cursor/sdk) ──gRPC/HTTP2──▶ Cursor backend
```

Because the bridge uses `@cursor/sdk`, chat works with **only your Cursor key** — no
backend secrets. `GET /v1/models` and `/health` work even with no key and no bridge.

**Why the bridge runs under Node (not Bun):** `@cursor/sdk` loads `sqlite3`'s native addon
(so it can't be `bun --compile`d) and it talks to Cursor over gRPC/Connect (HTTP/2); Bun's
HTTP/2 client fails with `NGHTTP2_FRAME_SIZE_ERROR`. Node works (and is what Cursor's own
production container uses).

## Troubleshooting

First, confirm the local server is actually up and reachable:

```powershell
# Is something listening on 8787, and is it the installed app?
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object LocalAddress, OwningProcess
# Key-free endpoints (must work whenever the app is running):
Invoke-RestMethod http://127.0.0.1:8787/health
Invoke-RestMethod http://127.0.0.1:8787/v1/models | Select-Object -Expand data | Select-Object -First 3 id
```

| Symptom | Cause & fix |
|---|---|
| **"Unable to connect" / connection refused** right after opening the app | The SDK bridge has a **~10–15 s cold start**. Wait, then retry. The first request after launch may fail while the bridge warms up. |
| **"Unable to connect…"** persists, or **chat fails but `/v1/models` works** | The server is up but the bridge isn't, or the key didn't reach it. Click **Stop → Start** in the app (reloads the key), wait ~15 s, retry. Check the in-app **log viewer** (Settings) for `[bridge] …` lines. |
| Client says **"Unable to access the URL"** but `127.0.0.1` works in PowerShell | Your client used **`localhost`** (which can resolve to IPv6 `::1`); the server binds IPv4 `127.0.0.1` only. Use **`http://127.0.0.1:8787/v1`**. Also check the client isn't sandboxed (WSL/Docker) — it must reach the Windows loopback. |
| **`401 unauthorized` / "Missing or invalid authorization"** | Cursor rejected the key — it's invalid, revoked, or the account lacks API/Composer access. Save a valid key, then **Stop → Start**. |
| **SmartScreen blocks the installer** | The build isn't EV-signed → **More info → Run anyway**. Sign with an EV certificate to remove the warning (set the `WINDOWS_CERTIFICATE` secret for CI). |
| **Port 8787 already in use** | Change the port in **Settings** (persists to `settings.json`, applies on next start), or stop the process using it. |
| **App won't appear** | It starts hidden in the tray (no taskbar entry). Look in the hidden-icons overflow `^`. |
| **Need to force-kill** | `Get-Process api-for-cursor* \| Stop-Process -Force` (also stops the server + bridge). |

## Build from source

### Prerequisites

- [Bun](https://bun.sh) 1.3+ — package manager + sidecar compiler
- [Node](https://nodejs.org) 20+ — bundled as the SDK-bridge runtime (and `npm` fetches
  `sqlite3`'s prebuilt binary)
- [Rust](https://rustup.rs) stable + the `x86_64-pc-windows-msvc` target
- [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/) (MS C++ Build
  Tools + WebView2)

### Develop

```powershell
# from desktop/
bun install
bun run tauri dev
```

### Build a local installer

```powershell
# from desktop/

# 1. Compile the main API-server sidecar (source lives in ../sidecar/)
bun build ../sidecar/server.ts --compile `
  --outfile src-tauri/binaries/api-for-cursor-server-x86_64-pc-windows-msvc.exe

# 2. Assemble the @cursor/sdk bridge runtime (a Tauri resource).
#    npm (not bun) so sqlite3 gets its prebuilt binary; ship Node (not bun) as the runtime.
Copy-Item ..\scripts\cursor-sdk-local-agent-bridge.mjs src-tauri\bridge\
Push-Location src-tauri\bridge; npm install --omit=dev; Pop-Location
Copy-Item (Get-Command node).Source src-tauri\bridge\node.exe

# 3. Generate icons (once) and build the app + NSIS installer.
bunx tauri icon app-icon.png
bun run tauri build --target x86_64-pc-windows-msvc
```

Installer output: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe`
(plus a `.exe.sig` for the updater).

> The build depends on sibling source in the repo (`../sidecar/server.ts`, `../worker/*.ts`, `../scripts/cursor-sdk-local-agent-bridge.mjs`).
> Build from a full checkout (needs `../sidecar/`, `../worker/`, `../scripts/`), not `desktop/` alone.

## Release pipeline (CI)

`.github/workflows/release-windows.yml` (runner `windows-latest`) builds, optionally
signs, and optionally publishes. Trigger by pushing a tag `v*.*.*-win` or via
`workflow_dispatch`:

```powershell
git tag v0.1.0-win
git push origin v0.1.0-win
```

It compiles the sidecar, assembles the Node bridge runtime, runs `tauri build`,
**(optionally)** Authenticode-signs with `signtool`, **(optionally)** publishes to
Cloudflare R2, and uploads the installer (+ `.sig`) as an artifact. Every signing/publish
step is gated on its secret being present, so the build still succeeds with no secrets.

### Optional CI secrets

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` / `…_PASSWORD` | Sign the updater `.sig` (generate with `bunx tauri signer generate`) |
| `WINDOWS_CERTIFICATE` / `…_PASSWORD` | Base64 `.pfx` Authenticode cert + password |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Publish to Cloudflare R2 |

The updater **public** key lives in `tauri.conf.json` (`plugins.updater.pubkey`); the
**private** key must never be committed — keep it in the `TAURI_SIGNING_PRIVATE_KEY` secret.

## Where things are stored

- **Cursor API key** → Windows Credential Manager (Generic Credential), never on disk in
  plaintext. Service `ai.standardagents.apiforcursor`, account `cursor-api-key` (a legacy
  service `ai.standardagents.cursorapi` is read and migrated automatically).
- **Settings** (port, autostart) → `%APPDATA%\API for Cursor\settings.json`.
- **Start with Windows** → `APIforCursor` value under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

## Security notes

- The server binds **loopback only** (`127.0.0.1`) — it is not exposed on the network.
- The Cursor key is held in the Credential Manager and passed to the server process via an
  environment variable at launch; it is never written to disk in plaintext.
- The SDK bridge listens on loopback with a random per-launch bearer token shared only with
  the local server.
- Don't commit secrets: the updater private key, signing certs, and any `crsr_…` key stay
  out of the repo (`.gitignore` covers the runtime binaries, `node_modules`, and `*.key`).

---

This is the Windows port of the macOS **API for Cursor** by Standard Agents —
[standardagents/composer-api](https://github.com/standardagents/composer-api) (MIT), which
provides the macOS app, the Cloudflare Worker / OpenAI-compatibility layer, and the
`@cursor/sdk` bridge this app bundles. Built with [Tauri 2](https://v2.tauri.app/) and backed by
[`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) + the Cursor Composer models. See
[`BUILD_CONTRACT.md`](./BUILD_CONTRACT.md) for the detailed port decisions and the macOS→Windows
mapping, and the repo [`CHANGELOG.md`](../CHANGELOG.md) for version history.
