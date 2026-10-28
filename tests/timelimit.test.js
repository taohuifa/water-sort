/**
 * 限时 / 步数限制 / 续杯道具 单元测试（PRD-限时与步数限制 F-01~F-04/F-10，Node 直接运行）
 * 覆盖：配置解析与容错（放大/强制清零/special 可配）、tickTime 计时/暂停口径、时间单向流动（不入 undo）、
 *       步限判定与 undo 回退、failReason 派生优先级、生成管线解长约束、applyRevive 三类加成。
 * ▶ 何时跑我：改 game.js tickTime/failReason/applyRevive、levels.js _validateLimits、levels.json timeLimit/moveLimit、main.js 失败流程
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import GameLogic, { TIME_REVIVE_BONUS, MOVE_REVIVE_BONUS, BOMB_REVIVE_BONUS } from '../js/core/game.js';
import { buildLevelsFromConfig, parseJsonc } from '../js/core/levels.js';

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

/** 捕获 console.warn（容错断言用） */
function captureWarn(fn) {
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warns;
}

console.log('== F-01 数据层：配置解析 ==');

test('T-01：铺量配置与 §2.1 公式一致（L96~99 试用 + L31~L100 全量），其余关 0（不限）；defaults 含新字段', () => {
  assert.ok('timeLimit' in CFG.defaults && 'moveLimit' in CFG.defaults, 'defaults 应含 timeLimit/moveLimit');
  // §2.1 公式：moveLimit = max(20, ⌈par×1.5⌉)、timeLimit = max(90, par×8)（par 用 levels.json 回填值）
  const expect = new Map([
    // —— 试用（已拍板，不动）——
    [96, { timeLimit: 264, moveLimit: 50 }], // par 33：⌈49.5⌉=50 / 33×8=264
    [97, { timeLimit: 0, moveLimit: 44 }], // par 29：⌈43.5⌉=44
    [98, { timeLimit: 248, moveLimit: 0 }], // par 31：31×8=248
    [99, { timeLimit: 232, moveLimit: 44 }],
    // —— 全量铺量（步限：第4章起每章2关；限时：第7章起每章1~2关 + Boss70/90）
    // —— v2 难度重整（PRD-关卡难度重整 §3/执行记录）：限时首秀 L43、双限过渡 L94、Boss50/60 加压、
    //    L46/47/57/73/76 步限按重摇后 par 重算、L52 补步限（par 用 levels.json 回填值）
    [34, { timeLimit: 0, moveLimit: 26 }], // par 17：⌈25.5⌉=26
    [36, { timeLimit: 0, moveLimit: 36 }], // par 24
    [43, { timeLimit: 208, moveLimit: 0 }], // v2 限时首秀：par 26 → 26×8=208
    [46, { timeLimit: 0, moveLimit: 36 }], // v2 seed 重摇后 par 24
    [47, { timeLimit: 0, moveLimit: 38 }], // v2 seed 重摇后 par 25：⌈37.5⌉=38
    [48, { timeLimit: 200, moveLimit: 0 }], // v2 锁+时限组合教学（par 24）
    [50, { timeLimit: 456, moveLimit: 0 }], // v2 Boss⑤ 加压：par 57†（BFS 上界）→ 57×8=456
    [52, { timeLimit: 0, moveLimit: 36 }], // v2 补步限：par 24
    [57, { timeLimit: 0, moveLimit: 41 }], // v2 seed 重摇后 par 27：⌈40.5⌉=41
    [58, { timeLimit: 0, moveLimit: 33 }], // par 22
    [60, { timeLimit: 320, moveLimit: 0 }], // v2 Boss⑥ 大瓶10层重摇：par 40† → max(90, ⌈40×8⌉)=320
    [62, { timeLimit: 0, moveLimit: 42 }], // par 28
    [63, { timeLimit: 256, moveLimit: 0 }], // par 32：32×8=256
    [65, { timeLimit: 0, moveLimit: 41 }], // par 27：⌈40.5⌉=41
    [66, { timeLimit: 264, moveLimit: 0 }], // par 33
    [70, { timeLimit: 360, moveLimit: 0 }], // Boss⑦：45×8
    [73, { timeLimit: 0, moveLimit: 36 }], // v2 seed 重摇后 par 24
    [74, { timeLimit: 192, moveLimit: 0 }], // par 24
    [75, { timeLimit: 200, moveLimit: 0 }], // v2 时限配无空瓶锁关（par 24）
    [76, { timeLimit: 0, moveLimit: 39 }], // v2 seed 重摇后 par 26
    [77, { timeLimit: 184, moveLimit: 0 }], // par 23
    [82, { timeLimit: 0, moveLimit: 30 }],
    [86, { timeLimit: 232, moveLimit: 0 }], // par 29
    [87, { timeLimit: 0, moveLimit: 39 }], // par 26：⌈39⌉=39
    [88, { timeLimit: 248, moveLimit: 0 }], // par 31
    [90, { timeLimit: 416, moveLimit: 0 }], // Boss⑨：52×8
    [94, { timeLimit: 240, moveLimit: 0 }], // v2 双限过渡关：par 30 → 30×8=240
  ]);
  for (let i = 0; i < LEVELS.length; i++) {
    const no = i + 1;
    const e = expect.get(no) ?? { timeLimit: 0, moveLimit: 0 };
    assert.strictEqual(LEVELS[i].timeLimit, e.timeLimit, `L${no} timeLimit 应为 ${e.timeLimit}`);
    assert.strictEqual(LEVELS[i].moveLimit, e.moveLimit, `L${no} moveLimit 应为 ${e.moveLimit}`);
    if (e.timeLimit > 0) assert.ok(e.timeLimit >= Math.max(60, LEVELS[i].par * 6), `L${no} timeLimit 应满足 par×6 下限`);
    if (e.moveLimit > 0) assert.ok(e.moveLimit >= LEVELS[i].par + 2, `L${no} moveLimit 应满足 par+2 下限`);
  }
});

test('T-02：配置容错 —— 非法值回退 0；显式违例按 par 放大 + warn；mix 强制清零；special bigBottle 可配', () => {
  const warns = captureWarn(() => {
    const lvs = buildLevelsFromConfig({
      levelCount: 5,
      seedBase: 500,
      defaults: { colors: 4, empties: 2 },
      levels: [
        { level: 1, par: 10, moveLimit: -3, timeLimit: 2.5 }, // 非法 → 双双回退 0
        { level: 2, par: 10, moveLimit: 5 }, // < par+2=12 → 放大 12
        { level: 3, par: 10, timeLimit: 30 }, // < max(60, 60)=60 → 放大 60
        { level: 4, mix: true, timeLimit: 100, moveLimit: 50 }, // mix 不叠加 → 强制 0
        { level: 5, special: 'bigBottle', bigCapacity: 6, timeLimit: 120, moveLimit: 30 }, // 大瓶可叠 → 保留
      ],
    });
    assert.strictEqual(lvs[0].moveLimit, 0, '负数 moveLimit 应回退 0');
    assert.strictEqual(lvs[0].timeLimit, 0, '非整数 timeLimit 应回退 0');
    assert.strictEqual(lvs[1].moveLimit, 12, 'moveLimit < par+2 应放大为 par+2');
    assert.strictEqual(lvs[2].timeLimit, 60, 'timeLimit < max(60,par×6) 应放大');
    assert.strictEqual(lvs[3].timeLimit, 0, 'mix 关 timeLimit 强制 0');
    assert.strictEqual(lvs[3].moveLimit, 0, 'mix 关 moveLimit 强制 0');
    assert.strictEqual(lvs[4].timeLimit, 120, 'special bigBottle 关 timeLimit 可配（不清零）');
    assert.strictEqual(lvs[4].moveLimit, 30, 'special bigBottle 关 moveLimit 可配（不清零）');
  });
  assert.ok(warns.length >= 5, `每处容错/放大均应 warn（实际 ${warns.length} 条）`);
});

console.log('== F-02 逻辑层：限时 ==');

test('T-03：tickTime —— 递减 / clamp 0 / 不限时关无效 / 归零失败（failReason time）', () => {
  const logic = new GameLogic();
  logic.timeLimit = 90;
  logic.timeLeft = 90;
  logic.tickTime(30);
  assert.strictEqual(logic.timeLeft, 60);
  logic.tickTime(1000); // 超额推进 clamp 到 0
  assert.strictEqual(logic.timeLeft, 0);
  assert.ok(logic.isFailed(), '时间归零应判定失败');
  assert.strictEqual(logic.failReason, 'time');
  assert.strictEqual(logic.canPour(0, 1), 0, '失败态应冻结操作');
  const untimed = new GameLogic();
  untimed.timeLimit = 0;
  untimed.timeLeft = 0;
  untimed.tickTime(5);
  assert.strictEqual(untimed.timeLeft, 0, '不限时关 tickTime 应无效且不触发失败');
  assert.ok(!untimed.isFailed());
});

test('T-04：时间单向流动 —— undo 不回退 timeLeft（不入 undoStack）；loadLevel 重置满值', () => {
  const logic = new GameLogic();
  logic.loadLevel({ colors: 2, empties: 2, seed: 42, timeLimit: 100 });
  assert.strictEqual(logic.timeLeft, 100, 'loadLevel 应重置为满值');
  logic.timeLeft = 55.5; // 模拟已消耗 44.5s
  // 执行一步倒水再撤销
  let src = -1;
  let to = -1;
  for (let f = 0; f < logic.bottles.length && src < 0; f++) {
    for (let t = 0; t < logic.bottles.length; t++) {
      if (f !== t && logic.canPour(f, t) > 0) {
        src = f;
        to = t;
        break;
      }
    }
  }
  logic.pour(src, to);
  assert.strictEqual(logic.undoStack.length, 1);
  logic.undo();
  assert.strictEqual(logic.timeLeft, 55.5, 'undo 不应回退时间（时间不入快照，单向流动）');
  logic.loadLevel({ colors: 2, empties: 2, seed: 42, timeLimit: 100 });
  assert.strictEqual(logic.timeLeft, 100, '重开应重置满值');
});

console.log('== F-03 逻辑层：步数限制 ==');

test('T-05：步限 —— 达限未通关失败（moves）/ 操作冻结 / undo 回退 moveCount 解除 / 无限关不受影响', () => {
  // 注：步限注入在 loadLevel 之后（moveLimit=2 过小会触发生成解长约束重洗，语义不同）
  const logic = new GameLogic();
  logic.loadLevel({ colors: 2, empties: 2, seed: 42 });
  logic.moveLimit = 2;
  assert.strictEqual(logic.moveLimit, 2);
  const findMove = () => {
    for (let f = 0; f < logic.bottles.length; f++) {
      for (let t = 0; t < logic.bottles.length; t++) {
        if (f !== t && logic.canPour(f, t) > 0) return [f, t];
      }
    }
    return null;
  };
  logic.pour(...findMove());
  assert.ok(!logic.isFailed(), '未达限不应失败');
  logic.pour(...findMove());
  assert.strictEqual(logic.moveCount, 2);
  assert.ok(logic.isFailed(), 'moveCount 达上限未通关应判定失败');
  assert.strictEqual(logic.failReason, 'moves');
  assert.strictEqual(logic.canPour(...findMove() || [0, 1]), 0, '失败态应冻结操作');
  // undo 回退 moveCount → 失败自动解除（PRD 验收 3：步数回退口径）
  assert.ok(logic.undo());
  assert.strictEqual(logic.moveCount, 1, 'undo 应回退 moveCount');
  assert.ok(!logic.isFailed(), 'undo 后失败态应解除');
  assert.ok(logic.canPour(...findMove() || [0, 1]) > 0, '解除后恢复可操作');
  // 无限关：moveLimit=0 永不因步数失败
  const unlimited = new GameLogic();
  unlimited.loadLevel({ colors: 2, empties: 2, seed: 42 });
  unlimited.moveCount = 999;
  assert.ok(!unlimited.isFailed(), 'moveLimit=0（无限）不应失败');
});

test('T-06：failReason 派生优先级 —— 炸弹 > 步数 > 时间；既有炸弹失败口径保持', () => {
  // 手工 fixture：1 炸弹引信 1 + moveLimit 1 → 同一次 pour 双触发，按炸弹显示
  const logic = new GameLogic();
  logic.capacity = 4;
  logic.bombBottles = [0];
  logic.bombMoves = 1;
  logic.bombTimers = [1];
  logic.bombDefused = [false];
  logic.moveLimit = 1;
  logic.bottles = [[1], [0], []];
  logic.pour(1, 2); // 该步同时引爆炸弹并达步限
  assert.strictEqual(logic.moveCount, 1);
  assert.ok(logic.isFailed());
  assert.strictEqual(logic.failReason, 'bomb', '同拍多机制应按炸弹优先显示');
  // 既有口径回归：纯炸弹失败
  const bombOnly = new GameLogic();
  bombOnly.bombBottles = [0];
  bombOnly.bombMoves = 1;
  bombOnly.bombTimers = [1];
  bombOnly.bombDefused = [false];
  bombOnly.bottles = [[1], [0], []];
  bombOnly.pour(1, 2);
  assert.strictEqual(bombOnly.failReason, 'bomb', '炸弹失败口径应保持（零回归）');
});

console.log('== F-04 生成管线：解长约束 ==');

test('T-07：显式 moveLimit/timeLimit 关生成接受局面必满足解长约束（solLen ≤ moveLimit−2 且 solLen×6 ≤ timeLimit）', () => {
  const logic = new GameLogic();
  logic.loadLevel({ colors: 2, empties: 2, seed: 777, bombCount: 1, moveLimit: 8, timeLimit: 60 });
  assert.ok(logic.lastGenSolvable, '紧约束（2 色可满足）应在预算内生成成功');
  assert.ok(logic.lastGenSolLen > 0, '应记录启发式解长');
  assert.ok(
    logic.lastGenSolLen <= logic.moveLimit - 2,
    `解长(${logic.lastGenSolLen}) ≤ moveLimit(${logic.moveLimit})−2`
  );
  assert.ok(
    logic.lastGenSolLen * 6 <= logic.timeLimit,
    `解长(${logic.lastGenSolLen})×6 ≤ timeLimit(${logic.timeLimit})`
  );
});

console.log('== F-10 续杯道具：applyRevive 统一复活语义 ==');

test('T-08：applyRevive —— time +60s / moves moveLimit+10 / bomb 引信+10 封顶初值；加成后失败态解除', () => {
  assert.strictEqual(TIME_REVIVE_BONUS, 60);
  assert.strictEqual(MOVE_REVIVE_BONUS, 10);
  assert.strictEqual(BOMB_REVIVE_BONUS, 10, '炸弹加成常量与步限加成当前同值（独立导出便于调参）');
  // time
  const t = new GameLogic();
  t.timeLimit = 90;
  t.timeLeft = 0;
  assert.strictEqual(t.failReason, 'time');
  assert.strictEqual(t.applyRevive(), 'time');
  assert.strictEqual(t.timeLeft, 60, '时间复活应 +60s');
  assert.ok(!t.isFailed() && t.failReason === null, '加成后失败态应解除');
  // moves
  const m = new GameLogic();
  m.moveLimit = 10;
  m.moveCount = 10;
  assert.strictEqual(m.applyRevive(), 'moves');
  assert.strictEqual(m.moveLimit, 20, '步限复活应为上限抬升 +10');
  assert.ok(!m.isFailed(), '加成后失败态应解除');
  // bomb：引信 +10 封顶各自初值
  const b = new GameLogic();
  b.bombBottles = [0, 1];
  b.bombMoves = 5;
  b.bombTimers = [0, 3];
  b.bombDefused = [false, false];
  assert.strictEqual(b.applyRevive(), 'bomb');
  assert.deepStrictEqual(b.bombTimers, [5, 5], '引信 +10 封顶初值（0→5，3→5）');
  assert.ok(!b.isFailed(), '引信 ≥1 即解除失败');
  // 已拆除炸弹不受影响
  const b2 = new GameLogic();
  b2.bombBottles = [0];
  b2.bombMoves = 5;
  b2.bombTimers = [2];
  b2.bombDefused = [true];
  b2.applyRevive();
  assert.strictEqual(b2.bombTimers[0], 2, '已拆除引信不应被加成');
});

console.log('== F-05/F-06/F-07/F-10/F-11 胶水链路（main.js + wx storage mock） ==');

// ---------- wx 桩（storage 为内存 Map，与 inventory.test.js 同款） ----------
const noop = () => {};
const gradient = { addColorStop: noop };
const ctxStub = new Proxy(
  {},
  {
    get(target, prop) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
      if (prop === 'fillText') return (text) => globalThis.__fillTexts.push(String(text));
      if (typeof prop === 'symbol') return undefined;
      return target[prop] !== undefined ? target[prop] : noop;
    },
    set(target, prop, v) {
      target[prop] = v;
      return true;
    },
  }
);
globalThis.__fillTexts = [];
const store = new Map();
globalThis.wx = {
  createCanvas: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
  getSystemInfoSync: () => ({ screenWidth: 375, screenHeight: 812, pixelRatio: 2 }),
  onTouchStart: (fn) => (globalThis.__ts = fn),
  onTouchMove: (fn) => (globalThis.__tm = fn),
  onTouchEnd: (fn) => (globalThis.__te = fn),
  onTouchCancel: (fn) => (globalThis.__tc = fn),
  setStorageSync: (k, v) => store.set(k, v),
  getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
  removeStorageSync: (k) => store.delete(k),
  createWebAudioContext: () => ({
    currentTime: 0,
    sampleRate: 44100,
    destination: {},
    createOscillator: () => ({ connect: noop, start: noop, stop: noop, frequency: { value: 0 }, gain: { value: 0, setValueAtTime: noop, exponentialRampToValueAtTime: noop } }),
    createGain: () => ({ connect: noop, gain: { value: 0, setValueAtTime: noop, exponentialRampToValueAtTime: noop } }),
  }),
  getMenuButtonBoundingClientRect: () => ({ top: 24, bottom: 56, height: 32, left: 281, right: 368, width: 87 }),
  getFileSystemManager: () => ({
    readFileSync: (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
  }),
};
globalThis.requestAnimationFrame = () => 1;

const { default: Main } = await import('../js/main.js');
const main = new Main();
const logic = main.logic;
const renderer = main.renderer;

const center = (r) => ({ x: r.x + (r.w || 0) / 2, y: r.y + (r.h || 0) / 2 });
const tap = (x, y) => {
  globalThis.__ts({ touches: [{ clientX: x, clientY: y }] });
  globalThis.__te({ changedTouches: [{ clientX: x, clientY: y }] });
};
const tapBtn = (r) => tap(center(r).x, center(r).y);
/** 弹出失败面板（跳过 0.6s 闪光窗口，与既有冒烟同口径） */
const popFailPanel = () => {
  for (let i = 0; i < 30 && !main.failPanel; i++) {
    main.failDelay = 0.7; // 同毫秒 tick dt≈0，手动推进弹窗计时
    main.tick();
  }
};
/** 读取 __dbg_state（置空签名强制写一次） */
const readDbg = () => {
  main._dbgSig = '';
  main._dbgTs = 0;
  main.tick();
  return store.get('__dbg_state');
};

test('G-01：L96 限时/步限关载入 —— core 满值 + 调试协议四新字段', () => {
  main.loadLevel(95); // L96：timeLimit 264 / moveLimit 50
  main.scene = 'game'; // loadLevel 不切场景（与既有冒烟同口径），喂帧/失败检测要求 game 场景
  assert.strictEqual(logic.timeLimit, 264);
  assert.strictEqual(logic.timeLeft, 264, 'loadLevel 应重置满值');
  assert.strictEqual(logic.moveLimit, 50);
  const dbg = readDbg();
  assert.strictEqual(dbg.timeLeft, 264, 'timeLeft 整数秒入协议');
  assert.strictEqual(dbg.moveLimit, 50);
  assert.strictEqual(dbg.failReason, '');
  assert.strictEqual(dbg.invRevive, main.inv.revive);
});

test('G-02：限时喂帧与暂停 —— 浮层打开停喂（pauseOverlay），关闭恢复推进', () => {
  logic.timeLeft = 100;
  main.pauseOverlay = true;
  main.lastTs = Date.now() - 1000; // dt = 0.05（tick 上限 clamp）
  main.tick();
  assert.strictEqual(logic.timeLeft, 100, '暂停浮层打开时不应计时');
  main.pauseOverlay = false;
  main.lastTs = Date.now() - 1000; // 重置时间基准：dt = 0.05（tick 上限 clamp）
  main.tick();
  assert.strictEqual(logic.timeLeft, 99.95, '浮层关闭后应恢复推进（单次 tick dt=0.05s）');
});

test('G-03：步限失败链路 —— 文案「步数用完」+ 续杯消耗（+10 上限抬升，不回退局面）', () => {
  main.loadLevel(95);
  logic.moveCount = logic.moveLimit; // 直接达步限
  assert.ok(logic.isFailed() && logic.failReason === 'moves');
  popFailPanel();
  assert.ok(main.failPanel);
  globalThis.__fillTexts.length = 0;
  main.tick();
  const texts = globalThis.__fillTexts.join('\n');
  assert.ok(texts.includes('步数用完'), '失败弹窗应显示步限文案');
  assert.ok(texts.includes('续杯'), '应含续杯按钮');
  assert.ok(!texts.includes('缤纷果汁铺'), '游戏内顶部标题应已移除（F-06①）');
  const bottlesBefore = JSON.stringify(logic.bottles);
  const movesBefore = logic.moveCount;
  main.inv.revive = 1;
  tapBtn(renderer.failReviveBtn);
  assert.strictEqual(main.inv.revive, 0, '续杯应消耗 1 个');
  assert.ok(!main.failPanel, '复活后失败弹窗应关闭');
  assert.ok(!logic.isFailed(), '复活后应解除失败态');
  assert.strictEqual(logic.moveLimit, 60, '步限复活应上限抬升 +10');
  assert.strictEqual(logic.moveCount, movesBefore, '续杯不回退步数（局面保持）');
  assert.strictEqual(JSON.stringify(logic.bottles), bottlesBefore, '续杯不回退局面');
});

test('G-04：续杯库存 0 —— 广告确认浮层（覆盖失败弹窗）→ 补 1 自动使用', () => {
  main.loadLevel(95);
  logic.moveCount = logic.moveLimit;
  popFailPanel();
  main.inv.revive = 0;
  tapBtn(renderer.failReviveBtn);
  assert.strictEqual(main.adConfirm, 'revive', '库存 0 应弹广告确认浮层');
  main.tick(); // 浮层绘制不抛错（覆盖失败弹窗）
  tapBtn(renderer.adConfirmWatchBtn);
  assert.strictEqual(main.inv.revive, 0, '广告补 1 后应自动消耗使用');
  assert.ok(!main.failPanel && !main.adConfirm, '补给自动使用后浮层应全部关闭');
  assert.ok(!logic.isFailed(), '应解除失败态');
});

test('G-05：限时失败链路 —— 文案「时间到」+ failReason 入协议 + 续杯 +60s', () => {
  main.loadLevel(95);
  logic.timeLeft = 0;
  assert.strictEqual(logic.failReason, 'time');
  popFailPanel();
  globalThis.__fillTexts.length = 0;
  main.tick();
  assert.ok(globalThis.__fillTexts.join('\n').includes('时间到'), '失败弹窗应显示限时文案');
  assert.strictEqual(readDbg().failReason, 'time', 'failReason 应写入协议');
  main.inv.revive = 1;
  tapBtn(renderer.failReviveBtn);
  assert.strictEqual(logic.timeLeft, 60, '时间复活应 +60s');
  assert.ok(!logic.isFailed());
});

test('G-06：重开本关 —— timeLeft/moveLimit 满值重置、失败态清除', () => {
  main.loadLevel(95);
  logic.timeLeft = 3;
  logic.moveCount = logic.moveLimit;
  popFailPanel();
  tapBtn(renderer.failRestartBtn);
  while (main.scene === 'loading') main.stepLoading(); // 重开走 loading 分帧生成（PRD-关卡生成异步化）
  assert.ok(!main.failPanel, '重开后失败弹窗应关闭');
  assert.strictEqual(logic.moveCount, 0, '重开后步数清零');
  assert.strictEqual(logic.timeLeft, 264, '重开后倒计时满值重置');
  assert.strictEqual(logic.moveLimit, 50, '重开后步限恢复配置值（续杯抬升不残留）');
  assert.ok(!logic.isFailed());
});

test('G-07：HUD 顶栏 —— 限时关 mm:ss 倒计时 + 步数 N/M；无限关不显示（标题移除留空）', () => {
  main.loadLevel(95); // L96 双限
  logic.timeLeft = 8; // ≤10s 临界（红色脉冲分支）
  globalThis.__fillTexts.length = 0;
  main.tick();
  const timedTexts = globalThis.__fillTexts.join('\n');
  assert.ok(/\d+:\d{2}/.test(timedTexts), '限时关应显示 mm:ss 倒计时');
  assert.ok(timedTexts.includes('步数: 0/50'), '步限关应显示 步数 N/M');
  main.loadLevel(0); // L1 无限不限时
  globalThis.__fillTexts.length = 0;
  main.tick();
  const plainTexts = globalThis.__fillTexts.join('\n');
  assert.ok(!/步数/.test(plainTexts), '无限关不应显示步数（F-06③）');
  assert.ok(!/\d+:\d{2}/.test(plainTexts), '不限时关顶部居中留空（F-06②）');
  assert.ok(!plainTexts.includes('缤纷果汁铺'), '游戏内顶部标题应移除（F-06①）');
});

test('G-08：爆炸动画帧（F-11）—— 引爆 0.6s 窗口内绘制不抛错、failPanel 弹出后停止', () => {
  main.loadLevel(22); // L23：2 炸弹瓶
  logic.bombTimers[0] = 1;
  let moved = false;
  for (let f = 0; f < logic.bottles.length && !moved; f++) {
    for (let t = 0; t < logic.bottles.length; t++) {
      if (f !== t && logic.canPour(f, t) > 0) {
        logic.pour(f, t);
        moved = true;
        break;
      }
    }
  }
  assert.ok(moved && logic.isFailed(), '引信归零应失败');
  main.tick(); // 进入闪光态：爆炸动画相位帧绘制不抛错
  assert.ok(main.failFlashIdx >= 0, '应记录引爆瓶下标');
  assert.ok(main.failDelay < 0.6, '0.6s 窗口内面板未弹出');
  popFailPanel();
  assert.ok(main.failPanel, '闪光结束后应弹出失败弹窗');
  main.loadLevel(22); // 清理现场
});

test('G-09：达限→失败面板→续杯→再达限 —— 面板复现且 failDelay/failLatch 正确重置（B-01）', () => {
  main.loadLevel(95);
  main.inv.revive = 1;
  logic.moveCount = logic.moveLimit; // 第一次达步限
  popFailPanel();
  assert.ok(main.failPanel, '第一次达限应弹失败面板');
  assert.ok(main.failLatch && main.failDelay > 0.6, '首失败应置门闩并累计弹窗计时');
  tapBtn(renderer.failReviveBtn); // 续杯（_useRevive 复位 failPanel/failDelay/failLatch）
  assert.ok(!main.failPanel && !logic.isFailed(), '续杯后应解除失败并关面板');
  assert.strictEqual(main.failDelay, 0, '续杯应复位弹窗计时');
  assert.strictEqual(main.failLatch, false, '续杯应复位失败门闩');
  logic.moveCount = logic.moveLimit; // 第二次达步限（上限已 +10）
  assert.ok(logic.isFailed() && logic.failReason === 'moves', '再达限应重新失败');
  popFailPanel();
  assert.ok(main.failPanel, '续杯后再次达限失败面板应复现');
  assert.ok(main.failLatch, '新失败应重新置位门闩');
  assert.ok(main.failDelay > 0.6, '弹窗计时从 0 重新累计到弹出');
});

test('G-10：时间失败不可经 undo 解除 —— undo 回退局面但 timeLeft 单向流动，失败态保持', () => {
  main.loadLevel(95);
  // 先走一步合法倒水（构造 undo 快照）
  let moved = false;
  for (let f = 0; f < logic.bottles.length && !moved; f++) {
    for (let t = 0; t < logic.bottles.length; t++) {
      if (f !== t && logic.canPour(f, t) > 0) {
        logic.pour(f, t);
        moved = true;
        break;
      }
    }
  }
  assert.ok(moved && logic.undoStack.length === 1, '应存在可撤回快照');
  logic.timeLeft = 0; // 时间失败
  assert.ok(logic.isFailed() && logic.failReason === 'time');
  assert.ok(logic.undo(), '失败态仍允许 undo（仅 undo 不冻结）');
  assert.ok(logic.undoStack.length === 0, 'undo 应回退局面快照');
  assert.ok(logic.isFailed(), '时间失败 undo 后仍失败（时间不可回退，PRD 拍板 5）');
  assert.strictEqual(logic.failReason, 'time');
});

test('G-11：步限关最后一步恰好通关 —— moveCount 达限但不进失败分支（通关面板优先，isWin 守卫）', () => {
  main.loadLevel(95);
  // 手工摆出「再一步即通关」夹具：1 色 2 层分装两瓶，倒一步凑满且清场
  // （L96 自带锁/遮盖，夹具需一并清空，避免 canPour 被锁遮盖拦截）
  logic.colorCount = 1;
  logic.capacity = 2;
  logic.completed = [];
  logic.removed = new Set();
  logic.undoStack = [];
  logic.locks = [];
  logic.unlocked = [];
  logic.coverBottles = [];
  logic.coverLayers = 0;
  logic.bombBottles = [];
  logic.bombTimers = [];
  logic.bombDefused = [];
  logic.moveLimit = 1;
  logic.moveCount = 0;
  logic.bottles = [[1], [1], []];
  logic.pour(1, 0); // 最后一步：凑满纯色瓶 → 连瓶收走，场上清空 → isWin
  assert.ok(logic.isWin(), '该步应恰好通关');
  assert.strictEqual(logic.moveCount, logic.moveLimit, '步数应恰好达限');
  // 胶水层喂帧：通关面板应弹出，失败分支不触发
  main.winPanel = false;
  main.winDelay = 0;
  main.failPanel = false;
  main.failLatch = false;
  for (let i = 0; i < 30 && !main.winPanel; i++) {
    main.winDelay = 0.5; // 手动推进弹窗计时（与 popFailPanel 同口径）
    main.tick();
  }
  assert.ok(main.winPanel, '最后一步通关应弹通关面板');
  assert.ok(!main.failPanel, '不应进失败分支（failPanel 不弹出）');
  assert.ok(!main.failLatch, '不应置失败门闩');
});


console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
