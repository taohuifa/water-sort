# Asset compression pipeline for water-sort images.
# - Scene backgrounds: PNG -> JPEG quality 80 (750x1624 = 2x screen).
# - Transparent assets (bottle / icons): crop alpha bbox, resize to 2x usage size.
# Usage: powershell -File tools\compress-assets.ps1
param(
  [string]$Dir = "$PSScriptRoot\..\assets\images"
)

Add-Type -AssemblyName System.Drawing

function Save-Jpeg($img, $path, $quality = 80) {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
  $img.Save($path, $codec, $ep)
}

function Get-AlphaBBox($bmp) {
  $rect = New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $minX = $bmp.Width; $minY = $bmp.Height; $maxX = -1; $maxY = -1
  $row = New-Object byte[] ($data.Stride)
  for ($y = 0; $y -lt $bmp.Height; $y++) {
    [System.Runtime.InteropServices.Marshal]::Copy([IntPtr]::Add($data.Scan0, $y * $data.Stride), $row, 0, $data.Stride)
    for ($x = 0; $x -lt $bmp.Width; $x++) {
      if ($row[$x * 4 + 3] -gt 16) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $bmp.UnlockBits($data)
  if ($maxX -lt 0) { return $null }
  return New-Object System.Drawing.Rectangle $minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1)
}

function Get-CenterMeanAlpha($bmp) {
  $rect = New-Object System.Drawing.Rectangle ([int]($bmp.Width * 0.35)), ([int]($bmp.Height * 0.5)), ([int]($bmp.Width * 0.3)), ([int]($bmp.Height * 0.3))
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes = New-Object byte[] ($data.Stride * $rect.Height)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($data)
  $sum = 0; $n = 0
  for ($i = 3; $i -lt $bytes.Length; $i += 4) { $sum += $bytes[$i]; $n++ }
  return [Math]::Round($sum / [Math]::Max($n, 1), 1)
}

function Convert-TransparentAsset($srcName, $dstName, $targetW, $targetH) {
  $srcPath = Join-Path $Dir $srcName
  $dstPath = Join-Path $Dir $dstName
  $src = [System.Drawing.Image]::FromFile($srcPath)
  $bmp = New-Object System.Drawing.Bitmap $src
  $src.Dispose()
  $bbox = Get-AlphaBBox $bmp
  if ($bbox) {
    $crop = $bmp.Clone($bbox, $bmp.PixelFormat)
    $bmp.Dispose()
    $bmp = $crop
  }
  Write-Output ("{0}: cropped {1}x{2}, center mean alpha = {3}" -f $dstName, $bmp.Width, $bmp.Height, (Get-CenterMeanAlpha $bmp))
  $out = New-Object System.Drawing.Bitmap $targetW, $targetH
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($bmp, 0, 0, $targetW, $targetH)
  $g.Dispose()
  $bmp.Dispose()
  $out.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Remove-Item $srcPath -Force
}

function Convert-Icon($srcName, $dstName, $canvas = 112, $maxSide = 96) {
  $srcPath = Join-Path $Dir $srcName
  $dstPath = Join-Path $Dir $dstName
  $src = [System.Drawing.Image]::FromFile($srcPath)
  $bmp = New-Object System.Drawing.Bitmap $src
  $src.Dispose()
  $bbox = Get-AlphaBBox $bmp
  if ($bbox) {
    $crop = $bmp.Clone($bbox, $bmp.PixelFormat)
    $bmp.Dispose()
    $bmp = $crop
  }
  $scale = $maxSide / [Math]::Max($bmp.Width, $bmp.Height)
  $w = [int]($bmp.Width * $scale); $h = [int]($bmp.Height * $scale)
  $out = New-Object System.Drawing.Bitmap $canvas, $canvas
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($bmp, [int](($canvas - $w) / 2), [int](($canvas - $h) / 2), $w, $h)
  $g.Dispose()
  $bmp.Dispose()
  $out.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Remove-Item $srcPath -Force
}

# --- scene backgrounds: PNG -> JPG ---
$bgMap = @{
  '1792911238-image.png' = 'bg-menu.jpg'
  '1792911233-image.png' = 'bg-levels.jpg'
  '1792911229-image.png' = 'bg-settings.jpg'
}
foreach ($pair in $bgMap.GetEnumerator()) {
  $img = [System.Drawing.Image]::FromFile((Join-Path $Dir $pair.Key))
  Save-Jpeg $img (Join-Path $Dir $pair.Value)
  $img.Dispose()
  Remove-Item (Join-Path $Dir $pair.Key) -Force
  Write-Output ("bg -> {0}" -f $pair.Value)
}

# --- bottle glass sprite: crop + resize to 132x169 (2x of 66x85 max bottle) ---
Convert-TransparentAsset '1792911266-15-85.png' 'bottle-glass.png' 132 169

# --- button icons: crop + fit into 112x112 canvas (2x of r=28 circle) ---
$iconMap = @{
  '1792911265-UI.png' = 'icon-back.png'
  '1792911261-UI.png' = 'icon-undo.png'
  '1792911264-UI.png' = 'icon-shuffle.png'
  '1792911291-UI.png' = 'icon-add.png'
  '1792911292-UI.png' = 'icon-restart.png'
}
foreach ($pair in $iconMap.GetEnumerator()) {
  Convert-Icon $pair.Key $pair.Value
}

Get-ChildItem $Dir | Select-Object Name, Length
