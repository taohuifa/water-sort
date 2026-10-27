// 蓝色主图亮度保持重上色 → 9 色（备选滤色路线：直接以蓝基色亮度映射，不经白模）
// 迁移自 recolor-liquid.ps1（2026-10-27 mjs 化）
// 与白模滤色（process-liquid-ai.mjs 主路线）的区别：本路线以基准蓝 (0,147,250) 的
// 亮度 Lref 为参照——暗部乘 shade、亮部向白渐近；适合已有成品蓝主图、不想重建白模时换色
// 用法: node tools/recolor-liquid.mjs [蓝色主图PNG]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, writePng } from '../.codebuddy/skills/process/art-style/scripts/imgproc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2] || path.join(root, 'assets/images/liquid-src/liquid-tpl.png');
const outDir = path.join(root, 'assets/images');
const REF = [0, 147, 250]; // 基准蓝
const refL = 0.299 * REF[0] + 0.587 * REF[1] + 0.114 * REF[2];

const targets = [
  { n: '0', name: '草莓', rgb: [249, 79, 109] },
  { n: '1', name: '橙子', rgb: [255, 152, 56] },
  { n: '2', name: '芒果', rgb: [255, 201, 51] },
  { n: '3', name: '青苹果', rgb: [139, 212, 80] },
  { n: '4', name: '蓝莓', rgb: [91, 141, 239] },
  { n: '5', name: '葡萄', rgb: [162, 107, 242] },
  { n: '6', name: '奶昔', rgb: [243, 221, 180] },
  { n: '7', name: '抹茶', rgb: [79, 176, 140] },
  { n: 'hidden', name: '隐藏灰紫', rgb: [158, 143, 181] },
];

const img = readPng(input);
for (const t of targets) {
  const [tr, tg, tb] = t.rgb;
  const out = Buffer.from(img.px);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] < 8) continue;
    const L = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2];
    let r, g, b;
    if (L <= refL) {
      const k = L / refL; // 暗部等比压暗
      r = tr * k; g = tg * k; b = tb * k;
    } else {
      const k = (L - refL) / (255 - refL); // 亮部向白渐近（保色相）
      r = tr + (255 - tr) * k; g = tg + (255 - tg) * k; b = tb + (255 - tb) * k;
    }
    out[i] = Math.min(255, Math.round(r));
    out[i + 1] = Math.min(255, Math.round(g));
    out[i + 2] = Math.min(255, Math.round(b));
  }
  writePng(path.join(outDir, `liquid-tpl-${t.n}.png`), { w: img.w, h: img.h, px: out });
  console.log(`OK liquid-tpl-${t.n}.png (${t.name})`);
}
console.log('DONE');
