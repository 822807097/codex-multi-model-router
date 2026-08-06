# start-router.ps1 — 启动本地路由（前台运行，便于看日志）
# 说明：路由进程启动时才会读取环境变量 key，因此这里从 User+Machine 双作用域
#       显式注入，避免「key 是后设的、当前 shell 没继承」导致 401。
$ErrorActionPreference = 'Stop'

# Codex 数据目录：优先 CODEX_HOME 环境变量，否则 ~/.codex
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$env:CODEX_HOME = $codexHome

# 需要注入给路由的 key 环境变量名（逗号分隔，可按需增减）
$keyNames = if ($env:ROUTER_ENV_KEYS) { $env:ROUTER_ENV_KEYS } else { 'DEEPSEEK_API_KEY,BAILIAN_API_KEY' }

function Get-EnvAny($name) {
    $v = [Environment]::GetEnvironmentVariable($name, 'User')
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'Machine') }
    return $v
}
foreach ($k in $keyNames.Split(',')) {
    $v = Get-EnvAny $k.Trim()
    if ($v) { Set-Item "env:$k" $v } else { Write-Host "警告: 环境变量 $k 未设置，对应腿会失败" -ForegroundColor Yellow }
}

$router = Join-Path $PSScriptRoot '..\codex-router.mjs'
node $router
