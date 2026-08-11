# login-device.ps1 — Device Code 一键登录（绕开桌面端 localhost:1455 回调故障）
# 原理：codex CLI 的 device-auth 流程无需本地回调端口，浏览器输入一次性代码即可完成授权。
# 用法：.\login-device.ps1            # 正常登录（自动打开浏览器）
#       .\login-device.ps1 -NoBrowser # 测试模式：只生成并显示代码，不打开浏览器
# 前置：已安装 Codex CLI（npm install -g @openai/codex）
param(
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'

# 1. 检查 codex CLI
$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) {
    Write-Host "未找到 codex CLI，请先安装：npm install -g @openai/codex" -ForegroundColor Red
    exit 1
}

# 2. auth.json 目标位置（与桌面端/路由共用 CODEX_HOME）
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$authPath = Join-Path $codexHome 'auth.json'

# 防呆：已登录（令牌未过期）时直接退出，绝不重复发起登录流程覆盖现有凭据。
if (Test-Path $authPath) {
    try {
        $authData = Get-Content $authPath -Raw | ConvertFrom-Json
        $accessToken = $authData.tokens.access_token
        if ($accessToken) {
            $payload = $accessToken.Split('.')[1]
            $pad = 4 - ($payload.Length % 4)
            if ($pad -lt 4) { $payload += ('=' * $pad) }
            $claims = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload.Replace('-', '+').Replace('_', '/'))) | ConvertFrom-Json
            $expireSeconds = [long]$claims.exp
            if ($expireSeconds -gt ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 3600)) {
                Write-Host "已检测到有效登录态（auth.json 存在且令牌未过期），无需重复登录。" -ForegroundColor Green
                Write-Host "如需强制重新登录，请先删除：$authPath" -ForegroundColor Yellow
                exit 0
            }
        }
    } catch { # 解析失败按未登录处理
    }
}

$authBefore = if (Test-Path $authPath) { (Get-Item $authPath).LastWriteTimeUtc } else { [DateTime]::MinValue }

# 3. 后台启动 device-auth，输出重定向到临时文件
$outFile = Join-Path $env:TEMP "codex-device-$(Get-Random).out"
$errFile = Join-Path $env:TEMP "codex-device-$(Get-Random).err"
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList @('/c', "codex login --device-auth > `"$outFile`" 2> `"$errFile`"") -WindowStyle Hidden -PassThru

# 4. 等待并解析授权 URL 与一次性代码（输出可能在 stdout 或 stderr，进程退出后仍需读一次）
$authUrl = ''
$deviceCode = ''
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $content = ((Get-Content $outFile, $errFile -Raw -ErrorAction SilentlyContinue) -join "`n")
    if ($content) {
        if (-not $authUrl) {
            $match = [regex]::Match($content, 'https://[^\s]+')
            if ($match.Success) { $authUrl = $match.Value }
        }
        if (-not $deviceCode) {
            $match = [regex]::Match($content, '([A-Z0-9]{5}-[A-Z0-9]{5})')
            if ($match.Success) { $deviceCode = $match.Value }
        }
    }
    if ($authUrl -and $deviceCode) { break }
}
if (-not ($authUrl -and $deviceCode)) {
    Write-Host "未能获取设备码，输出如下：" -ForegroundColor Red
    Get-Content $outFile, $errFile -ErrorAction SilentlyContinue
    Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
    exit 1
}

# 5. 显示信息并打开浏览器
Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  1. 浏览器打开授权页（已自动打开）"
Write-Host "     $authUrl"
Write-Host "  2. 输入一次性代码：$deviceCode  （15 分钟内有效）"
Write-Host "  3. 用 ChatGPT 账号确认授权"
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""
if (-not $NoBrowser) { Start-Process $authUrl }

# 6. 等待授权完成（auth.json 更新）
Write-Host "等待授权完成（浏览器确认后自动继续）..." -NoNewline
$succeeded = $false
for ($i = 0; $i -lt 360; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $authPath) {
        $modified = (Get-Item $authPath).LastWriteTimeUtc
        if ($modified -gt $authBefore) { $succeeded = $true; break }
    }
    if ($i % 20 -eq 0) { Write-Host "." -NoNewline }
}
Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue

if ($succeeded) {
    Write-Host ""
    Write-Host "登录成功！auth.json 已更新：$authPath" -ForegroundColor Green
    Write-Host "桌面端会自动检测到登录态，官方模型与订阅额度立即可用。" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "等待超时（6 分钟）或代码已过期。请重新运行本脚本。" -ForegroundColor Yellow
    exit 1
}
