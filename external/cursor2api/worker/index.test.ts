import { describe, expect, it } from "vitest";
import { resetCursorSdkSessionCacheForTest } from "./cursor-sdk";
import { handleRequest } from "./index";
import { resetModelRouterStateForTest } from "./model-router";
import { FakeD1, fakeCtx } from "./test-helpers";
import type { Deps, Env } from "./types";

interface MakeEnvOptions {
  assetsFetch?: Fetcher["fetch"];
  releases?: Record<string, { body: string; contentType?: string }>;
  notaryWebhookToken?: string;
  githubReleaseDispatchToken?: string;
  githubReleaseRepository?: string;
}

function makeEnv(
  db: FakeD1,
  assetsFetchOrOptions: Fetcher["fetch"] | MakeEnvOptions = () => Promise.resolve(new Response("asset"))
): Env {
  const options: MakeEnvOptions =
    typeof assetsFetchOrOptions === "function" ? { assetsFetch: assetsFetchOrOptions } : assetsFetchOrOptions;
  const assetsFetch = options.assetsFetch ?? (() => Promise.resolve(new Response("asset")));
  return {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: assetsFetch } as unknown as Fetcher,
    RELEASES: options.releases ? fakeR2(options.releases) : undefined,
    ENCRYPTION_KEY: "test-encryption-secret-with-enough-entropy",
    CURSOR_API_BASE: "https://api.cursor.test",
    CURSOR_BACKEND_BASE_URL: "https://cursor-backend.test",
    CURSOR_CHAT_ENDPOINT: "/test-cursor-chat",
    CURSOR_CLIENT_VERSION: "2.6.22",
    CURSOR_LOCAL_AGENT_ENDPOINT: "/test-local-sdk",
    CURSOR_SDK_CLIENT_VERSION: "sdk-test",
    NOTARY_WEBHOOK_TOKEN: options.notaryWebhookToken,
    GITHUB_RELEASE_DISPATCH_TOKEN: options.githubReleaseDispatchToken,
    GITHUB_RELEASE_REPOSITORY: options.githubReleaseRepository
  };
}

function fakeR2(objects: Record<string, { body: string; contentType?: string }>): R2Bucket {
  return {
    async get(key: string) {
      const item = objects[key];
      if (!item) return null;
      const body = new TextEncoder().encode(item.body);
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          }
        }),
        httpEtag: `"${key}-etag"`,
        httpMetadata: { contentType: item.contentType },
        writeHttpMetadata(headers: Headers) {
          if (item.contentType) headers.set("content-type", item.contentType);
        }
      } as unknown as R2ObjectBody;
    }
  } as unknown as R2Bucket;
}

describe("Worker", () => {
  it("redirects the public download URL to the latest DMG release object", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(new Request("https://composer.test/download"), env, fakeCtx(), deps);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://composer.test/releases/API-for-Cursor-latest.dmg");
  });

  it("serves Sparkle appcast and DMG release objects from R2", async () => {
    const db = new FakeD1();
    const env = makeEnv(db, {
      releases: {
        "appcast.xml": { body: "<rss></rss>", contentType: "application/rss+xml" },
        "releases/API-for-Cursor-0.1.0-1.dmg": { body: "dmg-bytes", contentType: "application/x-apple-diskimage" }
      }
    });
    const { deps } = fakeDeps();

    const appcast = await handleRequest(new Request("https://composer.test/appcast.xml"), env, fakeCtx(), deps);
    expect(appcast.status).toBe(200);
    expect(appcast.headers.get("content-type")).toContain("application/rss+xml");
    expect(appcast.headers.get("cache-control")).toContain("max-age=60");
    await expect(appcast.text()).resolves.toBe("<rss></rss>");

    const dmg = await handleRequest(new Request("https://composer.test/releases/API-for-Cursor-0.1.0-1.dmg"), env, fakeCtx(), deps);
    expect(dmg.status).toBe(200);
    expect(dmg.headers.get("content-type")).toContain("application/x-apple-diskimage");
    expect(dmg.headers.get("cache-control")).toContain("immutable");
    expect(dmg.headers.get("content-disposition")).toContain("API-for-Cursor-0.1.0-1.dmg");
    await expect(dmg.text()).resolves.toBe("dmg-bytes");
  });

  it("returns 404 for missing release objects without falling through to assets", async () => {
    const db = new FakeD1();
    const env = makeEnv(db, { releases: {} });
    const { deps } = fakeDeps();

    const response = await handleRequest(new Request("https://composer.test/releases/missing.dmg"), env, fakeCtx(), deps);

    expect(response.status).toBe(404);
  });

  it("dispatches the release finalizer from an Apple notary webhook", async () => {
    const db = new FakeD1();
    const env = makeEnv(db, {
      notaryWebhookToken: "webhook-secret",
      githubReleaseDispatchToken: "github-token",
      githubReleaseRepository: "standardagents/composer-api"
    });
    const dispatches: { url: string; init?: RequestInit }[] = [];
    const { deps } = fakeDeps({
      fetch: (input, init) => {
        dispatches.push({ url: input.toString(), init });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
    });
    const url =
      "https://composer.test/api/notary/webhook/webhook-secret?version=0.1.3&build=4&run_id=123&artifact=pending&dmg=API.dmg&ref=refs/tags/v0.1.3";

    const response = await handleRequest(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "notary-id", status: "Accepted" })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].url).toBe("https://api.github.com/repos/standardagents/composer-api/dispatches");
    expect(dispatches[0].init?.headers).toMatchObject({ authorization: "Bearer github-token" });
    const body = JSON.parse(dispatches[0].init?.body as string);
    expect(body.event_type).toBe("apple-notary-complete");
    expect(body.client_payload).toMatchObject({
      submissionId: "notary-id",
      submissionStatus: "Accepted",
      version: "0.1.3",
      build: "4",
      sourceRunId: "123",
      artifactName: "pending",
      dmgName: "API.dmg",
      ref: "refs/tags/v0.1.3"
    });
  });

  it("allows OpenCode session headers in CORS preflight", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(new Request("https://composer.test/opencode/v1/chat/completions", { method: "OPTIONS" }), env, fakeCtx(), deps);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("x-session-affinity");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-opencode-session-id");
  });

  it("serves current stable Vite assets for stale hashed asset URLs", async () => {
    const db = new FakeD1();
    const requested: string[] = [];
    const env = makeEnv(db, (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requested.push(url.pathname);
      if (url.pathname === "/assets/index.css") {
        return Promise.resolve(new Response("body { color: red; }", { headers: { "content-type": "text/css" } }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/assets/index-OLDHASH.css"),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    await expect(response.text()).resolves.toContain("color: red");
    expect(requested).toContain("/assets/index.css");
  });

  it("signs up a Cursor API key and serves chat completions", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const signup = await handleRequest(
      new Request("https://composer.test/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cursorApiKey: "cursor_key", name: "Ada", email: "ada@example.com", joinWaitlist: true })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(signup.status).toBe(200);
    const signupBody = (await signup.json()) as { apiKey: string; endpoints: { chatCompletions: string } };
    expect(signupBody.apiKey).toMatch(/^cmp_/);
    expect(signupBody.endpoints.chatCompletions).toContain("/u/acct_");

    const completion = await handleRequest(
      new Request(signupBody.endpoints.chatCompletions, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${signupBody.apiKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(completion.status).toBe(200);
    await expect(completion.json()).resolves.toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "Hello from Composer" } }]
    });
    expect([...db.requestLogs.values()].at(-1)).toMatchObject({
      status: "completed",
      completion_chars: "Hello from Composer".length
    });
  });

  it("normalizes tool-call arguments through account-scoped Worker endpoints", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const signup = await handleRequest(
      new Request("https://composer.test/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cursorApiKey: "cursor_key", name: "Ada", email: "ada@example.com" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const signupBody = (await signup.json()) as { apiKey: string; endpoints: { chatCompletions: string } };

    const response = await handleRequest(
      new Request(signupBody.endpoints.chatCompletions, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${signupBody.apiKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Schema transform" }],
          tools: [
            {
              type: "function",
              function: {
                name: "glob",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: { pattern: { type: "string" } },
                  required: ["pattern"]
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            tool_calls: [{ type: "function", function: { name: "glob", arguments: "{\"pattern\":\"**/*.ts\"}" } }]
          },
          finish_reason: "tool_calls"
        }
      ]
    });
  });

  it("serves bare /v1/chat/completions with a direct Cursor key and writes no request log", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, exchangeAuthHeaders } = fakeDeps();

    const completion = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(completion.status).toBe(200);
    await expect(completion.json()).resolves.toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "Hello from Composer" } }]
    });

    // Direct mode must not persist anything to D1.
    expect(db.requestLogs.size).toBe(0);
    expect(db.accounts.size).toBe(0);
    expect(db.apiKeys.size).toBe(0);

    // The caller's own key is forwarded only for Cursor API-key authorization.
    expect(exchangeAuthHeaders).toContain("Bearer cursor_direct_key");
  });

  it("keeps the Cursor machine identity stable across API key rotations for the same account", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestHeaders } = fakeDeps();

    for (const key of ["cursor_direct_key_one", "cursor_direct_key_two"]) {
      const completion = await handleRequest(
        new Request("https://composer.test/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`
          },
          body: JSON.stringify({
            model: "composer-2.5",
            messages: [{ role: "user", content: "Say hello" }]
          })
        }),
        env,
        fakeCtx(),
        deps
      );
      expect(completion.status).toBe(200);
      await completion.json();
    }

    expect(chatRequestHeaders).toHaveLength(2);
    const machineIds = chatRequestHeaders.map((headers) => headers.get("x-cursor-checksum")?.slice(-64));
    expect(machineIds[0]).toBe(machineIds[1]);
    expect(chatRequestHeaders[0].get("x-cursor-config-version")).toBe(chatRequestHeaders[1].get("x-cursor-config-version"));
  });

  it("streams SSE chat chunks in direct mode when stream is true", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, exchangeAuthHeaders } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"content":"Hello from Composer"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('"choices":[]');
    expect(body).toContain('"usage"');
    expect(body).toContain('"total_usd"');
    expect(body).toContain("data: [DONE]");

    expect(db.requestLogs.size).toBe(0);
    expect(exchangeAuthHeaders).toContain("Bearer cursor_direct_key");
  });

  it("streams Composer tool-call markers as OpenAI chat tool calls", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          messages: [{ role: "user", content: "List files" }],
          tools: [
            {
              type: "function",
              function: {
                name: "glob",
                description: "Find files by glob",
                parameters: { type: "object", properties: { glob_pattern: { type: "string" } } }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"content":"Checking the workspace.\\n"');
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"name":"glob"');
    expect(body).toContain('"arguments":"{\\"glob_pattern\\":\\"*\\"}"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).not.toContain("tool_calls_begin");
  });

  it("buffers Composer tool-call markers as OpenAI chat tool calls", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "List files" }],
          tools: [{ type: "function", function: { name: "glob" } }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            content: "Checking the workspace.\n",
            tool_calls: [{ type: "function", function: { name: "glob", arguments: "{\"glob_pattern\":\"*\"}" } }]
          },
          finish_reason: "tool_calls"
        }
      ]
    });
  });

  it("serves OpenCode chat through the SDK harness with tool calls", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key",
          "x-session-affinity": "session-one"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "List files" }],
          tools: [
            {
              type: "function",
              function: {
                name: "glob",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: { pattern: { type: "string" } }
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"name":"glob"');
    expect(body).toContain('"arguments":"{\\"pattern\\":\\"*\\"}"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('"choices":[]');
    expect(body).toContain('"usage"');
    expect(db.requestLogs.size).toBe(0);
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
    expect(String(sdkRequests[0].body)).toContain("agent-");
    expect(String(sdkRequests[0].body)).toContain("SDK-compatible OpenCode harness");
    expect(sdkRequests[0].headers.get("x-cursor-client-type")).toBe("sdk");
    expect(sdkRequests[0].headers.get("x-cursor-client-version")).toBe("sdk-test");
    expect(sdkRequests[0].headers.get("content-type")).toContain("application/connect+proto");
  });

  it("keeps legacy /opencode chat on the Cursor chat endpoint", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencode/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_legacy",
          "x-session-affinity": "legacy-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "List files" }],
          tools: [{ type: "function", function: { name: "glob" } }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            content: "Checking the workspace.\n",
            tool_calls: [{ type: "function", function: { name: "glob", arguments: "{\"glob_pattern\":\"*\"}" } }]
          },
          finish_reason: "tool_calls"
        }
      ]
    });
    expect(sdkRequests).toHaveLength(0);
    expect(chatRequestBodies).toHaveLength(1);
    expect(chatRequestBodies[0]).toContain("This request is already in Agent mode");
    expect(chatRequestBodies[0]).toContain("Switched to agent mode successfully.");
    expect(chatRequestBodies[0]).not.toContain("SDK-compatible OpenCode harness");
  });

  it("keeps OpenCode SDK agents stable for a session-affinity header", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();

    for (const affinity of ["session-one", "session-one", "session-two"]) {
      const response = await handleRequest(
        new Request("https://composer.test/opencodev2/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer cursor_direct_key_stability",
            "x-session-affinity": affinity
          },
          body: JSON.stringify({
            model: "composer-2.5",
            messages: [{ role: "user", content: "Say hello" }]
          })
        }),
        env,
        fakeCtx(),
        deps
      );
      expect(response.status).toBe(200);
      await response.json();
    }

    expect(chatRequestBodies).toHaveLength(0);
    const paths = sdkRequests.map((item) => `${item.method} ${item.path}`);
    expect(paths).toEqual(["POST /test-local-sdk", "POST /test-local-sdk", "POST /test-local-sdk"]);
    const firstAgent = /agent-[0-9a-f-]{36}/.exec(String(sdkRequests[0].body))?.[0];
    expect(firstAgent).toBeTruthy();
    expect(String(sdkRequests[1].body)).toContain(firstAgent!);
    expect(String(sdkRequests[2].body)).not.toContain(firstAgent!);
    expect(String(sdkRequests[0].body)).toContain("SDK-compatible OpenCode harness");
    expect(String(sdkRequests[0].body)).not.toContain("Switched to agent mode successfully");
  });

  it("streams local SDK output from one run", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_retry",
          "x-session-affinity": "retry-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Retry dropped stream" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Partial after retry" }, finish_reason: "stop" }]
    });
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
  });

  it("retries schema-invalid SDK tool calls even when no local tool was required", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_invalid_retry",
          "x-session-affinity": "invalid-retry-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Retry invalid mapped tool" }],
          tools: [
            {
              type: "function",
              function: {
                name: "mcp__github__create_issue",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    title: { type: "string" },
                    body: { type: "string" }
                  },
                  required: ["title"]
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Partial after retry" }, finish_reason: "stop" }]
    });
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk", "POST /test-local-sdk"]);
    expect(String(sdkRequests[1].body)).toContain("Mapping failure detail");
    expect(String(sdkRequests[1].body)).toContain("Required client arguments");
    expect(String(sdkRequests[1].body)).toContain("title:string");
  });

  it("can route OpenCode SDK runs through a standard streaming bridge", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_bridge",
          "x-session-affinity": "bridge-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }],
          tools: [
            {
              type: "function",
              function: {
                name: "probe_write_file",
                description: "Writes a file through the harness MCP server.",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    file_path: { type: "string" },
                    contents: { type: "string" }
                  },
                  required: ["file_path", "contents"]
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Hello from SDK" }, finish_reason: "stop" }]
    });
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /sdk"]);
    expect(sdkRequests[0].headers.get("content-type")).toContain("application/json");
    expect(sdkRequests[0].body).toMatchObject({
      apiKey: "cursor_direct_key_bridge",
      model: "composer-2.5"
    });
    expect((sdkRequests[0].body as { tools?: unknown[] }).tools).toEqual([
      {
        name: "probe_write_file",
        description: "Writes a file through the harness MCP server.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ]);
    expect(String((sdkRequests[0].body as { prompt?: string }).prompt || "")).toContain("SDK-compatible OpenCode harness");
  });

  it("times out stalled standard SDK bridge requests", async () => {
    const db = new FakeD1();
    const base = fakeDeps();
    const env = {
      ...makeEnv(db),
      CURSOR_SDK_BRIDGE_URL: "https://bridge-timeout.test/sdk",
      CURSOR_SDK_BRIDGE_TIMEOUT_MS: "5"
    };
    const deps: Deps = {
      ...base.deps,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "bridge-timeout.test" && url.pathname === "/sdk") {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return base.deps.fetch(input, init);
      }
    };

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_bridge_timeout",
          "x-session-affinity": "bridge-timeout-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "cursor_sdk_bridge_timeout"
      }
    });
  });

  it("prefers the shared container bridge when the Durable Object binding exists", async () => {
    const db = new FakeD1();
    const bridgeRequests: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = [];
    const env = {
      ...makeEnv(db),
      CURSOR_SDK_BRIDGE_TOKEN: "bridge-token",
      CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk",
      CURSOR_SDK_BRIDGE_CONTAINER: fakeBridgeNamespace(async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        bridgeRequests.push({ path: url.pathname, headers, body });
        return localSdkBridgeJsonResponse(sdkRunKind(typeof body.prompt === "string" ? body.prompt : ""));
      })
    };
    const { deps, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_container_bridge",
          "x-session-affinity": "container-bridge-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [
            { role: "system", content: "Environment:\n  Working directory: /tmp/project" },
            { role: "user", content: "Say hello" }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Hello from SDK" }, finish_reason: "stop" }]
    });
    expect(sdkRequests).toHaveLength(0);
    expect(bridgeRequests).toHaveLength(1);
    expect(bridgeRequests[0].path).toBe("/sdk");
    expect(bridgeRequests[0].headers.get("authorization")).toBe("Bearer bridge-token");
    expect(bridgeRequests[0].body.apiKey).toBe("cursor_direct_key_container_bridge");
    expect(bridgeRequests[0].body.model).toBe("composer-2.5");
    expect(bridgeRequests[0].body.workingDirectory).toBe("/tmp/project");
  });

  it("persists OpenCode SDK sessions in D1 across isolate cache resets", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const firstDeps = fakeDeps();

    const first = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_persisted",
          "x-session-affinity": "persisted-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      firstDeps.deps
    );
    expect(first.status).toBe(200);
    await first.json();
    expect(db.sdkSessions.size).toBe(1);

    resetCursorSdkSessionCacheForTest();
    const secondDeps = fakeDeps();
    const second = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_persisted",
          "x-session-affinity": "persisted-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello again" }]
        })
      }),
      env,
      fakeCtx(),
      secondDeps.deps
    );

    expect(second.status).toBe(200);
    await second.json();
    expect(secondDeps.sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
    const persistedAgent = [...db.sdkSessions.values()][0]?.agent_id;
    expect(String(secondDeps.sdkRequests[0].body)).toContain(persistedAgent);
  });

  it("feeds OpenCode tool results back to the SDK run as SDK-shaped tool output", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_tool_result",
          "x-session-affinity": "tool-result-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [
            { role: "user", content: "Run tests" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_shell_1",
                  type: "function",
                  function: { name: "bash", arguments: "{\"command\":\"npm test\"}" }
                }
              ]
            },
            {
              role: "tool",
              tool_call_id: "call_shell_1",
              name: "bash",
              content: "{\"exitCode\":0,\"stdout\":\"tests passed\",\"stderr\":\"\",\"executionTime\":123}"
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Tool result incorporated" }, finish_reason: "stop" }]
    });
    const prompt = String(sdkRequests[0].body);
    expect(prompt).toContain("LOCAL OPENCODE TOOL RESULT");
    expect(prompt).toContain("\"name\":\"shell\"");
    expect(prompt).toContain("\"status\":\"completed\"");
    expect(prompt).toContain("\"stdout\":\"tests passed\"");
  });

  it("maps SDK shell calls to OpenCode bash schema including required defaults", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_shell",
          "x-session-affinity": "shell-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Run shell command" }],
          tools: [
            {
              type: "function",
              function: {
                name: "bash",
                parameters: {
                  type: "object",
                  properties: {
                    command: { type: "string" },
                    workdir: { type: "string" },
                    description: { type: "string" }
                  },
                  required: ["command", "description"]
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }> };
    const args = JSON.parse(body.choices[0].message.tool_calls[0].function.arguments) as Record<string, unknown>;
    expect(args).toEqual({
      command: "npm test",
      description: "Runs npm test"
    });
  });

  it("does not return completed SDK tool-result updates as fresh OpenCode tool calls", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_completed_tool",
          "x-session-affinity": "completed-tool"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Completed SDK tool result" }],
          tools: [
            {
              type: "function",
              function: {
                name: "read",
                parameters: {
                  type: "object",
                  properties: { filePath: { type: "string" } }
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string; tool_calls?: unknown[] }; finish_reason: string }> };
    expect(body.choices[0].message.content).toBe("Done after cloud result");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
  });

  it("labels the OpenCode model without changing the standard model list", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const standard = await handleRequest(
      new Request("https://composer.test/v1/models", {
        headers: { Authorization: "Bearer cursor_direct_key" }
      }),
      env,
      fakeCtx(),
      deps
    );
    const opencodeLegacy = await handleRequest(
      new Request("https://composer.test/opencode/v1/models", {
        headers: { Authorization: "Bearer cursor_direct_key" }
      }),
      env,
      fakeCtx(),
      deps
    );
    const opencodeSdk = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/models", {
        headers: { Authorization: "Bearer cursor_direct_key" }
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(standard.status).toBe(200);
    expect(opencodeLegacy.status).toBe(200);
    expect(opencodeSdk.status).toBe(200);
    const standardBody = (await standard.json()) as { data: Array<{ id: string; name: string; cost?: { input: number; output: number } }> };
    const opencodeLegacyBody = (await opencodeLegacy.json()) as { data: Array<{ id: string; name: string; cost?: { input: number; output: number } }> };
    const opencodeSdkBody = (await opencodeSdk.json()) as { data: Array<{ id: string; name: string; cost?: { input: number; output: number } }> };
    expect(standardBody.data.find((model) => model.id === "composer-2.5")?.name).toBe("Cursor Composer 2.5");
    expect(standardBody.data.map((model) => model.id)).not.toContain("composer-2.5-sdk");
    expect(opencodeLegacyBody.data.find((model) => model.id === "composer-2.5")?.name).toBe("Composer 2.5");
    expect(opencodeLegacyBody.data.map((model) => model.id)).not.toContain("composer-2.5-sdk");
    expect(opencodeSdkBody.data.find((model) => model.id === "composer-2.5")?.name).toBe("Composer 2.5");
    expect(opencodeSdkBody.data.find((model) => model.id === "composer-2.5-sdk")?.name).toBe("Composer 2.5 SDK Harness");
    expect(opencodeSdkBody.data.find((model) => model.id === "composer-2.5")?.cost).toEqual({ input: 0.5, output: 2.5 });
  });

  it("streams SSE response events in direct mode for /v1/responses", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({ model: "composer-2.5", stream: true, input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain("event: response.completed");
    expect(body).toContain("Hello from Composer");
    expect(db.requestLogs.size).toBe(0);
  });

  it("returns a buffered JSON response for /v1/responses when stream is absent", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      object: "response",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello from Composer" }] }]
    });
  });

  it("uses the SDK bridge for standard Responses when configured", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_responses_sdk",
          "x-session-affinity": "responses-sdk-session"
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: "response",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello from SDK" }] }]
    });
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /sdk"]);
    expect(sdkRequests[0].body).toMatchObject({
      apiKey: "cursor_direct_key_responses_sdk",
      model: "composer-2.5"
    });
  });

  it("uses the SDK bridge for standard Chat Completions when configured", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_chat_sdk"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Hello from SDK" }, finish_reason: "stop" }]
    });
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /sdk"]);
    expect(sdkRequests[0].body).toMatchObject({
      apiKey: "cursor_direct_key_chat_sdk",
      model: "composer-2.5"
    });
  });

  it("reuses the SDK session for standard Responses continuations", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, sdkRequests } = fakeDeps();

    const first = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_response_session"
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const firstBody = (await first.json()) as { id: string };

    const second = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_response_session"
        },
        body: JSON.stringify({ model: "composer-2.5", previous_response_id: firstBody.id, input: "Say hello again" })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(second.status).toBe(200);
    await second.json();
    expect(sdkRequests).toHaveLength(2);
    expect((sdkRequests[1].body as { sessionKey?: string }).sessionKey).toBe((sdkRequests[0].body as { sessionKey?: string }).sessionKey);
  });

  it("stores Responses for retrieval and input item listing", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const created = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const createdBody = (await created.json()) as { id: string };

    const retrieved = await handleRequest(
      new Request(`https://composer.test/v1/responses/${createdBody.id}`, {
        headers: { Authorization: "Bearer cursor_direct_key" }
      }),
      env,
      fakeCtx(),
      deps
    );
    await expect(retrieved.json()).resolves.toMatchObject({
      id: createdBody.id,
      object: "response",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello from Composer" }] }]
    });

    const inputItems = await handleRequest(
      new Request(`https://composer.test/v1/responses/${createdBody.id}/input_items`, {
        headers: { Authorization: "Bearer cursor_direct_key" }
      }),
      env,
      fakeCtx(),
      deps
    );
    await expect(inputItems.json()).resolves.toMatchObject({
      object: "list",
      data: [{ id: "item_0", type: "message", role: "user" }],
      has_more: false
    });
  });

  it("continues Responses with previous_response_id context", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestBodies } = fakeDeps();

    const first = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const firstBody = (await first.json()) as { id: string };

    const second = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({ model: "composer-2.5", previous_response_id: firstBody.id, input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const secondBody = (await second.json()) as { previous_response_id: string };

    expect(second.status).toBe(200);
    expect(secondBody.previous_response_id).toBe(firstBody.id);
    expect(chatRequestBodies[1]).toContain("USER: Say hello");
    expect(chatRequestBodies[1]).toContain("ASSISTANT: Hello from Composer");
  });

  it("continues store false Responses without making them retrievable", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const first = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({ model: "composer-2.5", store: false, input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const firstBody = (await first.json()) as { id: string };

    const retrieved = await handleRequest(
      new Request(`https://composer.test/v1/responses/${firstBody.id}`, {
        headers: { Authorization: "Bearer cursor_direct_key" }
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(retrieved.status).toBe(404);

    const second = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({ model: "composer-2.5", previous_response_id: firstBody.id, input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const secondBody = (await second.json()) as { previous_response_id: string };

    expect(second.status).toBe(200);
    expect(secondBody.previous_response_id).toBe(firstBody.id);
  });

  it("rejects missing or deleted previous Responses", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const missing = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({ model: "composer-2.5", previous_response_id: "resp_missing", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(missing.status).toBe(404);

    const created = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const createdBody = (await created.json()) as { id: string };

    const deleted = await handleRequest(
      new Request(`https://composer.test/v1/responses/${createdBody.id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer cursor_direct_key" }
      }),
      env,
      fakeCtx(),
      deps
    );
    await expect(deleted.json()).resolves.toMatchObject({ id: createdBody.id, deleted: true });

    const afterDelete = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({ model: "composer-2.5", previous_response_id: createdBody.id, input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(afterDelete.status).toBe(404);
  });

  it("returns Responses function calls when tools are provided", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          input: "Schema transform",
          tools: [
            {
              type: "function",
              name: "glob",
              parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; output: Array<Record<string, unknown>> };
    expect(body.object).toBe("response");
    expect(body.output.find((item) => item.type === "function_call")).toMatchObject({
      type: "function_call",
      name: "glob",
      arguments: "{\"pattern\":\"**/*.ts\"}"
    });
  });

  it("uses the SDK bridge for standard Chat Completions when tools are provided", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key_chat_sdk_tools"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }],
          tools: [
            {
              type: "function",
              function: {
                name: "glob",
                parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Hello from SDK" }, finish_reason: "stop" }]
    });
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /sdk"]);
    expect((sdkRequests[0].body as { tools?: unknown[] }).tools).toEqual([
      {
        name: "glob",
        parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
      }
    ]);
  });

  it("streams Responses function_call events when tools are provided", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          input: "Schema transform",
          tools: [
            {
              type: "function",
              name: "glob",
              parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("event: response.function_call_arguments.delta");
    expect(body).toContain("event: response.output_item.done");
    expect(body).toContain("\"name\":\"glob\"");
    expect(body).toContain("{\\\"pattern\\\":\\\"**/*.ts\\\"}");
  });

  it("streams SSE chat chunks in legacy cmp_ proxy mode and still writes a request log", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const signup = await handleRequest(
      new Request("https://composer.test/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cursorApiKey: "cursor_key" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const signupBody = (await signup.json()) as { apiKey: string; endpoints: { chatCompletions: string } };

    const response = await handleRequest(
      new Request(signupBody.endpoints.chatCompletions, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${signupBody.apiKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"content":"Hello from Composer"');
    expect(body).toContain("data: [DONE]");

    // Proxy mode still records a request log; streaming completes it asynchronously.
    expect(db.requestLogs.size).toBe(1);
  });

  it("streams Cursor errors as SSE errors instead of assistant text", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          messages: [{ role: "user", content: "Trigger Cursor error" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("event: error");
    expect(body).toContain("Too many computers used within the last 24 hours");
    expect(body).not.toContain("[composer-api error]");
  });

  it("streams Responses failures as schema-valid error events", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cursor_direct_key"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          input: "Trigger Cursor error"
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("event: error");
    expect(body).toContain('"type":"error"');
    expect(body).toContain('"sequence_number":0');
    expect(body).toContain("Too many computers used within the last 24 hours");
  });

  it("intersects gateway models, retries billing failures, and disables only that key model", async () => {
    resetModelRouterStateForTest();
    const db = new FakeD1();
    const env = makeEnv(db);
    const base = fakeDeps();
    const baseFetch = base.deps.fetch;
    const chatTokens: string[] = [];
    base.deps.fetch = async (input, init) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get("authorization") || "";
      if (url.pathname === "/v1/models") {
        const extra = auth.includes("cursor_route_a") ? "gpt-5.3-codex" : "claude-4.6-sonnet";
        return Response.json({ items: [
          { id: "composer-2.5", displayName: "Composer 2.5", aliases: ["default"] },
          { id: extra, displayName: extra, aliases: [] }
        ] });
      }
      if (url.pathname === "/auth/exchange_user_api_key") {
        return Response.json({ accessToken: `token:${auth.replace(/^Bearer /, "")}` });
      }
      if (url.pathname === "/test-cursor-chat") {
        chatTokens.push(auth);
        if (auth === "Bearer token:cursor_route_a") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(connectFrame(cursorError("Usage unavailable", "Spending limit reached for this model"), 2));
                controller.close();
              }
            }),
            { headers: { "content-type": "application/connect+proto" } }
          );
        }
      }
      return baseFetch(input, init);
    };

    const signup = await handleRequest(new Request("https://composer.test/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursorApiKey: "cursor_route_a" })
    }), env, fakeCtx(), base.deps);
    const gateway = (await signup.json()) as { apiKey: string };
    const added = await handleRequest(new Request("https://composer.test/api/credentials", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gateway.apiKey}` },
      body: JSON.stringify({ cursorApiKey: "cursor_route_b", label: "backup" })
    }), env, fakeCtx(), base.deps);
    expect(added.status).toBe(201);

    const models = await handleRequest(new Request("https://composer.test/v1/models", {
      headers: { authorization: `Bearer ${gateway.apiKey}` }
    }), env, fakeCtx(), base.deps);
    const modelBody = (await models.json()) as { data: Array<{ id: string }> };
    expect(modelBody.data.map((model) => model.id)).toEqual(["default", "composer-2.5"]);

    const completion = await handleRequest(new Request("https://composer.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gateway.apiKey}`,
        "x-session-affinity": "first"
      },
      body: JSON.stringify({ model: "composer-2.5", messages: [{ role: "user", content: "Say hello" }] })
    }), env, fakeCtx(), base.deps);
    expect(completion.status).toBe(200);
    await expect(completion.json()).resolves.toMatchObject({ choices: [{ message: { content: "Hello from Composer" } }] });
    expect(chatTokens).toEqual(["Bearer token:cursor_route_a", "Bearer token:cursor_route_b"]);
    expect([...db.cursorCredentialModels.values()]).toEqual([
      expect.objectContaining({ model_id: "composer-2.5", disabled_reason: expect.stringContaining("Spending limit") })
    ]);

    chatTokens.length = 0;
    const next = await handleRequest(new Request("https://composer.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gateway.apiKey}`, "x-session-affinity": "first" },
      body: JSON.stringify({ model: "composer-2.5", messages: [{ role: "user", content: "Say hello" }] })
    }), env, fakeCtx(), base.deps);
    expect(next.status).toBe(200);
    await next.json();
    expect(chatTokens).toEqual(["Bearer token:cursor_route_b"]);
  });

  it("lazily migrates a legacy account key into the multi-key credential pool", async () => {
    resetModelRouterStateForTest();
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const signup = await handleRequest(new Request("https://composer.test/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursorApiKey: "cursor_legacy_migration" })
    }), env, fakeCtx(), deps);
    const gateway = (await signup.json()) as { apiKey: string };
    db.cursorCredentials.clear();

    const response = await handleRequest(new Request("https://composer.test/v1/models", {
      headers: { authorization: `Bearer ${gateway.apiKey}` }
    }), env, fakeCtx(), deps);

    expect(response.status).toBe(200);
    expect(db.cursorCredentials.size).toBe(1);
    expect([...db.cursorCredentials.values()][0]).toMatchObject({ label: "default", status: "active" });
  });

  it("does not permanently disable a model for a recoverable Cursor failure", async () => {
    resetModelRouterStateForTest();
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const signup = await handleRequest(new Request("https://composer.test/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursorApiKey: "cursor_transient_key" })
    }), env, fakeCtx(), deps);
    const gateway = (await signup.json()) as { apiKey: string };

    const response = await handleRequest(new Request("https://composer.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gateway.apiKey}` },
      body: JSON.stringify({ model: "composer-2.5", messages: [{ role: "user", content: "Trigger Cursor error" }] })
    }), env, fakeCtx(), deps);

    expect(response.status).toBe(502);
    expect(db.cursorCredentialModels.size).toBe(0);
  });

  it("persists billing model disablement when the error arrives inside a stream", async () => {
    resetModelRouterStateForTest();
    const db = new FakeD1();
    const env = makeEnv(db);
    const base = fakeDeps();
    const baseFetch = base.deps.fetch;
    base.deps.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/exchange_user_api_key") return Response.json({ accessToken: "stream-billing-token" });
      if (url.pathname === "/test-cursor-chat") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(connectFrame(cursorError("Credits exhausted", "Insufficient credit for composer-2.5"), 2));
              controller.close();
            }
          }),
          { headers: { "content-type": "application/connect+proto" } }
        );
      }
      return baseFetch(input, init);
    };
    const signup = await handleRequest(new Request("https://composer.test/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursorApiKey: "cursor_stream_billing" })
    }), env, fakeCtx(), base.deps);
    const gateway = (await signup.json()) as { apiKey: string };

    const response = await handleRequest(new Request("https://composer.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gateway.apiKey}` },
      body: JSON.stringify({ model: "composer-2.5", stream: true, messages: [{ role: "user", content: "Say hello" }] })
    }), env, fakeCtx(), base.deps);
    const body = await response.text();

    expect(body).toContain("event: error");
    expect(body).toContain("Insufficient credit");
    expect([...db.cursorCredentialModels.values()]).toEqual([
      expect.objectContaining({ model_id: "composer-2.5", disabled_reason: expect.stringContaining("Insufficient credit") })
    ]);
  });

  it("keeps credential management isolated by gateway account", async () => {
    resetModelRouterStateForTest();
    const db = new FakeD1();
    const env = makeEnv(db);
    const base = fakeDeps();
    const baseFetch = base.deps.fetch;
    base.deps.fetch = async (input, init) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get("authorization") || "";
      if (url.pathname === "/v1/me") {
        const owner = auth.includes("owner_b") ? 222 : 111;
        return Response.json({ apiKeyName: "owner", userId: owner, userEmail: `${owner}@example.com`, createdAt: "2026-05-20T00:00:00.000Z" });
      }
      return baseFetch(input, init);
    };
    const signup = async (cursorApiKey: string): Promise<string> => {
      const response = await handleRequest(new Request("https://composer.test/api/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursorApiKey })
      }), env, fakeCtx(), base.deps);
      return ((await response.json()) as { apiKey: string }).apiKey;
    };
    const ownerA = await signup("owner_a_primary");
    const ownerB = await signup("owner_b_primary");
    const added = await handleRequest(new Request("https://composer.test/api/credentials", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerA}` },
      body: JSON.stringify({ cursorApiKey: "owner_a_backup", label: "backup" })
    }), env, fakeCtx(), base.deps);
    const addedBody = (await added.json()) as { id: string };

    const listA = await handleRequest(new Request("https://composer.test/api/credentials", { headers: { authorization: `Bearer ${ownerA}` } }), env, fakeCtx(), base.deps);
    const listB = await handleRequest(new Request("https://composer.test/api/credentials", { headers: { authorization: `Bearer ${ownerB}` } }), env, fakeCtx(), base.deps);
    expect(((await listA.json()) as { data: unknown[] }).data).toHaveLength(2);
    expect(((await listB.json()) as { data: unknown[] }).data).toHaveLength(1);

    const foreignDelete = await handleRequest(new Request(`https://composer.test/api/credentials/${addedBody.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ownerB}` }
    }), env, fakeCtx(), base.deps);
    expect(foreignDelete.status).toBe(404);
  });

  it("requires a bearer token for /v1/models", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const noAuth = await handleRequest(
      new Request("https://composer.test/v1/models"),
      env,
      fakeCtx(),
      deps
    );
    expect(noAuth.status).toBe(401);

    const withAuth = await handleRequest(
      new Request("https://composer.test/v1/models", {
        headers: { Authorization: "Bearer cursor_direct_key" }
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(withAuth.status).toBe(200);
    const body = (await withAuth.json()) as { object: string; data: Array<{ id: string }> };
    expect(body).toMatchObject({
      object: "list",
      data: expect.arrayContaining([
        expect.objectContaining({ id: "composer-2.5" }),
        expect.objectContaining({ id: "composer-2.5-fast" }),
        expect.objectContaining({ id: "gpt-5.3-codex" }),
        expect.objectContaining({ id: "gemini-3.1-pro" }),
        expect.objectContaining({ id: "default" })
      ])
    });
    expect(body.data.map((model) => model.id)).not.toContain("gpt-5.5");
  });

  it("rejects an unknown cmp_ token without forwarding it to Cursor", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, exchangeAuthHeaders } = fakeDeps();

    const completion = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cmp_not_a_real_key"
        },
        body: JSON.stringify({ model: "composer-2.5", messages: [{ role: "user", content: "Hi" }] })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(completion.status).toBe(401);
    // An invalid cmp_ token is never forwarded to Cursor as a Cursor key.
    expect(exchangeAuthHeaders).toHaveLength(0);
  });
});

function fakeDeps(overrides: Partial<Deps> = {}): {
  deps: Deps;
  exchangeAuthHeaders: string[];
  chatAuthHeaders: string[];
  chatRequestHeaders: Headers[];
  chatRequestBodies: string[];
  sdkRequests: Array<{ method: string; path: string; headers: Headers; body: unknown }>;
} {
  const exchangeAuthHeaders: string[] = [];
  const chatAuthHeaders: string[] = [];
  const chatRequestHeaders: Headers[] = [];
  const chatRequestBodies: string[] = [];
  const sdkRequests: Array<{ method: string; path: string; headers: Headers; body: unknown }> = [];
  let uuidCounter = 0;
  const deps: Deps = {
    now: () => new Date("2026-05-20T12:00:00.000Z"),
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get("authorization") || "";
      if (url.pathname === "/v1/me") {
        return Response.json({
          apiKeyName: "Test key",
          userId: 123,
          userEmail: "ada@example.com",
          userFirstName: "Ada",
          userLastName: "Lovelace",
          createdAt: "2026-05-20T00:00:00.000Z"
        });
      }
      if (url.pathname === "/v1/models") {
        return Response.json({ items: [
          { id: "composer-2.5", displayName: "Composer 2.5", aliases: ["default"] },
          { id: "composer-2.5-fast", displayName: "Composer 2.5 Fast", aliases: [] }
        ] });
      }
      if (url.pathname === "/auth/exchange_user_api_key" && init?.method === "POST") {
        exchangeAuthHeaders.push(auth);
        return Response.json({ accessToken: "cursor_access_token" });
      }
      if (url.pathname === "/test-local-sdk" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        const body = await decodeRequestBody(init.body);
        sdkRequests.push({ method: "POST", path: url.pathname, headers, body });
        return localSdkFakeResponse(sdkRunKind(body));
      }
      if (url.hostname === "bridge.test" && url.pathname === "/sdk" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        const body = JSON.parse(String(init.body || "{}")) as Record<string, unknown>;
        sdkRequests.push({ method: "POST", path: url.pathname, headers, body });
        return localSdkBridgeJsonResponse(sdkRunKind(typeof body.prompt === "string" ? body.prompt : ""));
      }
      if (url.pathname === "/test-cursor-chat" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        chatAuthHeaders.push(auth);
        chatRequestHeaders.push(headers);
        expect(headers.get("content-type")).toContain("application/connect+proto");
        const requestText = await decodeRequestBody(init.body);
        chatRequestBodies.push(requestText);
        if (requestText.includes("Trigger Cursor error")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(connectFrame(cursorError("Too many computers.", "Too many computers used within the last 24 hours."), 2));
                controller.close();
              }
            }),
            { headers: { "Content-Type": "application/connect+proto" } }
          );
        }
        if (requestText.includes("Schema transform")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  connectFrame(
                    chatResponseText(
                      [
                        "Checking the workspace.\n",
                        "<|tool_calls_begin|><|tool_call_begin|>\n",
                        "Glob\n",
                        "<|tool_sep|>targeting\n",
                        "/Users/example/project/**\n",
                        "<|tool_sep|>glob_pattern\n",
                        "*.ts\n",
                        "<|tool_call_end|><|tool_calls_end|>"
                      ].join("")
                    )
                  )
                );
                controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
                controller.close();
              }
            }),
            { headers: { "Content-Type": "application/connect+proto" } }
          );
        }
        if (requestText.includes("List files")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  connectFrame(
                    chatResponseText(
                      [
                        "Checking the workspace.\n",
                        "<|tool_calls_begin|><|tool_call_begin|>\n",
                        "Glob\n",
                        "<|tool_sep|>glob_pattern\n",
                        "*\n",
                        "<|tool_call_end|><|tool_calls_end|>"
                      ].join("")
                    )
                  )
                );
                controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
                controller.close();
              }
            }),
            { headers: { "Content-Type": "application/connect+proto" } }
          );
        }
        expect(requestText).toContain("Say hello");
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(connectFrame(chatResponseThinking("The answer is simple.</think>\nHello from Composer")));
              controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
              controller.close();
            }
          }),
          { headers: { "Content-Type": "application/connect+proto" } }
        );
      }
      return new Response("not found", { status: 404 });
    }
  };
  Object.assign(deps, overrides);
  return { deps, exchangeAuthHeaders, chatAuthHeaders, chatRequestHeaders, chatRequestBodies, sdkRequests };
}

function fakeBridgeNamespace(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: () => ({ fetch: handler }) as unknown as DurableObjectStub
  } as unknown as DurableObjectNamespace;
}

function cursorError(title: string, detail: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      error: {
        code: "resource_exhausted",
        message: "Error",
        details: [{ debug: { details: { title, detail } } }]
      }
    })
  );
}

async function decodeRequestBody(body: BodyInit | null | undefined): Promise<string> {
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (typeof body === "string") return body;
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
        if (chunks.length >= 1) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return new TextDecoder().decode(concatTestBytes(chunks));
  }
  return "";
}

function sdkRunKind(body: string): "completed" | "drop" | "hello" | "invalid" | "list" | "shell" | "tool-result" {
  const text = body;
  if (text.includes("Completed SDK tool result")) return "completed";
  if (text.includes("LOCAL OPENCODE TOOL RESULT:")) return "tool-result";
  if (text.includes("Retry invalid mapped tool") && text.includes("TOOL CALL RETRY")) return "drop";
  if (text.includes("Retry invalid mapped tool")) return "invalid";
  if (text.includes("Retry dropped stream")) return "drop";
  if (text.includes("Run shell command")) return "shell";
  if (text.includes("List files")) return "list";
  return "hello";
}

function localSdkFakeResponse(kind: ReturnType<typeof sdkRunKind>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (kind === "list") {
          controller.enqueue(localSdkToolCallFrame("sdk_call_1", 4, protoMessage([protoField(2, "*")])));
        } else if (kind === "invalid") {
          controller.enqueue(
            localSdkToolCallFrame(
              "sdk_call_invalid",
              15,
              protoMessage([
                protoField(1, "create_issue"),
                protoField(2, protoValueMapEntry("body", protoStringValue("Missing required title"))),
                protoField(4, "github"),
                protoField(5, "create_issue")
              ])
            )
          );
        } else if (kind === "drop") {
          controller.enqueue(localSdkTextFrame("Partial after retry"));
        } else if (kind === "shell") {
          controller.enqueue(localSdkExecFrame(1, 2, protoMessage([protoField(1, "npm test"), protoField(2, "/workspace")])));
        } else if (kind === "completed") {
          const readArgs = protoMessage([protoField(1, "README.md")]);
          const readCall = protoMessage([protoField(1, readArgs), protoField(2, protoMessage([]))]);
          controller.enqueue(localSdkToolCallCompletedFrame("sdk_call_completed", 8, readCall));
          controller.enqueue(localSdkTextFrame("Done after cloud result"));
        } else if (kind === "tool-result") {
          controller.enqueue(localSdkTextFrame("Tool result incorporated"));
        } else {
          controller.enqueue(localSdkTextFrame("Hello from SDK"));
        }
        controller.enqueue(localSdkTurnEndedFrame());
        controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
        controller.close();
      }
    }),
    { headers: { "Content-Type": "application/connect+proto" } }
  );
}

function localSdkBridgeJsonResponse(kind: ReturnType<typeof sdkRunKind>): Response {
  if (kind === "list") {
    return Response.json({ text: "", toolCalls: [{ name: "glob", arguments: { globPattern: "*" } }], agentID: "agent-test", runID: "run-test" });
  }
  if (kind === "invalid") {
    return Response.json({
      text: "",
      toolCalls: [
        {
          name: "mcp",
          arguments: {
            name: "create_issue",
            providerIdentifier: "github",
            toolName: "create_issue",
            args: { body: "Missing required title" }
          }
        }
      ],
      agentID: "agent-test",
      runID: "run-test"
    });
  }
  if (kind === "drop") {
    return Response.json({ text: "Partial after retry", toolCalls: [], agentID: "agent-test", runID: "run-test" });
  }
  if (kind === "shell") {
    return Response.json({
      text: "",
      toolCalls: [{ name: "shell", arguments: { command: "npm test", workingDirectory: "/workspace" } }],
      agentID: "agent-test",
      runID: "run-test"
    });
  }
  if (kind === "completed") {
    return Response.json({
      text: "Done after cloud result",
      toolCalls: [{ name: "read", arguments: { path: "README.md" } }],
      agentID: "agent-test",
      runID: "run-test"
    });
  }
  if (kind === "tool-result") {
    return Response.json({ text: "Tool result incorporated", toolCalls: [], agentID: "agent-test", runID: "run-test" });
  }
  return Response.json({ text: "Hello from SDK", toolCalls: [], agentID: "agent-test", runID: "run-test" });
}

function decodeBase64ForTest(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
}

function concatTestBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function sseFrame(event: string, data: unknown, id?: string): Uint8Array {
  return new TextEncoder().encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function chatResponseThinking(text: string): Uint8Array {
  return protoMessage([protoField(2, protoMessage([protoField(25, protoMessage([protoField(1, text)]))]))]);
}

function chatResponseText(text: string): Uint8Array {
  return protoMessage([protoField(2, protoMessage([protoField(1, text)]))]);
}

function localSdkTextFrame(text: string): Uint8Array {
  const textDelta = protoMessage([protoField(1, text)]);
  const interaction = protoMessage([protoField(1, textDelta)]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkTurnEndedFrame(): Uint8Array {
  const interaction = protoMessage([protoField(14, protoMessage([]))]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkToolCallFrame(callId: string, toolField: number, args: Uint8Array): Uint8Array {
  const toolPayload = protoMessage([protoField(1, args)]);
  const toolCall = protoMessage([protoField(toolField, toolPayload)]);
  const started = protoMessage([protoField(1, callId), protoField(2, toolCall)]);
  const interaction = protoMessage([protoField(2, started)]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkToolCallCompletedFrame(callId: string, toolField: number, toolCallPayload: Uint8Array): Uint8Array {
  const toolCall = protoMessage([protoField(toolField, toolCallPayload)]);
  const completed = protoMessage([protoField(1, callId), protoField(2, toolCall)]);
  const interaction = protoMessage([protoField(3, completed)]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkExecFrame(execId: number, execField: number, args: Uint8Array): Uint8Array {
  const exec = protoMessage([protoVarintField(1, execId), protoField(execField, args)]);
  return connectFrame(protoMessage([protoField(2, exec)]));
}

function connectFrame(payload: Uint8Array, flags = 0): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

function protoMessage(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function protoField(fieldNumber: number, value: string | Uint8Array): Uint8Array {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return protoMessage([varint((fieldNumber << 3) | 2), varint(data.length), data]);
}

function protoValueMapEntry(key: string, value: Uint8Array): Uint8Array {
  return protoMessage([protoField(1, key), protoField(2, value)]);
}

function protoStringValue(value: string): Uint8Array {
  return protoMessage([protoField(3, value)]);
}

function protoVarintField(fieldNumber: number, value: number): Uint8Array {
  return protoMessage([varint(fieldNumber << 3), varint(value)]);
}

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return new Uint8Array(bytes);
}
