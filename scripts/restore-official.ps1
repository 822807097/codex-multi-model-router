# restore-official.ps1 — 一键恢复 Codex 官方配置
# 动作：从 config.toml 移除 model_provider/model_catalog_json/[model_providers.router]，
#       停止路由并移除开机自启。跑完请完全重启 Codex 桌面端。
$ErrorActionPreference = 'Stop'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$cfg = Join-Path $codexHome 'config.toml'

# 备份（带时间戳，永不覆盖）
$bak = "$cfg.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $cfg $bak
Write-Host "已备份: $bak"

# 先定位 router 段头行号，避免跳过逻辑误伤其它段
$lines = [System.IO.File]::ReadAllLines($cfg)
$routerIdx = -1
for ($k = 0; $k -lt $lines.Count; $k++) { if ($lines[$k] -eq '[model_providers.router]') { $routerIdx = $k; break } }
$out = New-Object System.Collections.Generic.List[string]
$skip = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
    $l = $lines[$i]
    if ($skip) {
        if ($l -match '^\[') { $skip = $false; $out.Add($l) }  # 下一个段头保留
        continue
    }
    if ($l -match '^model_provider\s*=' -or $l -match '^model_catalog_json\s*=') { continue }
    # 段头前 2 行内的标记注释一并移除
    if ($routerIdx -ge 0 -and ($routerIdx - $i) -le 2 -and $l -match '^#\s*---\s*Local routing proxy') { continue }
    if ($i -eq $routerIdx) { $skip = $true; continue }
    $out.Add($l)
}
while ($out.Count -and $out[$out.Count - 1].Trim() -eq '') { $out.RemoveAt($out.Count - 1) }
[System.IO.File]::WriteAllLines($cfg, $out)
Write-Host "config.toml 已恢复官方状态"

# 停止路由 + 移除开机自启
& "$PSScriptRoot\stop-router.ps1"
$lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\codex-router.lnk"
if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "开机自启已移除" }

Write-Host ""
Write-Host "完成。请完全重启 Codex 桌面端，选择器将回到纯官方模型。"
Write-Host "想恢复自定义模型组合：运行 restore-custom.ps1"
