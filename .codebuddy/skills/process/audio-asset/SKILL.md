---
name: audio-asset
description: 免费音频素材（音效/BGM）搜索与下载能力。当用户需要为游戏/应用寻找、下载可商用的免费音效或背景音乐（"找音效""下载BGM""免费商用音频素材""替换合成音效"）时使用。封装 Mixkit 直链解析/下载脚本与素材站选型知识，下载带授权留档。
---

# Audio Asset：免费音频素材搜索与下载

为游戏/应用获取**可商用、免署名**的音效（SFX）与背景音乐（BGM）。核心工具 `scripts/fetch-mixkit.mjs`（Node ≥18 零依赖），站点知识见 `references/sites.md`（含直链规律、踩坑、已验证素材 id 表）。

## 工作流

### 1. 明确需求清单
先梳理目标项目需要哪些音频（读项目音效模块或问用户）：事件音效（tap/pour/win…）+ 是否要 BGM + 体积预算（小游戏主包通常 4MB 上限）。

工具脚本两个：
- `scripts/fetch-mixkit.mjs` — Mixkit 清单/下载（list / download 子命令）
- `scripts/mp3-utils.mjs` — mp3 时长测量 / 帧级裁剪（measure / trim 子命令，零依赖替代 ffmpeg）

### 2. 列候选（list 子命令）
```bash
node <skill>/scripts/fetch-mixkit.mjs list sfx water pour     # 分类+标题关键词过滤
node <skill>/scripts/fetch-mixkit.mjs list sfx click
node <skill>/scripts/fetch-mixkit.mjs list music game         # BGM 按 tag
```
- 分类参考：sfx 用 `water / click / win / wrong-answer / success / game`；music tag 用 `game / casual / upbeat`
- 输出为 `id<TAB>标题`，按标题语义挑选候选

### 3. 下载候选 + 测时长（download + mp3-utils measure）
```bash
node <skill>/scripts/fetch-mixkit.mjs download <项目>/temp/audio-candidates sfx 2826=pour 1124=tap
node <skill>/scripts/mp3-utils.mjs measure <项目>/temp/audio-candidates
```
- **下载到 `temp/` 暂存，附时长/大小表格呈报用户试听选择——严禁自行替换入包**（2026-11-02 用户明确纪律）
- 每个用途给 3+ 个候选；manifest.json 自动记录来源/许可/日期
- ⚠️ 文件大小不可靠估时长：Mixkit SFX preview 统一 128kbps，同尺寸时长可能差 3 倍，**必须实测**

### 4. 缩短素材三板斧（无需 ffmpeg）
- **选短的**：先按实测时长挑天然短的素材（最优解）
- **加速播放**：`src.playbackRate.value = N` → 时长 ÷N、音调 ×N（pour 2x → 1.8s，水声加速自然）；测试桩无此属性需判空
- **硬截/裁剪**：播放端 `src.start(t, 0, dur)` 截断；文件端 `mp3-utils.mjs trim` 帧级裁剪（BGM 整曲→循环段必用，2.7MB→40s≈1.4MB）

### 5. 呈报试听清单，等用户选定后入包
向用户输出表格：用途、文件、素材名、实测时长、推荐理由。用户拍板后才替换 `assets/audio/`，并同步更新项目授权留档（如 `docs/audio-licenses.json`）。入包属代码改动，走项目对应流程。

### 6. 响度归一（离线分析，零运行时开销）
素材定稿后跑一次：
```bash
node <skill>/scripts/analyze-sfx.mjs <项目>/assets/audio --out gains.json
```
- 原理：无头 Edge/Chrome 解码 → 按实际发声段 RMS 对齐目标响度 0.15（峰值保护防削波，限幅 [0.5,3]）
- 把输出的 `const GAINS = {...}` 粘贴进游戏音频模块的静态增益表（如 `audio.js` 顶部）
- **不要在游戏内做运行时逐样本分析**（用户 2026-11-02 拍板：离线评估进配置，减少开销）
- 素材更换或裁剪/加速参数变化后需重跑刷新
- **人工微调走调音台**（公式对持续音调类素材会失准——如 complete 是人耳敏感频段的警报音，主观响度高于实测 RMS）：
  ```bash
  node <skill>/scripts/gen-sfx-tuner.mjs <项目>/assets/audio --gains '<当前GAINS JSON>'
  ```
  用户逐颗拖滑杆试听（可勾循环），点「生成 GAINS 配置」复制回贴，AI 更新静态增益表即可

## 接入微信小游戏要点（water-sort 实测）

- 加载：`wx.getFileSystemManager().readFileSync('assets/audio/x.mp3')`（不传编码得 ArrayBuffer）→ `ctx.decodeAudioData`（回调/Promise 双式兼容 + feature-detect，测试桩缺此方法时静默回落合成音）
- **iOS WebAudio 需用户手势解锁**：BGM 挂在首次 `wx.onTouchStart` 后起播，开关切换联动 stop/play
- 每次播放新建 BufferSource（天然支持 pour 高频重叠触发）
- **向项目目录写任何文件（含 assets/audio/）触发 IDE watch 重编译 → scene 重置 menu**——验证链要重新导航
- BGM 循环用帧级裁剪的素材 `src.loop = true`，循环接缝为硬切；介意则后续用 ffmpeg 加淡入淡出

## 许可红线

- 首选 Mixkit（Mixkit Stock License：免费、可商用、免署名）；manifest.json 必须随素材保留
- **cc-by-nc（非商用）一律排除**；Freesound 逐条许可混杂需逐个核对
- 站点对比与不可脚本化的站（Kenney/Pixabay）见 `references/sites.md`

## 关键坑（详见 references/sites.md）

1. 解析/下载逻辑一律用 mjs 脚本文件，禁止 PowerShell 内联 `node -e` 写正则（易混入不可见字符）
2. Mixkit SFX 的 `-preview.mp3` 即完整音效；BGM 直链**无** `-preview` 后缀，两者格式不同
3. BGM 整曲 3~4MB，小游戏入包前必须裁 30~60s 循环段 + 降码率
4. 向项目目录写文件可能触发 IDE 重编译——素材暂存放 `temp/`，截图/中间产物走系统临时目录
