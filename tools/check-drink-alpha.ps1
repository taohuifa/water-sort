Add-Type -AssemblyName System.Drawing
foreach ($i in 0..7) {
    $path = "G:\prj\presonal\water-sort\assets\images\drink-$i.png"
    $bmp = [System.Drawing.Bitmap]::FromFile($path)
    $w = $bmp.Width; $h = $bmp.Height
    $edges = @(
        $bmp.GetPixel([int]($w / 2), 2).A,
        $bmp.GetPixel([int]($w / 2), ($h - 3)).A,
        $bmp.GetPixel(2, [int]($h / 2)).A,
        $bmp.GetPixel(($w - 3), [int]($h / 2)).A
    )
    # 不透明覆盖率（粗略判断是否有大面积底板）
    $opaque = 0; $total = 0
    for ($y = 0; $y -lt $h; $y += 2) {
        for ($x = 0; $x -lt $w; $x += 2) {
            $total++
            if ($bmp.GetPixel($x, $y).A -gt 32) { $opaque++ }
        }
    }
    $pct = [int](100 * $opaque / $total)
    Write-Output ("drink-{0}: edgeMidA={1}  coverage={2}%" -f $i, ($edges -join ','), $pct)
    $bmp.Dispose()
}
