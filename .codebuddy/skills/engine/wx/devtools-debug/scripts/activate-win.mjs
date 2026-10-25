/**
 * 激活微信开发者工具主窗口（置前台 + TOPMOST + 移主屏），复用 WinApi.dll。
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';

const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, ''); // skill/scripts/
// 通用脚本：项目根取 WX_PROJECT 环境变量或当前工作目录（稳定版窗口标题 = 项目目录名）
const ROOT = (process.env.WX_PROJECT || process.cwd()).replace(/[\\/]+$/, '');
const WIN_TITLE = ROOT.split(/[\\/]/).pop(); // 稳定版 devtools 窗口标题 = 项目目录名
const JOB_DIR = `${HERE}\\jobs`;
mkdirSync(JOB_DIR, { recursive: true });

const job = `${JOB_DIR}\\act.ps1`;
const done = `${JOB_DIR}\\act.done`;
try { rmSync(done); } catch (e) { /* 忽略 */ }

writeFileSync(job, '\ufeff' + `
$ErrorActionPreference = 'Stop'
Add-Type -Path '${HERE}\\WinApi.dll'
try {
  $h = [WinApi]::FindByTitle('${WIN_TITLE}')
  if ($h -eq [IntPtr]::Zero) { throw '未找到窗口' }
  if ([WinApi]::IsIconic($h)) { [WinApi]::ShowWindow($h, 9) | Out-Null }
  $ok = [WinApi]::Activate($h)
  Start-Sleep -Milliseconds 800
  $fg = [WinApi]::GetForegroundWindow()
  ("activated=$ok fgMatch=$($fg -eq $h) hwnd=0x" + $h.ToString('X')) | Out-File '${done}' -Encoding utf8
} catch {
  ("ERROR: " + $_.Exception.Message) | Out-File '${done}' -Encoding utf8
}
`, 'utf8');

execSync(`schtasks /Create /TN WSAct /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${job}" /SC ONCE /ST 00:00 /F /RL HIGHEST /IT`, { stdio: 'pipe' });
execSync('schtasks /Run /TN WSAct', { stdio: 'pipe' });
for (let i = 0; i < 30; i++) {
  if (existsSync(done)) { console.log(readFileSync(done, 'utf8').trim()); break; }
  if (i === 29) console.log('TIMEOUT');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
try { execSync('schtasks /Delete /TN WSAct /F', { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
