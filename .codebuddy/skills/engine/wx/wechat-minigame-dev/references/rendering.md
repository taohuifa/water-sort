# 渲染与 Canvas

## Canvas 类型选择

| Canvas 类型 | 适用场景 | 性能 |
|------------|---------|------|
| 2D Context | 2D 游戏、UI 界面 | 中 |
| WebGL | 3D 游戏、2D 高性能渲染 | 高 |
| OffscreenCanvas | 离屏渲染、Worker 中渲染 | 高 |

---

## 2D Canvas 基础

```javascript
// 创建主 Canvas
const canvas = wx.createCanvas();
canvas.width = wx.getSystemInfoSync().windowWidth;
canvas.height = wx.getSystemInfoSync().windowHeight;

const ctx = canvas.getContext('2d');

// 绘制精灵
function drawSprite(image, x, y, width, height) {
  ctx.drawImage(image, x, y, width, height);
}

// 绘制精灵图（Sprite Sheet）中的指定帧
function drawSpriteFrame(image, frameX, frameY, frameW, frameH, x, y) {
  ctx.drawImage(image, frameX, frameY, frameW, frameH, x, y, frameW, frameH);
}

// 绘制文字
function drawText(text, x, y, options = {}) {
  ctx.save();
  ctx.font = `${options.bold ? 'bold ' : ''}${options.size || 24}px ${options.font || 'sans-serif'}`;
  ctx.fillStyle = options.color || '#ffffff';
  ctx.textAlign = options.align || 'left';
  ctx.textBaseline = options.baseline || 'top';
  
  // 文字阴影（增强可读性）
  if (options.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;
  }
  
  ctx.fillText(text, x, y);
  ctx.restore();
}

// 清屏
function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
```

---

## 加载图片资源

```javascript
// 加载单张图片
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage(); // 注意：用 canvas.createImage()，不是 new Image()
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url; // 可以是网络 URL 或本地路径
  });
}

// 批量预加载
async function preloadImages(urls) {
  const images = {};
  await Promise.all(
    urls.map(async (url) => {
      const key = url.split('/').pop().replace(/\.\w+$/, ''); // 用文件名作为 key
      images[key] = await loadImage(url);
    })
  );
  return images;
}

// 使用
const sprites = await preloadImages([
  'https://cdn.game.com/hero.png',
  'https://cdn.game.com/enemy.png',
  'https://cdn.game.com/bg.png',
]);

ctx.drawImage(sprites.hero, 100, 200);
```

---

## 触摸/鼠标事件

```javascript
// 触摸事件（移动端）
wx.onTouchStart((event) => {
  event.touches.forEach(touch => {
    console.log('触摸开始', touch.clientX, touch.clientY);
  });
});

wx.onTouchMove((event) => {
  event.touches.forEach(touch => {
    // 处理拖拽
  });
});

wx.onTouchEnd((event) => {
  event.changedTouches.forEach(touch => {
    handleTap(touch.clientX, touch.clientY);
  });
});

// 鼠标事件（PC 端）
wx.onMouseDown((event) => {
  console.log('鼠标按下', event.x, event.y, event.button); // 0=左键,1=中键,2=右键
});

wx.onMouseMove((event) => {
  // event.movementX, event.movementY: 相对移动量
});

wx.onMouseUp((event) => {
  handleClick(event.x, event.y);
});

// PC 端鼠标滚轮
wx.onWheel?.((event) => {
  camera.zoom += event.deltaY * 0.001;
});

// ✅ 跨平台统一处理（同时支持触摸和鼠标）
function setupInput(onPress, onMove, onRelease) {
  // 触摸
  wx.onTouchStart(e => onPress(e.touches[0].clientX, e.touches[0].clientY));
  wx.onTouchMove(e => onMove(e.touches[0].clientX, e.touches[0].clientY));
  wx.onTouchEnd(e => onRelease(e.changedTouches[0].clientX, e.changedTouches[0].clientY));
  // 鼠标（PC）
  wx.onMouseDown(e => onPress(e.x, e.y));
  wx.onMouseMove(e => { if (e.buttons > 0) onMove(e.x, e.y); });
  wx.onMouseUp(e => onRelease(e.x, e.y));
}
```

---

## 帧率控制

```javascript
// 获取/设置屏幕帧率
wx.getDeviceInfo({
  success: (res) => {
    console.log('屏幕刷新率', res.screenFPS); // 通常 60 或 120
  }
});

// 固定游戏逻辑帧率（避免高刷屏设备逻辑更新过快）
class FixedUpdateLoop {
  constructor(targetFPS = 60) {
    this.targetFPS = targetFPS;
    this.fixedDelta = 1000 / targetFPS;
    this.accumulator = 0;
    this.lastTime = 0;
  }

  tick(timestamp) {
    const elapsed = timestamp - this.lastTime;
    this.lastTime = timestamp;
    this.accumulator += elapsed;
    
    // 固定步长更新物理/逻辑
    while (this.accumulator >= this.fixedDelta) {
      this.fixedUpdate(this.fixedDelta);
      this.accumulator -= this.fixedDelta;
    }
    
    // 渲染（每帧都渲染）
    const interpolation = this.accumulator / this.fixedDelta;
    this.render(interpolation);
    
    requestAnimationFrame(ts => this.tick(ts));
  }
}
```

---

## 截图功能

```javascript
// 游戏截图（用于分享图、存档封面等）
async function captureScreenshot() {
  return new Promise((resolve) => {
    wx.canvasToTempFilePath({
      canvas: mainCanvas,
      fileType: 'jpg',
      quality: 0.85,
      success: (res) => resolve(res.tempFilePath),
      fail: (err) => {
        console.error('截图失败', err);
        resolve(null);
      }
    });
  });
}
```
