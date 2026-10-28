/**
 * 渲染层 + 入口冒烟测试（Node 运行，无需微信开发者工具）
 * 通过 wx / canvas 桩验证：模块加载、触摸交互（选中→倒水→撤回）、绘制主路径不抛错
 * ▶ 何时跑我：改 renderer.js 任何视觉/布局/按钮、main.js 交互与浮层（tap/面板/广告）——UI 兜底，发布前必跑
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// ---------- 桩（stub） ----------
const noop = () => {};
const gradient = { addColorStop: noop };
// fillText 记录（AC-11 胜利面板文案 / AC-12 引导浮层文案断言用）
globalThis.__fillTexts = [];
const ctxStub = new Proxy(
  {},
  {
    get(target, prop) {
      if (prop === 'createLinearGradient') return () => gradient;
      if (prop === 'createRadialGradient') return () => gradient;
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
    globalThis.__ts = fn;
  },
  onTouchMove: (fn) => {
    globalThis.__tm = fn;
  },
  onTouchEnd: (fn) => {
    globalThis.__te = fn;
  },
  onTouchCancel: (fn) => {
    globalThis.__tc = fn;
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

// 点击 = start + end（位移小于阈值，end 派发 onTap）
const tap = (x, y) => {
  globalThis.__ts({ touches: [{ clientX: x, clientY: y }] });
  globalThis.__te({ changedTouches: [{ clientX: x, clientY: y }] });
};
// 拖动 = start + 越阈值 move + end（不派发点击，驱动关卡选择页滚动）
const drag = (x, y0, y1) => {
  globalThis.__ts({ touches: [{ clientX: x, clientY: y0 }] });
  globalThis.__tm({ touches: [{ clientX: x, clientY: y0 - 20 }] });
  globalThis.__tm({ touches: [{ clientX: x, clientY: y1 }] });
  globalThis.__te({ changedTouches: [{ clientX: x, clientY: y1 }] });
};
const center = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

console.log('== 渲染层 + 入口冒烟测试 ==');

const { default: Main } = await import('../js/main.js');
const { COLORS } = await import('../js/core/levels.js');
const { BOTTLE_ASPECT } = await import('../js/render/renderer.js');
const main = new Main();
const { logic, renderer, anims } = main;

// 驱动 loading 场景至进局（PRD-关卡生成异步化：进关/下一关/重开均分帧生成，冒烟一次性喂满）
const finishLoading = () => {
  let n = 0;
  while (main.scene === 'loading' && n++ < 100000) main.stepLoading();
  assert.strictEqual(main.scene, 'game', 'loading 应在有限步内完成');
};

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
  assert.strictEqual(renderer.levelBtns.length, 100);
  assert.strictEqual(renderer.levelCount, 100);
  // 未解锁关卡点击无效
  tap(renderer.levelBtns[1].x + 5, renderer.levelBtns[1].y + 5);
  assert.strictEqual(main.scene, 'levelSelect', '未解锁关卡不应进入');
});

check('选择第 1 关 → 进入游戏，关卡载入 + 布局生成', () => {
  tap(renderer.levelBtns[0].x + 5, renderer.levelBtns[0].y + 5);
  finishLoading(); // 进关走 loading 分帧生成（PRD-关卡生成异步化）
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
  finishLoading(); // 重开走 loading 分帧生成（PRD-关卡生成异步化）
  assert.strictEqual(logic.moveCount, 0);
  assert.strictEqual(logic.undoStack.length, 0);
  assert.strictEqual(main.selected, -1);
});

check('loading 场景：进关先入 loading、进度推进、触摸吞掉、完成后切 game（AC-04）', () => {
  main.cleared = 5;
  main.selectLevel(4); // L5 慢关概率低，任意关即可
  assert.strictEqual(main.scene, 'loading', 'selectLevel 后应先进 loading');
  assert.ok(main.logic.genProgress() && main.logic.genProgress().pending, '生成会话应进行中');
  // 喂两帧小预算：loading 期绘制不抛错 + 点击被吞（无场景跳转）
  main.stepLoading();
  main.stepLoading();
  main.tick(); // 绘制 loading 页（含位图进度条路径）
  const sceneBefore = main.scene;
  tap(renderer.menuPlayBtn.x, renderer.menuPlayBtn.y); // 任意点击，loading 应吞掉
  assert.strictEqual(main.scene, sceneBefore, 'loading 期触摸应被吞掉');
  // 喂满完成
  finishLoading();
  assert.strictEqual(main.scene, 'game');
  assert.strictEqual(main.levelIndex, 4);
  assert.ok(logic.bottles.length > 0, '生成完成后局面应就绪');
  // 首帧只画不推进（用户拍板：所有关卡都渲染 loading）：tick 后仍在 loading，快关也不跳帧
  main.cleared = 6;
  main.selectLevel(5);
  main.tick();
  assert.strictEqual(main.scene, 'loading', '首帧应只渲染 loading 不推进生成');
  finishLoading();
});

check('道具：打乱 → 选瓶模式 → 点瓶打乱、层集合不变、次数用尽后无效', () => {
  const before = JSON.stringify(logic.bottles);
  const flat = (bs) =>
    bs
      .flat()
      .map((c) => (c >= 0 ? c : -c - 1))
      .sort()
      .join(',');
  tap(renderer.shuffleBtn.x, renderer.shuffleBtn.y);
  assert.strictEqual(main.shuffleSelecting, true, '应进入选瓶模式');
  main.tick(); // 绘制选瓶提示不抛错
  // 选择一个多色瓶执行打乱
  const idx = logic.bottles.findIndex(
    (b) => new Set(b.map((c) => (c >= 0 ? c : -c - 1))).size > 1
  );
  assert.ok(idx >= 0, '应存在多色瓶');
  const p = center(renderer.bottleRect(idx));
  tap(p.x, p.y);
  assert.strictEqual(main.inv.shuffle, 1, '打乱应消耗背包 1 个（L1 首入赠 1 + 初始 1 - 用 1 = 1）');
  assert.strictEqual(main.shuffleSelecting, false, '打乱成功后应退出选瓶模式');
  assert.notStrictEqual(JSON.stringify(logic.bottles), before, '该瓶层序应变化');
  assert.strictEqual(flat(logic.bottles), flat(JSON.parse(before)), '层集合应不变');
  main.tick(); // 绘制不抛错
  const after = JSON.stringify(logic.bottles);
  main.inv.shuffle = 0; // 模拟库存耗尽
  tap(renderer.shuffleBtn.x, renderer.shuffleBtn.y); // 次数用尽 → 广告确认浮层
  assert.strictEqual(main.adConfirm, 'shuffle', '次数用尽应弹广告确认浮层');
  main.adConfirm = null; // 清理：广告补给流程由后续测试单独覆盖
  assert.strictEqual(JSON.stringify(logic.bottles), after, '未执行打乱，局面不变');
});

check('道具：加瓶 → 空瓶 +1、布局刷新、次数用尽后无效', () => {
  const n = logic.bottles.length;
  tap(renderer.addBottleBtn.x, renderer.addBottleBtn.y);
  assert.strictEqual(logic.bottles.length, n + 1);
  assert.strictEqual(renderer.bottleRects.length, n + 1, '布局应随瓶数刷新');
  assert.deepStrictEqual(logic.bottles[n], [], '新增瓶应为空');
  assert.strictEqual(main.inv.addBottle, 1, '加瓶应消耗背包 1 个（L1 首入赠 1 + 初始 1 - 用 1 = 1）');
  main.tick();
  main.inv.addBottle = 0; // 模拟库存耗尽
  tap(renderer.addBottleBtn.x, renderer.addBottleBtn.y);
  assert.strictEqual(logic.bottles.length, n + 1, '次数用尽应无效');
  main.adConfirm = null; // 清理：用尽点击会弹广告确认浮层，后续测试单独覆盖
});

check('广告补给：道具用尽 → 确认浮层 → 看广告（开发模式直接发放）', () => {
  // 此时打乱/加瓶均已用尽（前两项测试用掉并归零）
  assert.strictEqual(main.inv.shuffle, 0);
  assert.strictEqual(main.inv.addBottle, 0);

  // 点击用尽的打乱按钮 → 弹广告确认浮层（不再直接无效）
  tap(renderer.shuffleBtn.x, renderer.shuffleBtn.y);
  assert.strictEqual(main.adConfirm, 'shuffle', '应弹出广告确认浮层');
  main.tick(); // 绘制浮层不抛错

  // 取消
  tap(renderer.adConfirmCancelBtn.x + 5, renderer.adConfirmCancelBtn.y + 5);
  assert.strictEqual(main.adConfirm, null);
  assert.strictEqual(main.inv.shuffle, 0, '取消不应补充');

  // 再点 → 看广告 → 开发模式（无 adUnitId）直接发放
  tap(renderer.shuffleBtn.x, renderer.shuffleBtn.y);
  tap(renderer.adConfirmWatchBtn.x + 5, renderer.adConfirmWatchBtn.y + 5);
  assert.strictEqual(main.adConfirm, null);
  assert.strictEqual(main.inv.shuffle, 1, '看广告后应补充 1 次');
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

check('F-04：道具出厂废除 + 首入赠送一次性 + 撤销道具化（背包链路）', () => {
  const invBefore = { ...main.inv };
  main.loadLevel(8); // L9：无 grant，进关不改变背包（出厂已废除）
  assert.deepStrictEqual(main.inv, invBefore, '出厂废除：进关不应重置背包');
  main.tick();

  // L11（index 10）章首关首入发放：shuffle / addBottle 各 +1
  main.loadLevel(10);
  assert.strictEqual(main.inv.shuffle, invBefore.shuffle + 1, 'L11 首入应 +1 打乱');
  assert.strictEqual(main.inv.addBottle, invBefore.addBottle + 1, 'L11 首入应 +1 加瓶');
  main.tick();
  main.loadLevel(10);
  assert.strictEqual(main.inv.shuffle, invBefore.shuffle + 1, '二次进入不应重复发放');
  assert.strictEqual(main.inv.addBottle, invBefore.addBottle + 1, '二次进入不应重复发放');
  main.tick();

  // 首进特殊关弹引导浮层（浮层期间屏蔽其他输入）：先点「开始挑战」关闭
  main.loadLevel(9); // L10 特殊关
  assert.ok(main.bigIntro, '首进特殊关应弹引导浮层');
  main.tick();
  tap(renderer.bigIntroBtn.x + renderer.bigIntroBtn.w / 2, renderer.bigIntroBtn.y + renderer.bigIntroBtn.h / 2);
  assert.ok(!main.bigIntro, '点击「开始挑战」应关闭浮层');
  main.tick();

  // 撤销道具化：库存 0 且有步可撤 → 点撤回弹广告确认浮层 → 看广告 +1 可继续用
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
  assert.ok(src >= 0, 'L10 开局应存在合法倒法');
  logic.pour(src, to);
  main.inv.undo = 0; // 模拟撤回库存耗尽
  tap(renderer.undoBtn.x, renderer.undoBtn.y);
  assert.strictEqual(main.adConfirm, 'undo', '撤回耗尽应弹广告确认浮层');
  main.tick(); // 浮层绘制不抛错
  tap(renderer.adConfirmWatchBtn.x + 5, renderer.adConfirmWatchBtn.y + 5);
  assert.strictEqual(main.adConfirm, null);
  assert.strictEqual(main.inv.undo, 1, '看广告后应补充 1 次撤回');
});

function assertBottlesInSafeArea() {
  for (const r of renderer.bottleRects) {
    assert.ok(r.x >= 0 && r.x + r.w <= renderer.W, `瓶横向越界 x=${r.x} w=${r.w}`);
    assert.ok(r.y >= 230, `瓶顶越界 y=${r.y}`);
    assert.ok(r.y + r.h <= renderer.H - 110, `瓶底越界 y+h=${r.y + r.h}`);
  }
}

check('AC-09：容量自适应渲染（cap=3/5/8、无图片资源矢量降级）不抛错、瓶高在画布安全区内', () => {
  main.loadLevel(20); // L21 容量 3（L20 已改为特殊关）
  assert.strictEqual(logic.capacity, 3);
  assert.strictEqual(renderer.capacity, 3);
  main.tick();
  assertBottlesInSafeArea();
  main.selected = 0;
  main.tick();
  main.selected = -1;

  main.loadLevel(23); // 第 24 关容量 5（重排后 cap5 首秀，原 L22）
  assert.strictEqual(renderer.capacity, 5);
  main.tick();
  assertBottlesInSafeArea();

  renderer.setupBoard(10, 8); // 容量 8 上限（曲线无此关，手工验证布局）
  main.tick();
  assertBottlesInSafeArea();
});

check('AC-09：第 26 关（原 L24）条件锁渲染不抛错、锁定瓶点击为抖动反馈不选中', () => {
  main.loadLevel(25);
  assert.ok(logic.locks.some((l) => l.type === 'cond'));
  main.tick(); // 锁形角标 + 进度文本矢量绘制
  const locked = logic.locks.find((l) => l.type === 'cond').bottle;
  const p = center(renderer.bottleRect(locked));
  tap(p.x, p.y);
  assert.strictEqual(main.selected, -1, '锁定瓶不应被选中');
  assert.ok(anims.shakeOffset(locked) !== 0 || anims.list.some((a) => a.type === 'shake'), '应有抖动反馈');
});

check('AC-09：L27 钥匙锁渲染不抛错（钥匙层角标矢量降级）', () => {
  main.loadLevel(26);
  const keyLock = logic.locks.find((l) => l.type === 'key');
  assert.ok(keyLock);
  assert.ok(logic.bottles[keyLock.bottle].length > 0, '钥匙锁瓶应为内容瓶（Q4=B）');
  main.tick(); // 钥匙锁瓶角标 + 钥匙层角标绘制
  const selectable = logic.bottles.findIndex((b, i) => b.length > 0 && !logic.isLocked(i));
  main.selected = selectable;
  main.tick();
  main.selected = -1;
});

check('AC-09：L28 双锁 + L29 无空瓶开局 + L30 终局特殊关（cap5+big8 大瓶）渲染不抛错', () => {
  main.loadLevel(27); // L28：9 瓶 = 8 内容 + 1 空（条件锁与钥匙锁均锁在既有内容瓶上）
  assert.strictEqual(logic.bottles.length, 9);
  assert.ok(logic.locks.some((l) => l.type === 'cond') && logic.locks.some((l) => l.type === 'key'));
  main.tick();
  assertBottlesInSafeArea();

  main.loadLevel(28); // L29 scattered
  assert.strictEqual(logic.bottles.length, 8);
  assert.ok(logic.bottles.every((b) => b.length >= 2), '无空瓶开局每瓶应有内容');
  main.tick();

  main.loadLevel(29); // L30 终局特殊关：cap5 + big8，7 内容 + 2 空 + 1 大瓶
  assert.strictEqual(logic.bottles.length, 10);
  assert.strictEqual(logic.capacity, 5);
  assert.strictEqual(logic.special, 'bigBottle');
  assert.strictEqual(logic.locks.length, 0, '特殊关无锁');
  main.tick(); // 引导已读（前述用例已关闭），不再弹出
  assert.ok(!main.bigIntro, '已读后二次进入特殊关不应再弹引导');
  assertBottlesInSafeArea();
});

// ---------- 特殊关（大瓶收集）冒烟：AC-09 渲染 / AC-10 触摸 / AC-11 胜利文案 / AC-12 引导浮层 ----------

const fastForward = () => {
  for (let i = 0; i < 90 && !anims.allDone(); i++) anims.update(1 / 60);
};

check(`特殊关 AC-09/AC-13 前置：L10 大瓶渲染 —— 居中、瓶形比例 1:${BOTTLE_ASPECT}、预置限定色层、安全区无重叠、矢量降级绘制不抛错`, () => {
  main.loadLevel(9); // L10 特殊关
  main.tick();
  assert.ok(!main.bigIntro, '引导已读，直接进入棋盘');
  assert.ok(logic.bigColor >= 0, '大瓶应有瓶口限定色');
  assert.deepStrictEqual(logic.bottles[logic.bigIndex], [logic.bigColor], '大瓶开局应预置 1 层限定色');
  const bigRect = renderer.bottleRects[logic.bigIndex];
  const normalRect = renderer.bottleRects.find((r, i) => i !== logic.bigIndex);
  assert.ok(bigRect && normalRect, '应存在大瓶与普通瓶布局');
  assert.ok(
    Math.abs(bigRect.w / bigRect.h - 1 / BOTTLE_ASPECT) < 0.03,
    `大瓶应保持瓶形比例 1:${BOTTLE_ASPECT}（实际 ${(bigRect.w / bigRect.h).toFixed(3)}）`
  );
  assert.ok(Math.abs(bigRect.x + bigRect.w / 2 - renderer.W / 2) < 1, '大瓶应水平居中');
  assert.ok(bigRect.h > normalRect.h, 'bigCapacity 8 大瓶应高于 cap4 普通瓶');
  assertBottlesInSafeArea();
  main.selected = logic.bigIndex; // 大瓶选中态描边（宽度放大）绘制不抛错
  main.tick();
  main.selected = -1;
  main.tick();
});

check('特殊关 AC-10：大瓶触摸 —— 命中覆盖全宽；普通瓶→大瓶倒水、大瓶→普通瓶倒出与普通瓶一致', () => {
  main.loadLevel(9);
  main.tick();
  const big = logic.bigIndex;
  const bigRect = renderer.bottleRects[big];
  // 命中区域覆盖大瓶全部可见宽度（左右边缘内侧均可命中）
  const cy = bigRect.y + bigRect.h / 2;
  assert.strictEqual(renderer.getBottleAt(bigRect.x + 2, cy, logic), big, '大瓶左缘应可命中');
  assert.strictEqual(renderer.getBottleAt(bigRect.x + bigRect.w - 2, cy, logic), big, '大瓶右缘应可命中');
  // 普通瓶 → 大瓶（点选源瓶 → 点大瓶）
  let src = -1;
  for (let i = 0; i < logic.bottles.length; i++) {
    if (i !== big && logic.bottles[i].length > 0 && logic.canPour(i, big) > 0) {
      src = i;
      break;
    }
  }
  assert.ok(src >= 0, '开局应有可倒入大瓶的普通瓶');
  const sp = center(renderer.bottleRect(src));
  tap(sp.x, sp.y);
  assert.strictEqual(main.selected, src);
  tap(bigRect.x + bigRect.w / 2, cy);
  assert.strictEqual(logic.moveCount, 1, '点击大瓶应完成倒水');
  assert.ok(logic.bottles[big].length > 0, '大瓶应已接收液体');
  fastForward(); // 倒水动画落地后再操作
  // 大瓶只进不出（2026-10-28 规则修正）：点选大瓶 → 点空瓶，倒水应被拒绝
  const bigBefore = logic.bottles[big].slice();
  tap(bigRect.x + bigRect.w / 2, cy);
  assert.strictEqual(main.selected, big, '非空大瓶仍可被选中（用于提示不可倒出）');
  const emptyIdx = logic.bottles.findIndex((b, i) => i !== big && b.length === 0);
  assert.ok(emptyIdx >= 0, '特殊关应有空瓶');
  const ep = center(renderer.bottleRect(emptyIdx));
  tap(ep.x, ep.y);
  assert.strictEqual(logic.moveCount, 1, '从大瓶倒出应被拒绝（moveCount 不变）');
  assert.deepStrictEqual(logic.bottles[big], bigBefore, '大瓶内容不变');
  main.selected = -1;
  // 撤回一步完整恢复（撤销道具化：背包需备足 undo 存量）
  main.inv.undo = Math.max(main.inv.undo, 2);
  tap(renderer.undoBtn.x, renderer.undoBtn.y);
  assert.strictEqual(logic.moveCount, 0);
  assert.deepStrictEqual(logic.bottles[big], [logic.bigColor], '撤回后大瓶应恢复为仅含预置层');
});

check('特殊关 AC-11：通关胜利面板文案「集齐 X 色，收集完成！」', () => {
  main.loadLevel(9);
  main.tick();
  // DFS 走通（启发式 + 规范化状态 key，与 game.test.js solveVerify 同源）
  const visited = new Set();
  const bigIdx = logic.bigIndex;
  let nodes = 0;
  const key = () => {
    const free = [];
    const fixed = [];
    for (let i = 0; i < logic.bottles.length; i++) {
      const s = logic.bottles[i].join(',');
      if (i === bigIdx) fixed.push('B' + s);
      else free.push(s);
    }
    return free.sort().join('|') + '#' + fixed.join('|');
  };
  const dfs = () => {
    if (logic.isWin()) return true;
    if (nodes++ > 150000) return false;
    const k = key();
    if (visited.has(k)) return false;
    visited.add(k);
    const moves = [];
    for (let from = 0; from < logic.bottles.length; from++) {
      for (let to = 0; to < logic.bottles.length; to++) {
        if (from === to) continue;
        const amount = logic.canPour(from, to);
        if (!amount) continue;
        const f = logic.bottles[from];
        const t = logic.bottles[to];
        let score;
        if (to === bigIdx) score = t.length ? 500 + t.length : 300;
        else if (t.length) {
          let tr = 1;
          for (let i = t.length - 2; i >= 0 && t[i] === t[t.length - 1]; i--) tr++;
          score = tr === t.length && t.length + amount === logic.capOf(to) ? 600 : 100 + tr;
        } else score = 10;
        if (amount === f.length) score += 200;
        moves.push({ from, to, score });
      }
    }
    moves.sort((a, b) => b.score - a.score);
    for (const m of moves) {
      logic.pour(m.from, m.to);
      if (dfs()) return true;
      logic.undo();
    }
    return false;
  };
  assert.ok(dfs(), 'L10 特殊关应可 DFS 走通');
  assert.ok(logic.isWin());
  fastForward();
  main.winDelay = 0.5;
  main.tick();
  assert.ok(main.winPanel, '应弹出胜利面板');
  globalThis.__fillTexts.length = 0;
  main.tick(); // 绘制胜利面板
  const title = globalThis.__fillTexts.find((t) => t.includes('集齐'));
  assert.ok(title, '胜利面板标题应含「集齐」');
  const targetName = COLORS[logic.bottles[logic.bigIndex][0]].name;
  assert.ok(title.includes(targetName), `文案应含目标色名「${targetName}」（实际：${title}）`);
  assert.ok(title.includes('收集完成'), '文案应以「收集完成！」结尾');
  // 清理现场，避免影响后续用例的 cleared 断言
  main.winPanel = false;
  main.cleared = 0;
  main.winDelay = 0;
});

check('特殊关 AC-12：首进引导浮层 —— 首次弹出、点「开始挑战」关闭、二次进入不弹、重置进度后再弹', () => {
  main.bigIntroShown = false; // 模拟本机首次
  main.loadLevel(9);
  assert.ok(main.bigIntro, '首次进入特殊关应弹引导浮层');
  globalThis.__fillTexts.length = 0;
  main.tick(); // 浮层绘制不抛错（矢量示意瓶 + 文案）
  const texts = globalThis.__fillTexts.join('\n');
  assert.ok(texts.includes('特殊订单！'), '浮层标题应为「特殊订单！」');
  assert.ok(texts.includes('限定色') && texts.includes('大瓶'), '正文应说明大瓶玩法与预置限定色');
  assert.ok(texts.includes('开始挑战'), '按钮文案应为「开始挑战」');
  const b = renderer.bigIntroBtn;
  tap(b.x + b.w / 2, b.y + b.h / 2);
  assert.ok(!main.bigIntro, '点击「开始挑战」应关闭浮层');
  assert.ok(main.bigIntroShown, '应记住已读标志');
  main.loadLevel(9);
  assert.ok(!main.bigIntro, '二次进入不应再弹');
  main.resetProgress(); // 重置进度 → 引导标志一并重置
  assert.strictEqual(main.bigIntroShown, false, '重置进度应重置引导标志');
  main.loadLevel(9);
  assert.ok(main.bigIntro, '重置进度后再次进入应重新弹出');
  // 清理现场
  main.bigIntro = false;
  main.bigIntroShown = true;
  main.winPanel = false;
});

check('AC-10：关卡选择页 100 卡自适应列数 + 竖向滚动，返回键固定，重进复位', () => {
  main.scene = 'menu';
  tap(renderer.menuPlayBtn.x + 5, renderer.menuPlayBtn.y + 5);
  assert.strictEqual(main.scene, 'levelSelect');
  main.tick();
  assert.strictEqual(renderer.levelBtns.length, 100);
  assert.ok(renderer.levelScrollMax > 0, '100 关内容应超出可视高度（需滚动）');
  assert.strictEqual(renderer.levelScroll, 0);

  // 手指上拖 → 滚动偏移增加并 clamp，第 30 关卡片进入可视区
  drag(renderer.W / 2, 500, 150);
  assert.ok(renderer.levelScroll > 0, '拖动应产生滚动偏移');
  assert.ok(renderer.levelScroll <= renderer.levelScrollMax, '滚动应 clamp 在上限内');
  main.tick(); // 滚动后绘制不抛错
  const last = renderer.levelBtns[29];
  assert.ok(last.y < renderer.H && last.y + last.h > 0, '第 30 关卡片应可滚动至可视区');

  // 连续上拖到最底：第 100 关卡片应进入可视区（100 关滚动表现，F-04）
  for (let k = 0; k < 6; k++) drag(renderer.W / 2, 600, 100);
  main.tick();
  const card100 = renderer.levelBtns[99];
  assert.ok(renderer.levelScroll === renderer.levelScrollMax, '应可滚动至底部');
  assert.ok(card100.y < renderer.H && card100.y + card100.h > 0, '第 100 关卡片应可滚动至可视区');

  // 下拖回顶 + 返回按钮固定（不随滚动）
  drag(renderer.W / 2, 150, 700);
  tap(renderer.backBtn.x, renderer.backBtn.y);
  assert.strictEqual(main.scene, 'menu', '返回按钮应固定可用');

  // 重新进入选择页：滚动复位
  tap(renderer.menuPlayBtn.x + 5, renderer.menuPlayBtn.y + 5);
  assert.strictEqual(main.scene, 'levelSelect');
  assert.strictEqual(renderer.levelScroll, 0, '重进选择页滚动应复位');
  main.scene = 'menu'; // 恢复现场
});

check('AC-12：旧进度 cleared=8 语义 —— 第 9 关可挑战、第 10 关锁定（100 关下语义不变）', () => {
  const savedCleared = main.cleared;
  main.cleared = 8;
  assert.strictEqual(renderer.levelCount, 100);
  // 第 9 关（index 8）可挑战：直接以触摸链路进入
  main.scene = 'levelSelect';
  main.tick();
  const card9 = renderer.levelBtns[8];
  tap(card9.x + 5, card9.y + 5);
  finishLoading();
  assert.strictEqual(main.scene, 'game');
  assert.strictEqual(main.levelIndex, 8, 'cleared=8 应可挑战第 9 关');
  // 第 10 关（index 9）锁定
  main.scene = 'levelSelect';
  assert.ok(!main.selectLevel(9) && main.scene === 'levelSelect', '第 10 关应锁定');
  main.cleared = savedCleared; // 恢复现场（后续测试自行驱动通关流程）
  main.scene = 'game';
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
  finishLoading();
  assert.strictEqual(main.levelIndex, 1, '应进入第 2 关');
  assert.strictEqual(main.cleared, 1, '通关第 1 关后解锁进度应为 1');
  assert.strictEqual(logic.moveCount, 0, '新关步数应清零');
});

check('通关面板双按钮（方案 A）：主按钮「下一关」+ 副按钮「返回」回主菜单', () => {
  main.loadLevel(0);
  // DFS 求解（直接用逻辑层 API，聚焦面板交互）
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
  for (let i = 0; i < 120 && !anims.allDone(); i++) anims.update(1 / 60);
  main.tick();
  main.winDelay = 0.5;
  main.tick();
  assert.ok(main.winPanel, '应弹出胜利面板');

  // 绘制一次：面板应同时含主按钮与副按钮文案
  globalThis.__fillTexts.length = 0;
  main.tick();
  const texts = globalThis.__fillTexts.join('\n');
  assert.ok(texts.includes('下一关'), '非末关主按钮应为「下一关」');
  assert.ok(texts.includes('返回'), '副按钮应为「返回」');

  // 点「返回」→ 回主菜单，面板关闭
  const b = renderer.winBackBtn;
  tap(b.x + b.w / 2, b.y + b.h / 2);
  assert.strictEqual(main.scene, 'menu', '点「返回」应回到主菜单');
  assert.ok(!main.winPanel, '胜利面板应关闭');
  assert.strictEqual(main.cleared, 1, '返回不清除通关进度');

  // 恢复现场（与前置「完整通关流程」用例结束时一致：levelIndex=1），避免影响后续用例
  main.scene = 'game';
  main.loadLevel(1);
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
  finishLoading(); // 进关走 loading 分帧生成（PRD-关卡生成异步化）
  assert.strictEqual(main.scene, 'game');
  assert.strictEqual(main.levelIndex, 0);
  assert.strictEqual(main.cleared, 0, '重置后解锁进度应为 0');
  assert.strictEqual(logic.moveCount, 0);
});

check('设置页兑换码输入：unlock_all 解锁全部关卡、无效码提示、重置可恢复', () => {
  // 菜单 → 设置
  main.scene = 'menu';
  tap(renderer.menuSettingsBtn.x + 5, renderer.menuSettingsBtn.y + 5);
  assert.strictEqual(main.scene, 'settings');
  main.tick(); // 含兑换码按钮的设置页绘制不抛错

  // 无弹窗 API 环境：点击兑换码按钮降级为提示，不抛错
  tap(renderer.settingsKeyBtn.x + 5, renderer.settingsKeyBtn.y + 5);
  assert.ok(renderer.toast, '无弹窗环境应显示降级提示');

  // unlock_all（大小写不敏感、容忍空格）→ 解锁全部关卡
  main.applyKey('  Unlock_All ');
  assert.strictEqual(main.cleared, 100, 'unlock_all 应解锁全部 100 关');
  assert.ok(renderer.toast && renderer.toast.text.includes('100'), '应提示已解锁全部关卡');

  // 解锁后第 100 关可进入（unlock_all 的验收目的）
  main.scene = 'levelSelect';
  main.tick();
  main.selectLevel(99);
  finishLoading();
  assert.strictEqual(main.scene, 'game', 'unlock_all 后第 100 关应可挑战');
  assert.strictEqual(main.levelIndex, 99);
  main.scene = 'settings';

  // 无效兑换码 → 提示且进度不变
  main.applyKey('GM');
  assert.strictEqual(main.cleared, 100, '无效码不应改变进度');
  assert.ok(renderer.toast && renderer.toast.text === '兑换码无效');

  // 空输入 → 不提示不变化
  renderer.toast = null;
  main.applyKey('   ');
  assert.strictEqual(renderer.toast, null, '空输入应被忽略');

  // 重置进度恢复现场（供后续验收不受影响）
  main.applyKey('unlock_all'); // 确认解锁后再重置，覆盖"unlock_all→重置"链路
  tap(renderer.settingsResetBtn.x + 5, renderer.settingsResetBtn.y + 5);
  assert.strictEqual(main.cleared, 0, '重置后进度应归零');
  main.scene = 'menu';
});

check('混合容量关渲染：第 11 关（原 L26）底对齐、瓶高 ∝ 容量、安全区、绘制不抛错、触摸命中按实际 rect（PRD-混合容量瓶 AC-7/8）', () => {
  main.loadLevel(10); // 第 11 关混合首秀（重排后）
  main.scene = 'game'; // loadLevel 不切场景（与既有用例同口径）
  main.tick();
  assert.ok(logic.mix, '应为混合关');
  assert.strictEqual(logic.caps.length, logic.bottles.length, 'caps 与 bottles 平行');
  assert.ok(logic.caps.some((c) => c !== logic.capacity), '容量应存在 3~5 混合');

  const aspectFloor = 1.6; // 混合关瓶形下限（与 renderer BOTTLE_ASPECT_FLOOR 同口径）
  const capFloor = Math.min(logic.capacity, ...logic.caps); // 层厚下限口径（最矮瓶形不矮于下限比例）
  for (let i = 0; i < logic.bottles.length; i++) {
    const r = renderer.bottleRects[i];
    assert.ok(r && r.h > 0, `瓶 ${i} 应有布局`);
    // 同宽 + 瓶高 ∝ 容量（统一层厚，测试桩无贴图截距 k=0）
    assert.ok(Math.abs(r.h / r.w - (aspectFloor * logic.caps[i]) / capFloor) < 0.4, `瓶 ${i} 高宽比应 ∝ 容量`);
    assert.strictEqual(logic.bottles[i].length <= logic.caps[i], true, `瓶 ${i} 层数不超容量`);
  }
  // 行内近似底对齐：散布纵向抖动 ±22px（F-散布布局），排内瓶底差 ≤ 44px
  const n = logic.bottles.length;
  const cols = Math.max(2, Math.ceil(n / 2));
  for (let r = 0; r * cols < n; r++) {
    let bottom = null;
    for (let c = 0; c < cols && r * cols + c < n; c++) {
      const rect = renderer.bottleRects[r * cols + c];
      const b = rect.y + rect.h;
      if (bottom === null) bottom = b;
      else assert.ok(Math.abs(b - bottom) <= 44, `第 ${r} 排应近似底对齐（差 ${Math.abs(b - bottom)}px）`);
    }
  }
  // 散布可复现：同 seed 重新布局 → rect 完全一致
  {
    const snapshot = JSON.stringify(renderer.bottleRects);
    main.refreshBoard();
    assert.strictEqual(JSON.stringify(renderer.bottleRects), snapshot, '散布布局应随 seed 复现');
  }
  // 层厚全局一致：测试桩无贴图（截距补偿 k=0），层高 = 瓶高 / 容量，跨容量必须相等
  // （真机口径：瓶高 = 容量×层厚 + 截距C，液体内高 ∝ 容量，同归此断言意图）
  {
    const layerHs = logic.caps.map((c, i) => renderer.bottleRects[i].h / c);
    const spread = Math.max(...layerHs) - Math.min(...layerHs);
    assert.ok(spread < 0.5, `混合关各瓶层厚应一致（最大差 ${spread.toFixed(2)}px）`);
  }
  assertBottlesInSafeArea();
  main.tick(); // 绘制主路径不抛错

  // 触摸命中按实际 rect：点第一个非空瓶选中
  let target = -1;
  for (let i = 0; i < n; i++) {
    if (logic.bottles[i].length > 0) { target = i; break; }
  }
  const p = center(renderer.bottleRect(target));
  tap(p.x, p.y);
  assert.strictEqual(main.selected, target, '混合关触摸应按实际 rect 命中');
  main.selected = -1;
});

check('满瓶完成徽章链：满色瓶停留 ✓ 徽章 → 徽章结束后才起飞货架', () => {  // 进入 L1，DFS 求解路径（与 AC-11 同源），逐步经 tap 驱动真实 UI 动画链
  main.cleared = 1;
  main.selectLevel(0);
  finishLoading();
  main.tick();
  assert.strictEqual(main.scene, 'game');

  // 求解路径（纯逻辑层探索，undo 可完整回退）
  const visited = new Set();
  const path = [];
  const dfs = () => {
    if (logic.isWin()) return true;
    const key = JSON.stringify(logic.bottles);
    if (visited.has(key)) return false;
    visited.add(key);
    for (let from = 0; from < logic.bottles.length; from++) {
      for (let to = 0; to < logic.bottles.length; to++) {
        if (from === to || logic.canPour(from, to) === 0) continue;
        logic.pour(from, to);
        path.push([from, to]);
        if (dfs()) return true;
        path.pop();
        logic.undo();
      }
    }
    return false;
  };
  assert.ok(dfs(), 'L1 应可解');

  // 重载干净局面，按路径经 tap 重放（走完整 UI 动画链）
  main.loadLevel(0);
  assert.strictEqual(logic.moveCount, 0);
  let sawBadge = false;
  for (const [from, to] of path) {
    const doneBefore = logic.completed.length;
    const p1 = center(renderer.bottleRect(from));
    const p2 = center(renderer.bottleRect(to));
    tap(p1.x, p1.y);
    tap(p2.x, p2.y);
    // 推进 0.5s：pour(0.38s) 完成 → 徽章已入场（t≈0.12）
    for (let i = 0; i < 30 && !anims.allDone(); i++) anims.update(1 / 60);
    if (logic.completed.length > doneBefore) {
      const badge = anims.badgeOf(to);
      assert.ok(badge, '完成瓶应处于徽章停留阶段');
      assert.strictEqual(badge.layers.length, logic.capacity, '徽章阶段应展示满瓶');
      assert.ok(badge.layers.every((c) => c === badge.layers[0]), '徽章阶段应展示纯色满瓶');
      assert.ok(!anims.list.some((a) => a.type === 'fly'), '徽章结束前不应起飞去货架');
      main.tick(); // 含徽章的绘制不抛错
      sawBadge = true;
      fastForward(); // 徽章 0.5s → 起飞 0.5s 落地
      assert.strictEqual(renderer.displayedCompleted, logic.completed.length, '飞行落地后货架计数才 +1');
    } else {
      fastForward();
    }
  }
  assert.ok(sawBadge, '应至少经过一次完成链路');
  assert.ok(logic.isWin(), '按路径重放应通关');
});

check('R1 按下态生命周期：命中记录 / 抬手清 / 位移超阈值清 / onCancel 清 / onTap 派发零改动（AC-08/AC-09）', () => {
  main.loadLevel(0);
  main.scene = 'game';
  main.tick();
  // touchstart 命中底栏按钮 → pressed 记录（仅视觉，不派发）
  globalThis.__ts({ touches: [{ clientX: renderer.undoBtn.x, clientY: renderer.undoBtn.y }] });
  assert.strictEqual(renderer.pressed, 'undoBtn', 'touchstart 命中应记录按下态');
  assert.strictEqual(logic.moveCount, 0, '按下本身不触发任何操作');
  // 位移超阈值 → 清除按下态且不派发
  globalThis.__tm({ touches: [{ clientX: renderer.undoBtn.x, clientY: renderer.undoBtn.y - 20 }] });
  assert.strictEqual(renderer.pressed, null, '位移超阈值应清除按下态');
  globalThis.__te({ changedTouches: [] });
  assert.strictEqual(logic.moveCount, 0, '拖动不应误触按钮（onTap 派发行为与现状一致）');
  // start 命中 + end → 正常派发 onTap 且 pressed 清除（无残留）
  globalThis.__ts({ touches: [{ clientX: renderer.backBtn.x, clientY: renderer.backBtn.y }] });
  assert.strictEqual(renderer.pressed, 'backBtn', 'backBtn 命中应记录按下态');
  globalThis.__te({ changedTouches: [] });
  assert.ok(main.pauseOverlay, 'onTap 应正常派发（弹出暂停浮层）');
  assert.strictEqual(renderer.pressed, null, '抬手应清除按下态');
  // 浮层开关：onTap 分支置位 → 入口统一清（无「浮层下残留高亮」）
  renderer.pressed = 'undoBtn';
  tap(renderer.pauseResumeBtn.x + 5, renderer.pauseResumeBtn.y + 5);
  assert.ok(!main.pauseOverlay, '浮层应正常关闭');
  assert.strictEqual(renderer.pressed, null, 'onTap 入口应清按下态');
  // touchCancel → 清除
  globalThis.__ts({ touches: [{ clientX: renderer.undoBtn.x, clientY: renderer.undoBtn.y }] });
  assert.strictEqual(renderer.pressed, 'undoBtn');
  globalThis.__tc({ changedTouches: [] });
  assert.strictEqual(renderer.pressed, null, 'touchCancel 应清除按下态');
  main.pauseOverlay = false;
});

check('P-02/S-02：hitButton/onTap 命中矩阵 —— 4 场景 × 浮层开关组合，按钮 rect 中心逐一断言 + 抽检 onTap 对应', () => {
  const pt = (r) => (r.r != null ? { x: r.x, y: r.y } : { x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const mkCtx = () => ({
    scene: main.scene,
    winPanel: !!main.winPanel,
    bigIntro: !!main.bigIntro,
    adConfirm: !!main.adConfirm,
    pauseOverlay: !!main.pauseOverlay,
    cleared: main.cleared,
  });
  const shouldHit = (label, r, key) => {
    const p = pt(r);
    assert.strictEqual(
      renderer.hitButton(p.x, p.y, mkCtx()),
      key,
      `${label}：rect 中心 (${Math.round(p.x)},${Math.round(p.y)}) 应命中 ${key}`
    );
  };
  const shouldMiss = (label, r) => {
    const p = pt(r);
    assert.strictEqual(
      renderer.hitButton(p.x, p.y, mkCtx()),
      null,
      `${label}：rect 中心 (${Math.round(p.x)},${Math.round(p.y)}) 不应命中任何按钮`
    );
  };

  // ---------- menu ----------
  main.scene = 'menu';
  main.tick();
  shouldHit('menu', renderer.menuPlayBtn, 'menuPlayBtn');
  shouldHit('menu', renderer.menuSettingsBtn, 'menuSettingsBtn');

  // ---------- settings ----------
  main.scene = 'settings';
  main.tick();
  shouldHit('settings', renderer.backBtn, 'backBtn');
  shouldHit('settings', renderer.settingsSoundToggle, 'settingsSoundToggle');
  shouldHit('settings', renderer.settingsResetBtn, 'settingsResetBtn');
  shouldHit('settings', renderer.settingsKeyBtn, 'settingsKeyBtn');

  // ---------- levelSelect（cleared=2：前 3 关解锁，其余锁定） ----------
  const savedCleared = main.cleared;
  main.cleared = 2;
  main.scene = 'levelSelect';
  main.tick(); // 绘制刷新 levelBtns（含滚动偏移）
  shouldHit('levelSelect', renderer.backBtn, 'backBtn');
  shouldHit('levelSelect', renderer.levelBtns[0], 'level:0');
  shouldHit('levelSelect', renderer.levelBtns[1], 'level:1');
  shouldHit('levelSelect', renderer.levelBtns[2], 'level:2');
  shouldMiss('levelSelect（锁定卡）', renderer.levelBtns[3]);

  // ---------- game 常规（无浮层） ----------
  main.cleared = savedCleared;
  main.scene = 'game';
  main.tick();
  shouldHit('game', renderer.backBtn, 'backBtn');
  shouldHit('game', renderer.undoBtn, 'undoBtn');
  shouldHit('game', renderer.shuffleBtn, 'shuffleBtn');
  shouldHit('game', renderer.addBottleBtn, 'addBottleBtn');
  shouldHit('game', renderer.restartBtn, 'restartBtn');
  // bindTouch 消费同一函数：touchstart 记录的 pressed 与 hitButton 返回一致
  const up = pt(renderer.undoBtn);
  globalThis.__ts({ touches: [{ clientX: up.x, clientY: up.y }] });
  assert.strictEqual(renderer.pressed, 'undoBtn', 'pressed 应与 hitButton 命中一致');
  globalThis.__te({ changedTouches: [] });

  // ---------- game + winPanel（浮层分支优先级：常规按钮全部不可命中） ----------
  main.winPanel = true;
  main.tick(); // drawWinPanel 每帧覆写 nextBtn/winBackBtn rect，先绘制再命中
  shouldHit('game+winPanel', renderer.nextBtn, 'nextBtn');
  shouldHit('game+winPanel', renderer.winBackBtn, 'winBackBtn');
  shouldMiss('game+winPanel（backBtn）', renderer.backBtn);
  shouldMiss('game+winPanel（undoBtn）', renderer.undoBtn);
  // 注：pauseResumeBtn 布局中心恰落在 winPanel nextBtn 覆写 rect 内（布局物理重叠），
  // winPanel 分支优先返回 nextBtn 属正确行为，不作为「应 miss」样本
  main.winPanel = false;

  // ---------- game + bigIntro ----------
  main.bigIntro = true;
  main.tick();
  shouldHit('game+bigIntro', renderer.bigIntroBtn, 'bigIntroBtn');
  shouldMiss('game+bigIntro（backBtn）', renderer.backBtn);
  main.bigIntro = false;

  // ---------- game + adConfirm ----------
  main.adConfirm = 'shuffle';
  main.tick();
  shouldHit('game+adConfirm', renderer.adConfirmWatchBtn, 'adConfirmWatchBtn');
  shouldHit('game+adConfirm', renderer.adConfirmCancelBtn, 'adConfirmCancelBtn');
  shouldMiss('game+adConfirm（backBtn）', renderer.backBtn);
  main.adConfirm = null;

  // ---------- game + pauseOverlay ----------
  main.pauseOverlay = true;
  main.tick();
  shouldHit('game+pauseOverlay', renderer.pauseResumeBtn, 'pauseResumeBtn');
  shouldHit('game+pauseOverlay', renderer.pauseExitBtn, 'pauseExitBtn');
  shouldMiss('game+pauseOverlay（backBtn）', renderer.backBtn);
  shouldMiss('game+pauseOverlay（undoBtn）', renderer.undoBtn);
  main.pauseOverlay = false;

  // ---------- onTap 抽检（key 与实际响应一一对应，复用既有 tap 桩） ----------
  main.scene = 'menu';
  const ms = pt(renderer.menuSettingsBtn);
  tap(ms.x, ms.y);
  assert.strictEqual(main.scene, 'settings', '抽检：menuSettingsBtn 命中 ↔ onTap 切到设置页');
  main.scene = 'game';
  main.pauseOverlay = true;
  const pr = pt(renderer.pauseResumeBtn);
  tap(pr.x, pr.y);
  assert.ok(!main.pauseOverlay, '抽检：pauseResumeBtn 命中 ↔ onTap 关闭暂停浮层');
  main.adConfirm = 'shuffle';
  const ac = pt(renderer.adConfirmCancelBtn);
  tap(ac.x, ac.y);
  assert.strictEqual(main.adConfirm, null, '抽检：adConfirmCancelBtn 命中 ↔ onTap 关闭广告浮层');
});

check('P-03/S-04：levelSelect 锁定关卡卡片 —— hitButton 返回 null（无按下态）、按下链路不记录不进关', () => {
  main.cleared = 2;
  main.scene = 'levelSelect';
  main.tick();
  const c = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  // 走 bindTouch 真实链路：锁定卡 touchstart 不记录按下态
  const locked = c(renderer.levelBtns[3]);
  globalThis.__ts({ touches: [{ clientX: locked.x, clientY: locked.y }] });
  assert.strictEqual(renderer.pressed, null, '锁定卡不应记录按下态（无「可按不可点」暗示）');
  globalThis.__te({ changedTouches: [] });
  // 抬手派发 onTap → selectLevel 对未解锁直接 return，场景不变
  tap(locked.x, locked.y);
  assert.strictEqual(main.scene, 'levelSelect', '锁定卡点击不应进关');
  // 对照组：已解锁卡仍有按下态
  const unlocked = c(renderer.levelBtns[2]);
  globalThis.__ts({ touches: [{ clientX: unlocked.x, clientY: unlocked.y }] });
  assert.strictEqual(renderer.pressed, 'level:2', '已解锁卡应记录按下态');
  globalThis.__te({ changedTouches: [] });
  main.cleared = 0; // 恢复现场
  main.scene = 'game';
});

check('三星评价：通关结算面板星级/最佳文案 + 关卡选择页星数显示（PRD-玩法扩展 F-05/F-07）', () => {
  main.best = {}; // 干净起局（storage 桩为 noop，内存态即可）
  main.loadLevel(0);
  // DFS 走通 L1（与既有用例同源）
  const visited = new Set();
  const dfs = () => {
    if (logic.isWin()) return true;
    const key = JSON.stringify(logic.bottles) + JSON.stringify([...logic.removed]) + JSON.stringify(logic.unlocked);
    if (visited.has(key)) return false;
    visited.add(key);
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
  assert.ok(dfs(), 'L1 应可解');
  for (let i = 0; i < 200 && !anims.allDone(); i++) anims.update(1 / 60);
  main.winDelay = 0.5;
  main.tick();
  assert.ok(main.winPanel, '应弹出胜利面板');
  assert.ok(main.winStats && main.winStats.newRecord, '首通应标记新纪录');
  globalThis.__fillTexts.length = 0;
  main.tick(); // 绘制结算面板
  const texts = globalThis.__fillTexts.join('\n');
  assert.ok(texts.includes('★'), '结算面板应显示星级文本');
  assert.ok(texts.includes('最佳'), '结算面板应显示最佳纪录');
  assert.ok(texts.includes('新纪录'), '新纪录应有区分标识');
  assert.ok(texts.includes(`本关共 ${logic.moveCount} 步`), '应显示本局步数');
  // 关卡选择页：已通关卡片显示星数
  main.winPanel = false;
  main.cleared = 1;
  main.scene = 'levelSelect';
  globalThis.__fillTexts.length = 0;
  main.tick();
  const selTexts = globalThis.__fillTexts.join('\n');
  assert.ok(selTexts.includes('★'), '关卡选择页已通关卡应显示星数');
  // 清理现场
  main.best = {};
  main.cleared = 0;
  main.scene = 'game';
});

check('遮盖瓶：渲染不抛错 + 点击拒选 + 调试协议字段 + 揭示链路（PRD-玩法扩展 F-02/F-07/F-08）', () => {
  main.loadLevel(24); // L25：条件锁 + 遮盖首秀
  main.tick(); // 纸袋遮罩 + 剩余层数数字绘制不抛错
  const covered = logic.coverBottles[0];
  assert.ok(logic.isCovered(covered), 'L25 应存在遮盖瓶');
  // 点击遮盖瓶 → 拒选（sel=-1 + 抖动，与锁定瓶同级反馈）
  const cp = center(renderer.bottleRect(covered));
  tap(cp.x, cp.y);
  assert.strictEqual(main.selected, -1, '遮盖瓶不应被选中');
  assert.ok(anims.shakeOffset(covered) !== 0 || anims.list.some((a) => a.type === 'shake'), '应有抖动反馈');
  // 调试协议：covers 摘要与 completedCount 写入 __dbg_state（临时捕获桩；
  // 置空签名强制写一次，规避稳态 2s 心跳跳写）
  const seen = {};
  const origSet = globalThis.wx.setStorageSync;
  globalThis.wx.setStorageSync = (k, v) => {
    if (k === '__dbg_state') seen.state = v;
  };
  main._dbgSig = '';
  main.tick();
  globalThis.wx.setStorageSync = origSet;
  assert.ok(seen.state, '应写入 __dbg_state');
  assert.ok(Array.isArray(seen.state.covers), 'covers 应为数组');
  assert.strictEqual(seen.state.covers[covered], logic.coverLeft(), '遮盖瓶摘要应 = 剩余层数');
  assert.strictEqual(seen.state.completedCount, logic.completed.length);

  // 揭示链路：L29（双遮盖、无锁、无空瓶）走通 2 瓶成品 → 全体揭示 → 同瓶可选中
  main.loadLevel(28);
  main.tick();
  assert.strictEqual(logic.coverBottles.length, 2, 'L29 应有 2 个遮盖瓶');
  const visited = new Set();
  let nodes = 0;
  // key 含 completed.length（遮盖揭示由成品数派生，与 tools/solve-report stateKey 同口径）
  const key = () => logic.bottles.map((b) => b.join(',')).join('|') + '#' + logic.completed.length;
  const dfs = () => {
    if (logic.completed.length >= 2) return true;
    if (nodes++ > 80000) return false;
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
  assert.ok(dfs(), 'L29 应可走通 2 瓶成品（遮盖揭示）');
  assert.strictEqual(logic.completed.length, 2);
  assert.ok(logic.coverBottles.every((i) => !logic.isCovered(i)), '两遮盖瓶应全部揭示');
  main.tick(); // 揭示后普通瓶渲染不抛错
  const cv = logic.coverBottles[0];
  const p2 = center(renderer.bottleRect(cv));
  tap(p2.x, p2.y);
  assert.strictEqual(main.selected, cv, '揭示后原遮盖瓶应可选中');
});

check('炸弹瓶：角标渲染 + 倒计时递减 + 失败弹窗链路 + 广告复活/重开 + 调试协议字段（PRD-玩法扩展 F-03/F-06/F-07/F-08）', () => {
  main.loadLevel(22); // L23：2 炸弹瓶（8 色）
  main.tick(); // 角标绘制不抛错
  assert.strictEqual(logic.bombBottles.length, 2, 'L23 应有 2 个炸弹瓶');
  assert.ok(logic.bombMoves >= 8, `引信初值应 ≥ 8（实际 ${logic.bombMoves}）`);
  assert.ok(logic.bombBottles.every((bi) => logic.bottles[bi].length > 0), '炸弹瓶应为非空瓶');
  const timersInit = logic.bombTimers.slice();

  // UI 驱动一步倒水 → 活跃炸弹引信 -1
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
  assert.ok(src >= 0, 'L23 开局应存在合法倒法');
  tap(center(renderer.bottleRect(src)).x, center(renderer.bottleRect(src)).y);
  tap(center(renderer.bottleRect(to)).x, center(renderer.bottleRect(to)).y);
  assert.strictEqual(logic.moveCount, 1);
  fastForward();
  assert.ok(
    logic.bombBottles.some((bi, k) => !logic.bombDefused[k] && logic.bombTimers[logic.bombBottles.indexOf(bi)] < timersInit[logic.bombBottles.indexOf(bi)]),
    '倒水后活跃炸弹引信应递减'
  );
  main.tick(); // 含角标与递减后局面的绘制不抛错

  // 失败链路：手工把一个引信压到 1 → 一步引爆 → 红色闪光 → 失败弹窗
  const k0 = 0;
  logic.bombTimers[k0] = 1;
  let s2 = -1;
  let t2 = -1;
  for (let f = 0; f < logic.bottles.length && s2 < 0; f++) {
    for (let t = 0; t < logic.bottles.length; t++) {
      if (f !== t && logic.canPour(f, t) > 0) {
        s2 = f;
        t2 = t;
        break;
      }
    }
  }
  assert.ok(s2 >= 0, '当前局面应存在合法倒法');
  const undoBeforeFail = logic.undoStack.length;
  logic.pour(s2, t2); // 直接驱动逻辑层（聚焦失败流程链路）
  assert.ok(logic.isFailed(), '引信归零应判定失败');
  fastForward();
  for (let i = 0; i < 30 && !main.failPanel; i++) {
    main.failDelay = 0.7; // 同毫秒 tick dt≈0，手动推进闪光计时（与 winDelay 用例同口径）
    main.tick();
  }
  assert.ok(main.failPanel, '闪光结束后应弹出失败弹窗');
  assert.ok(main.failFlashIdx >= 0, '应记录引爆瓶下标');
  globalThis.__fillTexts.length = 0;
  main.tick(); // 绘制失败弹窗
  const failTexts = globalThis.__fillTexts.join('\n');
  assert.ok(failTexts.includes('炸弹爆炸了'), '失败弹窗标题文案');
  assert.ok(failTexts.includes('续杯'), '失败弹窗应含续杯按钮（PRD-限时与步数限制 F-10）');
  assert.ok(failTexts.includes('重开本关'), '失败弹窗应含重开按钮');

  // 调试协议：bombs 摘要 + fail 状态 + btns 自描述
  const seen = {};
  const origSet = globalThis.wx.setStorageSync;
  globalThis.wx.setStorageSync = (key, v) => {
    if (key === '__dbg_state') seen.state = v;
  };
  main._dbgSig = '';
  main.tick();
  globalThis.wx.setStorageSync = origSet;
  assert.ok(seen.state, '应写入 __dbg_state');
  assert.ok(Array.isArray(seen.state.bombs), 'bombs 应为数组');
  assert.strictEqual(seen.state.bombs[logic.bombBottles[k0]], 0, '已引爆炸弹摘要应为 0');
  assert.strictEqual(seen.state.fail, true, '失败态应写入协议');
  assert.strictEqual(seen.state.failReason, 'bomb', '失败原因应写入协议（PRD-限时与步数限制 F-07）');
  assert.ok(seen.state.btns.fail_revive && seen.state.btns.fail_restart, 'btns 表应自描述失败弹窗按钮');

  // 续杯统一复活（PRD-限时与步数限制 F-10，替代旧「undo×3 + 引信重置」）：
  // 库存 0 → 广告确认浮层（补 1）→ 自动使用：消耗 revive、不回退局面、未拆除引信 +10 封顶初值
  main.inv.revive = 0;
  const undoLenBeforeRevive = logic.undoStack.length;
  const timersBeforeRevive = logic.bombTimers.slice();
  tap(renderer.failReviveBtn.x + renderer.failReviveBtn.w / 2, renderer.failReviveBtn.y + renderer.failReviveBtn.h / 2);
  assert.strictEqual(main.adConfirm, 'revive', '续杯库存 0 应弹广告确认浮层');
  tap(renderer.adConfirmWatchBtn.x + renderer.adConfirmWatchBtn.w / 2, renderer.adConfirmWatchBtn.y + renderer.adConfirmWatchBtn.h / 2);
  assert.strictEqual(main.inv.revive, 0, '广告补 1 后应自动消耗使用');
  assert.ok(!main.failPanel, '复活后失败弹窗应关闭');
  assert.ok(!logic.isFailed(), '复活后应解除失败态');
  assert.ok(
    logic.bombBottles.every(
      (bi, k) => logic.bombDefused[k] || logic.bombTimers[k] === Math.min(timersBeforeRevive[k] + 10, logic.bombMoves)
    ),
    '未拆除引信应 +10（封顶各自初值）且 ≥ 1'
  );
  assert.strictEqual(logic.undoStack.length, undoLenBeforeRevive, '续杯不回退局面（undoStack 长度不变，语义变更）');

  // 再失败 → 重开本关
  logic.bombTimers[k0] = 1;
  if (!logic.isFailed()) {
    let s3 = -1;
    let t3 = -1;
    for (let f = 0; f < logic.bottles.length && s3 < 0; f++) {
      for (let t = 0; t < logic.bottles.length; t++) {
        if (f !== t && logic.canPour(f, t) > 0) {
          s3 = f;
          t3 = t;
          break;
        }
      }
    }
    if (s3 >= 0) logic.pour(s3, t3);
  }
  assert.ok(logic.isFailed(), '再次引爆应失败');
  fastForward();
  for (let i = 0; i < 30 && !main.failPanel; i++) {
    main.failDelay = 0.7;
    main.tick();
  }
  assert.ok(main.failPanel);
  tap(renderer.failRestartBtn.x + renderer.failRestartBtn.w / 2, renderer.failRestartBtn.y + renderer.failRestartBtn.h / 2);
  finishLoading(); // 重开走 loading 分帧生成（生成完成后局面才重建）
  assert.ok(!main.failPanel, '重开后失败弹窗应关闭');
  assert.strictEqual(logic.moveCount, 0, '重开后步数清零');
  assert.deepStrictEqual(logic.bombTimers, logic.bombBottles.map(() => logic.bombMoves), '重开后引信复位');
  assert.ok(!logic.isFailed(), '重开后不处于失败态');
  main.tick(); // 重开后绘制不抛错
});

check('B-01：0.6s 引爆闪光窗口内撤销解除失败态 → 闪光残影复位、下次引爆正常记录、不误弹失败面板', () => {
  main.loadLevel(22); // L23：2 炸弹瓶
  main.tick();
  assert.strictEqual(logic.bombBottles.length, 2, '前置：L23 应有 2 个炸弹瓶');
  logic.bombTimers[0] = 1; // 引信压到 1 → 一步引爆
  let s = -1;
  let t = -1;
  for (let f = 0; f < logic.bottles.length && s < 0; f++) {
    for (let to = 0; to < logic.bottles.length; to++) {
      if (f !== to && logic.canPour(f, to) > 0) {
        s = f;
        t = to;
        break;
      }
    }
  }
  assert.ok(s >= 0, '当前局面应存在合法倒法');
  logic.pour(s, t);
  assert.ok(logic.isFailed(), '引信归零应判定失败');
  fastForward();
  main.tick(); // 失败检测块：记录引爆闪光（此时 0.6s 窗口内）
  assert.ok(main.failFlashIdx >= 0, '应进入闪光态（记录引爆瓶下标）');
  assert.ok(!main.failPanel, '0.6s 窗口内失败面板尚未弹出');
  // 玩家在窗口内撤销 → 失败态解除
  main.inv.undo = Math.max(main.inv.undo, 1);
  main.undo();
  assert.ok(!logic.isFailed(), '撤销应解除失败态');
  main.tick(); // 推进失败检测块：闪光态应复位
  assert.strictEqual(main.failFlashIdx, -1, '闪光残影应复位（-1）');
  assert.strictEqual(main.failDelay, 0, '闪光计时应复位');
  // 持续推进不再误弹失败面板；再次引爆时闪光应能正常记录新下标/新时长
  for (let i = 0; i < 5; i++) {
    main.failDelay = 0.7;
    main.tick();
  }
  assert.ok(!main.failPanel, '失败态已解除不应弹出失败面板');
  assert.strictEqual(main.failFlashIdx, -1, '推进后闪光态保持复位');
});

console.log(`\n结果: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed > 0 ? 1 : 0);
