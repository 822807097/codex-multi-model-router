# start-router.ps1 — 启动本地路由（前台运行，便于看日志）
# 说明：路由进程启动时才会读取环境变量 key，因此这里从 User+Machine 双作用域
#       显式注入，避免「key 是后设的、当前 shell 没继承」导致 401。
$ErrorActionPreference = 'Stop'

# Codex 数据目录：优先 CODEX_HOME 环境变量，否则 ~/.codex
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$env:CODEX_HOME = $codexHome

# 需要注入给路由的 key 环境变量名：
#   1. 自动从同目录 ../config.json 提取所有 envKey（targets + visionRelay），保证后加的 key 也能注入
#   2. 再合并 ROUTER_ENV_KEYS（逗号分隔）作为补充
function Get-EnvAny($name) {
    $v = [Environment]::GetEnvironmentVariable($name, 'Process')
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'User') }
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'Machine') }
    return $v
}
$keySet = @{}
$cfgPath = if ($env:ROUTER_CONFIG_PATH) { $env:ROUTER_CONFIG_PATH } else { Join-Path $PSScriptRoot '..\config.json' }
if (-not (Test-Path $cfgPath)) { $cfgPath = Join-Path $PSScriptRoot 'config.json' }
if (Test-Path $cfgPath) {
    # 显式 UTF8：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI 解码，会把中文注释读坏导致 JSON 解析失败
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($t in @($cfg.targets)) { if ($t.envKey) { $keySet[$t.envKey] = $true } }
    if ($cfg.visionRelay.envKey) { $keySet[$cfg.visionRelay.envKey] = $true }
}
if ($env:ROUTER_ENV_KEYS) { foreach ($k in $env:ROUTER_ENV_KEYS.Split(',')) { $keySet[$k.Trim()] = $true } }
foreach ($k in $keySet.Keys) {
    $v = Get-EnvAny $k
    if ($v) { Set-Item "env:$k" $v } else { Write-Host "警告: 环境变量 $k 未设置，对应通道会失败" -ForegroundColor Yellow }
}

$router = Join-Path $PSScriptRoot '..\codex-router.mjs'
if (-not (Test-Path $router)) { $router = Join-Path $PSScriptRoot 'codex-router.mjs' }
# 核心诊断日志；上下文维护日志默认自动派生为 router-context.log。
# 两类 JSONL 都按 UTC 日轮转，并自动清理超过 72 小时的归档。
$env:ROUTER_LOG = Join-Path $PSScriptRoot 'router.log'

# Cursor 订阅额度网关联动启动：优先仓库 external\cursor2api（实际部署位置），
# 其次运行实例同级 external\cursor2api；确保其先行就绪（Codex 桌面端使用 cursor-* 模型
# 依赖它；多 Cursor 账号额度池由网关内部轮换/熔断）。
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$cursor2apiCandidates = @(
    (Join-Path $repoRoot 'external\cursor2api'),
    (Join-Path $PSScriptRoot '..\external\cursor2api')
) | Where-Object { Test-Path (Join-Path $_ 'server.mjs') }
$cursor2api = $cursor2apiCandidates | Select-Object -First 1
if ($cursor2api) {
    $crsrHealth = "http://127.0.0.1:6718/health"
    $crsrUp = $false
    try { $crsrUp = (Invoke-WebRequest -Uri $crsrHealth -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200 } catch { }
    if (-not $crsrUp) {
        $crsrKey = Get-EnvAny 'CURSOR_KEY'
        if ($crsrKey) {
            $bunDir = Join-Path $env:APPDATA 'npm\node_modules\bun\bin'
            $env:PATH = "$bunDir;$env:PATH"
            $env:CURSOR_API_KEYS = "main=$crsrKey"
            try {
                # 前台同步等网关 health；SDK bridge 与 sidecar 由 server.mjs 自管
                $p = Start-Process -FilePath 'node' -ArgumentList 'server.mjs','start' `
                    -WorkingDirectory $cursor2api -WindowStyle Hidden -PassThru `
                    -RedirectStandardOutput (Join-Path $cursor2api 'run.out.log') `
                    -RedirectStandardError (Join-Path $cursor2api 'run.err.log')
                Write-Host "cursor2api 已启动 (PID $($p.Id))"
            } catch { Write-Host "cursor2api 启动失败: $($_.Exception.Message)" -ForegroundColor Yellow }
        } else {
            Write-Host "警告: 未检测到 CURSOR_KEY，cursor 通道不可用" -ForegroundColor Yellow
        }
    } else {
        Write-Host "cursor2api 已在运行（health OK）"
    }
} else {
    Write-Host "未安装 cursor2api（external\cursor2api 缺失），cursor 通道不可用" -ForegroundColor Yellow
}

node $router
