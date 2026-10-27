/**
 * 渲染层 + 入口冒烟测试（Node 运行，无需微信开发者工具）
 * 通过 wx / canvas 桩验证：模块加载、触摸交互（选中→倒水→撤回）、绘制主路径不抛错
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
  assert.strictEqual(renderer.levelBtns.length, 30);
  assert.strictEqual(renderer.levelCount, 30);
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
  assert.strictEqual(main.props.shuffle, 0, '打乱次数应扣减');
  assert.strictEqual(main.shuffleSelecting, false, '打乱成功后应退出选瓶模式');
  assert.notStrictEqual(JSON.stringify(logic.bottles), before, '该瓶层序应变化');
  assert.strictEqual(flat(logic.bottles), flat(JSON.parse(before)), '层集合应不变');
  main.tick(); // 绘制不抛错
  const after = JSON.stringify(logic.bottles);
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

check('AC-07：道具出厂按曲线注入（L9 {1,1} / L10 {0,0}，补给流程不变）', () => {
  main.loadLevel(8);
  assert.deepStrictEqual(main.props, { shuffle: 1, addBottle: 1 });
  main.tick();
  main.loadLevel(9); // L10 已是特殊关
  assert.deepStrictEqual(main.props, { shuffle: 0, addBottle: 0 });
  // 首进特殊关弹引导浮层（浮层期间屏蔽其他输入）：先点「开始挑战」关闭
  assert.ok(main.bigIntro, '首进特殊关应弹引导浮层');
  main.tick();
  tap(renderer.bigIntroBtn.x + renderer.bigIntroBtn.w / 2, renderer.bigIntroBtn.y + renderer.bigIntroBtn.h / 2);
  assert.ok(!main.bigIntro, '点击「开始挑战」应关闭浮层');
  main.tick();
  // 出厂 0：直接点击打乱 → 广告确认浮层（补给流程不变）
  tap(renderer.shuffleBtn.x, renderer.shuffleBtn.y);
  assert.strictEqual(main.adConfirm, 'shuffle', 'L10 点击打乱应直接弹广告确认浮层');
  main.tick(); // 浮层绘制不抛错
  main.adConfirm = null; // 清理
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

check('特殊关 AC-09/AC-13 前置：L10 大瓶渲染 —— 居中、贴图天然比例 1:3、预置限定色层、安全区无重叠、矢量降级绘制不抛错', () => {
  main.loadLevel(9); // L10 特殊关
  main.tick();
  assert.ok(!main.bigIntro, '引导已读，直接进入棋盘');
  assert.ok(logic.bigColor >= 0, '大瓶应有瓶口限定色');
  assert.deepStrictEqual(logic.bottles[logic.bigIndex], [logic.bigColor], '大瓶开局应预置 1 层限定色');
  const bigRect = renderer.bottleRects[logic.bigIndex];
  const normalRect = renderer.bottleRects.find((r, i) => i !== logic.bigIndex);
  assert.ok(bigRect && normalRect, '应存在大瓶与普通瓶布局');
  assert.ok(
    Math.abs(bigRect.w / bigRect.h - 1 / 3) < 0.03,
    `大瓶应保持贴图天然比例 1:3（实际 ${(bigRect.w / bigRect.h).toFixed(3)}）`
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
  // 大瓶 → 普通瓶（反向：大瓶作源倒出）
  tap(bigRect.x + bigRect.w / 2, cy);
  assert.strictEqual(main.selected, big, '非空大瓶应可被选中');
  const emptyIdx = logic.bottles.findIndex((b, i) => i !== big && b.length === 0);
  assert.ok(emptyIdx >= 0, '特殊关应有空瓶');
  const ep = center(renderer.bottleRect(emptyIdx));
  tap(ep.x, ep.y);
  assert.strictEqual(logic.moveCount, 2, '大瓶倒出应与普通瓶行为一致');
  fastForward();
  // 连续撤回两步完整恢复
  tap(renderer.undoBtn.x, renderer.undoBtn.y);
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

check('AC-10：关卡选择页 30 卡自适应列数 + 竖向滚动，返回键固定，重进复位', () => {
  main.scene = 'menu';
  tap(renderer.menuPlayBtn.x + 5, renderer.menuPlayBtn.y + 5);
  assert.strictEqual(main.scene, 'levelSelect');
  main.tick();
  assert.strictEqual(renderer.levelBtns.length, 30);
  assert.ok(renderer.levelScrollMax > 0, '30 关内容应超出可视高度（需滚动）');
  assert.strictEqual(renderer.levelScroll, 0);

  // 手指上拖 → 滚动偏移增加并 clamp，第 30 关卡片进入可视区
  drag(renderer.W / 2, 500, 150);
  assert.ok(renderer.levelScroll > 0, '拖动应产生滚动偏移');
  assert.ok(renderer.levelScroll <= renderer.levelScrollMax, '滚动应 clamp 在上限内');
  main.tick(); // 滚动后绘制不抛错
  const last = renderer.levelBtns[29];
  assert.ok(last.y < renderer.H && last.y + last.h > 0, '第 30 关卡片应可滚动至可视区');

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

check('AC-12：旧进度 cleared=8 语义 —— 第 9 关可挑战、第 10 关锁定、进度 8/30', () => {
  const savedCleared = main.cleared;
  main.cleared = 8;
  assert.strictEqual(renderer.levelCount, 30);
  // 第 9 关（index 8）可挑战：直接以触摸链路进入
  main.scene = 'levelSelect';
  main.tick();
  const card9 = renderer.levelBtns[8];
  tap(card9.x + 5, card9.y + 5);
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
  assert.strictEqual(main.cleared, 30, 'unlock_all 应解锁全部 30 关');
  assert.ok(renderer.toast && renderer.toast.text.includes('30'), '应提示已解锁全部关卡');

  // 解锁后第 30 关可进入（unlock_all 的验收目的）
  main.scene = 'levelSelect';
  main.tick();
  main.selectLevel(29);
  assert.strictEqual(main.scene, 'game', 'unlock_all 后第 30 关应可挑战');
  assert.strictEqual(main.levelIndex, 29);
  main.scene = 'settings';

  // 无效兑换码 → 提示且进度不变
  main.applyKey('GM');
  assert.strictEqual(main.cleared, 30, '无效码不应改变进度');
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

  const aspect = 3.0 * (1 + (logic.capacity - 4) * 0.11);
  for (let i = 0; i < logic.bottles.length; i++) {
    const r = renderer.bottleRects[i];
    assert.ok(r && r.h > 0, `瓶 ${i} 应有布局`);
    // 同宽 + 瓶高 ∝ 容量（统一层厚）
    assert.ok(Math.abs(r.h / r.w - (aspect * logic.caps[i]) / logic.capacity) < 0.4, `瓶 ${i} 高宽比应 ∝ 容量`);
    assert.strictEqual(logic.bottles[i].length <= logic.caps[i], true, `瓶 ${i} 层数不超容量`);
  }
  // 行内底对齐：同排瓶底 y 一致
  const n = logic.bottles.length;
  const cols = Math.max(2, Math.ceil(n / 2));
  for (let r = 0; r * cols < n; r++) {
    let bottom = null;
    for (let c = 0; c < cols && r * cols + c < n; c++) {
      const rect = renderer.bottleRects[r * cols + c];
      const b = rect.y + rect.h;
      if (bottom === null) bottom = b;
      else assert.strictEqual(b, bottom, `第 ${r} 排应底对齐`);
    }
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

console.log(`\n结果: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed > 0 ? 1 : 0);
