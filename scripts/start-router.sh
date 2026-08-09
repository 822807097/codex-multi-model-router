#!/usr/bin/env bash
# start-router.sh — 启动本地路由（前台运行，便于看日志）
# 用法：bash start-router.sh
# 说明：路由进程启动时才会读取环境变量 key，因此这里从环境显式注入

set -euo pipefail

# Codex 数据目录：优先 CODEX_HOME 环境变量，否则 ~/.codex
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

# 需要注入给路由的 key 环境变量名（空格分隔，可按需增减）
KEY_NAMES="${ROUTER_ENV_KEYS:-DEEPSEEK_API_KEY BAILIAN_API_KEY}"

for k in $KEY_NAMES; do
    if [ -z "${!k:-}" ]; then
        echo "警告：环境变量 $k 未设置，对应通道会失败" >&2
    fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUTER="$SCRIPT_DIR/../codex-router.mjs"

exec node "$ROUTER"
