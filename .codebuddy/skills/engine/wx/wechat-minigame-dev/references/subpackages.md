# 代码分包

微信小游戏通过"分包"机制将代码和资源拆分成多个包，按需下载，大幅减少首次启动时间。

---

## 目录

1. [包大小规则](#包大小规则)
2. [普通分包](#普通分包)
3. [独立分包](#独立分包)
4. [分包预下载](#分包预下载)
5. [分包预加载（下载与执行分离）](#分包预加载下载与执行分离)
6. [向下兼容](#向下兼容)
7. [分包策略建议](#分包策略建议)

---

## 包大小规则

| 类型 | 限制 |
|------|------|
| **所有包总大小** | ≤ 30MB |
| **主包** | ≤ 4MB（强制，超过无法上传） |
| **单个普通分包** | 无单独限制 |
| **单个独立分包** | ≤ 4MB |

> 主包是用户启动游戏时**必须下载**的部分，直接影响冷启动速度。应将主包控制在 2MB 以内，仅保留首屏启动必需的代码和资源。

---

## 普通分包

### 配置方式

在 `game.json` 中声明 `subpackages`，未列入任何分包的文件自动归入主包：

```json
{
  "subpackages": [
    {
      "name": "stage1",
      "root": "stages/stage1/"
    },
    {
      "name": "stage2",
      "root": "stages/stage2/"
    },
    {
      "name": "assets-hd",
      "root": "assets/hd/"
    }
  ]
}
```

分包根路径（`root`）可以是目录（目录下需有 `game.js` 作为入口）或单个 JS 文件：

```json
{
  "subpackages": [
    { "name": "extra", "root": "extras/extra.js" }
  ]
}
```

### 动态加载分包

游戏运行时按需加载，支持进度回调：

```javascript
// 加载分包（下载 + 执行）
function loadStage(stageName) {
  return new Promise((resolve, reject) => {
    const task = wx.loadSubpackage({
      name: stageName,
      success: resolve,
      fail: reject,
    });

    task.onProgressUpdate((res) => {
      // res.progress: 0-100
      // res.totalBytesWritten: 已下载字节
      // res.totalBytesExpectedToWrite: 总字节
      updateLoadingBar(res.progress);
      console.log(`${stageName} 下载进度: ${res.progress}%`);
    });
  });
}

// 使用
async function enterStage2() {
  showLoadingScreen();
  try {
    await loadStage('stage2');
    hideLoadingScreen();
    startStage2();
  } catch (err) {
    console.error('分包加载失败', err);
    showRetryButton();
  }
}
```

### 分包内引用规则

- ✅ 分包内可以 `require` 主包的文件
- ✅ 分包内可以访问主包的全局变量
- ❌ 分包之间**不能**互相 `require`（A 分包不能引用 B 分包的文件）
- ❌ 主包**不能** `require` 分包的文件（分包尚未加载时会报错）

```javascript
// stages/stage2/game.js（分包入口）

// ✅ 可以引用主包的工具函数
const { AudioManager } = require('../../src/audio/AudioManager.js');
const GameConfig = require('../../src/config/GameConfig.js');

// ✅ 可以访问主包初始化好的全局状态
const playerData = globalThis.playerData;

// ❌ 不能引用其他分包
// const stage1Utils = require('../stage1/utils.js'); // 报错！
```

---

## 独立分包

### 什么是独立分包

独立分包是一种特殊分包，**不依赖主包即可独立运行**。用户通过分享卡片、朋友圈等入口直接进入时，微信只下载该独立分包，跳过主包，实现更快的冷启动。

**典型使用场景**：
- 游戏分享的关卡挑战页（用户点击好友分享直接进入某关卡）
- 迷你玩法活动页（节日限定小游戏，独立运行）
- 游戏宣传预览页

### 配置方式

在分包配置中添加 `"independent": true`：

```json
{
  "subpackages": [
    {
      "name": "challenge",
      "root": "challenge/",
      "independent": true
    },
    {
      "name": "stage1",
      "root": "stages/stage1/"
    }
  ]
}
```

> **版本要求**：微信客户端 ≥ 7.0.13，基础库 ≥ 2.12.1，独立分包大小 ≤ 4MB。

### 独立分包的核心限制

独立分包运行时主包**完全没有加载**，因此：

- ❌ **不能引用主包任何文件**（JS、图片、音频等）
- ❌ **不能依赖主包初始化的全局状态**（如 `globalThis.xxx` 在主包 `game.js` 中设置的值）
- ❌ **不能使用主包注册的插件**
- ✅ 可以有自己独立的 `wx.cloud.init()` 初始化
- ✅ 所有微信平台 API（`wx.*`）正常可用

```javascript
// challenge/game.js（独立分包入口）

// ❌ 错误：独立分包不能引用主包文件
// const config = require('../src/config.js');

// ✅ 正确：独立分包内部自给自足
const config = {
  maxScore: 9999,
  bgmUrl: 'https://cdn.example.com/challenge-bgm.mp3',
};

// ✅ 可以独立初始化云开发
wx.cloud.init({ env: 'your-env-id' });

// ✅ 可以调用所有 wx.* API
const systemInfo = wx.getSystemInfoSync();
```

### 独立分包内按需加载主包

如果用户在独立分包内决定进入完整游戏，可以动态加载主包：

```javascript
// 在独立分包中加载主包（特殊名称：'__GAME__'）
async function enterFullGame() {
  showLoading('正在进入完整游戏...');
  
  const task = wx.loadSubpackage({
    name: '__GAME__', // 固定写法，表示主包
    success: () => {
      hideLoading();
      // 主包加载完成，可以跳转或调用主包逻辑
      require('../../game.js'); // 执行主包入口
    },
    fail: (err) => {
      console.error('主包加载失败', err);
      showError('网络异常，请重试');
    },
  });

  task.onProgressUpdate((res) => {
    updateProgress(res.progress);
  });
}
```

也可以加载其他分包：

```javascript
// 在独立分包中加载另一个分包
wx.loadSubpackage({
  name: 'stage1', // 其他分包的 name
  success: () => { /* ... */ },
});
```

### 独立分包的分享入口配置

通过 `wx.shareAppMessage` 分享到独立分包时，`path` 必须是 `game.json` 中该分包的 `root` 值：

```javascript
// 在独立分包（root: "challenge/"）内分享
wx.shareAppMessage({
  title: '来挑战我的最高分！',
  imageUrl: 'https://cdn.example.com/share-cover.jpg',
  path: '/challenge/', // ✅ 必须与 game.json 的 root 一致
});

// ❌ 错误写法
// path: '/challenge/index' 或 path: 'challenge'
```

---

## 分包预下载

在进入某个游戏阶段之前，利用网络空闲时机**提前下载**后续分包，让玩家过关时无需等待加载：

```json
// game.json
{
  "subpackages": [
    { "name": "stage1", "root": "stages/stage1/" },
    { "name": "stage2", "root": "stages/stage2/" },
    { "name": "stage3", "root": "stages/stage3/" }
  ],
  "preloadRule": {
    "app": {
      "network": "wifi",      // "wifi"（仅 Wi-Fi）| "all"（Wi-Fi+流量）
      "packages": ["stage1"]  // 游戏启动后立即预下载 stage1
    }
  }
}
```

`preloadRule` 的 key 是触发预下载的时机：
- `"app"` — 游戏启动后立即开始预下载（最常用）

> **注意**：`preloadRule` 只会**下载**分包到本地缓存，不会执行代码。真正执行仍需调用 `wx.loadSubpackage()`。

---

## 分包预加载（下载与执行分离）

基础库 3.4.9+ 提供 `wx.preDownloadSubpackage()`，将**下载**和**执行**彻底分离，适合需要精确控制加载时机的场景（如在过场动画期间下载，动画结束后立即执行）：

```javascript
// 第一步：在合适时机预下载（不执行代码，不影响当前游戏帧率）
function preloadNextStage(stageName) {
  return new Promise((resolve, reject) => {
    const task = wx.preDownloadSubpackage({
      name: stageName,
      success: resolve,
      fail: reject,
    });

    task.onProgressUpdate((res) => {
      console.log(`预下载 ${stageName}: ${res.progress}%`);
    });
  });
}

// 第二步：在需要时执行（此时文件已在本地，几乎无延迟）
async function executeStage(stageName) {
  await new Promise((resolve, reject) => {
    wx.loadSubpackage({ name: stageName, success: resolve, fail: reject });
  });
  // 代码已执行，可以直接使用分包内的模块
}

// 完整流程示例
async function stageTransition() {
  // 在 stage1 结算动画期间（约3秒）预下载 stage2
  const preloadPromise = preloadNextStage('stage2');
  await playResultAnimation(); // 约 3 秒

  // 动画结束时分包可能已下载完毕
  await preloadPromise;

  // 立即执行，几乎没有等待
  await executeStage('stage2');
  startStage2();
}
```

### preDownloadSubpackage vs loadSubpackage 对比

| | `wx.loadSubpackage()` | `wx.preDownloadSubpackage()` |
|---|---|---|
| 下载文件 | ✅ | ✅ |
| 执行 JS 代码 | ✅ | ❌（需再调用 loadSubpackage） |
| 基础库要求 | 2.1.0+ | 3.4.9+ |
| 适用场景 | 立即需要使用分包 | 提前静默下载，稍后执行 |

---

## 向下兼容

微信服务端会自动编译两个版本：
- **新版客户端**（基础库 ≥ 2.1.0）：使用分包版本，按需下载
- **旧版客户端**（< 2.1.0）：自动收到合并后的完整包

旧版客户端不支持 `wx.loadSubpackage()` API，需要用 `require` 兼容：

```javascript
// 兼容写法（同时支持新旧版本）
function loadStage1(callback) {
  if (wx.loadSubpackage) {
    // 新版：动态加载
    wx.loadSubpackage({
      name: 'stage1',
      success: callback,
      fail: console.error,
    });
  } else {
    // 旧版：直接 require（文件已在包内）
    require('stages/stage1/game.js');
    callback();
  }
}
```

---

## 分包策略建议

### 按游戏结构分包

```
主包（≤ 2MB 目标）
├── game.js           # 入口
├── src/core/         # 引擎核心、基础框架
├── src/ui/login/     # 登录界面
├── assets/ui/        # 首屏 UI 资源（压缩后）
│
分包：stage1/         # 第1关所有代码和资源
分包：stage2/         # 第2关...
分包：assets-hd/      # 高清纹理（Wi-Fi 下载）
独立分包：challenge/  # 可分享的挑战模式
```

### 主包只放必要内容

| 放主包 ✅ | 放分包 ✅ |
|---------|---------|
| 游戏引擎核心 | 各关卡的地图数据 |
| 登录鉴权流程 | 非首屏音频资源 |
| 首屏 UI 与背景 | 高清纹理图集 |
| 全局工具函数 | 特定模式的游戏逻辑 |
| wx.cloud 初始化 | 活动/节日限定内容 |

### 独立分包决策树

```
需要通过分享卡片/朋友圈直接打开某个游戏场景？
    ├── 是 → 使用独立分包（≤ 4MB，完全自给自足）
    └── 否 → 使用普通分包
              └── 玩家会在游戏内流程中进入？
                      ├── 是，立即需要 → wx.loadSubpackage()
                      └── 是，可以提前缓存 → preloadRule + wx.loadSubpackage()
                                           或 wx.preDownloadSubpackage()（基础库 3.4.9+）
```

### 常见问题

**Q：分包内的图片资源如何引用？**

```javascript
// 分包内（stages/stage1/game.js）引用本分包的资源，用相对路径
const img = canvas.createImage();
img.src = 'stages/stage1/assets/hero.png'; // 从项目根目录开始的路径
// 或者
img.src = './assets/hero.png'; // 相对于当前 JS 文件的路径（部分场景支持）
```

**Q：分包加载失败怎么处理？**

```javascript
// 加入重试机制
async function loadSubpackageWithRetry(name, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        wx.loadSubpackage({ name, success: resolve, fail: reject });
      });
      return; // 成功
    } catch (err) {
      console.warn(`分包 ${name} 加载失败，第 ${i + 1} 次重试`, err);
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1))); // 指数退避
      }
    }
  }
  throw new Error(`分包 ${name} 加载失败，已重试 ${maxRetries} 次`);
}
```

**Q：如何在加载界面展示总进度（多分包）？**

```javascript
async function loadMultipleSubpackages(packages) {
  const progresses = new Array(packages.length).fill(0);

  await Promise.all(packages.map((name, index) => {
    return new Promise((resolve, reject) => {
      const task = wx.loadSubpackage({ name, success: resolve, fail: reject });
      task.onProgressUpdate(({ progress }) => {
        progresses[index] = progress;
        const total = progresses.reduce((a, b) => a + b, 0) / packages.length;
        updateTotalProgress(Math.floor(total));
      });
    });
  }));
}

// 并行加载 stage1 和 assets
await loadMultipleSubpackages(['stage1', 'assets-hd']);
```
