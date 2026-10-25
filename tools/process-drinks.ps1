# Post-process drink-src/*.png -> drink-N.png
# Sample juice color from cup body region (below cream lid), map to 8 color indices,
# alpha-crop, resize to height 120, save as drink-{index}.png
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$srcDir = 'G:\prj\presonal\water-sort\assets\images\drink-src'
$outDir = 'G:\prj\presonal\water-sort\assets\images'
$targets = @(
    @(0xF9,0x4F,0x6D), @(0xFF,0x98,0x38), @(0xFF,0xC9,0x33), @(0x8B,0xD4,0x50),
    @(0x5B,0x8D,0xEF), @(0xA2,0x6B,0xF2), @(0xF3,0xEA,0xD7), @(0x4F,0xB0,0x8C)
)

function Get-BBox($bmp) {
    $top = 0; $bot = $bmp.Height - 1; $left = 0; $right = $bmp.Width - 1
    $found = $false
    for ($y = 0; $y -lt $bmp.Height -and -not $found; $y++) {
        for ($x = 0; $x -lt $bmp.Width; $x++) {
            if ($bmp.GetPixel($x, $y).A -gt 32) { $top = $y; $found = $true; break }
        }
    }
    $found = $false
    for ($y = $bmp.Height - 1; $y -ge 0 -and -not $found; $y--) {
        for ($x = 0; $x -lt $bmp.Width; $x++) {
            if ($bmp.GetPixel($x, $y).A -gt 32) { $bot = $y; $found = $true; break }
        }
    }
    $found = $false
    for ($x = 0; $x -lt $bmp.Width -and -not $found; $x++) {
        for ($y = 0; $y -lt $bmp.Height; $y++) {
            if ($bmp.GetPixel($x, $y).A -gt 32) { $left = $x; $found = $true; break }
        }
    }
    $found = $false
    for ($x = $bmp.Width - 1; $x -ge 0 -and -not $found; $x--) {
        for ($y = 0; $y -lt $bmp.Height; $y++) {
            if ($bmp.GetPixel($x, $y).A -gt 32) { $right = $x; $found = $true; break }
        }
    }
    return @($left, $top, $right, $bot)
}

$files = Get-ChildItem $srcDir -Recurse -Filter *.png
$assigned = @{}
foreach ($f in $files) {
    $bmp = [System.Drawing.Bitmap]::FromFile($f.FullName)
    $bb = Get-BBox $bmp
    $cw = $bb[2] - $bb[0] + 1
    $ch = $bb[3] - $bb[1] + 1
    # sample juice body: x 35%~65%, y 52%~78% of content
    $r = 0.0; $g = 0.0; $b = 0.0; $n = 0
    $x0 = [int]($bb[0] + $cw * 0.35); $x1 = [int]($bb[0] + $cw * 0.65)
    $y0 = [int]($bb[1] + $ch * 0.52); $y1 = [int]($bb[1] + $ch * 0.78)
    for ($y = $y0; $y -le $y1; $y += 3) {
        for ($x = $x0; $x -le $x1; $x += 3) {
            $p = $bmp.GetPixel($x, $y)
            if ($p.A -gt 128) { $r += $p.R; $g += $p.G; $b += $p.B; $n++ }
        }
    }
    if ($n -eq 0) { $bmp.Dispose(); Write-Output "SKIP no opaque sample: $($f.Name)"; continue }
    $avg = @([int]($r / $n), [int]($g / $n), [int]($b / $n))
    $best = 0; $bestD = [double]::MaxValue
    for ($i = 0; $i -lt $targets.Count; $i++) {
        $d = [math]::Pow($avg[0] - $targets[$i][0], 2) + [math]::Pow($avg[1] - $targets[$i][1], 2) + [math]::Pow($avg[2] - $targets[$i][2], 2)
        if ($d -lt $bestD) { $bestD = $d; $best = $i }
    }
    if ($assigned.ContainsKey($best)) { $bmp.Dispose(); Write-Output ("SKIP duplicate color {0}: {1}" -f $best, $f.Name); continue }
    $assigned[$best] = $true

    # crop + resize to height 120
    $newW = [int]($cw * 120 / $ch)
    if ($newW -lt 1) { $newW = 1 }
    $crop = $bmp.Clone((New-Object System.Drawing.Rectangle -ArgumentList $bb[0], $bb[1], $cw, $ch), $bmp.PixelFormat)
    $dst = New-Object System.Drawing.Bitmap $newW, 120
    $g2 = [System.Drawing.Graphics]::FromImage($dst)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($crop, 0, 0, $newW, 120)
    $g2.Dispose()
    $outPath = Join-Path $outDir ("drink-{0}.png" -f $best)
    $dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $dst.Dispose(); $crop.Dispose(); $bmp.Dispose()
    Write-Output ("{0} -> drink-{1}.png  avg=({2},{3},{4}) d={5}" -f $f.Name, $best, $avg[0], $avg[1], $avg[2], [int]$bestD)
}
$missing = @()
for ($i = 0; $i -lt 8; $i++) { if (-not $assigned.ContainsKey($i)) { $missing += $i } }
Write-Output ("missing: {0}" -f ($missing -join ','))
