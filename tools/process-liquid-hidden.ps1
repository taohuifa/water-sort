# Process the mystery (hidden-layer) liquid cylinder -> liquid-hidden.png (132x140)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$srcPath = 'G:\prj\presonal\water-sort\assets\images\liquid-src\1792930852-85.png'
$outPath = 'G:\prj\presonal\water-sort\assets\images\liquid-hidden.png'

$bmp = [System.Drawing.Bitmap]::FromFile($srcPath)
$widths = @(); $maxW = 0
for ($y = 0; $y -lt $bmp.Height; $y++) {
    $min = -1; $max = -1
    for ($x = 0; $x -lt $bmp.Width; $x++) {
        if ($bmp.GetPixel($x, $y).A -gt 32) {
            if ($min -lt 0) { $min = $x }
            $max = $x
        }
    }
    $w = 0; if ($min -ge 0) { $w = $max - $min + 1 }
    $widths += $w
    if ($w -gt $maxW) { $maxW = $w }
}
$top = 0; $bot = $bmp.Height - 1
while ($top -lt $bmp.Height -and $widths[$top] -eq 0) { $top++ }
while ($bot -gt $top -and $widths[$bot] -eq 0) { $bot-- }
$h = $bot - $top + 1
$th = [int]($maxW * 0.97)
$domeEnd = $top
while ($domeEnd -lt $bot -and $widths[$domeEnd] -lt $th) { $domeEnd++ }
$curveStart = $bot
while ($curveStart -gt $domeEnd -and $widths[$curveStart] -lt $th) { $curveStart-- }
$pad = [int]($h * 0.04)
$srcTopEnd = $domeEnd + $pad
if ($srcTopEnd -gt ($curveStart - 1)) { $srcTopEnd = $curveStart - 1 }
$srcBotStart = $curveStart - $pad
if ($srcBotStart -lt ($domeEnd + 1)) { $srcBotStart = $domeEnd + 1 }
$srcTopH = $srcTopEnd - $top + 1
$srcBotH = $bot - $srcBotStart + 1

$dst = New-Object System.Drawing.Bitmap 132, 140
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$srcRectTop = New-Object System.Drawing.Rectangle -ArgumentList 0, $top, $bmp.Width, $srcTopH
$dstRectTop = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, 132, 60
$srcRectBot = New-Object System.Drawing.Rectangle -ArgumentList 0, $srcBotStart, $bmp.Width, $srcBotH
$dstRectBot = New-Object System.Drawing.Rectangle -ArgumentList 0, 60, 132, 80
$g.DrawImage($bmp, $dstRectTop, $srcRectTop, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawImage($bmp, $dstRectBot, $srcRectBot, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$dst.Dispose(); $bmp.Dispose()
Write-Output ("liquid-hidden.png saved (domeEnd={0} curveStart={1} h={2})" -f $domeEnd, $curveStart, $h)
