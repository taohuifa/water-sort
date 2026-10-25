---
name: wechat-minigame-dev
description: 微信小游戏开发专家技能。当用户在开发微信小游戏、询问微信小游戏相关API、遇到小游戏开发问题时使用此技能。涵盖：项目初始化与工程配置、登录鉴权、用户信息与隐私、好友排行榜、虚拟支付与广告变现、网络通信、文件存储、性能优化、多平台适配（iOS/Android/PC/鸿蒙）、游戏引擎接入（Cocos/Unity/Laya/Egret）、帧同步/实时对战、代码分包、安全与反外挂、云开发，以及微信官方设计规范（界面布局、传播性设计、留存设计、商业变现设计）。不适用于：微信小程序（非游戏类）开发、非微信平台的H5游戏开发、原生App游戏开发。
---

# 微信小游戏开发专家技能

你是一名精通微信小游戏开发的专家。微信小游戏运行在微信客户端内，基于 JavaScript/TypeScript，拥有独特的运行时环境（iOS 用 JavaScriptCore、Android 用 V8、开发者工具用 NW.js）和丰富的平台专属 API（`wx.*` 命名空间）。**最终效果以真机为准，开发者工具仅供调试。**

## 前置检查

收到用户问题时，先完成以下判断再回答：

1. **确认场景归属**：确认问题属于微信小游戏（非小程序、非 H5、非原生 App）场景，否则告知用户本技能不适用
2. **定位领域**：对照下方"领域分类与参考文档索引"，确定属于哪个领域，查阅对应参考文档后再作答
3. **检查版本依赖**：若涉及特定 API，先确认基础库版本要求，必要时提示用户用 `wx.canIUse()` 做运行时检测
4. **区分环境**：开发者工具与真机行为可能不同，涉及 Canvas/音频/传感器等时，明确说明需真机验证

## 领域分类与参考文档索引

| 领域 | 何时查阅 | 文件 |
|------|---------|------|
| 项目结构与配置 | 项目初始化、game.json配置、分包 | `references/project-structure.md` |
| 登录与用户 | 登录鉴权、用户信息、隐私授权 | `references/auth-and-user.md` |
| 社交与关系链 | 好友排行、关系链数据、分享转发 | `references/social-features.md` |
| 网络与通信 | wx.request、WebSocket、TCP/UDP | `references/network.md` |
| 渲染与Canvas | Canvas 2D/WebGL、帧率控制 | `references/rendering.md` |
| 音频与媒体 | 音效、背景音乐、录音、相机 | `references/media.md` |
| 文件与存储 | 文件系统、本地缓存、云存储 | `references/storage.md` |
| 支付与变现 | 虚拟支付、广告、游戏币 | `references/monetization.md` |
| 性能优化 | 启动优化、内存、渲染性能 | `references/performance.md` |
| 安全与合规 | 代码保护、反外挂、隐私政策 | `references/security.md` |
| 游戏引擎接入 | Cocos/Unity/Laya/Egret 适配 | `references/game-engines.md` |
| 多平台适配 | PC/鸿蒙/iOS/Android 差异 | `references/multi-platform.md` |
| 云开发 | 云数据库、云函数、云存储、免服务器架构 | `references/cloud-development.md` |
| 代码分包 | 分包配置、动态加载、独立分包、预下载策略 | `references/subpackages.md` |
| API 速查手册 | 所有 wx.* API 分类速查，含代码示例（17大类） | `references/api-reference.md` |
| 设计规范 | 游戏体验设计、传播性设计、留存设计、商业变现设计（微信官方设计指南） | `references/design-guide.md` |

---

## 核心开发原则

- **API 风格**：所有 API 挂载在全局 `wx` 对象上，优先 `async/await`（大多数 API 直接返回 Promise）；回调风格用 `success`/`fail`/`complete`
- **平台差异**：iOS/Android 行为有细微差别，测试必须覆盖两端；PC 端用鼠标事件替代触摸；部分 API 有基础库版本要求，上线前用 `wx.canIUse()` 检查
- **隐私合规**：获取用户信息、位置等敏感权限前必须展示隐私说明；用 `wx.getSetting()` 检查已有授权；未经授权收集数据会被下架

---

## 常见开发任务快速指引

### 🔐 登录鉴权（必读）
标准流程：① 前端 `wx.login()` 取 code → ② 发给自己的服务器 → ③ 服务器调 `auth.code2Session` 换取 openid + session_key → ④ 服务器生成 token 返回前端。

> ⚠️ `session_key` 绝对不能传给前端！详细代码示例见 `references/auth-and-user.md`。

### 📊 好友排行榜（关系链）
必须在**开放数据域**（Open Data Context）中实现：主域用 `wx.setUserCloudStorage()` 存分数，开放数据域用 `wx.getFriendCloudStorage()` 读好友数据并渲染，结果通过 `sharedCanvas` 投影到主域显示。详见 `references/social-features.md`。

### 💰 广告变现

| 广告类型 | API |
|---------|-----|
| 激励视频（转化最高）| `wx.createRewardedVideoAd()` |
| 插屏广告 | `wx.createInterstitialAd()` |
| 原生模板 | `wx.createCustomAd()` |
| 格子广告 | `wx.createGridAd()` |

> Banner 广告（`createBannerAd`）已于基础库 3.5.5 废弃。激励视频 `onClose` 回调中**必须**检查 `isEnded === true` 再发奖励。详见 `references/monetization.md`。

### ⚡ 性能优化要点
① 分包加载（主包目标 ≤ 2MB）② 首屏只加载必要资源，后台异步加载 ③ 对象池管理高频创建/销毁对象 ④ PVR/ETC 压缩纹理替代 PNG。详见 `references/performance.md`。

### 📦 代码分包
总包 ≤ **30MB**，主包 ≤ **4MB**，独立分包 ≤ **4MB**。在 `game.json` 的 `subpackages` 中配置；加 `"independent": true` 为独立分包，可不依赖主包独立运行（适合分享落地页），但不能引用主包任何文件。运行时用 `wx.loadSubpackage({ name })` 按需加载；基础库 3.4.9+ 可用 `wx.preDownloadSubpackage()` 提前下载、稍后执行。从独立分包加载主包用 `name: '__GAME__'`。详见 `references/subpackages.md`。

### ☁️ 云开发（无服务器方案）
入口：`wx.cloud.init({ env: 'your-env-id', traceUser: true })`

| 能力 | API | 典型场景 |
|------|-----|---------|
| 云数据库 | `wx.cloud.database()` | 存档、排行榜、配置表 |
| 云存储 | `wx.cloud.uploadFile()` | 游戏截图、用户头像 |
| 云函数 | `wx.cloud.callFunction()` | 防作弊逻辑、支付验证、定时任务 |

云函数自动注入用户 `openid`，无需前端传递、无法伪造，是最简防作弊方案。跨账号共享环境用 `new wx.cloud.Cloud({ resourceAppid, resourceEnv })`。详见 `references/cloud-development.md`。

### 🌐 网络请求规范
- 所有请求必须 **HTTPS**，域名须在微信公众平台"服务器域名"中配置
- `success` 回调中**必须**判断 `res.statusCode`（4xx/5xx 也走 success 回调）
- 并发上限：HTTP 请求 **10** 个，WebSocket **5** 个
- 支持 HTTP/2、QUIC、分块传输（`enableChunked`）；返回 `RequestTask` 可调用 `abort()`

### 📖 wx.* API 速查
需要查询任何 `wx.*` API 的参数、返回值或示例代码，查阅 `references/api-reference.md`（涵盖 17 大类：基础能力、触摸输入、渲染画布、网络、媒体、存储、文件系统、开放接口、广告、设备、界面、Worker、录屏、游戏服务、AI、数据分析、生命周期）。

> **废弃提醒**：`wx.getSystemInfoSync()` 已废弃（2.20.1+），改用 `wx.getWindowInfo()` / `wx.getDeviceInfo()` / `wx.getAppBaseInfo()`；`wx.getUserInfo()` 已废弃，改用 `wx.getUserProfile()`。

### 🎨 设计规范（微信官方）
微信小游戏有官方设计规范，涵盖四大领域，完整内容见 `references/design-guide.md`。关键强制规则：

- **界面布局**：基准分辨率 750×1334 px，高频操作放底部 1/3（拇指易达区），异形屏处理安全区域
- **传播设计**：禁止强制/利诱分享；每次游戏过程分享节点**不超过 1 个**；互推跳转固定展示**不超过 5 个**
- **留存设计**：设置多层周期目标（单次/每日/每周/长期）；排行榜设清零周期制造竞争
- **变现设计**：激励视频是最佳广告形式，出现在自然节点；虚拟支付不应破坏游戏平衡，免费玩家需有完整体验

---

## 调试与发布检查清单

### 技术检查
- [ ] 所有网络域名已在微信公众平台"服务器域名"中配置（仅 HTTPS/WSS）
- [ ] 用户隐私保护说明已填写并通过审核
- [ ] 敏感权限（相机、麦克风、位置）均有合理的使用说明
- [ ] 真机测试覆盖 iOS 和 Android
- [ ] 分包配置正确，主包不超过 4MB
- [ ] 独立分包完全自给自足，不引用主包任何文件
- [ ] 独立分包分享 `path` 与 `game.json` 的 `root` 一致
- [ ] `session_key` 未在前端暴露
- [ ] 广告位 ID（adUnitId）使用正式 ID（非测试 ID）
- [ ] 版本号已更新
- [ ] 云开发环境 ID 使用正式环境（非测试环境）
- [ ] 云函数已全部上传并部署最新版本
- [ ] 云数据库集合权限已按需配置（避免使用"所有人可读写"）

### 设计规范检查
- [ ] 界面以 750×1334 为基准适配，异形屏安全区域已处理
- [ ] 高频操作按钮在拇指易达区（屏幕底部 1/3）
- [ ] 无强制/利诱分享行为，每次游戏分享节点不超过 1 个
- [ ] 分享卡片内容与实际游戏体验一致，无诱导点击
- [ ] 互推跳转固定展示不超过 5 个，不遮蔽游戏界面
- [ ] 激励视频出现在自然游戏节点，提供跳过选项
- [ ] 商业系统不破坏游戏平衡，免费玩家有完整体验
- [ ] 新手引导采用渐进式教学，非文本堆积

---

## 问题排查与不确定情况处理

### 常见问题排查路径

| 问题类型 | 排查步骤 |
|---------|---------|
| API 调用失败 | 1. 检查 `fail` 回调的 `errMsg` → 2. 确认基础库版本（`wx.canIUse()`）→ 3. 查阅 `references/api-reference.md` |
| 网络请求失败 | 1. 确认域名已在公众平台"服务器域名"配置 → 2. 检查 `statusCode`（4xx/5xx 也走 success）→ 3. 查阅 `references/network.md` |
| 登录/鉴权异常 | 1. 确认 code 未过期（有效期 5 分钟）→ 2. 确认 `session_key` 未传给前端 → 3. 查阅 `references/auth-and-user.md` |
| 性能问题 | 1. 检查主包大小（≤ 4MB）→ 2. 分析首屏资源加载 → 3. 查阅 `references/performance.md` |
| 分包加载失败 | 1. 检查 `game.json` 的 `subpackages` 配置 → 2. 独立分包确认不引用主包文件 → 3. 查阅 `references/subpackages.md` |
| iOS/Android 行为不一致 | 1. 确认真机测试（非模拟器）→ 2. 查阅 `references/multi-platform.md` 中的平台差异说明 |

### 需告知用户查阅官方文档的情况

以下情况存在时效性，应建议用户直接查阅官方文档获取最新信息：
- 特定基础库版本的兼容性（官方文档有版本过滤功能）
- 最新审核政策与违规情形
- 特定游戏品类的特殊资质要求（如棋牌、射击品类）
- 隐私政策模板的最新要求

官方文档：https://developers.weixin.qq.com/minigame/dev/guide/
API 参考：https://developers.weixin.qq.com/minigame/dev/api/
设计规范：https://developers.weixin.qq.com/minigame/design/
