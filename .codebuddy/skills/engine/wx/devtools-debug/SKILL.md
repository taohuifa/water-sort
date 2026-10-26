# 微信开发者工具调试（devtools-debug）

通过官方 MCP server 驱动微信开发者工具：编译、截图、日志、运行时执行，
配合备用系统级通道（PrintWindow 截图）完成小游戏/小程序的 AI 视觉调试闭环。

**触发条件**：用户要求"编译 / 跑起来看看 / 截图验证 / 调试小游戏"，
或需要 AI 亲眼验证运行效果时使用。

## 通道架构（按优先级）

| 优先级 | 通道 | 能力 | 状态 |
|---|---|---|---|
| 1 | **MCP**（`scripts/wxmcp.mjs`） | 编译 / 截图 / console 日志 / 渲染层 JS | ✅ 稳定（走 IDE 服务端口） |
| 2 | **PrintWindow**（`scripts/printwin.mjs`） | 整窗截图（无需前台/不受遮挡/锁屏可用） | ✅ 稳定 |

> 已废弃通道（勿再投入）：automator 9420（长期挂起）、系统级 RPA（点击打不进
> Chromium 内容区，截图被 PrintWindow 完全覆盖，脚本已删除，经验沉淀在 EXPERIENCE.md）。

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

## 标准 AI 调试工作流（视觉伺服）

1. `wxmcp.mjs refresh` — 重新编译（改代码后）
2. `wxmcp.mjs shot <name>` — 截图，AI 读图识别游戏场景
3. （触摸通道修复前）人工配合操作，或用 `wxmcp.mjs console` 验证日志
4. `wxmcp.mjs shot <name2>` — 再次截图对比验证

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

- **踩坑经验统一记录在 `EXPERIENCE.md`**，每次调试遇到新问题/新解法，追加更新（按日期分节）
- **screenshots/ 为过程产物**：截图/日志以 `mcp-`、`pw-`、`uiauto-` 前缀区分来源，
  调试闭环结束后清理（保留供当次分析的最少量证据）
- 脚本变更后先 `read_lints`，且所有脚本必须带超时（历史教训：无限挂起浪费大量排查时间）

## 文件清单

```
devtools-debug/
├── SKILL.md            本文档
├── EXPERIENCE.md       踩坑经验（定期更新）
└── scripts/            全部为通用脚本（WX_PROJECT/WX_TOOLS_DIR/WX_MCP_TOKEN 可覆盖路径与凭证）
    ├── wxmcp-lib.mjs   MCP 会话库（startSession/withTimeout，供 CLI 与项目测试脚本 import）
    ├── wxmcp.mjs       MCP CLI 薄壳（shot/refresh/console/eval/open/call/schema），基于 wxmcp-lib
    └── printwin.mjs    PrintWindow 整窗截图（备用通道；job 临时文件写项目 temp/devtools-debug，运行后自动清理）
```
