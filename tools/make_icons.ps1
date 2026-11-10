# LevelPlay Web: generate PWA icons (icon-192.png, icon-512.png)
# Same design as the exe version (tools/make_icon.ps1 in projects/levelplay).
# ASCII comments only (PowerShell 5.1 fails on UTF-8 without BOM).

Add-Type -AssemblyName System.Drawing
$outDir = Join-Path $PSScriptRoot "..\icons"

function New-RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

foreach ($S in @(192, 512)) {
    $k = $S / 256.0
    $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)

    $m = 8 * $k
    $bg = New-RoundRect $m $m ($S - 2 * $m) ($S - 2 * $m) (52 * $k)
    $c1 = [System.Drawing.Color]::FromArgb(255, 38, 198, 182)
    $c2 = [System.Drawing.Color]::FromArgb(255, 26, 92, 141)
    $lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point($S, $S)), $c1, $c2)
    $g.FillPath($lg, $bg)

    $wb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $tri = @(
        (New-Object System.Drawing.PointF((101 * $k), (72 * $k))),
        (New-Object System.Drawing.PointF((101 * $k), (156 * $k))),
        (New-Object System.Drawing.PointF((180 * $k), (114 * $k)))
    )
    $g.FillPolygon($wb, $tri)

    $bb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
    for ($i = 0; $i -lt 5; $i++) {
        $bx = (53 + $i * 30) * $k
        $g.FillPath($bb, (New-RoundRect $bx (170 * $k) (16 * $k) (40 * $k) (5 * $k)))
    }

    $path = Join-Path $outDir ("icon-{0}.png" -f $S)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output "saved $path"
}
