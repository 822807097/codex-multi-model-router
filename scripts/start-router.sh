#!/usr/bin/env bash
# start-router.sh — 启动本地路由（前台运行，便于看日志）
# 用法：bash start-router.sh
# 说明：路由进程启动时才会读取环境变量 key，因此这里从环境显式注入

set -euo pipefail

# Node 版本预检：路由使用 node:sqlite（内置模块，Node 23.4 起默认可用）。
# 旧版 Node 会在 import 阶段直接崩（ERR_UNKNOWN_BUILTIN_MODULE），提前拦截给出指引。
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 23 ]; then
    echo "错误：当前 Node.js 版本 $(node -v 2>/dev/null || echo '未知') 过低。" >&2
    echo "       本路由依赖 node:sqlite，需要 Node.js v23.4 或更高版本（推荐 LTS v24）。" >&2
    echo "       请到 https://nodejs.org 安装最新 LTS 后重试：node -v 应显示 v23.4+。" >&2
    exit 1
fi

# Codex 数据目录：优先 CODEX_HOME 环境变量，否则 ~/.codex
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 脚本既可能在 router/ 子目录（../codex-router.mjs）也可能与主程序同目录
if [ -f "$SCRIPT_DIR/../codex-router.mjs" ]; then
    ROUTER_PARENT="$SCRIPT_DIR/.."
else
    ROUTER_PARENT="$SCRIPT_DIR"
fi
ROUTER="$ROUTER_PARENT/codex-router.mjs"
CONFIG_PATH="${ROUTER_CONFIG_PATH:-$ROUTER_PARENT/config.json}"
# 核心请求与上下文维护分别写入 JSONL；两类归档都只保留最近 72 小时。
export ROUTER_LOG="${ROUTER_LOG:-$ROUTER_PARENT/router.log}"

# 从实际配置提取 targets 与视觉中继的 envKey，避免脚本和配置的变量名长期漂移。
CONFIG_KEY_NAMES="$(node -e '
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const names = [...(cfg.targets || []), cfg.visionRelay]
  .map((item) => item?.envKey)
  .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name || ""));
process.stdout.write([...new Set(names)].join(" "));
' "$CONFIG_PATH")"
EXTRA_KEY_NAMES="${ROUTER_ENV_KEYS:-}"
KEY_NAMES="$CONFIG_KEY_NAMES ${EXTRA_KEY_NAMES//,/ }"

for k in $KEY_NAMES; do
    if [ -z "${!k:-}" ]; then
        echo "警告：环境变量 $k 未设置，对应通道会失败" >&2
    fi
done

exec node "$ROUTER"
