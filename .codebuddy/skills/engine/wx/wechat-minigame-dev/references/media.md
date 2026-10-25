# 音频与媒体

## 音频系统架构

微信小游戏音频 API：`wx.createInnerAudioContext()`

建议在游戏中封装一个音频管理器，统一管理背景音乐和音效：

```javascript
// AudioManager.js
class AudioManager {
  constructor() {
    this.bgm = null;
    this.sfxPool = new Map(); // key: soundName, value: InnerAudioContext
    this.bgmVolume = 1.0;
    this.sfxVolume = 1.0;
    this.bgmEnabled = true;
    this.sfxEnabled = true;
    
    // 从存储中恢复设置
    this.bgmEnabled = wx.getStorageSync('bgmEnabled') ?? true;
    this.sfxEnabled = wx.getStorageSync('sfxEnabled') ?? true;
    this.bgmVolume = wx.getStorageSync('bgmVolume') ?? 1.0;
  }

  // 播放背景音乐
  playBGM(url, loop = true) {
    if (this.bgm) {
      this.bgm.stop();
      this.bgm.destroy();
    }
    
    this.bgm = wx.createInnerAudioContext();
    this.bgm.src = url;
    this.bgm.loop = loop;
    this.bgm.volume = this.bgmVolume;
    this.bgm.autoplay = true;
    
    if (this.bgmEnabled) {
      this.bgm.play();
    }
    
    this.bgm.onError((err) => {
      console.error('BGM 播放失败', err);
    });
  }

  // 播放音效（支持并发）
  playSFX(url, volume = 1.0) {
    if (!this.sfxEnabled) return;
    
    const audio = wx.createInnerAudioContext();
    audio.src = url;
    audio.volume = this.sfxVolume * volume;
    audio.play();
    
    // 播放完毕后销毁（避免内存泄漏）
    audio.onEnded(() => audio.destroy());
    audio.onError(() => audio.destroy());
  }

  // 预加载音效（提前缓存，减少首次播放延迟）
  preloadSFX(sounds) {
    sounds.forEach(({ name, url }) => {
      const audio = wx.createInnerAudioContext();
      audio.src = url;
      audio.volume = 0;
      audio.play(); // 触发加载
      audio.onCanplay(() => {
        audio.stop();
        this.sfxPool.set(name, url); // 只保存 url，播放时新建实例
      });
    });
  }

  toggleBGM() {
    this.bgmEnabled = !this.bgmEnabled;
    wx.setStorageSync('bgmEnabled', this.bgmEnabled);
    
    if (this.bgmEnabled) {
      this.bgm?.play();
    } else {
      this.bgm?.pause();
    }
  }

  toggleSFX() {
    this.sfxEnabled = !this.sfxEnabled;
    wx.setStorageSync('sfxEnabled', this.sfxEnabled);
  }

  // 游戏切后台时暂停
  pause() {
    this.bgm?.pause();
  }

  // 游戏切回前台时恢复
  resume() {
    if (this.bgmEnabled) {
      this.bgm?.play();
    }
  }
}

export const audioManager = new AudioManager();

// 在 game.js 中注册生命周期
wx.onHide(() => audioManager.pause());
wx.onShow(() => audioManager.resume());
```

---

## 音频使用示例

```javascript
import { audioManager } from './AudioManager.js';

// 进入主菜单时播放 BGM
audioManager.playBGM('https://cdn.game.com/audio/menu_bgm.mp3');

// 按钮点击音效
function onButtonClick() {
  audioManager.playSFX('https://cdn.game.com/audio/click.mp3');
}

// 开枪音效（高频触发，注意不要创建太多实例）
function onShoot() {
  audioManager.playSFX('https://cdn.game.com/audio/shoot.wav', 0.8);
}

// 切换音效设置
function onToggleBGM() {
  audioManager.toggleBGM();
}
```

---

## 注意事项

1. **首次播放限制**：iOS 要求必须在用户手势事件（触摸/点击）回调中触发首次播放，否则无声
   ```javascript
   wx.onTouchStart(() => {
     // 在首次触摸时播放，解锁 iOS 音频
     audioManager.playBGM(bgmUrl);
     wx.offTouchStart(); // 只需解锁一次
   });
   ```

2. **同时播放数量**：建议同时存在的 `InnerAudioContext` 不超过 20 个

3. **格式兼容**：
   - MP3：iOS 和 Android 都支持（推荐）
   - WAV：支持但文件大
   - AAC：iOS 支持好

4. **本地音频**：可以直接使用代码包内的相对路径，也可以使用下载后的本地文件路径

---

## 实时语音（多人游戏）

```javascript
// 加入实时语音房间（需要联系微信开通）
wx.joinVoIPChat({
  groupId: 'room_123',
  openIdList: ['openid1', 'openid2'],
  signature: 'server_generated_signature', // 服务端生成
  nonceStr: 'nonce',
  timeStamp: Date.now(),
  success: () => console.log('加入语音房间成功'),
  fail: console.error
});

// 离开语音
wx.exitVoIPChat();
```

---

## 录音功能（UGC 内容）

```javascript
const recorderManager = wx.getRecorderManager();

recorderManager.onStart(() => console.log('开始录音'));
recorderManager.onStop((res) => {
  // res.tempFilePath: 录音文件临时路径
  uploadRecording(res.tempFilePath);
});
recorderManager.onError(console.error);

// 开始录音（需要用户授权 scope.record）
function startRecording() {
  recorderManager.start({
    duration: 60000,   // 最长 60 秒
    sampleRate: 16000, // 采样率
    encodeBitRate: 96000,
    format: 'mp3',
  });
}

function stopRecording() {
  recorderManager.stop();
}
```
