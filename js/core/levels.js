/**
 * 关卡配置与颜色表
 * 颜色 ID 即 COLORS 下标；每种颜色的液体总量恒等于瓶容量，保证能满瓶
 */

export const CAPACITY = 4; // 每瓶容量（层数）

export const COLORS = [
  { name: '草莓', main: '#F94F6D', deep: '#D42B4E' },
  { name: '橙子', main: '#FF9838', deep: '#E67714' },
  { name: '芒果', main: '#FFC933', deep: '#E5A800' },
  { name: '青苹果', main: '#8BD450', deep: '#6BB032' },
  { name: '蓝莓', main: '#5B8DEF', deep: '#3A6BD4' },
  { name: '葡萄', main: '#A26BF2', deep: '#7F44D6' },
  { name: '椰子', main: '#F3EAD7', deep: '#D8C9A8' },
  { name: '抹茶', main: '#4FB08C', deep: '#338F6C' },
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
 * 曲线段取值：返回 fromLevel ≤ level 的最大段的 value；无匹配段/无曲线时回退 fallback。
 */
function segValue(segments, level, fallback) {
  if (!Array.isArray(segments)) return fallback;
  let v = fallback;
  for (const seg of segments) {
    if (level >= seg.fromLevel) v = seg.value;
  }
  return v;
}

/**
 * 按难度曲线配置生成关卡列表。
 * 配置存放在 assets/config/levels.json（.json 扩展名，内容为 JSONC），
 * 由入口（js/main.js）或测试读取文件文本并 parseJsonc 后传入本函数，
 * 逻辑层不直接读文件。
 *
 * 生成优先级：overrides[关卡号] > 曲线段 > 旧字段默认值。
 * 新字段全部可选，缺失时逐项回退到旧行为（容量 4、道具全程 {1,1}、无锁）。
 *
 * 生成规则：
 * - 颜色数每 colorStepEvery（默认 2）关 +1，封顶 maxColors
 * - 空瓶数：emptiesCurve 分段阶梯；未配置时回退 baseEmpties + extraEmptyFromLevel 旧公式
 * - 容量：capacityCurve 分段（3~8）；未配置时恒为 CAPACITY
 * - 问号隐藏层：第 hiddenFromLevel 关起每 hiddenStepEvery（默认 2）关 +1，封顶 hiddenMax
 * - 道具：props.freeUntilLevel 之前出厂 {1,1}，之后 {0,0}（仅广告补给）
 * - 机制：mechanics.*.fromLevel 起启用（condLock/keyLock/noEmptyStart），noEmptyStart 时 empties=0
 */
export function buildLevelsFromConfig(curve) {
  const colorStep = curve.colorStepEvery || 2;
  const hiddenStep = curve.hiddenStepEvery || 2;
  const freeUntil = curve.props ? curve.props.freeUntilLevel : undefined;
  const mech = curve.mechanics || {};
  const overrides = curve.overrides || {};
  const fromLevel = (m) => (m && m.fromLevel != null ? m.fromLevel : Infinity);

  const levels = [];
  for (let i = 0; i < curve.levelCount; i++) {
    const level = i + 1;
    const lv = {
      level,
      colors: Math.min(curve.maxColors, curve.startColors + Math.floor(level / colorStep)),
      empties: Array.isArray(curve.emptiesCurve)
        ? segValue(curve.emptiesCurve, level, curve.baseEmpties)
        : curve.baseEmpties + (level >= curve.extraEmptyFromLevel ? 1 : 0),
      hiddenCount:
        level >= curve.hiddenFromLevel
          ? Math.min(curve.hiddenMax, Math.floor((level - curve.hiddenFromLevel) / hiddenStep) + 1)
          : 0,
      seed: curve.seedBase + level,
      capacity: segValue(curve.capacityCurve, level, CAPACITY),
      props:
        freeUntil === undefined || level <= freeUntil
          ? { shuffle: 1, addBottle: 1 }
          : { shuffle: 0, addBottle: 0 },
      condLockCount: level >= fromLevel(mech.condLock) ? 1 : 0,
      condLockNeed: (mech.condLock && mech.condLock.need) || 2,
      keyLockCount: level >= fromLevel(mech.keyLock) ? 1 : 0,
      noEmptyStart: level >= fromLevel(mech.noEmptyStart),
    };
    if (lv.noEmptyStart) lv.empties = 0; // 无空瓶开局：空瓶数由机制置 0（非空瓶曲线段）
    const ov = overrides[String(level)] || overrides[level];
    if (ov) Object.assign(lv, ov);
    _validateSpecial(lv, level);
    levels.push(lv);
  }
  return levels;
}

/**
 * 特殊关（v1 仅 bigBottle）配置校验（PRD §2.1，S-01）：
 * - bigCapacity 非法（缺省 / 非整数 / 小于普通瓶容量）→ 剥离 special 字段回退普通关 + warn；
 * - 合法则强制 hiddenCount/condLockCount/keyLockCount/noEmptyStart 清零（v1 不叠加，
 *   配置显式写了也按 0 处理 + warn），empties 保持曲线/override 原值。
 */
function _validateSpecial(lv, level) {
  if (lv.special !== 'bigBottle') return;
  const capOk =
    typeof lv.bigCapacity === 'number' && Number.isInteger(lv.bigCapacity) && lv.bigCapacity >= lv.capacity;
  if (!capOk) {
    console.warn(
      `[levels] L${level} special=bigBottle 配置非法（bigCapacity=${lv.bigCapacity} 需为整数且 ≥ capacity=${lv.capacity}），回退普通关`
    );
    delete lv.special;
    delete lv.bigCapacity;
    return;
  }
  const forceZero = [
    ['hiddenCount', '隐藏层'],
    ['condLockCount', '条件锁'],
    ['keyLockCount', '钥匙锁'],
  ];
  for (const [k, label] of forceZero) {
    if (lv[k]) {
      console.warn(`[levels] L${level} 特殊关不叠加${label}（v1），${k} 强制 0`);
      lv[k] = 0;
    }
  }
  if (lv.noEmptyStart) {
    console.warn(`[levels] L${level} 特殊关不叠加无空瓶开局（v1），noEmptyStart 强制 false`);
    lv.noEmptyStart = false;
  }
}
