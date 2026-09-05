import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAuthStore } from "./auth";

describe("local auth store", () => {
  test("persists client key hashes and revokes keys", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "cursor2api-auth-")), "auth.json");
    const store = new LocalAuthStore(statePath);
    const session = store.setup("administrator-password");
    expect(session).toBeTruthy();
    expect(store.isSessionValid(session!)).toBe(true);

    const created = store.createClientKey("verification");
    expect(created.token).toStartWith("sk-");
    expect(store.clientKey(created.token)).toBe(true);

    const restored = new LocalAuthStore(statePath);
    expect(restored.isConfigured()).toBe(true);
    expect(restored.clientKey(created.token)).toBe(true);
    expect(restored.revokeClientKey(created.info.id)).toBe(true);
    expect(restored.clientKey(created.token)).toBe(false);
  });
});
