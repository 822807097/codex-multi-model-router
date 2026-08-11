#!/usr/bin/env bash
# login-device.sh — Device Code 一键登录（绕开桌面端 localhost:1455 回调故障）
# 原理：codex CLI 的 device-auth 流程无需本地回调端口，浏览器输入一次性代码即可完成授权。
# 用法：./login-device.sh            # 正常登录（自动打开浏览器）
#       ./login-device.sh --no-browser # 测试模式：只生成并显示代码，不打开浏览器
# 前置：已安装 Codex CLI（npm install -g @openai/codex）

set -euo pipefail

NO_BROWSER=false
if [ "${1:-}" = "--no-browser" ]; then NO_BROWSER=true; fi

# 1. 检查 codex CLI
if ! command -v codex >/dev/null 2>&1; then
    echo "未找到 codex CLI，请先安装：npm install -g @openai/codex" >&2
    exit 1
fi

# 2. auth.json 目标位置（与桌面端/路由共用 CODEX_HOME）
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
AUTH_PATH="$CODEX_HOME/auth.json"
AUTH_BEFORE=0
if [ -f "$AUTH_PATH" ]; then AUTH_BEFORE=$(stat -c %Y "$AUTH_PATH" 2>/dev/null || stat -f %m "$AUTH_PATH"); fi

# 3. 后台启动 device-auth，输出重定向到临时文件
OUT_FILE="$(mktemp /tmp/codex-device-XXXXXX.out)"
ERR_FILE="$(mktemp /tmp/codex-device-XXXXXX.err)"
codex login --device-auth >"$OUT_FILE" 2>"$ERR_FILE" &
CLI_PID=$!

# 4. 等待并解析授权 URL 与一次性代码
AUTH_URL=""
DEVICE_CODE=""
for _ in $(seq 1 60); do
    sleep 0.5
    if [ -s "$OUT_FILE" ]; then
        CONTENT=$(cat "$OUT_FILE")
        if [ -z "$AUTH_URL" ]; then
            AUTH_URL=$(printf '%s' "$CONTENT" | grep -oE 'https://[^[:space:]]+' | head -1 || true)
        fi
        if [ -z "$DEVICE_CODE" ]; then
            DEVICE_CODE=$(printf '%s' "$CONTENT" | grep -oE '[A-Z0-9]{5}-[A-Z0-9]{5}' | head -1 || true)
        fi
    fi
    if [ -n "$AUTH_URL" ] && [ -n "$DEVICE_CODE" ]; then break; fi
    if ! kill -0 "$CLI_PID" 2>/dev/null; then break; fi
done
if [ -z "$AUTH_URL" ] || [ -z "$DEVICE_CODE" ]; then
    echo "未能获取设备码，输出如下：" >&2
    cat "$OUT_FILE" "$ERR_FILE" >&2 || true
    rm -f "$OUT_FILE" "$ERR_FILE"
    exit 1
fi

# 5. 显示信息并打开浏览器
echo ""
echo "=================================================="
echo "  1. 浏览器打开授权页（已自动打开）"
echo "     $AUTH_URL"
echo "  2. 输入一次性代码：$DEVICE_CODE  （15 分钟内有效）"
echo "  3. 用 ChatGPT 账号确认授权"
echo "=================================================="
echo ""
if [ "$NO_BROWSER" = "false" ]; then
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "$AUTH_URL" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then open "$AUTH_URL" >/dev/null 2>&1 || true; fi
fi

# 6. 等待授权完成（auth.json 更新，最长 6 分钟）
echo -n "等待授权完成（浏览器确认后自动继续）..."
SUCCEEDED=false
for i in $(seq 1 360); do
    sleep 1
    if [ -f "$AUTH_PATH" ]; then
        MODIFIED=$(stat -c %Y "$AUTH_PATH" 2>/dev/null || stat -f %m "$AUTH_PATH")
        if [ "$MODIFIED" -gt "$AUTH_BEFORE" ]; then SUCCEEDED=true; break; fi
    fi
    if [ $((i % 20)) -eq 0 ]; then echo -n "."; fi
done
rm -f "$OUT_FILE" "$ERR_FILE"

if [ "$SUCCEEDED" = "true" ]; then
    echo ""
    echo "登录成功！auth.json 已更新：$AUTH_PATH"
    echo "桌面端会自动检测到登录态，官方模型与订阅额度立即可用。"
else
    echo ""
    echo "等待超时（6 分钟）或代码已过期。请重新运行本脚本。" >&2
    exit 1
fi
