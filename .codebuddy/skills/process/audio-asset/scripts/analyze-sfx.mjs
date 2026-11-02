#!/usr/bin/env node
/**
 * analyze-sfx.mjs — 音效响度离线分析 → 输出静态增益配置（零依赖，Node ≥18 + 系统 Edge/Chrome）
 *
 * 目的：替代游戏内运行时响度分析（省 decode 后逐样本统计的开销）。
 * 原理：生成内嵌 base64 音频的分析页 → 无头浏览器 decodeAudioData 解码 →
 *       按 loudness 公式计算各音效增益 → 从 dump-dom 提取结果。
 *
 * 公式（与 SKILL.md「缩短三板斧」一致）：
 *   分析窗口 = 实际发声段（pour: 0.9s 起被消费的 0.76s，2x 速即 0.38s 墙钟；其余全长）
 *   gain = 目标RMS(0.15) / 实测RMS；峰值保护（gain 后 peak ≤ 0.9）；限幅 [0.5, 3]
 *
 * 用法：
 *   node analyze-sfx.mjs [audioDir] [--out gains.json]
 *     audioDir 默认 ./assets/audio（bgm.mp3 自动排除）
 *     --out 额外把 {name: gain} 配置写入 JSON 文件（供粘贴进程序）
 *
 * 输出：终端表格 + JSON。把 gains 表粘贴进 audio.js 顶部 GAINS 常量即可。
 * 注意：素材更换/裁剪参数变化后需重跑本脚本刷新配置。
 */
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const BROWSERS = [
  process.env.SFX_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

// ---- 解析参数 ----
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const dir = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : './assets/audio');

const files = readdirSync(dir).filter((f) => f.endsWith('.mp3') && f !== 'bgm.mp3');
if (!files.length) { console.error(`ERR: ${dir} 下没有音效 mp3`); process.exit(1); }

// ---- 生成分析页（base64 内嵌，无网络/文件读取依赖） ----
const dataJs = files
  .map((f) => `  ${f.replace('.mp3', '')}: "${readFileSync(join(dir, f)).toString('base64')}"`)
  .join(',\n');
// 分析/窗口参数与游戏 audio.js 保持同步：POUR_OFFSET / POUR_SRC_SEC / TARGET_RMS / GAIN_LIMITS / PEAK_CAP
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
const DATA = {
${dataJs}
};
const POUR_OFFSET = 0.9, POUR_SRC_SEC = 0.76, TARGET_RMS = 0.15, GAIN_MIN = 0.5, GAIN_MAX = 3, PEAK_CAP = 0.9;
(async () => {
  try {
  const ctx = new AudioContext();
  const out = {};
  for (const name of Object.keys(DATA)) {
    const bin = atob(DATA[name]);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const buf = await ctx.decodeAudioData(u.buffer);
    const ch = buf.getChannelData(0), sr = buf.sampleRate;
    const start = name === 'pour' ? Math.floor(POUR_OFFSET * sr) : 0;
    const end = name === 'pour' ? Math.min(ch.length, start + Math.floor(POUR_SRC_SEC * sr)) : ch.length;
    let sum = 0, peak = 0, n = 0;
    for (let i = start; i < end; i++) { const v = ch[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; n++; }
    const rms = Math.sqrt(sum / Math.max(1, n));
    let gain = TARGET_RMS / Math.max(rms, 1e-4);
    if (peak * gain > PEAK_CAP) gain = PEAK_CAP / peak;
    gain = Math.min(GAIN_MAX, Math.max(GAIN_MIN, gain));
    out[name] = { dur: +buf.duration.toFixed(2), rms: +rms.toFixed(3), peak: +peak.toFixed(2), gain: +gain.toFixed(2) };
  }
  window.__RESULT__ = JSON.stringify(out);
  } catch (e) { window.__RESULT__ = JSON.stringify({ __error__: e.message }); }
})();
</script></body></html>`;

const htmlPath = join(tmpdir(), 'sfx-analyze.html');
const profileDir = join(tmpdir(), 'sfx-analyze-profile');
writeFileSync(htmlPath, html);

// ---- 无头启动 + CDP 轮询取结果（--dump-dom 不等异步解码，弃用） ----
const exe = BROWSERS.find((p) => { try { execFileSync(p, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!exe) { console.error('ERR: 找不到 Edge/Chrome，可用环境变量 SFX_BROWSER 指定'); process.exit(1); }

const PORT = 9223;
const child = spawn(exe, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  'file:///' + htmlPath.replace(/\\/g, '/'),
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let result = null;
try {
  let wsUrl = null;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) { /* 端口未就绪 */ }
  }
  if (!wsUrl) throw new Error('无头浏览器调试端口未就绪');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const evalExpr = `(async () => { for (let i = 0; i < 200 && !window.__RESULT__; i++) await new Promise(r => setTimeout(r, 100)); return window.__RESULT__ || 'TIMEOUT'; })()`;
  result = await new Promise((res, rej) => {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) {
        const val = msg.result?.result?.value;
        if (!val) return rej(new Error('evaluate 失败: ' + JSON.stringify(msg.result)));
        res(val === 'TIMEOUT' ? { __error__: '页面 20s 内未完成分析' } : JSON.parse(val));
      }
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: evalExpr, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
} catch (e) {
  result = { __error__: e.message };
} finally {
  try { child.kill(); } catch (e) { /* 进程已退 */ }
  rmSync(htmlPath, { force: true });
  rmSync(profileDir, { recursive: true, force: true });
}
if (result.__error__) { console.error('ERR: ' + result.__error__); process.exit(1); }

// ---- 呈报 ----
console.log(`# 音效响度分析（目标 RMS 0.15，限幅 [0.5,3]，峰值≤0.9）@ ${dir}`);
console.log('# name      时长    RMS    Peak   增益');
for (const [name, r] of Object.entries(result)) {
  console.log(`  ${name.padEnd(10)}${String(r.dur).padStart(5)}s  ${String(r.rms).padStart(5)}  ${String(r.peak).padStart(5)}  ${String(r.gain).padStart(5)}`);
}
const gains = Object.fromEntries(Object.entries(result).map(([k, r]) => [k, r.gain]));
console.log('\n// 粘贴进 audio.js：');
console.log('const GAINS = ' + JSON.stringify(gains) + ';');
if (outFile) {
  writeFileSync(outFile, JSON.stringify(gains, null, 2));
  console.log(`\n# 配置已写入 ${outFile}`);
}
