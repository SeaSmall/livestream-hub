# 停止直播中枢全部服务
$root = $PSScriptRoot

Write-Host '[停止] 关闭中央服务...' -ForegroundColor Cyan
$hubPid = (Get-NetTCPConnection -State Listen -LocalPort 7000 -ErrorAction SilentlyContinue).OwningProcess
if ($hubPid) { Stop-Process -Id $hubPid -Force -ErrorAction SilentlyContinue; Write-Host '  OK 中央服务已停止' -ForegroundColor Green }
else { Write-Host '  中央服务本来就没在跑' -ForegroundColor DarkGray }

Write-Host '[停止] 关闭 MediaMTX 及其转码进程...' -ForegroundColor Cyan
Get-Process -Name mediamtx -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match '8554/(wan|lanav)' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host '  OK 已停止' -ForegroundColor Green

Start-Sleep -Seconds 1
$left = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 7000, 8888, 8889, 1935, 8554, 9997 }
if ($left) { Write-Host "  仍占用端口: $($left.LocalPort -join ', ')" -ForegroundColor Yellow }
else { Write-Host '  端口已全部释放' -ForegroundColor Green }
