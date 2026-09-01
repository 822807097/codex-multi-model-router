<div align="center">

# Codex Multi-Model Router

**Local-First Multi-Model Router & Gateway**

![License](https://img.shields.io/badge/license-MIT-green) ![Node](https://img.shields.io/badge/Node.js-18%2B-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

[简体中文](./README.md) | **English**

</div>

A **local-first multi-model router & gateway**: use official ChatGPT quota, DeepSeek / Qwen / GLM / Kimi / Grok, and your Claude / Gemini / ChatGPT / Cursor subscription accounts in one model menu, for the OpenAI Codex desktop app, Claude Code, or any OpenAI-compatible client. Runs 100% on your own machine; no cloud account required.

> **Beginner one-liner**: Install Node.js → run it → open the web admin panel → click to add models & keys → point your client at one address. Done.

**Keywords**: Codex Router · Multi-Model Router · Claude Code Router · Gemini CLI · Subscription Quota Pool · OpenAI-Compatible Proxy · Local Gateway · Model Switcher · API Gateway

---

**Contents**

- [1. What it is / what it can do](#1-what-it-is--what-it-can-do)
- [2. Preparation (3 minutes)](#2-preparation-3-minutes)
- [3. Start & open the admin panel](#3-start--open-the-admin-panel)
- [4. Beginner: add your first model](#4-beginner-add-your-first-model)
- [5. Connect your clients (Codex / Trae / Qoder / OpenCode)](#5-connect-your-clients-codex--trae--qoder--opencode)
- [6. Feature map](#6-feature-map)
- [7. FAQ](#7-faq)
- [8. Security](#8-security)
- [9. Project layout & development](#9-project-layout--development)
- [10. Feedback & community](#10-feedback--community)

## 1. What it is / what it can do

The Codex desktop app allows "only one model provider at a time". This project puts a router in the middle:

```
Codex desktop / any client ──▶ 127.0.0.1:15730 (this project)
   ├─ Official channel (gpt-*/codex-*) ────▶ chatgpt.com (reuses desktop login)
   ├─ DeepSeek / Qwen / GLM / Kimi ───────▶ vendor OpenAI-compatible APIs
   ├─ Claude / Gemini / ChatGPT subs ─────▶ your membership quota (multi-account rotation)
   ├─ Cursor Pro subscription ────────────▶ built-in gateway, multi-account pool
   └─ …… any OpenAI-compatible endpoint
```

Point your client's `base_url` at `http://127.0.0.1:15730/v1`; the router forwards each request to the right upstream based on the `model` field.

**Core capabilities:**

| Capability | What it means |
| --- | --- |
| Multi-model, one menu | Official GPT and third-party models share one selector; switch anytime without touching configs |
| Web admin panel | Add/edit/remove models, test connectivity, one-click vendor onboarding, manage key pools & subscription accounts — all in your browser |
| Text & image dual channel | `/v1/responses` (Codex) and `/v1/chat/completions` (universal), native streaming |
| **Google subscription channel** | One-click Google AI Pro onboarding: the full gemini / claude family (25+ models) on your subscription quota; account-pool failover, thinking-tier variants, automatic tool-schema sanitization |
| **One-click Codex account switch** | Switch the Codex desktop app to any bound ChatGPT account from the panel (auto-backup, auto-restart, bidirectional) |
| **Live subscription quota panel** | ChatGPT accounts show 5-hour / weekly quota progress bars with reset times (same data source as the Codex CLI quota bar) |
| Vision relay ("borrowed eyes") | When a text-only model receives an image, a vision model describes it first; multi-endpoint with automatic failover |
| ChatGPT subscription image generation | `/v1/images/generations` & `/v1/images/edits` translated into official Responses + image_generation calls, billed to your ChatGPT subscription (platform key as fallback) |
| Multi-account subscription pool | Bind multiple Claude / Gemini / ChatGPT / Cursor accounts; automatic failover when quota runs dry; per-account drain order |
| Channel key pools | Multiple API keys per vendor with priority rotation and persisted 429 cooldown |
| Free-form model groups | Model cards can be freely edited / deleted / regrouped |
| Per-channel proxy | Each channel can go direct / via global proxy / via a custom node (paste ss / trojan / vless / socks5 / http links) |
| Cross-model continuation | Context trimming auto-generates a "goal checkpoint" so switching models never drops the task |
| Usage dashboard | Daily token trends, activity heatmap, per-model breakdown |
| Optional API key auth | Issue `sk-router-*` keys to control who may access |

Screenshots:

![Official & custom models in one menu](docs/demo-model-switching.png)
![Same task continuing across models](docs/demo-cross-model-continuation.png)

## 2. Preparation (3 minutes)

1. Install **Node.js 18 or newer** ([nodejs.org](https://nodejs.org), next-next-next is fine).
2. Prepare **your own** vendor API keys (DeepSeek open platform, Alibaba Bailian, SiliconFlow, OpenRouter, …). This project ships **no built-in keys**.
3. Download and extract this project's source to any directory, e.g. `D:\codex-multi-model-router`.

No npm install needed (pure Node.js — `npm start` just runs).

## 3. Start & open the admin panel

Windows:

```powershell
cd D:\codex-multi-model-router
.\scripts\start-router.ps1
```

macOS / Linux:

```bash
cd ~/codex-multi-model-router
./scripts/start-router.sh
```

When the log prints `codex-router listening on 127.0.0.1:15730`, open the admin panel in your browser:

```
http://127.0.0.1:15730/admin
```

> The panel binds to localhost (127.0.0.1) only and works under same-origin + anti-cross-site policies; it is never exposed to your LAN.

## 4. Beginner: add your first model

There are many ways to add models in the panel; the easiest is "one-click vendor onboarding":

1. Open the **model groups** page.
2. Click **one-click vendor onboarding** (top right) — a built-in list of common vendors (DeepSeek, Qwen, GLM, OpenRouter, …), grouped by region.
3. Pick a vendor, paste the API key(s) you applied for on that platform (multiple keys welcome — automatic failover), then click **onboard**.
4. The router automatically: creates the channel → puts the keys into the channel key pool → writes the vendor's default models into the catalog.

The models now appear in your client's model menu.

If you'd rather add an arbitrary OpenAI-compatible model manually:

- In **system & routing config → enabled target channels**, click "add channel": fill in the channel name, match regex (e.g. `^deepseek-`), host (e.g. `api.deepseek.com`), path prefix (usually `/v1`), and the key's env-var name.
- On the model-groups page, click "add custom model" and map the model slug to that channel.

> **Where do keys go?** This project insists "keys never live in config files". Put keys into **environment variables** (Windows: `setx VAR_NAME your_key`, e.g. `setx DEEPSEEK_API_KEY sk-xxx`) and reference only the variable name in the channel. Alternatively, paste plaintext keys into the panel's channel key pool — they are stored in the router's own local database, never written into `config.json`.

## 5. Connect your clients (Codex / Trae / Qoder / OpenCode)

Universal (any OpenAI-compatible client):

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:15730/v1` |
| API Key | a `sk-router-...` created on the panel's API-key page (create none = open access) |
| Chat endpoint | `POST /v1/chat/completions` (universal) |
| Codex endpoint | `POST /v1/responses` (Codex) |
| Model list | `GET /v1/models` |

Codex desktop app — the primary use case: let the app see every model and still open reliably. The catalog is managed dynamically by the panel's model-groups page and written into the `models.json` the desktop app reads:

- Make sure the catalog file the desktop app reads is the one this router writes (`$CODEX_HOME\models.json` by default on this machine).
- Set the desktop app's `base_url = http://127.0.0.1:15730/v1`; models appear in the bottom-right selector automatically.
- When switching across Chat / Responses, the router re-attaches full history plus a goal checkpoint, so task context survives.

> The desktop app parses `models.json` strictly. This project **auto-fills every desktop-required field** (including `supported_in_api`, `priority`, `base_instructions`, …) when writing models, so the catalog always parses and the app keeps opening.

Trae / Qoder / OpenCode etc.: they all support "OpenAI-compatible" config — just set the Base URL above. The API-key page also shows ready-made setup snippets for each key you create.

## 6. Feature map

Full details in [docs/ADVANCED.en.md](docs/ADVANCED.en.md). Quick map of "what can it do for me":

- **Membership subscription auth** (admin panel)
  - Claude / Gemini / ChatGPT member accounts: one-click OAuth or manual token, multi-account rotation, auto token refresh.
  - **Google AI Pro**: on the subscriptions page, the Google account card's "connect to router" pulls your subscription model list (full gemini / claude family) into the router; thinking tiers (`-high` / `-medium` / `-low`) auto-synthesize variants; agent tool definitions carrying Gemini-unsupported fields (`$schema` / `propertyNames` …) are auto-sanitized — no more 400s.
  - **Quota panel**: every ChatGPT account shows live 5-hour / weekly quota bars (captured from official response headers, same source as the Codex CLI quota bar); click "refresh" to update. Google accounts show a local 7-day request counter.
  - **Drain order**: each account card has a "drain order" number — lower numbers get drained first (empty = auto by plan tier, Pro first).
  - **One-click Codex switch**: on a ChatGPT account card, "switch Codex to this account" → signs out the current login (backed up) → writes that account's credentials → restarts the desktop app; bidirectional, usable ~10 seconds later.
  - Cursor Pro subscription: a built-in gateway converts subscription quota into an OpenAI-compatible API; add/remove `crsr_` keys to the account pool right in the panel.
- **Channel key pools**: multiple keys per channel, priority rotation + persisted 429 cooldown; falls back to the env var once the whole pool cools down.
- **Free-form model groups**: cards are freely editable / deletable; type a new group name to create a group (browser-local, never written into the desktop catalog); "one-click vendor onboarding" can pull the real model list to pick from.
- **Graceful restart**: the panel header's "graceful restart" swaps in new code without killing in-flight tasks.
- **Usage stats**: daily token trends, activity heatmap, per-model breakdown.
- **Full Codex plugin adaptation**: Codex tool declarations (shell, file editing, MCP, web search, …) are converted into each upstream's generic tool format.

## 7. FAQ

**Q: The client can't reach 15730?**
Make sure the router is running (log shows `listening`) and you used `http://127.0.0.1:15730/v1` — not `https`, not a public IP. If the panel opens but the client can't connect, it's almost always a wrong address/port.

**Q: A model keeps reporting "quota exceeded / 429"?**
The channel key may be exhausted, or a subscription account ran dry. Check cooldown status on the key-pool page, or account status on the subscriptions page; quota recovers automatically — no config change needed. For ChatGPT accounts, read the 5-hour / weekly bars on the account card.

**Q: Google models report 429 "per-minute quota limit"?**
Google rate-limits per "account × model" minute window (agent clients resend full context every turn, so it burns fast). The router auto-rolls to another account; if every account is inside the window, it recovers in about a minute — the error text says so. Failures lasting hours mean daily/weekly quota is used up: wait for reset or switch models (e.g. `claude-sonnet-4-6` / `gemini-2.5-flash` family). Agent clients often send `max_tokens=128000`; the router clamps it to a safe value so the pre-check won't 429.

**Q: A ChatGPT account on the subscriptions page shows "no quota data yet"?**
Quota arrives with official-channel response headers; there is no standalone query endpoint. Make one request with that account on an official model, then click "refresh".

**Q: "Unknown model / model not found"?**
The requested model name isn't in the catalog. Check it exists on the model-groups page and that its channel's match regex hits.

**Q: Added a model / changed config but nothing seems to change?**
You edited the disk config; the in-memory router needs a restart. Use the header's "graceful restart", or run `.\scripts\restart-router.ps1` / `bash scripts/restart-router.sh`.

**Q: Desktop app won't open / config_load error?**
Check the desktop log first: `unknown variant` / `missing field` = a `models.json` field problem; `usage limit` = a quota problem. This project auto-fills all required fields, so the former shouldn't happen; if it ever does, re-save any model on the model-groups page to trigger the auto-fix.

**Q: Proxy unreachable / need a global proxy?**
See [docs/ADVANCED.en.md "network & proxy"](docs/ADVANCED.en.md). Per-channel proxies are supported; custom proxies accept pasted airport node links (ss / trojan / vless / socks5 / http).

## 8. Security

- **Credentials are read only from environment variables or the local key service**: no usable key literals in source, docs, sample configs, or tests.
- Router API keys are stored hashed (`sk-router-` prefix + SHA-256); revocation is instant. Plaintext keys in channel pools live only in the local SQLite database, never written into `config.json`.
- The admin panel binds to the loopback address only, with Host/Origin/anti-cross-site checks (CSP, same-origin).
- `data/` (runtime database: accounts, keys, login states) is `.gitignore`d and never committed.

## 9. Project layout & development

```
codex-router.mjs          # entry point: assembles modules and listens on 15730
config.json               # sample config (no keys); real keys via env vars
models.json               # model catalog written by the admin panel (not committed)
lib/                      # core modules (routing, admin API, auth, key pools, subscriptions, vision relay…)
web-admin/                # admin panel frontend source (Vue 3 + Element Plus)
web/                      # built frontend assets (used at runtime)
scripts/                  # start / stop / restart / test scripts
test/                     # unit & integration tests (node:test)
```

Development / testing:

```bash
npm test                        # run all unit tests (node --test test/*.test.mjs)
cd web-admin && npm run build   # rebuild the admin panel frontend
```

Built-in mechanisms include multi-channel provider affinity per model, request budgets & timeouts, response history, cross-model goal checkpoints, channel-/account-level quota cooldowns, token tracking & usage stats; the model-catalog writer auto-completes desktop-required fields so configs never get corrupted.

## 10. Feedback & community

If this project helps you, please give it a Star. Feedback is welcome:

- **WeChat**: `b6356120` (mention "router" when adding; I'll invite you to the user group)
- **GitHub Issues**: [open an issue](https://github.com/822807097/codex-multi-model-router/issues)

When reporting, include: which model you used, the exact error text, and a screenshot of the relevant panel page — it makes things much faster.

---

<div align="center">

**MIT License** · This project is a local gateway aggregator only and is not affiliated with OpenAI / Anthropic / Google / Cursor. Please comply with each platform's terms of service — use at your own risk.

</div>
