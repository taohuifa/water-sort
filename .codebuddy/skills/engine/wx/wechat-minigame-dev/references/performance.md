# 性能优化

## 目录
1. [启动性能优化](#启动性能优化)
2. [运行时性能](#运行时性能)
3. [内存管理](#内存管理)
4. [渲染性能](#渲染性能)
5. [性能监控](#性能监控)

---

## 启动性能优化

微信数据：启动超 4 秒 → 损失 40% 用户；代码包下载阶段可消除约 25% 的流失。

### 1. 控制代码包体积
```json
// game.json：配置分包
{
  "subpackages": [
    { "name": "level1", "root": "stages/level1/" },
    { "name": "level2", "root": "stages/level2/" },
    { "name": "assets", "root": "assets/large/" }
  ]
}
```

- 主包 ≤ 4MB（强制要求）
- 总包 ≤ 20MB
- 首屏必要资源放主包，其余按需分包

### 2. 预下载分包
```json
// game.json：预下载配置（在网络空闲时提前下载）
{
  "preloadRule": {
    "app": {
      "network": "all",  // "all" | "wifi"
      "packages": ["level1"]  // 预下载的分包名
    }
  }
}
```

### 3. 异步加载资源
```javascript
// ❌ 不推荐：启动时同步加载所有资源
const texture = loadTextureSync('all-assets.png'); // 阻塞主线程

// ✅ 推荐：只加载首屏需要的，其余异步加载
async function init() {
  // 第一帧：加载最小必要资源
  await loadCriticalAssets(['loading-bg.png', 'logo.png']);
  showLoadingScreen();
  
  // 后台异步加载主菜单资源
  loadAssetsInBackground(['main-menu-bg.png', 'button-sprites.png'])
    .then(() => enableStartButton());
}
```

### 4. 按需加载分包
```javascript
function loadNextLevel(levelName) {
  return new Promise((resolve, reject) => {
    const loadTask = wx.loadSubpackage({
      name: levelName,
      success: resolve,
      fail: reject
    });
    
    // 显示加载进度条
    loadTask.onProgressUpdate((res) => {
      updateLoadingBar(res.progress / 100);
    });
  });
}
```

---

## 运行时性能

### 游戏循环优化
```javascript
// ✅ 使用 requestAnimationFrame 而不是 setInterval
let lastTime = 0;

function gameLoop(timestamp) {
  const deltaTime = timestamp - lastTime;
  lastTime = timestamp;
  
  // 防止帧率过低时物理异常（跳帧保护）
  const clampedDelta = Math.min(deltaTime, 50); // 最大 50ms（20FPS）
  
  update(clampedDelta);
  render();
  
  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);
```

### 对象池（减少 GC 压力）
```javascript
// 对子弹、粒子、敌人等频繁创建销毁的对象使用对象池
class ObjectPool {
  constructor(createFn, resetFn, initialSize = 20) {
    this.createFn = createFn;
    this.resetFn = resetFn;
    this.pool = Array.from({ length: initialSize }, createFn);
  }

  get() {
    return this.pool.length > 0 ? this.pool.pop() : this.createFn();
  }

  release(obj) {
    this.resetFn(obj);
    this.pool.push(obj);
  }
}

// 使用
const bulletPool = new ObjectPool(
  () => ({ x: 0, y: 0, vx: 0, vy: 0, active: false }),
  (b) => { b.active = false; }
);

function fireBullet(x, y, direction) {
  const bullet = bulletPool.get();
  bullet.x = x;
  bullet.y = y;
  bullet.active = true;
  return bullet;
}

function removeBullet(bullet) {
  bulletPool.release(bullet);
}
```

---

## 内存管理

微信数据：内存崩溃占退出比例 2-8%（复杂游戏更高）。

### 纹理内存优化
```javascript
// ✅ 不再使用的纹理及时释放
function unloadScene(sceneName) {
  const textures = sceneTextures.get(sceneName);
  textures?.forEach(tex => {
    tex.destroy(); // 释放 GPU 内存
  });
  sceneTextures.delete(sceneName);
}

// ✅ 使用压缩纹理（节省 75% 内存）
// iOS: PVR (.pvr)
// Android: ETC (.etc)
// 通用: Basis Universal (.basis)
// 在游戏引擎中（如 Cocos）配置自动使用对应平台压缩纹理
```

### 监听内存警告
```javascript
// 监听系统内存不足警告
wx.onMemoryWarning((res) => {
  // res.level: 5=TRIM_MEMORY_RUNNING_MODERATE, 10=...15=...
  console.warn('内存警告', res.level);
  
  // 立即释放非必要缓存
  clearImageCache();
  clearAudioCache();
  releaseUnusedTextures();
  
  // 如果内存告急，暂停非关键系统
  if (res.level >= 15) {
    pauseParticleSystem();
    reduceSoundChannels();
  }
});
```

### 避免内存泄漏
```javascript
// ✅ 移除事件监听器（组件销毁时）
class GameScene {
  init() {
    this.onTouchBound = this.onTouch.bind(this);
    wx.onTouchStart(this.onTouchBound);
    
    this.onMemoryWarningBound = this.onMemoryWarning.bind(this);
    wx.onMemoryWarning(this.onMemoryWarningBound);
  }

  destroy() {
    // 必须移除，否则内存泄漏
    wx.offTouchStart(this.onTouchBound);
    wx.offMemoryWarning(this.onMemoryWarningBound);
    
    // 清理定时器
    this.timers.forEach(id => clearTimeout(id));
    this.animFrames.forEach(id => cancelAnimationFrame(id));
  }
}
```

---

## 渲染性能

### Canvas 渲染优化
```javascript
const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');

// ✅ 批量绘制，减少状态切换
function renderSprites(sprites) {
  // 按纹理分组，减少 drawImage 切换
  const byTexture = groupBy(sprites, s => s.textureId);
  
  byTexture.forEach((group, textureId) => {
    const texture = textureCache.get(textureId);
    group.forEach(sprite => {
      ctx.drawImage(texture, sprite.x, sprite.y, sprite.w, sprite.h);
    });
  });
}

// ✅ 脏区域渲染（只重绘变化的区域）
function renderDirtyRegion(region) {
  ctx.clearRect(region.x, region.y, region.width, region.height);
  // 只绘制该区域内的精灵
  const visibleSprites = getSpritesInRegion(region);
  renderSprites(visibleSprites);
}
```

### WebGL 优化（高性能游戏）
```javascript
const canvas = wx.createCanvas();
const gl = canvas.getContext('webgl');

// 使用精灵批处理（SpriteBatch）减少 Draw Call
// 核心原则：相同材质的精灵合并到一个 Draw Call
```

---

## 性能监控

```javascript
// 获取性能数据
const performance = wx.getPerformance();

// 监控帧率
const observer = performance.createObserver((entryList) => {
  const entries = entryList.getEntries();
  entries.forEach(entry => {
    if (entry.entryType === 'render') {
      console.log(`帧渲染时间: ${entry.duration}ms`);
    }
  });
});
observer.observe({ entryTypes: ['render', 'script'] });

// 上报自定义性能数据（用于后台监控）
wx.reportPerformance(
  1001,  // 指标 ID（在微信公众平台配置）
  Date.now() - gameStartTime  // 指标值（如首屏加载时间）
);
```

### 性能检测工具
1. **开发者工具 → Audits**：自动检测性能问题
2. **开发者工具 → Performance**：录制帧率、CPU、内存
3. **微信云测试**：多机型真机测试
4. **小游戏后台 → 性能监控**：线上用户真实数据

### 性能目标参考值
| 指标 | 目标值 |
|------|--------|
| 首屏加载时间 | < 4 秒 |
| 游戏帧率 | 稳定 60 FPS |
| 内存峰值（iOS） | < 400MB |
| 内存峰值（Android 中端机） | < 250MB |
| 首包大小 | < 4MB |
