/**
 * 种子随机数生成器（mulberry32）
 * 保证同一关卡 seed 每次生成完全相同的局面
 */
export default class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
  }

  /** 返回 [0, 1) */
  next() {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 返回 [0, maxExclusive) 的整数 */
  int(maxExclusive) {
    return Math.floor(this.next() * maxExclusive);
  }
}
