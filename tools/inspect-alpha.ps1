# Diagnostics for a transparent PNG: alpha bbox + aspect ratio.
param([string]$Path)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $Path
$rect = New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $bmp.Height)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($data)
$minX = $bmp.Width; $minY = $bmp.Height; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $bmp.Height; $y++) {
  for ($x = 0; $x -lt $bmp.Width; $x++) {
    $a = $bytes[$y * $data.Stride + $x * 4 + 3]
    if ($a -gt 16) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
$w = $maxX - $minX + 1; $h = $maxY - $minY + 1
Write-Output ("bbox: {0},{1} - {2},{3}   image: {4}x{5}   content aspect: {6}" -f $minX, $minY, $maxX, $maxY, $bmp.Width, $bmp.Height, [Math]::Round($w / $h, 3))
# mean alpha of content center (is the glass see-through?)
$cx1 = $minX + [int]($w * 0.35); $cx2 = $minX + [int]($w * 0.65)
$cy1 = $minY + [int]($h * 0.45); $cy2 = $minY + [int]($h * 0.7)
$sum = 0; $n = 0
for ($y = $cy1; $y -lt $cy2; $y++) {
  for ($x = $cx1; $x -lt $cx2; $x++) {
    $sum += $bytes[$y * $data.Stride + $x * 4 + 3]; $n++
  }
}
Write-Output ("center mean alpha: " + [Math]::Round($sum / [Math]::Max($n, 1), 1))
$bmp.Dispose()
