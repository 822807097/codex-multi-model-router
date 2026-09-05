/**
 * API for Cursor — standalone sidecar server.
 *
 * A `node:http` server that exposes the standard (non-account) OpenAI-compatible
 * `/v1/*` surface by reusing the import-clean worker helpers.
 *
 * It has two paths for chat/responses:
 *   - PRIMARY (full macOS parity): when `CURSOR_SDK_BRIDGE_URL` is set, route via
 *     `worker/cursor-sdk.ts` `createCursorSdkCompletion`, mirroring `worker/index.ts`.
 *     This works with only the user's Cursor key (no private backend secrets).
 *   - FALLBACK: the direct `worker/cursor.ts` path when no bridge is configured.
 *
 * `cursor-sdk.ts` is import-clean here: it only TYPE-references
 * `DurableObjectNamespace` and touches `env.DB` inside try/catch (in-memory
 * fallback), so an undefined `env.DB` is fine. We still avoid importing
 * `worker/index`, `worker/db`, or `worker/sdk-bridge-container`.
 *
 * The worker helpers operate on Web `Request`/`Response` and parsed JSON. Node
 * 24 ships global `fetch`/`Request`/`Response`/`ReadableStream`/`crypto`, so we
 * only need thin adapters between `node:http` messages and Web types.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

import {
  createCursorCompletion,
  streamCursorText,
  type CursorTextEvent
} from "../worker/cursor";
import { errorResponse, HttpError, json, notFound, openAiError, sseResponse, unauthorized } from "../worker/http";
import {
  chatChunk,
  chatCompletionResponse,
  chatUsageChunk,
  completionCharsFromOutput,
  doneChunk,
  prepareChatRequest,
  prepareResponsesRequest,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseErrorEvent,
  responseObject,
  responseTextStartEvents,
  responseToolCallEvents,
  toOpenAiToolCalls,
  toolCallRetryHint,
  type OpenAiToolCall,
  type OpenAiToolSpec,
  type ToolCallContext
} from "../worker/openai";
import { collectCursorOutput } from "../worker/cursor";
import {
  createCursorSdkCompletion,
  collectCursorSdkOutput,
  isTransientCursorSdkError
} from "../worker/cursor-sdk";
import { encodeSse } from "../worker/sse";
import type { CursorToolCall, Deps, Env } from "../worker/types";
import {
  anthropicError,
  anthropicMessage,
  anthropicSseEvents,
  anthropicToChatBody,
  contextFromAnthropicBeta,
  estimateTokens,
  mapModel
} from "./anthropic";
import {
  canonicalModelId,
  CursorCredentialPool,
  isBillingError,
  parseCursorCredentialEnv
} from "./router";
import { LocalAuthStore, sessionCookie, sessionToken } from "./auth";

const HOST = process.env.HOST?.trim() || "127.0.0.1";
const DEFAULT_PORT = 8787;
const PRIMARY_MODEL = "auto";
const STATIC_DIR = process.env.STATIC_DIR?.trim() ? resolve(process.env.STATIC_DIR.trim()) : "";

/**
 * Minimal `Deps` backed by the real runtime. Identical in spirit to the
 * worker's `defaultDeps`, but with no Cloudflare assumptions.
 */
const deps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID()
};

/**
 * Build the minimal `Env` that `cursor.ts` needs. Only the Cursor-facing fields
 * are populated; D1/R2/Container fields are typed away with `undefined`/casts
 * because the standard `/v1` glue never touches them.
 *
 * The Cursor backend base URL and chat endpoint are deployment secrets (they
 * live in worker secrets, not as constants in `cursor.ts`), so we forward them
 * from the process environment when present. `/v1/models` and `/health` never
 * read them; chat/responses will surface a clean `HttpError` if a live request
 * is attempted without them configured.
 */
function buildEnv(): Env {
  return {
    ASSETS: undefined as unknown as Env["ASSETS"],
    DB: undefined as unknown as Env["DB"],
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || "api-for-cursor",
    CURSOR_API_BASE: process.env.CURSOR_API_BASE || "https://api.cursor.com",
    CURSOR_BACKEND_BASE_URL: process.env.CURSOR_BACKEND_BASE_URL,
    CURSOR_CHAT_ENDPOINT: process.env.CURSOR_CHAT_ENDPOINT,
    CURSOR_CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION || "2.6.22",
    CURSOR_SDK_BRIDGE_URL: process.env.CURSOR_SDK_BRIDGE_URL,
    CURSOR_SDK_BRIDGE_TOKEN: process.env.CURSOR_SDK_BRIDGE_TOKEN,
    CURSOR_SDK_BRIDGE_TIMEOUT_MS: process.env.CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS
  };
}

const env = buildEnv();
const credentialPool = new CursorCredentialPool(
  parseCursorCredentialEnv(process.env.CURSOR_API_KEY || "", process.env.CURSOR_API_KEYS || ""),
  process.env.CURSOR_ROUTER_STATE_PATH?.trim() || undefined,
  process.env.ENCRYPTION_KEY
);
const authStatePath = process.env.LOCAL_AUTH_STATE_PATH?.trim()
  || (process.env.CURSOR_ROUTER_STATE_PATH?.trim() || ".cursor2api/router-state.json") + ".auth";
const authStore = new LocalAuthStore(authStatePath, process.env.ADMIN_PASSWORD || "");

/**
 * The SDK bridge path (full macOS parity) is the PRIMARY route for
 * chat/responses whenever `CURSOR_SDK_BRIDGE_URL` is set. Otherwise we fall back
 * to the direct `worker/cursor.ts` path.
 */
function hasSdkBridge(): boolean {
  return Boolean(env.CURSOR_SDK_BRIDGE_URL?.trim());
}

/**
 * Derive a stable session key so multi-turn conversations reuse the same SDK
 * agent. Mirrors the worker's session-affinity headers, falling back to a fresh
 * UUID when the client provides none.
 */
function sessionAffinity(request: Request): string {
  const headers = request.headers;
  const candidate =
    headers.get("x-session-affinity") ||
    headers.get("x-opencode-session-id") ||
    headers.get("x-opencode-session") ||
    headers.get("idempotency-key") ||
    "";
  const trimmed = candidate.trim();
  return trimmed || `session-${crypto.randomUUID()}`;
}

/**
 * Owner key for SDK session scoping. We key the session cache to the resolved
 * Cursor API key so distinct keys never share an agent.
 */
function sdkSessionOwner(apiKey: string): string {
  return `cursor-key:${apiKey}`;
}

/**
 * Best-effort, in-memory store for the Responses API so that
 * `GET/DELETE /v1/responses/{id}` can echo a previously created response.
 */
interface StoredResponse {
  response: Record<string, unknown>;
  updatedAt: number;
}
const responseStore = new Map<string, StoredResponse>();
const RESPONSE_STORE_LIMIT = 512;

function storeResponse(id: string, response: Record<string, unknown>): void {
  responseStore.set(id, { response, updatedAt: Date.now() });
  if (responseStore.size <= RESPONSE_STORE_LIMIT) return;
  const entries = [...responseStore.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [key] of entries.slice(0, responseStore.size - RESPONSE_STORE_LIMIT)) {
    responseStore.delete(key);
  }
}

/**
 * External API calls use client keys created in the local control console.
 * Cursor credentials never leave the credential pool.
 */
interface RequestAccess {
  mode: "pool";
}

function requestApiKey(request: Request): string {
  // Anthropic clients send the key as `x-api-key`; OpenAI clients use Bearer auth.
  const apiKeyHeader = (request.headers.get("x-api-key") || "").trim();
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const bearer = match ? match[1].trim() : "";
  const candidate = apiKeyHeader || bearer;
  return candidate;
}

function resolveAccess(request: Request): RequestAccess | null {
  return authStore.clientKey(requestApiKey(request)) ? { mode: "pool" } : null;
}

async function cursorModelSelection(requestedModel: string, body: unknown, apiKey?: string): Promise<{ id: string }> {
  const rawModel = requestedModel.trim() || PRIMARY_MODEL;
  const match = /^([^\[]+?)(?:\[(.*)\])?$/.exec(rawModel);
  let modelId = (match?.[1] || PRIMARY_MODEL).trim();
  if (modelId.toLowerCase() === "default") modelId = "auto";

  const params = new Map<string, string>();
  const explicitParams = new Set<string>();
  const rawParams = match?.[2]?.trim();
  if (rawParams) {
    for (const entry of rawParams.split(",")) {
      const separator = entry.indexOf("=");
      if (separator <= 0) continue;
      const id = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
      if (id && value) {
        params.set(id, value);
        explicitParams.add(id);
      }
    }
  }

  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const reasoning = record.reasoning && typeof record.reasoning === "object" && !Array.isArray(record.reasoning)
    ? record.reasoning as Record<string, unknown>
    : {};
  const outputConfig = record.output_config && typeof record.output_config === "object" && !Array.isArray(record.output_config)
    ? record.output_config as Record<string, unknown>
    : {};
  const effort = [record.reasoning_effort, reasoning.effort, outputConfig.effort]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  let supportedParameters: Set<string> | undefined;
  if (apiKey) {
    const catalog = await liveCursorModels(apiKey);
    const normalizedModelId = modelId.split("/").filter(Boolean).at(-1) || modelId;
    const model = catalog.find((item) => item.id === normalizedModelId || item.aliases?.includes(normalizedModelId));
    supportedParameters = model ? new Set((model.parameters ?? []).map((parameter) => parameter.id)) : undefined;
  }
  if (
    effort
    && supportedParameters?.has("effort")
    && !params.has("effort")
    && !params.has("reasoning_effort")
  ) {
    params.set("effort", effort.trim());
  }

  const serviceTier = typeof record.service_tier === "string" ? record.service_tier.trim().toLowerCase() : "";
  const standardFast = typeof record.fast === "boolean"
    ? record.fast
    : serviceTier === "priority" || serviceTier === "fast"
      ? true
      : undefined;
  if (standardFast !== undefined && supportedParameters?.has("fast") && !params.has("fast")) {
    params.set("fast", String(standardFast));
  }

  if (typeof record.cursor_fast === "boolean" && !params.has("fast")) {
    params.set("fast", String(record.cursor_fast));
  }
  if (typeof record.cursor_context === "string" && record.cursor_context.trim() && !params.has("context")) {
    params.set("context", record.cursor_context.trim());
  }

  const routerMode = [record.cursor_router_mode, record.optimize_for]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  if (modelId.toLowerCase() === "auto-smart" && routerMode && !params.has("optimize_for")) {
    params.set("optimize_for", routerMode.trim());
  }

  const customParams = record.cursor_params ?? record.model_params;
  if (Array.isArray(customParams)) {
    for (const item of customParams) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const param = item as Record<string, unknown>;
      if (typeof param.id === "string" && typeof param.value === "string" && param.id.trim() && param.value.trim()) {
        params.set(param.id.trim(), param.value.trim());
        explicitParams.add(param.id.trim());
      }
    }
  } else if (customParams && typeof customParams === "object") {
    for (const [id, value] of Object.entries(customParams as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) {
        params.set(id, value.trim());
        explicitParams.add(id);
      } else if (typeof value === "boolean" || typeof value === "number") {
        params.set(id, String(value));
        explicitParams.add(id);
      }
    }
  }

  for (const id of explicitParams) {
    if (id === "reasoning_effort") {
      if (!params.has("effort")) params.set("effort", params.get(id) ?? "");
      params.delete(id);
    }
  }

  return { id: parameterizedModelId(modelId, Array.from(params, ([id, value]) => ({ id, value }))) };
}

// ---------------------------------------------------------------------------
// Route handlers (Web Request -> Web Response). These replicate ONLY the
// standard `/v1` glue from `worker/index.ts`, dropping the proxy/account/SDK
// paths and the Cloudflare `ExecutionContext`.
// ---------------------------------------------------------------------------

function healthResponse(request: Request): Response {
  return json({
    ok: true,
    service: "api-for-cursor",
    host: HOST,
    modelCatalog: credentialPool.credentials.length > 1 ? "multi-key-intersection" : "live-account-specific",
    credentialCount: credentialPool.credentials.length,
    clientKeyAuth: true,
    sdkVersion: "1.0.27",
    baseUrl: publicApiBaseUrl(request)
  });
}

interface CursorCatalogParameter {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
}

interface CursorCatalogVariant {
  params: Array<{ id: string; value: string }>;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

interface CursorCatalogModel {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: CursorCatalogParameter[];
  variants?: CursorCatalogVariant[];
}

const MODEL_CATALOG_TTL_MS = 60_000;
const modelCatalogCache = new Map<string, { models: CursorCatalogModel[]; expiresAt: number }>();

async function modelCatalogCacheKey(apiKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function cursorSdkModelsUrl(): string {
  const bridgeUrl = env.CURSOR_SDK_BRIDGE_URL?.trim();
  if (!bridgeUrl) {
    throw new HttpError("Cursor SDK bridge is not configured", 503, "cursor_sdk_bridge_missing");
  }
  const url = new URL(bridgeUrl);
  url.pathname = "/models";
  url.search = "";
  return url.toString();
}

async function liveCursorModels(apiKey: string): Promise<CursorCatalogModel[]> {
  const cacheKey = await modelCatalogCacheKey(apiKey);
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.models;

  const headers: Record<string, string> = { "content-type": "application/json" };
  const bridgeToken = env.CURSOR_SDK_BRIDGE_TOKEN?.trim();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;

  const response = await deps.fetch(cursorSdkModelsUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify({ apiKey })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text || `Cursor model discovery failed with status ${response.status}`;
    try {
      const payload = JSON.parse(text) as { error?: { message?: string } };
      if (payload.error?.message) message = payload.error.message;
    } catch {
      // Keep the raw response text.
    }
    const status = response.status === 401 ? 401 : response.status === 429 ? 429 : 502;
    throw new HttpError(message, status, response.status === 401 ? "cursor_unauthorized" : "cursor_models_error");
  }

  const payload = await response.json() as { models?: CursorCatalogModel[] };
  const models = Array.isArray(payload.models)
    ? payload.models.filter((model) => model && typeof model.id === "string" && typeof model.displayName === "string")
    : [];
  modelCatalogCache.set(cacheKey, { models, expiresAt: Date.now() + MODEL_CATALOG_TTL_MS });
  return models;
}

function parameterizedModelId(modelId: string, params: Array<{ id: string; value: string }>): string {
  if (!params.length) return modelId;
  return `${modelId}[${params.map((param) => `${param.id}=${param.value}`).join(",")}]`;
}

function openAiCatalogItem(
  model: CursorCatalogModel,
  id: string,
  displayName: string
): Record<string, unknown> {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "cursor",
    name: displayName,
    description: model.description ?? null,
    cursor_base_model: model.id,
    cursor_aliases: model.aliases ?? [],
    cursor_parameters: model.parameters ?? []
  };
}

function openAiCatalogData(models: CursorCatalogModel[]): Array<Record<string, unknown>> {
  const data: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const add = (item: Record<string, unknown>) => {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    data.push(item);
  };

  for (const model of models) {
    add(openAiCatalogItem(model, model.id, model.displayName));
  }

  return data;
}

async function handleModels(request: Request): Promise<Response> {
  if (!resolveAccess(request)) return unauthorized();
  const models = await credentialPool.intersectModels(liveCursorModels);
  return json({ object: "list", data: openAiCatalogData(models) });
}

async function handleModel(request: Request, id: string): Promise<Response> {
  if (!resolveAccess(request)) return unauthorized();
  const catalog = await credentialPool.intersectModels(liveCursorModels);
  const models = openAiCatalogData(catalog);
  const model = models.find((item) => item.id === id);
  if (!model) return openAiError(`Model '${id}' not found`, 404, "not_found", "model");
  return json(model);
}

function hasAdminSession(request: Request): boolean {
  return authStore.isSessionValid(sessionToken(request));
}

function assertManagedCredentialStore(): void {
  if (!process.env.ENCRYPTION_KEY?.trim() || !process.env.CURSOR_ROUTER_STATE_PATH?.trim()) {
    throw new HttpError(
      "ENCRYPTION_KEY and CURSOR_ROUTER_STATE_PATH are required for the local credential store",
      503,
      "server_error"
    );
  }
}

function configuredPublicBaseUrl(): string {
  return authStore.publicBaseUrl() || (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}

function publicApiBaseUrl(request: Request): string {
  const configured = configuredPublicBaseUrl();
  return (configured || new URL(request.url).origin) + "/v1";
}

function normalizePublicBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/v1$/i, "").replace(/\/+$/, "");
  if (!raw) return "";
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    throw new HttpError("Public URL must be a complete http(s) URL", 400, "invalid_request_error", "publicBaseUrl");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host) {
    throw new HttpError("Public URL must use http or https", 400, "invalid_request_error", "publicBaseUrl");
  }
  return parsed.toString().replace(/\/$/, "").replace(/\/v1$/i, "");
}

async function handleAuthStatus(request: Request): Promise<Response> {
  return json({ configured: authStore.isConfigured(), authenticated: hasAdminSession(request) });
}

async function handleAuthSetup(request: Request): Promise<Response> {
  if (authStore.isConfigured()) throw new HttpError("Administrator password is already configured", 409, "conflict");
  const body = await request.json() as Record<string, unknown>;
  const password = typeof body.password === "string" ? body.password : "";
  const token = authStore.setup(password);
  if (!token) throw new HttpError("Password must contain at least 8 characters", 400, "invalid_request_error", "password");
  return json({ configured: true, authenticated: true }, { headers: { "set-cookie": sessionCookie(token) } });
}

async function handleAuthLogin(request: Request): Promise<Response> {
  if (!authStore.isConfigured()) throw new HttpError("Set an administrator password before signing in", 409, "setup_required");
  const body = await request.json() as Record<string, unknown>;
  const password = typeof body.password === "string" ? body.password : "";
  const token = authStore.login(password);
  if (!token) return unauthorized();
  return json({ configured: true, authenticated: true }, { headers: { "set-cookie": sessionCookie(token) } });
}

function handleAuthLogout(request: Request): Response {
  authStore.revokeSession(sessionToken(request));
  return json({ ok: true }, { headers: { "set-cookie": sessionCookie("", 0) } });
}

async function handleSettings(request: Request): Promise<Response> {
  if (!hasAdminSession(request)) return unauthorized();
  if (request.method === "GET") return json({ publicBaseUrl: configuredPublicBaseUrl(), baseUrl: publicApiBaseUrl(request) });
  if (request.method === "PUT") {
    const body = await request.json() as Record<string, unknown>;
    const value = typeof body.publicBaseUrl === "string" ? body.publicBaseUrl : "";
    const publicBaseUrl = authStore.setPublicBaseUrl(normalizePublicBaseUrl(value));
    return json({ publicBaseUrl, baseUrl: publicApiBaseUrl(request) });
  }
  return notFound();
}

async function handleClientKeys(request: Request, keyId = ""): Promise<Response> {
  if (!hasAdminSession(request)) return unauthorized();
  if (request.method === "GET" && !keyId) return json({ data: authStore.listClientKeys() });
  if (request.method === "POST" && !keyId) {
    const body = await request.json() as Record<string, unknown>;
    const label = typeof body.label === "string" ? body.label : "Default";
    const created = authStore.createClientKey(label);
    return json({ ...created.info, token: created.token }, { status: 201 });
  }
  if (request.method === "DELETE" && keyId) {
    if (!authStore.revokeClientKey(keyId)) return notFound();
    return json({ id: keyId, revoked: true });
  }
  return notFound();
}

async function handleLocalCredentials(request: Request, credentialId = ""): Promise<Response> {
  if (!hasAdminSession(request)) return unauthorized();

  if (request.method === "GET" && !credentialId) {
    const data = await Promise.all(credentialPool.credentials.map(async (credential) => {
      let models: string[] = [];
      if (credential.status === "active") {
        try {
          models = (await liveCursorModels(credential.apiKey))
            .map((model) => model.id)
            .filter((model) => !credential.disabledModels.has(canonicalModelId(model)));
        } catch {
          models = [];
        }
      }
      return {
        id: credential.id,
        label: credential.label,
        hint: credential.hint,
        status: credential.status,
        disabledReason: credential.disabledReason || null,
        models,
        disabledModels: [...credential.disabledModels]
      };
    }));
    return json({ data });
  }

  if (request.method === "POST" && !credentialId) {
    assertManagedCredentialStore();
    const body = await request.json() as Record<string, unknown>;
    const cursorApiKey = typeof body.cursorApiKey === "string" ? body.cursorApiKey.trim() : "";
    const label = typeof body.label === "string" ? body.label.trim() : "Imported";
    if (!cursorApiKey) throw new HttpError("Cursor API key is required", 400, "invalid_request_error", "cursorApiKey");
    const models = await liveCursorModels(cursorApiKey);
    const credential = credentialPool.addCredential(cursorApiKey, label);
    return json({
      id: credential.id,
      label: credential.label,
      hint: credential.hint,
      cursorEmail: null,
      models: models.map((model) => model.id),
      disabledModels: [...credential.disabledModels]
    }, { status: 201 });
  }

  if (request.method === "DELETE" && credentialId) {
    if (!credentialPool.disableCredential(credentialId)) return notFound();
    return json({ id: credentialId, disabled: true });
  }

  return notFound();
}

async function routeCredentialRequest(
  request: Request,
  requestedModel: string,
  run: (apiKey: string, onBillingError?: (error: unknown) => void) => Promise<Response>
): Promise<Response> {
  if (!resolveAccess(request)) return unauthorized();

  const candidates = await credentialPool.candidates(
    requestedModel,
    sessionAffinity(request),
    liveCursorModels
  );
  if (!candidates.length) {
    throw new HttpError(`Model '${requestedModel}' is not available for the configured Cursor credential pool`, 404, "model_not_found", "model");
  }

  let lastBillingError: unknown;
  for (const credential of candidates) {
    const disableOnBilling = (error: unknown): void => {
      if (!isBillingError(error)) return;
      credentialPool.disableModel(credential, requestedModel);
      console.warn(JSON.stringify({
        event: "cursor_model_disabled",
        credentialId: credential.id,
        credentialHint: credential.hint,
        model: requestedModel,
        reason: error instanceof Error ? error.message : String(error)
      }));
    };
    try {
      return await run(credential.apiKey, disableOnBilling);
    } catch (error) {
      if (!isBillingError(error)) throw error;
      lastBillingError = error;
      disableOnBilling(error);
    }
  }
  throw lastBillingError instanceof Error
    ? lastBillingError
    : new HttpError("No Cursor credential can currently serve this model", 503, "cursor_credential_unavailable");
}

async function handleChatCompletions(request: Request): Promise<Response> {
  const body = await request.json();
  const requestedModel = typeof (body as { model?: unknown })?.model === "string" ? (body as { model: string }).model : PRIMARY_MODEL;
  return routeCredentialRequest(request, requestedModel, (apiKey, onBillingError) => (
    handleChatCompletionsWithKey(request, body, requestedModel, apiKey, onBillingError)
  ));
}

async function handleChatCompletionsWithKey(
  request: Request,
  body: unknown,
  requestedModel: string,
  apiKey: string,
  onBillingError?: (error: unknown) => void
): Promise<Response> {
  const cursorModel = await cursorModelSelection(requestedModel, body, apiKey);
  const prepared = prepareChatRequest(body, cursorModel);

  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);

  if (hasSdkBridge()) {
    return handleSdkRoute("chat", request, prepared, apiKey, id, created, chatIncrementalPrompt(body, cursorModel), onBillingError);
  }

  const completion = await createCursorCompletion(env, deps, apiKey, {
    prompt: prepared.prompt,
    model: prepared.cursorModel
  });

  if (prepared.stream) {
    return streamOpenAiResponse("chat", completion.stream, {
      id,
      created,
      model: prepared.model,
      promptChars: prepared.promptChars,
      includeUsage: prepared.includeUsage,
      tools: prepared.tools,
      context: prepared.toolContext,
      onError: onBillingError
    });
  }

  const output = await collectCursorOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext
  });
  return json(
    chatCompletionResponse({
      id,
      created,
      model: prepared.model,
      text: output.text,
      toolCalls,
      promptChars: prepared.promptChars,
      metadata: prepared.responseMetadata
    })
  );
}

async function handleResponses(request: Request): Promise<Response> {
  const body = await request.json();
  const requestedModel = typeof (body as { model?: unknown })?.model === "string" ? (body as { model: string }).model : PRIMARY_MODEL;
  return routeCredentialRequest(request, requestedModel, (apiKey, onBillingError) => (
    handleResponsesWithKey(request, body, requestedModel, apiKey, onBillingError)
  ));
}

async function handleResponsesWithKey(
  request: Request,
  body: unknown,
  requestedModel: string,
  apiKey: string,
  onBillingError?: (error: unknown) => void
): Promise<Response> {
  const cursorModel = await cursorModelSelection(requestedModel, body, apiKey);
  const prepared = prepareResponsesRequest(body, cursorModel);

  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);

  if (hasSdkBridge()) {
    return handleSdkRoute("responses", request, prepared, apiKey, id, created, undefined, onBillingError);
  }

  const completion = await createCursorCompletion(env, deps, apiKey, {
    prompt: prepared.prompt,
    model: prepared.cursorModel
  });

  if (prepared.stream) {
    return streamOpenAiResponse("responses", completion.stream, {
      id,
      created,
      model: prepared.model,
      promptChars: prepared.promptChars,
      includeUsage: prepared.includeUsage,
      metadata: prepared.responseMetadata,
      tools: prepared.tools,
      context: prepared.toolContext,
      onError: onBillingError,
      onDone: (text, _completionChars, toolCalls) => {
        storeResponse(
          id,
          responseObject({
            id,
            created,
            model: prepared.model,
            text,
            toolCalls,
            promptChars: prepared.promptChars,
            metadata: prepared.responseMetadata
          })
        );
      }
    });
  }

  const output = await collectCursorOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext
  });
  const response = responseObject({
    id,
    created,
    model: prepared.model,
    text: output.text,
    toolCalls,
    promptChars: prepared.promptChars,
    metadata: prepared.responseMetadata
  });
  storeResponse(id, response);
  return json(response);
}

// ---------------------------------------------------------------------------
// SDK bridge path (full macOS parity). Mirrors `worker/index.ts`
// `handleSdkPreparedOpenAiRoute`: `createCursorSdkCompletion` ->
// `collectCursorSdkOutput` + `chatCompletionResponse`/`responseObject` (non-stream)
// or `streamOpenAiEvents` over `completion.stream` (stream). The SDK completion's
// `.stream` is already an `AsyncIterable<CursorTextEvent>`, so the same
// `streamOpenAiEvents` / collected-output builders work unchanged.
// ---------------------------------------------------------------------------

type PreparedRequest = ReturnType<typeof prepareChatRequest> | ReturnType<typeof prepareResponsesRequest>;

/**
 * Transient SDK failures worth a transparent retry: the bridge does NOT auto-retry a run
 * timeout, and a freshly created SDK agent occasionally stalls on the handshake / first
 * token to Cursor's backend. We only retry when this happens *before any output*.
 */
function isTransientSdkError(error: unknown): boolean {
  return isTransientCursorSdkError(error);
}

/**
 * Wrap an SDK event stream so a transient failure *before any event is emitted* retries
 * with a fresh attempt (the factory decides what changes per attempt). Once any event has
 * been yielded we never retry, so partial output is never duplicated.
 */
function retryingSdkStream(
  make: (attempt: number) => Promise<AsyncIterable<CursorTextEvent>>,
  maxAttempts = 2
): AsyncIterable<CursorTextEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let attempt = 0; ; attempt += 1) {
        const iterator = (await make(attempt))[Symbol.asyncIterator]();
        let emitted = false;
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) return;
            emitted = true;
            yield next.value;
          }
        } catch (error) {
          try {
            await iterator.return?.();
          } catch {
            /* ignore */
          }
          if (!emitted && attempt + 1 < maxAttempts && isTransientSdkError(error)) continue;
          throw error;
        }
      }
    }
  };
}

/**
 * The incremental "new turn" for a follow-up chat request: every message after the last
 * assistant message. Returned as a CursorPrompt so a still-cached SDK agent receives only
 * the new turn instead of the whole conversation. Undefined on the first turn (no prior
 * assistant) — then the bridge uses the full prompt.
 */
function chatIncrementalPrompt(
  body: unknown,
  cursorModel: { id: string }
): ReturnType<typeof prepareChatRequest>["prompt"] | undefined {
  const messages = (body as { messages?: Array<{ role?: string }> } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0 || lastAssistant >= messages.length - 1) return undefined;
  const tail = messages.slice(lastAssistant + 1);
  try {
    const deltaBody = { ...(body as Record<string, unknown>), messages: tail, stream: false };
    return prepareChatRequest(deltaBody as Parameters<typeof prepareChatRequest>[0], cursorModel).prompt;
  } catch {
    return undefined;
  }
}

/** Shared tool-call gate for the SDK paths (OpenAI + Anthropic): allow a tool call only
 * if it maps to a known client tool, else return a retry hint string. */
function sdkAllowToolCall(prepared: PreparedRequest, toolCall: CursorToolCall) {
  if (!prepared.tools.length) return "No client tool inventory was available for this request.";
  const toolCalls = toOpenAiToolCalls({
    toolCalls: [toolCall],
    tools: prepared.tools,
    responseId: "probe",
    context: prepared.toolContext
  });
  return toolCalls.length > 0
    || toolCallRetryHint({ toolCall, tools: prepared.tools, context: prepared.toolContext });
}

// ---------------------------------------------------------------------------
// Anthropic Messages API (Claude Code). Translates Anthropic <-> the OpenAI/Cursor SDK
// path via `anthropic.ts`. See docs/superpowers/specs/2026-06-02-anthropic-endpoint-*.
// ---------------------------------------------------------------------------

/** Wrap an Anthropic SSE event generator into a streaming Response. On mid-stream failure
 * (after `message_start`), emit an Anthropic `error` event rather than a broken stream. */
function anthropicSseResponse(
  events: AsyncGenerator<{ event: string; data: Record<string, unknown> }>,
  onError?: (error: unknown) => void
): Response {
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const { event, data } of events) controller.enqueue(encodeSse(data, event));
      } catch (error) {
        onError?.(error);
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(encodeSse(anthropicError(message, "api_error"), "error"));
      } finally {
        controller.close();
      }
    }
  });
  return sseResponse(readable);
}

async function handleAnthropicMessages(request: Request): Promise<Response> {
  const body = await request.json();
  const requestedModel =
    body && typeof body === "object" && typeof (body as { model?: unknown }).model === "string"
      ? (body as { model: string }).model
      : PRIMARY_MODEL;
  return routeCredentialRequest(request, requestedModel, (apiKey, onBillingError) => (
    handleAnthropicMessagesWithKey(request, body, requestedModel, apiKey, onBillingError)
  ));
}

async function handleAnthropicMessagesWithKey(
  request: Request,
  body: unknown,
  requestedModel: string,
  apiKey: string,
  onBillingError?: (error: unknown) => void
): Promise<Response> {
  const translatedBody = anthropicToChatBody(body);
  const requestedContext = contextFromAnthropicBeta(request.headers.get("anthropic-beta"));
  if (requestedContext) translatedBody.cursor_context = requestedContext;
  const cursorModel = await cursorModelSelection(mapModel(requestedModel), translatedBody, apiKey);
  const prepared = prepareChatRequest(translatedBody, cursorModel);
  logToolForwarding("anthropic", prepared);
  const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  const inputTokens = estimateTokens(prepared.promptChars);

  // Claude Code resends the full conversation (incl. tool_result) every turn, so /v1/messages is
  // stateless: a fresh SDK session + full prompt per request, plus the transparent auto-retry.
  const makeStream = async (_attempt: number): Promise<AsyncIterable<CursorTextEvent>> => {
    const completion = await createCursorSdkCompletion(env, deps, apiKey, {
      prompt: prepared.prompt,
      model: prepared.cursorModel,
      sessionKey: `cc-${crypto.randomUUID()}`,
      sessionOwnerKey: sdkSessionOwner(apiKey),
      workingDirectory: prepared.toolContext?.workingDirectory,
      clientTools: prepared.tools,
      requiresLocalTool: prepared.requiresLocalTool,
      allowToolCall: (toolCall) => sdkAllowToolCall(prepared, toolCall)
    });
    return completion.stream;
  };
  const stream = retryingSdkStream(makeStream);

  if (prepared.stream) {
    return anthropicSseResponse(anthropicSseEvents({
      id,
      model: requestedModel,
      inputTokens,
      stream,
      tools: prepared.tools,
      toolContext: prepared.toolContext
    }), onBillingError);
  }

  const output = await collectCursorSdkOutput(stream);
  return json(
    anthropicMessage({
      id,
      model: requestedModel,
      text: output.text,
      toolCalls: output.toolCalls,
      tools: prepared.tools,
      toolContext: prepared.toolContext,
      inputTokens,
      outputTokens: estimateTokens(output.text.length)
    })
  );
}

/** `POST /v1/messages/count_tokens` — Claude Code's pre-send estimate. Uses the
 * same client API-key authorization as `/v1/messages`. */
async function handleCountTokens(request: Request): Promise<Response> {
  if (!resolveAccess(request)) return unauthorized();
  const body = await request.json();
  const translatedBody = anthropicToChatBody(body);
  const prepared = prepareChatRequest(translatedBody, await cursorModelSelection(mapModel(""), translatedBody));
  return json({ input_tokens: estimateTokens(prepared.promptChars) });
}

async function handleSdkRoute(
  kind: "chat" | "responses",
  request: Request,
  prepared: PreparedRequest,
  apiKey: string,
  id: string,
  created: number,
  incrementalPrompt?: ReturnType<typeof prepareChatRequest>["prompt"],
  onBillingError?: (error: unknown) => void
): Promise<Response> {
  logToolForwarding(kind, prepared);
  // Maintain one SDK agent per client session "under the hood": attempt 0 reuses the
  // session (stable affinity key) and sends only the new turn (incrementalPrompt). The
  // bridge re-feeds nothing while the agent is still cached and falls back to the full
  // prompt if it was evicted, so context is never lost. A transparent retry (attempt >= 1)
  // uses a FRESH session + the full prompt, so a transient bridge stall ("run timed out")
  // self-recovers instead of surfacing to the client.
  const baseSessionKey = sessionAffinity(request);
  const makeStream = async (attempt: number): Promise<AsyncIterable<CursorTextEvent>> => {
    const completion = await createCursorSdkCompletion(env, deps, apiKey, {
      prompt: prepared.prompt,
      model: prepared.cursorModel,
      sessionKey: attempt === 0 ? baseSessionKey : `retry-${crypto.randomUUID()}`,
      sessionOwnerKey: sdkSessionOwner(apiKey),
      incrementalPrompt: attempt === 0 ? incrementalPrompt : undefined,
      workingDirectory: prepared.toolContext?.workingDirectory,
      clientTools: prepared.tools,
      requiresLocalTool: prepared.requiresLocalTool,
      allowToolCall: (toolCall) => sdkAllowToolCall(prepared, toolCall)
    });
    return completion.stream;
  };
  const stream = retryingSdkStream(makeStream);

  if (prepared.stream) {
    return streamOpenAiEvents(kind, stream, {
      id,
      created,
      model: prepared.model,
      promptChars: prepared.promptChars,
      includeUsage: prepared.includeUsage,
      metadata: prepared.responseMetadata,
      tools: prepared.tools,
      context: prepared.toolContext,
      onError: onBillingError,
      onDone: (text, _completionChars, toolCalls) => {
        if (kind === "responses") {
          storeResponse(
            id,
            responseObject({
              id,
              created,
              model: prepared.model,
              text,
              toolCalls,
              promptChars: prepared.promptChars,
              metadata: prepared.responseMetadata
            })
          );
        }
      }
    });
  }

  const output = await collectCursorSdkOutput(stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext
  });

  if (kind === "chat") {
    return json(
      chatCompletionResponse({
        id,
        created,
        model: prepared.model,
        text: output.text,
        toolCalls,
        promptChars: prepared.promptChars,
        metadata: prepared.responseMetadata
      })
    );
  }

  const response = responseObject({
    id,
    created,
    model: prepared.model,
    text: output.text,
    toolCalls,
    promptChars: prepared.promptChars,
    metadata: prepared.responseMetadata
  });
  storeResponse(id, response);
  return json(response);
}

function logToolForwarding(surface: string, prepared: PreparedRequest): void {
  console.info(JSON.stringify({
    event: "client_tool_forwarding",
    surface,
    mode: prepared.prompt.mode,
    toolCount: prepared.tools.length,
    toolNames: prepared.tools.map((tool) => tool.name),
    requiresLocalTool: prepared.requiresLocalTool
  }));
}

function handleResponseState(request: Request, responseId: string): Response {
  if (!resolveAccess(request)) return unauthorized();
  const stored = responseStore.get(responseId);
  if (!stored) return openAiError("Response not found", 404, "not_found");
  if (request.method === "GET" || request.method === "HEAD") {
    return json(stored.response);
  }
  if (request.method === "DELETE") {
    responseStore.delete(responseId);
    return json({ id: responseId, object: "response", deleted: true });
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// Streaming glue. This mirrors `streamOpenAiEvents` from `worker/index.ts` but
// runs the pump directly (no `ExecutionContext.waitUntil`) and skips the
// request-log bookkeeping that only exists on the hosted proxy path.
// ---------------------------------------------------------------------------

interface StreamInput {
  id: string;
  created: number;
  model: string;
  promptChars: number;
  includeUsage: boolean;
  metadata?: Record<string, unknown>;
  tools: OpenAiToolSpec[];
  context?: ToolCallContext;
  onDone?: (text: string, completionChars: number, toolCalls: OpenAiToolCall[]) => void;
  onError?: (error: unknown) => void | Promise<void>;
}

function streamOpenAiResponse(kind: "chat" | "responses", cursorStream: Response, input: StreamInput): Response {
  return streamOpenAiEvents(kind, streamCursorText(cursorStream), input);
}

function streamOpenAiEvents(
  kind: "chat" | "responses",
  cursorEvents: AsyncIterable<CursorTextEvent>,
  input: StreamInput
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const pump = async () => {
    let text = "";
    let toolCallCount = 0;
    let finishReason: "stop" | "tool_calls" = "stop";
    const streamedToolCalls: OpenAiToolCall[] = [];
    let responseNextOutputIndex = 0;
    let responseTextOutputIndex: number | null = null;
    try {
      if (kind === "chat") {
        await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, role: "assistant" }));
      } else {
        for (const event of responseCreatedEvents(input)) await writer.write(event);
      }

      for await (const event of cursorEvents) {
        if (event.type === "text" && event.text) {
          text += event.text;
          if (kind === "chat") {
            await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, delta: event.text }));
          } else {
            if (responseTextOutputIndex === null) {
              responseTextOutputIndex = responseNextOutputIndex;
              responseNextOutputIndex += 1;
              for (const chunk of responseTextStartEvents({ id: input.id, outputIndex: responseTextOutputIndex })) {
                await writer.write(chunk);
              }
            }
            await writer.write(responseDeltaEvent({ id: input.id, delta: event.text, outputIndex: responseTextOutputIndex }));
          }
        }
        if (event.type === "tool_call") {
          const [toolCall] = toOpenAiToolCalls({
            toolCalls: [event.toolCall],
            tools: input.tools,
            responseId: input.id,
            startIndex: toolCallCount,
            context: input.context
          });
          if (!toolCall) continue;
          finishReason = "tool_calls";
          streamedToolCalls.push(toolCall);
          if (kind === "chat") {
            await writer.write(
              chatChunk({ id: input.id, created: input.created, model: input.model, toolCall: { index: toolCallCount, value: toolCall } })
            );
          } else {
            for (const chunk of responseToolCallEvents({ id: input.id, toolCall, outputIndex: responseNextOutputIndex })) {
              await writer.write(chunk);
            }
            responseNextOutputIndex += 1;
          }
          toolCallCount += 1;
        }
        if (event.type === "done") {
          text = event.finalText;
        }
      }

      if (kind === "chat") {
        const completionChars = completionCharsFromOutput(text, streamedToolCalls);
        await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, finish: true, finishReason }));
        if (input.includeUsage) {
          await writer.write(
            chatUsageChunk({
              id: input.id,
              created: input.created,
              model: input.model,
              promptChars: input.promptChars,
              completionChars
            })
          );
        }
        await writer.write(doneChunk());
      } else {
        if (responseTextOutputIndex === null && !streamedToolCalls.length) {
          responseTextOutputIndex = responseNextOutputIndex;
          responseNextOutputIndex += 1;
          for (const chunk of responseTextStartEvents({ id: input.id, outputIndex: responseTextOutputIndex })) {
            await writer.write(chunk);
          }
        }
        for (const event of responseDoneEvents({
          ...input,
          text,
          toolCalls: streamedToolCalls,
          textStarted: responseTextOutputIndex !== null,
          textOutputIndex: responseTextOutputIndex ?? 0
        })) {
          await writer.write(event);
        }
      }
      input.onDone?.(text, completionCharsFromOutput(text, streamedToolCalls), streamedToolCalls);
    } catch (error) {
      await input.onError?.(error);
      const message = error instanceof Error ? error.message : "Stream failed";
      await writer
        .write(
          kind === "responses"
            ? responseErrorEvent(message)
            : encodeSse({ error: { message, type: "cursor_error", code: "cursor_stream_error" } }, "error")
        )
        .catch(() => undefined);
    } finally {
      await writer.close().catch(() => undefined);
    }
  };
  void pump();
  return sseResponse(readable);
}

function staticContentType(filePath: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp"
  };
  return types[extname(filePath).toLowerCase()] || "application/octet-stream";
}

function serveStatic(request: Request, pathname: string): Response {
  if (!STATIC_DIR || (request.method !== "GET" && request.method !== "HEAD")) return notFound();
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return notFound(); }
  const requested = decoded === "/" || !extname(decoded) ? "/index.html" : decoded;
  const filePath = resolve(STATIC_DIR, `.${requested}`);
  if (filePath !== STATIC_DIR && !filePath.startsWith(`${STATIC_DIR}${sep}`)) return notFound();
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return notFound();
  const headers = new Headers({
    "content-type": staticContentType(filePath),
    "cache-control": requested === "/index.html" || /\.(?:css|js|map)$/.test(requested)
      ? "no-cache"
      : "public, max-age=3600"
  });
  const body = request.method === "HEAD" ? null : new Uint8Array(readFileSync(filePath));
  return new Response(body, { headers });
}

// ---------------------------------------------------------------------------
// Router. Only the bare `/v1/...` surface is matched; account-scoped,
// opencode, and opencodev2 surfaces from the worker are intentionally omitted.
// ---------------------------------------------------------------------------

async function route(request: Request, port: number): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers": "authorization,content-type,x-api-key"
      }
    });
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") return notFound();
      return healthResponse(request);
    }

    if (pathname === "/api/auth/status") {
      if (request.method !== "GET") return notFound();
      return await handleAuthStatus(request);
    }

    if (pathname === "/api/auth/setup") {
      if (request.method !== "POST") return notFound();
      return await handleAuthSetup(request);
    }

    if (pathname === "/api/auth/login") {
      if (request.method !== "POST") return notFound();
      return await handleAuthLogin(request);
    }

    if (pathname === "/api/auth/logout") {
      if (request.method !== "POST") return notFound();
      return handleAuthLogout(request);
    }

    if (pathname === "/api/settings") return await handleSettings(request);

    if (pathname === "/api/keys") return await handleClientKeys(request);

    const clientKeyMatch = /^\/api\/keys\/([^/]+)$/.exec(pathname);
    if (clientKeyMatch) return await handleClientKeys(request, decodeURIComponent(clientKeyMatch[1]));

    if (pathname === "/api/credentials") {
      return await handleLocalCredentials(request);
    }

    const credentialMatch = /^\/api\/credentials\/([^/]+)$/.exec(pathname);
    if (credentialMatch) {
      return await handleLocalCredentials(request, decodeURIComponent(credentialMatch[1]));
    }

    const v1Path = pathname.startsWith("/v1/") ? pathname.slice(3) : pathname === "/v1" ? "/" : "";

    if (v1Path === "/models") {
      if (request.method !== "GET") return notFound();
      return await handleModels(request);
    }

    const modelMatch = /^\/models\/(.+)$/.exec(v1Path);
    if (modelMatch) {
      if (request.method !== "GET") return notFound();
      return await handleModel(request, decodeURIComponent(modelMatch[1]));
    }

    if (v1Path === "/chat/completions") {
      if (request.method !== "POST") return notFound();
      return await handleChatCompletions(request);
    }

    if (v1Path === "/responses") {
      if (request.method !== "POST") return notFound();
      return await handleResponses(request);
    }

    if (v1Path === "/messages/count_tokens") {
      if (request.method !== "POST") return notFound();
      return await handleCountTokens(request);
    }

    if (v1Path === "/messages") {
      if (request.method !== "POST") return notFound();
      return await handleAnthropicMessages(request);
    }

    const responseMatch = /^\/responses\/([^/]+)$/.exec(v1Path);
    if (responseMatch) {
      return handleResponseState(request, decodeURIComponent(responseMatch[1]));
    }

    if (pathname === "/api" || pathname.startsWith("/api/") || pathname === "/v1" || pathname.startsWith("/v1/")) {
      return notFound();
    }
    return serveStatic(request, pathname);
  } catch (error) {
    return errorResponse(error);
  }
}

// ---------------------------------------------------------------------------
// node:http <-> Web Request/Response adapters.
// ---------------------------------------------------------------------------

function toWebRequest(req: IncomingMessage, port: number): Request {
  const method = req.method || "GET";
  const authority = typeof req.headers.host === "string" && req.headers.host.trim()
    ? req.headers.host.trim()
    : `${HOST}:${port}`;
  const url = `http://${authority}${req.url || "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    const bodyPromise = new Promise<Buffer>((resolve, reject) => {
      req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
    // Materialize the body synchronously-ish: callers await `route`, which
    // awaits `request.json()`. We attach a stream so the Web Request can read it.
    init.body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const buffer = await bodyPromise;
        if (buffer.length) controller.enqueue(new Uint8Array(buffer));
        controller.close();
      }
    });
    (init as { duplex?: string }).duplex = "half";
  }
  return new Request(url, init);
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

function parsePort(): number {
  const raw = process.env.PORT;
  if (!raw) return DEFAULT_PORT;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_PORT;
}

function main(): void {
  const port = parsePort();
  const server = createServer((req, res) => {
    const request = toWebRequest(req, port);
    route(request, port)
      .then((response) => writeWebResponse(res, response))
      .catch((error) => {
        const response = errorResponse(error);
        writeWebResponse(res, response).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
  });

  server.listen(port, HOST, () => {
    console.log(`API for Cursor server running at http://${HOST}:${port}/v1`);
  });
}

main();
