# 缤纷果汁铺 (JuiceSort)

微信小游戏 · 经典倒水排序 (Water Sort Puzzle) 的果汁店主题变体。
玩法分析与完整方案见 [docs/游戏分析与复刻方案.md](docs/游戏分析与复刻方案.md)。

## 玩法

- **菜单页**：开始游戏（有进度时显示"继续闯关"）/ 设置（重置关卡进度）
- **关卡选择页**：100 关（10 章 × 10 关，每章末大瓶 Boss）；打通前一关才解锁下一关（已通关 ✓ / 可挑战 / 锁定），通关卡显示最佳星数与道具库存
- **游戏内**：左上角返回按钮 → 弹出菜单（继续游戏 / 退出返回菜单，解锁进度保留）
- 点击源瓶选中，再点目标瓶倒水；点自己取消选中
- 倒法合法条件：目标瓶为空，或目标瓶顶层颜色与源瓶顶层相同
- 同色连续段整体转移，源瓶换色或目标瓶满即停
- **道具背包**（全局库存 `undo/shuffle/addBottle/revive`，章首关与每 5 关首入赠送，耗尽看激励视频广告补给）：撤销（消耗 undo）/ 打乱（按颜色段整体重排场上液体——段内不拆散、段间随机重排，隐藏层全部揭示，保证有解）/ 加瓶（临时增加一个空瓶中转位）/ **续杯**（失败弹窗消耗 1 个继续：限时 +60 秒 / 步限上限 +10 / 炸弹引信 +10 封顶初值，不回退局面；库存 0 可看广告补 1 后自动使用）。**重置进度会一并清空首入赠送标记**（章首/每 5 关赠送可重新获得），背包资产保留
- **限时 / 步数限制**（逐关配置 `timeLimit`/`moveLimit`，缺省 0 = 不限，存量关零影响）：限时关顶部居中显示 `mm:ss` 倒计时（≤10s 红 + 脉冲，暂停/弹窗打开时暂停计时，撤销不回退时间）；步限关右上角显示 `步数: N/M`（剩余 ≤5 变红，撤销回退步数一并回退）；归零/达限未通关弹失败面板（按原因区分文案），可续杯继续或重开。已全量铺量（PRD §2.1）：第 4 章起每章 2 关步限、第 7 章起每章 1~2 关限时 + L70/L90 Boss 调剂限时、L96~99 高配试用（双限/步限/限时）。禁配口径（不与炸弹同关、双限每章 ≤1）限第 4~9 章铺量关；L96~99 为试用高配关豁免（炸弹与限制可同关）
- **问号隐藏层**（第 4 关起）：下层颜色未知，倒出上层后立即揭示真实颜色
- **音效**：WebAudio 实时合成（选中/按钮/非法/倒水/完成/通关），设置页可开关（持久化）
- 凑满一瓶纯色 → 自动"制作"成成品饮料飞上货架，玻璃瓶腾空（多一个空瓶中转资源）
- 所有颜色分装完成即通关；无解时可撤回或重开

## 当前进度（方案 8.4 开发顺序）

- [x] 阶段一：瓶子渲染 + 点击选中 + 倒液规则（纯逻辑可玩）
- [x] 阶段二：满瓶判定 + 撤回 + 关卡数据（10 关，难度曲线递增）
- [x] 阶段三（简化版）：倒水流线动画 + 成品飞向货架动画
- [x] 阶段四：道具（打乱 / 加瓶子，每关各 1 次，可撤销）+ 问号隐藏层（第 4 关起，1~3 层）
- [x] 阶段五：WebAudio 合成音效（开关持久化）+ 激励视频广告点位（道具补给，开发模式降级）

## 源码目录

```
├── docs/                        // 方案文档
├── assets/config/               // 外部资源配置（打进小游戏包；.json 扩展名 + JSONC 带注释内容）
│   ├── levels.json              // 关卡难度曲线配置
│   └── ads.json                 // 广告位配置（adUnitId 留空 = 开发模式直接发放）
├── js
│   ├── core/                    // 纯逻辑层（不依赖 wx，可独立测试）
│   │   ├── rng.js               // 种子随机数（关卡可复现）
│   │   ├── levels.js            // 颜色表 + .jsonc 解析 + 按配置生成关卡
│   │   └── game.js              // 倒液规则 / 完成判定 / 撤回栈 / 关卡生成
│   ├── render/
│   │   ├── renderer.js          // Canvas 2D 渲染（货架/瓶子/液体/UI）
│   │   ├── anims.js             // 轻量动画（倒水流线/飞行/抖动）
│   │   └── audio.js             // WebAudio 合成音效（无需音频文件）
│   ├── runtime/
│   │   └── ads.js               // 激励视频广告封装（失败/开发模式降级发放）
│   └── main.js                  // 入口：加载配置/适配/触摸/主循环/进度
├── tests/                       // Node 单元测试（不参与小游戏打包）
│   ├── game.test.js             // 逻辑层单测（含 .jsonc 解析 + 100 关可解性验证）
│   ├── cover/bomb/stars/inventory/progress100/timelimit.test.js // 遮盖/炸弹/三星/背包/进度/限时步限续杯单测
│   └── smoke.render.test.js     // 渲染/入口冒烟测试（wx 桩）
├── game.js                      // 小游戏主入口
├── game.json                    // 小游戏运行时配置
└── project.config.json          // 项目配置（已排除 tests/package.json/docs）
```

## 关卡生成机制

- **关卡外部配置化**：难度曲线配置在 `assets/config/levels.json`（100 关逐关显式记录，
  .json 扩展名 + JSONC 带注释内容——微信代码包文件读取有扩展名白名单，
  `.jsonc` 扩展名会被拒绝，故用 `.json` 存放 JSONC 内容，加载时剥离注释）
  ——每关颜色数/空瓶/容量/隐藏层/锁/遮盖/炸弹/大瓶/限时/步限/seed/par 均为逐关显式字段
  （限时 `timeLimit` 秒、步限 `moveLimit` 步，0 = 不限；生成约束 par ≤ moveLimit−2、timeLimit ≥ par×6，
  显式违例运行时自动放大 + warn），
  seed 一律固化（= seedBase + 关卡号，重摇关单独覆盖），关卡总数可改 `levelCount` 调整；
  可解性与最短步数报告见 `docs/解题报告-100关.md`（`node tools/solve-report.mjs` 生成）
- **加载链路**：入口 `js/main.js` 用 `wx.getFileSystemManager().readFileSync` 读取
  → `parseJsonc` 剥离注释解析 → `buildLevelsFromConfig(curve)` 生成关卡列表 →
  注入渲染层（逻辑层不读文件，保持可独立测试）
- **必有解保证**：随机分层发牌 + 内置 DFS 求解器验证有解，无解自动换 seed 重试
  （最多 60 次），同 seed 局面可复现，生成耗时 < 1ms

## 本地测试

```bash
npm test                        # 逻辑层单测全量（含全部 100 关生成可解性 + DFS 走通验证）
npm run smoke                   # 渲染/入口冒烟测试（wx 桩，无需开发者工具）
node tools/solve-report.mjs     # 关卡可解性报告（BFS par 回填 → docs/解题报告-100关.md；改关卡配置后必跑）
node tools/solve-report.mjs --from 71 --to 80   # 区间模式：只跑第 71~80 关（配置改动定向校验）
```

### 改动 → 相关用例（只跑需要的，日常勿全量）

每个测试文件头部标注了「▶ 何时跑我」。速查：

| 改动内容 | 该跑 |
|---|---|
| `js/core/game.js` 生成/倒液/撤销/可解性 | `npm run test:game` |
| `js/core/game.js` 生成状态机（beginGenerate/stepGenerate）或 `GEN_TOTAL_BUDGET_MS` 预算 | `npm run test:game` + `npm run test:gen` |
| `js/core/game.js` 遮盖 / 炸弹 / 限时步限（局部规则） | 对应 `test:cover` / `test:bomb` / `test:timelimit` |
| `js/core/inventory.js`、道具账本 / 首入 / 重置（main.js） | `npm run test:inventory` |
| `js/core/stars.js`、三星结算、par 回填 | `npm run test:stars` |
| `assets/config/levels.json` 关卡数值/字段 | 对应字段域套件 + `solve-report`（区间模式定向） |
| 关卡总数 / 存档解锁链路 | `npm run test:progress` |
| `renderer.js` / 交互浮层（任何 UI） | `npm run test:smoke`（UI 兜底） |
| core 规则大改 / 发版前 | `npm test` + `npm run smoke` 全量 |

## 运行

用微信开发者工具导入项目根目录即可预览（compileType: game，竖屏）。
