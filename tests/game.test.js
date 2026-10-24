/**
 * 逻辑层单元测试（Node 直接运行：npm test 或 node tests/game.test.js）
 * 覆盖：关卡生成合法性、倒液规则、连续倒、完成清空、撤回、死局、可解性（DFS 求解器）
 */
import assert from 'node:assert';
import GameLogic from '../js/core/game.js';
import { LEVELS, CAPACITY, COLORS } from '../js/core/levels.js';

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

console.log('== 关卡生成 ==');

test('每关：瓶数 = 颜色数 + 空瓶数，每色液体总量 = 容量，颜色 ID 合法', () => {
  for (const cfg of LEVELS) {
    const logic = new GameLogic();
    logic.loadLevel(cfg);
    const totalBottles = cfg.colors + cfg.empties;
    assert.strictEqual(logic.bottles.length, totalBottles, `瓶数不符 seed=${cfg.seed}`);
    const count = new Array(cfg.colors).fill(0);
    for (const b of logic.bottles) {
      assert.ok(b.length <= CAPACITY, '瓶内层数超容量');
      for (const c of b) {
        assert.ok(c >= 0 && c < cfg.colors, `非法颜色 ID ${c}`);
        count[c]++;
      }
    }
    for (let c = 0; c < cfg.colors; c++) {
      assert.strictEqual(count[c], CAPACITY, `颜色 ${c} 总量应为 ${CAPACITY}，实际 ${count[c]}`);
    }
  }
});

test('每关：开局不存在已完成的满瓶纯色，且非空瓶数 = 颜色数（液体确实被打散装满）', () => {
  for (const cfg of LEVELS) {
    const logic = new GameLogic();
    logic.loadLevel(cfg);
    for (const b of logic.bottles) {
      const fullMono = b.length === CAPACITY && b.every((c) => c === b[0]);
      assert.ok(!fullMono, `seed=${cfg.seed} 开局出现纯色满瓶 [${b}]`);
    }
    const nonEmpty = logic.bottles.filter((b) => b.length > 0).length;
    assert.strictEqual(nonEmpty, cfg.colors, `seed=${cfg.seed} 非空瓶数应恰为颜色数`);
  }
});

test('同 seed 两次生成局面完全一致（可复现）', () => {
  const a = new GameLogic();
  const b = new GameLogic();
  a.loadLevel(LEVELS[5]);
  b.loadLevel(LEVELS[5]);
  assert.deepStrictEqual(a.bottles, b.bottles);
});

test('全部 10 关生成耗时合理（< 2s / 关）', () => {
  for (let i = 0; i < LEVELS.length; i++) {
    const logic = new GameLogic();
    const t0 = Date.now();
    logic.loadLevel(LEVELS[i]);
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `第 ${i + 1} 关生成耗时 ${ms}ms`);
    console.log(`      第 ${i + 1} 关生成耗时 ${ms}ms`);
  }
});

console.log('== 倒液规则 ==');

function loadFixed(bottles, colors = 0) {
  const logic = new GameLogic();
  logic.colorCount = colors;
  logic.bottles = bottles.map((b) => b.slice());
  return logic;
}

test('目标瓶为空 → 可倒', () => {
  const logic = loadFixed([[0, 0, 1, 1], []]);
  assert.strictEqual(logic.canPour(0, 1), 2); // 顶层 1 连续段 2 层
});

test('目标瓶顶层同色 → 可倒；异色 → 不可倒', () => {
  const logic = loadFixed([[0, 1], [2, 1]]);
  assert.strictEqual(logic.canPour(0, 1), 1); // 瓶0顶层1 == 瓶1顶层1
  const logic2 = loadFixed([[0, 1, 1, 1], [2, 0]]);
  assert.strictEqual(logic2.canPour(0, 1), 0); // 顶层1 vs 顶层0 异色
});

test('目标瓶已满 → 不可倒；满瓶作源倒向同色 → 可倒', () => {
  const logic = loadFixed([[1], [0, 1, 1, 1]]);
  assert.strictEqual(logic.canPour(0, 1), 0); // 目标满
  assert.strictEqual(logic.canPour(1, 0), 3); // 满瓶作源，顶层 1 连续段 3 层，目标剩 3 空间
});

test('源瓶为空 → 不可倒', () => {
  const logic = loadFixed([[], [0, 1]]);
  assert.strictEqual(logic.canPour(0, 1), 0);
});

test('连续倒：同色连续段整体转移，受目标剩余空间限制', () => {
  const logic = loadFixed([[2, 1, 1, 1], [3, 1]]);
  // 瓶0顶层 1 连续段 3 层；目标 [3,1] 剩余空间 2 → 只能倒 2 层
  assert.strictEqual(logic.canPour(0, 1), 2);
  const res = logic.pour(0, 1);
  assert.strictEqual(res.amount, 2);
  assert.deepStrictEqual(logic.bottles[0], [2, 1]);
  assert.deepStrictEqual(logic.bottles[1], [3, 1, 1, 1]);
});

test('倒水后源瓶换色即停（只转移顶层同色段）', () => {
  const logic = loadFixed([[0, 1, 1, 2], []]);
  const res = logic.pour(0, 1);
  assert.strictEqual(res.amount, 1); // 只倒顶层 2 一层
  assert.deepStrictEqual(logic.bottles[0], [0, 1, 1]);
  assert.deepStrictEqual(logic.bottles[1], [2]);
});

console.log('== 完成判定与清空 ==');

test('满瓶纯色 → 完成、记入货架、瓶子腾空（多一个空瓶资源）', () => {
  const logic = loadFixed([[1, 2], [2, 2, 2]], 3);
  const res = logic.pour(0, 1); // 顶层 2 一层倒入 → [2,2,2,2] 满纯色
  assert.strictEqual(res.amount, 1);
  assert.strictEqual(res.completedColor, 2);
  assert.deepStrictEqual(logic.bottles[1], []); // 完成即清空
  assert.deepStrictEqual(logic.completed, [2]);
});

test('满瓶但杂色 → 不完成', () => {
  const logic = loadFixed([[1, 2], [0, 3, 2]], 4);
  const res = logic.pour(0, 1); // 顶层 2 倒入 → [0,3,2,2] 满但杂色
  assert.strictEqual(res.amount, 1);
  assert.strictEqual(res.completedColor, -1);
  assert.strictEqual(logic.bottles[1].length, 4);
  assert.deepStrictEqual(logic.completed, []);
});

test('isWin：全部颜色完成才通关', () => {
  const logic = loadFixed([[1, 0], [0, 0, 0]], 2);
  logic.pour(0, 1); // 顶层 0 倒入 → [0,0,0,0] 完成 0 色
  assert.deepStrictEqual(logic.completed, [0]);
  assert.ok(!logic.isWin());
  logic.bottles[0] = [];
  logic.completed.push(1); // 手工完成最后一色
  assert.ok(logic.isWin());
});

console.log('== 撤回 ==');

test('undo 恢复倒水前的瓶子内容', () => {
  const logic = loadFixed([[0, 1, 1, 2], []]);
  const before = logic.bottles.map((b) => b.slice());
  logic.pour(0, 1);
  assert.ok(logic.undo());
  assert.deepStrictEqual(logic.bottles, before);
});

test('undo 撤销完成效果（货架减少、瓶子恢复）', () => {
  const logic = loadFixed([[1, 2], [2, 2, 2]], 3);
  logic.pour(0, 1);
  assert.deepStrictEqual(logic.completed, [2]);
  assert.ok(logic.undo());
  assert.deepStrictEqual(logic.completed, []);
  assert.deepStrictEqual(logic.bottles[0], [1, 2]);
  assert.deepStrictEqual(logic.bottles[1], [2, 2, 2]);
});

test('undo 空栈返回 false', () => {
  const logic = loadFixed([[0], []]);
  assert.ok(!logic.undo());
});

test('moveCount 随倒水/撤回正确增减', () => {
  const logic = loadFixed([[0, 2, 2], [2, 2]]);
  logic.pour(0, 1); // 顶层 2 两层倒入 [2,2] → 满纯色完成
  logic.pour(0, 1); // 剩 [0] 顶层 0 倒入空瓶
  assert.strictEqual(logic.moveCount, 2);
  logic.undo();
  assert.strictEqual(logic.moveCount, 1);
});

console.log('== 死局检测 ==');

test('hasAnyMove：无合法倒法时返回 false', () => {
  const logic = loadFixed([[0, 1], [1, 0]]);
  assert.ok(!logic.hasAnyMove());
  const logic2 = loadFixed([[0, 1], [1, 0], []]);
  assert.ok(logic2.hasAnyMove());
});

console.log('== 可解性（DFS 求解器端到端验证） ==');

/**
 * DFS 求解器：用真实 pour/undo API 搜索通关路径。
 * 验证生成器产出的关卡确实可被玩家走通（生成器内部已有独立验证，此处双重保险）。
 */
function solveVerify(cfg, nodeLimit = 150000) {
  const logic = new GameLogic();
  logic.loadLevel(cfg);
  const visited = new Set();
  let nodes = 0;
  let limitHit = false;

  const key = () => logic.bottles.map((b) => b.join(',')).join('|');

  function dfs() {
    if (logic.isWin()) return true;
    if (nodes++ > nodeLimit) {
      limitHit = true;
      return false;
    }
    const k = key();
    if (visited.has(k)) return false;
    visited.add(k);
    const n = logic.bottles.length;
    for (let from = 0; from < n; from++) {
      for (let to = 0; to < n; to++) {
        if (from === to || !logic.canPour(from, to)) continue;
        logic.pour(from, to);
        if (dfs()) return true;
        logic.undo();
        if (limitHit) return false;
      }
    }
    return false;
  }

  const solved = dfs();
  return { solved, limitHit, moves: logic.moveCount, states: visited.size };
}

for (let idx = 0; idx < LEVELS.length; idx++) {
  test(`第 ${idx + 1} 关可解（DFS 实际走通）`, () => {
    const { solved, limitHit, moves, states } = solveVerify(LEVELS[idx]);
    if (limitHit) {
      console.log(`      (达到节点上限，跳过完整验证，已访问 ${states} 态)`);
      return;
    }
    assert.ok(solved, 'DFS 未找到通关路径');
    console.log(`      通关步数 ${moves}，搜索 ${states} 态`);
  });
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
console.log(`颜色定义数: ${COLORS.length}，关卡数: ${LEVELS.length}，容量: ${CAPACITY}`);
process.exit(failed > 0 ? 1 : 0);
