/**
 * 微信开发者工具模拟器统一调试 CLI — devtools-debug skill 通道 3（Node inspector）
 * ============================================================================
 * 合并原 wx-tap.mjs / wx-snap.mjs，新增 storage 桥状态读取（免截图快速分支）。
 *
 * 用法：
 *   node wx.mjs state                                读游戏状态快照（scene/level/pause...）
 *   node wx.mjs btns                                 列出可按名点击的按钮及坐标（含可用场景）
 *   node wx.mjs tbtn <name> [idx] [--wait <ms>]      按语义名点击（坐标自动取自游戏布局快照，
 *                                                    自动场景校验防误点）
 *        name: play|settings|back|pause_resume|pause_exit|next|undo|shuffle|
 *              add_bottle|restart|sound_toggle|settings_reset|settings_key|
 *              ad_watch|ad_cancel|big_intro
 *        idx:  level <1..N 关卡号> / bottle <0..N 瓶序号> 时必带
 *   node wx.mjs tap <gameX> <gameY> [label]          按坐标点击 + 前后状态对比
 *        [--expect <scene>] [--wait <ms>]            expect：点击前校验场景，不符拒点
 *   node wx.mjs snap [out.png]                       画布截图（默认输出系统临时目录，防项目内重载）
 *   node wx.mjs wait <scene> [timeoutMs]             轮询等待场景切换（默认 10s）
 *   node wx.mjs cap                                  胶囊 rect + webview 几何
 *
 * 前提：IDE 以 --inspect=9229 启动；游戏 main.js 含 syncDebugState（storage 桥）。
 * 坐标系：游戏画布 390x844；CDP = webview 元素原点 + 游戏坐标 ×(el.w/390, el.h/844)。
 * 注意：guest 重载后 CDP Input domain 可能挂起 → tap 超时时按 EXPERIENCE.md 处置
 *       （detach 残留会话后重试）。
 *
 * 环境变量：WX_INSPECT_PORT（默认 9229）
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';

const PORT = process.env.WX_INSPECT_PORT || '9229';
const GAME_W = 390, GAME_H = 844;
const STATE_KEY = '__dbg_state';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
const cmd = args[0];
const CMDS = ['state', 'tap', 'tbtn', 'btns', 'snap', 'wait', 'cap'];
if (!CMDS.includes(cmd)) {
  console.error('用法: node wx.mjs state | tap <x> <y> [label] [--expect <s>] [--wait <ms>] | tbtn <name> [idx] [--wait <ms>] | btns | snap [out.png] | wait <scene> [timeoutMs] | cap');
  process.exit(1);
}
let gameX = null, gameY = null, label = '', expectScene = null, waitMs = 400, snapOut = null, waitScene = null, waitTimeout = 10000;
let tbtnName = null, tbtnIdx = null;
if (cmd === 'tap') {
  [gameX, gameY] = [Number(args[1]), Number(args[2])];
  if (!Number.isFinite(gameX) || !Number.isFinite(gameY)) {
    console.error('用法: node wx.mjs tap <gameX> <gameY> [label] [--expect <scene>] [--wait <ms>]');
    process.exit(1);
  }
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--expect') expectScene = args[++i];
    else if (args[i] === '--wait') waitMs = Number(args[++i]) || 400;
    else label = args[i];
  }
} else if (cmd === 'tbtn') {
  tbtnName = args[1];
  if (!tbtnName) { console.error('用法: node wx.mjs tbtn <name> [index] [--wait <ms>]  （name 见 btns 命令；level/bottle 需带序号）'); process.exit(1); }
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--wait') waitMs = Number(args[++i]) || 400;
    else if (tbtnIdx === null && Number.isFinite(Number(args[i]))) tbtnIdx = Number(args[i]);
    else label = args[i];
  }
} else if (cmd === 'snap') {
  snapOut = args[1] || null;
} else if (cmd === 'wait') {
  waitScene = args[1];
  waitTimeout = Number(args[2]) || 10000;
  if (!waitScene) { console.error('用法: node wx.mjs wait <scene> [timeoutMs]'); process.exit(1); }
}

// ---------- 连接主进程 inspector ----------
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  .catch(() => { console.error(`inspector ${PORT} 未监听——IDE 需以 --inspect=${PORT} 启动`); process.exit(2); });
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 20000);
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  }
};
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');

const evalMain = async (body) => {
  const r = await send('Runtime.evaluate', {
    expression: `(globalThis.__wx${seq} = (async () => { ${body} })())`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
  return r.result?.value;
};

// 主进程侧公共代码：找最新游戏 webview + 存 id
const FIND_WC = `const { webContents } = directRequire("electron");
  const wc = webContents.getAllWebContents()
    .filter(w => { try { return !w.isDestroyed() && w.getType() === "webview" && /\\/game\\/s\\d+\\//.test(w.getURL()); } catch (e) { return false; } })
    .sort((a, b) => Number((b.getURL().match(/\\/game\\/(s\\d+)\\//) || [])[1] || 0) - Number((a.getURL().match(/\\/game\\/(s\\d+)\\//) || [])[1] || 0))[0];`;

const getWc = async () => {
  const s = await evalMain(`${FIND_WC}
    if (!wc) return null;
    globalThis.__wxwc = wc.id;
    return wc.id;`);
  return s;
};

// ---------- 状态读取（storage 桥） ----------
const fmtState = (st) => {
  if (!st || typeof st !== 'object' || st.scene === undefined) return null;
  const age = st.t ? ((Date.now() - st.t) / 1000).toFixed(1) + 's' : '?';
  return { ...st, age };
};

const readState = async () => {
  const raw = await evalMain(`
    const { webContents } = directRequire("electron");
    const wc = webContents.getAllWebContents().find(w => w.id === Number(globalThis.__wxwc));
    if (!wc) return null;
    const r = await wc.executeJavaScript('JSON.stringify((function(){ try { var s = wx.getStorageSync("${STATE_KEY}"); return (s && typeof s === "object") ? s : null; } catch(e) { return null; } })())', true);
    return r;`);
  try { return fmtState(JSON.parse(raw)); } catch { return null; }
};

// ---------- 子命令 ----------

if (cmd === 'state') {
  if (!(await getWc())) { console.error('no game webview（项目窗口未开？）'); process.exit(2); }
  const st = await readState();
  if (!st) { console.error('[state] 无快照——游戏逻辑层未运行或未接入协议（见 skill ADAPTATION.md）'); process.exit(1); }
  // 通用输出：scene 必显 + 其余游戏自定义状态字段原样平铺（协议 v2，工具零硬编码）
  const parts = [];
  for (const [k, v] of Object.entries(st)) {
    if (k === 't' || k === 'btns' || k === 'age') continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  const stale = Number(st.age.replace('s', '')) > 5 ? ' ⚠️STALE(可能重载中)' : '';
  console.log(`[state] ${parts.join(' ')} age=${st.age}${stale}`);
  ws.close(); process.exit(0);
}

if (cmd === 'cap') {
  const geom = await evalMain(`${FIND_WC}
    if (!wc) return "no wc";
    const host = wc.hostWebContents;
    const el = await host.executeJavaScript('JSON.stringify((() => { const w = document.querySelectorAll("webview")[0]; const r = w.getBoundingClientRect(); const cap = (typeof wx !== "undefined" && wx.getMenuButtonBoundingClientRect) ? wx.getMenuButtonBoundingClientRect() : null; return {x: r.x, y: r.y, w: r.width, h: r.height, cap: cap}; })())', true);
    return el;`);
  const g = JSON.parse(geom);
  console.log(`[cap] 元素@(${g.x},${g.y}) ${g.w.toFixed(0)}x${g.h.toFixed(0)} 缩放=${(g.w / GAME_W).toFixed(3)} 胶囊=${g.cap ? JSON.stringify(g.cap) : '不可用'}`);
  ws.close(); process.exit(0);
}

if (cmd === 'snap') {
  // 默认输出系统临时目录：写入项目内会触发 IDE 重编译重载（EXPERIENCE.md 2026-10-27）
  const cwd = resolve('.');
  const out = snapOut || join(tmpdir(), `wx-snap-${Date.now()}.png`);
  if (resolve(out).startsWith(cwd)) {
    console.warn('⚠️ 输出在项目目录内——写入会触发 IDE 重编译重载（scene 重置 menu）！建议输出到项目外');
  }
  const raw = await evalMain(`${FIND_WC}
    if (!wc) return JSON.stringify({err: "no game webview"});
    try {
      const dataUrl = await wc.executeJavaScript('document.querySelectorAll("canvas")[0].toDataURL("image/png")', true);
      return JSON.stringify({ok: true, dataUrl});
    } catch (e) { return JSON.stringify({err: String((e && e.message) || e).slice(0, 150)}); }`);
  const res = JSON.parse(raw);
  if (res.err) { console.error('[snap 失败]', res.err); process.exit(1); }
  const b64 = res.dataUrl.slice('data:image/png;base64,'.length);
  writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`[snap ok] ${out} (${Math.round(b64.length * 3 / 4 / 1024)}KB, 画布 780x1688, 1px=0.5 游戏单位)`);
  ws.close(); process.exit(0);
}

if (cmd === 'wait') {
  if (!(await getWc())) { console.error('no game webview'); process.exit(2); }
  const t0 = Date.now();
  for (;;) {
    const st = await readState();
    if (st && st.scene === waitScene) { console.log(`[wait ok] scene=${waitScene} (${Date.now() - t0}ms)`); ws.close(); process.exit(0); }
    if (Date.now() - t0 > waitTimeout) {
      console.error(`[wait 超时] 期望 ${waitScene}，当前 ${st ? st.scene + '(age ' + st.age + ')' : '无快照'}`);
      ws.close(); process.exit(1);
    }
    await sleep(250);
  }
}

if (cmd === 'tap' || cmd === 'tbtn' || cmd === 'btns') {
  if (!(await getWc())) { console.error('no game webview（项目窗口未开？）'); process.exit(2); }

  const st = await readState();
  if (!st || !st.btns) {
    console.error('[失败] 无状态快照或快照缺 btns——游戏需按协议 v2 实现 syncDebugState（见 skill ADAPTATION.md）');
    ws.close(); process.exit(1);
  }

  // ---- 协议 v2 校验助手（语义全部来自快照自描述，工具零硬编码） ----
  // when 语义：{字段: true}=字段真值；其他值=严格相等
  const checkWhen = (entry, st) => {
    if (!entry.when) return null;
    for (const [f, want] of Object.entries(entry.when)) {
      const got = st[f];
      const ok = want === true ? !!got : got === want;
      if (!ok) return `需要 ${f}=${want === true ? '真值' : want}，当前 ${f}=${typeof got === 'object' ? JSON.stringify(got) : got}`;
    }
    return null;
  };
  const scenesOk = (entry, st) => !entry.scenes || entry.scenes.includes(st.scene);

  if (cmd === 'btns') {
    console.log(`[btns] scene=${st.scene} age=${st.age}（按钮表由游戏快照自描述，协议见 ADAPTATION.md）`);
    for (const [name, entry] of Object.entries(st.btns)) {
      const scenes = entry.scenes ? entry.scenes.join('/') : '任意';
      const when = entry.when ? ` when=${JSON.stringify(entry.when)}` : '';
      if (Array.isArray(entry.list)) {
        console.log(`  ${name}[${entry.list.length}] alias=${entry.alias} base=${entry.base} (${scenes}) 首个=${entry.list.length ? entry.list[0].join(',') : '-'}${when}`);
      } else {
        console.log(`  ${name}=${entry.xy ? entry.xy.join(',') : '?'}  (${scenes})${when}`);
      }
    }
    ws.close(); process.exit(0);
  }

  // ---- tbtn：按名查表（对象型直查；数组型按 alias 匹配）+ 自描述校验 ----
  if (cmd === 'tbtn') {
    const btns = st.btns;
    let coord = null, entry = null;
    if (btns[tbtnName] && !Array.isArray(btns[tbtnName].list)) {
      // 对象型按钮
      entry = btns[tbtnName];
      coord = entry.xy;
      label = tbtnName;
      if (tbtnIdx !== null) console.warn(`[tbtn] 注意：按钮 "${tbtnName}" 非数组型，序号 ${tbtnIdx} 被忽略`);
    } else {
      // 数组型：按 alias 找条目
      const arrEntry = Object.entries(btns).find(([, e]) => e && e.alias === tbtnName && Array.isArray(e.list));
      if (!arrEntry) {
        console.error(`[tbtn 失败] 未知按钮 "${tbtnName}"——用 btns 命令查看可用名称/别名`);
        ws.close(); process.exit(1);
      }
      entry = arrEntry[1];
      if (tbtnIdx === null) { console.error(`[tbtn 失败] "${tbtnName}" 需要序号（base=${entry.base} 起）：tbtn ${tbtnName} <序号>`); ws.close(); process.exit(1); }
      const li = tbtnIdx - entry.base;
      coord = entry.list[li];
      label = `${tbtnName}${tbtnIdx}`;
      if (!coord) { console.error(`[tbtn 失败] ${arrEntry[0]}[${li}] 不存在（共 ${entry.list.length} 个，序号 ${entry.base} 起）`); ws.close(); process.exit(1); }
    }
    if (!coord) { console.error(`[tbtn 失败] 按钮 "${tbtnName}" 无坐标`); ws.close(); process.exit(1); }
    // 自描述场景校验
    if (!scenesOk(entry, st)) {
      console.error(`[tbtn 拒绝] "${tbtnName}" 仅在 ${entry.scenes.join('/')} 可用，当前 scene=${st.scene}（age ${st.age}）`);
      ws.close(); process.exit(1);
    }
    const whenErr = checkWhen(entry, st);
    if (whenErr) { console.error(`[tbtn 拒绝] "${tbtnName}" ${whenErr}`); ws.close(); process.exit(1); }
    gameX = coord[0]; gameY = coord[1];
    console.log(`[tbtn] ${label} → 游戏坐标 (${gameX},${gameY})`);
  }

  // ---- 共享点击执行（tap 直达坐标 / tbtn 语义坐标） ----
  const before = st;
  if (expectScene) {
    if (before.scene !== expectScene) {
      console.error(`[tap 拒绝] expect=${expectScene} 但当前 scene=${before.scene}（age ${before.age}）——防误点，未执行点击`);
      ws.close(); process.exit(1);
    }
  }
  // 几何 + CDP touch（Input 挂起保护：单条命令 5s race）
  const tapRes = JSON.parse(await evalMain(`
    const { webContents } = directRequire("electron");
    const wc = webContents.getAllWebContents().find(w => w.id === Number(globalThis.__wxwc));
    if (!wc) return JSON.stringify({err: "wc lost"});
    try {
      const host = wc.hostWebContents;
      const el = JSON.parse(await host.executeJavaScript('JSON.stringify((() => { const w = document.querySelectorAll("webview")[0]; const r = w.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; })())', true));
      const cx = el.x + ${gameX} * (el.w / ${GAME_W}), cy = el.y + ${gameY} * (el.h / ${GAME_H});
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      const t0 = Date.now();
      await Promise.race([
        (async () => {
          await wc.debugger.sendCommand("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
          await new Promise(r2 => setTimeout(r2, 90));
          await wc.debugger.sendCommand("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("INPUT_TIMEOUT(重载后Input挂起?detach后重试)")), 5000)),
      ]);
      return JSON.stringify({ok: true, cdp: [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10], ms: Date.now() - t0});
    } catch (e) { return JSON.stringify({err: String((e && e.message) || e).slice(0, 120)}); }`));
  if (tapRes.err) { console.error('[tap 失败]', tapRes.err); ws.close(); process.exit(1); }
  // 后置状态：对比全部自定义状态字段（除 t/btns/age），报告变化字段名
  await sleep(waitMs);
  const after = await readState();
  const bStr = before.scene;
  const aStr = after ? after.scene : '?';
  let changed = [];
  if (before && after) {
    for (const k of Object.keys(before)) {
      if (k === 't' || k === 'btns' || k === 'age') continue;
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
    }
  }
  console.log(`[tap ok] (${gameX},${gameY})→cdp(${tapRes.cdp}) ${label} | ${bStr} → ${aStr} ${changed.length ? '✓CHANGED(' + changed.join(',') + ')' : '(unchanged)'}`);
  ws.close(); process.exit(0);
}
