# Post-process liquid-src/*.png -> liquid-N.png (132x140 capsule)
# 1. Map each source image to color index by average opaque color
# 2. Find domeEnd / curveStart by row-width scan
# 3. Compose: top region -> rows 0..59, bottom region -> rows 60..139
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$srcDir = 'G:\prj\presonal\water-sort\assets\images\liquid-src'
$outDir = 'G:\prj\presonal\water-sort\assets\images'
$targets = @(
    @(0xF9,0x4F,0x6D), @(0xFF,0x98,0x38), @(0xFF,0xC9,0x33), @(0x8B,0xD4,0x50),
    @(0x5B,0x8D,0xEF), @(0xA2,0x6B,0xF2), @(0xF3,0xEA,0xD7), @(0x4F,0xB0,0x8C)
)

function Get-AvgColor($bmp) {
    $r = 0.0; $g = 0.0; $b = 0.0; $n = 0
    for ($y = 0; $y -lt $bmp.Height; $y += 4) {
        for ($x = 0; $x -lt $bmp.Width; $x += 4) {
            $p = $bmp.GetPixel($x, $y)
            if ($p.A -gt 128) { $r += $p.R; $g += $p.G; $b += $p.B; $n++ }
        }
    }
    if ($n -eq 0) { return $null }
    return @([int]($r / $n), [int]($g / $n), [int]($b / $n))
}

function Get-ColorIndex($avg) {
    $best = 0; $bestD = [double]::MaxValue
    for ($i = 0; $i -lt $targets.Count; $i++) {
        $d = [math]::Pow($avg[0] - $targets[$i][0], 2) + [math]::Pow($avg[1] - $targets[$i][1], 2) + [math]::Pow($avg[2] - $targets[$i][2], 2)
        if ($d -lt $bestD) { $bestD = $d; $best = $i }
    }
    return $best
}

function Get-RowWidths($bmp) {
    $widths = @()
    $maxW = 0
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
    return @{ widths = $widths; maxW = $maxW }
}

$files = Get-ChildItem $srcDir -Filter *.png
$assigned = @{}
foreach ($f in $files) {
    $bmp = [System.Drawing.Bitmap]::FromFile($f.FullName)
    # crop to opaque bounding box
    $scan = Get-RowWidths $bmp
    $top = 0; $bot = $bmp.Height - 1
    while ($top -lt $bmp.Height -and $scan.widths[$top] -eq 0) { $top++ }
    while ($bot -gt $top -and $scan.widths[$bot] -eq 0) { $bot-- }
    $h = $bot - $top + 1
    $avg = Get-AvgColor $bmp
    $ci = Get-ColorIndex $avg
    if ($assigned.ContainsKey($ci)) { $bmp.Dispose(); Write-Output "SKIP duplicate color $ci : $($f.Name)"; continue }
    $assigned[$ci] = $true

    # find domeEnd (first row >= 97% maxW) and curveStart (last full row before narrowing)
    $th = [int]($scan.maxW * 0.97)
    $domeEnd = $top
    while ($domeEnd -lt $bot -and $scan.widths[$domeEnd] -lt $th) { $domeEnd++ }
    $curveStart = $bot
    while ($curveStart -gt $domeEnd -and $scan.widths[$curveStart] -lt $th) { $curveStart-- }
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
    $outPath = Join-Path $outDir ("liquid-{0}.png" -f $ci)
    $dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $dst.Dispose(); $bmp.Dispose()
    Write-Output ("{0} -> liquid-{1}.png  (domeEnd={2} curveStart={3} h={4})" -f $f.Name, $ci, $domeEnd, $curveStart, $h)
}
Write-Output 'done'
