# 微信小游戏 API 速查手册

> 覆盖官方 API 文档全部分类。标注 ⚠️ 表示废弃/已有推荐替代；标注 📦 表示有基础库版本要求。

---

## 目录

1. [基础能力](#基础能力)
2. [触摸与输入事件](#触摸与输入事件)
3. [渲染与画布](#渲染与画布)
4. [网络通信](#网络通信)
5. [媒体（音频/录音/视频/VoIP）](#媒体)
6. [数据缓存](#数据缓存)
7. [文件系统](#文件系统)
8. [开放接口](#开放接口)
9. [广告变现](#广告变现)
10. [设备能力](#设备能力)
11. [界面交互](#界面交互)
12. [Worker 多线程](#worker-多线程)
13. [游戏对局回放](#游戏对局回放)
14. [游戏服务（房间/帧同步）](#游戏服务)
15. [AI 能力](#ai-能力)
16. [数据分析](#数据分析)
17. [跳转与生命周期](#跳转与生命周期)

---

## 基础能力

### 系统信息（推荐新 API，2.25.3+）

`wx.getSystemInfoSync()` 已在 2.20.1 废弃，推荐按需使用细分 API：

```javascript
// 窗口与屏幕信息（最常用）
const win = wx.getWindowInfo();
// win.pixelRatio       设备像素比
// win.screenWidth/screenHeight  屏幕物理像素
// win.windowWidth/windowHeight  可用窗口逻辑像素
// win.statusBarHeight  状态栏高度
// win.safeArea         安全区 { left, right, top, bottom, width, height }

// 设备信息
const device = wx.getDeviceInfo();
// device.abi              应用二进制接口（Android）
// device.benchmarkLevel   性能基准评分 (Android, -2~50+)
// device.brand / model    品牌 / 型号

// 应用基础信息
const app = wx.getAppBaseInfo();
// app.SDKVersion   基础库版本
// app.language     微信语言
// app.version      微信版本号
// app.enableDebug  是否开启调试

// 系统设置
const sys = wx.getSystemSetting();
// sys.bluetoothEnabled    蓝牙开关
// sys.locationEnabled     位置开关
// sys.wifiEnabled         Wi-Fi 开关
// sys.deviceOrientation   'portrait' | 'landscape'

// 应用授权状态（注意：值是字符串，非布尔）
const auth = wx.getAppAuthorizeSetting();
// auth.cameraAuthorized       'authorized'|'denied'|'not determined'
// auth.microphoneAuthorized
// auth.albumAuthorized        (iOS only)
// auth.locationAuthorized     'authorized'|'denied'
// auth.bluetoothAuthorized    (Android 3.5.0+)

// 兼容写法（低版本降级）
function getWindowInfo() {
  if (wx.getWindowInfo) return wx.getWindowInfo();
  const info = wx.getSystemInfoSync();
  return { pixelRatio: info.pixelRatio, windowWidth: info.windowWidth,
           windowHeight: info.windowHeight, safeArea: info.safeArea,
           statusBarHeight: info.statusBarHeight };
}
```

### 环境变量

```javascript
// wx.env 对象
const userDataPath = wx.env.USER_DATA_PATH;
// 用户文件目录，例如 "wxfile://usr/xxx"，跨平台统一使用此路径
```

### 版本更新

```javascript
const updateManager = wx.getUpdateManager();

updateManager.onCheckForUpdate((res) => {
  console.log('是否有新版本:', res.hasUpdate);
});

updateManager.onUpdateReady(() => {
  wx.showModal({
    title: '更新提示',
    content: '新版本已下载，重启后生效',
    success: (res) => {
      if (res.confirm) updateManager.applyUpdate(); // 强制重启
    }
  });
});

updateManager.onUpdateFailed(() => {
  console.error('更新下载失败');
});
```

### 性能管理

```javascript
// 设置目标帧率（1-60fps，默认 60）
wx.setPreferredFramesPerSecond(30); // 低端机可降为 30fps 省电

// 触发 GC
wx.triggerGC();

// 获取性能数据
const perf = wx.getPerformance();
const now = perf.now(); // 高精度时间戳（毫秒）

// requestAnimationFrame / cancelAnimationFrame（全局可用）
let rafId = requestAnimationFrame(function loop(ts) {
  update(ts);
  render();
  rafId = requestAnimationFrame(loop);
});
// cancelAnimationFrame(rafId); // 停止
```

### 加密

```javascript
// 获取用户加密模块（基础库 2.17.3+）
const cryptoMgr = wx.getUserCryptoManager();

// 获取用户密钥（用于加密网络通信）
cryptoMgr.getLatestUserKey({
  success: ({ encryptKey, iv, version, expireTime }) => {
    // 用 encryptKey + iv 做 AES 加密
  }
});

// 生成安全随机数
cryptoMgr.getRandomValues({
  length: 16,          // 字节数
  success: ({ randomValues }) => { /* ArrayBuffer */ }
});
```

### 调试

```javascript
wx.setEnableDebug({ enableDebug: true }); // 开启 vConsole

// 日志管理器
const logger = wx.getLogManager({ level: 0 }); // 0=全量，1=过滤 App.onShow 等
logger.log('普通日志');
logger.warn('警告');
logger.debug('调试信息');

// 实时日志（用于线上问题排查，微信后台可查）
const rt = wx.getRealtimeLogManager();
rt.info('online log');
rt.error('error info', err);
rt.setFilterMsg('levelup'); // 按关键词过滤
```

---

## 触摸与输入事件

### 触摸事件

```javascript
// 注册触摸事件（全局）
wx.onTouchStart((event) => {
  event.touches         // 当前屏幕所有触点
  event.changedTouches  // 本次事件发生变化的触点
});

wx.onTouchMove((event) => { /* 同上 */ });
wx.onTouchEnd((event) => { /* changedTouches 为抬起的触点 */ });
wx.onTouchCancel((event) => { /* 触摸被打断（来电等） */ });

// Touch 对象字段
// identifier  触点ID（多指时区分）
// clientX/clientY  相对视口左上角坐标（逻辑像素）
// pageX/pageY      同上（小游戏中与 client 相同）
// force            压力值 0-1（支持 3D Touch 设备）

// 取消监听
wx.offTouchStart(handler);
```

### 键盘（PC端）

```javascript
if (wx.onKeyDown) {
  wx.onKeyDown((event) => {
    // event.code: 'Space'|'ArrowLeft'|'ArrowRight'|'ArrowUp'|'ArrowDown'
    //             'KeyA'~'KeyZ'|'Digit0'~'Digit9'|'Enter'|'Escape'
    // event.key:  实际字符
  });
  wx.onKeyUp((event) => { /* 同上 */ });
  wx.onKeyboardHeightChange?.((event) => {
    // event.height: 键盘高度（软键盘弹出时）
  });
}
```

### 鼠标（PC端）

```javascript
wx.onMouseDown?.((e) => { /* e.x, e.y, e.button(0=左/1=中/2=右) */ });
wx.onMouseMove?.((e) => { /* e.x, e.y, e.buttons（位掩码） */ });
wx.onMouseUp?.((e)   => { /* e.x, e.y, e.button */ });
wx.onWheel?.((e)     => { /* e.deltaX, e.deltaY, e.deltaZ */ });
```

### 手柄（Gamepad）

```javascript
// 获取已连接手柄（PC/TV）
const gamepads = wx.getGamepads();
// 返回 Gamepad[] 数组，每个对象含 axes[], buttons[], id, connected
```

---

## 渲染与画布

### Canvas 创建

```javascript
// 第一次调用：创建主屏幕画布
const canvas = wx.createCanvas();
canvas.width  = wx.getWindowInfo().windowWidth;
canvas.height = wx.getWindowInfo().windowHeight;

// 后续调用：创建离屏画布（用于纹理、合批渲染）
const offscreen = wx.createCanvas();
offscreen.width = 512;
offscreen.height = 512;

// 获取 2D 上下文
const ctx = canvas.getContext('2d');

// 获取 WebGL 上下文
const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: false });
// WebGL 扩展：绑定 Canvas 纹理
const ext = gl.getExtension('WEBGL_bind_tex_image_WX');
ext.wxBindCanvasTexture(gl.TEXTURE_2D, offscreen);
```

### Canvas 操作

```javascript
// 导出为 base64 DataURL
const dataUrl = canvas.toDataURL('image/png', 0.92);

// 异步保存为临时文件
canvas.toTempFilePath({
  x: 0, y: 0, width: canvas.width, height: canvas.height,
  destWidth: 200, destHeight: 200,
  fileType: 'png',
  quality: 0.9,
  success: ({ tempFilePath }) => { wx.saveImageToPhotosAlbum({ filePath: tempFilePath }); }
});
```

### 帧率控制

```javascript
wx.setPreferredFramesPerSecond(60); // 1-60，默认 60

// 监听帧率变化（基础库 3.3.0+）
wx.onFrameRecorderStateChange?.((res) => {
  console.log(res.state); // 'start'|'pause'|'resume'|'stop'
});
```

### 图片

```javascript
// 创建图片对象（主要用于 Canvas 贴图）
const img = canvas.createImage();
img.onload = () => { ctx.drawImage(img, 0, 0); };
img.onerror = (err) => { console.error(err); };
img.src = 'assets/hero.png'; // 本地或网络路径

// wx.createImage() 与 canvas.createImage() 效果相同
```

### 字体

```javascript
// 加载自定义字体（返回字体 family 名称）
const fontFamily = wx.loadFont('fonts/MyFont.ttf');
if (fontFamily) {
  ctx.font = `32px ${fontFamily}`;
}
```

---

## 网络通信

### HTTP 请求

```javascript
// wx.request 参数
const reqTask = wx.request({
  url: 'https://api.example.com/data',     // 必须 HTTPS
  method: 'POST',                           // GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS
  data: { userId: 'xxx' },                  // Object|String|ArrayBuffer
  header: { 'content-type': 'application/json' },
  dataType: 'json',                         // 'json'|'text'|'base64'|'arraybuffer'
  responseType: 'text',                     // 'text'|'arraybuffer'
  timeout: 10000,                           // 超时毫秒，默认 60000
  enableHttp2: false,                       // HTTP/2
  enableQuic: false,                        // QUIC 协议
  enableChunked: false,                     // 分块传输（流式响应）
  success: (res) => {
    // 注意：4xx/5xx 也走 success，需判断 res.statusCode
    if (res.statusCode === 200) { /* 处理数据 */ }
  },
  fail: (err) => { /* 网络不可达才走 fail */ }
});

// 中断请求
reqTask.abort();

// 监听响应头（在 success 前触发）
reqTask.onHeadersReceived(({ header }) => { console.log(header); });

// 流式接收（enableChunked: true 时）
reqTask.onChunkReceived(({ data }) => { /* ArrayBuffer */ });

// 并发限制：最多 10 个并发 HTTP 请求
```

### 下载与上传

```javascript
// 下载文件（最大 200MB）
const dlTask = wx.downloadFile({
  url: 'https://cdn.example.com/map.bin',
  filePath: `${wx.env.USER_DATA_PATH}/map.bin`, // 可选，不填则存临时目录
  success: ({ tempFilePath, statusCode }) => { /* 使用 tempFilePath */ },
});
dlTask.onProgressUpdate(({ progress, totalBytesWritten, totalBytesExpectedToWrite }) => {
  updateBar(progress); // 0-100
});
dlTask.abort();

// 上传文件（multipart/form-data POST）
const ulTask = wx.uploadFile({
  url: 'https://api.example.com/upload',
  filePath: tempFilePath,
  name: 'file',
  formData: { userId: 'xxx' },
  success: ({ data, statusCode }) => { /* data 为服务端响应字符串 */ }
});
ulTask.onProgressUpdate(({ progress }) => { updateBar(progress); });
ulTask.abort();
```

### WebSocket

```javascript
// 创建连接（最多 5 个并发）
const socket = wx.connectSocket({
  url: 'wss://ws.example.com/game',
  header: { Authorization: token },
  protocols: ['game-v1'],
});

socket.onOpen(() => { socket.send({ data: JSON.stringify({ type: 'join' }) }); });
socket.onMessage(({ data }) => { handleMsg(JSON.parse(data)); });
socket.onError(({ errMsg }) => { console.error(errMsg); });
socket.onClose(({ code, reason }) => { reconnect(); });

// 发送：data 支持 string | ArrayBuffer
socket.send({ data: buffer });
socket.close({ code: 1000, reason: 'normal' });
```

### UDP / TCP

```javascript
// UDP Socket
const udp = wx.createUDPSocket(); // 'udp4' | 'udp6'
const port = udp.bind(0);        // 绑定随机端口，返回实际端口号
udp.send({ address: '192.168.1.2', port: 9000, data: new Uint8Array([1, 2, 3]).buffer });
udp.onMessage(({ message, remoteInfo }) => { /* message: ArrayBuffer */ });
udp.onError(({ errMsg }) => {});
udp.close();

// TCP Socket
const tcp = wx.createTCPSocket();
tcp.connect({ address: '192.168.1.2', port: 9001 });
tcp.onConnect(() => { tcp.write(new Uint8Array([0x01]).buffer); });
tcp.onMessage(({ message }) => { /* message: ArrayBuffer */ });
tcp.onError(({ errMsg }) => {});
tcp.onClose(({ hadError }) => {});
tcp.close();
```

---

## 媒体

### 音频播放

```javascript
// 创建音频上下文（可多实例）
const audio = wx.createInnerAudioContext();

// 属性
audio.src           = 'assets/audio/bgm.mp3';  // 本地或网络路径
audio.autoplay      = false;
audio.loop          = true;
audio.volume        = 0.8;    // 0.0 - 1.0
audio.playbackRate  = 1.0;    // 播放速度
audio.startTime     = 0;      // 开始播放位置（秒）

// 只读属性
// audio.duration      总时长（秒）
// audio.currentTime   当前播放位置（秒）
// audio.paused        是否暂停

// 控制方法
audio.play();
audio.pause();
audio.stop();
audio.seek(30);     // 跳转到 30 秒
audio.destroy();    // 释放资源

// 事件回调
audio.onPlay(() => {});
audio.onPause(() => {});
audio.onStop(() => {});
audio.onEnded(() => {});
audio.onTimeUpdate(() => { /* audio.currentTime 变化 */ });
audio.onCanplay(() => { /* 可以播放了 */ });
audio.onError(({ errCode, errMsg }) => {});
audio.onSeeking(() => {});
audio.onSeeked(() => {});
audio.onWaiting(() => { /* 缓冲中 */ });

// 取消监听
audio.offPlay(handler);

// iOS 音频解锁（必须在用户首次触摸事件中播放）
let unlocked = false;
wx.onTouchStart(() => {
  if (!unlocked) {
    unlocked = true;
    const silent = wx.createInnerAudioContext();
    silent.src = 'assets/audio/silent.mp3';
    silent.volume = 0;
    silent.play();
    silent.onEnded(() => { silent.destroy(); bgm.play(); });
    wx.offTouchStart();
  }
});
```

### 录音

```javascript
// 全局唯一录音管理器
const recorder = wx.getRecorderManager();

recorder.start({
  format: 'mp3',            // 'mp3'|'aac'|'wav'|'PCM'
  sampleRate: 44100,        // 8000|11025|12000|16000|22050|24000|32000|44100|48000
  numberOfChannels: 1,      // 1（单声道）|2（立体声）
  encodeBitRate: 128000,    // 编码码率
  frameSize: 50,            // 指定帧大小（KB），触发 onFrameRecorded
  duration: 60000,          // 最长录制时长（毫秒），默认 60000
});

recorder.onStart(() => {});
recorder.onStop(({ tempFilePath, duration, fileSize }) => {
  // tempFilePath: 录音临时文件路径
  playRecording(tempFilePath);
});
recorder.onError(({ errMsg }) => {});
recorder.onFrameRecorded(({ frameBuffer, isLastFrame }) => {
  // 实时获取音频帧（PCM 数据 ArrayBuffer）
});

recorder.pause();
recorder.resume();
recorder.stop();
```

### 视频解码器

```javascript
// 视频逐帧解码（基础库 2.11.1+）
const decoder = wx.createVideoDecoder();

decoder.start({
  source: 'assets/video/cutscene.mp4',   // 本地或临时文件路径
  mode: 0,   // 0=按帧解码，1=实时解码
});

decoder.onStarted(() => { decodeLoop(); });

async function decodeLoop() {
  const frame = await decoder.getFrameData();
  if (frame) {
    // frame.width, frame.height, frame.data (ArrayBuffer, RGBA)
    // frame.pkPts: 时间戳（微秒）
    renderFrame(frame);
  }
}

decoder.seek(5000);  // 跳转到 5000ms
decoder.stop();
```

### 实时语音（VoIP）

```javascript
// 加入语音房间（需 scope.record 授权）
wx.joinVoIPChat({
  groupId: 'room-001',
  nonceStr: 'random123',
  signature: 'sha1-sign',  // 服务端签名
  timeStamp: Math.floor(Date.now() / 1000),
  success: () => {},
  fail: (err) => {},
});

// 监听成员变化
wx.onVoIPChatMembersChanged(({ openIdList, errCode, errMsg }) => {
  console.log('当前语音成员:', openIdList);
});

// 监听说话状态
wx.onVoIPChatSpeakersChanged(({ openIdList }) => {
  // 当前正在说话的用户
});

// 退出语音
wx.exitVoIPChat();
```

---

## 数据缓存

```javascript
// 异步版本（推荐在非关键路径使用）
wx.setStorage({ key: 'playerData', data: { score: 9999 }, success: () => {} });
wx.getStorage({ key: 'playerData', success: ({ data }) => { loadPlayer(data); }, fail: () => {} });
wx.removeStorage({ key: 'playerData' });
wx.clearStorage();
wx.getStorageInfo({ success: ({ keys, currentSize, limitSize }) => {
  console.log(`已用 ${currentSize}KB / ${limitSize}KB`);
}});

// 同步版本（简洁，用于同步流程）
try {
  wx.setStorageSync('token', 'abc123');
  const token = wx.getStorageSync('token'); // 不存在则返回 ''
  wx.removeStorageSync('token');
  wx.clearStorageSync();
  const info = wx.getStorageInfoSync(); // { keys, currentSize, limitSize }
} catch (e) { console.error(e); }

// 容量限制：单个 key 最大 1MB，总计最大 10MB
// 支持类型：string、number、boolean、Date、JSON 可序列化对象
```

---

## 文件系统

```javascript
const fs = wx.getFileSystemManager();

// 目录操作
fs.mkdirSync(`${wx.env.USER_DATA_PATH}/saves`, true); // true = 递归创建
fs.rmdirSync(`${wx.env.USER_DATA_PATH}/tmp`, true);
const files = fs.readdirSync(`${wx.env.USER_DATA_PATH}/saves`); // 返回文件名数组

// 文件读写
fs.writeFileSync(`${wx.env.USER_DATA_PATH}/save1.json`,
  JSON.stringify(saveData), 'utf8');

const raw = fs.readFileSync(`${wx.env.USER_DATA_PATH}/save1.json`, 'utf8');
const saveData = JSON.parse(raw);

// 追加写入
fs.appendFileSync(`${wx.env.USER_DATA_PATH}/log.txt`, 'hello\n', 'utf8');

// 复制、重命名、删除
fs.copyFileSync(src, dest);
fs.renameSync(oldPath, newPath);
fs.unlinkSync(filePath);

// 文件信息
const stat = fs.statSync(filePath);
// stat.size: 字节数, stat.lastModifiedTime: 时间戳

// 检查文件是否存在
try {
  fs.accessSync(filePath);
  // 文件存在
} catch (e) {
  // 文件不存在
}

// 异步版本（大文件推荐）
fs.readFile({
  filePath: `${wx.env.USER_DATA_PATH}/bigfile.bin`,
  encoding: 'binary',    // 'utf8'|'ascii'|'binary'|'base64'|'hex'
  success: ({ data }) => { /* data: string | ArrayBuffer */ },
});

// 解压 zip
fs.unzip({
  zipFilePath: `${wx.env.USER_DATA_PATH}/assets.zip`,
  targetPath: `${wx.env.USER_DATA_PATH}/assets/`,
  success: () => {},
});

// 读取压缩包内文件（不解压）
fs.readCompressedFile({
  filePath: `${wx.env.USER_DATA_PATH}/data.br`,
  compressionAlgorithm: 'br',  // 'br' = Brotli
  success: ({ data }) => { /* data: ArrayBuffer */ }
});
```

---

## 开放接口

### 登录与会话

```javascript
// 标准登录流程
async function login() {
  const { code } = await wx.login();      // 临时 code，5分钟有效
  // 发到自己服务器 → 服务器调 auth.code2Session → 返回 token
  const res = await callMyServer('/login', { code });
  wx.setStorageSync('token', res.token);
}

// 检查登录态是否过期
wx.checkSession({
  success: () => { /* session_key 未过期 */ },
  fail: () => { login(); /* 重新登录 */ }
});
```

### 用户信息

```javascript
// ⚠️ wx.getUserInfo 已废弃，改用以下方式：

// 方式 1：通过 getUserProfile（需用户点击触发）
wx.getUserProfile({
  desc: '用于完善玩家资料',
  success: ({ userInfo }) => {
    // userInfo.nickName, userInfo.avatarUrl, userInfo.gender
    // userInfo.country, userInfo.province, userInfo.city
  }
});

// 方式 2：创建 UserInfoButton（可自定义样式）
const btn = wx.createUserInfoButton({
  type: 'text',
  text: '获取头像',
  style: { left: 10, top: 10, width: 200, height: 60,
           backgroundColor: '#ff0000', color: '#ffffff', fontSize: 16,
           textAlign: 'center', borderRadius: 4 },
  withCredentials: false,
});
btn.onTap(({ userInfo }) => { /* 同上 */ });
btn.destroy();
```

### 授权

```javascript
// 主动申请授权（部分 scope 需要配合 button 触发）
wx.authorize({
  scope: 'scope.userLocation',  // 见下方 scope 列表
  success: () => { wx.getLocation(/* ... */); },
  fail: () => { wx.openSetting(); } // 引导用户在设置页开启
});

// scope 列表
// scope.userInfo           用户信息（已废弃）
// scope.userLocation       地理位置
// scope.userLocationBackground  后台定位
// scope.address            收货地址
// scope.invoiceTitle       发票抬头
// scope.werun              微信运动
// scope.record             录音
// scope.writePhotosAlbum   保存到相册
// scope.camera             摄像头

// 查询授权状态
wx.getSetting({
  success: ({ authSetting }) => {
    if (authSetting['scope.userLocation']) { /* 已授权 */ }
  }
});

// 打开设置页（让用户自行开关权限）
wx.openSetting({
  success: ({ authSetting }) => { /* 用户操作后的最新状态 */ }
});
```

### 开放数据域（关系链/排行榜）

```javascript
// 主域：获取开放数据域上下文
const openDataCtx = wx.getOpenDataContext();

// 向开放数据域发送消息
openDataCtx.postMessage({
  type: 'SHOW_LEADERBOARD',
  width: 400,
  height: 300,
});

// 获取 sharedCanvas（开放数据域渲染到此 canvas）
const sharedCanvas = openDataCtx.canvas;
// sharedCanvas.width / height 按需设置
// 在游戏循环中将 sharedCanvas 绘制到主 canvas
ctx.drawImage(sharedCanvas, x, y, w, h);

// -------- 开放数据域内部 --------
// 存储分数（主域/开放数据域均可调用）
wx.setUserCloudStorage({
  KVDataList: [{ key: 'score', value: String(9999) }],
  success: () => {}
});

// 仅在开放数据域内可用：
wx.getFriendCloudStorage({
  keyList: ['score'],
  success: ({ data }) => {
    // data: Array<{ openid, nickname, avatarUrl, KVDataList }>
    renderLeaderboard(data);
  }
});

wx.getGroupCloudStorage({
  shareTicket: shareTicket,
  keyList: ['score'],
  success: ({ data }) => { /* 同上 */ }
});
```

### 分享与转发

```javascript
// 主动分享（需在 button 的 tap 回调中调用）
wx.shareAppMessage({
  title: '我在游戏中得了 9999 分！',
  imageUrl: 'https://cdn.example.com/share.jpg',   // 5:4 比例
  imageUrlId: 'share-image-id',                     // 审核通过的素材 ID
  query: 'scene=share&from=xxx',                    // 拼接到启动参数
  // path: '/challenge/'  // 独立分包的分享路径
});

// 转发到群（获取 shareTicket，用于群排行）
wx.updateShareMenu({
  withShareTicket: true,
  isUpdatableMessage: false,
});

// 接收分享来源
const opts = wx.getLaunchOptionsSync();
// opts.scene   启动场景（1007=单人对话分享，1008=群聊分享...）
// opts.query   分享时传递的 query
// opts.shareTicket

wx.onShow((opts) => {
  // 每次从后台切回前台时也触发，可获取新的分享 scene
});
```

### 游戏圈

```javascript
const clubBtn = wx.createGameClubButton({
  type: 'image',       // 'text' | 'image'
  image: 'assets/club-btn.png',
  style: { left: 20, top: 100, width: 80, height: 80 },
});
clubBtn.onTap(() => { /* 进入游戏圈 */ });
clubBtn.show();
clubBtn.hide();
clubBtn.destroy();
```

### 跳转

```javascript
// 打开另一个小程序（需用户触摸触发）
wx.navigateToMiniProgram({
  appId: 'wx1234567890abcdef',
  path: '/pages/index',
  extraData: { from: 'game' },
  success: () => {},
});

// 退回上一个小程序
wx.navigateBackMiniProgram({ extraData: {} });

// 退出当前小游戏
wx.exitMiniProgram();

// 重启当前小游戏
wx.restartMiniProgram();
```

---

## 广告变现

### 激励视频广告（最主流）

```javascript
let rewardAd;

function initRewardAd() {
  rewardAd = wx.createRewardedVideoAd({ adUnitId: 'adunit-xxx' });
  rewardAd.onLoad(() => { console.log('广告加载完毕'); });
  rewardAd.onError(({ errCode, errMsg }) => {
    // errCode 1000: 后端错误 / 1001: 广告单元无效 / 1002: 无广告填充
    // errCode 1006: 广告组件被限制
    console.error(errCode, errMsg);
  });
  rewardAd.onClose(({ isEnded }) => {
    if (isEnded) {
      giveReward(); // 用户看完整广告，发奖励
    }
  });
}

async function showRewardAd() {
  try {
    await rewardAd.load();   // 预加载
    await rewardAd.show();   // 展示
  } catch (err) {
    console.error('广告展示失败', err);
    // 降级处理：提示用户稍后再试
  }
}
```

### Banner 广告

```javascript
// ⚠️ BannerAd 自 3.5.5 废弃，推荐 CustomAd
const banner = wx.createBannerAd({
  adUnitId: 'adunit-yyy',
  style: { left: 0, top: windowHeight - 100, width: windowWidth, height: 100 },
  adIntervals: 30,  // 刷新间隔（秒）
});
banner.onResize(({ width, height }) => {
  // 广告实际尺寸可能与设定不同，需重新定位
  banner.style.top = windowHeight - height;
});
banner.onLoad(() => { banner.show(); });
banner.onError(({ errCode }) => {});
banner.show();
banner.hide();
banner.destroy();
```

### 插屏广告

```javascript
const interstitial = wx.createInterstitialAd({ adUnitId: 'adunit-zzz' });
interstitial.onLoad(() => {});
interstitial.onError(({ errCode }) => {});
interstitial.onClose(() => { /* 用户关闭后继续游戏 */ });
// 在关卡结算时展示
interstitial.show().catch(console.error);
```

### 原生模板广告

```javascript
const customAd = wx.createCustomAd({
  adUnitId: 'adunit-custom',
  style: { left: 10, top: 10 },
});
customAd.onLoad(() => { customAd.show(); });
customAd.onClose(() => {});
customAd.hide();
customAd.destroy();
```

### 格子广告

```javascript
const gridAd = wx.createGridAd({
  adUnitId: 'adunit-grid',
  adTheme: 'white',   // 'white' | 'black'
  gridCount: 5,       // 3 | 5
  style: { left: 0, top: 100, width: windowWidth },
});
gridAd.onLoad(() => { gridAd.show(); });
gridAd.onError(({ errCode }) => {});
```

---

## 设备能力

### 网络状态

```javascript
wx.getNetworkType({
  success: ({ networkType }) => {
    // 'wifi' | '2g' | '3g' | '4g' | '5g' | 'none' | 'unknown'
    if (networkType === 'none') showOfflineModal();
  }
});

wx.onNetworkStatusChange(({ isConnected, networkType }) => {
  if (!isConnected) showOfflineUI();
});
```

### 加速度计、陀螺仪、罗盘

```javascript
// 加速度计
wx.startAccelerometer({
  interval: 'game',   // 'game'≈20ms | 'ui'≈60ms | 'normal'≈200ms
});
wx.onAccelerometerChange(({ x, y, z }) => {
  // x/y/z：三轴加速度（单位 g）
  tiltPlayer(x, y);
});
wx.stopAccelerometer();

// 陀螺仪
wx.startGyroscope({ interval: 'game' });
wx.onGyroscopeChange(({ x, y, z }) => {
  // x/y/z：三轴角速度（弧度/秒）
});
wx.stopGyroscope();

// 罗盘
wx.startCompass();
wx.onCompassChange(({ direction }) => {
  // direction: 顺时针角度（0-360，0=正北）
});
wx.stopCompass();
```

### 屏幕与振动

```javascript
wx.setKeepScreenOn({ keepScreenOn: true });          // 防止锁屏
wx.setScreenBrightness({ value: 0.8 });              // 屏幕亮度 0-1
wx.getScreenBrightness({ success: ({ value }) => {} });

wx.vibrateShort({ type: 'medium' });  // 'heavy'|'medium'|'light'（15ms）
wx.vibrateLong();                     // 400ms 强振动
```

### 电量与内存

```javascript
wx.getBatteryInfo({
  success: ({ level, isCharging }) => {
    if (level < 10 && !isCharging) showLowBatteryHint();
  }
});

wx.onMemoryWarning(({ level }) => {
  // level 10: 低内存警告，level 15: 严重不足（iOS/鸿蒙）
  if (level >= 10) {
    imageCache.clear();
    wx.triggerGC();
  }
});
```

### 蓝牙

```javascript
wx.openBluetoothAdapter({
  success: () => {
    wx.startBluetoothDevicesDiscovery({
      services: ['FEE7'],  // 指定 service UUID 过滤
      allowDuplicatesKey: false,
    });
  }
});

wx.onBluetoothDeviceFound(({ devices }) => {
  devices.forEach(d => console.log(d.name, d.deviceId, d.RSSI));
});

wx.stopBluetoothDevicesDiscovery();
wx.closeBluetoothAdapter();
```

### 扫码

```javascript
wx.scanCode({
  onlyFromCamera: true,      // 只允许相机扫（不从相册选）
  scanType: ['barCode', 'qrCode'],
  success: ({ result, scanType }) => {
    console.log('扫码结果:', result);
  }
});
```

---

## 界面交互

```javascript
// Toast 提示
wx.showToast({
  title: '操作成功',
  icon: 'success',    // 'success'|'error'|'loading'|'none'
  image: '',          // 自定义图标（与 icon 互斥）
  duration: 2000,     // 停留时间（毫秒）
  mask: false,        // 是否显示透明蒙层防止点穿
});
wx.hideToast();

// Loading 提示
wx.showLoading({ title: '加载中...', mask: true });
wx.hideLoading();

// Modal 对话框
wx.showModal({
  title: '提示',
  content: '确认退出游戏？',
  confirmText: '确认',    // 最多 4 字符
  cancelText: '取消',
  confirmColor: '#ff4444',
  success: ({ confirm, cancel }) => {
    if (confirm) exitGame();
  }
});

// ActionSheet 操作菜单
wx.showActionSheet({
  itemList: ['重新开始', '设置', '退出'],
  itemColor: '#000000',
  success: ({ tapIndex }) => {
    if (tapIndex === 0) restartGame();
  }
});

// 键盘（移动端输入框）
wx.showKeyboard({
  defaultValue: '',
  maxLength: 20,
  multiple: false,      // 是否多行
  confirmHold: false,   // 点击完成后是否保持键盘
  confirmType: 'done',  // 'done'|'next'|'search'|'go'|'send'
});
wx.onKeyboardInput(({ value }) => { inputField.text = value; });
wx.onKeyboardConfirm(({ value }) => { submitInput(value); wx.hideKeyboard(); });
wx.onKeyboardHeightChange(({ height }) => { adjustLayout(height); });
wx.hideKeyboard();
wx.updateKeyboard({ value: '新值' }); // 更新输入框内容
```

---

## Worker 多线程

```javascript
// 主线程：创建 Worker
const worker = wx.createWorker('workers/heavy.js', {
  useExperimentalWorker: false  // true = 独立进程（更稳定但启动慢）
});

worker.postMessage({ type: 'COMPUTE', data: bigData });
worker.onMessage(({ message }) => {
  // message: 从 worker 返回的结果
  applyResult(message.result);
});
worker.onError(({ message }) => { console.error(message); });
worker.onProcessKilled(() => { console.warn('Worker 进程被杀死'); });
worker.terminate(); // 销毁 Worker

// -------- workers/heavy.js（Worker 线程） --------
// Worker 内部通过全局 worker 对象通信
worker.onMessage(({ message }) => {
  if (message.type === 'COMPUTE') {
    const result = heavyCompute(message.data);
    worker.postMessage({ result });
  }
});

// 注意：Worker 不能操作 DOM/Canvas，不能调用大多数 wx.* API
// 适合：路径寻址、AI 计算、数据解析、物理模拟等 CPU 密集任务
```

---

## 游戏对局回放

```javascript
// 检查设备是否支持录制
const recorder = wx.getGameRecorder();
if (!recorder.isFrameSupported()) {
  console.log('当前设备不支持游戏录制');
  return;
}

// 开始录制
recorder.start({
  duration: 300,      // 最长录制秒数（5-7200，默认 7200）
  fps: 24,            // 24 | 30（默认 24）
  bitrate: 1000,      // 码率 600-3000 kbps（默认 1000）
  gop: 12,            // 关键帧间隔（默认 12）
  hookBgm: true,      // 录制游戏音效（仅 iOS）
});

recorder.on('start', () => { console.log('录制开始'); });
recorder.on('stop', ({ videoPath }) => {
  // videoPath: 录制完成的视频文件路径
  shareReplay(videoPath);
});
recorder.on('error', ({ errCode }) => {});
recorder.on('timeUpdate', ({ currentTime }) => { /* 当前录制时长 */ });

recorder.pause();
recorder.resume();
recorder.stop();
recorder.abort(); // 取消录制（不保存）

// 分享回放视频
function shareReplay(videoPath) {
  wx.shareAppMessage({
    title: '看我的精彩操作！',
    imageUrl: 'https://cdn.example.com/replay-cover.jpg',
    extra: {
      videoPath,           // 必填：录制的视频路径
      videoTopics: ['我的游戏时刻'], // 话题标签
    }
  });
}
```

---

## 游戏服务

> 帧同步/实时对战需要申请「游戏服务」，在微信公众平台开通。

```javascript
const gsm = wx.getGameServerManager();

// ---- 房间管理 ----
// 创建房间
gsm.createRoom({
  maxMemberNum: 4,
  roomType: 'public',    // 'public'|'private'
  startPercent: 100,     // 满员 N% 自动开始
  needUserInfo: true,
});

// 加入房间
gsm.joinRoom({ roomIdOrNum: 'ABCD' });
gsm.leaveRoom({});
gsm.getRoomInfo({
  success: ({ room }) => {
    // room.roomId, room.memberList, room.gameStatus
  }
});

// 换座位 / 踢出成员
gsm.changeSeat({ newPosNum: 2 });
gsm.kickoutMember({ openId: 'xxx' });

// ---- 匹配 ----
gsm.startMatch({ matchId: 'match-001' });
gsm.cancelMatch({ matchId: 'match-001' });

// ---- 帧同步 ----
gsm.startGame({});
gsm.uploadFrame({
  frameInfo: JSON.stringify({ action: 'move', x: 100, y: 200 }),
});
gsm.onSyncFrame(({ frameList }) => {
  // frameList: 所有玩家本帧的操作集合，用于确定性逻辑
  processFrame(frameList);
});
gsm.onLockStepError(({ errCode }) => {
  console.error('帧同步错误:', errCode);
});
gsm.getLostFrames({ beginFrameId: 10, endFrameId: 20,
  success: ({ frameList }) => { replayMissedFrames(frameList); }
});
gsm.endGame({});

// ---- 广播 ----
gsm.broadcastInRoom({
  msg: JSON.stringify({ type: 'chat', text: 'GG' }),
  toPlayerOpenId: [],  // 空数组 = 广播给全房间
});

// ---- 房间内消息监听 ----
gsm.onRoomInfoChange(({ room }) => { updateRoomUI(room); });
gsm.onMemberLeaveRoom(({ openId }) => { removePlayer(openId); });
gsm.onGameStart(() => { startLocalGame(); });
```

---

## AI 能力

### 本地 AI 推理（ONNX）

```javascript
// 创建推理会话（基础库 2.18.0+）
const session = wx.createInferenceSession({
  model: 'models/classifier.onnx',  // 代码包或本地路径
  precisionLevel: 4,   // 1-4，4=最高精度（默认）
  allowNSFW: false,
  allowQuantize: false,
});

session.onLoad(() => {
  runInference();
});
session.onError(({ errMsg }) => { console.error(errMsg); });

async function runInference() {
  const result = await session.run({
    input: {                      // key = 模型输入节点名
      data: new Float32Array(224 * 224 * 3), // 输入数据
      shape: [1, 3, 224, 224],    // NCHW 格式
      type: 'float32',
    }
  });
  // result.output: { data: Float32Array, shape: [...] }
  classify(result.output.data);
}

session.destroy();
```

### Vision Kit（AR/人脸/手势检测）

```javascript
// 检查设备支持
if (!wx.isVKSupport('v2')) {
  console.log('不支持 VisionKit v2');
}

// 创建 VK 会话
const session = wx.createVKSession({
  track: {
    plane: { mode: 1 },   // 平面检测
    face: { mode: 2 },    // 2D 人脸
    hand: { mode: 1 },    // 手势检测
    body: { mode: 1 },    // 人体骨骼
  },
  version: 'v2',
  gl,   // WebGL 上下文
});

session.start((errCode) => {
  if (errCode) return;
  requestAnimationFrame(() => loop(session));
});

function loop(session) {
  session.detectFace({
    frameBuffer,  // 视频帧 ArrayBuffer
    width, height,
    scoreThreshold: 0.5,
    sourceType: 1,  // 1=前摄，2=后摄
  });
  const frame = session.getVKFrame(canvas.width, canvas.height);
  if (frame) {
    // frame.camera.viewMatrix   相机视图矩阵
    // frame.camera.intrinsics   相机内参
  }
  requestAnimationFrame(() => loop(session));
}

session.stop();
session.destroy();
```

### 人脸检测（简化版）

```javascript
wx.initFaceDetect();

wx.faceDetect({
  frameBuffer,       // ArrayBuffer: RGBA 帧数据
  width, height,
  enablePoint: true,       // 106 个关键点
  enableConf: true,        // 置信度
  enableAngle: true,       // 角度
  enableMultiFace: false,  // 多人脸
  success: ({ faceNumber, faceList }) => {
    faceList.forEach(face => {
      // face.x, face.y: 位置
      // face.width, face.height
      // face.pointList: 关键点数组
      // face.angleArray: { pitch, yaw, roll }
      // face.confArray: 各关键点置信度
    });
  }
});

wx.stopFaceDetect();
```

---

## 数据分析

```javascript
// 自定义事件上报（需在小游戏后台配置事件）
wx.reportEvent('level_complete', {
  level_id: 3,
  score: 9999,
  duration: 120,
});

// 自定义性能监控指标
wx.reportMonitor('load_time', 2500); // 监控项 ID, 数值

// A/B 实验配置获取
const expInfo = wx.getExptInfoSync(['exp_group', 'button_color']);
// expInfo: { exp_group: 'A', button_color: 'red' }
if (expInfo.exp_group === 'A') { /* 实验组逻辑 */ }

// 实时日志（线上排查）
const rtLogger = wx.getRealtimeLogManager();
rtLogger.info('game_start', { level: 1 });
rtLogger.error('load_failed', { url: '...', code: 404 });
rtLogger.setFilterMsg('crash_report');
```

---

## 跳转与生命周期

```javascript
// ---- 生命周期 ----
wx.onShow((options) => {
  // 每次从后台切回前台触发
  // options.scene: 场景值（1001=发现页，1005=顶部搜索，...）
  // options.query: 启动参数
  resumeGame();
});

wx.onHide(() => {
  // 切到后台
  pauseGame();
  autoSave();
});

wx.onError((errMsg) => {
  console.error('未捕获错误:', errMsg);
  reportErrorToServer(errMsg);
});

wx.onUnhandledRejection(({ reason, promise }) => {
  console.error('未处理的 Promise rejection:', reason);
});

wx.onAudioInterruptionBegin(() => { bgm.pause(); }); // 来电/通知打断音频
wx.onAudioInterruptionEnd(() => { bgm.play(); });    // 打断结束恢复

// 获取启动参数（同步）
const launchOpts = wx.getLaunchOptionsSync();
// launchOpts.scene, launchOpts.query, launchOpts.referrerInfo

// ---- 跳转 ----
wx.navigateToMiniProgram({ appId: 'wxXXXX', path: '/pages/index' });
wx.navigateBackMiniProgram({ extraData: { result: 'win' } });
wx.exitMiniProgram();
wx.restartMiniProgram();
```
