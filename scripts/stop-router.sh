#!/usr/bin/env bash
# stop-router.sh — 停止路由（杀掉监听 ROUTER_PORT 的进程）
# 用法：bash stop-router.sh

set -euo pipefail

PORT="${ROUTER_PORT:-15730}"

# 查找监听该端口的进程
PID=$(lsof -ti :$PORT -sTCP:LISTEN 2>/dev/null || true)

if [ -z "$PID" ]; then
    echo "codex-router 未在运行"
    exit 0
fi

echo "停止 codex-router (PID: $PID)"
kill "$PID" 2>/dev/null || true
sleep 1

# 强制杀死
if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null || true
fi

echo "codex-router 已停止"
