# 项目结构与配置

## 标准目录结构

```
小游戏项目/
├── game.js          # 游戏入口文件（必须）
├── game.json        # 全局配置文件（必须）
├── project.config.json  # 开发者工具配置
├── src/
│   ├── main.js      # 游戏主逻辑
│   ├── scenes/      # 场景文件
│   ├── entities/    # 游戏实体
│   ├── utils/       # 工具函数
│   └── config/      # 配置常量
├── assets/
│   ├── images/      # 图片资源
│   ├── audio/       # 音频资源
│   └── fonts/       # 字体文件
├── open-data/       # 开放数据域（关系链排行榜）
│   └── index.js
└── subpackages/     # 分包目录
    ├── level1/
    └── level2/
```

---

## game.json 完整配置说明

```json
{
  "deviceOrientation": "portrait",  // "portrait"（竖屏）| "landscape"（横屏）
  "showStatusBar": false,           // 是否显示状态栏
  "networkTimeout": {
    "request": 10000,               // wx.request 超时（毫秒）
    "downloadFile": 60000,          // 下载超时
    "uploadFile": 60000,            // 上传超时
    "connectSocket": 10000          // WebSocket 连接超时
  },
  "openDataContext": "open-data",   // 开放数据域目录（有排行榜时必须配置）
  "subpackages": [                  // 分包配置
    {
      "name": "level1",
      "root": "subpackages/level1/",
      "pages": []
    },
    {
      "name": "assets-pack",
      "root": "subpackages/assets/"
    }
  ],
  "preloadRule": {                  // 预下载分包
    "app": {
      "network": "wifi",
      "packages": ["level1"]
    }
  },
  "workers": "workers/",           // Worker 目录（多线程）
  "plugins": {},                   // 插件配置
  "permission": {                  // 权限声明
    "scope.userLocation": {
      "desc": "用于游戏地图功能"
    }
  }
}
```

---

## game.js 入口文件

```javascript
// game.js：游戏入口，负责初始化
import './src/main.js';

// 如果使用 Cocos、Laya 等引擎，通常由引擎生成此文件
// 不要在这里写大量逻辑
```

---

## project.config.json 开发配置

```json
{
  "appid": "wx1234567890abcdef",
  "projectname": "my-minigame",
  "compileType": "game",
  "setting": {
    "es6": true,          // 开启 ES6 → ES5 转换
    "minified": false,    // 开发时关闭代码压缩，便于调试
    "enhance": true,      // 开启增强编译
    "uglifyFileName": false
  },
  "condition": {          // 调试入口配置
    "game": {
      "list": [
        {
          "id": -1,
          "name": "测试关卡2",
          "pathName": "",
          "query": "scene=level2&debug=true"
        }
      ]
    }
  }
}
```

---

## 生命周期

```javascript
// game.js
wx.onShow((options) => {
  // 小游戏从后台切到前台（或首次打开）
  // options.query: 启动参数
  // options.scene: 场景值
  console.log('游戏切回前台', options);
  resumeGame();
  resumeAudio();
});

wx.onHide(() => {
  // 小游戏切到后台
  pauseGame();
  pauseAudio();
  saveProgress(); // 切后台时自动存档
});

wx.onError((msg) => {
  // 全局错误捕获
  console.error('全局错误', msg);
  reportError(msg); // 上报错误日志
});

wx.onUnhandledRejection((res) => {
  // 未处理的 Promise rejection
  console.error('未处理的 Promise 错误', res.reason);
});
```

---

## 获取系统信息

```javascript
// 获取设备信息（只调用一次，缓存结果）
const systemInfo = wx.getSystemInfoSync();

const {
  windowWidth,    // 可用宽度（px）
  windowHeight,   // 可用高度（px）
  pixelRatio,     // 设备像素比（通常 2 或 3）
  platform,       // 'ios' | 'android' | 'devtools'
  SDKVersion,     // 基础库版本，如 '2.25.0'
  model,          // 设备型号
  system,         // 系统版本，如 'iOS 16.0'
} = systemInfo;

// 适配不同屏幕尺寸
const DESIGN_WIDTH = 750;
const scale = windowWidth / DESIGN_WIDTH;
const canvasHeight = windowHeight / scale;

// 检查 API 兼容性
if (!wx.canIUse('wx.createRewardedVideoAd')) {
  // 该 API 不可用，使用降级方案
}
```

---

## 多线程 Worker

适合计算密集型任务（寻路、物理计算等）：

```javascript
// 主线程
const worker = wx.createWorker('workers/pathfinder.js');

worker.postMessage({ type: 'FIND_PATH', start: { x: 0, y: 0 }, end: { x: 10, y: 10 } });

worker.onMessage((res) => {
  if (res.type === 'PATH_RESULT') {
    moveEntityAlongPath(res.path);
  }
});

// workers/pathfinder.js（Worker 代码）
worker.onMessage((data) => {
  if (data.type === 'FIND_PATH') {
    const path = calculatePath(data.start, data.end); // 耗时计算
    worker.postMessage({ type: 'PATH_RESULT', path });
  }
});
```
