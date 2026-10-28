/**
 * 三星步数评价单元测试（PRD-玩法扩展 F-05 / Node 直接运行：node tests/stars.test.js）
 * 覆盖：星级边界（=par / par+1 / ⌈par×1.5⌉）/ par 缺失兜底 / 存档更新规则（更优才更新）/
 * par 配置解析透传 / 通关结算存档链路（wx storage mock）/ 调试协议 v2 字段
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// ---------- wx 桩（storage 为内存 Map，验证持久化写入时机与内容） ----------
const noop = () => {};
const gradient = { addColorStop: noop };
const ctxStub = new Proxy(
  {},
  {
    get(target, prop) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
      if (typeof prop === 'symbol') return undefined;
      return target[prop] !== undefined ? target[prop] : noop;
    },
    set(target, prop, v) {
      target[prop] = v;
      return true;
    },
  }
);
const store = new Map();
globalThis.wx = {
  createCanvas: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
  getSystemInfoSync: () => ({ screenWidth: 375, screenHeight: 812, pixelRatio: 2 }),
  onTouchStart: (fn) => {
    globalThis.__ts = fn;
  },
  onTouchMove: (fn) => {
    globalThis.__tm = fn;
  },
  onTouchEnd: (fn) => {
    globalThis.__te = fn;
  },
  onTouchCancel: (fn) => {
    globalThis.__tc = fn;
  },
  setStorageSync: (k, v) => store.set(k, v),
  getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
  removeStorageSync: (k) => store.delete(k),
  getMenuButtonBoundingClientRect: () => ({ top: 24, bottom: 56, height: 32, left: 281, right: 368, width: 87 }),
  getFileSystemManager: () => ({
    readFileSync: (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
  }),
};
globalThis.requestAnimationFrame = () => 1;

const { calcStars, twoStarLimit, mergeRecord, sanitizeRecord } = await import('../js/core/stars.js');
const { buildLevelsFromConfig, parseJsonc } = await import('../js/core/levels.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n      ${err.message}`);
  }
}

console.log('== 星级计算（PRD-玩法扩展 §2 C） ==');

test('T-01：星级边界 —— par=12 时 12/13/18/19 步 = 3/2/2/1 星（PRD AC-3 数值）', () => {
  assert.strictEqual(calcStars(12, 12), 3, '=par 应得 3★');
  assert.strictEqual(calcStars(13, 12), 2, 'par+1 应得 2★');
  assert.strictEqual(calcStars(18, 12), 2, '⌈12×1.5⌉=18 边界内应得 2★');
  assert.strictEqual(calcStars(19, 12), 1, '出界 19 步应得 1★');
});

test('T-02：极值与兜底 —— par=1、0 步、par 缺失/0/负/非整数按 1★ 兜底不报错', () => {
  assert.strictEqual(calcStars(1, 1), 3);
  assert.strictEqual(calcStars(2, 1), 2, '⌈1×1.5⌉=2 边界内 2★');
  assert.strictEqual(calcStars(3, 1), 1);
  assert.strictEqual(calcStars(0, 5), 3, '0 步且 par 合法 → 3★');
  assert.strictEqual(calcStars(10, undefined), 1, 'par 缺失 → 1★ 兜底');
  assert.strictEqual(calcStars(10, null), 1);
  assert.strictEqual(calcStars(10, 0), 1);
  assert.strictEqual(calcStars(10, -3), 1);
  assert.strictEqual(calcStars(10, 4.5), 1, '非整数 par → 1★ 兜底');
  assert.strictEqual(calcStars(10, '12'), 1, '字符串 par → 1★ 兜底');
});

test('T-03：twoStarLimit = ⌈par×1.5⌉（奇数 par 向上取整）', () => {
  assert.strictEqual(twoStarLimit(4), 6);
  assert.strictEqual(twoStarLimit(5), 8);
  assert.strictEqual(twoStarLimit(1), 2);
  assert.strictEqual(twoStarLimit(27), 41);
});

console.log('== 存档更新规则 ==');

test('T-04：mergeRecord —— 首次记录 / 更优才更新 / 无改进返回 null / 不修改入参', () => {
  // 首次（无旧纪录）
  assert.deepStrictEqual(mergeRecord(null, 10, 2), { bestMoves: 10, stars: 2 });
  // 步数更小、星不变 → 更新（bestMoves 取 min）
  assert.deepStrictEqual(mergeRecord({ bestMoves: 15, stars: 2 }, 12, 2), { bestMoves: 12, stars: 2 });
  // 星更多（防御分支，par 变更后可能出现）→ 更新（stars 取 max）
  assert.deepStrictEqual(mergeRecord({ bestMoves: 15, stars: 1 }, 14, 3), { bestMoves: 14, stars: 3 });
  // 无改进 → null（不更新）
  assert.strictEqual(mergeRecord({ bestMoves: 10, stars: 2 }, 12, 2), null, '步数更多且星不变不应更新');
  assert.strictEqual(mergeRecord({ bestMoves: 10, stars: 3 }, 10, 3), null, '完全持平不应更新');
  // 不修改入参
  const saved = { bestMoves: 15, stars: 2 };
  mergeRecord(saved, 12, 2);
  assert.deepStrictEqual(saved, { bestMoves: 15, stars: 2 }, '入参旧纪录不应被修改');
});

test('T-05：sanitizeRecord 容错 —— 非法存档一律 null，合法记录原样保留', () => {
  assert.strictEqual(sanitizeRecord(null), null);
  assert.strictEqual(sanitizeRecord(''), null);
  assert.strictEqual(sanitizeRecord(42), null);
  assert.strictEqual(sanitizeRecord({}), null, '缺字段 → null');
  assert.strictEqual(sanitizeRecord({ bestMoves: -1, stars: 2 }), null, '负数 → null');
  assert.strictEqual(sanitizeRecord({ bestMoves: 1.5, stars: 2 }), null, '非整数 → null');
  assert.strictEqual(sanitizeRecord({ bestMoves: 10, stars: 0 }), null, 'stars 越界(0) → null');
  assert.strictEqual(sanitizeRecord({ bestMoves: 10, stars: 4 }), null, 'stars 越界(4) → null');
  assert.deepStrictEqual(sanitizeRecord({ bestMoves: 10, stars: 3 }), { bestMoves: 10, stars: 3 });
});

console.log('== par 配置解析 ==');

const DIFFICULTY_CURVE = parseJsonc(
  readFileSync(new URL('../assets/config/levels.json', import.meta.url), 'utf8')
);
const LEVELS = buildLevelsFromConfig(DIFFICULTY_CURVE);

test('T-06：100 关 par 全部回填为正整数（solve-report BFS 口径，超限关为 DFS 上界）', () => {
  assert.strictEqual(LEVELS.length, 100);
  for (const lv of LEVELS) {
    assert.ok(
      typeof lv.par === 'number' && Number.isInteger(lv.par) && lv.par > 0,
      `L${lv.level} par 应为正整数，实际 ${lv.par}`
    );
  }
  // 抽检与 solve-report 实跑值一致（L1~L30 冻结红线）
  assert.strictEqual(LEVELS[0].par, 4, 'L1 par=4');
  assert.strictEqual(LEVELS[23].par, 27, 'L24 par=27（30 关段峰值）');
  assert.strictEqual(LEVELS[29].par, 20, 'L30 par=20');
});

test('T-06b：缺 par 的配置透传 null 不炸（calcStars 兜底 1★）', () => {
  const lvs = buildLevelsFromConfig({
    levelCount: 1,
    seedBase: 1,
    defaults: { colors: 4, empties: 2 },
    levels: [{ level: 1 }],
  });
  assert.strictEqual(lvs[0].par, null);
  assert.strictEqual(calcStars(5, lvs[0].par), 1, 'par 缺失通关按 1★ 兜底');
});

console.log('== 通关结算链路（wx storage mock） ==');

// 构造 Main（复用桩；GameGlobal 不存在 → 不挂载调试入口，debugBridge 走 storage 桥）
const { default: Main } = await import('../js/main.js');
const BEST_KEY = 'juicesort_best';
const main = new Main();
main.scene = 'game'; // loadLevel 不切场景（与游戏内 selectLevel 口径一致），通关判定需在 game 场景
const { logic, anims } = main;

/** DFS 求解当前局面（测试专用，返回步序列） */
function dfsSolve() {
  const visited = new Set();
  const path = [];
  const dfs = () => {
    if (logic.isWin()) return true;
    const key = JSON.stringify(logic.bottles) + JSON.stringify([...logic.removed]) + JSON.stringify(logic.unlocked);
    if (visited.has(key)) return false;
    visited.add(key);
    for (let from = 0; from < logic.bottles.length; from++) {
      for (let to = 0; to < logic.bottles.length; to++) {
        if (from === to || logic.canPour(from, to) === 0) continue;
        logic.pour(from, to);
        path.push([from, to]);
        if (dfs()) return true;
        path.pop();
        logic.undo();
      }
    }
    return false;
  };
  return dfs() ? path : null;
}

const fastForward = () => {
  for (let i = 0; i < 200 && !anims.allDone(); i++) anims.update(1 / 60);
};
const winLevel = () => {
  fastForward();
  main.winDelay = 0.5;
  main.tick();
};

/** BFS 最短路求解（返回最短步序列；与 tools/solve-report.mjs solveParBFS 同思路，快照含 completed） */
function bfsSolve() {
  const snap = () => ({
    b: logic.bottles.map((x) => x.slice()),
    r: [...logic.removed],
    c: [...logic.completed],
  });
  const restore = (s) => {
    logic.bottles = s.b.map((x) => x.slice());
    logic.removed = new Set(s.r);
    logic.completed = [...s.c];
  };
  const clean = () => {
    // BFS 探索会残留 moveCount / undoStack（获胜步未回退），重放前清零防污染
    logic.moveCount = 0;
    logic.undoStack = [];
  };
  const keyOf = (s) => JSON.stringify(s);
  const start = snap();
  const visited = new Set([keyOf(start)]);
  let frontier = [{ s: start, path: [] }];
  while (frontier.length) {
    const next = [];
    for (const { s, path } of frontier) {
      restore(s);
      const n = logic.bottles.length;
      for (let from = 0; from < n; from++) {
        for (let to = 0; to < n; to++) {
          if (from === to || !logic.canPour(from, to)) continue;
          logic.pour(from, to);
          if (logic.isWin()) {
            restore(start);
            clean();
            return [...path, [from, to]];
          }
          const ns = snap();
          const k = keyOf(ns);
          if (!visited.has(k)) {
            visited.add(k);
            next.push({ s: ns, path: [...path, [from, to]] });
          }
          logic.undo();
        }
      }
    }
    frontier = next;
  }
  restore(start);
  clean();
  return null;
}

test('T-07：首次通关 L1 → 结算星级 + best 存档持久化 + 新纪录标识', () => {
  main.loadLevel(0);
  const path = bfsSolve();
  assert.ok(path, 'L1 应可解');
  assert.strictEqual(path.length, LEVELS[0].par, 'BFS 最短路应等于 par');
  for (const [f, t] of path) logic.pour(f, t);
  assert.ok(logic.isWin());
  const moves = logic.moveCount;
  assert.strictEqual(calcStars(moves, LEVELS[0].par), 3, '打平 par 应得 3★');
  winLevel();
  assert.ok(main.winPanel, '应弹出胜利面板');
  assert.ok(main.winStats, '结算态应记录');
  assert.strictEqual(main.winStats.moves, moves);
  assert.strictEqual(main.winStats.stars, 3);
  assert.strictEqual(main.winStats.newRecord, true, '首通应为新纪录');
  // 持久化：storage 中有 best[L1]
  const saved = store.get(BEST_KEY);
  assert.ok(saved && saved['1'], '通关后应写 juicesort_best');
  assert.strictEqual(saved['1'].bestMoves, moves);
  assert.strictEqual(saved['1'].stars, main.winStats.stars);
  // 与内存一致
  assert.deepStrictEqual(main.best['1'], saved['1']);
});

test('T-07b：更差战绩回打不覆盖最佳；更优战绩可覆盖并刷新星数', () => {
  const bestBefore = { ...main.best['1'] };
  // —— 更差战绩：普通 DFS 首解（无启发式，长于 BFS 最短路）→ 严格更差 ——
  main.loadLevel(0);
  const badPath = dfsSolve();
  assert.ok(badPath, 'L1 应可解');
  assert.ok(badPath.length > bestBefore.bestMoves, 'DFS 首解应长于最佳（BFS 最短）');
  for (const [f, t] of badPath) logic.pour(f, t);
  winLevel();
  assert.strictEqual(main.winStats.newRecord, false, '更差战绩不应标记新纪录');
  assert.strictEqual(main.winStats.bestMoves, bestBefore.bestMoves, '结算应展示历史最佳');
  assert.deepStrictEqual(main.best['1'], bestBefore, '更差战绩不应覆盖存档');
  // —— 更优战绩：手工置差档后以 par 步数通关 → 覆盖 + 新纪录 ——
  main.best['1'] = { bestMoves: 99, stars: 1 };
  main.loadLevel(0);
  const pathBest = bfsSolve();
  for (const [f, t] of pathBest) logic.pour(f, t);
  winLevel();
  assert.strictEqual(main.winStats.newRecord, true, '更优战绩应标记新纪录');
  assert.strictEqual(main.best['1'].bestMoves, LEVELS[0].par, '最佳步数应刷新为 par');
  assert.strictEqual(main.winStats.stars, 3, '打平 par 应得 3★');
  assert.strictEqual(main.winStats.bestMoves, LEVELS[0].par);
  // 清理现场
  store.delete(BEST_KEY);
  main.best = {};
  main.winPanel = false;
  main.cleared = 0;
  main.winDelay = 0;
});

test('T-09：调试协议 v2 —— __dbg_state 含 moves/par/stars 并纳入签名（进关/结算变化即写）', () => {
  main.loadLevel(0);
  main.tick(); // 驱动 syncDebugState
  let dbg = store.get('__dbg_state');
  assert.ok(dbg, '应写调试状态');
  assert.strictEqual(dbg.moves, 0, '进关后 moves=0');
  assert.strictEqual(dbg.par, LEVELS[0].par, 'par 应为当前关配置');
  assert.strictEqual(dbg.stars, 0, '非结算态 stars=0');
  // 倒一步 → moves 变化应反映
  outer: for (let f = 0; f < logic.bottles.length; f++) {
    for (let t = 0; t < logic.bottles.length; t++) {
      if (f !== t && logic.canPour(f, t) > 0) {
        logic.pour(f, t);
        break outer;
      }
    }
  }
  main.tick();
  dbg = store.get('__dbg_state');
  assert.strictEqual(dbg.moves, 1, '步数变化应同步到调试状态');
  // 清理现场
  store.delete('__dbg_state');
});

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
