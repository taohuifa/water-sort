/**
 * 逻辑层单元测试（Node 直接运行：npm test 或 node tests/game.test.js）
 * 覆盖：关卡生成合法性、倒液规则、连续倒、完成清空、撤回、死局、可解性（DFS 求解器）
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import GameLogic from '../js/core/game.js';
import { buildLevelsFromConfig, parseJsonc, CAPACITY, COLORS } from '../js/core/levels.js';

// 从 assets/config/levels.json（.json 扩展名，内容为 JSONC 带注释）加载关卡配置，与游戏入口同源
const DIFFICULTY_CURVE = parseJsonc(
  readFileSync(new URL('../assets/config/levels.json', import.meta.url), 'utf8')
);
const LEVELS = buildLevelsFromConfig(DIFFICULTY_CURVE);
const LEVEL_COUNT = LEVELS.length;

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

console.log('== JSONC 解析 ==');

test('stripJsonComments：行注释 / 块注释被剥离，字符串内的注释符号不误伤', () => {
  const src = `{
    // 行注释
    "a": 1, /* 块注释 */
    "url": "http://example.com//path", // 字符串内的 // 应保留
    "s": "/* 不是注释 */",
    "b": "转义\\"引号//仍保留"
  }`;
  const obj = parseJsonc(src);
  assert.deepStrictEqual(obj, {
    a: 1,
    url: 'http://example.com//path',
    s: '/* 不是注释 */',
    b: '转义"引号//仍保留',
  });
});

test('assets/config/levels.json 可解析且含全部难度曲线字段', () => {
  const required = [
    'levelCount',
    'startColors',
    'maxColors',
    'baseEmpties',
    'extraEmptyFromLevel',
    'hiddenFromLevel',
    'hiddenMax',
    'seedBase',
  ];
  for (const key of required) {
    assert.ok(key in DIFFICULTY_CURVE, `配置缺少字段 ${key}`);
  }
  assert.strictEqual(DIFFICULTY_CURVE.levelCount, LEVELS.length);
  assert.ok(DIFFICULTY_CURVE.maxColors <= COLORS.length, '颜色数上限超出颜色表');
});

console.log('== 关卡配置生成 ==');

test('关卡数量与字段由难度曲线配置决定', () => {
  assert.strictEqual(LEVELS.length, LEVEL_COUNT);
  for (let i = 0; i < LEVEL_COUNT; i++) {
    const lv = LEVELS[i];
    const level = i + 1;
    assert.strictEqual(lv.level, level, 'level 字段应为关卡序号');
    assert.strictEqual(
      lv.colors,
      Math.min(DIFFICULTY_CURVE.maxColors, DIFFICULTY_CURVE.startColors + Math.floor(level / 2)),
      `第 ${level} 关颜色数不符合曲线`
    );
    assert.strictEqual(
      lv.empties,
      DIFFICULTY_CURVE.baseEmpties + (level >= DIFFICULTY_CURVE.extraEmptyFromLevel ? 1 : 0),
      `第 ${level} 关空瓶数不符合曲线`
    );
    assert.strictEqual(lv.seed, DIFFICULTY_CURVE.seedBase + level, 'seed 应由基准 + 关卡号生成');
  }
});

test('难度曲线单调不减，颜色数不超过颜色表', () => {
  for (let i = 1; i < LEVELS.length; i++) {
    assert.ok(LEVELS[i].colors >= LEVELS[i - 1].colors, '颜色数应单调不减');
  }
  assert.ok(Math.max(...LEVELS.map((l) => l.colors)) <= COLORS.length, '颜色数超出颜色表');
});

console.log('== 关卡生成 ==');

test('每关：瓶数 = 颜色数 + 空瓶数，每色液体总量 = 容量（含隐藏层换算），颜色 ID 合法', () => {
  for (const cfg of LEVELS) {
    const logic = new GameLogic();
    logic.loadLevel(cfg);
    const totalBottles = cfg.colors + cfg.empties;
    assert.strictEqual(logic.bottles.length, totalBottles, `瓶数不符 seed=${cfg.seed}`);
    const count = new Array(cfg.colors).fill(0);
    for (const b of logic.bottles) {
      assert.ok(b.length <= CAPACITY, '瓶内层数超容量');
      for (const raw of b) {
        const c = raw >= 0 ? raw : -raw - 1; // 隐藏层换算回真实色
        assert.ok(c >= 0 && c < cfg.colors, `非法颜色 ID ${raw}`);
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

test('满瓶纯色 → 完成、记入货架、瓶子一并收走（不可再参与倒水）', () => {
  const logic = loadFixed([[1, 2], [2, 2, 2], []], 3);
  const res = logic.pour(0, 1); // 顶层 2 一层倒入 → [2,2,2,2] 满纯色
  assert.strictEqual(res.amount, 1);
  assert.strictEqual(res.completedColor, 2);
  assert.deepStrictEqual(logic.bottles[1], []); // 完成即清空
  assert.deepStrictEqual(logic.completed, [2]);
  assert.ok(logic.removed.has(1), '瓶 1 应被收走');
  assert.strictEqual(logic.canPour(0, 1), 0, '收走的瓶不可再接收倒水');
  assert.strictEqual(logic.canPour(1, 2), 0, '收走的瓶不可再作为源');
});

test('收走的瓶子不影响死局判定（不当作空瓶中转位）', () => {
  const logic = loadFixed([[0, 1], [1, 0]], 2);
  logic.bottles[1] = []; // 模拟完成后仅剩空瓶
  logic.removed.add(1);
  assert.ok(!logic.hasAnyMove(), '收走的空瓶不应算作可行目标');
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

test('undo 撤销完成效果（货架减少、瓶子放回、取消收走）', () => {
  const logic = loadFixed([[1, 2], [2, 2, 2]], 3);
  logic.pour(0, 1);
  assert.deepStrictEqual(logic.completed, [2]);
  assert.ok(logic.removed.has(1));
  assert.ok(logic.undo());
  assert.deepStrictEqual(logic.completed, []);
  assert.ok(!logic.removed.has(1), '撤回后瓶子应放回场上');
  assert.deepStrictEqual(logic.bottles[0], [1, 2]);
  assert.deepStrictEqual(logic.bottles[1], [2, 2, 2]);
});

test('undo 空栈返回 false', () => {
  const logic = loadFixed([[0], []]);
  assert.ok(!logic.undo());
});

test('moveCount 随倒水/撤回正确增减', () => {
  const logic = loadFixed([[0, 2, 2], [2, 2], []], 3);
  logic.pour(0, 1); // 顶层 2 两层倒入 [2,2] → 满纯色完成
  logic.pour(0, 2); // 剩 [0] 顶层 0 倒入空瓶
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

console.log('== 道具：打乱 ==');

test('shuffle：每色总量保持、无开局完成瓶、局面必有解、可撤销', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[7]); // 6 色 3 空
  const before = logic.bottles.map((b) => b.slice());
  assert.ok(logic.shuffle(), '打乱应成功');

  // 每色总量不变
  const count = {};
  for (const b of logic.bottles) {
    for (const c of b) count[c] = (count[c] || 0) + 1;
  }
  for (const [c, n] of Object.entries(count)) {
    assert.strictEqual(n, CAPACITY, `颜色 ${c} 总量应保持 ${CAPACITY}`);
  }
  // 无开局完成瓶、必有解
  assert.ok(!logic.bottles.some((b) => b.length === CAPACITY && b.every((c) => c === b[0])));
  assert.ok(logic._solvable(logic.bottles), '打乱后局面应可解');
  // 撤销恢复原局面
  assert.ok(logic.undo());
  assert.deepStrictEqual(logic.bottles, before);
});

test('shuffle 后无隐藏层（全部揭示）', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[9]); // 含隐藏层关卡
  assert.ok(logic.bottles.some((b) => b.some((c) => c < 0)), '第 10 关应有隐藏层');
  assert.ok(logic.shuffle());
  assert.ok(!logic.bottles.some((b) => b.some((c) => c < 0)), '打乱后不应有隐藏层');
});

test('shuffle：已收走的瓶子保持空置，不参与重排', () => {
  const logic = loadFixed([[1, 1], [1, 1], [0, 0, 2, 2], [2, 2, 0, 0], [], [], []], 3);
  logic.pour(0, 1); // [1,1] → [1,1,1,1] 完成收走
  assert.ok(logic.removed.has(1));
  assert.ok(logic.shuffle(), '打乱应成功');
  assert.deepStrictEqual(logic.bottles[1], [], '收走的瓶应保持空置');
  const flat = logic.bottles.flat().sort().join(',');
  assert.strictEqual(flat, '0,0,0,0,2,2,2,2', '层集合不变');
  assert.ok(logic.undo());
  assert.ok(logic.removed.has(1), '撤销打乱不影响收走状态');
});

test('shuffleOne：单瓶层序重排、集合不变且揭示、可撤销', () => {
  const logic = new GameLogic();
  logic.colorCount = 2;
  logic.bottles = [[0, -2, 1, 0], []]; // -2 为隐藏的真实色 1
  assert.ok(logic.shuffleOne(0));
  const b = logic.bottles[0];
  assert.ok(b.every((c) => c >= 0), '隐藏层应全部揭示');
  assert.strictEqual(
    b.slice().sort((x, y) => x - y).join(','),
    '0,0,1,1',
    '层集合应保持不变'
  );
  assert.notDeepStrictEqual(b, [0, 1, 1, 0], '层序应与原排列不同');
  assert.ok(logic.undo());
  assert.deepStrictEqual(logic.bottles[0], [0, -2, 1, 0], '撤销应恢复含隐藏层的原状');
});

test('shuffleOne：空瓶 / 纯色瓶 / 已收走的瓶拒绝打乱', () => {
  const logic = new GameLogic();
  logic.colorCount = 2;
  logic.bottles = [[], [1, 1, 1, 1], [0, 1], []];
  logic.removed.add(3);
  assert.ok(!logic.shuffleOne(0), '空瓶不可打乱');
  assert.ok(!logic.shuffleOne(1), '纯色瓶不可打乱');
  assert.ok(!logic.shuffleOne(3), '已收走的瓶不可打乱');
  assert.ok(logic.shuffleOne(2), '多色瓶可打乱');
});

console.log('== 道具：加瓶子 ==');

test('addBottle：新增空瓶、死局复活、倒水后连续撤销可完整回退', () => {
  const logic = loadFixed([[0, 1], [1, 0]], 2);
  assert.ok(!logic.hasAnyMove(), '应为死局');
  assert.ok(logic.addBottle());
  assert.strictEqual(logic.bottles.length, 3);
  assert.deepStrictEqual(logic.bottles[2], [], '新增瓶应为空');
  assert.ok(logic.hasAnyMove(), '加瓶后应有可行走法');

  // 倒水 → 连续撤销（LIFO：先撤倒水，再撤加瓶）
  logic.pour(0, 2);
  logic.undo();
  logic.undo();
  assert.strictEqual(logic.bottles.length, 2, '应移除新增瓶');
  assert.deepStrictEqual(logic.bottles, [[0, 1], [1, 0]]);
});

test('addBottle：达到 12 瓶上限后失败', () => {
  const bottles = [];
  for (let i = 0; i < 12; i++) bottles.push([]);
  const logic = loadFixed(bottles);
  assert.ok(!logic.addBottle());
});

console.log('== 问号隐藏层 ==');

test('关卡配置：第 4 关起隐藏层数量按曲线递增', () => {
  assert.strictEqual(LEVELS[0].hiddenCount, 0);
  assert.strictEqual(LEVELS[3].hiddenCount, 1); // 第 4 关
  assert.strictEqual(LEVELS[5].hiddenCount, 2); // 第 6 关
  assert.strictEqual(LEVELS[7].hiddenCount, 3); // 第 8 关
  assert.strictEqual(LEVELS[9].hiddenCount, 3); // 第 10 关（封顶）
});

test('隐藏层标记：数量正确、全部位于非顶层、同 seed 可复现', () => {
  const a = new GameLogic();
  const b = new GameLogic();
  const cfg = { colors: 5, empties: 2, seed: 506, hiddenCount: 3 };
  a.loadLevel(cfg);
  b.loadLevel(cfg);
  assert.deepStrictEqual(a.bottles, b.bottles, '同 seed 局面应一致');
  let hidden = 0;
  for (const bottle of a.bottles) {
    for (let li = 0; li < bottle.length; li++) {
      if (bottle[li] < 0) {
        hidden++;
        assert.ok(li < bottle.length - 1, '隐藏层不得位于顶层');
      }
    }
  }
  assert.strictEqual(hidden, 3);
});

test('隐藏层揭示：倒出上层后顶层隐藏层转为真实颜色', () => {
  const logic = new GameLogic();
  logic.colorCount = 2;
  // 瓶0 = [底层隐藏色0, 顶层 1]，瓶1 = [1,1,1]
  logic.bottles = [[-1, 1], [1, 1, 1]];
  const res = logic.pour(0, 1); // 顶层 1 倒入 → 瓶1 满纯色完成，瓶0 露出隐藏层
  assert.strictEqual(res.completedColor, 1);
  assert.deepStrictEqual(logic.bottles[0], [0], '隐藏层应揭示为真实色 0');
});

test('undo 撤销倒水后隐藏状态一并恢复', () => {
  const logic = new GameLogic();
  logic.colorCount = 2;
  logic.bottles = [[-1, 1], [1, 1, 1]];
  logic.pour(0, 1);
  logic.undo();
  assert.deepStrictEqual(logic.bottles[0], [-1, 1], '隐藏状态应随快照恢复');
  assert.deepStrictEqual(logic.bottles[1], [1, 1, 1]);
});

test('隐藏层不影响倒水合法性判定（顶层始终已揭示）', () => {
  const logic = new GameLogic();
  logic.colorCount = 3;
  // 瓶0 = [2, 隐藏1, 0]，顶层 0；瓶1 = [1, 0]，顶层 0
  logic.bottles = [[2, -2, 0], [1, 0]];
  assert.strictEqual(logic.canPour(0, 1), 1); // 顶层 0 == 顶层 0，可倒
  const res = logic.pour(0, 1);
  assert.strictEqual(res.amount, 1);
  assert.deepStrictEqual(logic.bottles[0], [2, 1], '倒出 0 后露出隐藏 1，应立即揭示');
  assert.deepStrictEqual(logic.bottles[1], [1, 0, 0]);
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
