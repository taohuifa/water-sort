param(
    [Parameter(Mandatory = $true)][string]$Src,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$X = 0, [int]$Y = 0, [int]$W = 420, [int]$H = 900,
    [int]$Scale = 2
)
# 通用截图裁剪放大：Src 为 screenshots 下文件名（不含路径），Out 同
Add-Type -AssemblyName System.Drawing
$srcPath = "G:\prj\presonal\water-sort\screenshots\$Src"
$outPath = "G:\prj\presonal\water-sort\screenshots\$Out"
$bmp = [System.Drawing.Bitmap]::FromFile($srcPath)
$rect = New-Object System.Drawing.Rectangle -ArgumentList $X, $Y, $W, $H
$crop = $bmp.Clone($rect, $bmp.PixelFormat)
$big = New-Object System.Drawing.Bitmap -ArgumentList ($crop, [int]($W * $Scale), [int]($H * $Scale))
$big.Save($outPath)
$bmp.Dispose(); $crop.Dispose(); $big.Dispose()
Write-Output "saved $Out"
