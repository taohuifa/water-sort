// AI 瓶子素材管线（瘦封装）：AI 原图 → 清边 → 真透明玻璃化 → 裁剪缩放
// 通用函数在 art-style skill: .codebuddy/skills/process/art-style/scripts/imgproc.mjs
// 产物: images/bottle-glass.png（三段式绘制素材，BOTTLE_TOP/BOT_FRAC 按此比例标定）
// 用法: node tools/process-bottle-ai.mjs [输入PNG]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPng, writePng, cleanEdges, alphaBBox, crop, resize, glassPx,
} from '../.codebuddy/skills/process/art-style/scripts/imgproc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2] || path.join(root, 'assets/images/bottle-src/ai-raw.png');
const outPath = path.join(root, 'assets/images/bottle-glass.png');
const masterW = 132;

// 1) 清边（AI 生成物带白色光晕，必须清）
let img = readPng(input);
img.px = cleanEdges(img);

// 2) 真透明玻璃化：瓶身白底全透明清除，高光条留 12% 淡影、
//    体侧/底部投影留 35%、深色描边保持实心（默认参数即 v6.1 定稿值）
img.px = glassPx(img.px);

// 3) 裁剪 + 缩放保存
const bbox = alphaBBox(img);
if (!bbox) throw new Error('全透明：清洗参数过狠');
const master = resize(crop(img, bbox), masterW);
writePng(outPath, master);
console.log(`OK bottle-glass.png (${master.w} x ${master.h}, aspect 1:${(master.h / master.w).toFixed(3)})`);
