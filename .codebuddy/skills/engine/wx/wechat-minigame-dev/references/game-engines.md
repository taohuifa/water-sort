# 游戏引擎接入

## 主流引擎对比

| 引擎 | 语言 | 特点 | 适用场景 |
|------|------|------|---------|
| Cocos Creator | TypeScript/JS | 官方深度支持，2D/3D | 最推荐，生态最好 |
| Laya | TypeScript/AS3 | 高性能 2D，轻量 | 休闲小游戏 |
| Egret | TypeScript | 2D，文档丰富 | 2D 游戏 |
| Unity (WebGL) | C# → JS | 3D 能力强 | 转化后体积较大 |
| 原生 JS | JavaScript | 最灵活 | 简单游戏 |

---

## Cocos Creator 接入微信小游戏

Cocos Creator 对微信小游戏有原生支持，发布时选择"微信小游戏"平台即可。

### 关键适配点

```typescript
// 在 Cocos 中调用微信 API
// 方式 1：声明全局 wx（TypeScript 类型）
declare const wx: any;

// 方式 2：安装类型包（推荐）
// npm install @types/wechat-miniprogram -D

// 登录示例（在 Cocos 组件中）
import { Component, onLoad } from 'cc';

@ccclass('LoginManager')
export class LoginManager extends Component {
  onLoad() {
    this.doLogin();
  }
  
  async doLogin() {
    try {
      const { code } = await new Promise<{ code: string }>((resolve, reject) => {
        wx.login({ success: resolve, fail: reject });
      });
      
      // 发送到服务器...
    } catch (err) {
      console.error('登录失败', err);
    }
  }
}
```

### Cocos + 微信关系链排行榜

```typescript
// Cocos 中处理 sharedCanvas
import { Canvas, Director, Node } from 'cc';

export class LeaderboardManager {
  private openDataContext: any;
  private sharedCanvas: any;
  private mainCanvas: HTMLCanvasElement;
  
  init() {
    this.openDataContext = wx.getOpenDataContext();
    this.sharedCanvas = this.openDataContext.canvas;
    
    // 获取 Cocos 的主 Canvas
    const canvasNode = Director.instance.getScene()?.getChildByName('Canvas');
    // ... 将 sharedCanvas 渲染到 Cocos 的 Sprite 上
  }
  
  showLeaderboard() {
    this.openDataContext.postMessage({
      type: 'SHOW_LEADERBOARD',
      width: this.sharedCanvas.width,
      height: this.sharedCanvas.height,
    });
  }
}
```

### Cocos 性能优化建议
```json
// Cocos 构建配置（微信小游戏平台）
{
  "textureCompression": {
    "pvr": true,   // iOS 压缩纹理
    "etc1": true,  // Android
    "etc2": true,
    "astc": true   // 高端机
  },
  "inlineSpriteFrames": false,  // 分离精灵帧，优化首包
  "optimizeHotUpdate": true
}
```

---

## Laya 引擎接入

```typescript
// Laya 微信小游戏适配器（Laya 已内置）
import 'laya/adaptors/wechat/MiniAdaptor';
import Laya from 'Laya';

Laya.init(750, 1334, Laya.WebGL);

// 在 Laya 中调用微信 API
Laya.loader.load('res/atlas/ui.atlas', Laya.Handler.create(this, () => {
  // 资源加载完成后调用微信 API
  wx.login({
    success: (res) => this.onLogin(res.code)
  });
}));
```

---

## Unity WebGL 转微信小游戏

Unity 游戏通过微信提供的"Unity 小游戏转换工具"转换：

1. 在 Unity 安装 WX-MINI-GAME 插件（微信提供）
2. Build & Run → 选择 WebGL
3. 使用插件将 WebGL 包转换为小游戏格式

### 注意事项
- 总包体积通常较大（建议 > 30MB 的资源走分包）
- 首包代码需压缩到 4MB 以内（需要代码分割）
- C# 中调用微信 API：
  ```csharp
  using WeChatWASM;
  
  WX.Login(new LoginOption {
    success = (res) => { Debug.Log("code: " + res.code); }
  });
  
  WX.ShowToast(new ShowToastOption { title = "Hello!" });
  ```

---

## 原生 JavaScript 开发

适合简单休闲游戏，不依赖引擎：

```javascript
// game.js
const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');
const systemInfo = wx.getSystemInfoSync();
canvas.width = systemInfo.windowWidth;
canvas.height = systemInfo.windowHeight;

// 简单游戏循环
const gameState = {
  player: { x: canvas.width / 2, y: canvas.height / 2, r: 20 },
  score: 0,
};

function update(dt) {
  // 更新游戏逻辑
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // 绘制玩家
  ctx.beginPath();
  ctx.arc(gameState.player.x, gameState.player.y, gameState.player.r, 0, Math.PI * 2);
  ctx.fillStyle = '#4488ff';
  ctx.fill();
  
  // 绘制分数
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(`分数: ${gameState.score}`, 20, 50);
}

let lastTime = 0;
function loop(timestamp) {
  update(timestamp - lastTime);
  render();
  lastTime = timestamp;
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
```
