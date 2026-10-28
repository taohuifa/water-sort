/**
 * 三星步数评价纯逻辑（PRD-玩法扩展 §2 C）：
 * 星级线：3★ = moves ≤ par；2★ = moves ≤ ⌈par×1.5⌉；1★ = 通关。
 * par 缺失 / 非法按 1★ 兜底（配置 theoretically 必有 par，容错不炸）。
 * 纯函数、无状态、不依赖 wx（存档读写与时机控制归 main.js 胶水层）。
 */

/** 2★ 步数上限 = ⌈par × 1.5⌉（向上取整） */
export function twoStarLimit(par) {
  return Math.ceil(par * 1.5);
}

/**
 * 星级计算：moves 为本局步数（logic.moveCount），par 为关卡最短步数（levels.json 回填）。
 * par 非正整数（缺失 / 0 / 负数 / 非整数）→ 一律 1★（通关兜底，不报错）。
 */
export function calcStars(moves, par) {
  if (typeof par !== 'number' || !Number.isInteger(par) || par <= 0) return 1;
  if (moves <= par) return 3;
  if (moves <= twoStarLimit(par)) return 2;
  return 1;
}

/**
 * 存档清洗：旧纪录（可能为空串 / null / 缺字段 / 非法值）→ 合法 {bestMoves, stars} 或 null。
 * bestMoves 须为非负整数；stars 须为 1~3 整数。
 */
export function sanitizeRecord(saved) {
  if (!saved || typeof saved !== 'object') return null;
  const { bestMoves, stars } = saved;
  if (typeof bestMoves !== 'number' || !Number.isInteger(bestMoves) || bestMoves < 0) return null;
  if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 3) return null;
  return { bestMoves, stars };
}

/**
 * 最佳纪录合并：更优才更新（步数更小或星更多，二者独立判断，防御 par 变更后的旧档）。
 * @returns 更优后的新纪录 {bestMoves, stars}；无改进返回 null（调用方不写档）。
 * 不修改入参。
 */
export function mergeRecord(saved, moves, stars) {
  const old = sanitizeRecord(saved);
  if (!old) return { bestMoves: moves, stars };
  if (moves < old.bestMoves || stars > old.stars) {
    return { bestMoves: Math.min(moves, old.bestMoves), stars: Math.max(stars, old.stars) };
  }
  return null;
}
