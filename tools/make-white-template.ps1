# make-white-template.ps1 — 生成白模板滤色方案的三张模板图
# Part A: liquid-0~7.png -> liquid-white.png (132x140, 比值编码: byte = ratio x 127.5, 余量 2.0)
# Part B: drink-4.png (蓝莓) -> drink-base.png + drink-juice.png (色度 smoothstep 分割)
# 运行时 tint 解码: out = min(255, byte * 2 / 255 * main)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dir = 'G:\prj\presonal\water-sort\assets\images'
$mains = @(
    @(0xF9,0x4F,0x6D), @(0xFF,0x98,0x38), @(0xFF,0xC9,0x33), @(0x8B,0xD4,0x50),
    @(0x5B,0x8D,0xEF), @(0xA2,0x6B,0xF2), @(0xF3,0xEA,0xD7), @(0x4F,0xB0,0x8C)
)

function Get-Px($bmp, $x, $y) { return $bmp.GetPixel($x, $y) }

# ============ Part A: liquid-white.png ============
Write-Output '=== Part A: liquid-white ==='
$liq = @()
for ($c = 0; $c -lt 8; $c++) { $liq += ,[System.Drawing.Bitmap]::FromFile((Join-Path $dir "liquid-$c.png")) }

# pass 1: 每色比值中位数（归一化基准，消除各源图整体明度偏差）
$medians = @()
for ($c = 0; $c -lt 8; $c++) {
    $rs = New-Object System.Collections.Generic.List[double]
    $m = $mains[$c]
    for ($y = 0; $y -lt 140; $y += 2) {
        for ($x = 0; $x -lt 132; $x += 2) {
            $p = $liq[$c].GetPixel($x, $y)
            if ($p.A -gt 200) {
                for ($ch = 0; $ch -lt 3; $ch++) {
                    $mv = $m[$ch]
                    if ($mv -gt 30) {
                        $pv = (0, $p.R, $p.G, $p.B)[$ch + 1]
                        $rs.Add([double]$pv / $mv)
                    }
                }
            }
        }
    }
    $a = $rs.ToArray(); [Array]::Sort($a)
    $medians += $a[[int]($a.Count * 0.5)]
    Write-Output ("color {0}: median ratio = {1:N3}" -f $c, $medians[$c])
}

# pass 2: 逐像素聚合归一化比值（mean 与 median 两种，择优），编码为 byte
$tpl = New-Object System.Drawing.Bitmap 132, 140
$ratiosAvg = New-Object 'double[,]' 132, 140   # 记录基色区平均比值（诊断用）
$useMedian = $true
for ($y = 0; $y -lt 140; $y++) {
    for ($x = 0; $x -lt 132; $x++) {
        $rsR = New-Object System.Collections.Generic.List[double]
        $rsG = New-Object System.Collections.Generic.List[double]
        $rsB = New-Object System.Collections.Generic.List[double]
        $sumA = 0.0; $n = 0
        for ($c = 0; $c -lt 8; $c++) {
            $p = $liq[$c].GetPixel($x, $y)
            $sumA += $p.A
            if ($p.A -gt 200) {
                $m = $mains[$c]
                $rsR.Add(([double]$p.R / $m[0]) / $medians[$c])
                $rsG.Add(([double]$p.G / $m[1]) / $medians[$c])
                $rsB.Add(([double]$p.B / $m[2]) / $medians[$c])
                $n++
            }
        }
        $A = [int]($sumA / 8)
        if ($n -gt 0) {
            if ($useMedian) {
                $aR = $rsR.ToArray(); [Array]::Sort($aR)
                $aG = $rsG.ToArray(); [Array]::Sort($aG)
                $aB = $rsB.ToArray(); [Array]::Sort($aB)
                $mid = $n / 2
                $rR = ($aR[[int][math]::Floor($mid)] + $aR[[int][math]::Ceiling($mid - 1)]) / 2
                $rG = ($aG[[int][math]::Floor($mid)] + $aG[[int][math]::Ceiling($mid - 1)]) / 2
                $rB = ($aB[[int][math]::Floor($mid)] + $aB[[int][math]::Ceiling($mid - 1)]) / 2
            } else {
                $rR = ($rsR | Measure-Object -Average).Average
                $rG = ($rsG | Measure-Object -Average).Average
                $rB = ($rsB | Measure-Object -Average).Average
            }
            $ratiosAvg[$x, $y] = ($rR + $rG + $rB) / 3
            $R = [math]::Min(255, [int][math]::Round($rR * 127.5))
            $G = [math]::Min(255, [int][math]::Round($rG * 127.5))
            $B = [math]::Min(255, [int][math]::Round($rB * 127.5))
        } else {
            $R = 128; $G = 128; $B = 128
        }
        $tpl.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($A, $R, $G, $B))
    }
}
$tpl.Save((Join-Path $dir 'liquid-white.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$opaque = 0; $hi = 0
for ($y = 0; $y -lt 140; $y++) { for ($x = 0; $x -lt 132; $x++) { if ($tpl.GetPixel($x, $y).A -gt 200) { $opaque++; if ($ratiosAvg[$x, $y] -gt 1.3) { $hi++ } } } }
Write-Output ("liquid-white.png saved (useMedian={0}). opaque={1}, highlight(>1.3)={2} ({3:N1}%)" -f $useMedian, $opaque, $hi, (100.0 * $hi / $opaque))

# ASCII 可视化模板光照结构（每 4x2 px 一格，按 luminance 比值分级）
Write-Output '--- template shading map (x33 cols, ratio levels) ---'
for ($y = 0; $y -lt 140; $y += 4) {
    $line = ''
    for ($x = 0; $x -lt 132; $x += 4) {
        $p = $tpl.GetPixel($x, $y)
        if ($p.A -le 32) { $line += '.'; continue }
        $lv = ($p.R + $p.G + $p.B) / 3 / 127.5
        if ($lv -ge 1.3) { $line += '#' }       # 高光
        elseif ($lv -ge 1.1) { $line += '+' }
        elseif ($lv -ge 0.95) { $line += '=' }  # 基色
        elseif ($lv -ge 0.75) { $line += '-' }
        elseif ($lv -ge 0.5) { $line += ':' }   # 阴影
        else { $line += ' ' }                   # 深阴影
    }
    Write-Output ('{0,3} {1}' -f $y, $line)
}

# 验证: tint 回各色 vs 原图 误差
Write-Output '--- per-color reconstruction error (mean/p95 abs diff, opaque) ---'
for ($c = 0; $c -lt 8; $c++) {
    $m = $mains[$c]
    $errs = New-Object System.Collections.Generic.List[double]
    for ($y = 0; $y -lt 140; $y++) {
        for ($x = 0; $x -lt 132; $x++) {
            $t = $tpl.GetPixel($x, $y); $o = $liq[$c].GetPixel($x, $y)
            if ($t.A -gt 200 -and $o.A -gt 200) {
                $tr = [math]::Min(255, [int]($t.R * 2 * $m[0] / 255))
                $tg = [math]::Min(255, [int]($t.G * 2 * $m[1] / 255))
                $tb = [math]::Min(255, [int]($t.B * 2 * $m[2] / 255))
                $errs.Add([math]::Abs($tr - $o.R) + [math]::Abs($tg - $o.G) + [math]::Abs($tb - $o.B))
            }
        }
    }
    $ea = $errs.ToArray(); [Array]::Sort($ea)
    $cnt = $ea.Count
    Write-Output ("color {0}: mean={1:N1}/765 p95={2:N0}/765 n={3}" -f $c, (($ea | Measure-Object -Average).Average), $ea[[int]($cnt * 0.95)], $cnt)
}

# ============ Part B: drink split ============
Write-Output '=== Part B: drink split (from drink-4 blueberry) ==='
$src = [System.Drawing.Bitmap]::FromFile((Join-Path $dir 'drink-4.png'))
$W = $src.Width; $H = $src.Height
$mainJ = @(0x5B, 0x8D, 0xEF)  # 蓝莓 main
$base = New-Object System.Drawing.Bitmap $W, $H
$juice = New-Object System.Drawing.Bitmap $W, $H
$T0 = 18; $T1 = 48   # chroma smoothstep 阈值
$juicePx = 0
for ($y = 0; $y -lt $H; $y++) {
    for ($x = 0; $x -lt $W; $x++) {
        $p = $src.GetPixel($x, $y)
        if ($p.A -eq 0) {
            $base.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
            $juice.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
            continue
        }
        $mx = [math]::Max($p.R, [math]::Max($p.G, $p.B))
        $mn = [math]::Min($p.R, [math]::Min($p.G, $p.B))
        $chroma = $mx - $mn
        $j = 0.0
        if ($chroma -ge $T1) { $j = 1.0 }
        elseif ($chroma -gt $T0) { $j = [double]($chroma - $T0) / ($T1 - $T0) }
        if ($j -gt 0) {
            $rR = [double]$p.R / $mainJ[0]; $rG = [double]$p.G / $mainJ[1]; $rB = [double]$p.B / $mainJ[2]
            $jR = [math]::Min(255, [int][math]::Round($rR * 127.5))
            $jG = [math]::Min(255, [int][math]::Round($rG * 127.5))
            $jB = [math]::Min(255, [int][math]::Round($rB * 127.5))
            $jA = [int][math]::Round($p.A * $j)
            $juice.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($jA, $jR, $jG, $jB))
            if ($jA -gt 200) { $juicePx++ }
        } else {
            $juice.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
        }
        $bA = [int][math]::Round($p.A * (1.0 - $j))
        $base.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($bA, $p.R, $p.G, $p.B))
    }
}
$base.Save((Join-Path $dir 'drink-base.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$juice.Save((Join-Path $dir 'drink-juice.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("drink-base.png / drink-juice.png saved ({0}x{1}), strong juice px={2}" -f $W, $H, $juicePx)

# 验证: base 覆盖 tint(juice, 蓝莓) 重组 vs 原图
$errs = New-Object System.Collections.Generic.List[double]
for ($y = 0; $y -lt $H; $y++) {
    for ($x = 0; $x -lt $W; $x++) {
        $b = $base.GetPixel($x, $y); $u = $juice.GetPixel($x, $y); $o = $src.GetPixel($x, $y)
        if ($o.A -eq 0) { continue }
        # juice tint 回蓝莓
        $ur = [math]::Min(255, [int]($u.R * 2 * $mainJ[0] / 255))
        $ug = [math]::Min(255, [int]($u.G * 2 * $mainJ[1] / 255))
        $ub = [math]::Min(255, [int]($u.B * 2 * $mainJ[2] / 255))
        $uA = [double]$u.A / 255
        # 先画 juice（半透明贴到透明背景），再 base over
        $fr = $uA * $ur
        $fg = $uA * $ug
        $fb = $uA * $ub
        $fA = $uA
        $bA = [double]$b.A / 255
        $fr = $bA * $b.R + (1 - $bA) * $fr
        $fg = $bA * $b.G + (1 - $bA) * $fg
        $fb = $bA * $b.B + (1 - $bA) * $fb
        $fA = $bA + (1 - $bA) * $fA
        if ($fA -gt 0.01) {
            $errs.Add([math]::Abs($fr / $fA - $o.R) + [math]::Abs($fg / $fA - $o.G) + [math]::Abs($fb / $fA - $o.B))
        }
    }
}
$ea = $errs.ToArray(); [Array]::Sort($ea)
$cnt = $ea.Count
Write-Output ("drink-4 self-reconstruction: mean={0:N2}/765 p95={1:N0}/765 p99={2:N0}/765 n={3}" -f (($ea | Measure-Object -Average).Average), $ea[[int]($cnt * 0.95)], $ea[[int]($cnt * 0.99)], $cnt)

foreach ($b in $liq) { $b.Dispose() }
$src.Dispose(); $base.Dispose(); $juice.Dispose(); $tpl.Dispose()
Write-Output 'done'
