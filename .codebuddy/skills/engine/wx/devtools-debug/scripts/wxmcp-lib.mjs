/**
 * 微信开发者工具 MCP 会话库（通用，非项目绑定）
 * ================================================
 * 提供 startSession()：spawn MCP server（stdio bridge）→ initialize（含授权等待重试），
 * 返回 { call, schema, close }。
 *
 * 环境变量（均可选，缺省用默认值）：
 *   WX_TOOLS_DIR   微信开发者工具安装目录（默认 C:\Program Files (x86)\Tencent\微信web开发者工具）
 *   WX_MCP_TOKEN   MCP Token（安全设置里生成）
 *
 * 用法：
 *   import { startSession } from '<skill>/scripts/wxmcp-lib.mjs';
 *   const s = await startSession();
 *   const [err, text] = await s.call('simulator_screenshot', { project, path });
 *   s.close();
 *
 * 已知行为（详见 ../EXPERIENCE.md）：
 * - 授权不持久："Client authorization pending" 时需人工在工具界面点确认（内置 7 次重试）
 * - automation_evaluate 在渲染层执行（非游戏逻辑层）
 * - 依赖 automator 通道的工具（画布 tap 等）在本机长期无效
 */
import { spawn } from 'node:child_process';

const TOOLS = process.env.WX_TOOLS_DIR || 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具';
const TOKEN = process.env.WX_MCP_TOKEN || 'knCzgTd043YspmDDoR90e0LryZqwsR3-';
const BOOT = "const e=process.argv[1],a=process.argv.slice(2).filter(function(x){return x!=='--electron'});if(!process.env.cwd)process.env.cwd=process.cwd();process.argv=[process.execPath,e,'--electron'].concat(a);require(e)";
const SKILL_ENTRY = `${TOOLS}\\resources\\app.asar.unpacked\\js\\common\\cli\\skill-index.js`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`[超时 ${ms}ms] ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 建立 MCP 会话。
 * @param {{onAuthWait?: (msg: string, attempt: number) => void}} [hooks]
 * @returns {Promise<{call: Function, schema: Function, close: Function}>}
 */
export async function startSession(hooks = {}) {
  const c = spawn(
    `${TOOLS}\\微信开发者工具.exe`,
    ['-e', BOOT, SKILL_ENTRY, 'mcp', `--token=${TOKEN}`],
    { cwd: TOOLS, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }
  );

  let buf = '';
  const pending = new Map();
  let seq = 1;
  c.stdout.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch (e) { /* 非 JSON 行 */ }
    }
  });
  c.stderr.on('data', () => { /* bridge 诊断信息 */ });
  c.on('error', (e) => { throw new Error(`spawn 失败: ${e.message}（检查 WX_TOOLS_DIR=${TOOLS}）`); });

  const rpc = (method, params) => new Promise((res) => {
    const id = seq++;
    pending.set(id, res);
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  // initialize：授权 pending 时等待人工确认（工具界面），最多 7 次
  let init;
  for (let i = 0; i < 7; i++) {
    init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wxmcp', version: '1.0' } });
    if (!init.error) break;
    hooks.onAuthWait?.(init.error.message, i + 1);
    await sleep(10000);
  }
  if (init.error) throw new Error(`initialize 失败: ${init.error.message}（请到开发者工具界面确认 MCP 授权）`);
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    /**
     * 调用 MCP 工具。
     * 注意：部分工具失败时 MCP 层 isError=false，但正文是 {"success":false,...}，
     * 这里一并识别为失败，避免退出码欺骗（如 automation_evaluate 的 automator 超时）。
     * @returns {Promise<[boolean, string]>} [isError, text]
     */
    async call(name, argv, tmo = 45000) {
      const r = await withTimeout(rpc('tools/call', { name, arguments: argv }), tmo, name);
      if (r.error) return [true, JSON.stringify(r.error)];
      const text = (r.result.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      const softFail = /^\s*\{\s*\"success\"\s*:\s*false/.test(text);
      return [!!r.result.isError || softFail, text];
    },
    /** 查工具 inputSchema */
    async schema(name) {
      const r = await rpc('tools/list');
      const t = r.result.tools.find((x) => x.name === name);
      return t ? JSON.stringify(t.inputSchema, null, 2) : `未找到工具 ${name}`;
    },
    close() { try { c.kill(); } catch (e) { /* 忽略 */ } },
  };
}
