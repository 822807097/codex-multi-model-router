# test-router.ps1 — 改完 key/URL 后的一键验收
# 依次检查：路由存活 → 环境变量存在 → 两条文本腿 → 视觉中继 → 官方腿(可选)
# 用法：powershell -ExecutionPolicy Bypass -File test-router.ps1 [-SkipOfficial] [-SkipVision]
# 注意：改完 Machine 环境变量后必须先 restart-router.ps1，再跑本测试
param([switch]$SkipOfficial, [switch]$SkipVision)

$port = if ($env:ROUTER_PORT) { [int]$env:ROUTER_PORT } else { 15730 }
$base = "http://127.0.0.1:$port"
$results = @()

function Get-EnvAny($name) {
    $v = [Environment]::GetEnvironmentVariable($name, 'User')
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'Machine') }
    return $v
}

Write-Host "=== 本地路由模型测试 ===" -ForegroundColor Cyan

# 0. 路由存活
try {
    $h = Invoke-RestMethod -Uri "$base/healthz" -TimeoutSec 5
    Write-Host "[路由] 运行中 targets: $($h.targets -join ', ')" -ForegroundColor Green
} catch {
    Write-Host "[路由] 未运行！请先执行 restart-router.ps1" -ForegroundColor Red
    exit 1
}

# 1. 环境变量存在性（不打印值）
$keyNames = if ($env:ROUTER_ENV_KEYS) { $env:ROUTER_ENV_KEYS.Split(',') } else { @('DEEPSEEK_API_KEY', 'BAILIAN_API_KEY') }
foreach ($k in $keyNames) {
    if (Get-EnvAny $k) { Write-Host "[env] $k 已设置" -ForegroundColor Green }
    else { Write-Host "[env] $k 未设置！对应腿会失败" -ForegroundColor Red }
}

# 2. 文本腿：发一句 "Reply exactly: OK"，能拿回回复即通
function Test-TextModel($model) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $body = @{ model = $model; store = $false; input = @(@{ role = 'user'; content = @(@{ type = 'input_text'; text = 'Reply exactly: OK' }) }) } | ConvertTo-Json -Depth 6
    try {
        $r = Invoke-RestMethod -Uri "$base/v1/responses" -Method Post -ContentType 'application/json' -Headers @{ Authorization = 'Bearer router-local' } -Body $body -TimeoutSec 90
        $sw.Stop()
        $txt = $r.output_text
        if (-not $txt) { $txt = ($r.output | ForEach-Object { $_.content | ForEach-Object { $_.text } }) -join '' }
        return @{ ok = $true; detail = "回复: $($txt.Trim()) ($([int]$sw.ElapsedMilliseconds)ms)" }
    } catch {
        $msg = if ($_.ErrorDetails) { $_.ErrorDetails.Message.Substring(0, [Math]::Min(120, $_.ErrorDetails.Message.Length)) } else { $_.Exception.Message }
        return @{ ok = $false; detail = $msg }
    }
}
foreach ($m in @('deepseek-v4-flash', 'qwen3.8-max')) {
    $t = Test-TextModel $m
    Write-Host ("$(if ($t.ok) { '[OK]  ' } else { '[FAIL]' }) $m -> $($t.detail)") -ForegroundColor $(if ($t.ok) { 'Green' } else { 'Red' })
    $results += [pscustomobject]@{ model = $m; ok = $t.ok }
}

# 3. 视觉中继：生成一张红色小图发给文本模型，回复含 red 即中继生效
if (-not $SkipVision) {
    try {
        Add-Type -AssemblyName System.Drawing
        $bmp = New-Object System.Drawing.Bitmap(64, 64)
        $g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::Red); $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $png = [Convert]::ToBase64String($ms.ToArray())
        $body = @{ model = 'deepseek-v4-flash'; store = $false; input = @(@{ role = 'user'; content = @(@{ type = 'input_text'; text = 'What color is the image? One word.' }, @{ type = 'input_image'; image_url = "data:image/png;base64,$png" }) }) } | ConvertTo-Json -Depth 8
        $r = Invoke-RestMethod -Uri "$base/v1/responses" -Method Post -ContentType 'application/json' -Headers @{ Authorization = 'Bearer router-local' } -Body $body -TimeoutSec 120
        $txt = ($r.output | Where-Object { $_.type -eq 'message' } | ForEach-Object { $_.content | ForEach-Object { $_.text } }) -join ''
        $hit = $txt -match 'red'
        Write-Host "[OK]   视觉中继 deepseek+图片 -> 回复: $($txt.Trim())" -ForegroundColor $(if ($hit) { 'Green' } else { 'Yellow' })
        $results += [pscustomobject]@{ model = 'vision-relay'; ok = $hit }
    } catch {
        Write-Host "[FAIL] 视觉中继: $($_.Exception.Message)" -ForegroundColor Red
        $results += [pscustomobject]@{ model = 'vision-relay'; ok = $false }
    }
}

# 4. 官方腿：流式请求只看状态码。200=通；429=链路通但额度尽；其余=失败（查本地代理）
if (-not $SkipOfficial) {
    $body = '{"model":"gpt-5.4-mini","store":false,"stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"Reply exactly: OK"}]}]}'
    $code = & curl.exe -s -o NUL -w '%{http_code}' --max-time 25 -X POST "$base/v1/responses" -H 'content-type: application/json' -H 'Authorization: Bearer router-local' -d $body 2>$null
    switch ($code) {
        '200' { Write-Host "[OK]   官方腿 -> 200 流式正常" -ForegroundColor Green; $results += [pscustomobject]@{ model = 'official'; ok = $true } }
        '429' { Write-Host "[OK]   官方腿 -> 429 额度用尽（链路通）" -ForegroundColor Yellow; $results += [pscustomobject]@{ model = 'official'; ok = $true } }
        default { Write-Host "[FAIL] 官方腿 -> HTTP $code（检查本地代理是否运行）" -ForegroundColor Red; $results += [pscustomobject]@{ model = 'official'; ok = $false } }
    }
}

Write-Host ""
$bad = @($results | Where-Object { -not $_.ok })
if ($bad.Count) { Write-Host "总结: $($bad.Count) 项失败 -> $($bad.model -join ', ')" -ForegroundColor Red; exit 1 }
else { Write-Host "总结: 全部通过" -ForegroundColor Green; exit 0 }
