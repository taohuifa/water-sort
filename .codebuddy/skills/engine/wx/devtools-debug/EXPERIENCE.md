# 踩坑经验总结（EXPERIENCE.md）

> 调试微信开发者工具过程中实测踩过的坑与解法。每次调试有新发现，**按日期追加**到对应章节。
> 最后更新：2026-10-27

## 目录
- [automator 通道（9420）](#automator-通道9420)
- [MCP 通道（服务端口）](#mcp-通道服务端口)
- [Windows 系统级 RPA](#windows-系统级-rpa)
- [PowerShell 脚本工程](#powershell-脚本工程)
- [微信开发者工具行为](#微信开发者工具行为)
- [2026-10-25 追加](#2026-10-25-追加)

---

## automator 通道（9420）

### 症状
`cli auto --auto-port 9420` 输出 ✔ auto、端口监听正常、`automator.connect()` 秒连成功，
但 **systemInfo / screenshot / evaluate 等所有 API 永久挂起或 Connection closed**。
Nightly v2.01 与稳定版 2.02.2608080 均复现。

### 已排除的原因
| 假设 | 验证结果 |
|---|---|
| 服务端口未开 | 排除（开启后症状不变） |
| 残留会话/双客户端互顶 | 排除（单客户端干净环境下依旧） |
| CLI 被脚本带走（stdio 断开） | 排除（`cli auto` 本就是一次性命令，✔ 后 0.1s 退出是正常行为） |
| 工具窗口未以自动化模式打开 | 排除（关闭工具让 CLI 重新拉起后依旧） |
| 白屏/游戏未加载 | 排除（游戏画面正常时依旧；Nightly 时代另有红条 "Request initialize failed: specified module could not be found"，稳定版无红条但症状相同） |

### 未解
根因未定位。怀疑与系统环境（企业安全软件/网络栈）有关。
**结论：本机勿再投入 automator 排查时间，直接走 MCP 通道。**

### 相关衍生
- `miniprogram-automator-next`（社区修复版 SDK）同样只修了启动侧问题，API 挂起无解
- `automation_game_action`（MCP 的画布 tap）内部依赖 automator → 本机同样无效（返回 status 0 但无实际效果，具有欺骗性）

## MCP 通道（服务端口）

### 配置两大坑
1. **`wechatide` 不在 PATH**：官方"复制 MCP 配置"给的 `command: "wechatide"` 无法解析（ENOENT）
2. **`.cmd` 被 Node spawn 拒绝**：BatBadBut CVE 修复（Node ≥18.20/20.12）使 spawn `.cmd/.bat` 报 EINVAL

**解法**（`.codebuddy/mcp.json` 已落地）：command 直接指向 202MB 的
`微信开发者工具.exe`（Electron 本体），args 复刻 `wechatide.cmd` 内部逻辑：
`["-e", <bootstrap JS>, <resources\app.asar.unpacked\js\common\cli\skill-index.js 完整路径>, "mcp", "--token=<token>"]`，
env 设 `ELECTRON_RUN_AS_NODE=1`（Electron 以 as-Node 模式跑 JS）。

### 授权机制
- 首次连接报 `Client authorization pending`（JSON-RPC error -32603）
- **工具界面会出现授权确认（wechatide://skill/auth 回调机制），需人工点击**
- **授权不持久**：过一段时间（或某些条件）后会重新 pending，需再次人工确认——
  wxmcp.mjs 已内置 3 次重试（每次等 10s），期间到工具界面点授权即可

### evaluate 的执行上下文（重要）
`automation_evaluate` 在**渲染层**执行：
- `GameGlobal` 存在但只是 window 别名（document/navigator/performance 可见）
- `wx` 可用；`getCurrentPages`/`__wxConfig`（逻辑层特征）前者无、后者有
- **游戏逻辑层对象（GameGlobal.main、游戏类）完全不可见**——不能直接驱动游戏逻辑
- 探测代码：`function(){ return { gg: typeof GameGlobal, win: typeof window, main: typeof GameGlobal.main }; }`

### canvas 渲染层探测结果（2026-10-25）
- 渲染层有 `document.querySelectorAll('canvas')`，小游戏主 canvas id=`myCanvas`
- 实测 `780x1688`（物理像素），`rect 390x844`（逻辑）→ dpr=2
- **但 evaluate 的 fnSource 里 `document.querySelector` 报 "is not a function"**（首次探测成功、
  第二次失败——上下文可能不稳定，待查）。渲染层合成 TouchEvent 派发方案搁置中

## Windows 系统级 RPA

- **CodeBuddy 派生的 shell 附着在非交互 window station 且不稳定**：
  直接截屏/注入会间歇性黑屏、`GetForegroundWindow()=0x0`、`CopyFromScreen` 报 handle invalid。
  解法：UI 操作经 `schtasks /Create /Run /IT` 在交互桌面执行（uiauto.mjs 已内置）
- **会话锁屏时一切 UI 操作无效**（`OpenInputDesktop` 返回 0）：RDP 断开自动锁屏；
  解锁后 `tscon 1 /dest:console` 可保持会话活跃
- **SendInput/mouse_event 点击对 Chromium 内容区无效**：原生标题栏/菜单有效，
  Electron 窗口内容区（包括工具 UI 与模拟器）不响应合成输入——RPA 点击路线死路
- **PrintWindow（flags=3 PW_RENDERFULLCONTENT）对 Electron 窗口有效**：无需前台、
  不受遮挡、连窗口超出屏幕的部分都能截——这是"看"的最稳通道
- devtools 主窗口定位：**稳定版窗口标题 = 项目目录名**（如 `water-sort`）；
  旧版为 `<项目名> - 微信开发者工具`。`Get-Process` 的 MainWindowHandle 可能指向
  最小化幽灵窗口（-32000,-32000），须 EnumWindows 按标题+可见性锁定
- 窗口可能残留在已断开的第二显示器坐标（屏幕外）：SetWindowPos 移回主屏 (0,0)
- 前台锁定绕过：模拟 ALT 按下 + SetForegroundWindow + HWND_TOPMOST

## PowerShell 脚本工程

- **PS5.1 读无 BOM 的 UTF-8 ps1 按 ANSI 解析**：含中文时字节错位会吞换行符，
  产生随机解析错误。所有含中文的 ps1 必须带 BOM（Node 写入时 `\ufeff` 前缀）
- **schtasks /TR 内嵌引号会破坏任务定义**（任务启动即失败）：/TR 内路径不加引号（确保无空格）
- **job 内 `exit` 会跳过 done 标记写入**：Node 侧只见"超时"看不到真实错误
- **schtasks job 的 Write-Output 丢失**：唯一有效输出通道是往 done 文件 `Add-Content`
- **运行时 Add-Type 在 schtasks 环境可能编译失败**（错误明细被吞）：预编译 DLL
  （`build-winapi.ps1` → `WinApi.dll`，job 里 `Add-Type -Path` 加载）
- C# 内字符串必须双引号（单引号是 char）；PowerShell 命令行传 JSON 参数会被引号剥离，写文件执行

## 微信开发者工具行为

- **`cli auto` 是一次性命令**：`✔ auto` 后 CLI 立即退出（exit 0），stdin 保活无效，
  9420 端口由 devtools 进程自己监听
- **`cli.bat` 的真实机制**：`ELECTRON_RUN_AS_NODE=1` + 找 >50MB 的 Electron 本体 +
  `-e <bootstrap> <resources\app.asar.unpacked\js\common\cli\index.js> %*`
- **工具目录结构（Electron 化后）**：根目录没有 node.exe（只有 node.dll），
  `next` 版 SDK 的 resolveCliRunner 检测失败会退回 shell+bat 模式（带空格路径炸）
- **服务端口与自动化端口是两回事**：安全设置里的"服务端口"（本机 20856）供 CLI/MCP 通信；
  `--auto-port 9420` 是 automator 专用。CLI 报"服务端口已关闭"时：工具 UI 开启
  （设置→安全设置），或 CLI 交互 y 确认（部分版本此交互损坏）
- **`.cli` 文件**（User Data\<hash>\Default\.cli）记录 IDE server 端口，过期值会导致 CLI 误报
- devtools 白屏 ≠ 崩溃：冷启动加载 10s+，等待后重截
- 预览打包报 "invalid file"：`.codebuddy` 等 skill 目录要加进 project.config.json 的 packOptions.ignore
- **User Data 多 hash 目录**：每个版本一个（如 2ca4252f/80d77482），CLI 只认自己安装对应的目录；
  自动更新后旧 CLI 与新 IDE 版本错位会报 "IDE has been properly installed"

## 2026-10-25 追加

- MCP 通道全链路验证通过：compile(refresh) ✅ / screenshot ✅×4 / console ✅ / evaluate(渲染层) ✅
- `automation_game_action` tap 实测无效（依赖死的 automator 通道）；曾有一次"成功进关卡选择"
  的假象，复跑不可再现——结论以多次复测为准，勿凭单次成功下结论
- **`automation_evaluate` 也会整体超时**：模拟器 refresh 重启后连续 3 次返回
  `{"success":false,"error":"timeout waiting for automator response"}`——它内部也经
  automator 桥接，通道状态劣化时整条 evaluate 不可用（此前的渲染层探测是好的时候测的）。
  遇到该报错不要反复重试，改走截图 + console 观测
- **MCP 工具软失败有欺骗性**：工具失败时 MCP 层 `isError=false`，正文才是
  `{"success":false,...}`——只查 isError 会得到 exit 0 假成功。wxmcp-lib 的 `call()`
  已加正文 `success:false` 识别，退出码真实
- `simulator_refresh` 后立刻截图会全黑（模拟器还在启动，console 只剩基础库日志）：
  等待 6-10s 再截（smoke 测试里的 5s 不够，冒烟截图全黑是时序问题非功能问题）
- skill 脚本通用化改造：项目路径一律 `WX_PROJECT` 环境变量 || CWD（不再 6 层上溯
  硬绑定 skill 所在工程）；会话逻辑抽到 wxmcp-lib.mjs 供项目 tests/ import 复用
- `get_simulator_console` 参数是 `command: "grep -n -i <pattern>"`（不是 grep/n 字段）
- wxmcp.mjs 合并了此前 8 个散装 MCP 脚本的功能（call/schema/shot/refresh/console/eval/verify/flow）
- skill 目录从 `.codebuddy/skills/wx-devtools-uiauto/` 迁移至 `.codebuddy/skills/engine/wx/devtools-debug/`

## 2026-10-25 追加 2（视觉调试）

- 视觉验证用「红块探针」必须画在 `draw()` 末尾（不透明背景图之后）：画在
  drawBackground 之前会被背景图完全盖住，造成"编译不生效"的误判（链路其实是好的）
- refresh 后等 ~10s 再截图确认为必要：1s 内拍到的是重启前旧帧（与既有 6-10s 记录一致）
- `simulator_screenshot` 的 `imageWidth` 参数实测不生效（固定 289x625 长边优化），
  需要看细节时别指望放大，靠多次迭代对比
- **IDE 编译会"卡死"（refresh 返回 success 但bundle 不更新）**：表现为连续多次 refresh+
  截图内容哈希不变。解法：先调 `open_project_window`（返回 reuse 也有效）唤醒 IDE，
  再 refresh 即恢复正常。判断是否陈旧帧：改一个必然可见的场景变化（如 debug 自动进关）
  对比截图；单靠静态场景截图哈希相同不能区分"没重编译"和"画面没变"
- 批量生成素材时，文生图对"细长竖条" subjects 有系统性画细倾向（要求 1:3 实出 1:12）。
  对策：prompt 强调"非常粗壮，宽度占画面宽度 85% 以上"+ 用 1:2 画布，出图后裁边拉伸到目标比例

## 2026-10-27 追加（方案B 定稿：点击工具落地 + 关键坐标系）

### 最终工具（scripts/，IDE 需 --inspect=9229 启动）
- **`wx-snap.mjs <out.png>`**：游戏画布原生截图（canvas.toDataURL，780x1688，
  **1px = 0.5 游戏逻辑单位**）。比 MCP 截图可靠：无缩放歧义、无陈旧帧、无双实例混淆。
  AI 读图按**比例**定位（读图显示尺寸≠实际像素，务必用分数定位）→ ×(390,844) 得游戏坐标
- **`wx-tap.mjs <gameX> <gameY>`**：CDP 可信触摸注入。支持 `--img <px> <py> <w> <h>`
  （MCP 截图像素坐标自动换算）与 `--info`（打印几何）。内部动态读 webview 元素位置换算
- 闭环已验证：menu→设置→返回→关卡选择→进关 全流程精确命中

### 关键坐标系（全部实证）
- 游戏画布 390x844（canvas CSS rect @0,0，zoom=1，guest innerWidth=390/innerHeight=844）
- MCP 截图 273x591 = webview 元素显示尺寸，与画布等比 ×0.7（与窗口尺寸无关，画布恒 390x844）
- CDP Input.dispatchTouchEvent 坐标 = **宿主页面视口**（非 guest！）：game→CDP =
  elOrigin + game×0.7，elOrigin 动态读取（当前 (72.5,90.5)）。校准实证：CDP(196,466)→DOM touch@(176,536)
- sendInputEvent(mouse) 坐标 = guest 视口（390x844），但 **runtime 的 mouse→touch 翻译层
  时开时关**（TS@ 时有时无，疑似 IDE 检查器 touch-mode 开关）→ 不可依赖；
  CDP touch 走真实触摸管线，稳定 ✓

### 观测通道的坑（重要）
- **MCP 截图可能是陈旧帧或另一个模拟器实例（s0）的画面**：存在双实例（s0=旧全 IDE 窗口
  最小化，s1=纯模拟器 lite 窗口），MCP screenshot/console 可能读 s0 → 状态误判。
  **状态确认一律用 wx-snap（画布原生）或 printwin（窗口真实像素）**
- MCP console 读的是"项目当前会话"的 console，多实例时埋点日志可能读不到
- guest 的 `document` 是 gameservice shim：无 hasFocus/getElementById、visibilityState
  读数不可信、eval 被禁——guest executeJavaScript 写探测代码必须全防御式（裸引用
  devicePixelRatio 等会 ReferenceError 使整段脚本失败）
- V8 inspector 坑：evaluate 返回的 Promise 必须 `(globalThis.__p = ...)` 挂全局保活，
  否则 "Promise was collected"；getAllWebContents 遍历需 isDestroyed() 守卫
- 模板字面量套模板字面量传正则：源码 `\\/` 两层转义（4 层会炸 "Invalid regex flags"）
- 一次性诊断脚本已清理；点击/截图工具固化为 wx-tap.mjs / wx-snap.mjs

### 未完全收尾的线索
- **（2026-10-27 已解，见下一节）**"点卡片/点返回偶发回主菜单"谜团已定案：
  wx-snap 写 PNG 触发 IDE 重编译重载所致，与点击无关

## 2026-10-27 追加 3（目录约定 + 坐标封装分析）

### 临时脚本目录约定
- **temp/scripts/** = 一次性诊断/探测脚本（用后即删）；**tools/** = 长期维护的正式工具
  （仅 solve-report.mjs）。AI 生成临时脚本一律进 temp/scripts，勿污染 tools/

### ⑥ tbtn 语义点击（按钮坐标表，2026-10-27 落地；同日升级协议 v2 自描述）
- **思路**：按钮 rect 真源在 renderer 实例属性（menuPlayBtn/backBtn/levelBtns/bottleRects
  等全部现成），`syncDebugState()` 快照带 `btns` 表（签名含 levelScroll 使滚动坐标刷新）
- **协议 v2（同日抽象，见 ADAPTATION.md）**：btns 条目自描述——对象型
  `{xy, scenes, when?}`、数组型 `{alias, base, list, scenes}`；when 值 `true`=字段真值、
  其他=严格相等。**wx.mjs 删除 BTN_SCENES/BTN_OVERLAY 硬编码，语义全部从快照读取**——
  工具变为跨项目通用，新游戏按 ADAPTATION.md 写 ~30 行 syncDebugState 即接入
- **tap/tbtn 输出通用化**：CHANGED 判定 = 快照顶层字段全量 diff（除 t/btns），
  报告变化字段名（如 ✓CHANGED(scene,pause)）——"哪些字段算状态"也由游戏自定义
- **价值实证**：back=34,60 自动读出（此前人算 34,30 全 miss 的坑不会再犯）；
  UI 改版/换分辨率坐标自动跟随，工具零维护；AI 跑流程无需读 renderer 布局代码
- 验证：tbtn play→level 17→back→pause_exit 全链路一次通过；pause=false 时 tbtn pause_exit
  被 when 条件正确拒绝；menu 下 tbtn back 场景校验拒绝；tbtn bottle 0/1 选中+倒水 ✓

## 2026-10-27 追加 2（三大谜团定案 + 坐标修正）

### ① "莫名回主菜单"根因 = wx-snap 写文件触发 IDE 重载（实锤）
- **机制**：wx-snap 向项目内 `temp/` 写 PNG → IDE 文件监视把 temp/ 变化当项目变更 →
  触发小程序重新编译 → guest 页面 reload → `scene` 重置为初始值 `'menu'`
- **验证手段**：guest 侧 `window.__rlMarker = Date.now()` 重载标记（executeJavaScript 装载，
  幂等；重载后 marker 消失/变值）。实测：每次 wx-snap 写 PNG 后 1~2 秒内 marker 必变值
- **全部历史异常 100% 吻合**：e2→e3 / d3→d4 / 单独 back 实验的"tap 后回菜单"都发生在
  snap 写 PNG 之后；flow-marker 实验（纯 executeJavaScript 零文件写入）marker 全程 alive
- **操作纪律（关键）**：
  - 多步流程必须**单脚本连续执行且零文件写入**（参考 temp/final-run.mjs 模式）
  - snap 只能放在流程**最末尾**做最终验证；中途观测用 executeJavaScript 读内存状态
  - temp/ 不在 IDE watch 白名单里，写入同样触发重载——诊断脚本写一次就停，
    写完等 5s 让重载完成再开始操作

### ② back 按钮坐标修正：capCenterY=60，不是 30
- `renderer.backBtn = { x: 34, y: capCenterY }`，capCenterY 来自
  `wx.getMenuButtonBoundingClientRect()`（模拟器实测 top=44, h=32 → **中心 y=60**），
  fallback 30 只是无胶囊环境用——**模拟器里 tap (34,30) 全部 miss（距圆心 30 > r 18）**
- 历史上"back 点击无反应/直接 menu"一半是这个原因（tap 打到棋盘空白处），一半是重载
- 正确坐标：**back(34,60)**；读取方法：guest executeJavaScript 调
  `wx.getMenuButtonBoundingClientRect()`（不需要 debugger attach）

### ③ guest reload 后 CDP Input domain 挂起的处置
- **症状**：重载后 wx-tap 的 `debugger.sendCommand("Input.dispatchTouchEvent")` 永久挂起
  （Runtime.evaluate awaitPromise 整体超时），但 Runtime domain 消息正常回流、
  `executeJavaScript` 完全正常——只有 Input domain 死
- **诊断阶梯**：主进程 inspector ping(1+1) → directRequire/getAllWebContents →
  `wc.debugger.isAttached()`（残留 true = 死会话）→ `detach()` 同步可用 →
  attach 后 `Runtime.enable` 有响应 → Input 仍死
- **解法（实测有效）**：detach → 重新 attach → `Page.bringToFront` +
  `Emulation.setFocusEmulationEnabled(true)` → Input 恢复（2ms 响应）
  （也可能是 IDE 稳定后自愈，两者都做最稳）
- **预防**：wx-tap 挂起超时后，不要无脑重试——先 detach 残留会话再重试

### ④ 一次触摸只派发一次 onTap（已排除的嫌疑）
- `bindTouch`：touchstart 记录起点 → touchend 位移<8px 才派发 onTap——无双派发，
  之前怀疑的"start/end 各触发一次"不成立

### ⑤ storage 桥状态读取（免截图快速分支，2026-10-27 落地）
- **前提事实**：逻辑层与渲染层分离——`wc.executeJavaScript` 跑渲染层，
  `GameGlobal.__app`（逻辑层实例）不可见（实测 ggKeys 全是 window 属性）；
  但 **两层共享 storage**：渲染层 `wx.getStorageSync` 能读到逻辑层
  `wx.setStorageSync` 写的数据（juicesort_cleared=30 实证）
- **实现**：`main.js` 的 `syncDebugState()`（tick 末尾调用）——状态签名
  `[scene,pause,level,sel,win,ad,shuf,cleared]` 变化立即写 `__dbg_state`，
  稳态 2s 心跳刷时间戳；`wx.mjs state` 读快照并按 age 判活（>5s STALE）
- **工具**：`wx.mjs` 统一 CLI（state/tap/snap/wait/cap）取代 wx-tap/wx-snap：
  - `tap --expect <scene>` 点击前校验场景，防误点（教训：pauseExitBtn(195,470)
    与 menuPlayBtn(195,467) 几乎重叠，场景判断错时点"退出"会变成点"play"）
  - tap 输出前后状态对比，`wait <scene>` 轮询等待切换——**多数场景免截图**
  - snap 默认输出系统临时目录（项目内写文件 = 触发重载）
- 全链路验证：state→tap play(--expect menu)→lv2(--expect levelSelect)→
  back(34,60)(--expect game)→exit(--expect game) 四步全 ✓CHANGED，零截图

### 全链路最终验证（零写入单脚本，temp/final-run.mjs 模式）
back(levelSelect)→play→lv2→back(34,60)→**BK:pause toast + 暂停浮层出现**（截图实证）→
exit(195,470)→主菜单 ✓。pauseExitBtn 中心 (195,470)；menuPlayBtn 中心 (195,467)——
**场景判断错时 (195,470) 会误点 play**（曾致"退出后竟在选关页"），tap 前务必确认 scene
- **2026-10-27 复测更新**：加 HUD 埋点（dbgLog 事件流画在画布上）后完整复测
  menu→选关→进第 2 关 **全流程成功**，事件流 T:menu→OPEN:LS→T:levelSelect→SEL:1→LOAD:1
  逐条正确。此前两次"卡片点击回菜单"均发生在**选关页长停留（>20s，中间夹着人工读图）之后**——
  怀疑选关页长时间闲置后模拟器/运行时状态漂移（未定论）。
  **操作纪律：每步 tap 后立刻 wx-snap 验证，发现场景不符预期时先重走导航再继续，
  不要对"上一步应该还在的场景"做假设**

## 2026-10-26 追加 3（方案B：CDP 死路 + Node inspector 突破）

### CDP `--remote-debugging-port=9222` — 死路，勿再投入
- 端口能开（Chrome 138 / Electron 37），`/json/version`、`/json/list`、browser 级
  `Target.getTargets` 全试过：**只有 1 个 target = UGit app-6.2.0 的空壳启动页**
  （47 个 DOM 节点，desktop-app-container，无 webview/iframe）
- 项目窗口（water-sort）与模拟器 webview 都在同一进程但**不在默认 session**——
  Electron 官方文档限制：remote debugging 只挂默认 session 的页面，partition
  session 的 webContents 完全不可见
- `--remote-port 3799`（进程参数里那个）不是 CDP，未监听

### Node inspector `--inspect=9229` — 正确路线（实验中）
- **启动方式**：`cli.bat quit` 退干净 → `Start-Process 微信开发者工具.exe -ArgumentList "--inspect=9229"`
  → `http://127.0.0.1:9229/json/list` 拿 ws 地址 → Node 22 原生 WebSocket 直连
- **主进程代码注入**：`Runtime.evaluate` 执行 JS；`require` 不在全局（CJS 模块作用域），
  **`directRequire('electron')` 可用**（cli bootstrap 注入的全局），`process.mainModule.require` 也可以
- **V8 inspector 经典坑**：evaluate 返回的 Promise 若无引用会被 GC → 报
  "Promise was collected"——必须 `(globalThis.__p = new Promise(...))` 挂全局保活
- `webContents.getAllWebContents()` 遍历时旧对象可能已销毁（"Object has been destroyed"），
  必须逐个 try/catch + `isDestroyed()` 守卫；webview guest 无 `isVisible()`
- **模拟器结构**（多开时按 session 编号取最大）：宿主窗口页（electron-project-lite.html）
  → `<webview>`「小游戏运行时」（URL `/game/sN/.../gamePage.html`，canvas `myCanvas`
  390x844 @0,0，zoom=1，**guest CSS 坐标 = 输入坐标，无换算**）
- **注入验证（探针实证）**：对 guest `sendInputEvent`（mouseMove+mouseDown+mouseUp）→
  事件到达（trusted=true、坐标零偏移）→ **runtime 自动 mouse→touch（TOUCHSTART 触发）**→
  游戏真实响应：主菜单→选择关卡→进第 2 关全流程成功（mcp-repro-2.jpg）
- **宿主层注入无效**：对宿主 webContents sendInputEvent 不会路由进 guest webview，直接对 guest 注入
- **未解决问题：送达间歇性**——后续复测 4/4 注入被吞（guest 探针 `window.__clicks` 活着但零记录），
  怀疑窗口焦点丢失（IDE 启动时前台、被 shell 活动顶掉后注入被丢）。
  验证脚本 `temp/cdp-focus.mjs`（读焦点状态 → win.focus()+wc.focus() → 再注入）已写好未跑
- 复用点击工具骨架：`temp/cdp-click.mjs`（`node temp/cdp-click.mjs <x> <y>`，画布逻辑坐标）
- MCP 通道与 --inspect 共存无冲突：服务端口/MCP 工具照常可用

## 2026-10-26 追加 2（tap 根因深挖，app.asar 取证）

- **automation_game_action 完整链路**（app.asar 可直接 latin1 grep，实现已明文）：
  MCP → IDE `Tool.invokeGameMethod` → `invokeGameInteraction(method)` →
  `IEnvMessagerService2.invoke(APPSERVICE, GAME_DRIVER_COMMAND)` → 游戏 webview 内
  driver（inspector_v1/inject.js，AES 加密、key 硬编码在 app.asar）→
  `document.getElementById("myCanvas")` → `new Touch/TouchEvent` →
  `canvasProto.dispatchEvent.call(canvas, ev)`（touchstart+touchend）→ **无条件返回 {status:0}**
- **status 0 语义 = "canvas 找到且 dispatchEvent 调用过"，fire-and-forget，不代表游戏收到**
- **console 实证**：tap 命令确实到达 driver（`[Driver.game] Driver.game.tap {x:196,y:466}`），
  坐标换算正确——断点在最后一段：合成 DOM TouchEvent 通常进不了
  「模拟器→逻辑层 wx.onTouchStart」的真实输入管线；偶发成功（两天各 1 次）说明该链路
  状态相关（疑似 webview 实例漂移/转发监听状态），不可依赖
- **9420 automator 端口与 automation_game_action 无关**（tap 期间 netstat 实证零连接）——
  此前"tap 依赖 automator 通道"的结论有误，corrected：它走 IDE 内部 messager
- **automation_evaluate 是 driver 的 evaluate 分支，但用户代码跑在沙箱 shim**：
  无 Touch/TouchEvent/Event 构造器、document.getElementById/querySelector 缺失
  （querySelectorAll 反而可用）、canvas.ownerDocument.defaultView=undefined、eval 被禁
  → **沙箱内无法自派发触摸事件，渲染层合成触摸方案彻底死路**
- 可行替代方向：① 游戏侧调试 RPC（wx.connectSocket 连本机 WS server，直接调用游戏
  触摸 handler，确定性 100%，改自己代码）② IDE 加 `--remote-debugging-port` 走 CDP
  `Input.dispatchTouchEvent`（可信输入，走真实管线，不改游戏代码，待验证）
  ③ 真机 adb input tap

## 2026-10-26 追加（tap 复测）

- 结合 CLI V2 官方文档确认：CLI 本身没有任何模拟器点击/输入命令，`cli auto` 只是开启
  automator 端口；点击能力只在 automator SDK（MiniProgram/Element tap）和 MCP 的
  `automation_game_action`（内部同样桥接 automator）
- `automation_game_action` tap 再次复测（4 次独立点击，image 坐标空间，带截图前后对比）：
  仅第 1 次生效（主菜单→选择关卡），第 2~4 次全部无效（status 0 但画面不变，同会话
  连续 3 击均无反应）——与 10-25 "单次假象不可再现"结论一致，**tap 通道确认不可用**，
  不要再因偶发一次成功而改判
- PowerShell 下 `wxmcp.mjs call <tool> '<json>'` 的 JSON 引号会被 shell 剥离（单双引号
  都不行），必须写临时 .mjs 脚本 import wxmcp-lib.mjs 执行

## 2026-10-25 追加 3（白模板滤色）

- **本项目 devtools 环境（libVersion 3.17.4）`wx.createOffscreenCanvas` 不存在**（game 上下文
  报 not a function）。小游戏标准兜底：`wx.createCanvas()` 第二次及以后调用返回离屏画布
  （首次调用才是上屏 canvas），`getImageData/putImageData/drawImage(canvas)` 全部可用。
  离屏画布代码写成两者兼容：`typeof wx.createOffscreenCanvas === 'function' ? ... : wx.createCanvas()`
- 滤色（tint）方案落地验证：比值模板（byte = ratio × 127.5，2.0 高光余量）× 目标色逐像素
  乘法，PowerShell 侧从现有贴图反推（各色比值中位数 0.97~1.08，模型成立）；奶茶杯 8 张
  宽度不一（69~77px）无法逐像素对齐，改从单张（drink-4 蓝莓，色度与中性色分离最好）按
  chroma smoothstep(18,48) 拆 base/果汁两层，自重组误差 0.15%
- 滤色缓存构建失败会静默 catch 降级，截图看不出来——必须加一次性 console 标记
  （grep console）确认缓存真建成了，再清掉标记

## 2026-10-27 追加 4（液面帽素材管线 + PS 批处理坑）

### imagegen `transparent=true` 透明差分管线不可靠（重要）
- 白底+黑底两次渲染差分在**大面积纯色扁平形状**上会误判：9 张液面帽中 4 张
  （橙/芒果黄/青苹果/抹茶）主体出现黑色斑纹 + 大块透明区，渲染时透出白瓶身
  形成"泡沫块"。蓝/紫/奶白/灰紫/红 5 张正常——**损坏是概率性的，必须逐张肉眼验收**
- 解法：改走绿幕管线（`#00FF00` 背景 prompt + 严格色键 `G>200 && R<120 && B<120`，
  与 fix-apple-green.ps1 同口径），9/9 干净。近似色（青苹果浅绿 vs 绿幕）靠
  R<120 卡阈值区分（青苹果 R≈139 过不了键）
- 帽素材 prompt 要点：CONCAVE elliptical surface（中间下凹两端翘）、
  side outlines 向下延伸出图、**bottom OPEN 无边框**（否则拼接到柱身多一条横线）、
  白高光点+竖高光条

### 液面帽渲染三参数（renderer.js drawBottleLiquid）
- **帽要压扁**：素材 2.1:1 按宽度等比画出约 1.1 个层高，参考图液面弧仅 0.3~0.4
  层高 → 帽高 ×0.6，1 格带不再被帽子占满
- **mid 上缘内缩要够**：4px 仍会采到柱图圆顶描边残留（帽底平切线+残留线=双线），
  加深到 10px 解决
- **绘制顺序**：mid/bot 先画、帽最后叠加并向下多压 2px 盖住 mid 顶缘过渡像素；
  顺序反了残留线盖不住
- 跨素材色板偏差用后处理拉齐：采样柱图体色 vs 帽体色求每通道比
  （clamp 0.75~1.35），只调主体像素（白高光 min>230、深描边 max<100 不动）

### PS 批处理新坑
- **一行命令连环拉起多个 `powershell -File` 子进程时 `Add-Type -AssemblyName
  System.Drawing` 会随机失效**（类型找不到、byte[] 构造失败）——单独跑正常。
  解法：循环写进单个 ps1 脚本内单进程执行
- **GDI+ 保存回原路径报"一般性错误"/文件被锁**：`Image.FromFile` 的底层流不关。
  解法：字节流加载（`File.ReadAllBytes` → `MemoryStream` → `FromStream`，即时
  Dispose）+ 保存走 MemoryStream → `File.WriteAllBytes`

### 素材写入触发重载的连带效应
- 向 assets/ 写图片 → IDE watch 触发重编译 → guest reload。若正好打断图片加载，
  渲染器**静默降级到矢量画法**（无描边/无高光的纯色块），极易误判"改坏了"。
  素材写完后必须干净 refresh 一次再验证；`wx.mjs state` scene 重置回 menu 即重载标志
