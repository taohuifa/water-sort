import Rng from './rng.js';
import { CAPACITY } from './levels.js';

/**
 * 纯逻辑层：瓶子数据结构、倒液规则、满瓶判定、撤回栈、关卡生成。
 * 不依赖 wx / canvas，可在 Node 下独立做单元测试。
 *
 * 数据结构：
 * - bottles: Array<Array<colorId>>，每个瓶子是一个颜色栈，index 0 为底层
 * - completed: 已上架的成品饮料颜色列表
 * - undoStack: 每次倒水的完整快照，支持无限步撤回
 */
export default class GameLogic {
  constructor() {
    this.capacity = CAPACITY;
    this.colorCount = 0;
    this.bottles = [];
    this.completed = [];
    this.undoStack = [];
    this.moveCount = 0;
  }

  /** 载入关卡（同 seed 局面完全一致，可复现） */
  loadLevel({ colors, empties, seed }) {
    this.colorCount = colors;
    this.bottles = this._generate(colors, empties, seed);
    this.completed = [];
    this.undoStack = [];
    this.moveCount = 0;
  }

  // ---------- 关卡生成：随机分层发牌 + 求解器验证，保证必有解 ----------

  _generate(colors, empties, seed) {
    let last = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const bottles = this._randomDeal(colors, empties, seed + attempt * 997);
      last = bottles;
      // 开局不允许直接存在已完成的满瓶纯色
      if (bottles.some((b) => this._isFullMono(b))) continue;
      // 内置求解器验证局面必有解
      if (this._solvable(bottles)) return bottles;
    }
    return last; // 兜底：60 次全部无解的概率极低
  }

  /**
   * 随机分层发牌：把 colors 色 × capacity 层随机洗混后依次装满前 colors 个瓶，
   * 再附加 empties 个空瓶。
   */
  _randomDeal(colors, empties, seed) {
    const rng = new Rng(seed);
    const layers = [];
    for (let c = 0; c < colors; c++) {
      for (let i = 0; i < this.capacity; i++) layers.push(c);
    }
    // Fisher-Yates 洗牌
    for (let i = layers.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [layers[i], layers[j]] = [layers[j], layers[i]];
    }
    const bottles = [];
    for (let i = 0; i < layers.length; i += this.capacity) {
      bottles.push(layers.slice(i, i + this.capacity));
    }
    for (let e = 0; e < empties; e++) bottles.push([]);
    return bottles;
  }

  /**
   * 可解性验证：DFS 搜索（与游戏规则完全一致的模拟，含完成清空）。
   * 启发式：优先尝试倒向同色非空目标，空瓶目标靠后（空瓶是最稀缺的中转资源）。
   */
  _solvable(bottles, nodeLimit = 60000) {
    const cap = this.capacity;
    const bs = bottles.map((b) => b.slice());
    const n = bs.length;
    const visited = new Set();
    let nodes = 0;

    const amountOf = (f, t) => {
      if (!f.length || t.length >= cap) return 0;
      if (t.length && t[t.length - 1] !== f[f.length - 1]) return 0;
      let run = 1;
      for (let i = f.length - 2; i >= 0 && f[i] === f[f.length - 1]; i--) run++;
      return Math.min(run, cap - t.length);
    };

    const dfs = () => {
      // 完成即清空 → 所有瓶为空 = 通关
      if (bs.every((b) => b.length === 0)) return true;
      if (nodes++ > nodeLimit) return false;
      const key = bs.map((b) => b.join(',')).join('|');
      if (visited.has(key)) return false;
      visited.add(key);

      const moves = [];
      for (let from = 0; from < n; from++) {
        for (let to = 0; to < n; to++) {
          if (from === to) continue;
          const amount = amountOf(bs[from], bs[to]);
          if (!amount) continue;
          const t = bs[to];
          let score = 0;
          if (t.length) {
            let tr = 1;
            for (let i = t.length - 2; i >= 0 && t[i] === t[t.length - 1]; i--) tr++;
            score = 100 + tr; // 同色目标优先，越"接近满"越优先
          }
          moves.push({ from, to, amount, score });
        }
      }
      moves.sort((a, b) => b.score - a.score);

      for (const m of moves) {
        const snap = bs.map((b) => b.slice());
        const f = bs[m.from];
        const t = bs[m.to];
        for (let i = 0; i < m.amount; i++) t.push(f.pop());
        if (t.length === cap && t.every((c) => c === t[0])) t.length = 0; // 完成清空
        if (dfs()) return true;
        for (let i = 0; i < n; i++) bs[i] = snap[i];
      }
      return false;
    };

    return dfs();
  }

  // ---------- 倒液规则（方案 2.2） ----------

  /** 瓶子顶层同色连续段长度 */
  _topRunOf(b) {
    if (!b.length) return 0;
    let n = 1;
    for (let i = b.length - 2; i >= 0 && b[i] === b[b.length - 1]; i--) n++;
    return n;
  }

  /**
   * 计算合法倒水量：
   * 1. 目标瓶为空 → 可倒；
   * 2. 目标瓶顶层色与源瓶顶层色相同 → 可倒；
   * 倒量 = 源瓶顶层同色连续段长度，且不超过目标瓶剩余空间
   */
  _amountOf(f, t) {
    if (!f.length || t.length >= this.capacity) return 0;
    if (t.length && t[t.length - 1] !== f[f.length - 1]) return 0;
    return Math.min(this._topRunOf(f), this.capacity - t.length);
  }

  canPour(from, to) {
    if (from === to) return 0;
    return this._amountOf(this.bottles[from], this.bottles[to]);
  }

  /**
   * 执行倒水：把源瓶顶层同色连续段整体倒入目标瓶。
   * 目标瓶凑满纯色 → 判定完成：颜色记入货架，瓶子清空（腾出空瓶资源，方案 2.4）。
   * @returns {null | {amount, color, completedColor}} completedColor >= 0 表示本次完成一瓶
   */
  pour(from, to) {
    const amount = this.canPour(from, to);
    if (!amount) return null;

    const f = this.bottles[from];
    const t = this.bottles[to];
    const record = {
      from,
      to,
      fromContent: f.slice(),
      toContent: t.slice(),
      completedBefore: this.completed.slice(),
    };
    const color = f[f.length - 1];
    for (let i = 0; i < amount; i++) t.push(f.pop());

    let completedColor = -1;
    if (this._isFullMono(t)) {
      completedColor = color;
      this.completed.push(color);
      t.length = 0; // 完成即上架，玻璃瓶留在原地腾空
    }
    this.undoStack.push(record);
    this.moveCount++;
    return { amount, color, completedColor };
  }

  /** 撤回上一步（含完成效果的撤销），恢复到该步之前的状态 */
  undo() {
    const r = this.undoStack.pop();
    if (!r) return false;
    this.bottles[r.from] = r.fromContent;
    this.bottles[r.to] = r.toContent;
    this.completed = r.completedBefore;
    if (this.moveCount > 0) this.moveCount--;
    return true;
  }

  // ---------- 判定 ----------

  _isFullMono(b) {
    return b.length === this.capacity && b.every((c) => c === b[0]);
  }

  /** 通关：所有颜色的液体都已完成分装（方案 2.3） */
  isWin() {
    return this.completed.length >= this.colorCount;
  }

  /** 死局检测：场上不存在任何合法倒法 */
  hasAnyMove() {
    for (let from = 0; from < this.bottles.length; from++) {
      for (let to = 0; to < this.bottles.length; to++) {
        if (from !== to && this.canPour(from, to) > 0) return true;
      }
    }
    return false;
  }
}
