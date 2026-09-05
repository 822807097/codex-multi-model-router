import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorCredentialPool, canonicalModelId, isBillingError, parseCursorCredentialEnv } from "./router";

const catalogs: Record<string, Array<{ id: string; aliases?: string[] }>> = {
  one: [{ id: "composer-2.5", aliases: ["default"] }, { id: "gpt-5.3-codex" }],
  two: [{ id: "Composer-2.5", aliases: ["default"] }, { id: "claude-4.6-sonnet" }]
};

describe("sidecar credential pool", () => {
  test("parses singular, delimited, and JSON credential environment values", () => {
    expect(parseCursorCredentialEnv("one", "team=two\nthree")).toEqual([
      { apiKey: "one", label: "default" },
      { apiKey: "two", label: "team" },
      { apiKey: "three" }
    ]);
    expect(parseCursorCredentialEnv("", '[{"label":"team","key":"two"},"three"]')).toEqual([
      { apiKey: "two", label: "team" },
      { apiKey: "three" }
    ]);
  });

  test("returns the catalog intersection and routes only supporting keys", async () => {
    const pool = new CursorCredentialPool([{ apiKey: "one" }, { apiKey: "two" }]);
    const load = async (key: string) => catalogs[key];
    expect((await pool.intersectModels(load)).map((model) => canonicalModelId(model.id))).toEqual(["composer-2.5"]);
    expect((await pool.candidates("gpt-5.3-codex", "session", load)).map((item) => item.apiKey)).toEqual(["one"]);
  });

  test("persists a billing-disabled key/model and retains a route through a backup credential", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "cursor2api-router-")), "state.json");
    const pool = new CursorCredentialPool([{ apiKey: "one" }, { apiKey: "two" }], statePath);
    pool.disableModel(pool.credentials[0], "Composer-2.5");
    expect(JSON.parse(readFileSync(statePath, "utf8")).disabledModels).toBeTruthy();

    const restored = new CursorCredentialPool([{ apiKey: "one" }, { apiKey: "two" }], statePath);
    expect((await restored.candidates("composer-2.5", "session", async (key) => catalogs[key])).map((item) => item.apiKey)).toEqual(["two"]);
    expect((await restored.intersectModels(async (key) => catalogs[key])).map((model) => canonicalModelId(model.id))).toEqual(["composer-2.5"]);
  });

  test("encrypts managed credentials across restarts", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "cursor2api-router-")), "state.json");
    const encryptionSecret = "test-encryption-secret";
    const pool = new CursorCredentialPool([], statePath, encryptionSecret);
    pool.addCredential("crsr_managed_secret", "Managed");
    const serialized = readFileSync(statePath, "utf8");
    expect(serialized).not.toContain("crsr_managed_secret");

    const restored = new CursorCredentialPool([], statePath, encryptionSecret);
    expect(restored.credentials.map((credential) => ({
      apiKey: credential.apiKey,
      label: credential.label,
      managed: credential.managed
    }))).toEqual([{ apiKey: "crsr_managed_secret", label: "Managed", managed: true }]);
  });

  test("excludes a disabled credential from catalogs and routing after restart", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "cursor2api-router-")), "state.json");
    const pool = new CursorCredentialPool([{ apiKey: "one" }, { apiKey: "two" }], statePath);
    expect(pool.disableCredential(pool.credentials[0].id, "retired")).toBe(true);

    const restored = new CursorCredentialPool([{ apiKey: "one" }, { apiKey: "two" }], statePath);
    expect((await restored.intersectModels(async (key) => catalogs[key])).map((model) => canonicalModelId(model.id))).toEqual([
      "composer-2.5",
      "claude-4.6-sonnet"
    ]);
    expect((await restored.candidates("gpt-5.3-codex", "session", async (key) => catalogs[key])).map((item) => item.apiKey)).toEqual([]);
    expect((await restored.candidates("composer-2.5", "session", async (key) => catalogs[key])).map((item) => item.apiKey)).toEqual(["two"]);
  });

  test("distinguishes billing failures from recoverable errors", () => {
    expect(isBillingError({ status: 402 })).toBe(true);
    expect(isBillingError(new Error("Insufficient credit"))).toBe(true);
    expect(isBillingError(new Error("Rate limit temporarily unavailable"))).toBe(false);
  });
});
