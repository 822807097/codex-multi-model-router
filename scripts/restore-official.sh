#!/usr/bin/env bash
# restore-official.sh — 一键恢复 Codex 官方配置
# 动作：从 config.toml 移除 model_provider/model_catalog_json/[model_providers.router]，
#       停止路由。跑完请完全重启 Codex 桌面端。

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

# 移除 model_provider 和 model_catalog_json 行
sed -i.bak '/^model_provider\s*=/d; /^model_catalog_json\s*=/d' "$CFG"

# 移除 [model_providers.router] 段（从段头到下一个段头或文件尾）
awk '
/^\[model_providers\.router\]/ { skip=1; next }
/^\[/ { skip=0 }
!skip { print }
' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"

echo "config.toml 已恢复官方状态"

# 停止路由
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/stop-router.sh"

echo ""
echo "完成。请完全重启 Codex 桌面端，选择器将回到纯官方模型。"
echo "想恢复自定义模型组合：运行 restore-custom.sh"
