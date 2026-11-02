# 免费音频素材站对比与踩坑笔记

## 站点选型（2026-11 实测）

| 站点 | 许可 | 可否脚本直链下载 | 结论 |
|---|---|---|---|
| **Mixkit** (mixkit.co) | Mixkit Stock License：免费、可商用、免署名 | ✅ 直链无鉴权（见下） | **首选**，音效+BGM 一站式 |
| Kenney (kenney.nl) | CC0 | ❌ 下载直链含动态 hash，页面无静态 zip 链接 | 手动下载其 UI 音效包可用，脚本不友好 |
| Pixabay | Pixabay Content License | ❌ 下载需会话/JS | 备选，手动用 |
| Freesound (freesound.org) | 逐条 CC0/CC-BY/CC-BY-NC 混杂 | ❌ 下载需登录/API Key | 需逐条核对许可，慎用 NC 素材 |
| FreePD (freepd.com) | Public Domain | ⚠️ 部分路径 404（如 `/upbeat.php`） | BGM 备选，需先探路 |
| Sonniss GDC 捆绑包 | 免版税可商用 | 大文件年度 zip | 大批量专业音效备选 |

## Mixkit 直链规律（核心知识）

- **音效（SFX）**：
  - 分类页：`https://mixkit.co/free-sound-effects/{分类}/`（water / click / win / wrong-answer / success / game 等，每页约 36 条）
  - 页面结构：每个卡片有 `data-audio-player-preview-url-value="https://assets.mixkit.co/active_storage/sfx/{id}/{id}-preview.mp3"`，
    标题在该节点后 ~2000 字符内的 `<h2 class="item-grid-card__title">标题</h2>`
  - **`-preview.mp3` 就是完整音效**（音效都很短），直接下载即可
- **音乐（BGM）**：
  - 分类页：`https://mixkit.co/free-stock-music/tag/{tag}/`（game / casual / upbeat 等，每页约 16 条）
  - 直链：`https://assets.mixkit.co/music/{id}/{id}.mp3` —— **整曲、无 `-preview` 后缀**（与 SFX 格式不同，脚本要分开处理）
  - 整曲 3~4MB，小游戏入包前必须裁剪循环段 + 降码率

## 已验证可用的音效候选（water-sort 2026-11-02 定稿，可直接复用 id）

| 用途 | id | 标题 | 实测时长 |
|---|---|---|---|
| tap（选中） | 1124 | Plastic bubble click | 0.26s |
| button（按钮） | 2568 | Cool interface click tone | 0.26s |
| invalid（非法操作） | 2569 | Negative tone interface tap | 1.33s |
| pour（倒水） | 125 | Liquid poured in a jar with ice | 3.68s（播放端 2x 加速 → 1.8s） |
| complete（完成一瓶） | 2039 | Game success alert | 2.01s |
| win（通关） | 600 | Achievement bell | 2.46s |
| BGM | 787 | Love（80s 整曲） | 帧级裁剪 1s~41s → 40s 循环段 1.37MB |

备选池（曾入候选/试听）：1110 Click error 1.18s、3159 Wrong answer mech 2.06s、946 Wrong answer fail 2.01s、1317 Water bubble 0.50s、3000 Liquid bubble 1.12s、1311 Water splash 1.54s、2826 Pouring water in a glass 8.07s。

## 时长与「缩短」经验（2026-11 实测）

- **Mixkit SFX preview 统一 128kbps**——按文件大小估时长会严重失真（曾把 1.33s 估成 4s），选型前必须用 `mp3-utils.mjs measure` 实测
- 缩短三板斧（无需 ffmpeg，按优先级）：
  1. 选天然短的素材
  2. 播放端 `src.playbackRate.value = N`：时长 ÷N、音调 ×N（水声/打击乐加速自然；弦乐人声慎用）
  3. 播放端 `src.start(t, 0, dur)` 硬截，或文件端 `mp3-utils.mjs trim` 帧级裁剪（BGM 整曲 → 循环段专用，不重编码零音质损失）
- BGM 循环段裁剪点对齐帧边界即可，循环接缝为硬切；无缝循环需交叉淡化（ffmpeg）

## 踩坑记录

## 踩坑记录

1. **PowerShell 内联 `node -e` 写正则易混入不可见字符**导致语法错误 —— 解析/下载逻辑一律落成 .mjs 脚本文件执行。
2. 解析分类页时**不能用 `split('item-grid-card')`**：该字符串在页面 CSS/类名中多次出现，分块错乱；用单条正则全局匹配（preview-url → title 顺序）。
3. **站点不可达先探测**：内网/代理环境下先 `HTTP 200` 探测再批量下载，脚本已带错误处理，SKIP/ERR 不中断。
4. **授权留档**：下载时必须写 manifest.json（来源 URL / 许可 / 日期），入包素材可追溯，避免日后版权纠纷。
5. 许可红线：**cc-by-nc 一律排除**（非商用）；免署名许可也建议保留 manifest 留档。
6. **工作流纪律（用户明确要求）**：候选一律下载到 `temp/` 附实测时长呈报，**由用户试听拍板后才替换入包，严禁 AI 自行替换**。
7. **mp3 帧解析版本位映射**：MPEG 版本位 ver 3=MPEG1（144 系数/1152 样本）、2=MPEG2（72/576）、0=MPEG2.5——判断反了整体解析失败（曾把 40s 读成 0.8s）；用 `mp3-utils.mjs` 勿重造解析器。
