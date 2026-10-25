/**
 * 系统级 UI 自动化 v2（RPA）：截图观测 + 模拟点击，操控微信开发者工具。
 *
 * 架构要点（踩坑经验，详见 docs/dev-tools-automation-experience.md）：
 * - CodeBuddy 派生的 shell 进程附着在非交互 window station 上且状态不稳定，
 *   直接执行注入/截屏会间歇性失败（黑屏、GetForegroundWindow=0x0）
 * - 解法：所有 UI 操作写入 job 脚本，经任务计划程序（schtasks /IT）以
 *   交互桌面身份执行，Node 侧轮询 done 文件取结果
 * - 会话锁屏/断开时一切 UI 操作无效：前置检查 + 提示
 * - devtools 主窗口用 EnumWindows 按标题精确锁定（Get-Process 的
 *   MainWindowHandle 可能指向最小化的幽灵窗口）
 * - 窗口可能残留在已断开的第二显示器坐标（屏幕外）：移到主屏 (0,0)
 * - 绕过前台锁定：ALT 键模拟 + SetForegroundWindow + HWND_TOPMOST
 *
 * 命令：
 *   node .codebuddy/skills/engine/wx/devtools-debug/scripts/uiauto.mjs shot <name>        截屏 → screenshots/uiauto-<name>.png
 *   node .codebuddy/skills/engine/wx/devtools-debug/scripts/uiauto.mjs click <x> <y>      模拟鼠标左键点击（屏幕坐标）
 *   node .codebuddy/skills/engine/wx/devtools-debug/scripts/uiauto.mjs tap <x> <y> [name] 点击 + 800ms 后截屏（观测操作结果）
 *   node .codebuddy/skills/engine/wx/devtools-debug/scripts/uiauto.mjs info               打印 devtools 窗口状态
 *
 * 所有命令带超时，绝不无限等待。退出码：0 成功 / 1 失败 / 2 会话锁屏或环境不可用
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';

const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, ''); // skill/scripts/
// 通用脚本：项目根取 WX_PROJECT 环境变量或当前工作目录（稳定版窗口标题 = 项目目录名）
const ROOT = (process.env.WX_PROJECT || process.cwd()).replace(/[\\/]+$/, '');
const WIN_TITLE = ROOT.split(/[\\/]/).pop(); // 稳定版 devtools 窗口标题 = 项目目录名
const OUT_DIR = `${ROOT}\\screenshots`;
const JOB_DIR = `${HERE}\\jobs`;
const TASK_NAME = 'WxDevToolsUIJob';
const T_CMD = 45000; // schtasks 启动 + Add-Type 冷编译较慢，需放宽

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(JOB_DIR, { recursive: true });

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** job 脚本公共头：加载预编译 WinApi.dll + 定义 Out-Done（job 内唯一有效的输出通道） */
const HELPERS = (donePath) => `
$ErrorActionPreference = 'Stop'
Add-Type -Path '${HERE}\\WinApi.dll'
function Out-Done([string]$line) { Add-Content -LiteralPath '${donePath}' -Value $line -Encoding UTF8 }
`;

/** 经任务计划程序在交互桌面执行脚本；返回 job 的输出内容（超时抛错） */
function runOnDesktop(script) {
  const id = `${process.pid}-${Date.now()}`;
  const job = `${JOB_DIR}\\job-${id}.ps1`;
  const done = `${JOB_DIR}\\job-${id}.done`;
  // job 末尾把运行期输出写入 done 文件
  writeFileSync(job, '\ufeff' + HELPERS(done) + script + `\nOut-Done 'JOB_DONE'\n`, 'utf8');
  try {
    execSync(
      `schtasks /Create /TN ${TASK_NAME} /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${job}" /SC ONCE /ST 00:00 /F /RL HIGHEST /IT`,
      { timeout: T_CMD, stdio: 'pipe' }
    );
    execSync(`schtasks /Run /TN ${TASK_NAME}`, { timeout: T_CMD, stdio: 'pipe' });
    const t0 = Date.now();
    for (;;) {
      if (existsSync(done)) {
        const out = readFileSync(done, 'utf8').replace(/JOB_DONE\s*$/, '').trim();
        if (out.includes('FATAL:')) throw new Error(out.replace('FATAL:', '').trim());
        return out;
      }
      if (Date.now() - t0 > T_CMD) {
        throw new Error(`schtasks 任务超时（${T_CMD / 1000}s）。若提示锁屏/无输入桌面，请保持远程会话连接`);
      }
      sleepSync(300);
    }
  } finally {
    try { execSync(`schtasks /Delete /TN ${TASK_NAME} /F`, { timeout: 10000, stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
    try { rmSync(job); } catch (e) { /* 忽略 */ }
    try { rmSync(done); } catch (e) { /* 忽略 */ }
  }
}

// job 内用 try/catch 把任何异常写进 done（标记 FATAL 供 Node 侧识别；不可 exit，否则 done 丢失）
const GUARD = (body) => `
try {
${body}
} catch {
  Out-Done ("FATAL:" + $_.Exception.Message)
}
`;

const TITLE = WIN_TITLE; // 稳定版窗口标题 = 项目目录名（旧版为 '<项目名> - 微信开发者工具'）

const [cmd, ...args] = process.argv.slice(2);

try {
  if (cmd === 'info') {
    const out = runOnDesktop(GUARD(`
$st = [WinApi]::DesktopState()
Out-Done "desktop=$st"
if ($st -eq 'OK') {
  $h = [WinApi]::FindByTitle('${TITLE}')
  Out-Done ("devtools=0x{0:X}" -f $h)
  $fg = [WinApi]::GetForegroundWindow()
  Out-Done ("foreground=0x{0:X}" -f $fg)
}`));
    console.log(out);
    process.exit(0);
  }

  if (cmd === 'shot' || cmd === 'tap') {
    const name = cmd === 'shot' ? args[0] : args[2] || 'after-tap';
    if (!name) { console.error('缺少截图名称'); process.exit(1); }
    const png = `${OUT_DIR}\\uiauto-${name}.png`;
    let body = `
$st = [WinApi]::DesktopState()
if ($st -ne 'OK') { throw "会话处于锁屏/断开状态（$st），UI 自动化不可用。请保持远程会话连接" }
$h = [WinApi]::FindByTitle('${TITLE}')
if ($h -eq [IntPtr]::Zero) { throw "未找到开发者工具窗口（标题含 '${TITLE}'）" }
if ([WinApi]::IsIconic($h)) { [WinApi]::ShowWindow($h, 9) | Out-Null }
[WinApi]::Activate($h) | Out-Null
Start-Sleep -Milliseconds 800`;
    if (cmd === 'tap') {
      const [x, y] = args.map(Number);
      if (Number.isNaN(x) || Number.isNaN(y)) { console.error('坐标无效'); process.exit(1); }
      body += `\n[WinApi]::ClickSI(${x}, ${y})\nStart-Sleep -Milliseconds 800`;
    }
    body += `\n[WinApi]::Shot('${png}')\nOut-Done 'OK'`;
    const out = runOnDesktop(GUARD(body));
    console.log(`${out} → screenshots\\uiauto-${name}.png`);
    process.exit(0);
  }

  if (cmd === 'click') {
    const [x, y] = args.map(Number);
    if (Number.isNaN(x) || Number.isNaN(y)) { console.error('坐标无效'); process.exit(1); }
    const out = runOnDesktop(GUARD(`
$st = [WinApi]::DesktopState()
if ($st -ne 'OK') { throw "会话处于锁屏/断开状态（$st）" }
$h = [WinApi]::FindByTitle('${TITLE}')
if ($h -eq [IntPtr]::Zero) { throw "未找到开发者工具窗口" }
[WinApi]::Activate($h) | Out-Null
Start-Sleep -Milliseconds 500
[WinApi]::ClickSI(${x}, ${y})
Out-Done 'OK'`));
    console.log(`${out} clicked (${x}, ${y})`);
    process.exit(0);
  }

  console.log('用法: node tools/uiauto.mjs shot <name> | click <x> <y> | tap <x> <y> [name] | info');
  process.exit(1);
} catch (e) {
  console.error(`失败: ${e.message}`);
  process.exit(2);
}
