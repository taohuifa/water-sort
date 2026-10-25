/**
 * 微信开发者工具 MCP 统一调试工具（wxmcp）
 * ============================================
 * 主通道：官方 MCP server（stdio，经 IDE 服务端口 20856）
 * 备用通道：见同目录 printwin.mjs（PrintWindow 截图，不依赖任何服务）
 *
 * 项目路径：默认取当前工作目录（在项目根执行），可用环境变量 WX_PROJECT 覆盖。
 * 会话逻辑在 wxmcp-lib.mjs（通用库，可被项目测试脚本 import 复用）。
 *
 * 用法（在目标项目根目录执行）：
 *   node <skill>/scripts/wxmcp.mjs shot [name]     截图 → <project>/screenshots/mcp-<name>.jpg
 *   node <skill>/scripts/wxmcp.mjs refresh         触发模拟器重新编译（+ 编译后截图）
 *   node <skill>/scripts/wxmcp.mjs console [grep]  读模拟器 console 日志（默认全部）
 *   node <skill>/scripts/wxmcp.mjs eval '<fn>'    在渲染层执行 JS（注意：不是逻辑层！）
 *   node <skill>/scripts/wxmcp.mjs open           打开项目窗口（窗口被关时）
 *   node <skill>/scripts/wxmcp.mjs call <tool> '<json>'  调用任意 MCP 工具
 *   node <skill>/scripts/wxmcp.mjs schema <tool>   查看工具参数 schema
 *
 * 已知限制（详见 ../EXPERIENCE.md）：
 * - automation_evaluate 执行在渲染层（GameGlobal 是 window 别名），游戏逻辑层对象不可见
 * - automation_game_action（画布 tap）内部依赖 automator 通道（9420），该通道在本机
 *   长期挂起（connect OK 但 API 无响应），触摸注入暂不可用——修复前不要依赖 tap 类工具
 * - simulator_screenshot / simulator_refresh / get_simulator_console 走服务端口，稳定可用
 */
import { mkdirSync } from 'node:fs';
import { startSession } from './wxmcp-lib.mjs';

// 通用脚本：项目路径取 WX_PROJECT 环境变量或当前工作目录，不绑定 skill 所在工程
const ROOT = (process.env.WX_PROJECT || process.cwd()).replace(/[\\/]+$/, '');
const OUT = `${ROOT}/screenshots`;
const PROJECT = ROOT.replaceAll('\\', '/');

const [cmd, ...args] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USAGE = `用法（在目标项目根目录执行，或设 WX_PROJECT=<项目路径>）:
  wxmcp.mjs shot [name]      截图 → screenshots/mcp-<name>.jpg
  wxmcp.mjs refresh          触发模拟器重新编译（+ 编译后截图）
  wxmcp.mjs console [grep]   读模拟器 console（默认全部）
  wxmcp.mjs eval '<fnSrc>'   渲染层执行 JS（如 'function(){return 1+1}'）
  wxmcp.mjs open             打开项目窗口（窗口被关时）
  wxmcp.mjs call <tool> '<json参数>'
  wxmcp.mjs schema <tool>`;

if (!cmd) { console.log(USAGE); process.exit(1); }

try {
  const s = await startSession({
    onAuthWait: (msg, attempt) => console.error(`等待授权（${msg}），请在开发者工具界面确认，10s 后重试（${attempt}/7）...`),
  });
  let err, text;

  if (cmd === 'shot') {
    const name = args[0] || 'shot';
    [err, text] = await s.call('simulator_screenshot', { project: PROJECT, path: `${OUT}/mcp-${name}.jpg` });
  } else if (cmd === 'open') {
    // 打开项目窗口（窗口被关时使用），打开后等待加载并截图确认
    [err, text] = await s.call('open_project_window', { project: PROJECT });
    console.log(text);
    await sleep(12000);
    [err, text] = await s.call('simulator_screenshot', { project: PROJECT, path: `${OUT}/mcp-opened.jpg` });
  } else if (cmd === 'refresh') {
    [err, text] = await s.call('simulator_refresh', { project: PROJECT });
    console.log(text); // 编译完成提示
    await sleep(5000); // 等待游戏重启
    [err, text] = await s.call('simulator_screenshot', { project: PROJECT, path: `${OUT}/mcp-after-refresh.jpg` });
  } else if (cmd === 'console') {
    [err, text] = await s.call('get_simulator_console', { project: PROJECT, command: `grep -n -i "${args[0] || '.'}"` });
  } else if (cmd === 'eval') {
    if (!args[0]) { console.error('缺少函数源码，如: wxmcp.mjs eval "function(){return 1}"'); process.exit(1); }
    [err, text] = await s.call('automation_evaluate', { project: PROJECT, action: 'evaluate', fnSource: args[0] });
  } else if (cmd === 'call') {
    if (!args[0]) { console.error('缺少工具名'); process.exit(1); }
    let argv = {};
    if (args[1]) { try { argv = JSON.parse(args[1]); } catch (e) { console.error(`参数不是合法 JSON: ${e.message}`); process.exit(1); } }
    [err, text] = await s.call(args[0], argv);
  } else if (cmd === 'schema') {
    console.log(await s.schema(args[0]));
    s.close();
    process.exit(0);
  } else {
    console.log(USAGE);
    s.close();
    process.exit(1);
  }

  s.close();
  console.log(text);
  process.exit(err ? 1 : 0);
} catch (e) {
  console.error(`失败: ${e.message}`);
  process.exit(1);
}
