/**
 * 渲染层 + 入口冒烟测试（Node 运行，无需微信开发者工具）
 * 通过 wx / canvas 桩验证：模块加载、触摸交互（选中→倒水→撤回）、绘制主路径不抛错
 */
import assert from 'node:assert';

// ---------- 桩（stub） ----------
const noop = () => {};
const gradient = { addColorStop: noop };
const ctxStub = new Proxy(
  {},
  {
    get(target, prop) {
      if (prop === 'createLinearGradient') return () => gradient;
      if (typeof prop === 'symbol') return undefined;
      return target[prop] !== undefined ? target[prop] : noop;
    },
    set(target, prop, v) {
      target[prop] = v;
      return true;
    },
  }
);
const canvasStub = { width: 0, height: 0, getContext: () => ctxStub };

globalThis.wx = {
  createCanvas: () => canvasStub,
  getSystemInfoSync: () => ({ screenWidth: 375, screenHeight: 812, pixelRatio: 2 }),
  onTouchStart: (fn) => {
    globalThis.__touchHandler = fn;
  },
  setStorageSync: noop,
  getStorageSync: () => '',
};
globalThis.requestAnimationFrame = () => 1; // 不实际循环，由测试手动驱动 tick

const tap = (x, y) => globalThis.__touchHandler({ touches: [{ clientX: x, clientY: y }] });
const center = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

console.log('== 渲染层 + 入口冒烟测试 ==');

const { default: Main } = await import('../js/main.js');
const main = new Main();
const { logic, renderer, anims } = main;

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n      ${err.message}`);
  }
}

check('模块加载 + 关卡载入 + 布局生成', () => {
  assert.ok(logic.bottles.length > 0);
  assert.strictEqual(renderer.bottleRects.length, logic.bottles.length);
});

check('绘制主路径不抛错（含空动画）', () => {
  main.tick();
});

check('触摸：选中瓶 → 高亮选中态', () => {
  const firstNonEmpty = logic.bottles.findIndex((b) => b.length > 0);
  const p = center(renderer.bottleRect(firstNonEmpty));
  tap(p.x, p.y);
  assert.strictEqual(main.selected, firstNonEmpty);
});

check('触摸：合法倒水 → 执行一步（moveCount=1）', () => {
  // 找一个合法目标
  const from = main.selected;
  let target = -1;
  for (let to = 0; to < logic.bottles.length; to++) {
    if (logic.canPour(from, to) > 0) {
      target = to;
      break;
    }
  }
  assert.ok(target >= 0, '当前局面应存在合法目标');
  const before = JSON.stringify(logic.bottles);
  const p = center(renderer.bottleRect(target));
  tap(p.x, p.y);
  assert.strictEqual(logic.moveCount, 1);
  assert.notStrictEqual(JSON.stringify(logic.bottles), before);
  assert.ok(anims.activePour(), '倒水动画应已创建');
});

check('动画推进到结束后动画清除', () => {
  for (let i = 0; i < 60; i++) anims.update(1 / 60);
  assert.ok(!anims.activePour());
  assert.ok(anims.allDone());
});

check('绘制含动画后状态不抛错', () => {
  main.tick();
});

check('触摸：点自己取消选中', () => {
  const firstNonEmpty = logic.bottles.findIndex((b) => b.length > 0);
  const p = center(renderer.bottleRect(firstNonEmpty));
  tap(p.x, p.y);
  tap(p.x, p.y);
  assert.strictEqual(main.selected, -1);
});

check('触摸：非法目标 → 抖动动画 + 选中切换，不执行倒水', () => {
  // 构造：选中一个瓶，再点一个异色非空瓶
  const from = logic.bottles.findIndex((b) => b.length > 0);
  let illegal = -1;
  for (let to = 0; to < logic.bottles.length; to++) {
    if (to !== from && logic.bottles[to].length > 0 && logic.canPour(from, to) === 0) {
      illegal = to;
      break;
    }
  }
  if (illegal < 0) {
    console.log('      (当前局面无非法目标场景，跳过)');
    return;
  }
  const movesBefore = logic.moveCount;
  tap(...Object.values(center(renderer.bottleRect(from))).slice(0, 2));
  tap(center(renderer.bottleRect(illegal)).x, center(renderer.bottleRect(illegal)).y);
  assert.strictEqual(logic.moveCount, movesBefore);
  assert.strictEqual(main.selected, illegal, '应切换选中到该瓶');
});

check('撤回按钮：恢复上一步', () => {
  const movesBefore = logic.moveCount;
  assert.ok(movesBefore > 0, '此前应有倒水记录');
  tap(renderer.undoBtn.x, renderer.undoBtn.y);
  assert.strictEqual(logic.moveCount, movesBefore - 1, '点击撤回按钮应撤销一步');
});

check('重开按钮：关卡重置', () => {
  tap(renderer.restartBtn.x, renderer.restartBtn.y);
  assert.strictEqual(logic.moveCount, 0);
  assert.strictEqual(logic.undoStack.length, 0);
  assert.strictEqual(main.selected, -1);
});

check('完整通关流程：走完一关 → 胜利面板 → 下一关', () => {
  main.loadLevel(0);
  // DFS 求解（直接用逻辑层 API；本测试关注的是胜利面板与关卡切换流程）
  const visited = new Set();
  const key = () => logic.bottles.map((b) => b.join(',')).join('|');
  const dfs = () => {
    if (logic.isWin()) return true;
    const k = key();
    if (visited.has(k)) return false;
    visited.add(k);
    for (let from = 0; from < logic.bottles.length; from++) {
      for (let to = 0; to < logic.bottles.length; to++) {
        if (from === to || logic.canPour(from, to) === 0) continue;
        logic.pour(from, to);
        if (dfs()) return true;
        logic.undo();
      }
    }
    return false;
  };
  assert.ok(dfs(), '第 1 关应可解');
  assert.ok(logic.isWin());

  // 动画落地 → 通关面板弹出
  for (let i = 0; i < 120 && !anims.allDone(); i++) anims.update(1 / 60);
  main.tick();
  main.winDelay = 0.5;
  main.tick();
  assert.ok(main.winPanel, '应弹出胜利面板');

  // 点击「下一关」
  tap(renderer.nextBtn.x + renderer.nextBtn.w / 2, renderer.nextBtn.y + renderer.nextBtn.h / 2);
  assert.strictEqual(main.levelIndex, 1, '应进入第 2 关');
  assert.strictEqual(logic.moveCount, 0, '新关步数应清零');
});

console.log(`\n结果: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed > 0 ? 1 : 0);
