/**
 * 音效模块：微信 WebAudio 实时合成，无需任何音频资源文件。
 * 惰性创建 AudioContext（首次播放时），音频异常静默降级，绝不阻塞游戏。
 *
 * 音效清单：
 * - tap      选中瓶子（短促高频）
 * - button   按钮点击
 * - invalid  非法操作（低频短音）
 * - pour     倒水（低通滤波白噪声）
 * - complete 完成一瓶（上行双音）
 * - win      通关（小旋律）
 */
export default class Audio {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.ctx = null; // 惰性创建
  }

  setEnabled(v) {
    this.enabled = v;
  }

  play(name) {
    if (!this.enabled) return;
    try {
      this._play(name);
    } catch (e) {
      // 音频失败静默降级
    }
  }

  _play(name) {
    if (!this.ctx) this.ctx = wx.createWebAudioContext();
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
    g.gain.setValueAtTime(vol, t);
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
    g.gain.value = vol;
    src.connect(filter);
    filter.connect(g);
    g.connect(this.ctx.destination);
    src.start(t);
  }
}
