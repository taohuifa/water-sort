# 一次性编译 WinApi.dll（UI 自动化的 user32 P/Invoke 集合）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-winapi.ps1
# 之后 job 脚本用 Add-Type -Path <dll> 加载，无需运行时编译。
$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinApi {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f, bool i, uint a);
  [DllImport("user32.dll")] public static extern bool SetThreadDesktop(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public struct P { public int X; public int Y; }

  public static IntPtr FindByTitle(string p) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.ToString().Contains(p)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // 绕过前台锁定：模拟 ALT 按下 → SetForegroundWindow → 失败则 SwitchToThisWindow → 强制 TOPMOST 并移到主屏 (0,0)
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  public static bool Activate(IntPtr h) {
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    bool ok = SetForegroundWindow(h);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    if (!ok) { SwitchToThisWindow(h, true); ok = GetForegroundWindow() == h; }
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0040); // TOPMOST + 主屏(0,0)
    return ok;
  }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(150);
    mouse_event(2, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(4, 0, 0, 0, UIntPtr.Zero);
  }

  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  // SendInput 版：绝对坐标移动 + 按下 + 抬起，完整事件序列
  public static void ClickSI(int x, int y) {
    var b = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
    var move = new INPUT(); move.type = 0; move.mi.dwFlags = 0x0001 | 0x8000;
    move.mi.dx = x * 65536 / b.Width; move.mi.dy = y * 65536 / b.Height;
    var down = new INPUT(); down.type = 0; down.mi.dwFlags = 0x0002;
    var up = new INPUT(); up.type = 0; up.mi.dwFlags = 0x0004;
    var arr = new INPUT[] { move, down, up };
    SendInput(3, arr, Marshal.SizeOf(typeof(INPUT)));
  }

  public static string DesktopState() {
    IntPtr d = OpenInputDesktop(0, false, 0x02000000); // MAXIMUM_ALLOWED
    return d == IntPtr.Zero ? "NO_INPUT_DESKTOP(锁屏或会话断开)" : "OK";
  }

  public static void Shot(string path) {
    var b = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
    using (var bmp = new System.Drawing.Bitmap(b.Width, b.Height))
    using (var g = System.Drawing.Graphics.FromImage(bmp)) {
      g.CopyFromScreen(0, 0, 0, 0, bmp.Size);
      bmp.Save(path);
    }
  }
}
'@
$dst = Join-Path $PSScriptRoot 'WinApi.dll'
Add-Type -TypeDefinition $src -OutputAssembly $dst -OutputType Library -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing')
Write-Output "OK $dst"
