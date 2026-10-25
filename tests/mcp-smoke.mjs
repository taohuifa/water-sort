/**
 * 本项目 MCP 调试链路冒烟测试（需要微信开发者工具已启动并打开本项目）
 * ================================================================
 * 复用 skill 的通用会话库 wxmcp-lib.mjs，验证：
 *   1. simulator_refresh   重新编译成功
 *   2. simulator_screenshot 编译后截图产出文件
 *   3. get_simulator_console console 无 error 级日志
 *
 * 运行（项目根目录）：
 *   npm run mcp-smoke
 * 前置：若首次连接报 "Client authorization pending"，需到工具界面点授权。
 * 退出码：0 通过 / 1 失败
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startSession } from '../.codebuddy/skills/engine/wx/devtools-debug/scripts/wxmcp-lib.mjs';

const PROJECT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '').replaceAll('\\', '/');
const SHOT = `${PROJECT}/screenshots/mcp-smoke.jpg`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
}

const s = await startSession({
  onAuthWait: (msg, attempt) => console.error(`等待授权（${msg}），请在开发者工具界面确认...（${attempt}/7）`),
});

try {
  // 1. 重新编译
  {
    const [err, text] = await s.call('simulator_refresh', { project: PROJECT });
    record('refresh', !err, text.slice(0, 200));
    await sleep(5000); // 等待游戏重启
  }

  // 2. 截图产出
  {
    const [err] = await s.call('simulator_screenshot', { project: PROJECT, path: SHOT });
    record('screenshot', !err && existsSync(SHOT), existsSync(SHOT) ? SHOT : '截图文件未生成');
  }

  // 3. console 无 error
  {
    const [err, text] = await s.call('get_simulator_console', { project: PROJECT, command: 'grep -n -i "error"' });
    const hasError = !err && text.trim().length > 0;
    record('console-no-error', !hasError, hasError ? text.slice(0, 300) : '无 error 日志');
  }
} finally {
  s.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n冒烟结果: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
