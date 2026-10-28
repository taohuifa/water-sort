# AGENTS.md —— water-sort 开发协作指引

> 给 AI Agent / SubAgent 的项目入口文档。先读本文件，再按流程取用对应 Skill 与 SubAgent。
> 项目：缤纷果汁铺 JuiceSort —— 微信小游戏，经典倒水排序（Water Sort Puzzle）的果汁店主题变体。
> 技术栈：微信小游戏运行时 + Canvas 2D 手写渲染（无游戏引擎），代码包 JS ES Module，
> Node 侧工具链（测试 / 素材管线 / 调试协议脚本均为 .mjs）。

---

## 1. 文档导航

| 想了解 | 读哪个文件 |
|---|---|
| 玩法、进度、源码目录、关卡机制 | `README.md` |
| 玩法分析与完整复刻方案 | `docs/游戏分析与复刻方案.md` |
| 关卡难度曲线（30 关逐关显式配置，JSONC） | `assets/config/levels.json` |
| **美术素材与渲染方式规范（位图拼接 / 管线 / 禁止项）** | **`.codebuddy/rules/art-rendering.md`（改美术前必读）** |
| **美术验收闭环规范（截图证据 / 对比口径 / 归档）** | **`.codebuddy/rules/art-acceptance.md`** |
| 美术验收报告（液体/瓶子 v1~v7 全程证据链） | `docs/art-acceptance/2026-10-27-liquid-cap.md` |
| 关卡可解性验证 | `docs/解题报告-30关.md`（`tools/solve-report.mjs` 生成） |
| 微信小游戏开发领域知识 | `.codebuddy/skills/engine/wx/wechat-minigame-dev/` |
| 开发者工具调试协议（协议 v2 自描述） | `.codebuddy/skills/engine/wx/devtools-debug/SKILL.md` |
| 图片处理通用库 | `.codebuddy/skills/process/art-style/scripts/imgproc.mjs` + `README.md` |

SubAgent 定义：`.codebuddy/agents/`（prd-writer / impl-developer / integration-tester / code-reviewer）
流程 Skill：`.codebuddy/skills/process/`（prd / impl-doc / integration-test / code-review / code-optimize / art-style）
引擎 Skill：`.codebuddy/skills/engine/wx/`（wechat-minigame-dev 领域知识 / devtools-debug 调试 / weixin-minigame-helper CLI）
学习 Skill：`.codebuddy/skills/learn/code-learnability/`

---

## 2. 架构硬约束（一票否决）

```
js/
  main.js              入口：配置加载 / 触摸 / 主循环 / 场景状态机（menu|levelSelect|game|settings）/
                       调试协议 v2（syncDebugState 写 __dbg_state，按钮表自描述）
  core/                纯逻辑层（不依赖 wx，可独立 Node 测试）
    rng.js             种子随机数（关卡洗牌可复现）
    levels.js          颜色表 COLORS / .jsonc 解析 / 按配置生成关卡
    game.js            倒液规则 / 完成判定 / 撤回栈 / DFS 可解性
  render/              表现层
    renderer.js        Canvas 2D（位图素材拼接渲染；只读逻辑层数据）
    anims.js           轻量动画（倒水流线 / 飞行 / 抖动）
    audio.js           WebAudio 合成音效
  runtime/ads.js       激励视频广告封装（失败/开发模式降级发放）
assets/
  config/              levels.json / ads.json（JSONC，.json 扩展名过包内白名单）
  images/              运行时素材（平铺根目录；约 638KB 入包）
  images/liquid-src/   液体原图（参考图 / AI 原图 / 主图 / 白模）—— packOptions 排除
  images/bottle-src/   瓶子 AI 原图 —— 排除
  images/drink-src/    奶茶杯原图 —— 排除
tools/                 长期工具（全部 .mjs）：素材管线 ×2 / 备选抠图×2 / 重上色 / solve-report
tests/                 Node 单测（game.test.js / smoke.render.test.js / mcp-smoke.mjs）
```

| 层 | 必须 | 禁止 |
|---|---|---|
| `core/` | 纯函数 / 可注入 rng，Node 直接可测 | 依赖 `wx` / Canvas / 渲染层 |
| `render/` | 只读逻辑层数据（logic/state），位图 `drawImage` 拼接 | 自行做规则判定；程序化绘制充当美术（见 §6） |
| `main.js` | 场景状态机 + 调试协议同步 | 渲染细节、规则实现 |
| `runtime/` | 平台 API 薄封装 + 降级路径 | 业务规则 |

- 依赖方向单向：main → render → core；core 不反向依赖。
- 关卡数值（颜色数 / 空瓶 / 隐藏层 / 锁 / 大瓶）一律走 `assets/config/levels.json`，禁止硬编码进逻辑层。
- 洗牌/随机一律走 `core/rng.js` 注入 seed，保证可复现。
- 调试协议 v2（storage 桥）：逻辑层 `syncDebugState()` 写 `wx.setStorageSync('__dbg_state', {scene, t, 自定义字段..., btns})`；btns 自描述（对象型 `{xy, scenes, when?}` / 数组型 `{alias, base, list, scenes}`）；签名变化即写 + 2s 心跳。新增可交互元素必须同步补进 btns 表。

---

## 3. 开发流程（四阶段，每阶段完成必须停下等用户确认）

```
想法 → ① 需求 PRD（用户确认） → ② 实现设计 + 编码 + 测试 → ③ 集成验证 → ④ 代码审查 → 归档清理
                    ↑ 未确认不得进入 ②
```

| 阶段 | SubAgent | Skill | 产物 | 完成判据 |
|---|---|---|---|---|
| ① 需求 | `prd-writer` | `game-dev-prd` | `docs/prd/PRD-<特性>.md` | PRD 全文呈报，**用户确认** |
| ② 实现 | `impl-developer` | `game-dev-impl-doc` | 实现文档 + 代码 + 测试 | headless 回归通过 |
| ③ 验证 | `integration-tester` | `game-dev-integration-test` | `docs/integration/` 或 `docs/art-acceptance/` 验收报告 | 分层验证全绿 + **截图证据呈报用户** |
| ④ 审查 | `code-reviewer` | `game-dev-code-review` | 审查报告 + 下一步规划 | 报告全文呈报 |

### 关键顺序纪律

1. **① 未完成不准动代码**：方案未确认前只输出文档，不改任何代码文件。
2. **每阶段完成必须停下**：呈报结果 → 用户确认 → 才进下一阶段，禁止连续闷头推进。
3. **进入 ④ 审查前必须先给真机/模拟器验证清单**：提供用户可亲自执行的验证方法与命令（进关、操作、截图对比），确认通过后才进入审查。
4. **③ 视觉改动必须截图验收**：真机截图 + 参考图对比 + 放大细节，证据归档 `screenshots/archive/`，报告内嵌相对链接，**完成判定权在用户**。
5. **④ 只读审查**：code-reviewer 不改代码，问题交回 impl-developer 修。

---

## 4. 命令速查（工作目录 = 项目根，Node ≥18）

| 用途 | 命令 |
|---|---|
| 逻辑层单测（含 DFS 可解性） | `npm test` |
| 渲染/入口冒烟（wx 桩） | `npm run smoke` |
| 开发者工具编译刷新 | `node .codebuddy/skills/engine/wx/devtools-debug/scripts/wxmcp.mjs refresh` |
| 调试：查状态 / 点按钮 / 等场景 / 截图 | `node .codebuddy/skills/engine/wx/devtools-debug/scripts/wx.mjs state\|tbtn\|wait\|snap`（IDE 需 `--inspect=9229`） |
| 进关验证示例 | `wx.mjs tbtn play` → `tbtn level 16` → `snap` |
| 液体素材管线（AI 原图→9 色） | `node tools/process-liquid-ai.mjs [输入PNG]` |
| 瓶子素材管线（AI 原图→真透明玻璃） | `node tools/process-bottle-ai.mjs [输入PNG]` |
| 备选：参考图抠瓶 / 抠液体 / 蓝基重上色 | `node tools/extract-bottle-ref.mjs` / `extract-liquid-ref.mjs` / `recolor-liquid.mjs` |
| 关卡可解性报告 | `node tools/solve-report.mjs` |

---

## 5. 测试约定

- 测试一律放 `tests/`（不进 `js/`，不放根目录），命名 `*.test.js` / `*.mjs`。
- 逻辑层测试 Node 直接跑（core 不依赖 wx）；渲染冒烟用 wx 桩。
- 关卡改动必须重跑 DFS 可解性验证（`game.test.js` / `solve-report.mjs`）。
- 临时调试脚本放 `temp/scripts/`（**用后即删**，不 git；长期工具才进 `tools/`）。

---

## 6. 美术素材规范（2026-10-27 定稿，改美术前必读 `.codebuddy/rules/art-rendering.md`）

**核心原则：美术元素一律素材位图拼接（drawImage 切片/拉伸），禁止 API 程序化绘图。**
（`fillRect`/`ellipse`/`path` 充当液体、器皿、装饰同禁；例外仅 `fillText` 文本与选中框等交互提示。）

### 素材生产标准管线

```
AI 生成（imagegen 图生图，参考图输入，透明底直出）
  → 清边 cleanEdges（alpha 阈值 230 切光晕 → 腐蚀 2px → 羽化 → 白污染反解）   ← AI 生成物带光晕是常态，不可省
  → 分路线：
      多色族: whiteMap（白模，p = 127.5×L/Lbody）→ tint 滤色 9 色（暗部乘 shade、亮部向白渐近）
      玻璃器皿: glassPx（瓶身白底全透明清除，高光留 12% 淡影、投影 35%、描边实心）
  → bbox 裁剪 → resize（预乘 alpha 防渗色）→ 成品
```

- 通用库：`.codebuddy/skills/process/art-style/scripts/imgproc.mjs`（纯 JS + pngjs，跨平台；从 GDI+ 迁移注意 pngjs 像素是 **RGBA** 顺序非 BGRA）。
- 亮部滤色**禁止通道相乘**（会把橙推成黄），必须向白渐近。
- 素材布局：运行时素材平铺 `assets/images/`；原图归档 `*-src/` 目录并保持 `project.config.json` packOptions.ignore 排除。

### 当前视觉定稿要点（v6.1/v7）

- 液体渲染：位图三段拼接（顶盖平顶+亮盘只画顶带、**每个液体块都有圆弧底**（浅弧下沉挂下一带顶部，底带全高收瓶底内）、主体中段拉伸；分界无直线分隔线）。
- 玻璃层级：**液体先画（globalAlpha 0.9）、真透明玻璃瓶后画套住液体**；瓶子三段式（顶 32% 固定 / 中段拉伸 / 底 12% 固定）；液宽 = 0.80 × 瓶外轮廓。
- 色表：`js/core/levels.js` COLORS 与滤色目标表（tools 管线内）必须同步修改；6 号色 = 奶昔 `#F3DDB4`。

### 验收闭环

视觉改动验收 = 进关截图（wx.mjs）+ 放大细节（裁剪输出**系统临时目录**，勿写项目内防 IDE 重载）+ 参考图对比 → 证据归档 `screenshots/archive/` → `docs/art-acceptance/` 报告内嵌相对链接 → **用户确认后才算完成**。

---

## 7. 打包与 git 边界

| 内容 | 入包 | 入 git | 说明 |
|---|---|---|---|
| `js/`、`game.js`、`game.json`、`assets/config/`、`assets/images/`（根） | 是 | 是 | 代码与运行时素材（≈638KB） |
| `assets/images/*-src/` | **否** | 是 | 原图（参考图 / AI 原图 / 主图 / 白模），packOptions.ignore 排除 |
| `tests/`、`tools/`、`docs/`、`screenshots/`、`temp/`、`package*.json`、`.codebuddy/`、`.vscode/` | **否** | — | packOptions.ignore 已配 |
| `temp/` | 否 | 否 | 临时工作区（调试脚本用后即删） |

---

## 8. 通用纪律（所有 Agent 必读）

1. **最小化改动**：先 `read_file` 再 `replace_in_file` 定向修改，禁止整文件重写，不删改无关内容。
2. **讨论阶段不改代码**：方案未确认前只输出文档。
3. **可逆性优先**：修复未验证通过前严禁删除诊断/调试代码；验证通过 → 确认解决 → 清理 → 复跑回归。
4. **视觉改动需截图验收**（见 §6），通过且用户确认后才算完成。
5. **git push 必须先经用户明确批准**：用户说 push 才执行；下次 push 前必须再问。commit 不受限。
6. **完整呈报**：PRD 拆分表、审查报告、建议清单必须在回复中完整呈现内容（做什么/为什么/怎么做），不能只给摘要表格。
7. **工具脚本一律 mjs**（跨平台，Node ≥18）：新工具进 `tools/`（长期）或 `temp/scripts/`（临时用后删）；通用图片处理复用 imgproc.mjs，不重造轮子。
8. 涉及玩法数值/判定条件的决策，信息不足时列开放问题问用户，禁止脑补。
9. **重载陷阱**：向项目目录写任何文件会触发 IDE watch 重编译 → guest reload → scene 重置 menu；验证流程中的截图/裁剪等中间产物一律走系统临时目录。

---

## 9. 当前状态

- 玩法五阶段全部完成（渲染/关卡/动画/道具/音效广告），30 关配置化。
- 玩法扩展已落地（2026-10-28）：道具背包 / 三星评价 / 遮盖瓶 / 炸弹瓶；关卡扩至 100 关（10 章 × 10 关，配置驱动）。
- 美术视觉管线 v7 定稿：AI 生成 + 白模滤色 + 真透明玻璃（证据链见 `docs/art-acceptance/`）。
- 新需求先走 §3 阶段 ①；美术调整先读 §6 与两份 rules。
