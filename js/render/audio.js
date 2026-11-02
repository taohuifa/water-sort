/**
 * 音效模块：素材优先（assets/audio/*.mp3，见 docs/audio-licenses.json 授权留档）+ WebAudio 合成兜底。
 * 启动时异步解码素材为 buffer（best-effort，缺文件/解码失败回落合成音），音频异常静默降级，绝不阻塞游戏。
 *
 * 音效清单（素材 / 合成兜底口径）：
 * - tap      选中瓶子（气泡点击 / 短促高频）
 * - button   按钮点击（界面点击音 / 短音）
 * - invalid  非法操作（界面提示音 / 低频短音）
 * - pour     倒水（倒水入罐声 1.2s 响亮段起播 · 2x 加速 · 2x 增益 · 0.38s 与动画同步 / 低通滤波白噪声）
 * - complete 完成一瓶（成功提示音 / 上行双音）
 * - win      通关（成就铃 / 小旋律）
 * - bgm      背景音乐循环（playBgm/stopBgm，受声音开关联动）
 */
/**
 * 响度归一增益表（静态配置，离线生成，零运行时开销）：
 * 由 skill 脚本 `analyze-sfx.mjs` 按各音效实际发声段 RMS 对齐目标响度 0.15 计算得出，
 * 含峰值保护（增益后 Peak ≤ 0.9）。素材更换/裁剪参数变化后需重跑脚本刷新此表。
 */
const GAINS = { button: 2, complete: 0.25, invalid: 0.7, pour: 1.45, tap: 1.2, win: 1.15 }; // 2026-11-02 人工调音台定稿（analyze-sfx 公式打底 + gen-sfx-tuner 用户拖杆微调）

export default class Audio {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.sfxVol = 1; // 音效音量 0~1（PRD-设置页音量调节）
    this.bgmVol = 0.4; // 音乐音量 0~1（默认 0.4 与历史固定增益一致，升级无跳变）
    this.ctx = null; // 惰性创建
    this._bufs = {}; // name -> AudioBuffer（素材解码完成后填充）
    this._bgmBuf = null; // BGM 素材 buffer
    this._bgmSrc = null; // BGM 播放源（null=未在播）
    this._bgmGain = null; // BGM 增益节点引用（音量实时可调）
    this._bgmWanted = false; // 业务期望 BGM 播放（开关恢复/素材就绪后据此起播）
    this._loadAssets(); // 异步 best-effort，失败静默回落合成
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v) this.stopBgm();
    else if (this._bgmWanted) this.playBgm();
  }

  /** 设置音效/音乐音量（0~1，超界裁剪）；BGM 在播时实时生效 */
  setVolumes(sfx, bgm) {
    this.sfxVol = Math.min(1, Math.max(0, sfx));
    this.bgmVol = Math.min(1, Math.max(0, bgm));
    try {
      if (this._bgmGain) this._bgmGain.gain.value = this.bgmVol;
    } catch (e) { /* 静默降级 */ }
  }

  play(name) {
    if (!this.enabled) return;
    try {
      const buf = this._bufs[name];
      if (buf) this._playBuf(name, buf);
      else this._play(name); // 素材未就绪/缺失：合成兜底
    } catch (e) {
      // 音频失败静默降级
    }
  }

  /** 素材播放：BufferSource 直出；pour 与倒水动画（anims.js addPour dur=0.38s）严格同步；音量 = sfxVol x 响度归一增益 */
  _playBuf(name, buf) {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    if (name === 'pour') {
      // 从 0.9s 响亮段起播（试听选定，素材前 0.9s 为安静起手）+ 2x 加速 + 0.38s 与动画同步；不淡出
      if (src.playbackRate) src.playbackRate.value = 2;
      g.gain.value = this.sfxVol * (GAINS[name] || 1);
      src.connect(g);
      g.connect(this.ctx.destination);
      src.start(t, 0.9);
      src.stop(t + 0.38);
      return;
    }
    g.gain.value = this.sfxVol * (GAINS[name] || 1);
    src.connect(g);
    g.connect(this.ctx.destination);
    src.start(t);
  }

  /** BGM：循环播放（首次触摸后由 main 调起；开关切换联动） */
  playBgm() {
    this._bgmWanted = true;
    if (!this.enabled || !this._bgmBuf || this._bgmSrc) return;
    try {
      const ctx = this._ensureCtx();
      const src = ctx.createBufferSource();
      src.buffer = this._bgmBuf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = this.bgmVol; // 音乐音量（PRD-设置页音量调节，默认 0.4 压低不盖音效）
      src.connect(g);
      g.connect(ctx.destination);
      src.start(0);
      this._bgmSrc = src;
      this._bgmGain = g;
    } catch (e) {
      // 静默降级：无 BGM 不影响游戏
    }
  }

  stopBgm() {
    this._bgmWanted = false;
    try {
      if (this._bgmSrc) {
        this._bgmSrc.stop();
        this._bgmSrc = null;
        this._bgmGain = null;
      }
    } catch (e) {
      this._bgmSrc = null;
      this._bgmGain = null;
    }
  }

  /** 加载 assets/audio/ 素材（缺 getFileSystemManager / 文件 / decodeAudioData 均静默回落） */
  _loadAssets() {
    try {
      if (typeof wx === 'undefined' || !wx.getFileSystemManager) return;
      const fs = wx.getFileSystemManager();
      ['tap', 'button', 'invalid', 'pour', 'complete', 'win'].forEach((n) => {
        try {
          this._decode(fs.readFileSync(`assets/audio/${n}.mp3`), (buf) => { this._bufs[n] = buf; });
        } catch (e) { /* 单个素材缺失只影响该音效 */ }
      });
      this._decode(fs.readFileSync('assets/audio/bgm.mp3'), (buf) => {
        this._bgmBuf = buf;
        if (this._bgmWanted) this.playBgm(); // 素材晚于首次 playBgm 到位时补起播
      });
    } catch (e) { /* 整体回落合成 */ }
  }

  _decode(arrayBuf, cb) {
    const ctx = this._ensureCtx();
    if (!ctx || typeof ctx.decodeAudioData !== 'function') return;
    let done = false;
    const once = (buf) => { if (!done) { done = true; cb(buf); } };
    try {
      const p = ctx.decodeAudioData(arrayBuf, once); // 兼容回调式与 Promise 式实现
      if (p && typeof p.then === 'function') p.then(once).catch(() => {});
    } catch (e) { /* 解码失败回落合成 */ }
  }

  _ensureCtx() {
    if (!this.ctx) this.ctx = wx.createWebAudioContext();
    return this.ctx;
  }

  _play(name) {
    this._ensureCtx();
    const t = this.ctx.currentTime;
    switch (name) {
      case 'tap':
        this._tone(t, 880, 0.05, 0.12);
        break;
      case 'button':
        this._tone(t, 660, 0.06, 0.15);
        break;
      case 'invalid':
        this._tone(t, 180, 0.12, 0.18);
        break;
      case 'pour':
        this._noise(t, 0.32, 1200, 0.22);
        break;
      case 'complete':
        this._tone(t, 660, 0.09, 0.16);
        this._tone(t + 0.09, 880, 0.12, 0.16);
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this._tone(t + i * 0.13, f, 0.12, 0.18));
        break;
      default:
        break;
    }
  }

  /** 单音：正弦 + 指数衰减包络 */
  _tone(t, freq, dur, vol) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol * this.sfxVol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur);
  }

  /** 白噪声 + 低通滤波（倒水声），自带线性衰减 */
  _noise(t, dur, cutoff, vol) {
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buffer = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.value = vol * this.sfxVol;
    src.connect(filter);
    filter.connect(g);
    g.connect(this.ctx.destination);
    src.start(t);
  }
}
