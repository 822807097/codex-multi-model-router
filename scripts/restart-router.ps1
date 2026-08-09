# restart-router.ps1 — 无感重启路由（不打断在跑任务）
# 原理：POST /_admin/shutdown 让旧进程释放端口并排空在跑任务，
#       新进程立即绑定端口接管新请求；在跑的流式任务在旧进程上自然结束。
$ErrorActionPreference = 'Stop'
$port = if ($env:ROUTER_PORT) { [int]$env:ROUTER_PORT } else { 15730 }
$here = $PSScriptRoot
# 兼容两种目录布局（scripts/ 子目录 或 与 mjs 同目录）
$router = Join-Path $here '..\codex-router.mjs'
if (-not (Test-Path $router)) { $router = Join-Path $here 'codex-router.mjs' }
$cfgPath = Join-Path (Split-Path $router) 'config.json'

# 1. 通知旧进程优雅退出（不强杀）
try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/_admin/shutdown" -TimeoutSec 3 | Out-Null
    Write-Host "已通知旧进程优雅退出（在跑任务将继续完成）"
} catch {
    Write-Host "旧进程未运行或无响应，直接启动新进程"
}
# 等待旧进程释放端口
for ($i = 0; $i -lt 10; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
}

# 2. 注入环境变量（从 Machine/User 读取 config 里声明的 envKey）
$env:CODEX_HOME = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$env:ROUTER_LOG = Join-Path (Split-Path $router) 'router.log'
function Get-EnvAny($n) { $v = [Environment]::GetEnvironmentVariable($n, 'User'); if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, 'Machine') }; $v }
$keySet = @{}
if (Test-Path $cfgPath) {
    # 显式 UTF8：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI 解码，会把中文注释读坏导致 JSON 解析失败
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($t in @($cfg.targets)) { if ($t.envKey) { $keySet[$t.envKey] = $true } }
    if ($cfg.visionRelay.envKey) { $keySet[$cfg.visionRelay.envKey] = $true }
}
foreach ($k in $keySet.Keys) { $v = Get-EnvAny $k; if ($v) { Set-Item "env:$k" $v } }

# 3. 直接后台启动 node（比隐藏 powershell 更可靠）
Start-Process -WindowStyle Hidden node -ArgumentList "`"$router`"" | Out-Null

# 4. 等待新进程监听就绪
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
        if ($h.ok) { Write-Host "codex-router 已无感重启，监听 127.0.0.1:$port"; exit 0 }
    } catch { }
}
Write-Host "重启后未检测到监听，请手动运行 start-router.ps1 查看报错" -ForegroundColor Red
exit 1
