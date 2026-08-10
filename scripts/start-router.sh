#!/usr/bin/env bash
# start-router.sh — 启动本地路由（前台运行，便于看日志）
# 用法：bash start-router.sh
# 说明：路由进程启动时才会读取环境变量 key，因此这里从环境显式注入

set -euo pipefail

# Codex 数据目录：优先 CODEX_HOME 环境变量，否则 ~/.codex
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUTER="$SCRIPT_DIR/../codex-router.mjs"
CONFIG_PATH="${ROUTER_CONFIG_PATH:-$SCRIPT_DIR/../config.json}"

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
