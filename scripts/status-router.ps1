# status-router.ps1 — 查看路由状态（PID + 健康检查）
$port = if ($env:ROUTER_PORT) { [int]$env:ROUTER_PORT } else { 15730 }
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $p = Get-Process -Id ($conns[0].OwningProcess)
    Write-Host "codex-router 运行中 PID=$($p.Id) 启动于 $($p.StartTime)"
} else {
    Write-Host "codex-router 未在运行"
}
try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 5
    Write-Host "healthz: ok=$($h.ok) targets=$($h.targets -join ',')"
} catch {
    Write-Host "healthz: 无响应"
}
