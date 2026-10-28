/**
 * 存档/解锁/发放/记星链路对关号 >30 的验证（PRD-100关扩充 F-03，headless wx storage mock）
 * 场景：老玩家已通 30 关 → 更新后 L31 解锁 → 首入发放章首 grant → 实际走通 L31 → 记星 + 进度 31
 * ▶ 何时跑我：改关卡总数（levelCount）、main.js 进度/解锁/首入发放链路、levelSelect 对 >30 关号的行为
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// ---------- wx 桩（storage 为内存 Map，与 inventory.test.js 同款） ----------
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

// 模拟老存档：已通关 30 关（LEVEL_COUNT 扩到 100 后老进度无损）
store.set('juicesort_cleared', 30);

const { default: Main } = await import('../js/main.js');
const main = new Main();
const { logic, renderer } = main;

test('P-01：老存档 cleared=30 → L31 解锁、L32 锁定，关卡总数 100', () => {
  assert.strictEqual(main.cleared, 30);
  assert.strictEqual(renderer.levelCount, 100, '关卡总数应为 100');
  main.selectLevel(30);
  assert.strictEqual(main.scene, 'game', 'L31 应可挑战');
  assert.strictEqual(main.levelIndex, 30);
  assert.strictEqual(main.scene, 'game');
  main.scene = 'levelSelect';
  assert.ok(!main.selectLevel(31) && main.scene === 'levelSelect', 'L32 应锁定（未通关 L31）');
});

test('P-02：首入 L31 发放章首 grant（shuffle/addBottle 各 +1）并持久化，重复进入不重发', () => {
  assert.deepStrictEqual(main.inv, { undo: 3, shuffle: 2, addBottle: 2, revive: 1 }, 'L31 章首关首入应发放');
  assert.strictEqual(store.get('juicesort_granted')[31], true, '应持久化发放标记');
  main.loadLevel(30);
  assert.deepStrictEqual(main.inv, { undo: 3, shuffle: 2, addBottle: 2, revive: 1 }, '重复进入不应重复发放');
});

/** DFS 求解当前局面（L31 无锁无遮盖，启发式排序与 solveVerify 同源） */
function solveAndPlay() {
  const visited = new Set();
  let nodes = 0;
  const key = () => {
    const free = [];
    for (let i = 0; i < logic.bottles.length; i++) {
      if (logic.removed.has(i)) continue;
      free.push(logic.bottles[i].join(','));
    }
    return free.sort().join('|');
  };
  function dfs() {
    if (logic.isWin()) return [];
    if (nodes++ > 150000) return null;
    const k = key();
    if (visited.has(k)) return null;
    visited.add(k);
    const n = logic.bottles.length;
    const moves = [];
    for (let from = 0; from < n; from++) {
      for (let to = 0; to < n; to++) {
        if (from === to) continue;
        if (!logic.canPour(from, to)) continue;
        moves.push([from, to]);
      }
    }
    moves.sort((a, b) => {
      const sc = ([f, t]) => {
        const fb = logic.bottles[f];
        const tb = logic.bottles[t];
        let s = tb.length ? 100 : 10;
        if (fb.length === logic.canPour(f, t)) s += 200;
        return s;
      };
      return sc(b) - sc(a);
    });
    for (const [f, t] of moves) {
      logic.pour(f, t);
      const rest = dfs();
      if (rest) return [[f, t], ...rest];
      logic.undo();
    }
    return null;
  }
  const path = dfs();
  assert.ok(path, 'L31 应存在可走通路径（不用道具必有解）');
  for (const [f, t] of path) logic.pour(f, t);
  return path.length;
}

test('P-03：走通 L31 → 三星结算记星 + 进度推进 31，均持久化', () => {
  main.loadLevel(30); // 重开一局干净局面
  main.scene = 'game'; // P-01 锁定验证后 scene 留在 levelSelect，通关判定要求 game 场景
  const moves = solveAndPlay();
  assert.ok(logic.isWin(), '倒完应处于胜利态');
  for (let i = 0; i < 200 && !main.anims.allDone(); i++) main.anims.update(1 / 60); // 快进动画（与 smoke 同口径）
  main.tick();
  main.winDelay = 0.5; // 跳过 0.45s 落地等待
  main.tick();
  assert.ok(main.winPanel, '通关应弹出胜利面板');
  assert.ok(main.winStats && main.winStats.stars >= 1 && main.winStats.stars <= 3, '应结算 1~3 星');
  const rec = main.best[31];
  assert.ok(rec && rec.bestMoves === moves && rec.stars === main.winStats.stars, '应记录 L31 最佳步数与星数');
  assert.deepStrictEqual(store.get('juicesort_best')[31], rec, '最佳纪录应持久化');
  assert.strictEqual(main.cleared, 31, '通关 L31 后进度应推进到 31');
  assert.strictEqual(store.get('juicesort_cleared'), 31, '解锁进度应持久化');
});

test('P-04：通关 L31 后 L32 解锁（解锁链路对 >30 关号正常）', () => {
  main.winPanel = false;
  main.scene = 'levelSelect';
  main.tick();
  main.selectLevel(31);
  assert.strictEqual(main.scene, 'game');
  assert.strictEqual(main.levelIndex, 31, 'L32 应可进入');
  assert.ok(!logic.isFailed(), 'L32 载入正常（炸弹关为自动口径，未配置则无失败态）');
});

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
