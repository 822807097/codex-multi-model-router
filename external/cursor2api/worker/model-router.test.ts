import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalModelId,
  intersectCatalog,
  isBillingError,
  openAiModelList,
  resetModelRouterStateForTest,
  routeCandidates,
  type RoutedCredential
} from "./model-router";

function credential(id: string, models: string[], disabled: string[] = []): RoutedCredential {
  return {
    id,
    label: id,
    hint: id.slice(-4),
    apiKey: `key-${id}`,
    models: models.map((model) => ({ id: model, displayName: model, aliases: [] })),
    catalogReady: true,
    disabledModels: new Set(disabled)
  };
}

describe("multi-key model router", () => {
  beforeEach(() => resetModelRouterStateForTest());

  it("publishes only the model intersection across ready credentials", () => {
    const credentials = [
      credential("one", ["Composer-2.5", "gpt-5.3-codex"]),
      credential("two", ["composer-2.5", "claude-4.6-sonnet"])
    ];

    expect(intersectCatalog(credentials).map((model) => canonicalModelId(model.id))).toEqual(["composer-2.5"]);
    expect((openAiModelList(credentials).data as Array<{ id: string }>).map((model) => model.id)).toEqual([
      "default",
      "composer-2.5"
    ]);
  });

  it("returns an empty catalog until every active credential has a catalog", () => {
    const credentials = [credential("one", ["composer-2.5"]), credential("two", [])];
    credentials[1].catalogReady = false;

    expect(openAiModelList(credentials)).toEqual({ object: "list", data: [] });
  });

  it("excludes a model disabled for a credential from routing and intersection", () => {
    const credentials = [
      credential("one", ["composer-2.5"], ["composer-2.5"]),
      credential("two", ["composer-2.5"])
    ];

    expect(intersectCatalog(credentials)).toEqual([]);
    expect(routeCandidates(credentials, "COMPOSER-2.5").map((item) => item.id)).toEqual(["two"]);
  });

  it("classifies billing failures without persisting transient failures", () => {
    expect(isBillingError({ status: 402, error: { code: "payment_required" } })).toBe(true);
    expect(isBillingError({ status: 400, error: { code: "insufficient_quota", message: "Quota exceeded" } })).toBe(true);
    expect(isBillingError(new Error("Spending limit reached for this account"))).toBe(true);
    expect(isBillingError({ status: 429, error: { code: "rate_limit_exceeded", message: "Quota temporarily rate limited" } })).toBe(false);
    expect(isBillingError(new Error("Network timeout"))).toBe(false);
  });

  it("normalizes aliases and unknown model ids consistently", () => {
    expect(canonicalModelId("Composer-2-5")).toBe("composer-2.5");
    expect(canonicalModelId(" CUSTOM-Model ")).toBe("custom-model");
  });
});
