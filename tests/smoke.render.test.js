/**
 * 渲染层 + 入口冒烟测试（Node 运行，无需微信开发者工具）
 * 通过 wx / canvas 桩验证：模块加载、触摸交互（选中→倒水→撤回）、绘制主路径不抛错
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

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

// WebAudio 桩（音效模块用）
const audioNodeStub = () => ({
  connect: noop,
  start: noop,
  stop: noop,
  frequency: { value: 0 },
  gain: { value: 0, setValueAtTime: noop, exponentialRampToValueAtTime: noop },
  buffer: null,
});
const webAudioStub = {
  currentTime: 0,
  sampleRate: 44100,
  destination: {},
  createOscillator: audioNodeStub,
  createGain: audioNodeStub,
  createBufferSource: audioNodeStub,
  createBiquadFilter: audioNodeStub,
  createBuffer: () => ({ getChannelData: () => new Float32Array(100) }),
};

globalThis.wx = {
  createCanvas: () => canvasStub,
  getSystemInfoSync: () => ({ screenWidth: 375, screenHeight: 812, pixelRatio: 2 }),
  onTouchStart: (fn) => {
    globalThis.__touchHandler = fn;
  },
  setStorageSync: noop,
  getStorageSync: () => '',
  removeStorageSync: noop,
  createWebAudioContext: () => webAudioStub,
  // 胶囊按钮位置（顶部安全区计算用）
  getMenuButtonBoundingClientRect: () => ({
    top: 24,
    bottom: 56,
    height: 32,
    left: 281,
    right: 368,
    width: 87,
  }),
  // 模拟代码包文件读取（assets/config/ 下的 .jsonc 配置）
  getFileSystemManager: () => ({
    readFileSync: (path) =>
      readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
  }),
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

check('初始进入菜单场景，菜单绘制不抛错', () => {
  assert.strictEqual(main.scene, 'menu');
  main.tick();
});

check('点击开始 → 关卡选择页（第 1 关可挑战，后续锁定）', () => {
  tap(renderer.menuPlayBtn.x + renderer.menuPlayBtn.w / 2, renderer.menuPlayBtn.y + renderer.menuPlayBtn.h / 2);
  assert.strictEqual(main.scene, 'levelSelect');
  main.tick(); // 绘制关卡选择页不抛错
  assert.strictEqual(renderer.levelBtns.length, 10);
  // 未解锁关卡点击无效
  tap(renderer.levelBtns[1].x + 5, renderer.levelBtns[1].y + 5);
  assert.strictEqual(main.scene, 'levelSelect', '未解锁关卡不应进入');
});

check('选择第 1 关 → 进入游戏，关卡载入 + 布局生成', () => {
  tap(renderer.levelBtns[0].x + 5, renderer.levelBtns[0].y + 5);
  assert.strictEqual(main.scene, 'game');
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

check('道具：打乱 → 液体重排、层集合不变、次数用尽后无效', () => {
  const before = JSON.stringify(logic.bottles);
  const flat = (bs) =>
    bs
      .flat()
      .map((c) => (c >= 0 ? c : -c - 1))
      .sort()
      .join(',');
  tap(renderer.shuffleBtn.x, renderer.shuffleBtn.y);
  assert.strictEqual(main.props.shuffle, 0, '打乱次数应扣减');
  assert.notStrictEqual(JSON.stringify(logic.bottles), before, '局面应重排');
  assert.strictEqual(flat(logic.bottles), flat(JSON.parse(before)), '层集合应不变');
  main.tick(); // 绘制不抛错
  const after = JSON.stringify(logic.bottles);
  tap(renderer.shuffleBtn.x, renderer.shuffleBtn.y);
  assert.strictEqual(JSON.stringify(logic.bottles), after, '次数用尽应无效');
  main.adConfirm = null; // 清理：用尽点击会弹广告确认浮层，后续测试单独覆盖
});

check('道具：加瓶 → 空瓶 +1、布局刷新、次数用尽后无效', () => {
  const n = logic.bottles.length;
  tap(renderer.addBottleBtn.x, renderer.addBottleBtn.y);
  assert.strictEqual(logic.bottles.length, n + 1);
  assert.strictEqual(renderer.bottleRects.length, n + 1, '布局应随瓶数刷新');
  assert.deepStrictEqual(logic.bottles[n], [], '新增瓶应为空');
  main.tick();
  tap(renderer.addBottleBtn.x, renderer.addBottleBtn.y);
  assert.strictEqual(logic.bottles.length, n + 1, '次数用尽应无效');
  main.adConfirm = null; // 清理：用尽点击会弹广告确认浮层，后续测试单独覆盖
});

check('广告补给：道具用尽 → 确认浮层 → 看广告（开发模式直接发放）', () => {
  // 此时打乱/加瓶均已用尽（前两项测试各用掉 1 次）
  assert.strictEqual(main.props.shuffle, 0);
  assert.strictEqual(main.props.addBottle, 0);

  // 点击用尽的打乱按钮 → 弹广告确认浮层（不再直接无效）
  tap(renderer.shuffleBtn.x, renderer.shuffleBtn.y);
  assert.strictEqual(main.adConfirm, 'shuffle', '应弹出广告确认浮层');
  main.tick(); // 绘制浮层不抛错

  // 取消
  tap(renderer.adConfirmCancelBtn.x + 5, renderer.adConfirmCancelBtn.y + 5);
  assert.strictEqual(main.adConfirm, null);
  assert.strictEqual(main.props.shuffle, 0, '取消不应补充');

  // 再点 → 看广告 → 开发模式（无 adUnitId）直接发放
  tap(renderer.shuffleBtn.x, renderer.shuffleBtn.y);
  tap(renderer.adConfirmWatchBtn.x + 5, renderer.adConfirmWatchBtn.y + 5);
  assert.strictEqual(main.adConfirm, null);
  assert.strictEqual(main.props.shuffle, 1, '看广告后应补充 1 次');
  assert.ok(renderer.toast, '应显示补充提示');
});

check('第 4 关（含问号隐藏层）渲染不抛错', () => {
  main.loadLevel(3);
  assert.ok(logic.bottles.some((b) => b.some((c) => c < 0)), '第 4 关应有隐藏层');
  main.tick();
  main.selected = 0;
  main.tick();
  main.selected = -1;
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
  assert.strictEqual(main.cleared, 1, '通关第 1 关后解锁进度应为 1');
  assert.strictEqual(logic.moveCount, 0, '新关步数应清零');
});

check('左上角返回按钮 → 暂停浮层（继续 / 退出）', () => {
  tap(renderer.backBtn.x, renderer.backBtn.y);
  assert.ok(main.pauseOverlay, '应弹出暂停浮层');
  main.tick(); // 绘制浮层不抛错
  // 浮层期间点击瓶子无效
  tap(200, 500);
  assert.strictEqual(logic.moveCount, 0);
  // 继续游戏
  tap(renderer.pauseResumeBtn.x + 5, renderer.pauseResumeBtn.y + 5);
  assert.ok(!main.pauseOverlay);
});

check('退出 → 返回开始菜单（进度保留）→ 设置 → 重置进度 → 重新开始', () => {
  tap(renderer.backBtn.x, renderer.backBtn.y);
  tap(renderer.pauseExitBtn.x + 5, renderer.pauseExitBtn.y + 5);
  assert.strictEqual(main.scene, 'menu', '应返回开始菜单');
  assert.strictEqual(main.levelIndex, 1, '进度应保留');
  main.tick(); // 菜单绘制不抛错

  // 设置页
  tap(renderer.menuSettingsBtn.x + 5, renderer.menuSettingsBtn.y + 5);
  assert.strictEqual(main.scene, 'settings');
  main.tick(); // 设置页绘制不抛错

  // 音效开关切换（默认开 → 关 → 开）
  assert.strictEqual(main.soundOn, true);
  tap(renderer.settingsSoundToggle.x + 5, renderer.settingsSoundToggle.y + 5);
  assert.strictEqual(main.soundOn, false);
  main.tick(); // 绘制开关状态不抛错
  tap(renderer.settingsSoundToggle.x + 5, renderer.settingsSoundToggle.y + 5);
  assert.strictEqual(main.soundOn, true);

  tap(renderer.settingsResetBtn.x + 5, renderer.settingsResetBtn.y + 5);
  assert.strictEqual(main.cleared, 0, '重置后解锁进度应为 0');
  assert.ok(renderer.toast, '应显示重置提示');

  // 返回菜单 → 开始 → 关卡选择 → 第 1 关
  tap(renderer.backBtn.x, renderer.backBtn.y);
  assert.strictEqual(main.scene, 'menu');
  tap(renderer.menuPlayBtn.x + 5, renderer.menuPlayBtn.y + 5);
  assert.strictEqual(main.scene, 'levelSelect');
  tap(renderer.levelBtns[0].x + 5, renderer.levelBtns[0].y + 5);
  assert.strictEqual(main.scene, 'game');
  assert.strictEqual(main.levelIndex, 0);
  assert.strictEqual(main.cleared, 0, '重置后解锁进度应为 0');
  assert.strictEqual(logic.moveCount, 0);
});

console.log(`\n结果: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed > 0 ? 1 : 0);
