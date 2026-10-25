# 踩坑经验总结（EXPERIENCE.md）

> 调试微信开发者工具过程中实测踩过的坑与解法。每次调试有新发现，**按日期追加**到对应章节。
> 最后更新：2026-10-25

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
