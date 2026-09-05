import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PoolCatalogModel {
  id: string;
  aliases?: string[];
}

export interface PoolCredential {
  id: string;
  label: string;
  apiKey: string;
  hint: string;
  disabledModels: Set<string>;
  status: "active" | "disabled";
  disabledReason?: string;
  managed: boolean;
}

interface RouterState {
  version: 2;
  disabledModels: Record<string, string[]>;
  disabledCredentials: Record<string, string>;
  credentials: Array<{ id: string; label: string; secret: EncryptedValue }>;
}

interface EncryptedValue {
  ciphertext: string;
  iv: string;
  tag: string;
}

export class CursorCredentialPool {
  readonly credentials: PoolCredential[];
  private readonly rotation = new Map<string, number>();
  private readonly statePath?: string;
  private readonly encryptionKey?: Buffer;

  constructor(keys: Array<{ apiKey: string; label?: string }>, statePath?: string, encryptionSecret?: string) {
    const state = readRouterState(statePath);
    this.encryptionKey = encryptionSecret?.trim()
      ? createHash("sha256").update(encryptionSecret.trim()).digest()
      : undefined;
    const storedKeys = this.encryptionKey
      ? state.credentials.flatMap((item) => {
          try {
            return [{ apiKey: decryptValue(item.secret, this.encryptionKey!), label: item.label, managed: true }];
          } catch {
            return [];
          }
        })
      : [];
    const unique = new Map<string, { apiKey: string; label?: string }>();
    const managedKeys = new Set(storedKeys.map((item) => item.apiKey));
    for (const item of [...keys, ...storedKeys]) {
      const apiKey = item.apiKey.trim();
      if (apiKey && !unique.has(apiKey)) unique.set(apiKey, { ...item, apiKey });
    }
    this.credentials = [...unique.values()].map((item, index) => {
      const id = credentialId(item.apiKey);
      return {
        id,
        label: item.label?.trim() || `cursor-${index + 1}`,
        apiKey: item.apiKey,
        hint: item.apiKey.slice(-4),
        disabledModels: new Set((state.disabledModels[id] || []).map(canonicalModelId)),
        status: state.disabledCredentials[id] ? "disabled" : "active",
        disabledReason: state.disabledCredentials[id],
        managed: managedKeys.has(item.apiKey)
      };
    });
    this.statePath = statePath;
  }

  async intersectModels<T extends PoolCatalogModel>(load: (apiKey: string) => Promise<T[]>): Promise<T[]> {
    const active = this.credentials.filter((credential) => credential.status === "active");
    if (!active.length) return [];
    const catalogs = await Promise.all(active.map(async (credential) => ({
      credential,
      models: await load(credential.apiKey)
    })));
    const first = catalogs[0];
    const shared = new Map(first.models.map((model) => [canonicalModelId(model.id), model]));
    for (const entry of catalogs.slice(1)) {
      const available = new Set(entry.models.map((model) => canonicalModelId(model.id)));
      for (const modelId of shared.keys()) if (!available.has(modelId)) shared.delete(modelId);
    }
    return [...shared].flatMap(([modelId, model]) => (
      catalogs.some(({ credential }) => !credential.disabledModels.has(modelId)) ? [model] : []
    ));
  }

  async candidates<T extends PoolCatalogModel>(
    requestedModel: string,
    affinity: string,
    load: (apiKey: string) => Promise<T[]>
  ): Promise<PoolCredential[]> {
    const modelId = canonicalModelId(requestedModel);
    const catalogs = await Promise.all(this.credentials.filter((credential) => credential.status === "active").map(async (credential) => {
      try {
        return { credential, models: await load(credential.apiKey) };
      } catch {
        return { credential, models: [] as T[] };
      }
    }));
    const eligible = catalogs
      .filter(({ credential, models }) => (
        !credential.disabledModels.has(modelId)
        && models.some((model) => modelSupports(model, modelId))
      ))
      .map(({ credential }) => credential);
    if (eligible.length <= 1) return eligible;

    const key = `${modelId}:${affinity}`;
    const start = this.rotation.get(key) ?? stableIndex(key, eligible.length);
    this.rotation.set(key, (start + 1) % eligible.length);
    return [...eligible.slice(start), ...eligible.slice(0, start)];
  }

  disableModel(credential: PoolCredential, model: string): void {
    credential.disabledModels.add(canonicalModelId(model));
    this.persist();
  }

  addCredential(apiKey: string, label = "Imported"): PoolCredential {
    const normalized = apiKey.trim();
    const existing = this.credentials.find((credential) => credential.apiKey === normalized);
    if (existing) {
      existing.label = label.trim() || existing.label;
      existing.status = "active";
      existing.disabledReason = undefined;
      existing.managed = true;
      this.persist();
      return existing;
    }
    const credential: PoolCredential = {
      id: credentialId(normalized),
      label: label.trim() || `cursor-${this.credentials.length + 1}`,
      apiKey: normalized,
      hint: normalized.slice(-4),
      disabledModels: new Set(),
      status: "active",
      managed: true
    };
    this.credentials.push(credential);
    this.persist();
    return credential;
  }

  disableCredential(id: string, reason = "disabled by gateway owner"): boolean {
    const credential = this.credentials.find((item) => item.id === id);
    if (!credential) return false;
    credential.status = "disabled";
    credential.disabledReason = reason;
    this.persist();
    return true;
  }

  private persist(): void {
    if (!this.statePath) return;
    const state: RouterState = {
      version: 2,
      disabledModels: Object.fromEntries(
        this.credentials
          .filter((credential) => credential.disabledModels.size > 0)
          .map((credential) => [credential.id, [...credential.disabledModels].sort()])
      ),
      disabledCredentials: Object.fromEntries(
        this.credentials
          .filter((credential) => credential.status === "disabled")
          .map((credential) => [credential.id, credential.disabledReason || "disabled"])
      ),
      credentials: this.encryptionKey
        ? this.credentials
            .filter((credential) => credential.managed)
            .map((credential) => ({
              id: credential.id,
              label: credential.label,
              secret: encryptValue(credential.apiKey, this.encryptionKey!)
            }))
        : [],
    };
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
    } catch (error) {
      console.warn(`Could not persist Cursor router state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function parseCursorCredentialEnv(primary = "", multiple = ""): Array<{ apiKey: string; label?: string }> {
  const parsed: Array<{ apiKey: string; label?: string }> = [];
  const trimmed = multiple.trim();
  if (trimmed.startsWith("[")) {
    try {
      const values = JSON.parse(trimmed) as unknown;
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value === "string") parsed.push({ apiKey: value });
          else if (value && typeof value === "object") {
            const item = value as { key?: unknown; apiKey?: unknown; label?: unknown };
            const apiKey = typeof item.apiKey === "string" ? item.apiKey : typeof item.key === "string" ? item.key : "";
            if (apiKey) parsed.push({ apiKey, label: typeof item.label === "string" ? item.label : undefined });
          }
        }
      }
    } catch {
      // Fall back to the delimiter format below.
    }
  }
  if (!parsed.length && trimmed) {
    for (const entry of trimmed.split(/[\r\n,;]+/)) {
      const value = entry.trim();
      if (!value) continue;
      const separator = value.indexOf("=");
      parsed.push(separator > 0
        ? { label: value.slice(0, separator).trim(), apiKey: value.slice(separator + 1).trim() }
        : { apiKey: value });
    }
  }
  if (primary.trim()) parsed.unshift({ apiKey: primary.trim(), label: "default" });
  return parsed;
}

export function canonicalModelId(value: string): string {
  const base = value.trim().replace(/\[.*\]$/, "").split("/").filter(Boolean).at(-1) || "auto";
  const normalized = base.toLowerCase();
  if (normalized === "default") return "auto";
  if (normalized === "composer-2-5" || normalized === "composer-2.5-sdk" || normalized === "composer-latest") return "composer-2.5";
  if (normalized === "composer-2-5-fast") return "composer-2.5-fast";
  return normalized;
}

export function isBillingError(error: unknown): boolean {
  const status = numericFields(error, ["status", "statusCode", "httpStatus"]);
  if (status.includes(402)) return true;
  const text = errorText(error).toLowerCase();
  if (["rate limit", "too many requests", "temporarily unavailable", "timeout", "timed out"].some((marker) => text.includes(marker))) return false;
  return [
    "billing", "payment required", "payment_required", "insufficient credit", "insufficient_credit",
    "insufficient balance", "insufficient_balance", "spending limit", "spending_limit", "usage limit",
    "usage_limit", "quota exceeded", "quota_exceeded", "out of credits", "out_of_credits",
    "credit exhausted", "credit_exhausted", "plan limit", "plan_limit", "subscription required",
    "subscription_required"
  ].some((marker) => text.includes(marker));
}

function modelSupports(model: PoolCatalogModel, requestedModel: string): boolean {
  return [model.id, ...(model.aliases || [])].map(canonicalModelId).includes(requestedModel);
}

function credentialId(apiKey: string): string {
  return `cred_${createHash("sha256").update(apiKey).digest("hex").slice(0, 24)}`;
}

function readRouterState(statePath?: string): RouterState {
  const empty = (): RouterState => ({ version: 2, disabledModels: {}, disabledCredentials: {}, credentials: [] });
  if (!statePath) return empty();
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<RouterState>;
    return {
      version: 2,
      disabledModels: parsed.disabledModels && typeof parsed.disabledModels === "object" ? parsed.disabledModels : {},
      disabledCredentials: parsed.disabledCredentials && typeof parsed.disabledCredentials === "object" ? parsed.disabledCredentials : {},
      credentials: Array.isArray(parsed.credentials) ? parsed.credentials : []
    };
  } catch {
    return empty();
  }
}

function encryptValue(value: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

function decryptValue(value: EncryptedValue, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function errorText(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return "";
  if (typeof error === "string" || typeof error === "number" || typeof error === "boolean") return String(error);
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (Array.isArray(error)) return error.map((item) => errorText(item, depth + 1)).join(" ");
  if (typeof error === "object") return Object.entries(error as Record<string, unknown>).map(([key, value]) => `${key} ${errorText(value, depth + 1)}`).join(" ");
  return "";
}

function numericFields(error: unknown, names: string[], depth = 0): number[] {
  if (depth > 5 || error === null || typeof error !== "object") return [];
  if (Array.isArray(error)) return error.flatMap((item) => numericFields(item, names, depth + 1));
  const record = error as Record<string, unknown>;
  const values = names.flatMap((name) => {
    const value = record[name];
    if (typeof value === "number") return [value];
    if (typeof value === "string" && /^\d+$/.test(value)) return [Number(value)];
    return [];
  });
  return [...values, ...Object.values(record).flatMap((value) => numericFields(value, names, depth + 1))];
}

function stableIndex(value: string, length: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return Math.abs(hash) % length;
}
