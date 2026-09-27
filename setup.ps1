# =====================================================================
#  livestream-hub  一键安装
#
#  做这些事：
#    1. 检查依赖 (PowerShell / Node.js / npm / ffmpeg)
#    2. 下载 MediaMTX 媒体服务器到 bin\mediamtx\
#    3. 从模板生成 bin\mediamtx\mediamtx.yml 与 data\config.json（含随机 hostKey）
#    4. 生成 data\names.txt 白名单（首次）
#    5. 安装 Node 依赖
#    6. 可选：生成桌面快捷方式
#
#  用法:
#    .\setup.ps1                   完整安装
#    .\setup.ps1 -NoShortcuts      不建桌面快捷方式
#    .\setup.ps1 -Force            覆盖已存在的配置
#    .\setup.ps1 -GithubMirror https://ghfast.top/    GitHub 下载慢时用加速前缀
# =====================================================================
[CmdletBinding()]
param(
    [switch]$NoShortcuts,
    [switch]$Force,
    [string]$GithubMirror = '',
    [string]$MediaMTXVersion = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Say($m)  { Write-Host "[安装] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   注意 $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "   错误 $m" -ForegroundColor Red }

Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '   livestream-hub  安装程序' -ForegroundColor Cyan
Write-Host "   安装目录: $root" -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ''

foreach ($d in 'bin\mediamtx', 'bin', 'data', 'logs', 'config', 'server', 'web', 'tools') {
    New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null
}

# ---------------------------------------------------------------- 1. 依赖检查
Say '检查依赖'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail '找不到 Node.js。请先安装：https://nodejs.org/  (建议 18 以上)'; exit 1 }
Ok "Node.js $(& node -v)  -> $($node.Source)"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Fail '找不到 npm（通常随 Node.js 一起安装）'; exit 1 }
Ok "npm $(& npm -v)"

# ffmpeg: 用于按需转码 720p
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) {
    foreach ($p in @(
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links\ffmpeg.exe",
        'C:\ffmpeg\bin\ffmpeg.exe', 'D:\ffmpeg\ffmpeg.exe', 'D:\ffmpeg\bin\ffmpeg.exe',
        'C:\Program Files\ffmpeg\bin\ffmpeg.exe'
    )) { if (Test-Path $p) { $ffmpeg = $p; break } }
}
if (-not $ffmpeg) {
    Fail '找不到 ffmpeg.exe。外网那一路 720p 转码依赖它。'
    Write-Host '        安装方式（任选其一）：' -ForegroundColor Yellow
    Write-Host '          winget install Gyan.FFmpeg' -ForegroundColor Yellow
    Write-Host '          或到 https://www.gyan.dev/ffmpeg/builds/ 下载后把 bin 目录加入 PATH' -ForegroundColor Yellow
    exit 1
}
$ffmpegFwd = $ffmpeg.Replace('\', '/')
Ok "ffmpeg -> $ffmpeg"
try {
    $enc = & $ffmpeg -hide_banner -encoders 2>&1 | Select-String 'h264_nvenc'
    if ($enc) { Ok 'ffmpeg 支持 h264_nvenc（NVIDIA 硬件转码可用）' }
    else { Warn 'ffmpeg 不支持 h264_nvenc。如果你没有 N 卡，请把 mediamtx.yml 里 wan 的编码器改成 libx264' }
} catch { Warn '无法探测 ffmpeg 编码器' }

# ---------------------------------------------------------------- 2. MediaMTX
Say '准备 MediaMTX 媒体服务器'
$mtxDir = Join-Path $root 'bin\mediamtx'
$mtxExe = Join-Path $mtxDir 'mediamtx.exe'

if ((Test-Path $mtxExe) -and -not $Force) {
    Ok "已存在，跳过下载：$mtxExe"
} else {
    $ver = $MediaMTXVersion
    if (-not $ver) {
        try {
            $rel = Invoke-RestMethod 'https://api.github.com/repos/bluenviron/mediamtx/releases/latest' -TimeoutSec 25
            $ver = $rel.tag_name
        } catch {
            $ver = 'v1.21.1'
            Warn "查最新版本失败，回退到 $ver"
        }
    }
    if ($ver -notmatch '^v') { $ver = "v$ver" }
    $asset = "mediamtx_${ver}_windows_amd64.zip"
    $url = "$GithubMirror" + "https://github.com/bluenviron/mediamtx/releases/download/$ver/$asset"
    $zip = Join-Path $env:TEMP $asset
    Say "下载 $asset ..."
    Say "  来源: $url"
    $okDl = $false
    try {
        Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 900 -UseBasicParsing
        $okDl = (Test-Path $zip) -and (Get-Item $zip).Length -gt 5MB
    } catch { $okDl = $false }

    if (-not $okDl) {
        # 断点续传再试一次（国内直连 GitHub 常见超时）
        Warn '首次下载未完成，改用 curl 断点续传重试...'
        & curl.exe -L -C - --retry 5 --retry-delay 2 --max-time 900 -o $zip $url
        $okDl = (Test-Path $zip) -and (Get-Item $zip).Length -gt 5MB
    }
    if (-not $okDl) {
        Fail 'MediaMTX 下载失败。'
        Write-Host '        可以手动下载后解压到 bin\mediamtx\ ：' -ForegroundColor Yellow
        Write-Host "        https://github.com/bluenviron/mediamtx/releases/download/$ver/$asset" -ForegroundColor Yellow
        Write-Host '        国内可用加速前缀重跑：.\setup.ps1 -GithubMirror https://ghfast.top/' -ForegroundColor Yellow
        exit 1
    }
    Expand-Archive -Path $zip -DestinationPath $mtxDir -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $mtxExe)) { Fail "解压后没找到 mediamtx.exe，请检查 $mtxDir"; exit 1 }
    Ok "MediaMTX $ver 已就位（MIT 许可，见 bin\mediamtx\LICENSE）"
}

# ---------------------------------------------------------------- 3. 生成 mediamtx.yml
Say '生成 MediaMTX 配置'
$tpl = Join-Path $root 'config\mediamtx.yml.template'
$mtxYml = Join-Path $mtxDir 'mediamtx.yml'
if (-not (Test-Path $tpl)) { Fail "缺少模板 $tpl"; exit 1 }
if ((Test-Path $mtxYml) -and -not $Force) {
    Ok 'mediamtx.yml 已存在，保留（要覆盖请加 -Force）'
} else {
    $t = Get-Content $tpl -Raw -Encoding UTF8
    $t = $t.Replace('{{ROOT}}', $root.Replace('\', '/')).Replace('{{FFMPEG}}', $ffmpegFwd)
    [System.IO.File]::WriteAllText($mtxYml, $t, (New-Object System.Text.UTF8Encoding($false)))
    Ok "已生成 $mtxYml"
}

# ---------------------------------------------------------------- 4. 生成 config.json / names.txt
Say '生成中枢配置'
$dataDir = Join-Path $root 'data'
$cfgPath = Join-Path $dataDir 'config.json'
if ((Test-Path $cfgPath) -and -not $Force) {
    Ok 'data\config.json 已存在，保留（要覆盖请加 -Force）'
} else {
    $ex = Join-Path $root 'config\config.example.json'
    $cfg = Get-Content $ex -Raw -Encoding UTF8 | ConvertFrom-Json
    # 生成每台机器独立的 hostKey（主机消息窗用它鉴权，不能是固定值）
    $key = -join ((48..57) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
    $cfg.hostKey = $key
    $cfg | ConvertTo-Json -Depth 8 | Set-Content $cfgPath -Encoding UTF8
    Ok "已生成 data\config.json（hostKey 随机生成）"
}

$namesPath = Join-Path $dataDir 'names.txt'
if ((Test-Path $namesPath) -and -not $Force) {
    Ok 'data\names.txt 已存在，保留（要覆盖请加 -Force）'
} else {
    Copy-Item (Join-Path $root 'config\names.example.txt') $namesPath -Force
    Ok '已生成 data\names.txt —— 记得改成真实名单！'
}

# ---------------------------------------------------------------- 5. Node 依赖
Say '安装 Node 依赖'
Push-Location (Join-Path $root 'server')
try {
    & npm install --no-audit --no-fund 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Warn '默认源安装失败，改用 npmmirror 重试...'
        & npm install --registry=https://registry.npmmirror.com --no-audit --no-fund 2>&1 | Out-Null
    }
    if (Test-Path (Join-Path $root 'server\node_modules\ws')) { Ok 'ws 模块已安装' }
    else { Fail '依赖安装失败，请进 server 目录手动执行 npm install'; }
} finally { Pop-Location }

# ---------------------------------------------------------------- 6. 桌面快捷方式
if (-not $NoShortcuts) {
    Say '创建桌面快捷方式'
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $ps = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
        if (-not $ps) { $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" }
        $ws = New-Object -ComObject WScript.Shell

        $a = $ws.CreateShortcut((Join-Path $desktop '开始直播.lnk'))
        $a.TargetPath       = $ps
        $a.Arguments        = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\start-all.ps1`""
        $a.WorkingDirectory = $root
        if (Test-Path (Join-Path $root 'live.ico')) { $a.IconLocation = (Join-Path $root 'live.ico') + ',0' }
        $a.Description = '启动直播中枢：媒体服务 + 聊天 + 右下角置顶消息窗'
        $a.Save()

        $b = $ws.CreateShortcut((Join-Path $desktop '结束直播.lnk'))
        $b.TargetPath       = $ps
        $b.Arguments        = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\stop-all.ps1`""
        $b.WorkingDirectory = $root
        if (Test-Path (Join-Path $root 'stop.ico')) { $b.IconLocation = (Join-Path $root 'stop.ico') + ',0' }
        $b.Description = '停止直播中枢的全部服务'
        $b.Save()

        Ok "已创建：开始直播.lnk / 结束直播.lnk  ->  $desktop"
    } catch { Warn "创建快捷方式失败（不影响使用）: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------- 完成
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
Write-Host ''
Write-Host '================== 安装完成 ==================' -ForegroundColor Green
Write-Host ''
Write-Host ' 下一步：' -ForegroundColor Cyan
Write-Host '   1. 编辑 data\names.txt   改成你的观众名单（一行一个真名）'
Write-Host '   2. 双击桌面「开始直播」（或运行 .\start-all.ps1）'
Write-Host '   3. OBS -> 设置 -> 直播：' -ForegroundColor Yellow
Write-Host '        服务   : WHIP'
Write-Host '        服务器 : http://127.0.0.1:8889/live/whip'
Write-Host '        令牌   : 留空'
Write-Host '      设置 -> 视频：输出分辨率 1920x1080'
Write-Host '      （务必用 WHIP。用 RTMP 推流时音轨是 AAC，WebRTC 会丢掉它，' -ForegroundColor Yellow
Write-Host '        局域网观众就只剩画面没声音）' -ForegroundColor Yellow
Write-Host '   4. 局域网入口（发给校内同学）：'
$routes = $null
Write-Host '        启动后终端会打印，形如 http://192.168.x.x:7000'
Write-Host '   5. 外网入口：需要自己做端口穿透（见 README 的「让外网看到」一节）'
Write-Host ''
Write-Host " 主机消息窗地址（本机打开）：http://127.0.0.1:$($cfg.port)/host?key=$($cfg.hostKey)"
Write-Host ''
Write-Host '==============================================' -ForegroundColor Green
