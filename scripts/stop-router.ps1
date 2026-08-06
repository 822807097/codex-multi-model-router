# stop-router.ps1 — 停止路由（杀掉监听 ROUTER_PORT 的进程）
$port = if ($env:ROUTER_PORT) { [int]$env:ROUTER_PORT } else { 15730 }
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) { Write-Host "codex-router 未在运行"; exit 0 }
$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
Write-Host "codex-router 已停止"
