# =====================================================================
#  Generate the launcher icons (live.ico / stop.ico)
#
#  Draws a rounded gradient tile with a play triangle + red LIVE dot (live),
#  or a red tile with a stop square (stop), then packs several sizes into a
#  Vista-style .ico (PNG payloads).
#
#  Usage:
#    .\tools\make-icon.ps1                          regenerate both icons
#    .\tools\make-icon.ps1 -Variant live
#    .\tools\make-icon.ps1 -Variant stop -Out C:\tmp\my.ico
#
#  ASCII-only on purpose: avoids ANSI / UTF-8 BOM decoding surprises.
# =====================================================================
param(
    [ValidateSet('live', 'stop', 'both')]
    [string]$Variant = 'both',
    [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# 脚本在 tools\ 下，图标输出到项目根目录
$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

function New-LiveTile([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $c1 = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)
    $c2 = [System.Drawing.Color]::FromArgb(255, 124, 58, 237)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)

    $r = [single]($size * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r, $r, 180, 90)
    $path.AddArc($size - $r, 0, $r, $r, 270, 90)
    $path.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
    $path.AddArc(0, $size - $r, $r, $r, 90, 90)
    $path.CloseFigure()
    $g.FillPath($brush, $path)

    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 255, 255, 255), [single]([Math]::Max(1, $size * 0.012)))
    $g.DrawPath($pen, $path)

    $wb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $pts = @(
        (New-Object System.Drawing.PointF([single]($size * 0.38), [single]($size * 0.28))),
        (New-Object System.Drawing.PointF([single]($size * 0.38), [single]($size * 0.72))),
        (New-Object System.Drawing.PointF([single]($size * 0.73), [single]($size * 0.50)))
    )
    $g.FillPolygon($wb, $pts)

    $d  = [single]($size * 0.26)
    $dx = [single]($size - $d - $size * 0.05)
    $dy = [single]($size * 0.05)
    $ring = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillEllipse($ring, [single]($dx - $size * 0.025), [single]($dy - $size * 0.025), [single]($d + $size * 0.05), [single]($d + $size * 0.05))
    $dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 239, 68, 68))
    $g.FillEllipse($dot, $dx, $dy, $d, $d)

    $g.Dispose()
    return $bmp
}

function New-StopTile([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $c1 = [System.Drawing.Color]::FromArgb(255, 220, 38, 38)
    $c2 = [System.Drawing.Color]::FromArgb(255, 120, 20, 20)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)

    $r = [single]($size * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r, $r, 180, 90)
    $path.AddArc($size - $r, 0, $r, $r, 270, 90)
    $path.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
    $path.AddArc(0, $size - $r, $r, $r, 90, 90)
    $path.CloseFigure()
    $g.FillPath($brush, $path)

    $sq = [single]($size * 0.40)
    $x  = [single](($size - $sq) / 2)
    $wb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillRectangle($wb, $x, $x, $sq, $sq)

    $g.Dispose()
    return $bmp
}

function Write-Ico([string]$file, [scriptblock]$drawer, [int[]]$sizes) {
    $payloads = @()
    foreach ($s in $sizes) {
        $bmp = & $drawer $s
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $payloads += [pscustomobject]@{ size = $s; bytes = $ms.ToArray() }
        $ms.Dispose(); $bmp.Dispose()
    }

    $dir = Split-Path -Parent $file
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    $fs = [System.IO.File]::Create($file)
    $bw = New-Object System.IO.BinaryWriter($fs)
    $bw.Write([UInt16]0)                  # reserved
    $bw.Write([UInt16]1)                  # type = icon
    $bw.Write([UInt16]$payloads.Count)

    $offset = 6 + 16 * $payloads.Count
    foreach ($p in $payloads) {
        $dim = if ($p.size -ge 256) { 0 } else { $p.size }   # 0 means 256
        $bw.Write([Byte]$dim); $bw.Write([Byte]$dim)
        $bw.Write([Byte]0); $bw.Write([Byte]0)
        $bw.Write([UInt16]1); $bw.Write([UInt16]32)
        $bw.Write([UInt32]$p.bytes.Length); $bw.Write([UInt32]$offset)
        $offset += $p.bytes.Length
    }
    foreach ($p in $payloads) { $bw.Write($p.bytes) }
    $bw.Flush(); $bw.Close(); $fs.Close()

    Write-Host ("  {0}  ({1} bytes, sizes {2})" -f $file, (Get-Item $file).Length, ($sizes -join '/'))
}

$sizes = @(256, 64, 48, 32, 16)
$explicitOut = [bool]$Out

if ($Variant -eq 'live' -or $Variant -eq 'both') {
    $f = if ($explicitOut) { $Out } else { Join-Path $root 'live.ico' }
    Write-Ico $f ${function:New-LiveTile} $sizes
}
if ($Variant -eq 'stop' -or $Variant -eq 'both') {
    $f = if ($explicitOut) { $Out } else { Join-Path $root 'stop.ico' }
    Write-Ico $f ${function:New-StopTile} $sizes
}

Write-Host 'done.'
