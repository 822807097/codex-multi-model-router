#!/usr/bin/env bash
# stop-router.sh — 优雅停止路由（不打断在跑任务）
# 发送 SIGTERM（新版入口走 gracefulExit 排空），等待进程自然退出；
# 绝不 kill -9 强杀。路由内部有 10 分钟排空安全阀兜底。
# 用法：bash stop-router.sh

set -euo pipefail

PORT="${ROUTER_PORT:-15730}"
WAIT_SECONDS="${ROUTER_STOP_WAIT_SECONDS:-600}"

# 查找监听端口的进程
PID=$(lsof -ti :$PORT -sTCP:LISTEN 2>/dev/null || true)

if [ -z "$PID" ]; then
    echo "codex-router 未在运行"
    exit 0
fi

echo "停止 codex-router (PID: $PID)，优雅排空在跑任务..."
kill -TERM "$PID" 2>/dev/null || true

# 等待排空退出（gracefulExit 最长 10 分钟安全阀）
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while kill -0 "$PID" 2>/dev/null; do
    if [ "$(date +%s)" -gt "$deadline" ]; then
        echo "等待排空超时（${WAIT_SECONDS} 秒），进程仍在运行；请稍后重试" >&2
        exit 1
    fi
    sleep 1
done

echo "codex-router 已优雅退出"
