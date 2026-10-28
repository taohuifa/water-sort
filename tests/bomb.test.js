/**
 * 炸弹瓶逻辑层单元测试（Node 直接运行：node tests/bomb.test.js）
 * 对应 PRD-玩法扩展 §2 B / F-03，实现文档 docs/design/PRD-玩法扩展-炸弹瓶-实现.md §8
 * 覆盖：配置解析与容错、生成结构（炸弹/锁/钥匙/遮盖/隐藏零重叠）、倒计时递减、倒空拆除、
 *       失败判定与冻结、undo 回退倒计时、快照一致性、生成解长约束、打乱适配
 * 注：T-07b 为慢用例（生成重洗耗尽 5s 预算），整体约 +5s。
 * ▶ 何时跑我：改 game.js 炸弹逻辑（引信/拆除/failReason bomb 分支/applyRevive 炸弹加成）、levels.json bombCount/bombMoves
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import GameLogic from '../js/core/game.js';
import { buildLevelsFromConfig, parseJsonc } from '../js/core/levels.js';

// 与游戏入口同源加载 30 关配置
const CFG = parseJsonc(readFileSync(new URL('../assets/config/levels.json', import.meta.url), 'utf8'));
const LEVELS = buildLevelsFromConfig(CFG);

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

console.log('== 炸弹瓶：配置解析（F-01 部分） ==');

test('T-01：炸弹配置总表与 levels.json 一致（L23/L26 基线 + 铺量章节）；bombMoves ≥ 8（回填后显式）；defaults 含新字段', () => {
  // [关号, bombCount] 全量清单（PRD-100关扩充 §3 章节表 + 原 L23/L26 + v2 难度重整补空洞 L37/39/45/54/72/79）
  const expectBomb = new Map([
    [23, 2], [26, 1],
    [37, 1], [39, 1], [45, 1], [54, 1],
    [67, 1], [68, 1], [69, 1],
    [72, 1], [79, 1],
    [85, 1], [89, 1],
    [91, 1], [93, 1], [96, 1], [97, 1], [98, 2], [99, 2], // L92/L95 已改混合关（912a44e），炸弹按 mix 写回口径卸载，不入总表
  ]);
  for (let i = 0; i < LEVELS.length; i++) {
    const expect = expectBomb.get(i + 1) ?? 0;
    assert.strictEqual(LEVELS[i].bombCount, expect, `L${i + 1} bombCount 应为 ${expect}`);
    if (expect > 0) {
      assert.ok(LEVELS[i].bombMoves >= 8, `L${i + 1} bombMoves=${LEVELS[i].bombMoves} 应 ≥ 8（solve-report 回填）`);
    }
  }
  assert.ok('bombCount' in CFG.defaults, 'defaults 应含 bombCount');
  assert.ok('bombMoves' in CFG.defaults, 'defaults 应含 bombMoves');
});

test('T-02：配置容错 —— special/mix 强制清零；bombMoves 非法/过小回退自动（0）+ warn', () => {
  const warn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const lvs = buildLevelsFromConfig({
      levelCount: 5,
      seedBase: 400,
      defaults: { colors: 4, empties: 2 },
      levels: [
        { level: 1, special: 'bigBottle', bigCapacity: 6, bombCount: 1 }, // 特殊关 → 强制 0
        { level: 2, mix: true, bombCount: 1 }, // 混合关 → 强制 0
        { level: 3, bombCount: 1, bombMoves: -3 }, // 负数 → 回退自动
        { level: 4, bombCount: 1, bombMoves: 2.5 }, // 非整数 → 回退自动
        { level: 5, bombCount: 1, bombMoves: 5 }, // 0 < moves < 8 → 回退自动（解长约束不可行域）
      ],
    });
    assert.strictEqual(lvs[0].bombCount, 0, '特殊关 bombCount 强制 0');
    assert.strictEqual(lvs[1].bombCount, 0, '混合关 bombCount 强制 0');
    assert.strictEqual(lvs[2].bombMoves, 0, '负数 bombMoves 应回退自动');
    assert.strictEqual(lvs[3].bombMoves, 0, '非整数 bombMoves 应回退自动');
    assert.strictEqual(lvs[4].bombMoves, 0, 'bombMoves < 8 应回退自动');
    assert.ok(warns.length >= 5, '每处容错均应 warn');
  } finally {
    console.warn = warn;
  }
});

console.log('== 炸弹瓶：生成结构 ==');

test('T-03：生成结构 —— 数量正确、全为非空瓶、与锁/钥匙/遮盖/隐藏瓶零重叠、timers 初值、同 seed 复现、解长约束', () => {
  for (const idx of [22, 25]) {
    const cfg = LEVELS[idx];
    const a = new GameLogic();
    a.loadLevel(cfg);
    assert.strictEqual(a.bombBottles.length, cfg.bombCount, `L${cfg.level} 炸弹瓶数应 = bombCount`);
    assert.ok(a.bombMoves >= 8, `L${cfg.level} bombMoves=${a.bombMoves} 应 ≥ 8`);
    assert.ok(a.lastGenSolvable, `L${cfg.level} 含炸弹生成应通过求解器验证`);
    assert.ok(a.lastGenSolLen >= 1, `L${cfg.level} 应记录启发式解长`);
    assert.ok(
      a.bombMoves - a.lastGenSolLen >= 2,
      `L${cfg.level} 解长约束：bombMoves(${a.bombMoves}) - 解长(${a.lastGenSolLen}) ≥ 2`
    );
    assert.deepStrictEqual(a.bombTimers, a.bombBottles.map(() => a.bombMoves), 'timers 初值应 = bombMoves');
    assert.ok(a.bombDefused.every((d) => !d), '开局应无拆除标记');
    for (const bi of a.bombBottles) {
      assert.ok(a.bottles[bi].length > 0, `L${cfg.level} 炸弹瓶 ${bi} 应为非空瓶`);
      assert.ok(!a.locks.some((l) => l.bottle === bi), `L${cfg.level} 炸弹瓶 ${bi} 不应同时是锁瓶`);
      assert.ok(
        !a.locks.some((l) => l.type === 'key' && l.keyBottle === bi),
        `L${cfg.level} 炸弹瓶 ${bi} 不应同时是钥匙瓶`
      );
      assert.ok(!a.coverBottles.includes(bi), `L${cfg.level} 炸弹瓶 ${bi} 不应同时是遮盖瓶`);
      assert.ok(!a.bottles[bi].some((c) => c < 0), `L${cfg.level} 炸弹瓶 ${bi} 内不应有隐藏层`);
    }
    // 隐藏瓶与炸弹瓶零重叠
    for (let i = 0; i < a.bottles.length; i++) {
      if (a.bombBottles.includes(i)) continue;
      // 其余瓶是否有隐藏层不影响断言；炸弹瓶自身已在上面断言无隐藏层
    }
    const b = new GameLogic();
    b.loadLevel(cfg);
    assert.deepStrictEqual(a.bottles, b.bottles, `L${cfg.level} 同 seed 局面应复现`);
    assert.deepStrictEqual(a.bombBottles, b.bombBottles, `L${cfg.level} 同 seed 炸弹瓶位应复现`);
    assert.strictEqual(a.bombMoves, b.bombMoves, `L${cfg.level} 同 seed bombMoves 应复现`);
  }
});

console.log('== 炸弹瓶：倒计时 / 拆除 / 失败（手工 fixture） ==');

/** 手工 fixture：注入炸弹状态（与 loadLocked/loadCoverFixed 同思路） */
function loadBombFixed(bottles, { colors = 0, bombBottles = [], bombMoves = 3, capacity = 4 } = {}) {
  const logic = new GameLogic();
  logic.capacity = capacity;
  logic.colorCount = colors;
  logic.bombBottles = bombBottles.slice();
  logic.bombMoves = bombMoves;
  logic.bombTimers = bombBottles.map(() => bombMoves);
  logic.bombDefused = bombBottles.map(() => false);
  logic.bottles = bottles.map((b) => b.slice());
  return logic;
}

test('T-04：倒计时递减 + 倒空拆除（拆除瓶不再倒计时）+ 完成收走同判拆除', () => {
  // b0=[1,1,1]炸弹A b1=[1] b2=[0,0]炸弹B b3=[0,0] b4 空
  const logic = loadBombFixed(
    [[1, 1, 1], [1], [0, 0], [0, 0], []],
    { colors: 2, bombBottles: [0, 2], bombMoves: 3 }
  );
  assert.ok(!logic.isFailed(), '开局不应失败');
  // 步 1：普通倒液 → 双炸弹各 -1
  logic.pour(3, 4);
  assert.deepStrictEqual(logic.bombTimers, [2, 2], '每次成功倒液未拆除炸弹应各 -1');
  // 步 2：b2 倒入 b4 凑满纯色 → 完成收走 → 炸弹 B 倒空拆除（本步不再 -1）；炸弹 A -1
  logic.pour(2, 4);
  assert.strictEqual(logic.bombDefused[1], true, '炸弹 B（瓶 2）倒空应拆除');
  assert.deepStrictEqual(logic.bombTimers, [1, 2], '拆除瓶不再倒计时，A 继续递减');
  assert.ok(!logic.isFailed());
  // 步 3：b1 倒入 b0 凑满 → 完成收走 → 炸弹 A 拆除
  logic.pour(1, 0);
  assert.strictEqual(logic.bombDefused[0], true, '炸弹 A（瓶 0）倒空应拆除');
  assert.deepStrictEqual(logic.bombTimers, [1, 2], '拆除后不再倒计时');
  assert.ok(!logic.isFailed(), '全部拆除后不可能失败');
});

test('T-05：失败判定 —— 归零未拆除 → isFailed；操作全冻结（除 undo）；undo 恢复并解除失败', () => {
  // b0=[1,1,1]炸弹(2 步引信) b1/b2=[0,0]×2 b3 空
  const logic = loadBombFixed(
    [[1, 1, 1], [0, 0], [0, 0], []],
    { colors: 2, bombBottles: [0], bombMoves: 2 }
  );
  logic.pour(1, 3); // timer 2→1
  assert.strictEqual(logic.bombTimers[0], 1);
  assert.ok(!logic.isFailed());
  logic.pour(2, 3); // b3 凑满纯色完成；timer 1→0 → 失败
  assert.strictEqual(logic.bombTimers[0], 0);
  assert.ok(logic.isFailed(), '归零未拆除应判定失败');
  // 失败冻结：倒水 / 打乱 / 选瓶打乱 / 加瓶 全拒绝
  assert.strictEqual(logic.canPour(1, 3), 0, '失败后 canPour 应返回 0');
  assert.strictEqual(logic.pour(1, 3), null, '失败后 pour 应返回 null');
  assert.ok(!logic.shuffle(), '失败后全场打乱应拒绝');
  assert.ok(!logic.shuffleOne(1), '失败后选瓶打乱应拒绝');
  assert.ok(!logic.addBottle(), '失败后加瓶应拒绝');
  // undo 回退倒计时 → 失败自动解除
  assert.ok(logic.undo(), '失败后撤回应可用');
  assert.strictEqual(logic.bombTimers[0], 1, 'undo 应回退倒计时');
  assert.ok(!logic.isFailed(), 'undo 后失败态应解除');
  assert.ok(logic.canPour(2, 3) > 0, '解除后恢复可操作（b2 已随 undo 复原）');
});

test('T-06：快照一致性 —— 多步倒水后全量 undo，timers/defused 与开局一致；resetBombs 重置未拆除炸弹', () => {
  const logic = loadBombFixed(
    [[1, 1, 1], [1], [0, 0], [0, 0], []],
    { colors: 2, bombBottles: [0, 2], bombMoves: 5 }
  );
  const snapshot = {
    timers: logic.bombTimers.slice(),
    defused: logic.bombDefused.slice(),
    bottles: JSON.stringify(logic.bottles),
    moves: logic.moveCount,
  };
  logic.pour(3, 4);
  logic.pour(2, 4); // 炸弹 B 完成 → 拆除
  logic.pour(1, 0); // 炸弹 A 完成 → 拆除
  assert.ok(logic.bombDefused.every(Boolean));
  // 全量回退
  while (logic.undoStack.length > 0) logic.undo();
  assert.deepStrictEqual(logic.bombTimers, snapshot.timers, '全量 undo 后 timers 应与开局一致');
  assert.deepStrictEqual(logic.bombDefused, snapshot.defused, '全量 undo 后拆除标记应复原');
  assert.strictEqual(JSON.stringify(logic.bottles), snapshot.bottles, '局面应复原');
  assert.strictEqual(logic.moveCount, snapshot.moves);
  // 拆除标记不因后续操作丢失（回退点之前的拆除永久保留）
  logic.resetBombs();
  assert.deepStrictEqual(logic.bombTimers, [5, 5], 'resetBombs 应重置未拆除炸弹为初值');
  // 重做步 2 → 炸弹 B 再拆除；resetBombs 不影响已拆除瓶
  logic.pour(3, 4);
  logic.pour(2, 4);
  logic.resetBombs();
  assert.strictEqual(logic.bombTimers[0], 5, '未拆除炸弹应重置为初值');
  assert.strictEqual(logic.bombTimers[1], 4, '已拆除炸弹不受 resetBombs 影响（保持拆除时读数）');
});

test('T-06b：bombTimerOf / isFailed 查询口径（表现层/调试协议用）', () => {
  const logic = loadBombFixed(
    [[2], [1], [0, 0, 1]],
    { colors: 3, bombBottles: [0], bombMoves: 4 }
  );
  assert.strictEqual(logic.bombTimerOf(0), 4, '炸弹瓶应返回剩余步数');
  assert.strictEqual(logic.bombTimerOf(1), -1, '普通瓶应返回 -1');
  logic.pour(2, 1); // 与炸弹无关的倒液也 -1
  assert.strictEqual(logic.bombTimerOf(0), 3, '任意成功倒液均应递减');
});

console.log('== 炸弹瓶：生成解长约束 ==');

test('T-07a：自动口径 —— bombMoves ≥ 8 且 ≥ 解长 + 4；显式配置以配置为准', () => {
  const auto = new GameLogic();
  auto.loadLevel({ colors: 2, empties: 2, seed: 777, bombCount: 1 });
  assert.ok(auto.lastGenSolvable);
  assert.ok(auto.bombMoves >= 8, `自动口径应 ≥ 8（实际 ${auto.bombMoves}）`);
  assert.ok(auto.bombMoves >= auto.lastGenSolLen + 4, `自动口径应 ≥ 解长+4（${auto.bombMoves} vs ${auto.lastGenSolLen}）`);
  const explicit = new GameLogic();
  explicit.loadLevel({ colors: 2, empties: 2, seed: 777, bombCount: 1, bombMoves: 20 });
  assert.strictEqual(explicit.bombMoves, 20, '显式配置应以配置为准');
  assert.ok(explicit.bombMoves - explicit.lastGenSolLen >= 2, '显式配置应满足解长约束');
});

test('T-07b：显式配置余量不足 → 重洗耗尽预算，兜底 warn + lastGenSolvable=false（慢用例 ~5s）', () => {
  const warn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const logic = new GameLogic();
    // 6 色最短解必 > 6 步（每色至少出瓶 + 集齐两段），bombMoves=8 需解长 ≤ 6 → 全 attempts 不可行
    logic.loadLevel({ colors: 6, empties: 2, seed: 888, bombCount: 1, bombMoves: 8 });
    assert.ok(!logic.lastGenSolvable, '约束不可行应标记生成未验证通过');
    assert.ok(warns.some((w) => w.includes('预算')), '应输出预算耗尽 warn');
    // B-06：兜底路径防御 —— bombMoves 放大为 lastSolLen + 4（解长可得时），保证不违反「解长 ≤ bombMoves − 2」
    assert.ok(logic._lastSolLen > 0, '兜底前最后一次求解应记录启发式解长');
    assert.ok(
      logic.bombMoves >= logic._lastSolLen + 4,
      `兜底 bombMoves(${logic.bombMoves}) 应 ≥ lastSolLen(${logic._lastSolLen}) + 4`
    );
  } finally {
    console.warn = warn;
  }
});

test('B-05：coverCount 超候选（防御）—— 生成不炸、实际遮盖数 = 候选上限、warn 含关卡号与字段名', () => {
  const warn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const logic = new GameLogic();
    logic.loadLevel({ colors: 3, empties: 0, noEmptyStart: true, seed: 4242, coverCount: 99, level: 99 });
    // 候选上限 = 非空瓶 − 锁瓶 − 钥匙瓶（本关无锁，散打关 = 全部非空瓶）
    const candCap = logic.bottles.filter(
      (b, i) =>
        b.length > 0 &&
        !logic.locks.some((l) => l.bottle === i || (l.type === 'key' && l.keyBottle === i))
    ).length;
    assert.strictEqual(logic.coverBottles.length, candCap, `实际遮盖数应 = 候选上限 ${candCap}`);
    assert.ok(logic.coverBottles.length < 99, '遮盖数应被候选上限截断（生成不炸）');
    assert.ok(
      warns.some((w) => w.includes('coverCount') && w.includes('L99')),
      '应输出含关卡号与字段名的候选不足 warn'
    );
  } finally {
    console.warn = warn;
  }
});

console.log('== 炸弹瓶：全场打乱适配 ==');
test('T-08：shuffle 倒空炸弹瓶判拆除、timers 不变；undo 恢复拆除前状态', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[22]); // L23：2 炸弹瓶
  const timersBefore = logic.bombTimers.slice();
  const defusedBefore = logic.bombDefused.slice();
  assert.ok(logic.shuffle(), 'L23 打乱应成功');
  // 一致性：倒空的炸弹瓶必已拆除；未倒空的保持原标记；timers 不变
  for (let k = 0; k < logic.bombBottles.length; k++) {
    const bi = logic.bombBottles[k];
    if (logic.bombDefused[k]) {
      assert.strictEqual(logic.bottles[bi].length, 0, '拆除标记仅应出现在倒空炸弹瓶上');
    }
    assert.strictEqual(logic.bombTimers[k], timersBefore[k], '打乱不应改变倒计时');
  }
  assert.ok(!logic.isFailed(), '打乱后不应失败');
  assert.ok(logic.undo(), '撤销打乱');
  assert.deepStrictEqual(logic.bombTimers, timersBefore, 'undo 后 timers 恢复');
  assert.deepStrictEqual(logic.bombDefused, defusedBefore, 'undo 后拆除标记恢复');
});

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
