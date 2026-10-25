
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  public struct R { public int L; public int T; public int Rt; public int B; }
  public static IntPtr FindMain(string p) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.ToString() == p) { found = h; return false; } // 稳定版窗口标题就是项目名本身
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$log = @()
try {
  $h = [PW]::FindMain('water-sort')
  if ($h -eq [IntPtr]::Zero) { throw '未找到窗口' }
  $r = New-Object PW+R
  [PW]::GetWindowRect($h, [ref]$r) | Out-Null
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap(($r.Rt - $r.L), ($r.B - $r.T))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [PW]::PrintWindow($h, $hdc, 3)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $bmp.Save('g:\\prj\\presonal\\water-sort\\screenshots\pw-' + 'auth-check' + '.png')
  $bmp.Dispose()
  $log += "printed ok=$ok rect=($($r.L),$($r.T))-($($r.Rt),$($r.B))"
} catch {
  $log += "ERROR: $($_.Exception.Message)"
}
$log -join "`n" | Out-File 'g:\prj\presonal\water-sort\.codebuddy\skills\engine\wx\devtools-debug\scripts\jobs\pw-auth-check.done' -Encoding utf8
