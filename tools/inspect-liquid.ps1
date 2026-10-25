param(
    [string]$Path = 'G:\prj\presonal\water-sort\assets\images\liquid-0.png'
)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Path)
Write-Output ("size: {0}x{1}" -f $bmp.Width, $bmp.Height)
# 每隔 5 行扫一次：统计 alpha>16 的像素横向跨度
for ($y = 0; $y -lt $bmp.Height; $y += 5) {
    $min = -1; $max = -1
    for ($x = 0; $x -lt $bmp.Width; $x++) {
        if ($bmp.GetPixel($x, $y).A -gt 16) {
            if ($min -lt 0) { $min = $x }
            $max = $x
        }
    }
    if ($min -ge 0) {
        Write-Output ("y={0,4}  span=[{1,3},{2,3}]  width={3}" -f $y, $min, $max, ($max - $min + 1))
    } else {
        Write-Output ("y={0,4}  EMPTY" -f $y)
    }
}
$bmp.Dispose()
