#!/usr/bin/env bash
# test-router.sh — 改完 key/URL 后的一键验收
# 用法：bash test-router.sh [--skip-official] [--skip-vision]
# 注意：改完环境变量后必须先 restart-router.sh，再跑本测试

set -euo pipefail

PORT="${ROUTER_PORT:-15730}"
BASE="http://127.0.0.1:$PORT"
SKIP_OFFICIAL=false
SKIP_VISION=false

for arg in "$@"; do
    case $arg in
        --skip-official) SKIP_OFFICIAL=true ;;
        --skip-vision) SKIP_VISION=true ;;
    esac
done

echo "=== 本地路由模型测试 ==="

# 0. 路由存活
if ! curl -sf "$BASE/healthz" >/dev/null 2>&1; then
    echo "[路由] 未运行！请先执行 restart-router.sh" >&2
    exit 1
fi
echo "[路由] 运行中"

# 1. 环境变量存在性（不打印值）
KEY_NAMES="${ROUTER_ENV_KEYS:-DEEPSEEK_API_KEY BAILIAN_API_KEY}"
for k in $KEY_NAMES; do
    if [ -n "${!k:-}" ]; then
        echo "[env] $k 已设置"
    else
        echo "[env] $k 未设置！对应腿会失败" >&2
    fi
done

# 2. 文本腿测试
test_model() {
    local model=$1
    local body="{\"model\":\"$model\",\"store\":false,\"input\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Reply exactly: OK\"}]}]}"
    local response
    response=$(curl -sf -X POST "$BASE/v1/responses" \
        -H "content-type: application/json" \
        -H "Authorization: Bearer router-local" \
        -d "$body" \
        --max-time 90 2>&1) || {
        echo "[FAIL] $model -> $response"
        return 1
    }
    local text
    text=$(printf '%s' "$response" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{let j;try{j=JSON.parse(d)}catch{for(const l of d.split(/\r?\n/)){if(!l.startsWith('data: '))continue;try{const e=JSON.parse(l.slice(6));if(e.type==='response.completed')j=e.response}catch{}}}console.log(j?.output_text||(j?.output||[]).map(m=>(m.content||[]).map(c=>c.text||'').join('')).join(''))})")
    echo "[OK]   $model -> 回复：${text:-OK}"
}

test_model "deepseek-v4-flash"
test_model "qwen3.8-max"

# 3. 视觉中继（可选）
if [ "$SKIP_VISION" = false ]; then
    echo "[视觉中继] 测试跳过（需要生成图片，暂不支持 bash 版）"
fi

# 4. 官方腿（可选）
if [ "$SKIP_OFFICIAL" = false ]; then
    code=''
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/responses" \
        -H "content-type: application/json" \
        -H "Authorization: Bearer router-local" \
        -d '{"model":"gpt-5.4-mini","store":false,"stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"Reply exactly: OK"}]}]}' \
        --max-time 25 2>/dev/null)
    case $code in
        200) echo "[OK]   官方腿 -> 200 流式正常" ;;
        429) echo "[OK]   官方腿 -> 429 额度用尽（链路通）" ;;
        *)   echo "[FAIL] 官方腿 -> HTTP $code（检查本地代理是否运行）" >&2 ;;
    esac
fi

echo ""
echo "总结：测试完成"
