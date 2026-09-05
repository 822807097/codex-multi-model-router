# Anthropic Messages Endpoint (Claude Code) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Anthropic Messages-compatible endpoint (`POST /v1/messages` + `/v1/messages/count_tokens`) to the Windows app's local server so Claude Code (CLI) can use Cursor's Composer via `ANTHROPIC_BASE_URL`, with text chat and tool use.

**Architecture:** A sidecar-local Anthropic↔OpenAI adapter (`anthropic.ts`) converts the Anthropic request into the existing OpenAI/Cursor pipeline (`prepareChatRequest` → `createCursorSdkCompletion` + the 0.1.2 fresh-session/auto-retry stream) and translates the `CursorTextEvent` stream back to an Anthropic `Message` (non-stream) or a dedicated Anthropic SSE pump (stream). The shared `worker/` layer is not modified.

**Tech Stack:** TypeScript, Bun (sidecar runtime + `bun test`), `node:http`, reuse of `worker/openai.ts` + `worker/cursor-sdk.ts`.

**Full design:** `docs/superpowers/specs/2026-06-02-anthropic-endpoint-claude-code-design.md` (read it — it has the exact protocol shapes and the review corrections). This plan implements that spec.

---

## File structure

- **Create `windows-app/sidecar/anthropic.ts`** — pure translation (no I/O): request→OpenAI body, non-stream `Message` builder, SSE event generator, `count_tokens` estimate, error shape, tool/image/tool_result/tool_choice conversion helpers.
- **Create `windows-app/sidecar/anthropic.test.ts`** — `bun:test` unit tests for the pure functions.
- **Modify `windows-app/sidecar/server.ts`** — extend `resolveApiKey` (read `x-api-key` first); add `POST /v1/messages` + `POST /v1/messages/count_tokens` routing; a `handleAnthropicMessages` that reuses `retryingSdkStream`; an Anthropic SSE writer.
- **Modify `windows-app/src-tauri/tauri.conf.json` + `Cargo.toml`** — bump to `0.2.0`.
- **Modify `README.md` + `CHANGELOG.md`** — Claude Code section + 0.2.0 entry; tick the roadmap item.

Run tests from `windows-app/sidecar/`: `bun test`.

---

### Task 1: Request translation (Anthropic → OpenAI body)

**Files:** Create `windows-app/sidecar/anthropic.ts`; Test `windows-app/sidecar/anthropic.test.ts`

Exports: `mapModel(model: string): string`, `flattenToolResultContent(content: unknown, isError?: boolean): string`, `mapToolChoice(tc: unknown)`, `anthropicToChatBody(body: AnthropicRequest): OpenAiChatBody`.

- [ ] **Step 1 — failing tests** (`anthropic.test.ts`): cover
  - `mapModel("claude-3-5-haiku-20241022")` → `"composer-2.5"` (NOT fast — cost), `mapModel("claude-sonnet-4")` → `"composer-2.5"`.
  - `anthropicToChatBody` with: a string `system`; an array `system` with `cache_control` (ignored); a user msg with text + a base64 `image` block → OpenAI `image_url` data URL; an assistant msg with a `tool_use` block → OpenAI assistant `tool_calls` (id preserved verbatim, `arguments` = JSON string); a user msg with a `tool_result` block whose `content` is an **array** of text blocks + `is_error:true` → an OpenAI `tool` message whose content is the flattened text prefixed with an error marker and `tool_call_id` = the same `toolu_…`.
  - `tools` → OpenAI `{type:"function",function:{name,description,parameters:input_schema}}`.
  - `tool_choice` mapping: `{type:"auto"}`→omit, `{type:"any"}`→`"required"`, `{type:"tool",name:"x"}`→`{type:"function",function:{name:"x"}}`, `{type:"none"}`→`"none"`.
- [ ] **Step 2 — run, verify fail:** `cd windows-app/sidecar && bun test anthropic.test.ts` → FAIL (functions not defined).
- [ ] **Step 3 — implement** the helpers in `anthropic.ts` per the spec's "Request translation" section. Flatten `tool_result.content`: if string use as-is; if array, join `text` blocks (and note image blocks as `[image]`); prefix `is_error` with `"[tool error] "`.
- [ ] **Step 4 — run, verify pass:** `bun test anthropic.test.ts` → PASS.
- [ ] **Step 5 — commit:** `git add windows-app/sidecar/anthropic.ts windows-app/sidecar/anthropic.test.ts && git commit -m "feat(windows): Anthropic->OpenAI request translation for /v1/messages"`

---

### Task 2: Non-stream Message + count_tokens + error shape

**Files:** Modify `anthropic.ts`, `anthropic.test.ts`

Exports: `anthropicMessage(opts: {id, model, text, toolCalls, inputTokens, outputTokens}): object`, `estimateInputTokens(body): number`, `anthropicError(message: string, type: string): object`.

- [ ] **Step 1 — failing tests:**
  - `anthropicMessage` with text only → `{type:"message",role:"assistant",content:[{type:"text",text}],stop_reason:"end_turn",usage:{input_tokens,output_tokens}}`; with a tool call → adds a `{type:"tool_use",id,name,input}` block and `stop_reason:"tool_use"`; empty text + tool → no empty text block.
  - `estimateInputTokens` over a body returns a positive integer roughly chars/4.
  - `anthropicError("nope","authentication_error")` → `{type:"error",error:{type:"authentication_error",message:"nope"}}`.
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement.** `id` = `msg_<uuid no dashes>`; tool_use `id` = `toolu_<uuid>`; `input` = the tool-call args object. Reuse the existing char→token heuristic used by the OpenAI usage estimator (look in `worker/openai.ts`); if not exported, compute `Math.max(1, Math.ceil(chars/4))`.
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit:** `feat(windows): Anthropic non-stream Message + count_tokens + error shape`

---

### Task 3: Anthropic SSE event generator

**Files:** Modify `anthropic.ts`, `anthropic.test.ts`

Export: `async function* anthropicSseEvents(opts: {id, model, inputTokens, stream: AsyncIterable<CursorTextEvent>}): AsyncGenerator<{event: string; data: unknown}>` — yields the event objects (server formats to `event:/data:`). Sequence per spec "Streaming SSE": `message_start` → (text block: `content_block_start`/`content_block_delta` text_delta/`content_block_stop`) → (optional tool block at next index: `content_block_start` tool_use / one `content_block_delta` input_json_delta with full `JSON.stringify(args)` or `"{}"` / `content_block_stop`) → `message_delta` (cumulative `output_tokens`) → `message_stop`. Text block must be stopped before a tool block opens. `output_tokens` accumulates as text arrives.

- [ ] **Step 1 — failing test:** feed a fake async iterable yielding `{type:"text",text:"Hi"}`, `{type:"text",text:"!"}`, `{type:"done",...}` → assert the ordered event types: `message_start, content_block_start, content_block_delta, content_block_delta, content_block_stop, message_delta, message_stop`, the deltas carry `index:0` + `delta:{type:"text_delta",text}`, and `message_delta.delta.stop_reason==="end_turn"`. Second test: stream with a trailing `{type:"tool_call",toolCall:{name,args}}` → text block 0 stops, then tool block index 1 with `input_json_delta.partial_json===JSON.stringify(args)`, and `stop_reason==="tool_use"`.
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement** the generator.
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit:** `feat(windows): Anthropic SSE event generator`

---

### Task 4: Wire the routes in server.ts

**Files:** Modify `windows-app/sidecar/server.ts`

- [ ] **Step 1 — `resolveApiKey`:** read `x-api-key` first, then `Authorization: Bearer`; treat `cursor-local`/empty from EITHER as the env-key fallback. (Manual reasoning + the existing smoke covers this; add a tiny `bun test` if practical.)
- [ ] **Step 2 — `handleAnthropicMessages(request)`:** resolve key (401 `authentication_error` via `anthropicError` if none); parse body; `cursorModel = mapModel(body.model)`; `prepared = prepareChatRequest(anthropicToChatBody(body), cursorModel)`; build the SDK stream via `retryingSdkStream(makeStream)` (same factory shape as `handleSdkRoute`, fresh session per request, NO incrementalPrompt). If `body.stream`: return a `Response` whose body is the Anthropic SSE (a `ReadableStream` writing `event:/data:` from `anthropicSseEvents`, with a dedicated try/catch emitting an Anthropic `error` event). Else: `collectCursorSdkOutput(stream)` → `anthropicMessage(...)` → `json(...)` (Anthropic `Message`).
- [ ] **Step 3 — `handleCountTokens(request)`:** parse the same body, return `json({ input_tokens: estimateInputTokens(body) })`.
- [ ] **Step 4 — routing:** in the request dispatcher add `POST /v1/messages` → `handleAnthropicMessages`, `POST /v1/messages/count_tokens` → `handleCountTokens`. Keep existing routes unchanged.
- [ ] **Step 5 — compile:** `cd windows-app && bun build sidecar/server.ts --compile --outfile src-tauri/binaries/api-for-cursor-server-x86_64-pc-windows-msvc.exe` → exit 0.
- [ ] **Step 6 — commit:** `feat(windows): add /v1/messages (+ count_tokens) Anthropic routes`

---

### Task 5: Smoke test the endpoint

**Files:** none (manual)

- [ ] **Step 1:** start the sidecar (no bridge needed for these checks): `PORT=8831 ./src-tauri/binaries/api-for-cursor-server-x86_64-pc-windows-msvc.exe`.
- [ ] **Step 2 — auth error:** `POST /v1/messages` with no `x-api-key`/key → HTTP 401 body `{"type":"error","error":{"type":"authentication_error",...}}`.
- [ ] **Step 3 — count_tokens:** `POST /v1/messages/count_tokens` with a small body → `{"input_tokens": <n>}`.
- [ ] **Step 4 — stream shape (bogus key + bridge):** with the bridge running and `x-api-key: crsr_bogus`, `POST /v1/messages` `{"model":"claude-3-5-sonnet","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}` → SSE begins with `event: message_start` then an `event: error` (Anthropic shape). Kill processes.
- [ ] **Step 5 — commit:** none (no code change) — or commit any fixes found.

---

### Task 6: Version bump + docs + installer

**Files:** Modify `tauri.conf.json`, `Cargo.toml`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1:** bump version `0.1.2` → `0.2.0` in `tauri.conf.json` and `Cargo.toml`.
- [ ] **Step 2:** README — add a "Use it in Claude Code" section (`ANTHROPIC_BASE_URL=http://127.0.0.1:8787`, `ANTHROPIC_API_KEY=<cursor key or cursor-local>`, run `claude`); tick the roadmap Anthropic item; note the tool-fidelity caveat.
- [ ] **Step 3:** CHANGELOG — `## 0.2.0` entry (Anthropic `/v1/messages` for Claude Code; text + tool use; known caveats).
- [ ] **Step 4 — build installer:** kill any running app, then `cargo tauri build` (with the updater signing env). Expect the NSIS `.exe` + `.sig`.
- [ ] **Step 5 — commit:** `feat(windows): Claude Code support via Anthropic endpoint; bump 0.2.0` + docs.

---

### Task 7: Live verification + release

**Files:** none / release

- [ ] **Step 1 (user):** install 0.2.0; set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` and `ANTHROPIC_API_KEY=cursor-local`; run `claude`; verify (a) a plain chat answers, (b) a simple tool task (e.g. "read package.json") triggers a `tool_use` round-trip and completes.
- [ ] **Step 2:** if good → push commits to `standalone` (`feat/windows-app` → branch + `main`), then `gh release create v0.2.0-win --repo garciarsdiego/api-for-cursor-windows --target main` with the installer + `.sig`.
- [ ] **Step 3:** if tool-calling is too flaky, capture findings and decide follow-up (e.g. tune the tool prompt, or document Claude Code as "chat works, tools best-effort").

---

## Notes
- DRY: reuse `prepareChatRequest`, `createCursorSdkCompletion`, `retryingSdkStream`, `collectCursorSdkOutput`, `json`/`unauthorized` helpers, and the usage estimator. The ONLY new pipeline is the Anthropic translation in `anthropic.ts`.
- YAGNI: no parallel tools, no prompt caching, no `thinking`, no Desktop interception.
- TDD: `anthropic.ts` is pure → unit-tested with `bun test` before wiring routes.
