# 将 liquid-0~7.png 裁短：顶部 60px（圆顶+短直筒）+ 原图 [355,435) 80px（短直筒+圆底）
# 新图 132x140 紧凑胶囊；原图备份到 liquid-src-435px/
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$dir = 'G:\prj\presonal\water-sort\assets\images'
$bak = Join-Path $dir 'liquid-src-435px'
if (-not (Test-Path $bak)) { New-Item -ItemType Directory -Path $bak | Out-Null }

for ($c = 0; $c -lt 8; $c++) {
    $name = "liquid-$c.png"
    $path = Join-Path $dir $name
    $backup = Join-Path $bak $name
    if (-not (Test-Path $backup)) { Copy-Item $path $backup }

    $src = [System.Drawing.Bitmap]::FromFile($backup)
    $dst = New-Object System.Drawing.Bitmap 132, 140
    $g = [System.Drawing.Graphics]::FromImage($dst)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, 132, 60)), (New-Object System.Drawing.Rectangle(0, 0, 132, 60)), [System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 60, 132, 80)), (New-Object System.Drawing.Rectangle(0, 355, 132, 80)), [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $dst.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $src.Dispose(); $dst.Dispose()
    Write-Output "$name -> 132x140"
}
Write-Output 'done'
