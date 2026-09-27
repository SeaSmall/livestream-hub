# =====================================================================
# 主机端「观众消息」置顶小窗
#   右下角停靠 + 始终置顶 + 无地址栏，只读展示观众聊天与流量
#
# 用法:
#   .\host-window.ps1              打开（已开则重新置顶）
#   .\host-window.ps1 -Keep        打开并常驻看守置顶（每 5 秒重新压一次）
#   .\host-window.ps1 -Close       关闭
#   .\host-window.ps1 -Width 460 -Height 320 -Margin 16
# =====================================================================
param(
    [switch]$Keep,
    [switch]$Close,
    [int]$Width = 400,
    [int]$Height = 280,
    [int]$Margin = 12
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$cfgPath = Join-Path $root 'data\config.json'
if (-not (Test-Path $cfgPath)) { Write-Host "缺少 $cfgPath，请先运行 .\setup.ps1" -ForegroundColor Red; return }
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$port = if ($cfg.port) { $cfg.port } else { 7000 }
$url = "http://127.0.0.1:$port/host?key=$($cfg.hostKey)"
$title = '观众消息'
$profileDir = Join-Path $root 'data\hostwin-profile'

if (-not ('WinApi' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinApi {
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
}
'@
}
$HWND_TOPMOST   = [IntPtr](-1)
$SWP_SHOWWINDOW = 0x0040

function Get-HostWindowHandle {
    # 用进程的 MainWindowTitle 找更稳: Edge 应用窗口标题就是网页 title，
    # FindWindow 的精确匹配在 Edge 上不可靠，且冷启动可能超过 10 秒。
    $p = Get-Process -Name 'msedge', 'chrome' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$title*" } |
        Select-Object -First 1
    if ($p) { return $p.MainWindowHandle }
    return [IntPtr]::Zero
}

function Get-WorkArea {
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        return @{ X = $wa.X; Y = $wa.Y; W = $wa.Width; H = $wa.Height }
    } catch {
        try {
            $v = Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution } | Select-Object -First 1
            return @{ X = 0; Y = 0; W = [int]$v.CurrentHorizontalResolution; H = [int]$v.CurrentVerticalResolution }
        } catch { return @{ X = 0; Y = 0; W = 1920; H = 1080 } }
    }
}

if ($Close) {
    $h = Get-HostWindowHandle
    if ($h -ne [IntPtr]::Zero) { [WinApi]::ShowWindow($h, 0) | Out-Null }
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'hostwin-profile' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host '主机消息窗已关闭' -ForegroundColor Yellow
    return
}

try { $null = Invoke-WebRequest "http://127.0.0.1:$port/probe" -TimeoutSec 4 -UseBasicParsing }
catch { Write-Host "中央服务($port)不可达，请先运行 .\start-all.ps1" -ForegroundColor Red; return }

$wa = Get-WorkArea
$posX = [Math]::Max(0, $wa.X + $wa.W - $Width - $Margin)
$posY = [Math]::Max(0, $wa.Y + $wa.H - $Height - $Margin)
$h = Get-HostWindowHandle

if ($h -eq [IntPtr]::Zero) {
    $edge = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $edge) { Write-Host '找不到 Edge 或 Chrome' -ForegroundColor Red; return }

    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    Start-Process -FilePath $edge -ArgumentList @(
        "--app=$url",
        "--user-data-dir=$profileDir",
        "--window-size=$Width,$Height",
        "--window-position=$posX,$posY",
        '--no-first-run', '--no-default-browser-check',
        '--disable-features=Translate,msEdgeTranslate',
        '--autoplay-policy=no-user-gesture-required'
    ) -WindowStyle Normal | Out-Null

    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        $h = Get-HostWindowHandle
        if ($h -ne [IntPtr]::Zero) { break }
    }
}

if ($h -eq [IntPtr]::Zero) {
    Write-Host '未能定位到消息窗，手动打开这个地址即可：' -ForegroundColor Yellow
    Write-Host "  $url"
    return
}

function Assert-TopMost($handle) {
    [WinApi]::SetWindowPos($handle, $HWND_TOPMOST, $posX, $posY, $Width, $Height, $SWP_SHOWWINDOW) | Out-Null
}

Assert-TopMost $h
Write-Host "主机消息窗已就位: 右下角 ${Width}x${Height} 置顶" -ForegroundColor Green
Write-Host "  地址: $url"
Write-Host '  内容: 只读，展示观众发言 + 在线人数 + 隧道流量'

if ($Keep) {
    Write-Host '  看守模式: 每 5 秒重新压置顶（Ctrl+C 退出）' -ForegroundColor DarkGray
    while ($true) {
        Start-Sleep -Seconds 5
        if (-not [WinApi]::IsWindow($h)) {
            $h = Get-HostWindowHandle
            if ($h -eq [IntPtr]::Zero) { Write-Host '消息窗已关闭，看守退出'; break }
        }
        Assert-TopMost $h
    }
}
