import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface ClientKeyRecord {
  id: string;
  label: string;
  hint: string;
  hash: string;
  createdAt: string;
}

interface AuthState {
  version: 1;
  adminPasswordHash?: string;
  sessionSecret: string;
  clientKeys: ClientKeyRecord[];
  publicBaseUrl?: string;
}

export interface ClientKeyInfo {
  id: string;
  label: string;
  hint: string;
  createdAt: string;
}

export class LocalAuthStore {
  private readonly statePath: string;
  private readonly configuredClientKey: string;
  private state: AuthState;
  private readonly sessions = new Map<string, number>();

  constructor(statePath: string, configuredAdminPassword = "", configuredClientKey = "") {
    this.statePath = statePath;
    this.configuredClientKey = configuredClientKey.trim();
    this.state = readState(statePath);
    if (configuredAdminPassword.trim() && !this.state.adminPasswordHash) {
      this.state.adminPasswordHash = hashPassword(configuredAdminPassword.trim());
      this.persist();
    }
  }

  isConfigured(): boolean {
    return Boolean(this.state.adminPasswordHash);
  }

  setup(password: string): string | null {
    if (this.isConfigured() || !validPassword(password)) return null;
    this.state.adminPasswordHash = hashPassword(password);
    this.persist();
    return this.createSession();
  }

  login(password: string): string | null {
    if (!this.state.adminPasswordHash || !verifyPassword(password, this.state.adminPasswordHash)) return null;
    return this.createSession();
  }

  createSession(): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now() + 1000 * 60 * 60 * 24 * 7);
    return token;
  }

  isSessionValid(token: string): boolean {
    const expiresAt = this.sessions.get(token);
    if (!expiresAt || expiresAt < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revokeSession(token: string): void {
    this.sessions.delete(token);
  }

  clientKey(token: string): boolean {
    const candidate = token.trim();
    if (!candidate) return false;
    if (this.configuredClientKey && candidate === this.configuredClientKey) return true;
    const digest = hashToken(candidate);
    return this.state.clientKeys.some((item) => item.hash === digest);
  }

  listClientKeys(): ClientKeyInfo[] {
    return this.state.clientKeys.map(({ id, label, hint, createdAt }) => ({ id, label, hint, createdAt }));
  }

  createClientKey(label = "Default"): { token: string; info: ClientKeyInfo } {
    const token = `sk-${randomBytes(24).toString("base64url")}`;
    const info: ClientKeyInfo = {
      id: `key_${randomBytes(8).toString("hex")}`,
      label: label.trim() || "Default",
      hint: token.slice(-6),
      createdAt: new Date().toISOString()
    };
    this.state.clientKeys.push({ ...info, hash: hashToken(token) });
    this.persist();
    return { token, info };
  }

  revokeClientKey(id: string): boolean {
    const before = this.state.clientKeys.length;
    this.state.clientKeys = this.state.clientKeys.filter((item) => item.id !== id);
    if (this.state.clientKeys.length === before) return false;
    this.persist();
    return true;
  }

  publicBaseUrl(): string {
    return this.state.publicBaseUrl || "";
  }

  setPublicBaseUrl(value: string): string {
    const normalized = value.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
    this.state.publicBaseUrl = normalized;
    this.persist();
    return normalized;
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      console.warn(`Could not persist local auth state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function sessionCookie(token: string, maxAge = 60 * 60 * 24 * 7): string {
  return `cursor2api_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export function sessionToken(request: Request): string {
  const raw = request.headers.get("cookie") || "";
  const match = /(?:^|;\s*)cursor2api_session=([^;]+)/.exec(raw);
  return match ? decodeURIComponent(match[1]) : "";
}

function readState(path: string): AuthState {
  const fallback: AuthState = { version: 1, sessionSecret: randomBytes(32).toString("hex"), clientKeys: [] };
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AuthState>;
    return {
      version: 1,
      adminPasswordHash: typeof parsed.adminPasswordHash === "string" ? parsed.adminPasswordHash : undefined,
      sessionSecret: typeof parsed.sessionSecret === "string" ? parsed.sessionSecret : fallback.sessionSecret,
      clientKeys: Array.isArray(parsed.clientKeys) ? parsed.clientKeys.filter((item): item is ClientKeyRecord => Boolean(item && typeof item.id === "string" && typeof item.hash === "string")) : [],
      publicBaseUrl: typeof parsed.publicBaseUrl === "string" ? parsed.publicBaseUrl : undefined
    };
  } catch {
    return fallback;
  }
}

function validPassword(password: string): boolean {
  return password.trim().length >= 8;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [, salt, expected] = encoded.split("$");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 32);
  const target = Buffer.from(expected, "hex");
  return target.length === actual.length && timingSafeEqual(target, actual);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
