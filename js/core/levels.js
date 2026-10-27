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
  { name: '奶昔', main: '#F3DDB4', deep: '#DCC49A' },
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
 * 按关卡配置生成关卡列表（v3：defaults 默认模板 + levels 逐关记录，无曲线生成）。
 * 配置存放在 assets/config/levels.json（.json 扩展名，内容为 JSONC），
 * 由入口（js/main.js）或测试读取文件文本并 parseJsonc 后传入本函数，
 * 逻辑层不直接读文件。
 *
 * 取值优先级：levels[n].<字段> > defaults.<字段> > 内置兜底。
 * - 每关一条记录，缺失的记录按 defaults 补全（warn，永不炸游戏）
 * - 逐关随机种子：levels[n].seed 缺省时 = seedBase + 关卡号（满意局面固化用，见配置头注释）
 * - noEmptyStart 生效时空瓶数置 0
 * - 特殊关（bigBottle）/ 混合关（mix）校验清零叠加机制（v1 不叠加）
 */
export function buildLevelsFromConfig(cfg) {
  const levelCount = cfg.levelCount || 0;
  const seedBase = typeof cfg.seedBase === 'number' ? cfg.seedBase : 0;
  const defaults = cfg.defaults || {};
  const records = Array.isArray(cfg.levels) ? cfg.levels : [];
  const byNo = new Map();
  for (const r of records) {
    if (r && Number.isInteger(r.level)) {
      if (byNo.has(r.level)) console.warn(`[levels] L${r.level} 记录重复，后者覆盖`);
      byNo.set(r.level, r);
    }
  }

  const num = (v, fb) => (typeof v === 'number' ? v : fb);
  const levels = [];
  for (let i = 1; i <= levelCount; i++) {
    if (!byNo.has(i)) console.warn(`[levels] L${i} 缺少记录，按 defaults 补全`);
    const r = byNo.get(i) || {};
    const lv = {
      level: i,
      colors: num(r.colors, num(defaults.colors, 4)),
      empties: num(r.empties, num(defaults.empties, 2)),
      capacity: num(r.capacity, num(defaults.capacity, CAPACITY)),
      hiddenCount: num(r.hiddenCount, num(defaults.hiddenCount, 0)),
      condLockCount: num(r.condLockCount, num(defaults.condLockCount, 0)),
      condLockNeed: num(r.condLockNeed, num(defaults.condLockNeed, 2)),
      keyLockCount: num(r.keyLockCount, num(defaults.keyLockCount, 0)),
      noEmptyStart: r.noEmptyStart ?? defaults.noEmptyStart ?? false,
      mix: r.mix ?? defaults.mix ?? false,
      special: r.special ?? defaults.special ?? null,
      bigCapacity: num(r.bigCapacity, num(defaults.bigCapacity, 0)),
      props: { shuffle: 1, addBottle: 1, ...(defaults.props || {}), ...(r.props || {}) },
      // 逐关随机种子（满意局面固化）：缺省 = seedBase + 关卡号
      seed: typeof r.seed === 'number' ? r.seed : seedBase + i,
    };
    if (lv.noEmptyStart) lv.empties = 0; // 无空瓶开局：空瓶数由机制置 0
    _validateSpecial(lv, i);
    _validateMix(lv, i);
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

/**
 * 混合容量关校验（PRD-混合容量瓶 §3，v1 不叠加）：
 * - mix 关强制 condLock/keyLock/hiddenCount 清零、noEmptyStart 强制 false（+ warn）；
 * - 剥离 special（v1 mix 与大瓶互斥，配置层双保险）；
 * - capacity 需为 ≥2 整数（容量池 = capacity±1 至少含 1），非法回退 4。
 */
function _validateMix(lv, level) {
  if (!lv.mix) return;
  if (lv.special === 'bigBottle') {
    console.warn(`[levels] L${level} 混合关不叠加特殊关（v1），special 剥离`);
    delete lv.special;
    delete lv.bigCapacity;
  }
  const forceZero = [
    ['condLockCount', '条件锁'],
    ['keyLockCount', '钥匙锁'],
    ['hiddenCount', '隐藏层'],
  ];
  for (const [k, label] of forceZero) {
    if (lv[k]) {
      console.warn(`[levels] L${level} 混合关不叠加${label}（v1），${k} 强制 0`);
      lv[k] = 0;
    }
  }
  if (lv.noEmptyStart) {
    console.warn(`[levels] L${level} 混合关不叠加无空瓶开局（v1），noEmptyStart 强制 false`);
    lv.noEmptyStart = false;
  }
  if (!(Number.isInteger(lv.capacity) && lv.capacity >= 2)) {
    console.warn(`[levels] L${level} 混合关 capacity=${lv.capacity} 非法（需 ≥2 整数），回退 4`);
    lv.capacity = 4;
  }
}
