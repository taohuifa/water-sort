# 游戏适配指南（ADAPTATION.md）

> 如何让**任何微信小游戏**接入 `wx.mjs` 调试工具（state / btns / tbtn 语义点击）。
> 本 skill 的通道层（inspector 连接 / CDP 触摸 / 截图）**零适配即可用**；
> 本文档只讲一件事：**游戏侧按协议 v2 写一份状态快照，即可获得免截图状态读取与语义级点击**。

## 为什么需要适配（背景）

- 微信小游戏**逻辑层与渲染层分离**：`wc.executeJavaScript` 跑在渲染层，读不到游戏实例
  （`GameGlobal.__app` 等逻辑层对象不可见）
- 但**两层共享 storage**：逻辑层 `wx.setStorageSync` 写的数据，渲染层 `wx.getStorageSync` 能读
- → 状态/按钮坐标经 storage 从逻辑层"桥"到渲染层，工具再从渲染层读出

## 协议 v2：`__dbg_state` 快照

游戏在主循环中低频写入 storage key `__dbg_state`（固定名）：

```js
wx.setStorageSync('__dbg_state', {
  // ---- 必填 ----
  scene: 'menu',        // 当前场景名（字符串，游戏自定义枚举；工具的场景判断/校验都基于它）
  t: Date.now(),        // 写入时间戳（工具按 age>5s 判 STALE，即"游戏可能正在重载"）

  // ---- 游戏自定义状态字段（可选，任意数量；state 命令原样平铺输出，tap 前后自动对比这些字段） ----
  pause: false, level: 2, sel: -1, win: false, cleared: 30, ...

  // ---- 按钮表 btns（自描述语义，tbtn 的全部依据，工具零硬编码） ----
  btns: {
    // 对象型按钮：一个语义名对应一个坐标
    play:        { xy: [195, 467], scenes: ['menu'] },
    back:        { xy: [34, 60],   scenes: ['levelSelect', 'settings', 'game'] },
    pause_exit:  { xy: [195, 470], scenes: ['game'], when: { pause: true } },
    // 数组型按钮：一组同类目标（关卡卡片 / 棋盘格子 / 列表项...）
    levels:   { alias: 'level',  base: 1, scenes: ['levelSelect'], list: [[49,159], [195,159], ...] },
    bottles:  { alias: 'bottle', base: 0, scenes: ['game'],        list: [[135,397], ...] },
  },
});
```

### 字段语义

| 字段 | 必填 | 说明 |
|---|---|---|
| `scene` | ✅ | 当前场景名。工具的 `wait <scene>`、`tap --expect <scene>`、tbtn 场景校验都基于它 |
| `t` | ✅ | 写入时间戳（ms）。判活依据 |
| 其他顶层字段 | ❌ | 游戏自定义状态。`state` 命令平铺输出；`tap/tbtn` 前后**自动 diff 这些字段**并报告变化名 |
| `btns.<name>.xy` | ✅（对象型） | 按钮中心坐标（游戏逻辑坐标系） |
| `btns.<name>.scenes` | ❌ | 可用场景列表；缺省 = 任意场景可点 |
| `btns.<name>.when` | ❌ | 前置状态条件：`{字段: true}` = 字段真值；其他值 = 严格相等（如 `{mode: 'hard'}`）。不满足则拒点 |
| `btns.<name>.alias` | ✅（数组型） | tbtn 调用名（如 `tbtn level 17`） |
| `btns.<name>.base` | ✅（数组型） | 序号起算值（1 = 关卡号从 1 起；0 = 索引从 0 起） |
| `btns.<name>.list` | ✅（数组型） | 坐标数组（含滚动等动态偏移，每次快照重算） |

## 游戏侧实现模板（约 30 行）

```js
// 主循环 tick() 末尾调用；构造器里初始化 this._dbgSig = ''
syncDebugState() {
  const sig = [this.scene, this.pauseOverlay, this.levelIndex, /* ...参与判变的字段 */,
               this.renderer.scrollY /* 滚动量——影响数组型坐标时必须纳入 */].join('|');
  const now = Date.now();
  if (sig === this._dbgSig && now - this._dbgTs < 2000) return; // 签名变化即写 + 2s 心跳
  this._dbgSig = sig; this._dbgTs = now;
  try {
    wx.setStorageSync('__dbg_state', {
      scene: this.scene, pause: this.pauseOverlay, level: this.levelIndex, t: now,
      btns: { /* 按上表声明，坐标直读 renderer 的布局属性（真源，UI 改版自动跟随） */ },
    });
  } catch (e) { /* storage 不可用时静默，不影响游戏 */ }
}
```

**要点**：
1. 坐标从**渲染层已算好的布局属性**直读（如 `renderer.menuPlayBtn`、`renderer.levelBtns`），
   不要在快照里重复计算——保证"所见即所点"
2. 滚动/动画影响坐标时，把滚动量纳入签名（否则快照坐标不刷新）
3. 快照 ~1KB 量级无压力；2s 心跳写一次 storage 开销可忽略
4. 生产环境可保留（纯写 storage 无副作用），或用编译开关剔除

## 工具行为（协议消费方式）

| 命令 | 消费协议 |
|---|---|
| `state` | 平铺输出除 `t/btns` 外全部顶层字段 + age（STALE 判定） |
| `btns` | 渲染按钮表（坐标 / scenes / when / alias / base） |
| `tbtn <name>` | 查 `btns[name]` → 校验 `scenes` + `when` → CDP 点击 |
| `tbtn <alias> <N>` | 按 `alias` 找数组型条目 → `list[N - base]` → 校验 → 点击 |
| `tap/tbtn` 输出 | 前后快照 diff（顶层字段，除 t/btns），报 `✓CHANGED(变化字段名)` |

## 参考实现

- 本项目（water-sort）：`js/main.js` 的 `syncDebugState()`（协议 v2 完整实现，
  16 个对象型按钮 + 2 个数组型，含 when 条件/滚动刷新）
