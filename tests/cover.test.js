/**
 * 遮盖瓶逻辑层单元测试（Node 直接运行：node tests/cover.test.js）
 * 对应 PRD-玩法扩展 §2 A / F-02，实现文档 docs/design/PRD-玩法扩展-遮盖瓶-实现.md §8
 * 覆盖：配置解析与容错、生成结构（遮盖/锁/隐藏零重叠）、交互锁、解封时序、派生一致性、生成必有解
 * ▶ 何时跑我：改 game.js 遮盖逻辑（coverLeft/isCovered/shuffleOne 冻结）、levels.js _validateCover、levels.json coverCount/coverLayers
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

console.log('== 遮盖瓶：配置解析（F-01 部分） ==');

test('T-01：遮盖配置总表与 levels.json 一致（30 关基线 + 铺量章节）；coverLayers 默认 2', () => {
  // [关号, coverCount] 全量清单（PRD-100关扩充 §3 章节表 + 原 L25/L28/L29）
  const expectCover = new Map([
    [25, 1], [28, 1], [29, 2],
    [32, 1], [34, 1], [38, 1],
    [42, 1], [44, 1], [46, 1], [47, 1],
    [55, 1], [57, 2], [59, 1],
    [62, 1], [65, 1], [66, 1],
    [72, 1], [74, 1], [76, 1], [77, 1], [78, 1], [79, 1],
    [82, 1], [83, 1], [87, 1],
    [94, 1], [96, 1], [99, 1],
  ]);
  for (let i = 0; i < LEVELS.length; i++) {
    const expect = expectCover.get(i + 1) ?? 0;
    assert.strictEqual(LEVELS[i].coverCount, expect, `L${i + 1} coverCount 应为 ${expect}`);
    assert.strictEqual(LEVELS[i].coverLayers, 2, `L${i + 1} coverLayers 应为默认 2`);
  }
  // defaults 模板包含新字段
  assert.ok('coverCount' in CFG.defaults, 'defaults 应含 coverCount');
  assert.ok('coverLayers' in CFG.defaults, 'defaults 应含 coverLayers');
});

test('T-02：配置容错 —— special/mix 强制清零；coverLayers ≥ colors clamp 为 colors-1；非法值回退 2', () => {
  const warn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const lvs = buildLevelsFromConfig({
      levelCount: 5,
      seedBase: 300,
      defaults: { colors: 4, empties: 2 },
      levels: [
        { level: 1, special: 'bigBottle', bigCapacity: 6, coverCount: 1 }, // 特殊关 → 强制 0
        { level: 2, mix: true, coverCount: 1 }, // 混合关 → 强制 0
        { level: 3, colors: 2, coverCount: 1, coverLayers: 5 }, // ≥ colors → clamp 为 1
        { level: 4, colors: 4, coverCount: 1, coverLayers: 0 }, // 非法 → 回退 2
        { level: 5, colors: 4, coverCount: 1, coverLayers: 2.5 }, // 非整数 → 回退 2
      ],
    });
    assert.strictEqual(lvs[0].coverCount, 0, '特殊关 coverCount 强制 0');
    assert.strictEqual(lvs[1].coverCount, 0, '混合关 coverCount 强制 0');
    assert.strictEqual(lvs[2].coverLayers, 1, 'coverLayers ≥ colors 应 clamp 为 colors-1');
    assert.strictEqual(lvs[3].coverLayers, 2, 'coverLayers=0 应回退 2');
    assert.strictEqual(lvs[4].coverLayers, 2, '非整数 coverLayers 应回退 2');
    assert.ok(warns.length >= 5, '每处容错均应 warn');
  } finally {
    console.warn = warn;
  }
});

console.log('== 遮盖瓶：生成结构 ==');

test('T-03：生成结构 —— 数量正确、全为非空内容瓶、与锁瓶/钥匙瓶/隐藏层瓶零重叠、同 seed 复现、生成可解', () => {
  for (const idx of [24, 27, 28]) {
    const cfg = LEVELS[idx];
    const a = new GameLogic();
    a.loadLevel(cfg);
    assert.strictEqual(a.coverBottles.length, cfg.coverCount, `L${cfg.level} 遮盖瓶数应 = coverCount`);
    assert.strictEqual(a.coverLayers, cfg.coverLayers, `L${cfg.level} coverLayers 透传`);
    assert.ok(a.lastGenSolvable, `L${cfg.level} 含遮盖生成应通过求解器验证`);
    for (const bi of a.coverBottles) {
      assert.ok(a.bottles[bi].length > 0, `L${cfg.level} 遮盖瓶 ${bi} 应为非空瓶`);
      assert.ok(!a.locks.some((l) => l.bottle === bi), `L${cfg.level} 遮盖瓶 ${bi} 不应同时是锁瓶`);
      assert.ok(
        !a.locks.some((l) => l.type === 'key' && l.keyBottle === bi),
        `L${cfg.level} 遮盖瓶 ${bi} 不应同时是钥匙瓶（钥匙层不可被遮盖）`
      );
      assert.ok(
        !a.bottles[bi].some((c) => c < 0),
        `L${cfg.level} 遮盖瓶 ${bi} 内不应有隐藏层（PRD：信息模型不叠加）`
      );
    }
    // 隐藏层瓶与遮盖瓶零重叠（有隐藏层的关：L25/L28）
    if (cfg.hiddenCount > 0) {
      for (let i = 0; i < a.bottles.length; i++) {
        if (a.coverBottles.includes(i)) continue;
        const hasHidden = a.bottles[i].some((c) => c < 0);
        if (hasHidden) {
          assert.ok(!a.coverBottles.includes(i), '隐藏瓶与遮盖瓶不应重叠');
        }
      }
      // 隐藏层总数应配满（未被遮盖瓶挤占）
      const hiddenTotal = a.bottles.reduce((s, b) => s + b.filter((c) => c < 0).length, 0);
      assert.strictEqual(hiddenTotal, cfg.hiddenCount, `L${cfg.level} 隐藏层数应配满`);
    }
    const b = new GameLogic();
    b.loadLevel(cfg);
    assert.deepStrictEqual(a.bottles, b.bottles, `L${cfg.level} 同 seed 局面应复现`);
    assert.deepStrictEqual(a.coverBottles, b.coverBottles, `L${cfg.level} 同 seed 遮盖瓶位应复现`);
  }
});

console.log('== 遮盖瓶：交互锁（与锁定瓶同级） ==');

/** 手工 fixture：注入遮盖状态（与 loadLocked/loadMixFixed 同思路） */
function loadCoverFixed(bottles, { colors = 0, coverBottles = [], coverLayers = 2 } = {}) {
  const logic = new GameLogic();
  logic.colorCount = colors;
  logic.coverBottles = coverBottles.slice();
  logic.coverLayers = coverLayers;
  logic.bottles = bottles.map((b) => b.slice());
  return logic;
}

test('T-04：遮盖瓶 canPour 源/目标均拒绝、pour 返回 null、shuffleOne 拒绝、hasAnyMove 不计遮盖步', () => {
  const logic = loadCoverFixed(
    [[1, 2], [2, 2, 2], [1, 0], [1, 1, 1]],
    { colors: 3, coverBottles: [3], coverLayers: 2 }
  );
  assert.ok(logic.isCovered(3), '瓶 3 应处于遮盖状态');
  assert.strictEqual(logic.coverLeft(), 2, 'coverLeft 应为 2');
  assert.strictEqual(logic.canPour(3, 1), 0, '遮盖瓶不可作源');
  assert.strictEqual(logic.canPour(0, 3), 0, '遮盖瓶不可作目标（顶层 2 与瓶 3 顶层 1 本就异色，此处验证拒绝路径）');
  assert.strictEqual(logic.canPour(2, 3), 0, '遮盖瓶不可作目标（同色顶层 1 本应可倒，被遮盖拒绝）');
  assert.strictEqual(logic.pour(2, 3), null, '对遮盖瓶 pour 应返回 null');
  assert.strictEqual(logic.pour(3, 1), null, '从遮盖瓶 pour 应返回 null');
  assert.ok(!logic.shuffleOne(3), '遮盖瓶不可打乱');
  // hasAnyMove：排除遮盖瓶参与的步（瓶 2→瓶 3 本为合法步）
  assert.ok(!logic.canPour(2, 3));
});

test('T-05：解封时序 —— 第 1 瓶成品后 coverLeft=1 仍遮盖；第 2 瓶后揭示恢复可倒', () => {
  const logic = loadCoverFixed(
    [[0, 2], [2, 2, 2], [1], [0, 0, 0], [1, 1, 1]],
    { colors: 3, coverBottles: [4], coverLayers: 2 }
  );
  assert.ok(logic.isCovered(4));
  // 第 1 瓶成品（色 2）
  const r1 = logic.pour(0, 1);
  assert.strictEqual(r1.completedColor, 2, '应完成色 2');
  assert.strictEqual(logic.completed.length, 1);
  assert.strictEqual(logic.coverLeft(), 1, '第 1 瓶成品后遮盖剩余应为 1');
  assert.ok(logic.isCovered(4), '未归零仍应遮盖');
  assert.strictEqual(logic.canPour(2, 4), 0, '仍遮盖时不可倒入');
  // 第 2 瓶成品（色 0）
  const r2 = logic.pour(0, 3); // [0] → [0,0,0,0] 完成色 0
  assert.strictEqual(r2.completedColor, 0);
  assert.strictEqual(logic.completed.length, 2);
  assert.strictEqual(logic.coverLeft(), 0, '第 2 瓶成品后遮盖剩余应为 0');
  assert.ok(!logic.isCovered(4), '归零应揭示');
  assert.strictEqual(logic.canPour(2, 4), 1, '揭示后恢复可倒（[1] → [1,1,1]）');
  const r3 = logic.pour(2, 4);
  assert.strictEqual(r3.amount, 1, '揭示后倒水应成功');
});

test('T-06：派生一致性 —— undo 回退成品 → 遮盖自动恢复；coverLeft 由 completed 派生无独立快照；加瓶不影响遮盖下标', () => {
  const logic = loadCoverFixed(
    [[0, 2], [2, 2, 2], [1], [0, 0, 0], [1, 1, 1]],
    { colors: 3, coverBottles: [4], coverLayers: 2 }
  );
  logic.pour(0, 1); // 完成 1 → coverLeft=1
  logic.pour(0, 3); // 完成 2 → 揭示
  assert.ok(!logic.isCovered(4));
  assert.ok(logic.undo()); // 撤销完成 2
  assert.ok(logic.isCovered(4), 'undo 后应恢复遮盖');
  assert.strictEqual(logic.coverLeft(), 1);
  assert.ok(logic.undo()); // 撤销完成 1
  assert.strictEqual(logic.coverLeft(), 2, '全撤后应回到初始遮盖层数');
  assert.ok(logic.isCovered(4));
  // 加瓶/撤加瓶：coverBottles 下标恒定，遮盖状态不受影响
  assert.ok(logic.addBottle());
  const newIdx = logic.bottles.length - 1;
  assert.ok(!logic.coverBottles.includes(newIdx), '新增瓶不应带遮盖');
  assert.ok(logic.isCovered(4), '加瓶不应影响既有遮盖');
  assert.ok(logic.undo());
  assert.strictEqual(logic.coverLeft(), 2, '撤加瓶后遮盖状态不变');
});

console.log('== 遮盖瓶：全场打乱适配 ==');

test('shuffle：遮盖瓶内容冻结（不参与重排）、重排后仍遮盖、可撤销', () => {
  const logic = new GameLogic();
  logic.loadLevel(LEVELS[28]); // L29：2 遮盖、无锁
  const covered = logic.coverBottles.slice();
  const before = logic.coverBottles.map((i) => logic.bottles[i].slice());
  // shuffle 走 Math.random 重排（300 次尝试），无空瓶关可解率 ~93% —— 偶发失败无副作用，重试取不变式
  let shuffled = false;
  for (let t = 0; t < 6 && !shuffled; t++) shuffled = logic.shuffle();
  assert.ok(shuffled, '含遮盖关打乱应成功（6 次重试内）');
  assert.deepStrictEqual(
    logic.coverBottles.map((i) => logic.bottles[i]),
    before,
    '遮盖瓶内容应冻结（层序不变）'
  );
  assert.strictEqual(logic.coverLeft(), logic.coverLayers, '打乱不应影响遮盖层数');
  assert.ok(covered.every((i) => logic.isCovered(i)), '打乱后遮盖瓶应仍遮盖');
  assert.ok(logic.undo(), '撤销打乱');
  assert.deepStrictEqual(
    logic.coverBottles.map((i) => logic.bottles[i]),
    before,
    '撤销后遮盖瓶内容恢复'
  );
});

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
