#!/usr/bin/env node
/**
 * mp3-utils.mjs — mp3 时长测量 / 帧级裁剪工具（Node ≥18，零依赖，无需 ffmpeg）
 *
 * 背景：小游戏音频体积敏感，常需「测时长选短素材」「整曲裁循环段」。
 * 帧级裁剪不重编码、零音质损失；裁剪点对齐帧边界。
 *
 * 用法：
 *   node mp3-utils.mjs measure <文件或目录>...        # 输出 时长/码率/采样率
 *   node mp3-utils.mjs trim <in.mp3> <out.mp3> <startSec> <durSec>
 *     例: trim bgm.mp3 bgm-loop.mp3 1 40              # 取 1s~41s 做 40s 循环段
 *
 * 实测坑（2026-11 water-sort）：
 * - Mixkit SFX preview mp3 统一 128kbps；仅凭文件大小估时长会差 3 倍，必须实测
 * - MPEG 版本位映射：ver 3=MPEG1(1152 样本/帧, 144 系数)、2=MPEG2(576, 72)、0=MPEG2.5
 *   ——判断反了会整体解析失败（曾把 40s 音频读成 0.8s）
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';

const BR = {
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG1 L3
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG2 L3
  0: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG2.5 L3
};
const SRS = [44100, 48000, 32000];

function id3Offset(buf) {
  if (buf.slice(0, 3).toString() === 'ID3') return 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]);
  return 0;
}

/** 逐帧遍历 [from, to)：返回每帧信息（容错：非帧头字节逐字节跳过） */
function walk(buf, from, to, onFrame) {
  let i = from, t = 0, frames = 0;
  while (i < to - 4) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const v = (buf[i + 1] >> 3) & 3, l = (buf[i + 1] >> 1) & 3;
      const bi = (buf[i + 2] >> 4) & 15, si = (buf[i + 2] >> 2) & 3;
      if (l !== 1 || bi === 0 || bi === 15 || si === 3 || !BR[v]) { i++; continue; }
      const br = BR[v][bi] * 1000;
      const sr = SRS[si] / (v === 3 ? 1 : v === 2 ? 2 : 4);
      const pad = (buf[i + 2] >> 1) & 1;
      const size = v === 3 ? Math.floor(144 * br / sr) + pad : Math.floor(72 * br / sr) + pad;
      const per = (v === 3 ? 1152 : 576) / sr;
      onFrame({ i, size, br, sr, per, t }); // t = 本帧起始时刻（秒）
      t += per; i += size; frames++;
    } else i++;
  }
  return { duration: t, frames };
}

const collect = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) return readdirSync(p).filter((f) => f.endsWith('.mp3')).map((f) => `${p}/${f}`);
  return [p];
};

const [, , cmd, ...args] = process.argv;
if (cmd === 'measure') {
  for (const p of args.flatMap(collect)) {
    const buf = readFileSync(p);
    const { duration, frames } = walk(buf, id3Offset(buf), buf.length, () => {});
    console.log(`${p}  ${(buf.length / 1024).toFixed(0)}KB  ${duration.toFixed(2)}s  ${frames} 帧`);
  }
} else if (cmd === 'trim') {
  const [inPath, outPath, startSec, durSec] = args;
  const buf = readFileSync(inPath);
  const off = id3Offset(buf);
  let startByte = -1, endByte = buf.length;
  walk(buf, off, buf.length, (f) => {
    if (startByte < 0 && f.t >= Number(startSec)) startByte = f.i;
    else if (startByte >= 0 && endByte === buf.length && f.t >= Number(startSec) + Number(durSec)) endByte = f.i;
  });
  if (startByte < 0) { console.error('ERR: 起点超出音频长度'); process.exit(1); }
  writeFileSync(outPath, buf.subarray(startByte, endByte));
  const out = buf.subarray(startByte, endByte);
  const { duration } = walk(out, 0, out.length, () => {});
  console.log(`OK ${outPath}  ${out.length ? (out.length / 1024).toFixed(0) + 'KB' : '0KB'}  ${duration.toFixed(1)}s`);
} else {
  console.log('用法:');
  console.log('  node mp3-utils.mjs measure <文件或目录>...');
  console.log('  node mp3-utils.mjs trim <in.mp3> <out.mp3> <startSec> <durSec>');
  process.exit(1);
}
