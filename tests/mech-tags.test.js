/**
 * 机制角标汇总 summarizeMechanics 单测（PRD-选关机制角标，headless 纯逻辑）
 * 场景：真实 levels.json 全量关 + 合成用例，验证判定条件 / 优先级排序 / 角标数上限
 * ▶ 何时跑我：改 summarizeMechanics 判定/优先级、levels.json 机制字段、选关页角标逻辑
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildLevelsFromConfig, parseJsonc, summarizeMechanics } from '../js/core/levels.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n    ${err.message}`);
  }
}

// ---------- 真实配置全量 ----------
const cfgText = readFileSync(new URL('../assets/config/levels.json', import.meta.url), 'utf8');
const LEVELS = buildLevelsFromConfig(parseJsonc(cfgText));

test('全量 100 关角标均为数组且数量 ≤5（>3 由渲染层显示「+N」兜底；上限取实配峰值 L79=无空/弹/条锁/钥锁/盖）', () => {
  assert.strictEqual(LEVELS.length, 100);
  for (const lv of LEVELS) {
    const tags = summarizeMechanics(lv);
    assert.ok(Array.isArray(tags), `L${lv.level} 角标非数组`);
    assert.ok(tags.length <= 5, `L${lv.level} 角标数 ${tags.length} > 5：${tags.join(',')}`);
  }
});

test('抽样：无机制关返回空数组', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    assert.deepStrictEqual(summarizeMechanics(LEVELS[n - 1]), [], `L${n} 应无角标`);
  }
});

test('抽样：L10 大瓶 / L11 混合 / L23 炸弹', () => {
  assert.deepStrictEqual(summarizeMechanics(LEVELS[9]), ['big']);
  assert.deepStrictEqual(summarizeMechanics(LEVELS[10]), ['mix']);
  assert.deepStrictEqual(summarizeMechanics(LEVELS[22]), ['bomb']);
});

test('抽样：L28 双锁+遮盖按优先级排序', () => {
  assert.deepStrictEqual(summarizeMechanics(LEVELS[27]), ['condLock', 'keyLock', 'cover']);
});

test('抽样：L29 无空+遮盖 / L43 条锁+限时 / L52 条锁+步限', () => {
  assert.deepStrictEqual(summarizeMechanics(LEVELS[28]), ['noEmpty', 'cover']);
  assert.deepStrictEqual(summarizeMechanics(LEVELS[42]), ['condLock', 'time']);
  assert.deepStrictEqual(summarizeMechanics(LEVELS[51]), ['condLock', 'move']);
});

// ---------- 合成用例（不依赖配置） ----------
test('空入参/空对象返回空数组', () => {
  assert.deepStrictEqual(summarizeMechanics(null), []);
  assert.deepStrictEqual(summarizeMechanics({}), []);
});

test('九机制全开：顺序 = 优先级表（大瓶/混/无空/弹/条锁/钥锁/盖/限时/步限）', () => {
  const lv = {
    special: 'bigBottle',
    mix: true,
    noEmptyStart: true,
    bombCount: 1,
    condLockCount: 1,
    keyLockCount: 1,
    coverCount: 1,
    timeLimit: 100,
    moveLimit: 20,
  };
  assert.deepStrictEqual(summarizeMechanics(lv), [
    'big',
    'mix',
    'noEmpty',
    'bomb',
    'condLock',
    'keyLock',
    'cover',
    'time',
    'move',
  ]);
});

test('字段为 0/false/null 不误报', () => {
  const lv = {
    special: null,
    mix: false,
    noEmptyStart: false,
    bombCount: 0,
    condLockCount: 0,
    keyLockCount: 0,
    coverCount: 0,
    timeLimit: 0,
    moveLimit: 0,
  };
  assert.deepStrictEqual(summarizeMechanics(lv), []);
});

console.log(`\n机制角标汇总：${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
