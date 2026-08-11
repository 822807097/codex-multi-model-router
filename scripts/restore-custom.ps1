# restore-custom.ps1 — 一键恢复自定义模型组合
# 动作：向 config.toml 写回 model_provider/model_catalog_json/[model_providers.router]，
#       恢复开机自启并拉起路由。跑完请完全重启 Codex 桌面端。
$ErrorActionPreference = 'Stop'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$cfg = Join-Path $codexHome 'config.toml'

$bak = "$cfg.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $cfg $bak
Write-Host "已备份: $bak"

$c = [System.IO.File]::ReadAllText($cfg)

# 顶层两行：插在 model = "..." 行之后
if ($c -notmatch '(?m)^model_provider\s*=') {
    $c = $c -replace '(?m)^(model\s*=\s*"[^"]*")', "`$1`nmodel_provider = ""router""`nmodel_catalog_json = ""$($codexHome -replace '\\','/')/models.json"""
    Write-Host "已写回 model_provider / model_catalog_json"
} else { Write-Host "model_provider 已存在，跳过" }

# router provider 段（requires_openai_auth=true 是桌面端门控钥匙，勿删）
if ($c -notmatch '\[model_providers\.router\]') {
    $block = @'

# --- Local routing proxy: official via local proxy tunnel, third-party direct, vision relay ---
[model_providers.router]
name = "LocalRouter"
base_url = "http://127.0.0.1:15730/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
'@
    $c = $c.TrimEnd() + "`n" + $block + "`n"
    Write-Host "已写回 [model_providers.router] 段"
} else { Write-Host "router 段已存在，跳过" }
[System.IO.File]::WriteAllText($cfg, $c)

# 开机自启快捷方式（启动目录 -> vbs 无窗拉起）
$lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\codex-router.lnk"
if (-not (Test-Path $lnk)) {
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = 'wscript.exe'
    $s.Arguments = "//B `"$PSScriptRoot\start-router-silent.vbs`""
    $s.Save()
    Write-Host "开机自启已恢复"
}
& "$PSScriptRoot\restart-router.ps1"

Write-Host ""
Write-Host "完成。请完全重启 Codex 桌面端，选择器将显示官方+自定义全部模型。"
