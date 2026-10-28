/**
 * 加载进度条素材管线（PRD-关卡生成异步化与加载界面 F-07）：
 * AI 原图（assets/images/loading-src/）→ cleanEdges 清边 → alphaBBox 裁剪 → resize（预乘 alpha）
 * → 成品 assets/images/loading-bar.png（外框）/ loading-fill.png（果汁填充）。
 * 用法：node tools/process-loading-bar.mjs [框原图] [填充原图]（缺省取 loading-src 下最新两张）
 */
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readPng, writePng, cleanEdges, alphaBBox, crop, resize } from '../.codebuddy/skills/process/art-style/scripts/imgproc.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = join(root, 'assets/images/loading-src');
const OUT_W = 720; // 成品宽（逻辑 360 × dpr2）

const files = readdirSync(SRC_DIR)
  .filter((f) => f.toLowerCase().endsWith('.png'))
  .map((f) => join(SRC_DIR, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
if (files.length < 2) {
  console.error('loading-src 下不足两张 PNG（需框 + 填充）');
  process.exit(1);
}
// 建议显式传参指定「框 / 填充」对应关系（生成文件名不含语义，缺省按时间序兜底）
const frameSrc = process.argv[2] || files[0];
const fillSrc = process.argv[3] || files[1];
console.log(`frame ← ${frameSrc}\nfill   ← ${fillSrc}`);

for (const [src, out] of [
  [frameSrc, join(root, 'assets/images/loading-bar.png')],
  [fillSrc, join(root, 'assets/images/loading-fill.png')],
]) {
  let img = readPng(src);
  // 清边（AI 生成物光晕切除）：UI 大色块素材用温和参数 —— 阈值 128 切低 alpha 光晕雾、
  // 腐蚀 1 遍防细节蚕食（默认 230/2 遍会把半透明果汁整个切空）。cleanEdges 返回 px，需回填
  img = { ...img, px: cleanEdges(img, { alphaThresh: 128, erodePass: 1, feather: 1 }) };
  img = crop(img, alphaBBox(img), 0);
  img = resize(img, OUT_W);
  writePng(out, img);
  console.log(`→ ${out}  ${img.w}x${img.h}`);
}
