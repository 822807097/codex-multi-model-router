# Changelog — API for Cursor (Windows)

All notable changes to the Windows app. Versions are the app/installer version.

## 0.2.0 — 2026-06-02

### Added
- **Claude Code support** via an Anthropic Messages-compatible endpoint. The local server now
  also serves `POST /v1/messages` (non-stream `Message` + Anthropic SSE) and
  `POST /v1/messages/count_tokens`. Point Claude Code at it with
  `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` and `ANTHROPIC_API_KEY=cursor-local`. Text chat and
  tool use are translated to/from the existing Cursor SDK path; key is read from `x-api-key`.
  - **Caveat:** Composer wasn't trained on Claude Code's exact tool schemas, so the agentic
    tool loop can be less reliable than native Claude (improving tool-loop fidelity is on the
    roadmap). One tool call per turn (sequential).

## 0.1.2 — 2026-06-02

### Improved
- **Multi-turn reliability.** Two changes resolve the occasional single-message
  `Cursor SDK bridge run timed out` noted as a known issue in 0.1.1:
  - **Session kept "under the hood".** Chat now reuses one `@cursor/sdk` agent per client
    session and sends only the **new turn** (`incrementalPrompt`) to it, instead of
    re-feeding the whole conversation. The bridge falls back to the full prompt if the agent
    was evicted, so context is never lost. (Threads `incrementalPrompt` through
    `worker/cursor-sdk.ts`.)
  - **Transparent auto-retry.** A transient bridge stall *before any output* now retries
    automatically with a fresh session + full prompt, instead of surfacing to the client — so
    the previous manual "try again" is no longer needed.

## 0.1.1 — 2026-06-02

### Fixed
- **Multi-turn chat timed out (`Cursor SDK bridge run timed out`).** With a client that reuses a
  session across turns (e.g. **OpenCode**, which sends a stable `x-opencode-session-id`), the
  **second and later messages** hung until the 120 s bridge timeout. The first message always
  worked.

  **Root cause.** `/v1/chat/completions` is stateless — the client resends the full message
  history on every turn. But the sidecar keyed the `@cursor/sdk` agent to the client's session
  header, so the bridge **reused the cached agent** and re-fed the **entire conversation** to an
  agent that already held it. The SDK run never produced a terminal event and hit the run
  timeout.

  **Fix.** Chat completions now use a **fresh SDK session per request** (no agent reuse — a fresh
  agent receives the full prompt, which is correct for a stateless OpenAI endpoint). `/v1/responses`
  keeps session affinity for `previous_response_id` continuity.

### Known issues
- **Occasional transient `Cursor SDK bridge run timed out` on a single message** (sending again
  succeeds). With a fresh session per chat, every request creates a new SDK agent, and the agent
  handshake / first response to Cursor's backend occasionally stalls. The bridge does not yet
  auto-retry a timeout, so it surfaces to the client and a manual retry (a new agent) works.
  A transparent auto-retry for transient stalls is planned — see the Roadmap in the README.

## 0.1.0 — 2026-06-02

- Initial Windows release: Tauri 2 system-tray app exposing a local OpenAI-compatible API
  (`/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/health`) backed by Cursor's Composer
  models; Windows Credential Manager key storage; one-click agent setup (OpenCode, Codex, VS Code,
  Cline, Kilo Code, pi); autostart; NSIS installer + Tauri updater.
- Bundles the `@cursor/sdk` bridge as a **Node** runtime resource (the SDK's native `sqlite3`
  addon can't be `bun --compile`d, and its gRPC/HTTP-2 transport requires Node, not Bun).
- **Known issue (fixed in 0.1.1):** multi-turn chat could time out with session-reusing clients.
- Other 0.1.0 fixes made during bring-up: tray **Quit** now actually exits (was blocked by an
  unconditional `prevent_exit`); the bundled bridge spawned by the no-console GUI app crashed on
  Node's verbatim (`\\?\`) script path — the path is now stripped before launch.
