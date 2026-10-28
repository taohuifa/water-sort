/**
 * 关卡生成异步化回归（PRD-关卡生成异步化与加载界面 F-01/F-02，headless）
 * ▶ 何时跑我：改 core/game.js 生成状态机（beginGenerate/stepGenerate/_genAttempt/_finalizeGenerate）、
 *   改 _generate 逻辑、改 GEN_TOTAL_BUDGET_MS 预算、改 _solvable
 * 覆盖：T-01 异步/同步等价 · T-02 暂停恢复+幂等 · T-03 慢关可解 · T-04 special/mix 单帧即过
 * （T-05 全量 3s 预算断言在 game.test.js「全部关卡生成」用例内）
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import GameLogic from '../js/core/game.js';
import { buildLevelsFromConfig, parseJsonc } from '../js/core/levels.js';

const cfg = parseJsonc(readFileSync(new URL('../assets/config/levels.json', import.meta.url), 'utf8'));
const LEVELS = buildLevelsFromConfig(cfg);

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

/** 异步跑完一关：beginGenerate + 循环 stepGenerate(小预算片)，返回 {logic, steps, attempts} */
function runAsync(lv, sliceMs = 8) {
  const logic = new GameLogic();
  logic.beginGenerate(lv);
  let steps = 0;
  let r;
  do {
    r = logic.stepGenerate(sliceMs);
    steps++;
  } while (!r.done && steps < 100000);
  assert.ok(r.done, 'stepGenerate 应在有限步内完成');
  return { logic, steps, attempts: r.attempts };
}

/** 局面维度摘要（等价性比较用） */
function snapshot(logic) {
  return {
    solvable: logic.lastGenSolvable,
    solLen: logic.lastGenSolLen,
    bottleCount: logic.bottles.length,
    colorCount: logic.colorCount,
    lockCount: logic.locks.length,
    coverCount: logic.coverBottles.length,
    bombCount: logic.bombBottles.length,
    bombMoves: logic.bombMoves,
    moveLimit: logic.moveLimit,
    timeLimit: logic.timeLimit,
    bottles: JSON.stringify(logic.bottles),
    locks: JSON.stringify(logic.locks),
    covers: JSON.stringify(logic.coverBottles),
    bombs: JSON.stringify(logic.bombBottles),
  };
}

console.log('== T-01 异步/同步等价（AC-01） ==');
for (const no of [15, 23, 25, 28, 45, 49]) {
  test(`L${no}：分步生成与同步 loadLevel 局面完全一致`, () => {
    const lv = LEVELS[no - 1];
    const sync = new GameLogic();
    sync.loadLevel(lv);
    const { logic: async, attempts } = runAsync(lv);
    assert.deepStrictEqual(snapshot(async), snapshot(sync), `L${no} 局面不一致`);
    assert.ok(attempts >= 1);
  });
}

console.log('== T-02 暂停/恢复 + 完成后幂等（AC-02） ==');
test('L45：stepGenerate(1) 未完成可续跑，完成后重复调用幂等', () => {
  const logic = new GameLogic();
  logic.beginGenerate(LEVELS[44]); // L45 钥匙×2 慢关
  const r1 = logic.stepGenerate(1); // 预算片极小：大概率未完成
  if (!r1.done) {
    assert.ok(r1.attempts >= 1, '未完成时也应至少跑过一次 attempt');
    let guard = 0;
    let r;
    do {
      r = logic.stepGenerate(30);
      guard++;
    } while (!r.done && guard < 100000);
    assert.ok(r.done, '续跑应最终完成');
  } else {
    console.log('      （本机过快，stepGenerate(1) 已完成，跳过恢复断言）');
  }
  assert.ok(logic.lastGenSolvable, 'L45 应可解');
  assert.ok(logic.isGenerating() === false, '完成后 isGenerating 应为 false');
  const bottlesBefore = JSON.stringify(logic.bottles);
  const r2 = logic.stepGenerate(6);
  assert.ok(r2.done, '完成后重复调用应幂等返回 done');
  assert.strictEqual(JSON.stringify(logic.bottles), bottlesBefore, '重复调用不得改动局面');
});

console.log('== T-03 慢关可解（AC-03） ==');
for (const no of [25, 28, 45, 49]) {
  test(`L${no}：异步全流程 lastGenSolvable=true`, () => {
    const { logic } = runAsync(LEVELS[no - 1]);
    assert.ok(logic.lastGenSolvable, `L${no} 未验证出可解局面（兜底风险）`);
  });
}

console.log('== T-04 special/mix 单帧即过 ==');
test('L10 特殊关：beginGenerate 即完成，bigIndex/bigColor 正确', () => {
  const logic = new GameLogic();
  logic.beginGenerate(LEVELS[9]);
  const r = logic.stepGenerate(6);
  assert.ok(r.done, '特殊关应首调即完成');
  assert.ok(logic.bigIndex >= 0 && logic.bigIndex === logic.bottles.length - 1, '大瓶应固定末位');
  assert.ok(logic.bigColor >= 0);
  assert.ok(logic.lastGenSolvable, 'L10 特殊关生成应可解');
});
test('L11 混合关：beginGenerate 即完成，caps 填充正确', () => {
  const logic = new GameLogic();
  logic.beginGenerate(LEVELS[10]);
  const r = logic.stepGenerate(6);
  assert.ok(r.done, '混合关应首调即完成');
  assert.strictEqual(logic.caps.length, logic.bottles.length, 'caps 应与 bottles 平行');
  assert.ok(logic.caps.every((c) => c >= 3 && c <= 5), '混合关容量应为 3~5');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
