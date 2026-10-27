// 从参考图色键抠出空瓶 → bottle-glass.png（备选路线：AI 生成是主路线）
// 迁移自 extract-bottle-ref.ps1（2026-10-27 mjs 化）
// 逻辑：背景米色 (252,243,227) 严格色键 ±16；瓶体定位用深棕描边像素（排除去饱和地面投影）；
//       最右簇 = 空瓶，描边 bbox 外扩 2px → 裁剪 → 132 宽缩放；附半瓶液体/层间白线测量输出
// 用法: node tools/extract-bottle-ref.mjs [参考图PNG]
// ⚠️ 会覆盖 assets/images/bottle-glass.png（当前为 AI 生成瓶）——仅在明确要走抠图路线时运行
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, writePng, resize, alphaBBox } from '../.codebuddy/skills/process/art-style/scripts/imgproc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refPath = process.argv[2] || path.join(root, 'assets/images/liquid-src/ref-liquid-v1.png');
const outPath = path.join(root, 'assets/images/bottle-glass.png');
const BG = [252, 243, 227]; // 米色背景（RGBA 顺序）
const TOL = 16;
const masterW = 132;

const img = readPng(refPath);
const { w, h, px } = img;
console.log(`ref ${w}x${h}`);

// 1) 背景色键（米色 → 透明）
for (let i = 0; i < px.length; i += 4) {
  if (Math.abs(px[i] - BG[0]) <= TOL && Math.abs(px[i + 1] - BG[1]) <= TOL && Math.abs(px[i + 2] - BG[2]) <= TOL) {
    px[i + 3] = 0;
  }
}

// 2) 深棕描边判定：亮度低且有色饱和度
const isOutline = (i) => {
  const r = px[i], g = px[i + 1], b = px[i + 2];
  const bright = (r + g + b) / 3;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return bright < 130 && (mx - mn) > 25;
};

// 3) 描边像素列投影 → 瓶簇（列内描边像素数 > 3 视为瓶体列）
const colCount = new Int32Array(w);
for (let x = 0; x < w; x++) {
  let n = 0;
  for (let y = 0; y < h; y++) {
    const i = (y * w + x) * 4;
    if (px[i + 3] > 40 && isOutline(i)) n++;
  }
  colCount[x] = n;
}
const clusters = [];
let inC = false, s = 0;
for (let x = 0; x < w; x++) {
  if (colCount[x] > 3 && !inC) { inC = true; s = x; }
  if (colCount[x] <= 3 && inC) { inC = false; clusters.push([s, x - 1]); }
}
if (inC) clusters.push([s, w - 1]);
console.log('clusters:', clusters.map(([a, b]) => `${a}-${b}`).join(', '));

// 4) 簇内描边像素求 bbox（排除地面投影）
const outlineBBox = (x0, x1) => {
  let minY = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] > 40 && isOutline(i)) {
        if (minY < 0) minY = y;
        maxY = y;
        break;
      }
    }
  }
  return [minY, maxY];
};

// 5) 最右簇 = 空瓶 → bottle-glass.png（bbox 外扩 2px 保留描边抗锯齿）
const [e0, e1] = clusters[clusters.length - 1];
const [eb0, eb1] = outlineBBox(e0, e1);
const cropRect = {
  minX: Math.max(0, e0 - 2), minY: Math.max(0, eb0 - 2),
  maxX: Math.min(w - 1, e1 + 2), maxY: Math.min(h - 1, eb1 + 2),
};
const cw = cropRect.maxX - cropRect.minX + 1;
const ch = cropRect.maxY - cropRect.minY + 1;
console.log(`empty bottle outline bbox y[${eb0},${eb1}] crop ${cw}x${ch} aspect=${(ch / cw).toFixed(3)}`);
const cropped = { w: cw, h: ch, px: Buffer.alloc(cw * ch * 4) };
for (let y = 0; y < ch; y++) {
  px.copy(cropped.px, y * cw * 4, ((cropRect.minY + y) * w + cropRect.minX) * 4, ((cropRect.minY + y) * w + cropRect.minX + cw) * 4);
}
const master = resize(cropped, masterW);
writePng(outPath, master);
console.log(`bottle-glass.png replaced ${master.w}x${master.h}`);

// 6) 附：半瓶蓝液体测量（中簇；供白模/滤色标定参考）
if (clusters.length >= 2) {
  const [m0, m1] = clusters[1];
  let top = -1, bot = -1, minX = w, maxX = -1;
  const isBlue = (i) => px[i + 2] > 140 && px[i + 2] > px[i] + 40 && px[i + 2] > px[i + 1] + 20;
  for (let y = 0; y < h; y++) {
    for (let x = m0; x <= m1; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] < 200 || !isBlue(i)) continue;
      if (top < 0) top = y;
      bot = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  console.log(`blue liquid bbox x[${minX},${maxX}] y[${top},${bot}] w=${maxX - minX + 1}`);
}
