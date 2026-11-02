#!/usr/bin/env node
/**
 * gen-sfx-tuner.mjs — 音效音量人工调音页生成器（零依赖，Node ≥18）
 *
 * 用途：用户耳朵是最终标准。生成带滑杆的试听页，逐颗拖到满意音量，
 *       点「生成 GAINS 配置」复制结果，回贴给 AI 更新程序的静态增益表。
 *       播放口径与游戏一致（pour: 0.9s 起 2x 速 0.38s 截断；其余全长）。
 *
 * 用法：
 *   node gen-sfx-tuner.mjs [audioDir] [--gains '{"complete":0.5,...}']
 *     audioDir 默认 ./assets/audio（bgm.mp3 自动排除）
 *     --gains  滑杆初始值（默认全 1；通常传程序里当前的 GAINS，在此基础上微调）
 *
 * 流程：生成 HTML（base64 内嵌音频）→ 系统默认浏览器打开 → 用户拖滑杆试听 →
 *       复制页面上生成的 GAINS 配置 → AI 更新 audio.js。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const gainsIdx = argv.indexOf('--gains');
let initGains = {};
if (gainsIdx >= 0) { try { initGains = JSON.parse(argv[gainsIdx + 1]); } catch (e) { console.error('ERR: --gains 不是合法 JSON'); process.exit(1); } }
const dir = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : './assets/audio');

const files = readdirSync(dir).filter((f) => f.endsWith('.mp3') && f !== 'bgm.mp3');
if (!files.length) { console.error(`ERR: ${dir} 下没有音效 mp3`); process.exit(1); }

const dataJs = files
  .map((f) => `${f.replace('.mp3', '')}: "${readFileSync(join(dir, f)).toString('base64')}"`)
  .join(',\n');
const initJs = JSON.stringify(initGains);

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>音效音量调音台</title>
<style>
body{font-family:sans-serif;max-width:720px;margin:40px auto}
.row{display:flex;align-items:center;gap:14px;margin:14px 0;padding:10px;border:1px solid #ddd;border-radius:8px}
.row button{font-size:16px;padding:8px 16px;cursor:pointer}
.row input[type=range]{flex:1}
.row .val{width:52px;text-align:right;font-weight:bold;font-size:18px}
.row .name{width:90px;font-size:16px}
label.rep{font-size:14px;color:#556}
#cfg{width:100%;height:60px;margin-top:8px;font-family:monospace}
h3{margin-bottom:4px}#tip{color:#666;font-size:14px}
</style></head>
<body>
<h2>音效音量调音台</h2>
<p id="tip">拖动滑杆调音量（游戏内播出口径：pour 为 0.9s 起 2x 速 0.38s 截断）→ 点播放试听 →
勾「循环」可反复听 → 调好后点底部按钮，复制文本框内容发给 AI。</p>
<label class="rep"><input type="checkbox" id="rep"> 循环播放（选中音效反复播）</label>
<div id="rows"></div>
<button style="font-size:18px;padding:12px 24px" onclick="genCfg()">生成 GAINS 配置</button>
<textarea id="cfg" placeholder="点上方按钮生成配置，全选复制发给 AI"></textarea>
<script>
const DATA = {
${dataJs}
};
const INIT = ${initJs};
let ctx, bufs = {}, gains = {}, srcs = {};
async function ensure(name) {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state !== 'running') await ctx.resume();
  if (!bufs[name]) {
    const bin = atob(DATA[name]); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    bufs[name] = await ctx.decodeAudioData(u.buffer);
  }
  return bufs[name];
}
function stop(name) { try { if (srcs[name]) { srcs[name].onended = null; srcs[name].stop(); } } catch (e) {} srcs[name] = null; }
async function play(name) {
  const buf = await ensure(name);
  stop(name);
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = gains[name];
  src.connect(g); g.connect(ctx.destination);
  if (name === 'pour') { src.playbackRate.value = 2; src.start(t, 0.9); src.stop(t + 0.38); }
  else src.start(t);
  srcs[name] = src;
  src.onended = () => { srcs[name] = null; if (document.getElementById('rep').checked) play(name); };
}
function genCfg() {
  const out = {};
  for (const k of Object.keys(gains)) out[k] = +(+gains[k]).toFixed(2);
  document.getElementById('cfg').value = 'const GAINS = ' + JSON.stringify(out) + ';';
}
const rows = document.getElementById('rows');
for (const name of Object.keys(DATA)) {
  gains[name] = INIT[name] != null ? INIT[name] : 1;
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML =
    '<button onclick="play(\\'' + name + '\\')">▶ ' + name + '</button>' +
    '<input type="range" min="0" max="2.5" step="0.05" value="' + gains[name] + '" id="s_' + name + '">' +
    '<span class="val" id="v_' + name + '">' + gains[name] + '</span>';
  rows.appendChild(row);
  document.getElementById('s_' + name).oninput = (e) => {
    gains[name] = +e.target.value;
    document.getElementById('v_' + name).textContent = gains[name];
  };
  // 拖动结束（松手）重播一次，让新增益立即生效可听
  document.getElementById('s_' + name).onchange = () => { if (srcs[name]) play(name); };
}
</script></body></html>`;

const out = join(tmpdir(), 'sfx-tuner.html');
writeFileSync(out, html);
console.log(`OK ${out}`);
// 尝试直接打开浏览器
const openers = process.platform === 'win32'
  ? [['cmd', ['/c', 'start', '', out]]]
  : [['xdg-open', [out]]];
try { spawn(openers[0][0], openers[0][1], { detached: true, stdio: 'ignore' }).unref(); }
catch (e) { console.log('# 请手动用浏览器打开上面的文件'); }
