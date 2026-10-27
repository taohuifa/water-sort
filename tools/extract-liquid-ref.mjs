// 从参考图色键抠出蓝色液体 → 液体形状模板（自带平盖/高光/U 底）（备选路线）
// 迁移自 extract-liquid-ref.ps1（2026-10-27 mjs 化）
// 产出: liquid-src/liquid-tpl-extract.png（不覆盖 AI 主图 liquid-tpl.png——如要走抠图路线，
//       确认后手动改名顶替，再跑 process-liquid-ai.mjs 出 9 色）
// ⚠️ 历史教训：色键抠图的边缘抗锯齿像素混背景色 → 渲染白框（v4 根因），抠图路线需再清边
// 用法: node tools/extract-liquid-ref.mjs [参考图PNG]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, writePng } from '../.codebuddy/skills/process/art-style/scripts/imgproc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refPath = process.argv[2] || path.join(root, 'assets/images/liquid-src/ref-liquid-v1.png');
const outPath = path.join(root, 'assets/images/liquid-src/liquid-tpl-extract.png');
const BG = [252, 243, 227];
const TOL = 16;
// 参考图中瓶（中簇）横向范围（原 ps1 实测：227~351）
const SCAN_X0 = 227, SCAN_X1 = 351;

const img = readPng(refPath);
const { w, h, px } = img;

// 1) 背景色键
for (let i = 0; i < px.length; i += 4) {
  if (Math.abs(px[i] - BG[0]) <= TOL && Math.abs(px[i + 1] - BG[1]) <= TOL && Math.abs(px[i + 2] - BG[2]) <= TOL) {
    px[i + 3] = 0;
  }
}

// 2) 蓝色液体 bbox
const isBlue = (i) => px[i + 2] > 140 && px[i + 2] > px[i] + 40 && px[i + 2] > px[i + 1] + 20;
let top = -1, bot = -1, minX = w, maxX = -1;
for (let y = 0; y < h; y++) {
  for (let x = SCAN_X0; x <= SCAN_X1; x++) {
    const i = (y * w + x) * 4;
    if (px[i + 3] < 200 || !isBlue(i)) continue;
    if (top < 0) top = y;
    bot = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
}
console.log(`liquid bbox x[${minX},${maxX}] y[${top},${bot}]`);
if (top < 0) throw new Error('未找到蓝色液体（检查参考图/扫描范围）');

// 3) 抠图落位（保留 alpha）
const cw = maxX - minX + 1, ch = bot - top + 1;
const out = Buffer.alloc(cw * ch * 4);
for (let y = 0; y < ch; y++) {
  px.copy(out, y * cw * 4, ((top + y) * w + minX) * 4, ((top + y) * w + minX + cw) * 4);
}
writePng(outPath, { w: cw, h: ch, px: out });
console.log(`OK ${outPath} ${cw}x${ch}`);
