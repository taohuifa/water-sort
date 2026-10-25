/**
 * 轻量动画管理：倒水流线、成品飞向货架、非法抖动
 * （方案 8.4 阶段三的简化版，提前融入以获得基本反馈感）
 */

const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);

export default class Anims {
  constructor() {
    this.list = [];
  }

  addPour(opts) {
    this.list.push({ type: 'pour', t: 0, dur: 0.38, ...opts });
  }

  addFly(opts) {
    this.list.push({ type: 'fly', t: 0, dur: 0.5, ...opts });
  }

  /** 满瓶完成标记：满色瓶停留展示 ✓ 徽章，结束后再起飞去货架 */
  addBadge(opts) {
    this.list.push({ type: 'badge', t: 0, dur: 0.5, ...opts });
  }

  addShake(bottleIdx) {
    // 同一瓶重复抖动直接跳过
    if (this.list.some((a) => a.type === 'shake' && a.bottleIdx === bottleIdx)) return;
    this.list.push({ type: 'shake', t: 0, dur: 0.3, bottleIdx });
  }

  update(dt) {
    for (const a of this.list) a.t += dt / a.dur;
    const done = this.list.filter((a) => a.t >= 1);
    this.list = this.list.filter((a) => a.t < 1);
    for (const a of done) a.onDone && a.onDone();
  }

  /** 是否有阻塞性动画（倒水/飞行中需锁输入） */
  blocking() {
    return this.list.some((a) => a.type !== 'shake');
  }

  allDone() {
    return this.list.length === 0;
  }

  activePour() {
    return this.list.find((a) => a.type === 'pour');
  }

  flyOf(bottleIdx) {
    return this.list.find((a) => a.type === 'fly' && a.bottleIdx === bottleIdx);
  }

  badgeOf(bottleIdx) {
    return this.list.find((a) => a.type === 'badge' && a.bottleIdx === bottleIdx);
  }

  /** 抖动水平偏移 */
  shakeOffset(bottleIdx) {
    let dx = 0;
    for (const a of this.list) {
      if (a.type === 'shake' && a.bottleIdx === bottleIdx) {
        dx += Math.sin(a.t * Math.PI * 6) * 6 * (1 - a.t);
      }
    }
    return dx;
  }

  /** 倒水动画中已转移的层数 */
  pourMoved(a) {
    return Math.min(a.amount, Math.ceil(a.amount * easeOutQuad(Math.min(a.t, 1))));
  }

  /** 倒水进度缓动（用于源瓶倾斜） */
  pourEase(a) {
    return easeOutQuad(Math.min(a.t, 1));
  }
}
