// AI 液体素材管线（瘦封装）：AI 原图 → 清边 → 裁剪缩放 → 白模 → 9 色滤色
// 通用函数在 art-style skill: .codebuddy/skills/process/art-style/scripts/imgproc.mjs
// 产物: liquid-src/liquid-tpl.png（蓝色主图）+ liquid-src/liquid-tpl-white.png（白模）
//       + images/liquid-tpl-{0..7,hidden}.png（9 色，运行时只用这 9 张）
// 用法: node tools/process-liquid-ai.mjs [输入PNG]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPng, writePng, cleanEdges, alphaBBox, crop, resize, whiteMap, tint,
} from '../.codebuddy/skills/process/art-style/scripts/imgproc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2] || path.join(root, 'assets/images/liquid-src/ai-raw.png');
const imgRoot = path.join(root, 'assets/images');
const srcDir = path.join(imgRoot, 'liquid-src');
const masterW = 128;

const targets = [
  { n: '0', name: '草莓', rgb: [249, 79, 109] },
  { n: '1', name: '橙子', rgb: [255, 152, 56] },
  { n: '2', name: '芒果', rgb: [255, 201, 51] },
  { n: '3', name: '青苹果', rgb: [139, 212, 80] },
  { n: '4', name: '蓝莓', rgb: [91, 141, 239] },
  { n: '5', name: '葡萄', rgb: [162, 107, 242] },
  { n: '6', name: '奶昔', rgb: [243, 221, 180] }, // 原椰子白与白玻璃难分辨，2026-10-27 调整
  { n: '7', name: '抹茶', rgb: [79, 176, 140] },
  { n: 'hidden', name: '隐藏灰紫', rgb: [158, 143, 181] },
];

// 1) 清边 + 裁剪 + 缩放主图
let img = readPng(input);
img.px = cleanEdges(img);
const bbox = alphaBBox(img);
if (!bbox) throw new Error('全透明：清洗参数过狠');
const master = resize(crop(img, bbox), masterW);
writePng(path.join(srcDir, 'liquid-tpl.png'), master);
console.log(`OK liquid-src/liquid-tpl.png (${master.w} x ${master.h})`);

// 2) 白模（主体基准亮度 = 127.5）
const wm = whiteMap(master);
writePng(path.join(srcDir, 'liquid-tpl-white.png'), { w: master.w, h: master.h, px: wm.px });
console.log(`OK liquid-src/liquid-tpl-white.png (Lbody = ${wm.Lbody.toFixed(1)})`);

// 3) 9 色滤色（色相保持：暗部乘 shade、亮部向白渐近）
for (const t of targets) {
  const px = tint(wm.px, t.rgb);
  writePng(path.join(imgRoot, `liquid-tpl-${t.n}.png`), { w: master.w, h: master.h, px });
  console.log(`OK liquid-tpl-${t.n}.png (${t.name})`);
}
console.log('DONE');
