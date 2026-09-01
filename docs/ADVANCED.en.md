# Advanced Usage & Configuration Reference

[简体中文](./ADVANCED.md) | **English**

> For users who already have the basics running via the [README](../README.en.md). This doc covers "how to configure it even better".

## Environment variables & ports

| Variable | Purpose | Default |
| --- | --- | --- |
| `ROUTER_PORT` | Router listen port | `15730` |
| `CODEX_HOME` | Codex desktop config directory (where `config.toml` / `models.json` live) | optional, managed by the desktop app |
| `ROUTER_DB_PATH` | Local SQLite database path (tests / multi-instance isolation) | `data/router.db` |
| `CURSOR_GATEWAY_PORT` | Built-in Cursor gateway port | `6718` |
| `CURSOR_GATEWAY_ADMIN_PASSWORD` | Admin password used for auth between the panel and the Cursor gateway (**set it yourself**) | none (the panel's Cursor page reminds you when unset) |
| `CURSOR_KEY` | Fallback key when adding a Cursor account (may be left blank in the panel) | none |

> Vendor API keys are always passed via environment variables — see the next section.

## config.json (sample config, no keys)

The `config.json` in the repo is a fully-structured **sample** containing no real keys. Core structure:

```jsonc
{
  "port": 15730,
  "proxy": { "host": "127.0.0.1", "port": 10808 },   // global proxy (shared by viaProxy=true channels)
  "timeouts": { "connectMs": 15000, "responseHeaderMs": 120000, "streamIdleMs": 600000, "requestMs": 600000 },
  "maxConcurrentRequests": 8,
  "targets": [
    {
      "name": "deepseek-chat",
      "match": "^deepseek-",          // which model slugs go through this channel
      "host": "api.deepseek.com",
      "prefix": "/v1",
      "protocol": "https",
      "wireApi": "chat",              // chat (universal) or responses (official Codex format)
      "envKey": "DEEPSEEK_API_KEY",   // the env-var name to look up in your environment
      "viaProxy": false,
      "vision": true
    }
  ],
  "visionRelay": { "endpoints": [ { "model": "...", "host": "...", "prefix": "...", "envKey": "...", "protocol": "https" } ] }
}
```

- After changing config you **must restart the router** for it to take effect (the panel header's "graceful restart" is enough).
- Keys are never written into this file. The admin panel edits this same file directly, but sensitive fields are replaced with masked placeholders protected by one-time tokens.

## Channels (targets) & matching

- `match` is a regex: `^deepseek-` matches every model starting with it; to match exactly one model use `^model-name$`.
- Channels are scanned in order and the **first match wins**. When several channels match the same model, the router remembers which provider succeeded (affinity) to avoid bouncing between them.
- `wireApi`: when unsure pick `chat` (universal vendors like DeepSeek, GLM, Qwen); `responses` is the official Codex format.
- `upstreamModel`: rewrite the requested model name into the name the upstream actually expects (e.g. turn the desktop's `grok-4.6[effort=high,fast=true]` into the parameter form the upstream accepts).

## Network & per-channel proxy

Three modes per channel (a dropdown in the panel, beginner-friendly):

1. **Direct**: no proxy.
2. **Global proxy**: uses the `proxy` block at the top of `config.json` (your local proxy app, e.g. v2rayN's HTTP/mixed port).
3. **Custom proxy (node)**: fill in protocol/server/port/password, or **paste a full node link** and it is recognized automatically:
   - `ss://` (Shadowsocks airport node)
   - `trojan://` / `vless://` (airport nodes)
   - `socks5://` / `http://` (local proxy software)

Subscription accounts (Claude/Gemini/ChatGPT) can each have their own independent proxy too, without affecting other channels.

## Channel key pools (multiple keys per channel)

Use case: several accounts/keys on the same platform; when one gets 429-cooled, the next one takes over automatically.

- Add them in the panel: "model groups → key pool".
- Each key has a **priority** (lower number used first) + a **cooldown state** (auto-cooled when quota runs out, recovers when time is up).
- Equal priority = round robin; only when the entire pool is cooled down does it fall back to the `envKey` environment variable.
- Cooldown state is persisted to the local database and survives restarts.

## Multi-account subscription pools

Panel: "platform membership auth":

- **Claude / Gemini / ChatGPT**: "one-click authorize" per platform (OAuth, your browser opens the login) or import a Refresh Token manually. Tokens auto-refresh and persist locally.
- Each account shows plan, quota progress and available models; you can **pull the upstream model list** and benchmark each model on the real endpoint.
- **ChatGPT account quota panel**: live 5-hour / weekly progress bars + reset times, captured automatically from official-channel response headers (same source as the Codex CLI quota bar); row labels follow each window's real duration, and windows without data are hidden.
- **Drain order**: a number box on each account card, 1 = drained first; empty = auto by plan (Pro first). Multi-account failover picks accounts by `priority → plan → rotation`.
- **One-click Codex switch**: "switch Codex to this account" on a ChatGPT account card. Order of operations: fully quit the desktop app (poll-confirmed) → back up the original auth.json → write that account's credentials → auto-restart the app (~10 seconds). Bidirectional; clicking again while a switch is in progress returns a "switch in progress" notice.
- Multiple accounts on the same platform rotate automatically when quota runs out; independent per-account proxies are supported.

## Google subscription channel (Google AI Pro)

Run the full gemini / claude family directly on your Google AI Pro membership quota:

- **One-click onboarding**: after binding a Google account, the account card's "connect to router channel" pulls the subscription model list (25+ gemini / claude / gpt-oss models) → creates a dedicated channel per model and writes them into the desktop catalog. Idempotent on repeat clicks (existing channels are skipped).
- **Protocol bridging**: both `/v1/chat/completions` and `/v1/responses` are auto-translated to Antigravity generateContent; streaming / non-streaming, tool calls and multimodal images are all supported.
- **Thinking-tier variants**: models with the `-tiered` suffix are thinking-tier carriers; onboarding auto-synthesizes the friendly `-high` / `-medium` / `-low` names (the upstream knows the carrier name; the tier is controlled by the thinkingLevel parameter).
- **Tool schema sanitization**: agent clients send full JSON Schema tool definitions (including `$schema` / `propertyNames` / `additionalProperties` and other fields Gemini doesn't support); the router sanitizes them recursively against an allowlist; `$ref` is resolved from `$defs`, and `type` arrays become `type + nullable`.
- **Output budget clamping**: `max_tokens` / `max_completion_tokens` are clamped to 32768 — Google pre-checks its per-minute quota by "input + output reserve", and a 128k reserve gets an instant 429.
- **Account-pool failover**: 429 (60-second per-account × model cooldown) / 403 no-permission (30 min) / 401 (60 min) / invalid credentials → the router automatically rolls to the next account in the pool; Claude thinking models automatically get the VALIDATED tool mode and the interleaved-thinking beta header.
- **Quota notes**: Google has no public quota API (limits are per-minute, per-model); the panel shows a local 7-day request counter, and rate-limit errors include recovery guidance.

## Cursor subscription quota (built-in gateway)

Convert Cursor subscription quota into an OpenAI-compatible API:

- The gateway starts together with the router (listening on localhost 6718).
- Panel: "system & routing config → Cursor subscription gateway": add `crsr_` keys (Cursor settings → API KEY) into the account pool; multi-account rotation with automatic switchover when quota runs out.
- Models appear in the menu as `cursor/grok-4.6`, `cursor/composer-2.5`, etc.; reasoning/speed variants (e.g. `cursor-grok-4.6-fast`, `-high`, `-xhigh`) are auto-mapped to gateway parameters (`[effort=high,fast=true]`).
- The gateway admin password is set via the `CURSOR_GATEWAY_ADMIN_PASSWORD` environment variable (configure it on first run — don't leave it empty).

## Vision relay ("borrowed eyes")

When a text-only model receives an image, the image first goes to a vision model for a text description, and the description is then handed to the text model together with your request.

- Manage **multiple endpoints** (different platforms/models) in the panel: "system & routing config → vision relay".
- Each endpoint configures: vision model name, API host, path prefix, key env-var name, protocol, proxy.
- When an endpoint's quota runs out (429/quota errors) it cools down and the next one takes over automatically.
- Images are de-duplicated in a cache (concurrency / cache tunable); concurrent requests for the same image trigger only one vision call.

**Example: NVIDIA free vision model (NVIDIA NIM / build.nvidia.com)**

```jsonc
{
  "model": "nvidia/nemotron-nano-12b-v2-vl",  // NVIDIA's own VLM, text + images (up to 4 document images per call)
  "host": "integrate.api.nvidia.com",
  "prefix": "/v1",
  "protocol": "https",
  "envKey": "NVIDIA_API_KEY",                 // nvapi- key, keep it in env vars / registry only
  "viaProxy": false                           // if direct connection fails in some regions, set true to use the global proxy
}
```

- Free tier: about **40 requests/min, ~10k per day**; the shared endpoint may be throttled by other people's traffic (API Trial ToS); production use needs a paid dedicated NIM deployment.
- The stronger free-tier `meta/llama-3.2-90b-vision-instruct` binds to the same address, but free-tier cold start can be extremely slow (measured 150 seconds unresponsive); the 12B tier is recommended for daily use.

## Image generation API (OpenAI-compatible, for external agents)

The router exposes an OpenAI-compatible image generation endpoint that ZCode / Trae / Qoder / OpenCode or any tool can call directly:

```
POST http://127.0.0.1:15730/v1/images/generations
Authorization: Bearer <sk-router-...> (when auth is enabled)
Content-Type: application/json
```

```jsonc
{ "model": "gpt-image-2", "prompt": "a red owl icon, flat style", "n": 1, "size": "1024x1024" }
```

- The upstream is OpenAI platform `api.openai.com/v1/images/generations` (model `gpt-image-2`, **billed per image** — not Plus/Pro subscription quota).
- Credentials: **platform API key first** (`OPENAI_IMAGE_API_KEY`, falling back to `OPENAI_API_KEY`, read only from environment variables); only when no key is configured does it try the ChatGPT login token (in practice chatgpt.com-style tokens get 401 upstream, so a key is the reliable credential for image calls). With no credentials at all it returns a readable `401 image_provider_unconfigured`. The response is the standard `{ object:"list", created, data:[{b64_json|url}] }`.
- The Codex desktop app's "draw a picture" takes a different path: official models use the `image_generation` tool executed by the Codex host on subscription quota (enabled by default; it does not consume this endpoint's API balance).
- Note on why there is no public "subscription quota" image endpoint — OpenAI's Plus/Pro image quota only exists inside the official apps and the Codex tool; `/v1/images/generations` only accepts platform API-key billing, and this endpoint strictly matches that public contract.

## Usage dashboard & token tracking

The "usage stats" page shows: last 7/30 days token totals, call counts, active days, most-used models, a GitHub-style activity heatmap, per-day multi-model stacked bars, and per-model breakdowns (including thinking tokens and cache hits).

## Client API keys (optional)

After you create an `sk-router-*` key on the "API key management" page, the router enters auth mode: clients must send `Authorization: Bearer <key>` to call it. Keys are stored hashed only; revocation takes effect immediately. On creation you can also one-click sync the config into Codex (writes `config.toml` + a system environment variable). Creating no keys = open access (fine for a personal, single-user machine).

## Development & debugging

- Debug logs: `router.log` (structured JSON) and `router-console.out.log` (process console) in the working directory. For crashes / startup failures, check the console log first.
- Graceful restart: panel header button; or `scripts/restart-router.ps1` (Windows) / `scripts/restart-router.sh`. A restart waits for the old process to drain in-flight tasks before the new process takes over.
- The admin API accepts loopback Host + exact same-origin only; CSP allows same-origin scripts/styles and blocks third-party script injection.

## Feedback & community

Questions or usage tips to share:

- **WeChat**: `b6356120` (mention "router" when adding; I'll invite you to the user group)
- **GitHub Issues**: see the repo's Issues page

When reporting, attach: model name, the exact error text, and a panel screenshot — it makes things much faster.
