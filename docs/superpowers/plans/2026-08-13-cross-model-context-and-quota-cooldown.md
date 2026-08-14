# Cross-model Context and Quota Cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one Codex task continuous across arbitrary model switches, compacting history only when the selected model's input budget requires it, while stopping repeated requests to a model under a known long-duration quota limit.

**Architecture:** Preserve the existing Chat request budget and goal-checkpoint path: short histories remain complete; over-budget histories become a checkpoint plus recent complete turns. Add a bounded in-memory `(target, model)` cooldown store that recognizes only explicit long-duration quota 429 responses. The first 429 remains visible; later attempts to that same target/model fail locally with a non-retryable 422, while other models and targets remain usable.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing Responses-to-Chat adapter and router diagnostics.

---

### Task 1: Lock context compaction semantics

**Files:**
- Modify: `test/chat-request.test.mjs`
- Verify: `lib/chat-request.mjs`
- Verify: `lib/context-budget.mjs`

- [ ] Add a test proving a model switch with history under the target model budget sends all compatible turns and makes no checkpoint request.
- [ ] Add or strengthen the long-history assertion proving old oversized turns are absent while the checkpoint and newest complete turn remain.
- [ ] Run `node --test test/chat-request.test.mjs` and confirm the behavior is green without changing production code unless the regression exposes a gap.

### Task 2: Implement a bounded long-quota cooldown store

**Files:**
- Create: `test/model-quota-cooldown.test.mjs`
- Create: `lib/model-quota-cooldown.mjs`

- [ ] Write failing tests for explicit `GoUsageLimitError`/five-hour-limit recognition, ordinary 429 rejection, numeric and HTTP-date `Retry-After`, fallback expiry, automatic expiry, and bounded entry eviction.
- [ ] Run `node --test test/model-quota-cooldown.test.mjs` and verify failure because the module is absent.
- [ ] Implement the smallest store API: `observe({ target, model, status, headers, bodyText })` and `get(target, model)`.
- [ ] Ensure entries contain only the bounded key, retry timestamp, and reason code—never body text, prompt content, headers, or credentials.
- [ ] Re-run the unit test and verify it passes.

### Task 3: Integrate cooldown into routing

**Files:**
- Modify: `test/router-integration.test.mjs`
- Modify: `lib/router-handler.mjs`
- Modify: `codex-router.mjs`

- [ ] Write a failing isolated-router test: first explicit long-quota 429 reaches the upstream; second request to the same model returns `422 model_quota_cooldown` without another upstream hit.
- [ ] Extend the test so the same task/session switches to another model and succeeds with budget-fitted context.
- [ ] Verify an ordinary transient 429 does not create a cooldown.
- [ ] Run the targeted integration test and confirm the expected failure before production edits.
- [ ] Observe qualifying Chat 429 bodies after their bounded read and store the cooldown.
- [ ] Check cooldown before opening an upstream stream; skip a cooled candidate when another compatible target exists, otherwise serialize the stable 422 response with `retry_at` and `retry_after_seconds`.
- [ ] Add `model_quota_cooldown` to router-rejection diagnostics and instantiate one process-local store in `codex-router.mjs`.
- [ ] Re-run targeted unit and integration tests until green.

### Task 4: Verify and hand off without touching the live router

**Files:**
- Review only: all changed source and tests

- [ ] Run `node --test test/model-quota-cooldown.test.mjs`.
- [ ] Run `node --test test/chat-request.test.mjs`.
- [ ] Run `node --test test/router-integration.test.mjs`.
- [ ] Run `npm test`.
- [ ] Run syntax checks for `codex-router.mjs`, `lib/router-handler.mjs`, and `lib/model-quota-cooldown.mjs`.
- [ ] Inspect `git diff --check`, `git status --short`, and the exact changed-file list; preserve the user's existing Web/UI changes.
- [ ] Give Qoder only the source synchronization list and post-deployment verification steps. Do not restart port 15730, update `A:\CodexData\router`, commit, push, or open a PR.
