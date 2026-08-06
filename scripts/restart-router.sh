#!/usr/bin/env bash
# restart-router.sh — 重启路由（改完配置/key 后执行）
# 用法：bash restart-router.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${ROUTER_PORT:-15730}"

echo "停止旧路由..."
bash "$SCRIPT_DIR/stop-router.sh"
sleep 1

echo "启动新路由..."
nohup bash "$SCRIPT_DIR/start-router.sh" > /tmp/codex-router.log 2>&1 &
disown

# 等待监听就绪
for i in $(seq 1 10); do
    sleep 1
    if lsof -ti :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
        echo "codex-router 已重启，监听 127.0.0.1:$PORT"
        exit 0
    fi
done

echo "重启后未检测到监听，请查看 /tmp/codex-router.log" >&2
exit 1
