# restart-router.ps1 — 无感重启路由（不打断在跑任务）
# 原理：先优雅停止旧进程（/_admin/shutdown 或 Ctrl+C → SIGINT 排空），
#       确认旧进程退出、端口释放后，再启动新进程接管。
# 新版正常运行模式不暴露进程控制端点（安全设计），因此用控制台 Ctrl+C 事件触发 SIGINT。
$ErrorActionPreference = 'Stop'
$port = if ($env:ROUTER_PORT) { [int]$env:ROUTER_PORT } else { 15730 }
$here = $PSScriptRoot
# 兼容两种目录布局（scripts/ 子目录 或 与 mjs 同目录）
$router = Join-Path $here '..\codex-router.mjs'
if (-not (Test-Path $router)) { $router = Join-Path $here 'codex-router.mjs' }
$cfgPath = Join-Path (Split-Path $router) 'config.json'

# Ctrl+C 事件需要附加到目标进程的控制台；目标进程必须拥有独立控制台（Start-Process 默认新建）。
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RouterCtrlC {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint pid);
}
'@

function Send-CtrlC($targetPid) {
    [RouterCtrlC]::FreeConsole() | Out-Null
    $attached = [RouterCtrlC]::AttachConsole([uint32]$targetPid)
    if (-not $attached) { [RouterCtrlC]::FreeConsole() | Out-Null; return $false }
    # 进程组 0 = 目标控制台内所有进程（路由进程无子进程，仅它自己）
    $sent = [RouterCtrlC]::GenerateConsoleCtrlEvent(0, 0)
    [RouterCtrlC]::FreeConsole() | Out-Null
    return $sent
}

# 1. 优雅停止旧进程（存在时）
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $oldPids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($oldPid in $oldPids) {
        Write-Host "停止旧进程 PID=$oldPid（优雅排空，在跑任务将继续完成）"
        # 1a. 兼容仍提供关闭端点的实例
        try {
            Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/_admin/shutdown" -TimeoutSec 3 | Out-Null
            Write-Host "已通过 /_admin/shutdown 通知优雅退出"
        } catch {
            # 新版无此端点（404），继续走 Ctrl+C
        }
        # 1b. 进程仍在则发送 Ctrl+C（触发 SIGINT → gracefulExit）
        if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
            if (Send-CtrlC $oldPid) { Write-Host "已发送 Ctrl+C（SIGINT）触发优雅排空" }
            else { Write-Host "无法附加目标进程控制台，请检查进程状态" -ForegroundColor Yellow }
        }
    }
    # 1c. 等待旧进程排空退出（路由内部有 10 分钟安全阀）
    $deadline = (Get-Date).AddSeconds(600)
    foreach ($oldPid in $oldPids) {
        while (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
            if ((Get-Date) -gt $deadline) { Write-Host "等待旧进程排空超时，请稍后重试" -ForegroundColor Red; exit 1 }
            Start-Sleep -Milliseconds 500
        }
    }
} else {
    Write-Host "旧进程未运行，直接启动新进程"
}

# 2. 注入环境变量（从 Machine/User 读取 config 里声明的 envKey）
$env:CODEX_HOME = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$env:ROUTER_LOG = Join-Path (Split-Path $router) 'router.log'
function Get-EnvAny($n) { $v = [Environment]::GetEnvironmentVariable($n, 'Process'); if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, 'User') }; if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, 'Machine') }; $v }
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
