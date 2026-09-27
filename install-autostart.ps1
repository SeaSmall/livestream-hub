# =====================================================================
# 注册/取消开机自启（登录时自动拉起直播中枢）
#   .\install-autostart.ps1           注册
#   .\install-autostart.ps1 -Remove   取消
# =====================================================================
param([switch]$Remove)

$taskName = 'LivestreamHub'
$root = $PSScriptRoot
$script = Join-Path $root 'start-all.ps1'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已取消开机自启: $taskName" -ForegroundColor Yellow
    return
}

if (-not (Test-Path $script)) { Write-Host "找不到 $script" -ForegroundColor Red; return }

# 用系统自带的 powershell.exe（5.1）最稳；注意 .ps1 必须是 UTF-8 with BOM，
# 否则 5.1 会按 ANSI 解码，中文注释变乱码直接语法报错。
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

$action = New-ScheduledTaskAction -Execute $ps `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'OBS 直播中枢: MediaMTX + 入口分流/聊天服务' -Force | Out-Null

Write-Host "已注册开机自启: $taskName" -ForegroundColor Green
Write-Host "  登录后自动执行: $script"
Write-Host "  查看状态: Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo"
Write-Host "  立即测试: Start-ScheduledTask -TaskName $taskName"
Write-Host "  取消:     .\install-autostart.ps1 -Remove"
