import Rng from './rng.js';
import { CAPACITY } from './levels.js';

/**
 * 纯逻辑层：瓶子数据结构、倒液规则、满瓶判定、撤回栈、关卡生成。
 * 不依赖 wx / canvas，可在 Node 下独立做单元测试。
 *
 * 数据结构：
 * - bottles: Array<Array<colorId>>，每个瓶子是一个颜色栈，index 0 为底层
 * - completed: 已上架的成品饮料颜色列表
 * - removed: 已收走的瓶子下标集合（完成即连瓶收走，不再参与倒水/点击/重排）
 * - undoStack: 每次倒水的完整快照，支持无限步撤回
 */
export default class GameLogic {
  constructor() {
    this.capacity = CAPACITY;
    this.colorCount = 0;
    this.bottles = [];
    this.completed = [];
    this.removed = new Set();
    this.undoStack = [];
    this.moveCount = 0;
  }

  /** 载入关卡（同 seed 局面完全一致，可复现） */
  loadLevel({ colors, empties, seed, hiddenCount = 0 }) {
    this.colorCount = colors;
    this.bottles = this._generate(colors, empties, seed);
    if (hiddenCount > 0) this._markHidden(hiddenCount, seed * 31 + 7);
    this._revealTops();
    this.completed = [];
    this.removed = new Set();
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
  _solvable(bottles, nodeLimit = 60000, removedSet = null) {
    const cap = this.capacity;
    const bs = bottles.map((b) => b.slice());
    const n = bs.length;
    const done = new Set(removedSet || []); // 已收走的瓶（含搜索中新完成的），不参与倒水
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
        if (done.has(from)) continue;
        for (let to = 0; to < n; to++) {
          if (from === to || done.has(to)) continue;
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
        if (t.length === cap && t.every((c) => c === t[0])) {
          t.length = 0; // 完成清空 + 收走，不再参与后续搜索
          done.add(m.to);
        }
        if (dfs()) return true;
        for (let i = 0; i < n; i++) bs[i] = snap[i];
        done.delete(m.to);
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
    if (this.removed.has(from) || this.removed.has(to)) return 0; // 已收走的瓶不参与
    return this._amountOf(this.bottles[from], this.bottles[to]);
  }

  /**
   * 执行倒水：把源瓶顶层同色连续段整体倒入目标瓶。
   * 目标瓶凑满纯色 → 判定完成：颜色记入货架，瓶子一并收走（不留空瓶，方案 2.4 调整版）。
   * 源瓶露出隐藏层 → 立即揭示真实颜色（方案 3「?」层机制）。
   * @returns {null | {amount, color, completedColor}} completedColor >= 0 表示本次完成一瓶
   */
  pour(from, to) {
    const amount = this.canPour(from, to);
    if (!amount) return null;

    const f = this.bottles[from];
    const t = this.bottles[to];
    const record = {
      type: 'pour',
      from,
      to,
      fromContent: f.slice(),
      toContent: t.slice(),
      completedBefore: this.completed.slice(),
      removedBefore: this.removed.has(to),
    };
    const color = f[f.length - 1];
    for (let i = 0; i < amount; i++) t.push(f.pop());
    this._revealTop(f); // 倒出后源瓶若露出「?」层则揭示

    let completedColor = -1;
    if (this._isFullMono(t)) {
      completedColor = color;
      this.completed.push(color);
      t.length = 0;
      this.removed.add(to); // 完成即连瓶收走上架
    }
    this.undoStack.push(record);
    this.moveCount++;
    return { amount, color, completedColor };
  }

  /** 撤回上一步（倒水 / 打乱 / 加瓶，按栈序恢复到该步之前的状态） */
  undo() {
    const r = this.undoStack.pop();
    if (!r) return false;
    if (r.type === 'shuffle') {
      this.bottles = r.bottles;
      this.completed = r.completed;
    } else if (r.type === 'shuffleOne') {
      this.bottles[r.idx] = r.content;
    } else if (r.type === 'addBottle') {
      // LIFO 保证此时新增瓶必为空（其后所有倒水已先被撤销）
      this.bottles.splice(r.idx, 1);
      this.removed.delete(r.idx);
    } else {
      this.bottles[r.from] = r.fromContent;
      this.bottles[r.to] = r.toContent;
      this.completed = r.completedBefore;
      if (r.removedBefore) this.removed.add(r.to);
      else this.removed.delete(r.to);
      if (this.moveCount > 0) this.moveCount--;
    }
    return true;
  }

  // ---------- 道具（方案 4） ----------

  /**
   * 道具·打乱：收拢场上全部液体重新随机分装（隐藏层全部揭示），保证有解。
   * 重排后液体装满前 total/capacity 个瓶，其余为空瓶（空瓶只增不减，救死局用）。
   * @returns {boolean} 是否成功（无可行重排时失败）
   */
  shuffle() {
    const layers = [];
    for (const b of this.bottles) {
      for (const c of b) layers.push(c >= 0 ? c : -c - 1); // 隐藏层揭示
    }
    const total = layers.length;
    if (total === 0 || total % this.capacity !== 0) return false;
    const fullBottles = total / this.capacity;
    // 已收走的完成瓶不参与重排，保持空置
    let activeCount = 0;
    for (let i = 0; i < this.bottles.length; i++) {
      if (!this.removed.has(i)) activeCount++;
    }
    if (fullBottles > activeCount) return false;

    const snapshot = {
      type: 'shuffle',
      bottles: this.bottles.map((b) => b.slice()),
      completed: this.completed.slice(),
    };

    for (let attempt = 0; attempt < 60; attempt++) {
      for (let i = layers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [layers[i], layers[j]] = [layers[j], layers[i]];
      }
      const bottles = [];
      let k = 0; // 已消耗的满瓶计数（跳过收走的瓶）
      for (let i = 0; i < this.bottles.length; i++) {
        if (this.removed.has(i)) {
          bottles.push([]);
          continue;
        }
        bottles.push(k < fullBottles ? layers.slice(k * this.capacity, (k + 1) * this.capacity) : []);
        k++;
      }
      if (bottles.some((b) => this._isFullMono(b))) continue;
      if (!this._solvable(bottles, 60000, this.removed)) continue;
      this.bottles = bottles;
      this.undoStack.push(snapshot);
      return true;
    }
    return false;
  }

  /**
   * 道具·打乱（选瓶模式）：只打乱指定瓶内的层序（隐藏层全部揭示）。
   * 与全场打乱不同，不校验全局可解性（玩家可用撤回兜底）。
   * @returns {boolean} 是否成功（空瓶 / 纯色瓶 / 已收走的瓶无法打乱）
   */
  shuffleOne(idx) {
    const b = this.bottles[idx];
    if (!b || !b.length || this.removed.has(idx)) return false;
    const revealed = b.map((c) => (c >= 0 ? c : -c - 1)); // 隐藏层揭示
    if (revealed.every((c) => c === revealed[0])) return false; // 纯色瓶无需打乱
    const before = b.slice();
    for (let attempt = 0; attempt < 24; attempt++) {
      for (let i = revealed.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [revealed[i], revealed[j]] = [revealed[j], revealed[i]];
      }
      if (revealed.some((c, i) => c !== before[i])) break; // 保证与原排列不同
    }
    this.bottles[idx] = revealed;
    this.undoStack.push({ type: 'shuffleOne', idx, content: before });
    return true;
  }

  /**
   * 道具·加瓶子：临时增加一个空瓶中转位（卡关救星）
   * @returns {boolean} 是否成功（达到布局上限则失败）
   */
  addBottle() {
    if (this.bottles.length >= 12) return false;
    this.bottles.push([]);
    this.undoStack.push({ type: 'addBottle', idx: this.bottles.length - 1 });
    return true;
  }

  // ---------- 问号隐藏层（方案 3） ----------

  /**
   * 随机把 count 个非顶层液体层标记为隐藏（层值取负，真实色 = -(值+1)）。
   * 隐藏层仅在成为顶层时揭示，倒水规则无需特判。
   */
  _markHidden(count, seed) {
    const rng = new Rng(seed);
    const candidates = [];
    for (let bi = 0; bi < this.bottles.length; bi++) {
      for (let li = 0; li < this.bottles[bi].length - 1; li++) {
        candidates.push([bi, li]);
      }
    }
    for (let i = 0; i < count && i < candidates.length; i++) {
      const j = i + rng.int(candidates.length - i);
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      const [bi, li] = candidates[i];
      this.bottles[bi][li] = -(this.bottles[bi][li] + 1);
    }
  }

  /** 揭示瓶顶的隐藏层（可能连续多层）。写法 -x-1 避免 -0 */
  _revealTop(b) {
    while (b.length && b[b.length - 1] < 0) {
      b[b.length - 1] = -b[b.length - 1] - 1;
    }
  }

  _revealTops() {
    for (const b of this.bottles) this._revealTop(b);
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
