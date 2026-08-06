#!/usr/bin/env bash
# restore-custom.sh — 一键恢复自定义模型组合
# 动作：向 config.toml 写回 model_provider/model_catalog_json/[model_providers.router]，
#       拉起路由。跑完请完全重启 Codex 桌面端。

set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CFG="$CODEX_HOME/config.toml"

if [ ! -f "$CFG" ]; then
    echo "错误：$CFG 不存在" >&2
    exit 1
fi

# 备份
BAK="$CFG.bak-$(date +%Y%m%d-%H%M%S)"
cp "$CFG" "$BAK"
echo "已备份：$BAK"

# 检查是否已有 model_provider
if ! grep -q '^model_provider\s*=' "$CFG"; then
    # 插在 model = "..." 行之后
    sed -i.bak '/^model\s*=/a model_provider = "router"\nmodel_catalog_json = "'"$CODEX_HOME"'/models.json"' "$CFG"
    echo "已写回 model_provider / model_catalog_json"
else
    echo "model_provider 已存在，跳过"
fi

# 检查是否已有 [model_providers.router]
if ! grep -q '^\[model_providers\.router\]' "$CFG"; then
    cat >> "$CFG" <<'EOF'

# --- Local routing proxy: official via local proxy tunnel, third-party direct, vision relay ---
[model_providers.router]
name = "LocalRouter"
base_url = "http://127.0.0.1:15730/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
EOF
    echo "已写回 [model_providers.router] 段"
else
    echo "router 段已存在，跳过"
fi

# 启动路由
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/restart-router.sh"

echo ""
echo "完成。请完全重启 Codex 桌面端，选择器将显示官方 + 自定义全部模型。"
