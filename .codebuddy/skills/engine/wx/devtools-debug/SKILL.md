# 微信开发者工具调试（devtools-debug）

通过官方 MCP server 驱动微信开发者工具：编译、截图、日志、运行时执行，
配合备用系统级通道（PrintWindow 截图）完成小游戏/小程序的 AI 视觉调试闭环。

**触发条件**：用户要求"编译 / 跑起来看看 / 截图验证 / 调试小游戏"，
或需要 AI 亲眼验证运行效果时使用。

## 通道架构（按优先级）

| 优先级 | 通道 | 能力 | 状态 |
|---|---|---|---|
| 1 | **统一 CLI**（`scripts/wx.mjs`，需 IDE `--inspect=9229`） | **状态读取（免截图）/ 可信点击 / 画布截图 / 等待场景 / 几何** | ✅ 定稿（2026-10-27） |
| 2 | **MCP**（`scripts/wxmcp.mjs`） | 编译 / 截图 / console 日志 / 渲染层 JS | ✅ 稳定（走 IDE 服务端口；截图/console 可能读旧实例 s0） |
| 3 | **PrintWindow**（`scripts/printwin.mjs`） | 整窗截图（无需前台/不受遮挡/锁屏可用） | ✅ 稳定 |

> 已废弃通道（勿再投入）：automator 9420（长期挂起）、系统级 RPA（点击打不进
> Chromium 内容区）、CDP `--remote-debugging-port`（只暴露默认 session 空壳）、
> sendInputEvent mouse→touch（翻译层时开时关）。

## MCP 快速用法

所有脚本均为**通用脚本**：项目路径默认取**当前工作目录**，可用环境变量 `WX_PROJECT=<项目路径>` 覆盖；
工具安装目录 / MCP Token 可用 `WX_TOOLS_DIR` / `WX_MCP_TOKEN` 覆盖。项目专属的测试脚本不放本 skill，放项目 `tests/` 下（通过 import 复用 `wxmcp-lib.mjs`）。

```bash
# 截图（→ <project>/screenshots/mcp-<name>.jpg）
node <skill>/scripts/wxmcp.mjs shot menu

# 重新编译 + 编译后截图
node <skill>/scripts/wxmcp.mjs refresh

# 读模拟器 console（grep 过滤）
node <skill>/scripts/wxmcp.mjs console error

# 渲染层执行 JS（注意：是渲染层，非游戏逻辑层！）
node <skill>/scripts/wxmcp.mjs eval "function(){return document.title}"

# 任意 MCP 工具调用 / 查参数 schema
node <skill>/scripts/wxmcp.mjs call simulator_screenshot '{"project":"G:/prj/presonal/water-sort","path":".../x.jpg"}'
node <skill>/scripts/wxmcp.mjs schema automation_evaluate
```

（`<skill>` = `.codebuddy/skills/engine/wx/devtools-debug`；在项目根目录执行时可直接用相对路径）

也可直接配置为 CodeBuddy MCP（见 `.codebuddy/mcp.json`），获得原生工具调用。

## 标准 AI 调试工作流（状态驱动，免截图）

> 核心：**逻辑层与渲染层分离**——`wc.executeJavaScript` 跑在渲染层，读不到游戏实例；
> 但两层共享 storage。游戏按**协议 v2**（`syncDebugState()` 写 `__dbg_state` 快照：
> 状态字段 + 自描述按钮表 btns，签名变化即写 + 2s 心跳）接入，CLI 从渲染层读取——
> **不用截图就能知道当前场景，不用读渲染代码就能点按钮**（tbtn 语义点击，
> 坐标真源 = 游戏自己算的布局值，UI 改版零维护，永不猜错坐标）。
> **语义全部由快照自描述（scenes/when/alias/base），工具零硬编码——
> 任何小游戏按 [ADAPTATION.md](ADAPTATION.md) 接入即用**。

```bash
W=.codebuddy/skills/engine/wx/devtools-debug/scripts/wx.mjs

node $W state                    # 当前 scene/level/pause/age（age>5s = STALE，可能重载中）
node $W btns                     # 列出可按名点击的按钮及坐标（坐标=游戏布局真源，自动跟随改版）
node $W tbtn play                # 按语义名点击（首选！自动场景校验防误点，坐标零维护）
node $W tbtn level 3             # 点关卡卡片 3（1 起）；tbtn bottle 0 点瓶（0 起，倒水测试）
node $W tbtn back                # 返回（menu/settings/levelSelect/game 语义自适应）
node $W tap 195 467 play --expect menu     # 兜底：按坐标点击 + 前后状态对比
node $W wait game 8000           # 轮询等待场景切换（进关动画后用）
node $W snap                     # 关键节点才截图（默认输出系统临时目录，防项目内写入触发重载）
node $W cap                      # 胶囊 rect + webview 几何（校准坐标用）
```

**纪律**：
- 多步流程连续 tap（紧凑执行），只在起点/终点/异常分支 snap
- tap 输出 `场景A → 场景B ✓CHANGED/(unchanged)`——unchanged 不一定是失败，
  结合 expect 判断；scene 不符先 `state` 确认再重走导航
- **严禁向项目目录（含 temp/）写文件**：IDE watch 触发重编译 → guest 重载 → scene 重置 menu
  （"莫名回主菜单"之谜的根因，见 EXPERIENCE.md 2026-10-27）
- guest 重载后 CDP Input domain 挂起：wx.mjs tap 已内置 5s 超时保护，
  报 INPUT_TIMEOUT 时先对残留 debugger 会话 detach 再重试

## 关键 MCP 工具速查（47 个，常用如下）

| 工具 | 用途 | 通道 |
|---|---|---|
| `simulator_screenshot` | 截图（path + imageWidth/Height，默认优化 1280 长边 JPEG） | 服务端口 ✅ |
| `simulator_refresh` | 触发重新编译 | 服务端口 ✅ |
| `get_simulator_console` | console 日志 grep（参数 `command: "grep -n -i xxx"`） | 服务端口 ✅ |
| `automation_evaluate` | 渲染层执行 JS（参数 `action:'evaluate'` + `fnSource`） | 服务端口 ✅ |
| `automation_game_action` | 画布 tap/swipe | automator ❌ 本机挂起 |
| `open_project_window` / `close_project_window` | 项目窗口管理 | 服务端口 ✅ |
| `automation_wx_api` | wx API 调用/mock/恢复 | 多半 automator ❌ |

## 已知限制（重要）

1. **automator 通道（9420）在本机长期挂起**：`cli auto` 报 ✔ 后 connect 仍无响应。
   `automation_game_action`（触摸）等依赖它的工具返回 status 0 但无实际效果。
   （Nightly 与稳定版均复现；根因未明，见 EXPERIENCE.md §automator）
2. **automation_evaluate 在渲染层**：`GameGlobal` 是 window 别名（document/navigator 可见），
   但游戏逻辑层对象（`GameGlobal.main`、游戏类）不可见——不能用它直接驱动游戏逻辑。
3. **MCP 首次连接需授权**：报 "Client authorization pending" 时，去工具界面点击授权确认。

## 维护约定

- **临时脚本一律放 `temp/scripts/`**（用后即删），**不放 `tools/`**——tools/ 是正式工具目录，
  只放长期维护的工具（如 `solve-report.mjs`）；一次性诊断/探测脚本进 temp/scripts 并随调试闭环清理
- **踩坑经验统一记录在 `EXPERIENCE.md`**，每次调试遇到新问题/新解法，追加更新（按日期分节）
- **screenshots/ 为过程产物**：截图/日志以 `mcp-`、`pw-`、`uiauto-` 前缀区分来源，
  调试闭环结束后清理（保留供当次分析的最少量证据）
- 脚本变更后先 `read_lints`，且所有脚本必须带超时（历史教训：无限挂起浪费大量排查时间）

## 文件清单

```
devtools-debug/
├── SKILL.md            本文档
├── ADAPTATION.md       游戏适配指南（协议 v2：__dbg_state 快照 + btns 自描述按钮表，跨项目接入用）
├── EXPERIENCE.md       踩坑经验（定期更新）
└── scripts/            全部为通用脚本（WX_PROJECT/WX_TOOLS_DIR/WX_MCP_TOKEN/WX_INSPECT_PORT 可覆盖）
    ├── wx.mjs          统一 CLI：state/btns/tbtn/tap/snap/wait/cap（CDP 点击 + 协议 v2 语义消费，通道 1）
    ├── wxmcp-lib.mjs   MCP 会话库（startSession/withTimeout，供 CLI 与项目测试脚本 import）
    ├── wxmcp.mjs       MCP CLI 薄壳（shot/refresh/console/eval/open/call/schema），基于 wxmcp-lib
    └── printwin.mjs    PrintWindow 整窗截图（备用通道；job 临时文件写项目 temp/devtools-debug，运行后自动清理）
```

> 历史：wx-tap.mjs / wx-snap.mjs 已并入 wx.mjs（2026-10-27）；MCP 截图可能是
> 旧实例 s0 的陈旧帧，状态判断一律用 `wx.mjs state`。
