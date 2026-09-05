#!/usr/bin/env node
/**
 * cursor2api local server CLI — cross-platform replacement for *.ps1 helpers.
 *
 *   node server.mjs start [--port 6718]
 *   node server.mjs stop
 *   node server.mjs status
 *   node server.mjs models [--json] [--port 6718]
 *   node server.mjs claude [--port 6718] [-- ...claude args]
 *   node server.mjs codex [--port 6718] [--profile NAME] [-- ...codex args]
 */

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PORT = 6718;
const RUNTIME_DIR = path.join(os.homedir(), ".cursor2api");
const STATE_PATH = path.join(RUNTIME_DIR, "state.json");
const CONFIG_PATH = path.join(RUNTIME_DIR, "config.json");
const CLIENT_INDEX = path.join(repoRoot, "dist", "client", "index.html");
const BRIDGE_SCRIPT = path.join(repoRoot, "scripts", "cursor-sdk-local-agent-bridge.mjs");
const SIDECAR_SCRIPT = path.join(repoRoot, "sidecar", "server.ts");

function usage() {
  console.log(`cursor2api local server

Usage:
  node server.mjs start [--port PORT] [--host HOST]
  node server.mjs stop
  node server.mjs status
  node server.mjs models [--json] [--port PORT]
  node server.mjs claude [--port PORT] [-- ...args]
  node server.mjs codex [--port PORT] [--profile NAME] [-- ...args]

Environment:
  CURSOR_API_KEY    One Cursor Dashboard API key (crsr_…)
  CURSOR_API_KEYS   Multiple Cursor keys (comma/newline, label=key, or JSON array)
  ADMIN_PASSWORD    Optional administrator password for the control console
  CURSOR2API_API_KEY Client sk-... key created in the control console

Defaults:
  port=${DEFAULT_PORT}  host=127.0.0.1  runtime=${RUNTIME_DIR}
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const positional = [];
  const flags = {};

  while (args.length > 0) {
    const token = args[0];
    if (token === "--") {
      args.shift();
      positional.push(...args);
      break;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      if (key.includes("=")) {
        const [name, value] = key.split("=", 2);
        flags[name] = value;
        args.shift();
        continue;
      }
      const next = args[1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        args.shift();
        args.shift();
        continue;
      }
      flags[key] = true;
      args.shift();
      continue;
    }
    positional.push(token);
    args.shift();
  }

  return { positional, flags };
}

function requireCommand(flags) {
  return Number.parseInt(String(flags.port ?? DEFAULT_PORT), 10);
}

function requireHost(flags) {
  return String(flags.host ?? "127.0.0.1").trim() || "127.0.0.1";
}

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function clearState() {
  if (existsSync(STATE_PATH)) rmSync(STATE_PATH, { force: true });
}

function readLocalConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function ensureLocalConfig() {
  const config = readLocalConfig();
  let changed = false;
  if (!config.encryptionKey) {
    config.encryptionKey = cryptoRandomHex(32);
    changed = true;
  }
  if (changed) {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  return config;
}

function ensureClientAssets() {
  const windows = process.platform === "win32";
  const command = windows ? (process.env.ComSpec || "cmd.exe") : "npm";
  const args = windows ? ["/d", "/s", "/c", "npm run build:client"] : ["run", "build:client"];
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
    windowsHide: true
  });
  if (result.status !== 0 || !existsSync(CLIENT_INDEX)) {
    throw new Error("Could not build the local dashboard assets.");
  }
}

function commandExists(name) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [name], { stdio: "ignore" });
  return result.status === 0;
}

function resolveExecutable(name) {
  if (!commandExists(name)) {
    throw new Error(`Required executable not found on PATH: ${name}`);
  }
  // Windows：优先解析为裸 .exe。PATH 上的 bun 常是 .cmd/.ps1 wrapper，
  // node spawn（不带 shell）无法直接执行脚本文件，但 .exe 可以直接跑。
  if (process.platform === "win32") {
    const probe = spawnSync('where', [`${'$'}{name}.exe`], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim()) return `${'$'}{name}.exe`;
    // Windows 上 bun 可能是无 .exe 扩展名的可执行文件：CreateProcess 无法按裸名解析，
    // 用 where 拿到的全路径显式 spawn。
    const probePlain = spawnSync('where', [name], { encoding: 'utf8' });
    if (probePlain.status === 0 && probePlain.stdout.trim()) {
      const fullPathRaw = probePlain.stdout.trim().split(String.fromCharCode(10))[0];
      const fullPath = fullPathRaw.replace(/\r+$/g, "");
      // PATH 上的 bun 常是 shim 脚本（无 .exe，CreateProcess 无法执行）；
      // 真身通常在 npm 全局布局 shim 旁的 node_modules/<name>/bin/<name>.exe。
      const dir = path.dirname(fullPath);
      const candidates = [
        path.join(dir, 'node_modules', name, 'bin', name + '.exe'),
        path.join(dir, name + '.exe'),
        path.join(dir, '..', 'node_modules', name, 'bin', name + '.exe'),
      ];
      for (const candidate of candidates) {
        try { if (existsSync(candidate)) return candidate; } catch { /* 容错 */ }
      }
      if (fullPath) return fullPath;
    }
  }
  return name;
}

function assertDependencies() {
  if (!existsSync(path.join(repoRoot, "node_modules", "@cursor", "sdk"))) {
    throw new Error(`Dependencies missing. Run 'npm ci' in ${repoRoot} first.`);
  }
  resolveExecutable("node");
  resolveExecutable("bun");
}

function getFreePort(startPort, host = "127.0.0.1") {
  const end = Math.min(startPort + 99, 65535);
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > end) {
        reject(new Error(`No free port found from ${startPort}.`));
        return;
      }
      const server = createServer();
      server.unref();
      server.on("error", () => tryPort(port + 1));
      server.listen({ port, host }, () => {
        const chosen = server.address()?.port;
        server.close(() => resolve(chosen ?? port));
      });
    };
    tryPort(startPort);
  });
}

async function fetchHealth(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(url, { pid, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pid && !isProcessAlive(pid)) {
      throw new Error(`Process ${pid} exited before ${url} became healthy.`);
    }
    const health = await fetchHealth(url);
    if (health) return health;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid) {
  if (!pid || !isProcessAlive(pid)) return false;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return false;
    }
  }
  return true;
}

function spawnLogged(name, command, args, env, logPaths, detached) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  // 临时诊断：spawn 错误直接打出来（ENOENT/EACCES 等），定位后移除
  const logFds = detached
    ? [openSync(logPaths.stdout, "w"), openSync(logPaths.stderr, "w")]
    : [];
  let child;
  try {
    child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      detached: Boolean(detached),
      stdio: detached ? ["ignore", ...logFds] : "inherit",
      windowsHide: true
    });
  } finally {
    for (const fd of logFds) closeSync(fd);
  }
  child.on("error", (spawnError) => {
    console.error(`[${name}] spawn error:`, spawnError?.code || spawnError?.message);
  });
  if (detached) child.unref();
  if (!child.pid) {
    throw new Error(`Failed to start ${name}.`);
  }
  return child;
}

async function cmdStart(flags) {
  assertDependencies();
  ensureClientAssets();
  const localConfig = ensureLocalConfig();
  const port = requireCommand(flags);
  const host = requireHost(flags);
  // Local services stay attached to the invoking terminal. This keeps every
  // startup entry point consistent and lets Ctrl+C shut down both children.
  const foreground = true;

  const existing = await fetchHealth(`http://${host}:${port}/health`);
  if (existing?.service === "api-for-cursor") {
    console.log(JSON.stringify({
      status: "already_running",
      baseUrl: existing.baseUrl ?? `http://${host}:${port}/v1`,
      anthropicBaseUrl: `http://${host}:${port}`,
      dashboardUrl: `http://${host}:${port}/dashboard`
    }));
    return;
  }

  if (existing) {
    throw new Error(`Port ${port} is already in use by another service.`);
  }

  const bridgePort = await getFreePort(port + 1, host);
  const bridgeToken = cryptoRandomHex(16);
  const bridgeEnv = {
    CURSOR_SDK_BRIDGE_HOST: host,
    CURSOR_SDK_BRIDGE_PORT: String(bridgePort),
    CURSOR_SDK_BRIDGE_TOKEN: bridgeToken,
    CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS: "180000"
  };

  const bridge = spawnLogged(
    "bridge",
    "node",
    [BRIDGE_SCRIPT],
    bridgeEnv,
    {
      stdout: path.join(RUNTIME_DIR, "bridge.stdout.log"),
      stderr: path.join(RUNTIME_DIR, "bridge.stderr.log")
    },
    !foreground
  );

  await waitForHealth(`http://${host}:${bridgePort}/health`, {
    pid: bridge.pid,
    timeoutMs: 30_000
  });

  const sidecarEnv = {
    HOST: host,
    PORT: String(port),
    CURSOR_SDK_BRIDGE_URL: `http://${host}:${bridgePort}/sdk`,
    CURSOR_SDK_BRIDGE_TOKEN: bridgeToken,
    CURSOR_ROUTER_STATE_PATH: path.join(RUNTIME_DIR, "router-state.json"),
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || localConfig.encryptionKey,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",
    LOCAL_AUTH_STATE_PATH: path.join(RUNTIME_DIR, "auth-state.json"),
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",
    STATIC_DIR: path.join(repoRoot, "dist", "client")
  };

  // Windows 上 PATH 里的 bun 常是 shim（无 .exe），必须用 resolveExecutable 的
  // 真实可执行文件路径（含 npm 全局布局 node_modules/<name>/bin/<name>.exe 探测）。
  const bunExecutable = resolveExecutable("bun");
  const sidecar = spawnLogged(
    "sidecar",
    bunExecutable,
    ["run", SIDECAR_SCRIPT],
    sidecarEnv,
    {
      stdout: path.join(RUNTIME_DIR, "server.stdout.log"),
      stderr: path.join(RUNTIME_DIR, "server.stderr.log")
    },
    !foreground
  );

  const health = await waitForHealth(`http://${host}:${port}/health`, {
    pid: sidecar.pid,
    timeoutMs: 30_000
  });

  writeState({
    port,
    host,
    bridgePort,
    bridgePid: bridge.pid,
    serverPid: sidecar.pid,
    startedAt: new Date().toISOString()
  });

  const summary = {
    status: "started",
    baseUrl: health.baseUrl ?? `http://${host}:${port}/v1`,
    anthropicBaseUrl: `http://${host}:${port}`,
    dashboardUrl: `http://${host}:${port}/dashboard`,
    serverPid: sidecar.pid,
    bridgePid: bridge.pid
  };

  if (foreground) {
    console.log(JSON.stringify(summary, null, 2));
    console.error("\nPress Ctrl+C to stop both processes.\n");
    const shutdown = () => {
      killProcess(sidecar.pid);
      killProcess(bridge.pid);
      clearState();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {});
    return;
  }

  console.log(JSON.stringify(summary));
}

function cmdStop() {
  const state = readState();
  if (!state) {
    console.log(JSON.stringify({ status: "not_running" }));
    return;
  }

  const stopped = [];
  for (const pid of [state.serverPid, state.bridgePid]) {
    if (killProcess(pid)) stopped.push(pid);
  }
  clearState();
  console.log(JSON.stringify({ status: "stopped", processIds: stopped }));
}

async function cmdStatus(flags) {
  const port = requireCommand(flags);
  const host = requireHost(flags);
  const state = readState();
  const health = await fetchHealth(`http://${host}:${port}/health`);

  console.log(JSON.stringify({
    state,
    health,
    running: health?.service === "api-for-cursor"
  }, null, 2));
}

function requireApiKey() {
  const key = (process.env.CURSOR2API_API_KEY || "").trim();
  if (!key) throw new Error("Set CURSOR2API_API_KEY to a client sk-... key created in the dashboard.");
  return key;
}

async function cmdModels(flags) {
  const port = requireCommand(flags);
  const host = requireHost(flags);
  const apiKey = requireApiKey();
  const response = await fetch(`http://${host}:${port}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) {
    throw new Error(`GET /v1/models failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const rows = (body.data ?? []).map((model) => {
    const parameters = (model.cursor_parameters ?? [])
      .map((item) => `${item.id}=[${(item.values?.value ?? []).join("|")}]`)
      .join("; ");
    const selected = (model.cursor_params ?? [])
      .map((item) => `${item.id}=${item.value}`)
      .join(", ");
    return { id: model.id, name: model.name, parameters, selected };
  });

  if (rows.length === 0) {
    console.log("No models returned.");
    return;
  }

  const widths = {
    id: Math.max(2, ...rows.map((row) => row.id.length)),
    name: Math.max(4, ...rows.map((row) => row.name.length))
  };
  console.log(
    `${"ID".padEnd(widths.id)}  ${"NAME".padEnd(widths.name)}  PARAMETERS`
  );
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(widths.id)}  ${row.name.padEnd(widths.name)}  ${row.parameters}${row.selected ? `  (${row.selected})` : ""}`
    );
  }
}

function spawnClient(command, args, env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32"
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function cmdClaude(flags, rest) {
  const apiKey = requireApiKey();
  const port = requireCommand(flags);
  const host = requireHost(flags);
  spawnClient("claude", rest, {
    ANTHROPIC_BASE_URL: `http://${host}:${port}`,
    ANTHROPIC_API_KEY: apiKey
  });
}

function cmdCodex(flags, rest) {
  const apiKey = requireApiKey();
  const profile = String(flags.profile ?? "cursor6718");
  spawnClient("codex", ["-p", profile, ...rest], {
    CODEX_API_KEY: apiKey
  });
}

function cryptoRandomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === "help" || flags.help) {
    usage();
    process.exit(command ? 0 : 1);
  }

  const rest = positional.slice(1);

  switch (command) {
    case "start":
      await cmdStart(flags);
      break;
    case "stop":
      cmdStop();
      break;
    case "status":
      await cmdStatus(flags);
      break;
    case "models":
      await cmdModels(flags);
      break;
    case "claude":
      cmdClaude(flags, rest);
      break;
    case "codex":
      cmdCodex(flags, rest);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
