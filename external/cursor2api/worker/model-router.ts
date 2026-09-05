import { listCursorModels } from "./cursor";
import { decryptText, sha256Hex } from "./crypto";
import {
  disableCursorCredential,
  disableCursorCredentialModel,
  listCursorCredentials,
  listDisabledCursorCredentialModels,
  saveCursorCredential
} from "./db";
import { modelList } from "./openai";
import type { Deps, Env } from "./types";

export interface CatalogModel {
  id: string;
  displayName: string;
  aliases: string[];
  parameters?: unknown[];
  description?: string;
}

export interface RoutedCredential {
  id: string;
  label: string;
  hint: string;
  apiKey: string;
  models: CatalogModel[];
  catalogReady: boolean;
  disabledModels: Set<string>;
}

const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const catalogCache = new Map<string, { expiresAt: number; models: CatalogModel[] }>();
const disabledModelCache = new Map<string, Set<string>>();
const rotation = new Map<string, number>();

export function resetModelRouterStateForTest(): void {
  catalogCache.clear();
  disabledModelCache.clear();
  rotation.clear();
}

export async function loadRoutedCredentials(
  env: Env,
  deps: Deps,
  input: { accountId?: string; fallbackApiKey: string }
): Promise<RoutedCredential[]> {
  let rows = input.accountId ? await listCursorCredentials(env, input.accountId) : [];
  if (input.accountId && rows.length === 0) {
    await saveCursorCredential(env, input.accountId, input.fallbackApiKey, "default");
    rows = await listCursorCredentials(env, input.accountId);
  }
  const activeRows = rows.filter((row) => row.status === "active");
  const credentials = activeRows.length
    ? await Promise.all(activeRows.map(async (row) => ({
        id: row.id,
        label: row.label,
        hint: row.cursor_api_key_hint || row.prefix,
        apiKey: await decryptText(row.cursor_api_key_ciphertext, row.cursor_api_key_iv, requireSecret(env)),
        row
      })))
    : rows.length
      ? []
      : [{
        id: `legacy:${input.accountId || await sha256Hex(input.fallbackApiKey)}`,
        label: "default",
        hint: input.fallbackApiKey.slice(-4),
        apiKey: input.fallbackApiKey,
        row: undefined
        }];

  const routed = await Promise.all(credentials.map(async (credential) => {
    const disabledModels = await loadDisabledModels(env, credential.id);
    const cached = catalogCache.get(credential.id);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...credential, models: cached.models, catalogReady: true, disabledModels };
    }

    try {
      const response = await listCursorModels(env, deps, credential.apiKey);
      const models = normalizeCatalog(response);
      catalogCache.set(credential.id, { models, expiresAt: Date.now() + MODEL_CATALOG_TTL_MS });
      return { ...credential, models, catalogReady: true, disabledModels };
    } catch (error) {
      // Invalid credentials are not recoverable. Network, rate-limit, and other
      // warnings retain any stale catalog and remain eligible for a later retry.
      if (isAuthenticationError(error) && credential.row) {
        await disableCursorCredential(env, credential.row.id, errorMessage(error)).catch(() => undefined);
        credential.row.status = "disabled";
        credential.row.disabled_reason = errorMessage(error);
      }
      return {
        ...credential,
        models: cached?.models ?? [],
        catalogReady: Boolean(cached),
        disabledModels
      };
    }
  }));

  return routed.filter((credential) => !credential.row || credential.row.status === "active");
}

export function intersectCatalog(credentials: RoutedCredential[]): CatalogModel[] {
  if (!credentials.length || credentials.some((credential) => !credential.catalogReady)) return [];
  const ready = credentials;

  const byId = new Map(availableModels(ready[0]).map((model) => [canonicalModelId(model.id), model]));
  for (const credential of ready.slice(1)) {
    const available = new Set(availableModels(credential).map((model) => canonicalModelId(model.id)));
    for (const id of byId.keys()) {
      if (!available.has(id)) byId.delete(id);
    }
  }
  return [...byId.values()];
}

export function openAiModelList(credentials: RoutedCredential[], options: { opencode?: boolean; sdk?: boolean } = {}): Record<string, unknown> {
  const models = intersectCatalog(credentials);
  if (!models.length) return { object: "list", data: [] };

  const staticModels = new Map(
    ((modelList(options).data as Array<Record<string, unknown>>) || []).map((item) => [String(item.id), item])
  );
  const data: Array<Record<string, unknown>> = [];
  const add = (model: CatalogModel) => {
    const id = canonicalModelId(model.id);
    const known = staticModels.get(id);
    data.push({
      ...(known || { object: "model", created: 0, owned_by: "cursor" }),
      id,
      name: model.displayName || known?.name || id,
      description: model.description ?? known?.description ?? null,
      cursor_base_model: id,
      cursor_aliases: model.aliases,
      cursor_parameters: model.parameters ?? []
    });
  };
  if (models.some((model) => canonicalModelId(model.id) === "composer-2.5")) {
    const defaultModel = staticModels.get("default");
    if (defaultModel) data.push(defaultModel);
  }
  for (const model of models) add(model);
  return { object: "list", data };
}

export function routeCandidates(
  credentials: RoutedCredential[],
  requestedModel: string,
  affinity = ""
): RoutedCredential[] {
  const modelId = canonicalModelId(requestedModel);
  const eligible = credentials.filter((credential) => {
    if (credential.disabledModels.has(modelId)) return false;
    if (!credential.catalogReady || credential.models.length === 0) return false;
    return credential.models.some((model) => modelSupports(model, modelId));
  });
  if (eligible.length <= 1) return eligible;

  const key = `${modelId}:${affinity}`;
  const start = rotation.get(key) ?? stableIndex(key, eligible.length);
  rotation.set(key, (start + 1) % eligible.length);
  return [...eligible.slice(start), ...eligible.slice(0, start)];
}

export async function markBillingModelDisabled(
  env: Env,
  credential: RoutedCredential,
  model: string,
  reason: string
): Promise<void> {
  const modelId = canonicalModelId(model);
  credential.disabledModels.add(modelId);
  disabledModelCache.get(credential.id)?.add(modelId);
  if (!credential.id.startsWith("legacy:")) {
    await disableCursorCredentialModel(env, credential.id, modelId, reason).catch(() => undefined);
  }
}

export function isBillingError(error: unknown): boolean {
  const status = collectNumericFields(error, ["status", "statusCode", "httpStatus"]);
  if (status.includes(402)) return true;

  const text = collectErrorText(error).toLowerCase();
  if (["rate limit", "too many requests", "temporarily unavailable", "timeout", "timed out"].some((marker) => text.includes(marker))) {
    return false;
  }
  return [
    "billing",
    "payment required",
    "payment_required",
    "insufficient credit",
    "insufficient_credit",
    "insufficient balance",
    "insufficient_balance",
    "spending limit",
    "spending_limit",
    "usage limit",
    "usage_limit",
    "quota exceeded",
    "quota_exceeded",
    "out of credits",
    "out_of_credits",
    "credit exhausted",
    "credit_exhausted",
    "plan limit",
    "plan_limit",
    "subscription required",
    "subscription_required"
  ].some((marker) => text.includes(marker));
}

export function canonicalModelId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "auto" || normalized === "default" || normalized === "composer-latest") return "composer-2.5";
  if (normalized === "composer-2-5" || normalized === "composer-2.5-sdk") return "composer-2.5";
  if (normalized === "composer-2-5-fast") return "composer-2.5-fast";
  return normalized;
}

function availableModels(credential: RoutedCredential): CatalogModel[] {
  return credential.models.filter((model) => !credential.disabledModels.has(canonicalModelId(model.id)));
}

function normalizeCatalog(value: unknown): CatalogModel[] {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const items = Array.isArray(record.items) ? record.items : Array.isArray(record.models) ? record.models : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const model = item as Record<string, unknown>;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) return [];
    const aliases = Array.isArray(model.aliases) ? model.aliases.filter((alias): alias is string => typeof alias === "string") : [];
    return [{
      id,
      displayName: typeof model.displayName === "string" ? model.displayName : id,
      aliases,
      parameters: Array.isArray(model.parameters) ? model.parameters : undefined,
      description: typeof model.description === "string" ? model.description : undefined
    }];
  });
}

function modelSupports(model: CatalogModel, requested: string): boolean {
  const ids = [model.id, ...model.aliases].map(canonicalModelId);
  return ids.includes(requested);
}

async function loadDisabledModels(env: Env, credentialId: string): Promise<Set<string>> {
  const cached = disabledModelCache.get(credentialId);
  if (cached) return new Set(cached);
  const rows = credentialId.startsWith("legacy:") ? [] : await listDisabledCursorCredentialModels(env, credentialId);
  const disabled = new Set(rows.map((row) => canonicalModelId(row.model_id)));
  disabledModelCache.set(credentialId, disabled);
  return new Set(disabled);
}

function requireSecret(env: Env): string {
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.trim().length < 16) throw new Error("ENCRYPTION_KEY is not configured");
  return env.ENCRYPTION_KEY;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectErrorText(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean") return String(error);
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (Array.isArray(error)) return error.map((item) => collectErrorText(item, depth + 1)).join(" ");
  if (typeof error === "object") {
    return Object.entries(error as Record<string, unknown>)
      .map(([key, value]) => `${key} ${collectErrorText(value, depth + 1)}`)
      .join(" ");
  }
  return "";
}

function collectNumericFields(error: unknown, names: string[], depth = 0): number[] {
  if (depth > 5 || error === null || typeof error !== "object") return [];
  if (Array.isArray(error)) return error.flatMap((item) => collectNumericFields(item, names, depth + 1));
  const record = error as Record<string, unknown>;
  const values: number[] = [];
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number") values.push(value);
    if (typeof value === "string" && /^\d+$/.test(value)) values.push(Number(value));
  }
  for (const value of Object.values(record)) values.push(...collectNumericFields(value, names, depth + 1));
  return values;
}

function isAuthenticationError(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown };
  return value?.status === 401 || value?.code === "cursor_unauthorized";
}

function stableIndex(value: string, length: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return Math.abs(hash) % length;
}
