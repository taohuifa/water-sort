/**
 * 关卡配置与颜色表
 * 颜色 ID 即 COLORS 下标；每种颜色的液体总量恒等于瓶容量，保证能满瓶
 */

export const CAPACITY = 4; // 每瓶容量（层数）

export const COLORS = [
  { name: '草莓', main: '#F94F6D' },
  { name: '橙子', main: '#FF9838' },
  { name: '芒果', main: '#FFC933' },
  { name: '青苹果', main: '#8BD450' },
  { name: '蓝莓', main: '#5B8DEF' },
  { name: '葡萄', main: '#A26BF2' },
  { name: '椰子', main: '#F3EAD7' },
  { name: '抹茶', main: '#4FB08C' },
];

/**
 * 解析 .jsonc 配置文本（JSON with Comments）：
 * 剥离行注释与块注释后交给 JSON.parse，字符串字面量内的注释符号不误伤。
 * 用于加载 assets/config/ 下的关卡配置。
 */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] || '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(out);
}

/**
 * 按难度曲线配置生成关卡列表。
 * 配置存放在 assets/config/levels.jsonc（.jsonc：带注释的 JSON），
 * 由入口（js/main.js）或测试读取文件文本并 parseJsonc 后传入本函数，
 * 逻辑层不直接读文件。
 *
 * 生成规则：
 * - 颜色数每 2 关 +1（2,3,3,4,4,5,5,6,6,7...），封顶 maxColors
 * - 空瓶数：baseEmpties，自 extraEmptyFromLevel 关起 +1
 * - 问号隐藏层：第 hiddenFromLevel 关起每 2 关 +1，封顶 hiddenMax（1,1,2,2,3,3...）
 */
export function buildLevelsFromConfig(curve) {
  const levels = [];
  for (let i = 0; i < curve.levelCount; i++) {
    const level = i + 1;
    const colors = Math.min(curve.maxColors, curve.startColors + Math.floor(level / 2));
    const empties = curve.baseEmpties + (level >= curve.extraEmptyFromLevel ? 1 : 0);
    const hiddenCount =
      level >= curve.hiddenFromLevel
        ? Math.min(curve.hiddenMax, Math.floor((level - curve.hiddenFromLevel) / 2) + 1)
        : 0;
    levels.push({ level, colors, empties, hiddenCount, seed: curve.seedBase + level });
  }
  return levels;
}
