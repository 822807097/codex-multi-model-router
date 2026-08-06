#!/usr/bin/env bash
# status-router.sh — 查看路由状态（PID + 健康检查）
# 用法：bash status-router.sh

set -euo pipefail

PORT="${ROUTER_PORT:-15730}"

PID=$(lsof -ti :$PORT -sTCP:LISTEN 2>/dev/null || true)

if [ -n "$PID" ]; then
    echo "codex-router 运行中 PID=$PID"
else
    echo "codex-router 未在运行"
fi

if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "healthz: ok"
else
    echo "healthz: 无响应"
fi
