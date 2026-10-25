# 多平台适配

## 平台差异总览

| 特性 | iOS | Android | PC（Windows/Mac） | 鸿蒙（HarmonyOS） |
|------|-----|---------|-------------------|-----------------|
| JS 引擎 | JavaScriptCore | V8 | NW.js | ArkTS/V8 |
| 音频首次播放 | 必须用户手势触发 | 无限制 | 无限制 | 与 iOS 类似 |
| 内存上限 | ~400MB | ~1.5GB | 更宽松 | ~400MB |
| 触摸事件 | ✅ | ✅ | ❌（用鼠标） | ✅ |
| 鼠标事件 | ❌ | ❌ | ✅ | ❌ |
| 键盘事件 | 软键盘 | 软键盘 | 硬键盘 ✅ | 视设备 |
| 屏幕帧率 | 60/120 FPS | 60/120 FPS | 60 FPS | 60/90 FPS |
| WebGL | ✅ | ✅ | ✅ | ✅ |

---

## 检测当前平台

```javascript
const sysInfo = wx.getSystemInfoSync();

const platform = sysInfo.platform; // 'ios' | 'android' | 'devtools' | 'windows' | 'mac'
const isIOS = platform === 'ios';
const isAndroid = platform === 'android';
const isPC = platform === 'windows' || platform === 'mac';
const isDevTools = platform === 'devtools';

// 检查运行环境（鸿蒙等新平台）
const hostEnv = sysInfo.host?.env ?? ''; // 'WeChat' | 'WeChatWork' | etc.
const isHarmony = sysInfo.system?.toLowerCase().includes('openharmony');
```

---

## PC 端适配

PC 端微信小游戏支持较新，需要额外处理键盘和鼠标输入。

### 键盘输入

```javascript
// PC 端键盘事件（触摸设备不支持）
if (isPC || isDevTools) {
  wx.onKeyDown?.((event) => {
    // event.code: 'Space', 'ArrowLeft', 'ArrowRight', etc.
    // event.key: 实际按键字符
    handleKeyDown(event.code);
  });

  wx.onKeyUp?.((event) => {
    handleKeyUp(event.code);
  });
}

// 键盘状态管理（适用于需要持续检测按键的游戏）
class KeyboardState {
  private held = new Set<string>();

  constructor() {
    wx.onKeyDown?.((e) => this.held.add(e.code));
    wx.onKeyUp?.((e) => this.held.delete(e.code));
  }

  isDown(code: string) {
    return this.held.has(code);
  }
}

export const keyboard = new KeyboardState();

// 游戏循环中使用
function update() {
  if (keyboard.isDown('ArrowLeft')) player.x -= 5;
  if (keyboard.isDown('ArrowRight')) player.x += 5;
  if (keyboard.isDown('Space')) player.jump();
}
```

### 鼠标与触摸统一处理

```javascript
// 跨平台输入抽象层
class InputManager {
  private listeners = { press: [], move: [], release: [] };

  init() {
    // 触摸（移动端）
    wx.onTouchStart(e => this.emit('press', e.touches[0].clientX, e.touches[0].clientY));
    wx.onTouchMove(e => this.emit('move', e.touches[0].clientX, e.touches[0].clientY));
    wx.onTouchEnd(e => this.emit('release', e.changedTouches[0].clientX, e.changedTouches[0].clientY));

    // 鼠标（PC端）
    wx.onMouseDown?.(e => { if (e.button === 0) this.emit('press', e.x, e.y); });
    wx.onMouseMove?.(e => { if (e.buttons & 1) this.emit('move', e.x, e.y); });
    wx.onMouseUp?.(e => { if (e.button === 0) this.emit('release', e.x, e.y); });
    
    // PC 鼠标右键（可用于特殊操作）
    wx.onMouseDown?.(e => { if (e.button === 2) this.emit('rightClick', e.x, e.y); });
    
    // 滚轮缩放（PC）
    wx.onWheel?.(e => this.emit('wheel', e.deltaY));
  }

  on(event, fn) {
    this.listeners[event]?.push(fn) ?? (this.listeners[event] = [fn]);
    return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); };
  }

  private emit(event, ...args) {
    this.listeners[event]?.forEach(fn => fn(...args));
  }
}

export const input = new InputManager();
```

### PC 端窗口与全屏

```javascript
// 监听窗口尺寸变化（PC 端用户可能调整窗口）
wx.onWindowResize?.((res) => {
  const { windowWidth, windowHeight } = res.size;
  resizeCanvas(windowWidth, windowHeight);
});

// 请求全屏
wx.setWindowSize?.({
  width: 1280,
  height: 720,
});
```

---

## iOS 特有适配

### 音频解锁

```javascript
// iOS 必须在首次用户手势中触发音频播放
let audioUnlocked = false;

wx.onTouchStart(() => {
  if (!audioUnlocked) {
    audioUnlocked = true;
    audioManager.unlockAudio(); // 播放一个无声或极短的音频
    wx.offTouchStart(); // 只需解锁一次，移除监听
  }
});

// AudioManager 中
unlockAudio() {
  const audio = wx.createInnerAudioContext();
  audio.src = 'assets/audio/silent.mp3'; // 0.1秒无声音频
  audio.volume = 0;
  audio.play();
  audio.onEnded(() => {
    audio.destroy();
    this.bgm?.play(); // 解锁后立即播放 BGM
  });
}
```

### iOS 内存管理

```javascript
// iOS 内存更紧张，需要更积极地清理
wx.onMemoryWarning((res) => {
  console.warn('内存警告，等级:', res.level);
  // level 10 = 低内存警告, level 15 = 严重内存不足
  if (res.level >= 10) {
    // 释放非必要纹理、预加载的资源
    imageCache.clearUnused();
    audioPool.clear();
    gc(); // 触发 JS 垃圾回收（如果可用）
  }
});

// iOS 纹理限制：单张纹理不超过 2048x2048（部分老机型 1024x1024）
function checkTextureSize(image) {
  if (isIOS && (image.width > 2048 || image.height > 2048)) {
    console.warn(`纹理过大: ${image.width}x${image.height}，iOS 可能崩溃`);
  }
}
```

---

## Android 特有适配

```javascript
// Android 上 V8 引擎，某些 ES 特性可能有差异
// 建议开启"增强编译"（project.config.json）以保证一致性

// Android 设备碎片化：检测低端设备并降级
function getDeviceLevel() {
  const info = wx.getSystemInfoSync();
  const memory = info.memorySize ?? 0; // MB，低端机通常 1-2GB
  const benchmarkLevel = info.benchmarkLevel ?? 0; // 性能评级，-1=未知

  if (benchmarkLevel !== -1) {
    if (benchmarkLevel < 10) return 'low';
    if (benchmarkLevel < 20) return 'medium';
    return 'high';
  }

  // 降级方案：按内存判断
  if (memory < 1500) return 'low';
  if (memory < 3000) return 'medium';
  return 'high';
}

const deviceLevel = getDeviceLevel();

// 根据设备等级调整画质
const qualitySettings = {
  low: { particleCount: 20, shadowEnabled: false, textureQuality: 0.5 },
  medium: { particleCount: 50, shadowEnabled: false, textureQuality: 0.75 },
  high: { particleCount: 100, shadowEnabled: true, textureQuality: 1.0 },
}[deviceLevel];
```

---

## 鸿蒙（HarmonyOS）适配

鸿蒙微信小游戏于 2024 年起逐步支持，整体 API 与 iOS/Android 兼容，但有少量差异：

```javascript
// 检测鸿蒙
const isHarmony = wx.getSystemInfoSync().system?.toLowerCase().includes('openharmony')
                  ?? false;

// 鸿蒙目前不支持的 API（需要降级处理）
function safeJoinVoIPChat(options) {
  if (isHarmony) {
    // 鸿蒙暂不支持 VoIP
    console.warn('鸿蒙暂不支持 VoIPChat');
    return;
  }
  wx.joinVoIPChat(options);
}

// 鸿蒙文件系统路径可能不同，使用 wx.env 获取基础路径
const fsBase = wx.env.USER_DATA_PATH; // 统一使用此方式，跨平台兼容
```

---

## 屏幕适配（多分辨率）

```javascript
// 设计尺寸（以 750px 宽为基准，竖屏）
const DESIGN_WIDTH = 750;
const DESIGN_HEIGHT = 1334;

const { windowWidth, windowHeight, pixelRatio } = wx.getSystemInfoSync();

// 计算缩放比
const scaleX = windowWidth / DESIGN_WIDTH;
const scaleY = windowHeight / DESIGN_HEIGHT;
const scale = Math.min(scaleX, scaleY); // 保持比例，可能有黑边

// 实际画布尺寸
const canvasWidth = windowWidth;
const canvasHeight = windowHeight;

// 游戏内坐标转换（设计坐标 → 屏幕坐标）
function designToScreen(x, y) {
  const offsetX = (canvasWidth - DESIGN_WIDTH * scale) / 2;
  const offsetY = (canvasHeight - DESIGN_HEIGHT * scale) / 2;
  return {
    x: x * scale + offsetX,
    y: y * scale + offsetY,
  };
}

// 屏幕坐标 → 设计坐标（触摸事件转换）
function screenToDesign(x, y) {
  const offsetX = (canvasWidth - DESIGN_WIDTH * scale) / 2;
  const offsetY = (canvasHeight - DESIGN_HEIGHT * scale) / 2;
  return {
    x: (x - offsetX) / scale,
    y: (y - offsetY) / scale,
  };
}
```

### 安全区域（刘海屏/圆角屏）

```javascript
// 获取安全区域（避免内容被刘海、圆角遮挡）
const { safeArea } = wx.getSystemInfoSync();
// safeArea: { top, left, right, bottom, width, height }

// 将 UI 元素限制在安全区域内
const UI_PADDING = {
  top: safeArea.top,
  bottom: windowHeight - safeArea.bottom,
  left: safeArea.left,
  right: windowWidth - safeArea.right,
};

// 例：将摇杆放在安全区域底部
const joystickY = windowHeight - UI_PADDING.bottom - 100;
```

---

## 横屏游戏适配

```javascript
// game.json
// "deviceOrientation": "landscape"

// 横屏时注意触摸坐标系与屏幕方向一致
// 设计尺寸以 1334x750（宽 > 高）为基准

// 动态检测屏幕方向（如果游戏允许旋转）
wx.onDeviceOrientationChange?.((res) => {
  // res.value: 'portrait' | 'landscapeLeft' | 'landscapeRight'
  handleOrientationChange(res.value);
});
```

---

## API 兼容性检查

```javascript
// 使用 wx.canIUse 在运行时检查 API 可用性
const apiChecks = {
  rewardedVideo: wx.canIUse('wx.createRewardedVideoAd'),
  voipChat: wx.canIUse('wx.joinVoIPChat'),
  keyboard: wx.canIUse('wx.onKeyDown'),
  wheel: wx.canIUse('wx.onWheel'),
  workerThreads: wx.canIUse('wx.createWorker'),
};

// 根据 API 可用性启用/禁用功能
if (!apiChecks.rewardedVideo) {
  adButton.visible = false; // 不支持激励广告则隐藏按钮
}

// 版本检查（更精细的控制）
function compareVersion(v1, v2) {
  const a = v1.split('.').map(Number);
  const b = v2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return 1;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return -1;
  }
  return 0;
}

const sdkVersion = wx.getSystemInfoSync().SDKVersion;
const supportsPrivacy = compareVersion(sdkVersion, '3.0.1') >= 0;
```
