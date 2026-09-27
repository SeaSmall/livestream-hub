# =====================================================================
# 直播中枢 —— 一键启动
#   MediaMTX(媒体服务器) + Node 中央服务(入口分流/聊天/反代) + 主机消息窗
#
# 用法:
#   .\start-all.ps1                启动（已在运行则只确保消息窗，不打断直播）
#   .\start-all.ps1 -Restart       强制重启全部服务
#   .\start-all.ps1 -NoHostWindow  不打开主机消息窗
# =====================================================================
param(
    [switch]$NoHostWindow,
    [switch]$Restart
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 日志太大就重开，避免无限增长
$tlog = Join-Path $logDir 'start-all.log'
if ((Test-Path $tlog) -and (Get-Item $tlog).Length -gt 1MB) { Remove-Item $tlog -Force -ErrorAction SilentlyContinue }
try { Start-Transcript -Path $tlog -Append -Force | Out-Null } catch {}

function Write-Step($m) { Write-Host "[启动] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  OK   $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "  注意 $m" -ForegroundColor Yellow }

function Test-HubUp { [bool](Get-NetTCPConnection -State Listen -LocalPort 7000 -ErrorAction SilentlyContinue) }
function Test-MtxUp { [bool](Get-Process mediamtx -ErrorAction SilentlyContinue) }

# 前置检查：装过没有
$mtxExe = Join-Path $root 'bin\mediamtx\mediamtx.exe'
if (-not (Test-Path $mtxExe)) {
    Write-Host '还没安装。请先运行 .\setup.ps1' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $root 'data\config.json'))) {
    Write-Host '缺少 data\config.json。请先运行 .\setup.ps1' -ForegroundColor Red
    exit 1
}

if ((Test-HubUp) -and (Test-MtxUp) -and (-not $Restart)) {
    Write-Step '服务已在运行，跳过重启（要强制重启请加 -Restart）'
} else {
    if ($Restart) { Write-Step '按 -Restart 要求，强制重启全部服务' }

    # ---------- 1. 清理旧进程 ----------
    Write-Step '清理旧进程'
    foreach ($name in 'mediamtx', 'node') {
        Get-CimInstance Win32_Process -Filter "Name='$name.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($root) } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    $hubPid = (Get-NetTCPConnection -State Listen -LocalPort 7000 -ErrorAction SilentlyContinue).OwningProcess
    if ($hubPid) { Stop-Process -Id $hubPid -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2

    # ---------- 2. MediaMTX ----------
    Write-Step '启动 MediaMTX'
    Start-Process -FilePath $mtxExe -WorkingDirectory (Split-Path $mtxExe) -WindowStyle Hidden
    $ok = $false
    foreach ($i in 1..20) {
        Start-Sleep -Milliseconds 500
        if (Get-NetTCPConnection -State Listen -LocalPort 8888 -ErrorAction SilentlyContinue) { $ok = $true; break }
    }
    if ($ok) { Write-Ok 'MediaMTX 已监听 8888(HLS) / 8889(WebRTC) / 1935(RTMP) / 8554(RTSP) / 8189(UDP)' }
    else     { Write-Warn2 'MediaMTX 未在预期时间内监听，请查看 logs\mediamtx.log' }

    # ---------- 3. Node 中枢 ----------
    Write-Step '启动中央服务'
    Start-Process -FilePath 'node' -ArgumentList 'server.js' `
        -WorkingDirectory (Join-Path $root 'server') -WindowStyle Hidden
    $ok2 = $false
    foreach ($i in 1..20) {
        Start-Sleep -Milliseconds 500
        if (Test-HubUp) { $ok2 = $true; break }
    }
    if ($ok2) { Write-Ok '中央服务已监听 7000' }
    else      { Write-Warn2 '中央服务未启动，请查看 logs\server.log' }
}

# ---------- 4. 主机消息窗 ----------
if (-not $NoHostWindow) {
    Write-Step '打开主机消息窗（右下角置顶）'
    try {
        & (Join-Path $root 'host-window.ps1') | Out-Null
        Write-Ok '消息窗已就位'
    } catch { Write-Warn2 "消息窗打开失败: $($_.Exception.Message)" }
}

# ---------- 5. 汇总 ----------
Start-Sleep -Seconds 1
Write-Host ''
Write-Host '===================== 运行状态 =====================' -ForegroundColor Cyan
try {
    $cfg = Get-Content (Join-Path $root 'data\config.json') -Raw | ConvertFrom-Json
    $routes = Invoke-RestMethod 'http://127.0.0.1:7000/routes.json' -TimeoutSec 5
    Write-Host '  局域网入口（发给同一局域网的同学）:'
    foreach ($r in $routes.lan) { Write-Host "    $($r.url)   [$($r.iface)]" }
    Write-Host ''
    if ($cfg.publicUrl) {
        Write-Host '  外网入口（发给校外观众）:'
        Write-Host "    $($cfg.publicUrl)"
    } else {
        Write-Host '  外网入口: 未配置（编辑 data\config.json 的 publicUrl，见 README）' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host '  主机消息窗（本机打开）:'
    Write-Host "    http://127.0.0.1:$($cfg.port)/host?key=$($cfg.hostKey)"
    Write-Host ''
    $namesPath = Join-Path $root 'data\names.txt'
    $names = @(Get-Content $namesPath -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') }).Count
    $st = Invoke-RestMethod 'http://127.0.0.1:7000/api/stats' -TimeoutSec 5
    Write-Host "  白名单人数: $names" + $(if ($names -le 3) { '   <- 还是示例名单，记得改 data\names.txt' } else { '' })
    Write-Host "  本月隧道用量: $([math]::Round($st.wanBytes/1GB,2)) GB / $($cfg.quotaGB) GB"
} catch {
    Write-Warn2 "读取状态失败: $($_.Exception.Message)"
}
Write-Host '===================================================' -ForegroundColor Cyan
try { Stop-Transcript | Out-Null } catch {}
exit 0
