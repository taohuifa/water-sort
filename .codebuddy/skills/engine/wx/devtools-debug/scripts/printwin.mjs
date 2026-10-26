/**
 * PrintWindow 截取 devtools 主窗口全貌（不需要前台/不受遮挡影响）。
 * 用法：node .codebuddy/skills/engine/wx/devtools-debug/scripts/printwin.mjs [输出名]
 * 窗口标题匹配：稳定版为项目名本身（如 'water-sort'），无 '- 微信开发者工具' 后缀。
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';

const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, ''); // skill/scripts/
// 通用脚本：项目根取 WX_PROJECT 环境变量或当前工作目录（稳定版窗口标题 = 项目目录名）
const ROOT = (process.env.WX_PROJECT || process.cwd()).replace(/[\\/]+$/, '');
const OUT_DIR = `${ROOT}\\screenshots`;
// job 临时文件放项目 temp/（.gitignore 已忽略 temp/**），避免污染 skill 目录；WX_JOB_DIR 可覆盖
const JOB_DIR = process.env.WX_JOB_DIR || `${ROOT}\\temp\\devtools-debug`;
const name = process.argv[2] || 'pw';
const WIN_TITLE = ROOT.split(/[\\/]/).pop(); // 稳定版 devtools 窗口标题 = 项目目录名
mkdirSync(JOB_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const job = `${JOB_DIR}\\pw-${name}.ps1`;
const done = `${JOB_DIR}\\pw-${name}.done`;
try { rmSync(done); } catch (e) { /* 忽略 */ }

writeFileSync(job, '\ufeff' + `
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
  $h = [PW]::FindMain('${WIN_TITLE}')
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
  $bmp.Save('${OUT_DIR.replaceAll('\\', '\\\\')}\\pw-' + '${name}' + '.png')
  $bmp.Dispose()
  $log += "printed ok=$ok rect=($($r.L),$($r.T))-($($r.Rt),$($r.B))"
} catch {
  $log += "ERROR: $($_.Exception.Message)"
}
$log -join "\`n" | Out-File '${done}' -Encoding utf8
`, 'utf8');

execSync(`schtasks /Create /TN WSPW /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${job}" /SC ONCE /ST 00:00 /F /RL HIGHEST /IT`, { stdio: 'pipe' });
execSync('schtasks /Run /TN WSPW', { stdio: 'pipe' });
for (let i = 0; i < 30; i++) {
  if (existsSync(done)) { console.log(readFileSync(done, 'utf8').trim()); break; }
  if (i === 29) console.log('TIMEOUT');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
try { execSync('schtasks /Delete /TN WSPW /F', { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
// 运行后清理 job 脚本与 done 文件（否则每次截图永久残留一对，越积越多）
try { rmSync(job); } catch (e) { /* 忽略 */ }
try { rmSync(done); } catch (e) { /* 忽略 */ }
