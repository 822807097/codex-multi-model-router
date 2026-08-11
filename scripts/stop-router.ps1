# stop-router.ps1 — 优雅停止路由（不打断在跑任务）
# 停止顺序：
#   1. 尝试 POST /_admin/shutdown（兼容仍提供关闭端点的旧实例/测试实例）
#   2. 新版正常运行模式无进程控制端点：向进程控制台发送 Ctrl+C，触发 SIGINT 排空流程
#   3. 等待旧进程排空在跑任务后自然退出（最长 10 分钟，与路由内部安全阀一致）
# 绝不直接 Stop-Process 强杀。
param([int]$WaitSeconds = 600)
$port = if ($env:ROUTER_PORT) { [int]$env:ROUTER_PORT } else { 15730 }
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) { Write-Host "codex-router 未在运行"; exit 0 }
$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique

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

foreach ($p in $pids) {
    if (-not (Get-Process -Id $p -ErrorAction SilentlyContinue)) { continue }
    Write-Host "停止路由 PID=$p（优雅排空，不打断在跑任务）"
    # 1. 兼容旧实例：关闭端点存在时优先使用
    try {
        Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/_admin/shutdown" -TimeoutSec 3 | Out-Null
        Write-Host "已通过 /_admin/shutdown 通知优雅退出"
    } catch {
        # 新版无此端点（404），继续走 Ctrl+C
    }

    # 2. 进程仍在则发送 Ctrl+C（触发 SIGINT → gracefulExit）
    if (Get-Process -Id $p -ErrorAction SilentlyContinue) {
        if (Send-CtrlC $p) { Write-Host "已发送 Ctrl+C（SIGINT）触发优雅排空" }
        else { Write-Host "无法附加目标进程控制台，进程可能无控制台；请手动处理" -ForegroundColor Yellow }
    }

    # 3. 等待排空退出
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while (Get-Process -Id $p -ErrorAction SilentlyContinue) {
        if ((Get-Date) -gt $deadline) {
            Write-Host "等待排空超时（$WaitSeconds 秒），进程仍在运行；路由内部 10 分钟安全阀会兜底退出" -ForegroundColor Yellow
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not (Get-Process -Id $p -ErrorAction SilentlyContinue)) { Write-Host "路由已优雅退出" }
}
