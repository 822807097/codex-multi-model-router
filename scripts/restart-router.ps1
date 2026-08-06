# restart-router.ps1 — 重启路由（改完 codex-router.mjs / 环境变量后执行）
$port = if ($env:ROUTER_PORT) { [int]$env:ROUTER_PORT } else { 15730 }
& "$PSScriptRoot\stop-router.ps1"
Start-Sleep -Seconds 1
# 隐藏窗口拉起 start-router.ps1
Start-Process -WindowStyle Hidden powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\start-router.ps1`"" | Out-Null
# 等待监听就绪
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        Write-Host "codex-router 已重启，监听 127.0.0.1:$port"
        exit 0
    }
}
Write-Host "重启后未检测到监听，请手动运行 start-router.ps1 查看报错" -ForegroundColor Red
exit 1
