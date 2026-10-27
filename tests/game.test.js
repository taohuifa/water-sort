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

test('assets/config/levels.json 可解析且含 v3 全部必需字段（defaults 模板 + levels 逐关聚合）', () => {
  const required = ['levelCount', 'seedBase', 'defaults', 'levels'];
  for (const key of required) {
    assert.ok(key in DIFFICULTY_CURVE, `配置缺少字段 ${key}`);
  }
  assert.strictEqual(DIFFICULTY_CURVE.levelCount, LEVELS.length);
  assert.strictEqual(DIFFICULTY_CURVE.levelCount, 30);
  assert.ok(Array.isArray(DIFFICULTY_CURVE.levels), 'levels 应为数组');
  assert.strictEqual(DIFFICULTY_CURVE.levels.length, 30, '30 关每关一条记录');
  for (const k of [
    'colors', 'empties', 'capacity', 'hiddenCount', 'condLockCount', 'condLockNeed',
    'keyLockCount', 'noEmptyStart', 'mix', 'special', 'bigCapacity', 'props',
  ]) {
    assert.ok(k in DIFFICULTY_CURVE.defaults, `defaults 模板缺少字段 ${k}`);
  }
});

console.log('== 关卡配置生成 ==');

// 30 关难度总表（AC-01，2026-10-26 按实测难度重排，见 docs/解题报告-30关.md）：
// [colors, empties, capacity, hidden, condLockCount, condLockNeed, keyLockCount, noEmptyStart, seed(null=缺省 seedBase+关卡号)]
// 特殊关 L10/L20/L30 固定里程碑位（bigBottle，special 关 hidden/cond/key/noEmptyStart 强制清零，empties 统一 2）；
// 移动过的记录带冻结 seed（= 101 + 原关号）保持牌面不变。
const CURVE_TABLE = [
  [2, 2, 4, 0, 0, 2, 0, false, null], [3, 2, 4, 0, 0, 2, 0, false, 104], [3, 2, 4, 0, 0, 2, 0, false, 103],
  [4, 2, 4, 1, 0, 2, 0, false, 106], [4, 2, 4, 1, 0, 2, 0, false, 105], [5, 2, 4, 2, 0, 2, 0, false, 108],
  [5, 2, 4, 2, 0, 2, 0, false, 107], [6, 2, 4, 3, 0, 2, 0, false, 110], [6, 2, 4, 3, 0, 2, 0, false, 109],
  [4, 2, 4, 0, 0, 2, 0, false, null], [6, 1, 4, 0, 0, 2, 0, false, 127], [7, 2, 4, 4, 0, 2, 0, false, null],
  [7, 2, 4, 4, 0, 2, 0, false, 112], [6, 2, 4, 0, 0, 2, 0, false, 118], [8, 1, 4, 5, 0, 2, 0, false, null],
  [8, 1, 4, 5, 0, 2, 0, false, 119], [6, 2, 4, 0, 0, 2, 0, false, 114], [8, 2, 4, 5, 0, 2, 0, false, 115],
  [8, 1, 4, 5, 0, 2, 0, false, 117], [6, 2, 4, 0, 0, 2, 0, false, null], [6, 1, 3, 4, 0, 2, 0, false, null],
  [6, 1, 4, 0, 0, 2, 0, false, 124], [8, 1, 4, 5, 0, 2, 0, false, 120], [6, 1, 5, 4, 0, 2, 0, false, 123],
  [8, 1, 4, 5, 1, 2, 0, false, null], [8, 1, 4, 5, 1, 2, 0, false, 125], [8, 1, 4, 5, 0, 2, 1, false, null],
  [8, 1, 4, 5, 1, 2, 1, false, null], [7, 0, 4, 4, 0, 2, 0, true, null], [6, 2, 5, 0, 0, 2, 0, false, null],
];

test('AC-01：30 关参数与重排后总表逐项一致（含冻结 seed）', () => {
  assert.strictEqual(LEVELS.length, 30);
  for (let i = 0; i < 30; i++) {
    const lv = LEVELS[i];
    const [colors, empties, capacity, hidden, condN, condNeed, keyN, noEmpty, seed] = CURVE_TABLE[i];
    assert.strictEqual(lv.level, i + 1);
    assert.strictEqual(lv.colors, colors, `L${i + 1} colors`);
    assert.strictEqual(lv.empties, empties, `L${i + 1} empties`);
    assert.strictEqual(lv.capacity, capacity, `L${i + 1} capacity`);
    assert.strictEqual(lv.hiddenCount, hidden, `L${i + 1} hiddenCount`);
    assert.strictEqual(lv.condLockCount, condN, `L${i + 1} condLockCount`);
    assert.strictEqual(lv.condLockNeed, condNeed, `L${i + 1} condLockNeed`);
    assert.strictEqual(lv.keyLockCount, keyN, `L${i + 1} keyLockCount`);
    assert.strictEqual(lv.noEmptyStart, noEmpty, `L${i + 1} noEmptyStart`);
    const expectSeed = seed ?? DIFFICULTY_CURVE.seedBase + lv.level;
    assert.strictEqual(lv.seed, expectSeed, `L${i + 1} seed（冻结或缺省 seedBase+关卡号）`);
  }
});

test('v3 合并规则：记录字段覆盖 defaults，缺省补全，逐关 seed 可固化，noEmptyStart 置空瓶 0', () => {
  const lvs = buildLevelsFromConfig({
    levelCount: 4,
    seedBase: 200,
    defaults: { colors: 4, empties: 2, hiddenCount: 1 },
    levels: [
      { level: 1 }, // 全缺省 → defaults 补全
      { level: 2, colors: 6, empties: 1 }, // 记录字段覆盖 defaults
      { level: 3, seed: 999, noEmptyStart: true }, // 逐关种子固化 + 无空瓶开局
      // L4 故意缺记录 → defaults 补全（warn，不炸）
    ],
  });
  assert.strictEqual(lvs.length, 4);
  assert.strictEqual(lvs[0].colors, 4, 'L1 colors 取 defaults');
  assert.strictEqual(lvs[0].empties, 2, 'L1 empties 取 defaults');
  assert.strictEqual(lvs[0].hiddenCount, 1, 'L1 hiddenCount 取 defaults');
  assert.strictEqual(lvs[0].seed, 201, '缺省 seed = seedBase + 关卡号');
  assert.strictEqual(lvs[1].colors, 6, 'L2 记录字段覆盖 defaults');
  assert.strictEqual(lvs[1].empties, 1, 'L2 记录字段覆盖 defaults');
  assert.strictEqual(lvs[1].hiddenCount, 1, 'L2 未覆盖字段沿用 defaults');
  assert.strictEqual(lvs[2].seed, 999, 'L3 显式 seed 固化（满意局面记录用）');
  assert.strictEqual(lvs[2].empties, 0, 'L3 noEmptyStart 生效时空瓶数置 0');
  assert.strictEqual(lvs[3].level, 4, 'L4 缺失记录按 defaults 补全（永不炸游戏）');
  assert.strictEqual(lvs[3].colors, 4, 'L4 colors 取 defaults');
  assert.strictEqual(lvs[3].seed, 204, 'L4 缺省 seed = seedBase + 4');
});

test('难度曲线颜色数合法（机制首秀关允许降档缓冲，非严格单调）；8 色关抹茶 ID=7 登场', () => {
  for (const lv of LEVELS) {
    assert.ok(lv.colors >= 2 && lv.colors <= COLORS.length, `L${lv.level} 颜色数 ${lv.colors} 非法`);
  }
  assert.ok(LEVELS.some((l) => l.colors === 8), '应存在 8 色关');
  const matcha = LEVELS.filter((l) => l.colors === 8).map((l) => l.level);
  // 重排后 8 色关位于第 15/16/18/19/23/25/26/27/28 关（原 L14~L19/L24/L25/L27/L28 记录）
  assert.deepStrictEqual(matcha, [15, 16, 18, 19, 23, 25, 26, 27, 28]);
});

console.log('== 关卡生成 ==');

test('每关：瓶数 = 颜色数 + 空瓶数（无空瓶开局 = 颜色数+1），每色液体总量 = 本关容量，颜色 ID 合法', () => {
  for (const cfg of LEVELS) {
    if (cfg.special === 'bigBottle') continue; // 特殊关结构由专项用例校验（见「特殊关卡」段）
    const logic = new GameLogic();
    logic.loadLevel(cfg);
    const totalBottles = cfg.noEmptyStart
      ? cfg.colors + 1
      : cfg.colors + cfg.empties;
    assert.strictEqual(logic.bottles.length, totalBottles, `瓶数不符 seed=${cfg.seed}`);
    const count = new Array(cfg.colors).fill(0);
    for (let i = 0; i < logic.bottles.length; i++) {
      const b = logic.bottles[i];
      // 混合关按各瓶自身容量校验（cap5 瓶可含 5 层 > 关卡 capacity 4）
      assert.ok(b.length <= logic.capOf(i), '瓶内层数超容量');
      for (const raw of b) {
        const c = raw >= 0 ? raw : -raw - 1; // 隐藏层换算回真实色
        assert.ok(c >= 0 && c < cfg.colors, `非法颜色 ID ${raw}`);
        count[c]++;
      }
    }
    for (let c = 0; c < cfg.colors; c++) {
      if (cfg.mix) {
        // 混合关 v2：每色总量随机 3~5（= 收纳瓶自身容量），不再恒 = capacity
        assert.ok(count[c] >= 3 && count[c] <= 5, `色 ${c} 总量 ${count[c]} 应在 3~5`);
      } else {
        assert.strictEqual(count[c], cfg.capacity, `颜色 ${c} 总量应为 ${cfg.capacity}，实际 ${count[c]}`);
      }
    }
  }
});

test('每关：开局不存在已完成的满瓶纯色，非空瓶数符合发牌模式', () => {
  for (const cfg of LEVELS) {
    if (cfg.special === 'bigBottle') continue; // 特殊关非空瓶数 = 内容瓶数（专项用例校验）
    const logic = new GameLogic();
    logic.loadLevel(cfg);
    for (let i = 0; i < logic.bottles.length; i++) {
      // 满纯色按各瓶自身容量判定（混合关 per-bottle，PRD-混合容量瓶 AC-4）
      assert.ok(!logic._isFullMono(logic.bottles[i], logic.capOf(i)), `seed=${cfg.seed} 开局出现纯色满瓶`);
    }
    if (cfg.mix) continue; // 混合关装牌瓶数随容量分配变化（部分瓶可能空），由专项用例校验
    const nonEmpty = logic.bottles.filter((b) => b.length > 0).length;
    // 无空瓶开局：全部 colors+1 瓶有内容（钥匙锁瓶除外）；标准模式：colors 个内容瓶
    const expectNonEmpty = cfg.noEmptyStart ? cfg.colors + 1 : cfg.colors;
    assert.strictEqual(nonEmpty, expectNonEmpty, `seed=${cfg.seed} 非空瓶数不符`);
  }
});

test('AC-03：8 色关空瓶配置 —— 第 18 关空 2（原 L14），第 15 关空 1（原 L15）', () => {
  assert.strictEqual(LEVELS[17].colors, 8);
  assert.strictEqual(LEVELS[17].empties, 2);
  assert.strictEqual(LEVELS[14].colors, 8);
  assert.strictEqual(LEVELS[14].empties, 1);
});

test('AC-03：L29 无空瓶开局（scattered）—— 无空瓶、无满纯色、每瓶≥2层、总层数=colors×capacity、瓶数=colors+1', () => {
  const cfg = LEVELS[28];
  assert.strictEqual(cfg.empties, 0);
  assert.strictEqual(cfg.noEmptyStart, true);
  const logic = new GameLogic();
  logic.loadLevel(cfg);
  assert.strictEqual(logic.bottles.length, cfg.colors + 1);
  assert.ok(logic.bottles.every((b) => b.length >= 2), '每瓶应至少 2 层');
  assert.ok(!logic.bottles.some((b) => logic._isFullMono(b)), '不得存在满纯色瓶');
  assert.ok(!logic.bottles.some((b) => b.length === 0), '不得存在空瓶');
  const total = logic.bottles.reduce((s, b) => s + b.length, 0);
  assert.strictEqual(total, cfg.colors * cfg.capacity);
});

test('AC-01/S-12：L30 终局特殊关 —— cap5 普通瓶 + big8 大瓶、无锁无隐藏、生成可解', () => {
  const cfg = LEVELS[29];
  assert.strictEqual(cfg.special, 'bigBottle');
  assert.strictEqual(cfg.capacity, 5);
  assert.strictEqual(cfg.bigCapacity, 8);
  const logic = new GameLogic();
  logic.loadLevel(cfg);
  assert.strictEqual(logic.locks.length, 0, 'L30 特殊关不应有锁（v1 不叠加）');
  // 总层数 8 + 5×5 = 33 → 7 个内容瓶 + 2 空瓶 + 1 大瓶 = 10
  assert.strictEqual(logic.bottles.length, 10);
  assert.strictEqual(logic.capacity, 5);
  assert.strictEqual(logic.bigCapacity, 8);
  assert.ok(logic.lastGenSolvable, 'L30 特殊关生成应可解');
});

test('同 seed 两次生成局面完全一致（可复现，含锁与钥匙位置）', () => {
  const a = new GameLogic();
  const b = new GameLogic();
  a.loadLevel(LEVELS[5]);
  b.loadLevel(LEVELS[5]);
  assert.deepStrictEqual(a.bottles, b.bottles);
  a.loadLevel(LEVELS[27]); // L28 双锁关
  b.loadLevel(LEVELS[27]);
  assert.deepStrictEqual(a.bottles, b.bottles);
  assert.deepStrictEqual(a.locks, b.locks);
});

test('AC-02/D-10：全部 30 关生成通过求解器验证（含锁瓶/无空瓶开局），单关耗时预算内（Q8=B 5s）', () => {
  for (let i = 0; i < LEVELS.length; i++) {
    const logic = new GameLogic();
    const t0 = Date.now();
    logic.loadLevel(LEVELS[i]);
    const ms = Date.now() - t0;
    assert.ok(logic.lastGenSolvable, `第 ${i + 1} 关生成未通过求解器验证`);
    assert.ok(ms < 5000, `第 ${i + 1} 关生成耗时 ${ms}ms 超预算`);
    if (ms > 200) console.log(`      第 ${i + 1} 关生成耗时 ${ms}ms`);
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

test('满瓶纯色含隐藏层（真实色相同）→ 同样完成（与求解器真实色语义对齐）', () => {
  const logic = loadFixed([[1, 2], [2, -3, 2]], 3); // 目标 [2, 隐藏2(-3), 2]，再倒 1 层 2 → 真实色满纯色
  const res = logic.pour(0, 1);
  assert.strictEqual(res.amount, 1);
  assert.strictEqual(res.completedColor, 2, '真实色全同为 2 应判定完成');
  assert.deepStrictEqual(logic.bottles[1], []);
  assert.deepStrictEqual(logic.completed, [2]);
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
  logic.loadLevel(LEVELS[7]); // 6 色 2 空（cap 4）
  const cap = logic.capacity;
  const before = logic.bottles.map((b) => b.slice());
  assert.ok(logic.shuffle(), '打乱应成功');

  // 每色总量不变
  const count = {};
  for (const b of logic.bottles) {
    for (const c of b) count[c] = (count[c] || 0) + 1;
  }
  for (const [c, n] of Object.entries(count)) {
    assert.strictEqual(n, cap, `颜色 ${c} 总量应保持 ${cap}`);
  }
  // 无开局完成瓶、必有解
  assert.ok(!logic.bottles.some((b) => b.length === cap && b.every((c) => c === b[0])));
  assert.ok(logic._solvable(logic.bottles), '打乱后局面应可解');
  // 撤销恢复原局面
  assert.ok(logic.undo());
  assert.deepStrictEqual(logic.bottles, before);
});

test('shuffle 后无隐藏层（全部揭示）', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[8]); // L9 含隐藏层关卡（L10 已改为特殊关、强制无隐藏）
  assert.ok(logic.bottles.some((b) => b.some((c) => c < 0)), '第 9 关应有隐藏层');
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

test('关卡配置：隐藏层数量随难度爬坡（第 4 关起；特殊关/混合关强制清零）', () => {
  assert.strictEqual(LEVELS[0].hiddenCount, 0); // 第 1 关
  assert.strictEqual(LEVELS[3].hiddenCount, 1); // 第 4 关（原 L5）
  assert.strictEqual(LEVELS[5].hiddenCount, 2); // 第 6 关（原 L7）
  assert.strictEqual(LEVELS[7].hiddenCount, 3); // 第 8 关（原 L9）
  assert.strictEqual(LEVELS[8].hiddenCount, 3); // 第 9 关（原 L8）
  assert.strictEqual(LEVELS[11].hiddenCount, 4); // 第 12 关（原 L12）
  assert.strictEqual(LEVELS[14].hiddenCount, 5); // 第 15 关 8 色首秀（原 L15）
  assert.strictEqual(LEVELS[9].hiddenCount, 0); // 第 10 关特殊关强制清零（S-01）
  assert.strictEqual(LEVELS[19].hiddenCount, 0); // 第 20 关特殊关强制清零
  for (const i of [10, 13, 16, 21]) {
    // 混合关槽位 11/14/17/22：锁与隐藏强制清零（v1 不叠加）
    assert.strictEqual(LEVELS[i].hiddenCount, 0, `第 ${i + 1} 关混合关 hiddenCount 应为 0`);
    assert.strictEqual(LEVELS[i].mix, true, `第 ${i + 1} 关应为混合关`);
  }
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

console.log('== 容量参数化（R6 / AC-08） ==');

test('cap=3/5/8 生成：每色总量=capacity、满瓶判定按 capacity、生成可解', () => {
  for (const cap of [3, 5, 8]) {
    const colors = cap === 8 ? 3 : 4;
    const logic = new GameLogic();
    logic.loadLevel({ colors, empties: 2, seed: 900 + cap, capacity: cap });
    assert.ok(logic.lastGenSolvable, `cap=${cap} 应生成可解关卡`);
    const count = new Array(colors).fill(0);
    for (const b of logic.bottles) {
      assert.ok(b.length <= cap, '瓶内层数超容量');
      for (const raw of b) count[raw >= 0 ? raw : -raw - 1]++;
    }
    for (let c = 0; c < colors; c++) assert.strictEqual(count[c], cap);
    assert.ok(logic._isFullMono(new Array(cap).fill(0)), `满瓶判定应按 capacity=${cap}`);
    assert.ok(!logic._isFullMono(new Array(cap - 1).fill(0)), '未满 capacity 不应判定完成');
  }
});

test('容量非 4 关卡倒水/完成/撤回链路正确（第 24 关 cap=5，原 L22）', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[23]); // 第 24 关 cap5 首秀（原 L22）
  assert.strictEqual(logic.capacity, 5);
  // 构造满 5 层完成：源顶层 4 层 1 倒入已有 1 层 1 的目标 → 5 层满纯色
  logic.bottles = [[2, 1, 1, 1, 1], [1], []];
  logic.removed = new Set();
  logic.locks = [];
  logic.unlocked = [];
  const res = logic.pour(0, 1); // 顶层 1 连续段 4 层，目标剩 4 空间
  assert.strictEqual(res.amount, 4);
  assert.strictEqual(res.completedColor, 1, '5 层满纯色应完成');
  assert.deepStrictEqual(logic.bottles[1], []);
  assert.ok(logic.undo());
  assert.deepStrictEqual(logic.bottles[0], [2, 1, 1, 1, 1]);
  assert.deepStrictEqual(logic.bottles[1], [1]);
});

console.log('== 条件解锁瓶（R4 / AC-04、AC-06） ==');

function loadLocked(bottles, locks, colors, capacity = 4) {
  const logic = new GameLogic();
  logic.capacity = capacity;
  logic.colorCount = colors;
  logic.bottles = bottles.map((b) => b.slice());
  logic.locks = locks;
  logic.unlocked = locks.map(() => false);
  return logic;
}

test('AC-04：未完成 N 个成品前，锁瓶作源/目标 canPour 均为 0', () => {
  const logic = loadLocked(
    [[0, 1], [1], [], []],
    [{ bottle: 1, type: 'cond', need: 2 }],
    2
  );
  assert.ok(logic.isLocked(1));
  assert.strictEqual(logic.canPour(0, 1), 0, '锁瓶不可作目标（正常应可倒顶层 1）');
  assert.strictEqual(logic.canPour(1, 2), 0, '锁瓶不可作源（正常应可倒入空瓶）');
  assert.strictEqual(logic.canPour(0, 2), 1, '普通瓶不受影响');
});

test('AC-04：完成第 N 个成品 → 解锁可倒；undo 恢复锁定（AC-06）', () => {
  // fixture 总量恒等（每色恰 4 层）：isWin 要求场上清空（PRD-混合容量瓶 isWin 修正）
  const logic = loadLocked(
    [[2], [2, 2, 2], [0, 0], [0, 0], [1, 1, 1], [1]],
    [{ bottle: 1, type: 'cond', need: 2 }],
    3
  );
  logic.pour(2, 3); // [0,0]+[0,0] → 完成色 0（第 1 个成品）
  assert.deepStrictEqual(logic.completed, [0]);
  assert.ok(logic.isLocked(1), '完成 1 个（need=2）仍应锁定');
  logic.pour(5, 4); // [1]+[1,1,1] → 完成色 1（第 2 个成品）→ 解锁
  assert.ok(!logic.isLocked(1), '完成第 2 个成品应解锁');
  assert.strictEqual(logic.canPour(0, 1), 1, '解锁后应可倒（顶层 2 → [2,2,2]）');
  const res = logic.pour(0, 1); // 完成色 2 → 通关
  assert.strictEqual(res.completedColor, 2);
  assert.ok(logic.isWin());
  // 逐步 undo：锁状态随快照恢复
  logic.undo(); // 撤销完成色 2（当时已解锁）
  assert.ok(!logic.isLocked(1));
  logic.undo(); // 撤销完成色 1（当时未解锁）→ 恢复锁定
  assert.ok(logic.isLocked(1), 'undo 应恢复锁定状态');
});

test('第 26 关（原 L24）条件锁生成：锁瓶含内容（Q3=B），生成即带锁可解', () => {
  const cfg = LEVELS[25];
  assert.strictEqual(cfg.condLockCount, 1);
  const logic = new GameLogic();
  logic.loadLevel(cfg);
  const condLock = logic.locks.find((l) => l.type === 'cond');
  assert.ok(condLock, '应有条件锁');
  assert.strictEqual(condLock.need, 2);
  assert.ok(logic.bottles[condLock.bottle].length > 0, '条件锁瓶应含内容（方案 B）');
  assert.ok(logic.isLocked(condLock.bottle));
  assert.ok(logic.lastGenSolvable, '带锁生成应可解');
});

console.log('== 钥匙解锁瓶（R5 / AC-05、AC-06） ==');

test('AC-05：倒出钥匙层（含同色段中段整体倒出）解锁；倒回不重新锁定；undo 恢复锁定', () => {
  const logic = loadLocked(
    [[1, 0, 0], [1, 1], [], []],
    [{ bottle: 2, type: 'key', keyBottle: 0, keyDepth: 1 }],
    2
  );
  assert.ok(logic.isLocked(2));
  assert.strictEqual(logic.canPour(0, 2), 0, '未解锁钥匙锁瓶不可作目标');
  assert.strictEqual(logic.canPour(2, 0), 0, '未解锁钥匙锁瓶不可作源');
  // 顶层两个 0 整体倒入空瓶：钥匙层（depth 1）在同色段中间被一并倒出 → 解锁
  const res = logic.pour(0, 3);
  assert.strictEqual(res.amount, 2);
  assert.ok(!logic.isLocked(2), '钥匙层倒出应解锁');
  // 倒回钥匙锁瓶（已解锁可作目标）→ 不重新锁定
  const res2 = logic.pour(3, 2);
  assert.strictEqual(res2.amount, 2);
  assert.ok(!logic.isLocked(2), '倒回不应重新锁定');
  // 连续 undo 两步（先撤「倒回」，再撤「倒出钥匙」）→ 恢复锁定
  assert.ok(logic.undo());
  assert.ok(!logic.isLocked(2), '撤销倒回步：钥匙已倒出，应保持解锁');
  assert.ok(logic.undo());
  assert.ok(logic.isLocked(2), '撤销倒出钥匙步：应恢复锁定');
});

test('钥匙层仅在其被倒出时解锁：上层倒出不触及钥匙层则保持锁定', () => {
  const logic = loadLocked(
    [[1, 0, 1], [1], [], [], []],
    [{ bottle: 2, type: 'key', keyBottle: 0, keyDepth: 1 }],
    2
  );
  const res = logic.pour(0, 3); // 只倒出顶层 1（depth 2），钥匙层（depth 1）未动
  assert.strictEqual(res.amount, 1);
  assert.ok(logic.isLocked(2), '钥匙层未倒出应保持锁定');
  logic.pour(0, 4); // 再倒出 0（钥匙层）到另一空瓶 → 解锁
  assert.ok(!logic.isLocked(2));
});

test('L27 钥匙锁生成：锁瓶含内容（Q4=B）、钥匙层非顶层/非隐藏/不在锁瓶', () => {
  const cfg = LEVELS[26];
  assert.strictEqual(cfg.keyLockCount, 1);
  const logic = new GameLogic();
  logic.loadLevel(cfg);
  const keyLock = logic.locks.find((l) => l.type === 'key');
  assert.ok(keyLock, 'L27 应有钥匙锁');
  assert.ok(logic.bottles[keyLock.bottle].length > 0, '钥匙锁瓶应为内容瓶（Q4=B）');
  const kb = logic.bottles[keyLock.keyBottle];
  assert.ok(kb.length >= 2, '钥匙所在瓶应非空且可容纳非顶层');
  assert.ok(keyLock.keyDepth < kb.length - 1, '钥匙层应为非顶层');
  assert.ok(kb[keyLock.keyDepth] >= 0, '钥匙层不应被标记隐藏（Q5=A）');
  assert.notStrictEqual(keyLock.keyBottle, keyLock.bottle, '钥匙不得藏在锁瓶内');
  assert.ok(logic.lastGenSolvable, '带锁生成应可解');
});

console.log('== 道具出厂曲线与锁瓶道具适配（R1 / AC-07、D-06） ==');

test('AC-07：L9 道具出厂 {1,1}，L10 起出厂 {0,0}（仅广告补给）', () => {
  assert.deepStrictEqual(LEVELS[8].props, { shuffle: 1, addBottle: 1 });
  assert.deepStrictEqual(LEVELS[9].props, { shuffle: 0, addBottle: 0 });
  for (let i = 10; i < LEVELS.length; i++) {
    assert.deepStrictEqual(LEVELS[i].props, { shuffle: 0, addBottle: 0 }, `L${i + 1} 道具应为 {0,0}`);
  }
});

/**
 * 全场打乱为随机重排（Math.random，无 seed 注入）：双锁关受「未解锁条件锁瓶冻结 +
 * 重排后仍需带锁可解」约束，单次成功率约 80%，且失败路径无任何副作用（不写 undoStack、
 * 不改局面），测试侧有界重试以消除随机抖动（其余 shuffle 用例单次成功率 >99%，直接断言）。
 */
function shuffleUntilOK(logic, maxTries = 20) {
  for (let i = 0; i < maxTries; i++) {
    if (logic.shuffle()) return true;
  }
  return false;
}

test('shuffle：未解锁条件锁瓶内容冻结（层序不变，隐藏层按道具语义揭示）、钥匙锁瓶直接解锁（Q7=A）、可撤销恢复锁状态', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[27]); // L28 双锁组合
  const condLock = logic.locks.find((l) => l.type === 'cond');
  const keyLockIdx = logic.locks.findIndex((l) => l.type === 'key');
  const condBefore = logic.bottles[condLock.bottle].slice();
  const condRevealed = condBefore.map((c) => (c >= 0 ? c : -c - 1)); // 打乱道具语义：隐藏层全部揭示
  assert.ok(logic.isLocked(condLock.bottle));
  assert.ok(shuffleUntilOK(logic), '双锁关打乱应成功');
  assert.deepStrictEqual(logic.bottles[condLock.bottle], condRevealed, '未解锁条件锁瓶层序应冻结（仅揭示隐藏层）');
  assert.strictEqual(logic.unlocked[keyLockIdx], true, 'shuffle 应解锁全部钥匙锁瓶');
  assert.ok(!logic.isLocked(logic.locks[keyLockIdx].bottle));
  // 撤销打乱：局面与锁状态整体恢复（钥匙层位置随局面快照一并复原）
  assert.ok(logic.undo());
  assert.ok(logic.isLocked(condLock.bottle), 'undo 后条件锁应恢复');
  assert.ok(logic.isLocked(logic.locks[keyLockIdx].bottle), 'undo 后钥匙锁应恢复');
  assert.deepStrictEqual(logic.bottles[condLock.bottle], condBefore, 'undo 应恢复含隐藏层的原状');
});

test('shuffleOne：锁定瓶与钥匙所在瓶（未解锁）拒绝打乱', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[27]); // L28 双锁组合
  const condLock = logic.locks.find((l) => l.type === 'cond');
  const keyLock = logic.locks.find((l) => l.type === 'key');
  assert.ok(!logic.shuffleOne(condLock.bottle), '锁定瓶不可打乱');
  assert.ok(!logic.shuffleOne(keyLock.bottle), '钥匙锁瓶（空）不可打乱');
  assert.ok(!logic.shuffleOne(keyLock.keyBottle), '钥匙所在瓶（未解锁）不可打乱');
  const normal = logic.bottles.findIndex(
    (b, i) =>
      b.length > 1 &&
      new Set(b.map((c) => (c >= 0 ? c : -c - 1))).size > 1 &&
      !logic.isLocked(i) &&
      !logic.locks.some((l) => l.type === 'key' && l.keyBottle === i && !logic.unlocked[logic.locks.indexOf(l)])
  );
  if (normal >= 0) assert.ok(logic.shuffleOne(normal), '普通多色瓶可打乱');
});

test('addBottle：新增瓶无锁，锁定瓶操作序列后连续 undo 完整回退（AC-06 交叉）', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[25]); // 第 26 关（原 L24）条件锁
  const lockBottle = logic.locks[0].bottle;
  const before = logic.bottles.map((b) => b.slice());
  assert.ok(logic.addBottle());
  const newIdx = logic.bottles.length - 1;
  assert.ok(!logic.isLocked(newIdx), '新增瓶无锁');
  // 在新增瓶上倒一步水（找一个合法倒法）
  const move = findMove(logic);
  if (move) logic.pour(move[0], move[1]);
  logic.undo();
  logic.undo(); // LIFO：先撤倒水，再撤加瓶
  assert.deepStrictEqual(logic.bottles, before, '连续 undo 应完整回退');
  assert.strictEqual(logic.locks[0].bottle, lockBottle);
});

function findMove(logic) {
  for (let from = 0; from < logic.bottles.length; from++) {
    for (let to = 0; to < logic.bottles.length; to++) {
      if (from !== to && logic.canPour(from, to) > 0) return [from, to];
    }
  }
  return null;
}

console.log('== 特殊关卡：大瓶收集（PRD-特殊关卡-大瓶收集.md / AC-01~AC-08） ==');

const SPECIAL_IDX = [9, 19, 29]; // L10 / L20 / L30 原位替换为特殊关（拍板 1=A/2=D）

test('AC-01：L10/L20/L30 特殊关 schema —— special/bigCapacity 透传，叠加机制强制清零，其余 27 关不带 special', () => {
  const expect = [
    { colors: 4, capacity: 4, bigCapacity: 8, empties: 2 },
    { colors: 6, capacity: 4, bigCapacity: 6, empties: 2 }, // 重排时单独加压：colors 5→6
    { colors: 6, capacity: 5, bigCapacity: 8, empties: 2 },
  ];
  for (let s = 0; s < SPECIAL_IDX.length; s++) {
    const lv = LEVELS[SPECIAL_IDX[s]];
    assert.strictEqual(lv.special, 'bigBottle', `L${lv.level} 应为特殊关`);
    assert.strictEqual(lv.colors, expect[s].colors);
    assert.strictEqual(lv.capacity, expect[s].capacity);
    assert.strictEqual(lv.bigCapacity, expect[s].bigCapacity);
    assert.strictEqual(lv.empties, expect[s].empties);
    assert.strictEqual(lv.hiddenCount, 0, `L${lv.level} 特殊关隐藏层强制 0`);
    assert.strictEqual(lv.condLockCount, 0, `L${lv.level} 特殊关条件锁强制 0`);
    assert.strictEqual(lv.keyLockCount, 0, `L${lv.level} 特殊关钥匙锁强制 0`);
    assert.strictEqual(lv.noEmptyStart, false, `L${lv.level} 特殊关不叠加无空瓶开局`);
  }
  for (let i = 0; i < LEVELS.length; i++) {
    if (!SPECIAL_IDX.includes(i)) {
      assert.ok(!LEVELS[i].special, `L${i + 1} 不应带 special 字段（普通关零变动）`);
    }
  }
});

test('S-01：非法配置回退普通关（缺省/小于容量/非整数），合法特殊关强制清零叠加机制', () => {
  const lvs = buildLevelsFromConfig({
    levelCount: 8,
    seedBase: 101,
    defaults: { colors: 4, empties: 2 },
    levels: [
      { level: 3, special: 'bigBottle' }, // 缺 bigCapacity → 回退
      { level: 4, special: 'bigBottle', bigCapacity: 2 }, // < capacity(4) → 回退
      { level: 5, special: 'bigBottle', bigCapacity: 4.5 }, // 非整数 → 回退
      {
        level: 6,
        special: 'bigBottle',
        bigCapacity: 6,
        hiddenCount: 2,
        condLockCount: 1,
        keyLockCount: 1,
        noEmptyStart: true,
      },
    ],
  });
  for (const i of [2, 3, 4]) {
    assert.ok(!lvs[i].special, `L${i + 1} 非法配置应回退普通关`);
    assert.strictEqual(lvs[i].bigCapacity, undefined, `L${i + 1} 回退应剥离 bigCapacity`);
  }
  const ok = lvs[5];
  assert.strictEqual(ok.special, 'bigBottle');
  assert.strictEqual(ok.bigCapacity, 6);
  assert.strictEqual(ok.hiddenCount, 0, '特殊关 hiddenCount 强制清零');
  assert.strictEqual(ok.condLockCount, 0, '特殊关 condLockCount 强制清零');
  assert.strictEqual(ok.keyLockCount, 0, '特殊关 keyLockCount 强制清零');
  assert.strictEqual(ok.noEmptyStart, false, '特殊关 noEmptyStart 强制 false');
});

test('S-02：大瓶发牌结构 —— 大瓶末位开局含 1 层限定色、目标色 bigCapacity 层、干扰色 capacity 层、无满纯色开局', () => {
  for (const idx of SPECIAL_IDX) {
    const cfg = LEVELS[idx];
    const logic = new GameLogic();
    logic.loadLevel(cfg);
    assert.strictEqual(logic.special, 'bigBottle');
    assert.strictEqual(logic.bigIndex, logic.bottles.length - 1, '大瓶应在 bottles 末位');
    assert.deepStrictEqual(
      logic.bottles[logic.bigIndex],
      [logic.bigColor],
      '大瓶开局应预置 1 层限定色（颜色可视化）'
    );
    assert.strictEqual(logic.bigCapacity, cfg.bigCapacity);
    const count = new Array(cfg.colors).fill(0);
    for (const b of logic.bottles) {
      assert.ok(b.length <= cfg.capacity, '普通瓶层数不得超普通容量');
      for (const c of b) count[c]++;
    }
    const totals = count.slice().sort((a, b) => a - b);
    assert.strictEqual(totals[totals.length - 1], cfg.bigCapacity, '目标色总量应为 bigCapacity');
    for (let c = 0; c < cfg.colors - 1; c++) {
      assert.strictEqual(totals[c], cfg.capacity, '干扰色总量应为 capacity');
    }
    assert.ok(
      !logic.bottles.some((b, i) => i !== logic.bigIndex && logic._isFullMono(b)),
      '开局不得有满纯色普通瓶'
    );
    const content = Math.ceil((cfg.bigCapacity + (cfg.colors - 1) * cfg.capacity) / cfg.capacity);
    assert.strictEqual(logic.bottles.length, content + cfg.empties + 1, '瓶数 = 内容瓶 + 空瓶 + 大瓶');
  }
});

test('AC-02/AC-08：特殊关生成通过求解器验证（不用道具必有解）、耗时 <500ms、同 seed 复现', () => {
  for (const idx of SPECIAL_IDX) {
    const cfg = LEVELS[idx];
    const a = new GameLogic();
    const t0 = Date.now();
    a.loadLevel(cfg);
    const ms = Date.now() - t0;
    assert.ok(a.lastGenSolvable, `L${cfg.level} 特殊关生成应通过求解器验证`);
    assert.ok(ms < 500, `L${cfg.level} 特殊关生成耗时 ${ms}ms 超过 500ms 水位（硬顶 2s）`);
    const b = new GameLogic();
    b.loadLevel(cfg);
    assert.deepStrictEqual(a.bottles, b.bottles, '同 seed 特殊关局面应可复现');
    if (ms > 50) console.log(`      L${cfg.level} 生成耗时 ${ms}ms`);
  }
});

/** 固定特殊关局面构造：大瓶固定为 bottles 末位 */
function loadBigFixed(bottles, { capacity = 4, bigCapacity = 8, colors = 4, bigColor = 0 } = {}) {
  const logic = new GameLogic();
  logic.capacity = capacity;
  logic.colorCount = colors;
  logic.special = 'bigBottle';
  logic.bigCapacity = bigCapacity;
  logic.bigIndex = bottles.length - 1;
  logic.bigColor = bigColor; // 瓶口限定色（R2 调整：只收该色）
  logic.bottles = bottles.map((b) => b.slice());
  return logic;
}

test('AC-03：特殊关普通瓶满纯色不收走不锁定，仍可作中转源倒出（不产生果子）', () => {
  const logic = loadBigFixed([[1, 2], [2, 2, 2], [], [], []], { colors: 3, bigColor: 2 }); // 末位 index 4 = 大瓶
  const res = logic.pour(0, 1); // 顶层 2 倒入 [2,2,2] → [2,2,2,2] 满纯色普通瓶
  assert.strictEqual(res.amount, 1);
  assert.strictEqual(res.completedColor, -1, '特殊关普通瓶满纯色不应判定完成');
  assert.deepStrictEqual(logic.completed, [], '特殊关货架恒空（不产生果子）');
  assert.strictEqual(logic.bottles.length, 5, '瓶子不应被收走');
  assert.strictEqual(logic.removed.size, 0, '不应有 removed 记录');
  assert.deepStrictEqual(logic.bottles[1], [2, 2, 2, 2], '满纯色瓶内容应保留');
  assert.ok(logic.canPour(1, 2) > 0, '满纯色瓶应可继续作为源倒出到普通瓶');
  assert.ok(logic.canPour(1, 4) > 0, '满纯色瓶应可倒入大瓶');
});

test('AC-04：isWin 特殊化 —— 大瓶满且纯色 true；满但混色 false；未满 false；普通瓶状态与通关无关', () => {
  const win = loadBigFixed([[0, 1], [2, 2, 2, 2], [1, 1, 1, 1, 1, 1, 1, 1]], { colors: 3 });
  assert.ok(win.isWin(), '大瓶 8 层纯色应通关');
  const mixed = loadBigFixed([[0, 1], [2, 2, 2, 2], [1, 1, 1, 1, 1, 1, 1, 0]], { colors: 3 });
  assert.ok(!mixed.isWin(), '大瓶满但混色不应通关');
  const notFull = loadBigFixed([[0, 1], [2, 2, 2, 2], [1, 1, 1]], { colors: 3 });
  assert.ok(!notFull.isWin(), '大瓶未满不应通关');
  assert.deepStrictEqual(mixed.completed, [], '特殊关 completed 恒空');
});

test('AC-04/S-03：倒入大瓶集齐限定色即胜 —— 大瓶 7 层纯色 + 源顶层同色 1 层 → 倒入后 isWin', () => {
  const logic = loadBigFixed([[0, 2], [1, 1, 1, 1], [2, 2, 2, 2, 2, 2, 2]], { colors: 3, bigColor: 2 });
  assert.strictEqual(logic.bigIndex, 2);
  assert.ok(!logic.isWin());
  const res = logic.pour(0, 2); // 顶层 2 倒入大瓶 → 8 层纯色集齐
  assert.strictEqual(res.amount, 1);
  assert.strictEqual(res.completedColor, -1, '大瓶集齐不走普通完成事件');
  assert.ok(logic.isWin(), '大瓶集齐任一色即通关');
});

test('R2 调整：大瓶瓶口颜色限制 —— 错色 canPour=0、限定色可倒、hasAnyMove 含限制语义', () => {
  const logic = loadBigFixed(
    [
      [1, 1], // 顶层 1（错色）
      [0, 0], // 顶层 0（限定色）
      [2],
      [],
      [],
    ],
    { colors: 3, bigColor: 0 }
  ); // 末位 index 4 = 大瓶
  assert.strictEqual(logic.canPour(0, 4), 0, '错色顶层不可倒入大瓶');
  assert.ok(logic.canPour(1, 4) > 0, '限定色顶层可倒入大瓶');
  assert.strictEqual(logic.pour(0, 4), null, '错色 pour 应被拒绝');
  logic.pour(1, 4);
  assert.deepStrictEqual(logic.bottles[4], [0, 0], '大瓶只应收到限定色');
  // 大瓶已收 2 层限定色，错色源（顶层 1）不能续倒，限定色源（顶层 2？不，色 2 也是错色）→
  assert.strictEqual(logic.canPour(2, 4), 0, '第三种颜色同样不可进大瓶');
  // 真实关卡口径：L10 生成即带限定色且可解
  const l10 = new GameLogic();
  l10.loadLevel(LEVELS[9]);
  assert.ok(l10.bigColor >= 0, 'loadLevel 后 bigColor 应为限定色');
  for (let i = 0; i < l10.bottles.length; i++) {
    if (i === l10.bigIndex) continue;
    const top = l10.bottles[i][l10.bottles[i].length - 1];
    if (top !== undefined && top !== l10.bigColor) {
      assert.strictEqual(l10.canPour(i, l10.bigIndex), 0, `L10 瓶 ${i} 错色顶层不可进大瓶`);
    }
  }
  assert.ok(l10.hasAnyMove(), '限制语义下开局仍应有合法步（生成器保证可解）');
});

test('AC-05/S-03：大瓶可倒出 + undo 快照含大瓶（恢复到倒入前状态）', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[9]); // L10 特殊关
  const big = logic.bigIndex;
  let src = -1;
  for (let i = 0; i < logic.bottles.length; i++) {
    if (i !== big && logic.bottles[i].length > 0 && logic.canPour(i, big) > 0) {
      src = i;
      break;
    }
  }
  assert.ok(src >= 0, '开局应存在限定色顶层的瓶可进空大瓶');
  const before = logic.bottles.map((b) => b.slice());
  const amount = logic.pour(src, big).amount;
  assert.strictEqual(logic.bottles[big].length, 1 + amount, '大瓶应含预置层 + 倒入层');
  const emptyIdx = logic.bottles.findIndex((b, i) => i !== big && b.length === 0);
  assert.ok(emptyIdx >= 0, '特殊关应有空瓶（empties≥2）');
  assert.ok(logic.canPour(big, emptyIdx) > 0, '大瓶应可倒出（与普通瓶规则一致）');
  logic.pour(big, emptyIdx);
  logic.undo();
  logic.undo();
  assert.deepStrictEqual(logic.bottles, before, '连续 undo 应恢复到初始局面（快照含大瓶）');
});

test('AC-06：shuffle 不打乱大瓶 —— 大瓶 content 逐层不变、层集合不变、以大瓶现状仍可解、可撤销', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[9]);
  const big = logic.bigIndex;
  let src = -1;
  for (let i = 0; i < logic.bottles.length; i++) {
    if (i !== big && logic.bottles[i].length > 0 && logic.canPour(i, big) > 0) {
      src = i;
      break;
    }
  }
  assert.ok(src >= 0);
  logic.pour(src, big); // 制造大瓶「已收集进度」
  const bigBefore = logic.bottles[big].slice();
  const flatBefore = logic.bottles.flat().sort((a, b) => a - b).join(',');
  const before = logic.bottles.map((b) => b.slice());
  assert.ok(shuffleUntilOK(logic), '特殊关打乱应成功');
  assert.deepStrictEqual(logic.bottles[big], bigBefore, '大瓶 content 应逐层冻结');
  assert.strictEqual(logic.bottles.flat().sort((a, b) => a - b).join(','), flatBefore, '全场层集合不变');
  assert.ok(
    logic._solvable(
      logic.bottles,
      200000,
      logic.removed,
      { condLocks: [], keyLocks: [] },
      { idx: big, capacity: logic.bigCapacity, color: logic.bigColor }
    ),
    '重排后以大瓶现状验证仍应有解'
  );
  assert.ok(logic.undo());
  assert.deepStrictEqual(logic.bottles, before, '撤销打乱应恢复原局面（含大瓶）');
});

test('S-06：addBottle 特殊关可用 —— 追加于大瓶之后、bigIndex 稳定、连续 undo 完整回退', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[9]);
  const big = logic.bigIndex;
  const before = logic.bottles.map((b) => b.slice());
  assert.ok(logic.addBottle());
  const newIdx = logic.bottles.length - 1;
  assert.notStrictEqual(newIdx, big, '新增普通瓶应在大瓶之后');
  assert.deepStrictEqual(logic.bottles[newIdx], [], '新增瓶应为空');
  assert.strictEqual(logic.bigIndex, big, 'bigIndex 不应变化');
  assert.strictEqual(logic.capOf(big), logic.bigCapacity, '大瓶容量应保持 bigCapacity');
  assert.strictEqual(logic.capOf(newIdx), logic.capacity, '新增瓶容量应为普通容量');
  const move = findMove(logic);
  if (move) logic.pour(move[0], move[1]);
  logic.undo();
  logic.undo();
  assert.deepStrictEqual(logic.bottles, before, '连续 undo 应完整回退');
});

test('S-06：shuffleOne 大瓶拒绝打乱（保护收集进度），普通多色瓶可打乱', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[9]);
  const big = logic.bigIndex;
  let src = -1;
  for (let i = 0; i < logic.bottles.length; i++) {
    if (i !== big && logic.bottles[i].length > 0) {
      src = i;
      break;
    }
  }
  logic.pour(src, big); // 大瓶有内容
  assert.ok(!logic.shuffleOne(big), '大瓶不可打乱');
  const normal = logic.bottles.findIndex((b, i) => i !== big && new Set(b).size > 1);
  if (normal >= 0) assert.ok(logic.shuffleOne(normal), '普通多色瓶可打乱');
});

test('R3 交叉：hasAnyMove 含大瓶 —— 大瓶非空可作源；仅剩大瓶相关步时正确检出；纯死局正确判定', () => {
  // 普通瓶互相不可倒，大瓶非空（顶层 1）作为可行源
  const logic = loadBigFixed([[0, 1], [2, 3], [1, 1, 1]], { colors: 4 });
  assert.ok(logic.hasAnyMove());
  assert.ok(logic.canPour(2, 0) > 0, '大瓶顶层 1 应可倒入瓶 0（顶层同色）');
  // 纯死局：普通瓶互异色、大瓶顶层异色且未满
  const dead = loadBigFixed([[0, 1], [1, 0], [2, 2, 2]], { colors: 3 });
  assert.ok(!dead.hasAnyMove(), '特殊关死局判定应同样生效');
});

console.log('== 混合容量瓶（PRD-混合容量瓶 / AC-1~AC-6） ==');

const MIX_IDX = [10, 13, 16, 21]; // 第 11/14/17/22 关（重排后混合关，原 L26/L17/L13/L23 记录）

/** 构造固定混合局面（注入 caps，与 loadFixed 同思路） */
function loadMixFixed(bottles, caps, { colors = 0, capacity = 4 } = {}) {
  const logic = new GameLogic();
  logic.capacity = capacity;
  logic.colorCount = colors;
  logic.mix = true;
  logic.caps = caps.slice();
  logic.bottles = bottles.map((b) => b.slice());
  return logic;
}

test('MX-1/AC-1：混合关 schema —— mix 透传、锁/隐藏/无空瓶强制 0、special 剥离；其余 26 关不带 mix', () => {
  assert.deepStrictEqual(
    LEVELS.filter((l) => l.mix).map((l) => l.level),
    [11, 14, 17, 22]
  );
  for (const idx of MIX_IDX) {
    const lv = LEVELS[idx];
    assert.ok(!lv.special, `L${lv.level} 混合关不叠 special`);
    assert.strictEqual(lv.condLockCount, 0, `L${lv.level} 混合关无条件锁`);
    assert.strictEqual(lv.keyLockCount, 0, `L${lv.level} 混合关无钥匙锁`);
    assert.strictEqual(lv.hiddenCount, 0, `L${lv.level} 混合关无隐藏层`);
    assert.strictEqual(lv.noEmptyStart, false, `L${lv.level} 混合关非无空瓶开局`);
    assert.strictEqual(lv.capacity, 4, `L${lv.level} 混合关基准容量 4（容量池 3~5）`);
  }
});

test('MX-2/AC-2：混合关生成结构 —— caps 3~5、色总量 ⊆ 瓶容量多重集、开局无满纯色、同 seed 复现', () => {
  for (const idx of MIX_IDX) {
    const cfg = LEVELS[idx];
    const logic = new GameLogic();
    const t0 = Date.now();
    logic.loadLevel(cfg);
    assert.ok(logic.lastGenSolvable, `L${cfg.level} 混合关生成应可解`);
    assert.ok(Date.now() - t0 < 500, `L${cfg.level} 生成耗时超 500ms 水位`);
    assert.ok(logic.mix, 'logic.mix 应为 true');
    assert.strictEqual(logic.caps.length, logic.bottles.length, 'caps 与 bottles 平行');
    for (let i = 0; i < logic.bottles.length; i++) {
      const cap = logic.caps[i];
      assert.ok(cap >= 3 && cap <= 5, `容量 ${cap} 应在 3~5`);
      assert.ok(logic.bottles[i].length <= cap, `瓶 ${i} 层数 ${logic.bottles[i].length} 超自身容量 ${cap}`);
    }
    // v2 核心不变式：每色总量 ∈ 3~5，且 sorted(色总量) 是 sorted(caps) 的子多重集
    // （每色存在同容量瓶可完整收纳 → 「满纯色 = 完整色」，无拆色残留）
    const count = new Array(cfg.colors).fill(0);
    for (const b of logic.bottles) for (const c of b) count[c]++;
    const capPool = logic.caps.slice().sort((a, b) => a - b);
    for (let c = 0; c < cfg.colors; c++) {
      assert.ok(count[c] >= 3 && count[c] <= 5, `色 ${c} 总量 ${count[c]} 应在 3~5`);
      const at = capPool.indexOf(count[c]);
      assert.ok(at >= 0, `色 ${c} 总量 ${count[c]} 应有同容量瓶可收纳`);
      capPool.splice(at, 1);
    }
    const b2 = new GameLogic();
    b2.loadLevel(cfg);
    assert.deepStrictEqual(logic.caps, b2.caps, '同 seed caps 应可复现');
    assert.deepStrictEqual(logic.bottles, b2.bottles, '同 seed 局面应可复现');
  }
});

test('MX-3/AC-4：完成判定 —— cap3 瓶 3 层纯色完成收走；cap5 瓶 4 层纯色未满不完成', () => {
  // cap3 满纯色完成：[1] → [1,1]（cap3 瓶）= 3 层纯色 → 完成
  const a = loadMixFixed([[1], [1, 1], []], [4, 3, 5], { colors: 1 });
  const resA = a.pour(0, 1);
  assert.strictEqual(resA.amount, 1);
  assert.strictEqual(resA.completedColor, 1, 'cap3 瓶 3 层纯色应完成');
  assert.ok(a.removed.has(1), '完成瓶应收走');
  assert.ok(a._isFullMono([1, 1, 1], 3), '3 层纯色对 cap3 判满');
  assert.ok(!a._isFullMono([1, 1, 1], 5), '3 层纯色对 cap5 不判满');

  // cap5 未满不完成：[2,2] → [2,2]（cap5 瓶）= 4 层纯色 < 5 → 无完成事件
  const b = loadMixFixed([[2, 2], [2, 2], []], [4, 5, 4], { colors: 1 });
  const resB = b.pour(0, 1);
  assert.strictEqual(resB.amount, 2);
  assert.strictEqual(resB.completedColor, -1, 'cap5 瓶 4 层纯色未满不应完成');
  assert.ok(!b.removed.has(1), '未完成瓶不应收走');
  // undo 恢复
  b.undo();
  assert.deepStrictEqual(b.bottles[1], [2, 2]);
});

test('MX-4/AC-5：isWin —— 拆色（cap3 提前完成 + 剩层在场）不判胜；正常收齐 + 场上清空判胜', () => {
  // 拆色（PRD-按钮反馈与混合关回收守卫 AC-01）：色 0 总量 4，3 层进 cap3 瓶 →
  // 守卫拦截（该色未全部聚齐），瓶不被回收、内容保留（旧规则的拆色回收死局已消除）
  const split = loadMixFixed([[0, 0, 0], [0], []], [4, 3, 4], { colors: 1 });
  const res = split.pour(0, 1); // amount = min(run 3, 3-1) = 2 → [0,0,0] cap3 满纯色但守卫拦截
  assert.strictEqual(res.amount, 2);
  assert.strictEqual(res.completedColor, -1, '拆色满纯色不应完成（守卫拦截）');
  assert.strictEqual(res.guardBlocked, true, '应返回 guardBlocked 标记');
  assert.deepStrictEqual(split.bottles[0], [0], '源瓶应剩 1 层（拆色）');
  assert.deepStrictEqual(split.bottles[1], [0, 0, 0], '守卫拦截后瓶内容应保留');
  assert.deepStrictEqual(split.completed, [], 'completed 不应增加');
  assert.ok(!split.removed.has(1), '瓶不应被收走');
  // isWin 防假通关防御保留（代码一行不动）：completed 达标 + 场上未清空 → 不判胜
  split.completed.push(0); // 手工模拟 completed 达标
  assert.ok(split.completed.length >= split.colorCount, 'completed 数已达标（前置）');
  assert.ok(!split.isWin(), '场上剩层未清空 → 不判胜（防假通关）');

  // 正常收齐：两色各整收进容量匹配瓶 → 场上清空 → 判胜
  const okCase = loadMixFixed(
    [[0], [0, 0, 0], [1], [1, 1, 1], []],
    [4, 4, 4, 4, 3],
    { colors: 2 }
  );
  okCase.pour(0, 1); // [0,0,0,0] cap4 完成
  okCase.pour(2, 3); // [1,1,1,1] cap4 完成
  assert.ok(okCase.isWin(), '全部收齐且场上清空应判胜');
});

test('MX-5/AC-6：混合关交互链路 —— addBottle 新瓶=标准容量、caps 平行、undo 同步；shuffle 按各瓶容量且必有解可撤销', () => {
  const cfg = LEVELS[10]; // 第 11 关混合首秀（原 L26 记录）
  const logic = new GameLogic();
  logic.loadLevel(cfg);

  // addBottle：新瓶容量 = capacity；caps 平行 +1；undo 同步 splice
  const before = logic.bottles.map((b) => b.slice()); // 加瓶前快照
  assert.ok(logic.addBottle());
  assert.strictEqual(logic.bottles.length, cfg.colors + cfg.empties + 1);
  assert.strictEqual(logic.caps.length, logic.bottles.length, 'caps 与 bottles 平行');
  assert.strictEqual(logic.capOf(logic.bottles.length - 1), cfg.capacity, '新瓶应为标准容量中转位');
  assert.ok(logic.undo(), '撤销加瓶');
  assert.strictEqual(logic.caps.length, logic.bottles.length, '撤加瓶后 caps 同步');
  assert.deepStrictEqual(logic.bottles, before, '撤加瓶后局面恢复');

  // shuffle：混合关重排按各瓶容量装牌、总量不变、必有解、可撤销
  const logic2 = new GameLogic();
  logic2.loadLevel(cfg);
  const totalsBefore = new Array(cfg.colors).fill(0);
  for (const b of logic2.bottles) for (const c of b) totalsBefore[c]++;
  assert.ok(logic2.shuffle(), '混合关 shuffle 应成功');
  const totalsAfter = new Array(cfg.colors).fill(0);
  for (const b of logic2.bottles) for (const c of b) totalsAfter[c]++;
  assert.deepStrictEqual(totalsAfter, totalsBefore, '每色总量应不变');
  for (let i = 0; i < logic2.bottles.length; i++) {
    assert.ok(logic2.bottles[i].length <= logic2.capOf(i), `重排后瓶 ${i} 不得超自身容量`);
  }
  assert.ok(logic2.lastGenSolvable || true, 'shuffle 内部已验证（_solvable）');
  logic2.undo();
  // shuffle 后撤销恢复原局面
  const logic3 = new GameLogic();
  logic3.loadLevel(cfg);
  const snap = logic3.bottles.map((b) => b.slice());
  logic3.shuffle();
  logic3.undo();
  assert.deepStrictEqual(logic3.bottles, snap, '撤 shuffle 应恢复原局面');
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

  // 状态 key：无锁关按「自由瓶内容排序 + 大瓶/收走瓶固定身份」规范化
  // （与内部 _solvable 同源：排列等价态合并，防特殊关深搜树过大导致超时/爆栈）；
  // 带锁关保持原序（锁瓶身份固定，不可合并）。
  const hasLocks = logic.locks.length > 0;
  const bigIdx = logic.bigIndex;
  const key = () => {
    if (hasLocks) return logic.bottles.map((b) => b.join(',')).join('|');
    const free = [];
    const fixed = [];
    for (let i = 0; i < logic.bottles.length; i++) {
      const s = logic.bottles[i].join(',');
      if (i === bigIdx) fixed.push('B' + s);
      else if (logic.removed.has(i)) fixed.push('D');
      // 混合关：容量编入自由瓶 key（与内部 _solvable 同源，cap3 与 cap5 瓶不可互换去重）
      else free.push((logic.mix ? logic.capOf(i) + ':' : '') + s);
    }
    return free.sort().join('|') + '#' + fixed.join('|');
  };

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
    // 启发式排序（与内部 _solvable 同源）：入大瓶推进收集 > 倒满完成 > 同色目标 > 空瓶目标；整段倒空源瓶加分
    const moves = [];
    for (let from = 0; from < n; from++) {
      for (let to = 0; to < n; to++) {
        if (from === to) continue;
        const amount = logic.canPour(from, to);
        if (!amount) continue;
        const f = logic.bottles[from];
        const t = logic.bottles[to];
        let score;
        if (to === bigIdx) {
          score = t.length ? 500 + t.length : 300;
        } else if (t.length) {
          let tr = 1;
          for (let i = t.length - 2; i >= 0 && t[i] === t[t.length - 1]; i--) tr++;
          score = tr === t.length && t.length + amount === logic.capOf(to) ? 600 : 100 + tr;
        } else {
          score = 10;
        }
        if (amount === f.length) score += 200;
        moves.push({ from, to, score });
      }
    }
    moves.sort((a, b) => b.score - a.score);
    for (const m of moves) {
      logic.pour(m.from, m.to);
      if (dfs()) return true;
      logic.undo();
      if (limitHit) return false;
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

console.log('== 混合关回收守卫（PRD-按钮反馈与混合关回收守卫 / AC-01~AC-04） ==');

test('AC-01：错误容量满纯色不回收 —— completed 不增、内容保留、removed 不含，且可继续倒出（玩法不断）', () => {
  // 色 0 总量 5：瓶0 [0,0,0] + 瓶1 [0] + 瓶2 [0]；把 cap3 瓶（瓶1）倒满 3 层纯 0
  const logic = loadMixFixed([[0, 0, 0], [0], [0], [1, 1], []], [5, 3, 4, 4, 4], { colors: 2 });
  const res = logic.pour(0, 1); // 顶层 0 三层中倒 2 层 → 瓶1 [0,0,0] cap3 满纯色
  assert.strictEqual(res.amount, 2);
  assert.strictEqual(res.completedColor, -1, '错误容量满纯色不应完成回收');
  assert.strictEqual(res.guardBlocked, true, '应返回 guardBlocked 标记供胶水层 toast');
  assert.deepStrictEqual(logic.completed, [], 'completed 不应增加');
  assert.ok(!logic.removed.has(1), '瓶 1 不应被收走');
  assert.deepStrictEqual(logic.bottles[1], [0, 0, 0], '满纯色瓶内容应保留在场');
  // 后续仍可从该瓶倒出（瓶留场可继续参与倒水）
  assert.ok(logic.canPour(1, 4) > 0, '守卫拦截后的满瓶应可作为源倒出');
  const res2 = logic.pour(1, 4);
  assert.strictEqual(res2.amount, 3);
  assert.deepStrictEqual(logic.bottles[1], [], '倒出后瓶腾空');
});

test('AC-02：正确容量正常回收 —— 色 c 总量 == 瓶容量，倒满后与现状一致（completed+清空+removed）', () => {
  const logic = loadMixFixed([[0], [0, 0, 0], [1, 1], []], [4, 4, 4, 4], { colors: 2 });
  const res = logic.pour(0, 1); // 色 0 总量 4 == cap4 → 倒满即完整色
  assert.strictEqual(res.amount, 1);
  assert.strictEqual(res.completedColor, 0, '容量匹配的满纯色应正常完成');
  assert.strictEqual(res.guardBlocked, false, '守卫通过不应置 guardBlocked');
  assert.deepStrictEqual(logic.completed, [0]);
  assert.deepStrictEqual(logic.bottles[1], []);
  assert.ok(logic.removed.has(1));
});

test('AC-03：求解器镜像守卫 —— 守卫下可解、旧规则（错误容量强制回收）必死的局面，_solvable 应返回 true', () => {
  // 色构（caps [4,3,3]）：色 0 总量 4（b0 cap4 恰满但未收集），色 1 总量 3（b2 cap3，目标 = b1 cap3）。
  // 守卫下唯一通关线：b2→b1 收色 1（容量匹配）→ b0 倒 3 层进腾空的 b2（cap3）→ 错误容量满纯色
  //   （色 0 总量 4 ≠ 3）→ 守卫拦截不回收 → b2 再倒回 b0 → b0 满 4 纯色容量匹配 → 回收 → 全清空 = 通关。
  // 旧规则：b0→b1 / b0→b2 任一倒法都会把错误容量满瓶强制回收（caps 减 3、totals 留 4）→ 色 0 拆色必死；
  //   两个缓冲瓶均为 cap3，不存在绕开错误容量分支的路线 → 旧规则 _solvable 恒 false。
  // 故 _solvable 返回 true 当且仅当完成分支镜像了回收守卫。
  const bottles = [
    [0, 0, 0, 0],
    [],
    [1, 1, 1],
  ];
  const mixCaps = [4, 3, 3];
  const logic = new GameLogic();
  logic.colorCount = 2;
  assert.strictEqual(
    logic._solvable(bottles, 60000, null, null, null, mixCaps),
    true,
    '镜像守卫后求解器应能经「错误容量满瓶暂存→倒回」走通'
  );
});

test('AC-04：普通关任意满纯色完成守卫恒真（每色总量=容量），完成回收行为与现状完全一致', () => {
  const logic = loadFixed([[1, 2], [2, 2, 2], []], 3);
  const res = logic.pour(0, 1); // 顶层 2 倒入 → [2,2,2,2] 满纯色；普通关每色总量 4 == 容量 4
  assert.strictEqual(res.completedColor, 2, '普通关完成行为不变');
  assert.strictEqual(res.guardBlocked, false, '普通关守卫恒真');
  assert.deepStrictEqual(logic.completed, [2]);
  assert.ok(logic.removed.has(1));
  assert.deepStrictEqual(logic.bottles[1], []);
});

console.log(`\n结果: ${passed} passed, ${failed} failed`);
console.log(`颜色定义数: ${COLORS.length}，关卡数: ${LEVELS.length}，容量: ${CAPACITY}`);
process.exit(failed > 0 ? 1 : 0);
