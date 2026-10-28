/**
 * 道具背包单元测试（PRD-玩法扩展 F-04 / Node 直接运行）
 * 覆盖：初始存量 / 存档清洗合并 / 首入发放一次性 / 扣减 / 耗尽广告补给 / grant 解析 / 持久化 mock
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// ---------- wx 桩（storage 为内存 Map，验证持久化写入时机与内容） ----------
const noop = () => {};
const gradient = { addColorStop: noop };
const ctxStub = new Proxy(
  {},
  {
    get(target, prop) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
      if (typeof prop === 'symbol') return undefined;
      return target[prop] !== undefined ? target[prop] : noop;
    },
    set(target, prop, v) {
      target[prop] = v;
      return true;
    },
  }
);
const store = new Map();
let readCalls = 0;
let writeCalls = 0;
globalThis.wx = {
  createCanvas: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
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
  setStorageSync: (k, v) => {
    writeCalls++;
    store.set(k, v);
  },
  getStorageSync: (k) => {
    readCalls++;
    return store.has(k) ? store.get(k) : '';
  },
  removeStorageSync: (k) => store.delete(k),
  getMenuButtonBoundingClientRect: () => ({ top: 24, bottom: 56, height: 32, left: 281, right: 368, width: 87 }),
  getFileSystemManager: () => ({
    readFileSync: (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
  }),
};
globalThis.requestAnimationFrame = () => 1;

const { defaultInventory, mergeInventory, applyGrant, canConsume, consume, PROP_KEYS } = await import(
  '../js/core/inventory.js'
);
const { buildLevelsFromConfig, parseJsonc } = await import('../js/core/levels.js');

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

console.log('== 背包纯函数（js/core/inventory.js） ==');

test('T-01：初始存量 = {undo:3, shuffle:1, addBottle:1}', () => {
  assert.deepStrictEqual(defaultInventory(), { undo: 3, shuffle: 1, addBottle: 1 });
  assert.deepStrictEqual(PROP_KEYS, ['undo', 'shuffle', 'addBottle']);
});

test('T-02：mergeInventory 容错 —— 空串/null/缺字段/负数/非整数/浮点均不炸且回退合法值', () => {
  assert.deepStrictEqual(mergeInventory(''), { undo: 3, shuffle: 1, addBottle: 1 });
  assert.deepStrictEqual(mergeInventory(null), { undo: 3, shuffle: 1, addBottle: 1 });
  assert.deepStrictEqual(mergeInventory(undefined), { undo: 3, shuffle: 1, addBottle: 1 });
  // 旧存档缺字段：缺省回默认，已有字段保留
  assert.deepStrictEqual(mergeInventory({ undo: 7 }), { undo: 7, shuffle: 1, addBottle: 1 });
  // 非法值剔除：负数 / 非整数 / 浮点 / 非数值
  assert.deepStrictEqual(mergeInventory({ undo: -2, shuffle: 1.5, addBottle: 'x' }), {
    undo: 3,
    shuffle: 1,
    addBottle: 1,
  });
  // 不修改入参
  const saved = { undo: 5 };
  mergeInventory(saved);
  assert.deepStrictEqual(saved, { undo: 5 });
});

test('T-03：applyGrant —— 正常叠加 / 非法字段忽略 / 0 与负数不叠加 / 返回新对象', () => {
  const base = defaultInventory();
  assert.deepStrictEqual(applyGrant(base, { shuffle: 1, addBottle: 1 }), {
    undo: 3,
    shuffle: 2,
    addBottle: 2,
  });
  assert.deepStrictEqual(applyGrant(base, { undo: 2 }), { undo: 5, shuffle: 1, addBottle: 1 });
  assert.deepStrictEqual(applyGrant(base, null), base, 'grant 缺省应原样返回');
  assert.deepStrictEqual(applyGrant(base, 'x'), base, 'grant 非对象应原样返回');
  assert.deepStrictEqual(applyGrant(base, { undo: 0, shuffle: -1, addBottle: 1.5 }), base, '0/负/浮点不叠加');
  const out = applyGrant(base, { undo: 1 });
  assert.deepStrictEqual(base, { undo: 3, shuffle: 1, addBottle: 1 }, '不应修改入参');
  assert.notStrictEqual(out, base);
});

test('canConsume / consume —— 扣减与耗尽判定', () => {
  const inv = { undo: 1, shuffle: 0, addBottle: 2 };
  assert.ok(canConsume(inv, 'undo'));
  assert.ok(!canConsume(inv, 'shuffle'));
  consume(inv, 'undo');
  assert.strictEqual(inv.undo, 0);
  assert.ok(!canConsume(inv, 'undo'), '耗尽后不可再消耗');
  consume(inv, 'undo'); // 0 时消耗应无副作用（防御）
  assert.strictEqual(inv.undo, 0);
});

console.log('== grant 配置解析（levels.js / levels.json） ==');

test('T-07：章首关 grant={shuffle:1,addBottle:1}、每 5 关 grant={undo:2}，其余关无 grant', () => {
  const cfg = parseJsonc(readFileSync(new URL('../assets/config/levels.json', import.meta.url), 'utf8'));
  const lvs = buildLevelsFromConfig(cfg);
  assert.strictEqual(lvs.length, 100);
  const heads = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  const every5 = [34, 44, 54, 64, 74, 84, 94];
  for (const idx of heads) {
    assert.deepStrictEqual(lvs[idx].grant, { shuffle: 1, addBottle: 1 }, `L${idx + 1} 应配章首关赠送`);
  }
  for (const idx of every5) {
    assert.deepStrictEqual(lvs[idx].grant, { undo: 2 }, `L${idx + 1} 应配每 5 关赠送`);
  }
  for (let i = 0; i < lvs.length; i++) {
    if (![...heads, ...every5].includes(i)) assert.ok(!lvs[i].grant, `L${i + 1} 不应配 grant`);
    assert.ok(!('props' in lvs[i]), `L${i + 1} 出厂 props 已废除`);
  }
});

console.log('== 胶水层背包链路（main.js + wx storage mock） ==');

const { default: Main } = await import('../js/main.js');
const main = new Main();
const { logic, renderer } = main;

const center = (r) => ({ x: r.x + (r.w || 0) / 2, y: r.y + (r.h || 0) / 2 });
const tap = (x, y) => {
  globalThis.__ts({ touches: [{ clientX: x, clientY: y }] });
  globalThis.__te({ changedTouches: [{ clientX: x, clientY: y }] });
};

test('T-01b：新档初始库存 = 默认值（读档 merge，无写档）', () => {
  assert.deepStrictEqual(main.inv, { undo: 3, shuffle: 1, addBottle: 1 });
  assert.deepStrictEqual(main.granted, {});
});

test('T-04：首入发放 —— 首入 L1 发放并持久化 granted / inventory；重进不重复发', () => {
  main.scene = 'levelSelect';
  main.tick();
  const p = center(renderer.levelBtns[0]);
  tap(p.x, p.y);
  assert.strictEqual(main.scene, 'game');
  assert.deepStrictEqual(main.inv, { undo: 3, shuffle: 2, addBottle: 2 }, 'L1 首入应 shuffle/addBottle 各 +1');
  assert.strictEqual(store.get('juicesort_granted')[1], true, '应持久化发放标记');
  assert.deepStrictEqual(store.get('juicesort_inventory'), main.inv, '应持久化背包');
  // 二次进入（重开同关 / 返回再进）不重复发
  main.loadLevel(0);
  assert.deepStrictEqual(main.inv, { undo: 3, shuffle: 2, addBottle: 2 }, '重复进入不应重复发放');
  assert.strictEqual(Object.keys(store.get('juicesort_granted')).length, 1);
});

test('T-05：撤回消耗背包且持久化', () => {
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
  assert.ok(src >= 0, '应存在合法倒法');
  logic.pour(src, to);
  const undoBefore = main.inv.undo;
  const p = center(renderer.undoBtn);
  tap(p.x, p.y);
  assert.strictEqual(logic.moveCount, 0, '应撤回一步');
  assert.strictEqual(main.inv.undo, undoBefore - 1, '撤回应消耗背包 1 个 undo');
  assert.deepStrictEqual(store.get('juicesort_inventory'), main.inv, '扣减后应持久化');
});

test('T-06：撤回耗尽 —— 弹广告浮层，看广告 +1 可继续用；撤销操作正常执行', () => {
  logic.pour(...findMove());
  main.inv.undo = 0;
  const p = center(renderer.undoBtn);
  tap(p.x, p.y);
  assert.strictEqual(main.adConfirm, 'undo', '耗尽应弹广告确认浮层');
  main.tick();
  const w = center(renderer.adConfirmWatchBtn);
  tap(w.x, w.y);
  assert.strictEqual(main.adConfirm, null);
  assert.strictEqual(main.inv.undo, 1, '看广告后应补充 1 个');
  assert.deepStrictEqual(store.get('juicesort_inventory'), main.inv, '补给后应持久化');
  // 补给后可继续使用：再撤一步应成功且扣减
  main.inv.undo = 1;
  logic.pour(...findMove());
  const u = center(renderer.undoBtn);
  tap(u.x, u.y);
  assert.strictEqual(main.inv.undo, 0);
});

test('T-05b：打乱/加瓶消耗背包；耗尽转广告补给', () => {
  // 打乱：进入选瓶模式 → 点瓶执行 → 扣 1
  main.inv.shuffle = 2;
  const s = center(renderer.shuffleBtn);
  tap(s.x, s.y);
  assert.strictEqual(main.shuffleSelecting, true);
  const idx = logic.bottles.findIndex((b) => new Set(b.map((c) => (c >= 0 ? c : -c - 1))).size > 1);
  assert.ok(idx >= 0, '应存在多色瓶');
  const bp = center(renderer.bottleRect(idx));
  tap(bp.x, bp.y);
  assert.strictEqual(main.inv.shuffle, 1, '打乱成功应扣 1');
  assert.deepStrictEqual(store.get('juicesort_inventory'), main.inv, '扣减后应持久化');
  // 耗尽 → 广告浮层 → 补给
  main.inv.shuffle = 0;
  tap(s.x, s.y);
  assert.strictEqual(main.adConfirm, 'shuffle');
  main.tick();
  const w = center(renderer.adConfirmWatchBtn);
  tap(w.x, w.y);
  assert.strictEqual(main.inv.shuffle, 1, '广告补给 +1');

  // 加瓶：扣 1 与耗尽补给
  main.inv.addBottle = 1;
  const n = logic.bottles.length;
  const a = center(renderer.addBottleBtn);
  tap(a.x, a.y);
  assert.strictEqual(logic.bottles.length, n + 1);
  assert.strictEqual(main.inv.addBottle, 0, '加瓶成功应扣 1');
  tap(a.x, a.y);
  assert.strictEqual(main.adConfirm, 'addBottle', '加瓶耗尽应弹广告浮层');
  main.tick();
  const w2 = center(renderer.adConfirmWatchBtn);
  tap(w2.x, w2.y);
  assert.strictEqual(main.inv.addBottle, 1, '广告补给 +1');
});

test('T-08：出厂废除 —— 无 grant 关进关不改变背包；库存跨关保持', () => {
  main.loadLevel(3); // L4：无 grant
  assert.deepStrictEqual(main.inv, { undo: 0, shuffle: 1, addBottle: 1 }, '进关不应重置背包');
  main.loadLevel(4); // L5：无 grant
  assert.deepStrictEqual(main.inv, { undo: 0, shuffle: 1, addBottle: 1 });
});

test('T-04b：L11 首入发放（模拟已解锁）—— 发放一次、重复进入不再发', () => {
  main.granted = {}; // 模拟未发放过
  store.set('juicesort_granted', {});
  main.loadLevel(10); // L11
  assert.strictEqual(main.inv.shuffle, 2, 'L11 首入 +1 打乱');
  assert.strictEqual(main.inv.addBottle, 2, 'L11 首入 +1 加瓶');
  assert.strictEqual(store.get('juicesort_granted')[11], true);
  main.loadLevel(10);
  assert.strictEqual(main.inv.shuffle, 2, '重复进入不重复发');
  assert.strictEqual(main.inv.addBottle, 2, '重复进入不重复发');
});

test('B-03：首入发放写序（先库存后标记，宁重发不吞发）+ 冷启动跨实例不重发', () => {
  // 写序：拦截 setStorageSync，重放 L31（章首关）首入发放，断言先写库存、后写 granted 标记
  const calls = [];
  const origSet = globalThis.wx.setStorageSync;
  globalThis.wx.setStorageSync = (k, v) => {
    calls.push(k);
    store.set(k, v);
  };
  try {
    main.granted = {};
    store.set('juicesort_granted', {});
    main.loadLevel(30); // L31：章首关，重新发放
    const iInv = calls.indexOf('juicesort_inventory');
    const iGrant = calls.indexOf('juicesort_granted');
    assert.ok(iInv >= 0, '应持久化库存');
    assert.ok(iGrant > iInv, `应先写库存后写发放标记（inventory@${iInv}, granted@${iGrant}）——写序中断时宁重发不吞发`);
  } finally {
    globalThis.wx.setStorageSync = origSet;
  }

  // 冷启动：持久化存档（标记在档）→ 重新 new Main()（新实例新起局）→ 重进已发放关不重发
  store.set('juicesort_granted', { 31: true });
  store.set('juicesort_inventory', { undo: 5, shuffle: 6, addBottle: 6 });
  const main2 = new Main();
  assert.deepStrictEqual(main2.granted, { 31: true }, '新实例应读到持久化发放标记');
  main2.loadLevel(30); // L31 已发放关
  assert.deepStrictEqual(main2.inv, { undo: 5, shuffle: 6, addBottle: 6 }, '冷启动重进已发放关不应改变库存');
  assert.strictEqual(main2.granted[31], true, '不应重发（标记保持）');
});

test('B-04：重置进度清理赠送标记 —— reset 后章首关赠送可重新获得（背包资产保留）', () => {
  // 新实例干净起局：标记在档 → 首入不重发
  store.set('juicesort_granted', { 31: true });
  store.set('juicesort_inventory', { undo: 3, shuffle: 4, addBottle: 4 });
  const m = new Main();
  m.loadLevel(30); // L31 章首关
  assert.deepStrictEqual(m.inv, { undo: 3, shuffle: 4, addBottle: 4 }, '标记在档 → 不重发');
  // 重置进度：granted 标记清空（内存 + 持久化），背包资产保留
  m.resetProgress();
  assert.deepStrictEqual(m.granted, {}, '重置进度应清空赠送标记（内存）');
  assert.strictEqual(store.has('juicesort_granted'), false, '重置进度应清除持久化赠送标记');
  assert.deepStrictEqual(m.inv, { undo: 3, shuffle: 4, addBottle: 4 }, '背包资产保留');
  // 重置后重新进入章首关 → 再次发放
  m.loadLevel(30);
  assert.deepStrictEqual(m.inv, { undo: 3, shuffle: 5, addBottle: 5 }, '重置后章首关应重新发放');
  assert.strictEqual(store.get('juicesort_granted')[31], true, '重发后标记重新持久化');
});

test('调试协议：数量变化写入 __dbg_state（invUndo/invShuffle/invAddBottle）', () => {
  main.inv.undo = 9;
  main.inv.shuffle = 8;
  main.inv.addBottle = 7;
  main._dbgSig = ''; // 强制签名失配
  main._dbgTs = 0;
  main.syncDebugState();
  const dbg = store.get('__dbg_state');
  assert.ok(dbg, '应写入调试快照');
  assert.strictEqual(dbg.invUndo, 9);
  assert.strictEqual(dbg.invShuffle, 8);
  assert.strictEqual(dbg.invAddBottle, 7);
});

/** 找一个合法倒法（当前局面） */
function findMove() {
  for (let f = 0; f < logic.bottles.length; f++) {
    for (let t = 0; t < logic.bottles.length; t++) {
      if (f !== t && logic.canPour(f, t) > 0) return [f, t];
    }
  }
  return null;
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
