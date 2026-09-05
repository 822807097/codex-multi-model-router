# Anthropic Messages endpoint for Claude Code — Design

Status: approved design (2026-06-02). Target app version: 0.2.0 (new feature).

## Goal

Let **Claude Code (CLI)** use Cursor's Composer models through the local server, by adding an
**Anthropic Messages-compatible** endpoint. The user sets:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=<their Cursor key, or "cursor-local" if saved in the app>
```

and runs `claude`. Scope: **text chat AND tool use** (Claude Code is agentic — it drives a
client-side tool loop), delivered together.

## Non-goals (v1)

- Claude **Desktop** (the chat app) — it needs request interception, out of scope.
- Parallel tool calls — the bridge captures one tool call per run, so we emit at most one
  `tool_use` block per turn (Claude Code handles this sequentially).
- Prompt caching, `count_tokens` exactness, vision fidelity beyond what the OpenAI path already
  supports, batch/`thinking` blocks.

## Architecture — Anthropic ↔ OpenAI adapter (reuse the proven pipeline)

We do NOT build a new model pipeline. We add a thin translation layer that converts the
Anthropic request into the EXISTING OpenAI/Cursor path (`prepareChatRequest` →
`createCursorSdkCompletion` → tool path → the 0.1.2 fresh-session + auto-retry stream), then
translates the resulting `CursorTextEvent` stream back into Anthropic `Message`/SSE.

```
Claude Code ──Anthropic /v1/messages──▶ anthropic.ts adapter
   request → OpenAI-shaped body → prepareChatRequest → createCursorSdkCompletion (bridge)
   CursorTextEvent stream  → anthropic.ts → Anthropic Message (non-stream) | Anthropic SSE
```

New code:
- `windows-app/sidecar/anthropic.ts` — pure translation (request → internal; events → Message;
  events → SSE; token estimate; error shape). No Cloudflare/Tauri deps; unit-testable.
- `windows-app/sidecar/server.ts` — two routes (`POST /v1/messages`, `POST /v1/messages/count_tokens`),
  `x-api-key` auth, model mapping; reuse `handleSdkRoute`'s factory (fresh session + auto-retry).

The shared `worker/` layer is NOT modified (Anthropic support is a Windows-app concern).

## Endpoints

- `POST /v1/messages` — core. Non-stream → `Message` object; `stream:true` → Anthropic SSE.
- `POST /v1/messages/count_tokens` → `{ "input_tokens": <estimate> }` (char-based, reusing the
  existing usage estimator). The request body is the **same shape as `/v1/messages`** (model,
  messages, system, tools) — reuse the same request parser, then estimate over the assembled prompt.
- Reuse existing `GET /health`. (No `/v1/models` change needed for Claude Code.)

## Auth & model mapping  (review: B1, S5, S8)

- **Key:** read **`x-api-key`** FIRST (Claude Code sends `ANTHROPIC_API_KEY` here, not Bearer),
  then `Authorization: Bearer`, then `cursor-local`/empty → `process.env.CURSOR_API_KEY`
  (Credential Manager). The `cursor-local` literal fallback applies to BOTH header sources.
  Extend `resolveApiKey` accordingly — without this every request 401s.
- **Headers:** ignore `anthropic-version` and `anthropic-beta` (Claude Code sends them); never 400
  a request for including them; do not require them.
- **Model:** map ANY incoming `model` → `composer-2.5`. Do NOT route `haiku` → `composer-2.5-fast`
  — fast is `{input 3, output 15}` vs `{0.5, 2.5}` (6× cost), and Claude Code fires many cheap
  `haiku` calls (titles etc.), so that mapping inverts the economics. Echo the **requested** model
  string back in the response `model` field (Claude Code is lenient).

## Request translation (Anthropic → internal)  (review: B3, N1, N3, N5, S9)

Build an OpenAI-shaped chat body, then call `prepareChatRequest`:
- `system` (string OR `[{type:"text",text, ...}]`) → a leading OpenAI `system` message.
  Concatenate `text` blocks; **ignore unknown keys** (e.g. `cache_control`) — don't crash.
- `messages[]`, each `content` is a string or an array of blocks:
  - `text` → text content.
  - `image` (`source.type:"base64"`, `{media_type,data}`) → OpenAI
    `{type:"image_url", image_url:{url:"data:<media_type>;base64,<data>"}}` (reuse existing image
    limits). Non-base64 sources (`url`, file ids): best-effort or skip with a text note — never crash.
  - `tool_use` (assistant; `id`,`name`,`input`) → OpenAI assistant `tool_calls`
    (`id` = the inbound `toolu_…` **verbatim**, `function.name`=name, `arguments`=JSON.stringify(input)).
    Assistant turns with only tool_use → OpenAI assistant `content:null` + `tool_calls` (handled).
  - `tool_result` (user; `tool_use_id`, `content`, `is_error?`) → OpenAI `tool` message
    (`tool_call_id` = the same `toolu_…` verbatim). **`content` is usually an ARRAY of blocks** —
    flatten it to text yourself in `anthropic.ts` (join `text` blocks; describe image blocks) BEFORE
    building the OpenAI `tool` message (do NOT pass raw Anthropic blocks — `contentToTextAndImages`
    would `JSON.stringify` them into garbage). If `is_error:true`, prefix the text with an error
    marker so Composer knows the tool failed.
- `tools[]` (`{name, description, input_schema}`) → OpenAI tools (`{type:"function", function:{name,
  description, parameters: input_schema}}`).
- `tool_choice` → translate: Anthropic `auto` → omit; `any` → `"required"`; `{type:"tool",name}` →
  `{type:"function",function:{name}}`; `none` → `"none"`.
- Params: `max_tokens` (required by Anthropic) → carried/ignored as the OpenAI path allows;
  `temperature`, `stop_sequences` → mapped where supported; `stream` → drives SSE vs object.

## Response translation (internal → Anthropic)

Consume the `CursorTextEvent` stream (`text` | `tool_call` | `done`).

**Non-stream `Message`:**
```json
{ "id": "msg_…", "type": "message", "role": "assistant", "model": "<requested>",
  "content": [ {"type":"text","text":"…"} , {"type":"tool_use","id":"toolu_…","name":"…","input":{…}} ],
  "stop_reason": "end_turn" | "tool_use", "stop_sequence": null,
  "usage": {"input_tokens": N, "output_tokens": M} }
```
`stop_reason` = `tool_use` when a `tool_call` was emitted, else `end_turn`. (review S7) We only
ever emit `end_turn` or `tool_use`; we never synthesize `max_tokens`/`stop_sequence` (Composer
doesn't surface them). This is correct for Claude Code's loop — it continues on `tool_use`, stops
on `end_turn`.

**Streaming SSE** (review: B2, B4, S1, S2, S3, S6) — a DEDICATED Anthropic pump (NOT
`streamOpenAiEvents`, whose error/usage shapes are OpenAI's). Each event is
`event: <type>\ndata: <json>\n\n`. Exact wire shapes (note top-level `index` + nested `delta`):
1. `message_start` — `{"type":"message_start","message":{"id":"msg_…","type":"message","role":"assistant","model":"<requested>","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":N,"output_tokens":1}}}`
2. Text block: `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` →
   one+ `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"…"}}` →
   `{"type":"content_block_stop","index":0}`.
3. Tool call (only after the text block is stopped — blocks never interleave): the bridge emits the
   full args in one shot, so emit `{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_…","name":"…","input":{}}}`
   → ONE `{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"<JSON.stringify(args)>"}}`
   (empty args → `partial_json:"{}"`) → `{"type":"content_block_stop","index":1}`.
4. `{"type":"message_delta","delta":{"stop_reason":"end_turn"|"tool_use","stop_sequence":null},"usage":{"output_tokens":M}}`
   — `output_tokens` here is the **CUMULATIVE total** for the whole message, not a per-event delta.
5. `{"type":"message_stop"}`.
   We skip `ping` (optional) and emit `message_start` immediately so the stream opens before the
   bridge's first token. On mid-stream failure (after `message_start`), emit an Anthropic error event:
   `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"…"}}`.

## Tool flow

Reuse the SDK tool path (`clientTools` from the converted `tools`, `allowToolCall`). When Composer
emits a `tool_call`, we surface it as a `tool_use` block (generate `toolu_<uuid>`, `name`, `input` =
the args object). Claude Code executes it and sends `tool_result` on the next request, which we
render back into the prompt. Full conversation (incl. tool history) is resent by Claude Code each
turn, so we use a **fresh SDK session + full prompt** per request (stateless) + the existing
auto-retry. (No incrementalPrompt for `/v1/messages` in v1 — Claude Code is stateless-friendly.)

## Errors

On failure return the Anthropic error shape with the right HTTP status:
```json
{ "type": "error", "error": { "type": "invalid_request_error"|"authentication_error"|"api_error",
  "message": "…" } }
```
Map our `unauthorized` → 401 `authentication_error`; bridge/SDK failures → 5xx `api_error`. For
streaming, if a failure occurs mid-stream after `message_start`, emit an SSE `error` event.

## Testing

- **Unit** (`anthropic.test.ts`): request conversion (system/text/image/tool_use/tool_result/tools),
  non-stream `Message` shape, SSE event sequence (text-only and text+tool_use), error shape,
  `count_tokens`.
- **Smoke** (build the sidecar): `POST /v1/messages` with no key → structured `authentication_error`;
  with `stream:true` and a bogus key → `message_start` then `error` event (proves the SSE shape).
- **Live**: user points `ANTHROPIC_BASE_URL` at the app, runs Claude Code, verifies a chat answers
  and a simple tool task (e.g., "read file X") triggers a `tool_use` round-trip.

## Risks (called out in the design discussion)

- **Tool-calling fidelity:** Composer was not trained on Claude Code's exact tool schemas; emitted
  tool calls may be imperfect → the agentic loop may be flaky. Only measurable live.
- **One tool per turn** (bridge captures one tool call + cancels the run); sequential, not broken.
- Claude Code sends a large system prompt + many tools; prompt size/latency may be higher.

## Out-of-scope / future

- Parallel tool calls, prompt caching, `thinking` blocks, Claude Desktop interception, Linux build.

## Implementation outline (files)

1. `windows-app/sidecar/anthropic.ts` — translators + token estimate + error shape (+ unit tests).
2. `windows-app/sidecar/server.ts` — `POST /v1/messages`, `POST /v1/messages/count_tokens`,
   `x-api-key` in `resolveApiKey`, model mapping, reuse the retrying SDK stream factory.
3. Bump app to **0.2.0**; README + CHANGELOG (new "Claude Code" section); roadmap update.
4. Build installer, live-verify with Claude Code, release `v0.2.0-win`.
