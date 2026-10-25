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
    // 锁瓶元数据（与 bottles 平行，不污染层内容编码）
    this.locks = []; // [{bottle, type:'cond', need} | {bottle, type:'key', keyBottle, keyDepth}]
    this.unlocked = []; // 与 locks 平行的解锁状态
    this.noEmptyStart = false; // 无空瓶开局标记（scattered 发牌）
    this.lastGenSolvable = true; // 最近一次生成是否通过求解器验证（测试断言用）
    this.special = null; // 特殊关类型（v1 仅 'bigBottle'，普通关为 null）
    this.bigIndex = -1; // 大瓶在 bottles 中的下标（特殊关固定末位，普通关 -1）
    this.bigCapacity = 0; // 大瓶容量（层数，特殊关 = 目标色每色总量）
    this.bigColor = -1; // 大瓶限定收集色（瓶口颜色限制：只收该颜色，普通关 -1）
  }

  /** 载入关卡（同 seed 局面完全一致，可复现）。新参数全部可选，缺省保持旧行为 */
  loadLevel({
    colors,
    empties,
    seed,
    hiddenCount = 0,
    capacity = CAPACITY,
    condLockCount = 0,
    condLockNeed = 2,
    keyLockCount = 0,
    noEmptyStart = false,
    special = null,
    bigCapacity = 0,
  }) {
    this.capacity = capacity;
    this.colorCount = colors;
    this.noEmptyStart = noEmptyStart;
    this.special = special === 'bigBottle' ? 'bigBottle' : null;
    this.bigCapacity = this.special ? bigCapacity : 0;
    let gen;
    if (this.special) {
      // 特殊关（大瓶收集，R1/R2）：大瓶专用发牌分支，大瓶固定排在 bottles 末位
      gen = this._generateBigBottle(colors, noEmptyStart ? 0 : empties, seed, {
        bigCapacity: this.bigCapacity,
      });
      this.bigIndex = gen.bottles.length - 1;
      this.bigColor = gen.bigColor; // 限定收集色（瓶口颜色限制）
    } else {
      this.bigIndex = -1;
      this.bigColor = -1;
      gen = this._generate(colors, noEmptyStart ? 0 : empties, seed, {
        noEmptyStart,
        condLockCount,
        condLockNeed,
        keyLockCount,
      });
    }
    this.bottles = gen.bottles;
    this.locks = gen.locks;
    this.unlocked = gen.locks.map(() => false);
    if (hiddenCount > 0) this._markHidden(hiddenCount, seed * 31 + 7, gen.keyLayer);
    this._revealTops();
    this.completed = [];
    this.removed = new Set();
    this.undoStack = [];
    this.moveCount = 0;
  }

  // ---------- 关卡生成：随机分层发牌 + 布锁 + 求解器验证，保证必有解 ----------

  /**
   * 生成含锁关卡：
   * 发牌 → 随机布置条件锁（含内容瓶）/ 钥匙锁（锁既有内容瓶 + 钥匙层）→ 带锁求解验证。
   * 重试以总耗时预算（5s）为上限兜底（Q8=B）：1 空瓶大关随机发牌可解率低（~3%），
   * 单次验证极快（<1ms），固定 60 次重试不足，按预算可跑数千次直至命中可解局面。
   */
  _generate(colors, empties, seed, opts = {}) {
    const { noEmptyStart = false, condLockCount = 0, condLockNeed = 2, keyLockCount = 0 } = opts;
    const nodeLimit = this.capacity >= 5 ? 200000 : 60000; // nodeLimit 随容量配置化（Q8=B）
    const deadline = Date.now() + 5000; // 单关生成总耗时预算
    const MAX_ATTEMPTS = 20000; // 防御性硬上限（正常预算内远达不到）
    let last = { bottles: [], locks: [] };
    this.lastGenSolvable = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0 && Date.now() > deadline) break;
      const dealSeed = seed + attempt * 997;
      const bottles = noEmptyStart
        ? this._randomDealScattered(colors, dealSeed)
        : this._randomDeal(colors, empties, dealSeed);
      // 开局不允许直接存在已完成的满瓶纯色
      if (bottles.some((b) => this._isFullMono(b))) {
        last = { bottles, locks: [] };
        continue;
      }
      // 布锁（与发牌同 seed 派生，同 seed 可复现；重试随 attempt 变化锁位）
      const rng = new Rng(dealSeed + 7919);
      const locks = [];
      let keyLayer = null;
      const condCands = bottles.map((b, i) => (b.length > 0 ? i : -1)).filter((i) => i >= 0);
      for (let i = 0; i < condLockCount && condCands.length > 0; i++) {
        // 条件锁瓶（方案 B）：含内容的真约束瓶
        locks.push({ bottle: condCands.splice(rng.int(condCands.length), 1)[0], type: 'cond', need: condLockNeed });
      }
      for (let i = 0; i < keyLockCount; i++) {
        // 钥匙锁瓶（方案 B，2026-10-25 调整）：锁在既有内容瓶上（真约束，不追加空瓶）；
        // 不与任何锁瓶（含本钥匙锁瓶）重叠
        const lockCands = bottles
          .map((b, bi) => (b.length > 0 && !locks.some((l) => l.bottle === bi) ? bi : -1))
          .filter((bi) => bi >= 0);
        if (lockCands.length === 0) continue; // 极端无候选（几乎不可能），跳过该锁
        const lockIdx = lockCands[rng.int(lockCands.length)];
        const keyCands = bottles
          .map((b, bi) => (b.length >= 2 && bi !== lockIdx && !locks.some((l) => l.bottle === bi) ? bi : -1))
          .filter((bi) => bi >= 0);
        if (keyCands.length === 0) continue;
        const kb = keyCands[rng.int(keyCands.length)];
        const kd = rng.int(bottles[kb].length - 1); // 从底数第 0~len-2 层（非顶层）
        locks.push({ bottle: lockIdx, type: 'key', keyBottle: kb, keyDepth: kd });
        keyLayer = { bottle: kb, depth: kd }; // v1 仅 1 个钥匙，供 _markHidden 排除
      }
      const lockInfo = {
        condLocks: locks.filter((l) => l.type === 'cond'),
        keyLocks: locks.filter((l) => l.type === 'key'), // 求解器精确模拟钥匙倒出
      };
      last = { bottles, locks };
      // 带锁求解器验证局面必有解
      if (this._solvable(bottles, nodeLimit, null, lockInfo)) {
        this.lastGenSolvable = true;
        return { bottles, locks, keyLayer };
      }
    }
    // 兜底：全部尝试失败的概率极低；返回最后一次（keyLayer 置空避免隐藏误标）
    return { bottles: last.bottles, locks: last.locks, keyLayer: null };
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
   * 无空瓶开局发牌（R3 scattered，Q2=A）：colors 色 × capacity 层随机分布到
   * colors + 1 个瓶，每瓶层数 ∈ [2, capacity]（允许满混合瓶，禁止满纯色由外层校验），
   * 总层数 < (colors+1)×capacity 天然保证至少 1 瓶非满，开局必有合法步。
   */
  _randomDealScattered(colors, seed) {
    const rng = new Rng(seed);
    const layers = [];
    for (let c = 0; c < colors; c++) {
      for (let i = 0; i < this.capacity; i++) layers.push(c);
    }
    for (let i = layers.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [layers[i], layers[j]] = [layers[j], layers[i]];
    }
    // 每瓶层数配额：初始均为 base，随机加到 [base, capacity]，总和恰为 colors×capacity
    const n = colors + 1;
    const total = colors * this.capacity;
    const base = total >= 2 * n ? 2 : 1; // 常规配置下恒为 2（防御极端 colors/capacity）
    const quota = new Array(n).fill(base);
    let rest = total - base * n;
    while (rest > 0) {
      const i = rng.int(n);
      if (quota[i] < this.capacity) {
        quota[i]++;
        rest--;
      }
    }
    const bottles = [];
    let k = 0;
    for (let i = 0; i < n; i++) {
      bottles.push(layers.slice(k, k + quota[i]));
      k += quota[i];
    }
    return bottles;
  }

  /**
   * 特殊关（大瓶收集）生成（R1，S-02）：
   * 目标色（rng 随机指定，同 seed 可复现）每色 bigCapacity 层 + 其余 (colors-1) 种
   * 干扰色每色 capacity 层，随机分层装入普通瓶 + empties 个空瓶，末位追加空大瓶。
   * attempt 框架与 _generate 一致（deadline 5s / dealSeed = seed + attempt*997），
   * 求解验证走 bigInfo 适配版（大瓶满纯色 = 通关，R4）。
   */
  _generateBigBottle(colors, empties, seed, opts = {}) {
    const { bigCapacity } = opts;
    const nodeLimit = 200000; // 无「完成清空」收缩，状态空间略大，统一 20w
    const deadline = Date.now() + 5000;
    const MAX_ATTEMPTS = 20000;
    let last = { bottles: [], target: 0 };
    this.lastGenSolvable = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0 && Date.now() > deadline) break;
      const dealSeed = seed + attempt * 997;
      const { bottles, target } = this._randomDealBig(colors, empties, dealSeed, bigCapacity);
      bottles[bottles.length - 1].push(target); // 大瓶预置 1 层限定色（R2 调整：颜色可视化）
      last = { bottles, target };
      // 开局不允许普通瓶直接满纯色（与普通关口径一致；大瓶开局仅含 1 层限定色）
      if (bottles.some((b, i) => i < bottles.length - 1 && this._isFullMono(b))) continue;
      const bigInfo = { idx: bottles.length - 1, capacity: bigCapacity, color: target };
      const lockInfo = { condLocks: [], keyLocks: [] }; // 特殊关锁数恒 0（v1 不叠加）
      if (this._solvable(bottles, nodeLimit, null, lockInfo, bigInfo)) {
        this.lastGenSolvable = true;
        return { bottles, locks: [], keyLayer: null, bigColor: target };
      }
    }
    return { bottles: last.bottles, locks: [], keyLayer: null, bigColor: last.target };
  }

  /**
   * 大瓶关随机分层发牌：目标色 bigCapacity 层 + 干扰色 (colors-1)×capacity 层洗混后
   * 按 capacity 依次装满普通瓶，追加 empties 个空瓶，末位追加空大瓶（由调用方预置 1 层限定色）。
   */
  _randomDealBig(colors, empties, seed, bigCapacity) {
    const rng = new Rng(seed);
    const target = rng.int(colors); // 目标色（每色总量 = bigCapacity 的那种颜色，即大瓶限定色）
    const layers = [];
    for (let c = 0; c < colors; c++) {
      // 目标色 bigCapacity-1 层入池洗混（另 1 层由调用方预置进大瓶，总量恒为 bigCapacity）
      const n = c === target ? bigCapacity - 1 : this.capacity;
      for (let i = 0; i < n; i++) layers.push(c);
    }
    for (let i = layers.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [layers[i], layers[j]] = [layers[j], layers[i]];
    }
    const bottles = [];
    for (let i = 0; i < layers.length; i += this.capacity) {
      bottles.push(layers.slice(i, i + this.capacity));
    }
    for (let e = 0; e < empties; e++) bottles.push([]);
    bottles.push([]); // 大瓶（开局为空，容量 bigCapacity）
    return { bottles, target };
  }

  /**
   * 可解性验证：DFS 搜索（与游戏规则完全一致的模拟，含完成清空与锁瓶过滤）。
   * 启发式：完成腾瓶 > 腾空源瓶 > 同色目标（越接近满越优）> 空瓶目标；
   * 状态 key 规范化（自由瓶内容排序）合并排列等价状态，大幅剪枝。
   * lockInfo（可选）：
   * - condLocks：条件锁瓶（done.size < need 时冻结；锁状态由完成数推导，Q3=B）；
   * - keyLocks：钥匙锁瓶（精确模拟钥匙层倒出：keyOut 布尔并入状态 key——
   *   剔除模型的简化在 L30 三机制叠加时过保守（可解率≈0），改为与游戏规则一致的模拟）。
   */
  _solvable(bottles, nodeLimit = 60000, removedSet = null, lockInfo = null, bigInfo = null) {
    const cap = this.capacity;
    const bigIdx = bigInfo ? bigInfo.idx : -1; // 特殊关：大瓶下标（普通关 -1）
    const bigCap = bigInfo ? bigInfo.capacity : cap; // 大瓶容量（R4/S-05）
    const bigColor = bigInfo && bigInfo.color >= 0 ? bigInfo.color : -1; // 大瓶限定色（-1 = 不限制）
    const condLocks = (lockInfo && lockInfo.condLocks) || [];
    const keyLocks = (lockInfo && lockInfo.keyLocks) || [];
    const bs = bottles.map((b) => b.slice());
    const n = bs.length;
    const done = new Set(removedSet || []); // 已收走的瓶（含搜索中新完成的），不参与倒水
    const visited = new Set();
    let nodes = 0;
    let keyOut = false; // 钥匙层是否已倒出（v1 每关至多 1 个钥匙锁）

    /** 瓶 i 当前是否不可用（钥匙未倒出时的钥匙锁瓶；完成数不足时的条件锁瓶） */
    const locked = (i) => {
      if (!keyOut) {
        for (const kl of keyLocks) {
          if (kl.bottle === i) return true;
        }
      }
      for (const cl of condLocks) {
        if (cl.bottle === i && done.size < cl.need) return true;
      }
      return false;
    };

    const amountOf = (f, t, ti) => {
      const tcap = ti === bigIdx ? bigCap : cap; // 目标瓶容量按瓶取（大瓶 bigCap，零规则豁免）
      if (!f.length || t.length >= tcap) return 0;
      if (ti === bigIdx && f[f.length - 1] !== bigColor) return 0; // 瓶口颜色限制（与 canPour 一致）
      if (t.length && t[t.length - 1] !== f[f.length - 1]) return 0;
      let run = 1;
      for (let i = f.length - 2; i >= 0 && f[i] === f[f.length - 1]; i--) run++;
      return Math.min(run, tcap - t.length);
    };

    const dfs = () => {
      if (bigIdx >= 0) {
        // 特殊关胜利条件（R4）：大瓶满且纯色 = 通关（替代「全部完成清空」）
        const big = bs[bigIdx];
        if (big.length === bigCap && big.every((c) => c === big[0])) return true;
      } else if (bs.every((b) => b.length === 0)) {
        // 完成即清空 → 所有瓶为空 = 通关
        return true;
      }
      if (nodes++ > nodeLimit) return false;
      // 规范化状态 key：自由瓶（可用源/目标）内容排序 —— 瓶序不影响后续可解性，
      // 排列等价状态合并去重，搜索空间按瓶排列数大幅剪枝（8 色大关必需）。
      // 收走瓶（恒空）与锁瓶（身份固定）按原位参与，保证锁语义区分。
      const freeKeys = [];
      const fixedKeys = [];
      for (let i = 0; i < n; i++) {
        const s = bs[i].join(',');
        if (i === bigIdx) fixedKeys.push('B' + s); // 大瓶容量独特，按固定身份参与（R4）
        else if (done.has(i)) fixedKeys.push('D');
        else if (locked(i)) fixedKeys.push('L' + s);
        else freeKeys.push(s);
      }
      const key = freeKeys.sort().join('|') + '#' + fixedKeys.join('|') + (keyLocks.length ? (keyOut ? '#K1' : '#K0') : '');
      if (visited.has(key)) return false;
      visited.add(key);

      const moves = [];
      for (let from = 0; from < n; from++) {
        if (done.has(from) || locked(from)) continue;
        for (let to = 0; to < n; to++) {
          if (from === to || done.has(to) || locked(to)) continue;
          const amount = amountOf(bs[from], bs[to], to);
          if (!amount) continue;
          const t = bs[to];
          const f = bs[from];
          let score;
          if (to === bigIdx) {
            // 特殊关：倒入大瓶 = 推进收集，最高优先（已开启收集的同色续倒 > 开启新收集）
            score = t.length ? 500 + t.length : 300;
          } else if (t.length) {
            let tr = 1;
            for (let i = t.length - 2; i >= 0 && t[i] === t[t.length - 1]; i--) tr++;
            // 倒满即完成（目标整瓶同色）→ 腾出空瓶，最高优先
            score = tr === t.length && t.length + amount === cap ? 600 : 100 + tr;
          } else {
            score = 10; // 空瓶目标靠后（空瓶是最稀缺的中转资源）
          }
          if (amount === f.length) score += 200; // 源瓶整段倒空 → 腾出空瓶
          moves.push({ from, to, amount, score });
        }
      }
      moves.sort((a, b) => b.score - a.score);

      for (const m of moves) {
        const snap = bs.map((b) => b.slice());
        const f = bs[m.from];
        const t = bs[m.to];
        const fromLenBefore = f.length;
        for (let i = 0; i < m.amount; i++) t.push(f.pop());
        // 钥匙层倒出判定（与游戏 pour 逻辑一致：倒出层覆盖钥匙深度位置）
        const keyWasOut = keyOut;
        if (!keyOut) {
          for (const kl of keyLocks) {
            if (kl.keyBottle === m.from && kl.keyDepth >= fromLenBefore - m.amount) {
              keyOut = true;
              break;
            }
          }
        }
        if (bigIdx < 0 && t.length === cap) {
          // 完成判定按真实色（与游戏 _isFullMono 一致；shuffle 验证时冻结瓶可能含隐藏层）。
          // 特殊关无「完成清空」语义（R4：普通瓶满纯色不收走），整体跳过。
          const c0 = t[0] >= 0 ? t[0] : -t[0] - 1;
          if (t.every((c) => (c >= 0 ? c : -c - 1) === c0)) {
            t.length = 0; // 完成清空 + 收走，不再参与后续搜索
            done.add(m.to);
          }
        }
        if (dfs()) return true;
        for (let i = 0; i < n; i++) bs[i] = snap[i];
        done.delete(m.to);
        keyOut = keyWasOut;
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
   * capTo（可选）：目标瓶容量（大瓶 = bigCapacity，其余默认 this.capacity；R2 零规则豁免）
   */
  _amountOf(f, t, capTo = this.capacity) {
    if (!f.length || t.length >= capTo) return 0;
    if (t.length && t[t.length - 1] !== f[f.length - 1]) return 0;
    return Math.min(this._topRunOf(f), capTo - t.length);
  }

  /** 瓶 idx 的容量（特殊关大瓶 = bigCapacity，其余 = this.capacity） */
  capOf(idx) {
    return this.special === 'bigBottle' && idx === this.bigIndex ? this.bigCapacity : this.capacity;
  }

  /** 瓶子是否处于锁定状态（未解锁的锁瓶，不可作为倒水源/目标）。供胶水层/表现层查询 */
  isLocked(idx) {
    for (let k = 0; k < this.locks.length; k++) {
      if (this.locks[k].bottle === idx && !this.unlocked[k]) return true;
    }
    return false;
  }

  canPour(from, to) {
    if (from === to) return 0;
    if (this.removed.has(from) || this.removed.has(to)) return 0; // 已收走的瓶不参与
    if (this.isLocked(from) || this.isLocked(to)) return 0; // 未解锁锁瓶不可作源/目标
    if (this.special === 'bigBottle' && to === this.bigIndex) {
      // 瓶口颜色限制：大瓶只收限定色（R2 调整，与瓶口色环标识一致）
      const f = this.bottles[from];
      if (!f.length || f[f.length - 1] !== this.bigColor) return 0;
    }
    return this._amountOf(this.bottles[from], this.bottles[to], this.capOf(to));
  }

  /**
   * 执行倒水：把源瓶顶层同色连续段整体倒入目标瓶。
   * 目标瓶凑满纯色 → 判定完成：颜色记入货架，瓶子一并收走（不留空瓶，方案 2.4 调整版）。
   * 源瓶露出隐藏层 → 立即揭示真实颜色（方案 3「?」层机制）。
   * 钥匙层倒出（离开所在瓶）→ 解锁对应钥匙锁瓶（之后倒回不重新锁定，R5）。
   * 完成 N 个成品 → 解锁对应条件锁瓶（R4）。
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
      unlockedBefore: this.unlocked.slice(), // 锁状态快照（AC-06：undo 完整恢复）
    };
    const color = f[f.length - 1];
    // 钥匙层倒出判定：源瓶为钥匙所在瓶，且本次倒出的层覆盖钥匙深度位置（含同色段中段整体倒出）
    const pouredFromIdx = f.length - amount; // 本次被倒出的最底层下标
    for (let k = 0; k < this.locks.length; k++) {
      const lk = this.locks[k];
      if (
        lk.type === 'key' &&
        !this.unlocked[k] &&
        lk.keyBottle === from &&
        lk.keyDepth >= pouredFromIdx
      ) {
        this.unlocked[k] = true;
      }
    }
    for (let i = 0; i < amount; i++) t.push(f.pop());
    this._revealTop(f); // 倒出后源瓶若露出「?」层则揭示

    let completedColor = -1;
    if (this.special !== 'bigBottle' && this._isFullMono(t)) {
      completedColor = color;
      this.completed.push(color);
      t.length = 0;
      this.removed.add(to); // 完成即连瓶收走上架
      // 条件锁解锁检查：已完成成品数 ≥ need → 解锁
      for (let k = 0; k < this.locks.length; k++) {
        const lk = this.locks[k];
        if (lk.type === 'cond' && !this.unlocked[k] && this.completed.length >= lk.need) {
          this.unlocked[k] = true;
        }
      }
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
      if (r.unlockedBefore) this.unlocked = r.unlockedBefore.slice();
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
      if (r.unlockedBefore) this.unlocked = r.unlockedBefore.slice();
      if (r.removedBefore) this.removed.add(r.to);
      else this.removed.delete(r.to);
      if (this.moveCount > 0) this.moveCount--;
    }
    return true;
  }

  // ---------- 道具（方案 4） ----------

  /**
   * 道具·打乱：收拢场上全部液体重新随机分装（隐藏层全部揭示），保证有解。
   * 重排后液体依次装满前若干瓶，其余为空瓶（空瓶只增不减，救死局用）。
   * 锁瓶适配（R4/R5）：
   * - 未解锁的条件锁瓶整体冻结（内容不参与重排、位置原样保留，已解锁则正常参与）；
   * - 钥匙锁瓶直接全部解锁（Q7=A：脱困道具给正反馈，且免去重排后钥匙深度追踪），
   *   解锁后作为普通空瓶参与重排；
   * - 重排后仍带锁验证有解。
   * @returns {boolean} 是否成功（无可行重排时失败）
   */
  shuffle() {
    const frozen = new Set(); // 不参与重排的瓶（未解锁条件锁瓶整体保持原样）
    for (let k = 0; k < this.locks.length; k++) {
      if (this.locks[k].type === 'cond' && !this.unlocked[k]) frozen.add(this.locks[k].bottle);
    }
    if (this.special === 'bigBottle') frozen.add(this.bigIndex); // 大瓶内容冻结（Q6=A：不打乱大瓶）
    const layers = [];
    for (let i = 0; i < this.bottles.length; i++) {
      if (this.removed.has(i) || frozen.has(i)) continue;
      for (const c of this.bottles[i]) layers.push(c >= 0 ? c : -c - 1); // 隐藏层揭示
    }
    const total = layers.length;
    if (total === 0) return false;
    // 可用瓶须能容纳全部待重排液体（每瓶至多 capacity；冻结瓶层数使 total 可能非 capacity 整除）
    let activeCount = 0;
    for (let i = 0; i < this.bottles.length; i++) {
      if (!this.removed.has(i) && !frozen.has(i)) activeCount++;
    }
    if (Math.ceil(total / this.capacity) > activeCount) return false;

    const snapshot = {
      type: 'shuffle',
      bottles: this.bottles.map((b) => b.slice()),
      completed: this.completed.slice(),
      unlockedBefore: this.unlocked.slice(), // 锁状态快照（含 shuffle 解锁的钥匙锁）
    };
    // 带锁验证信息：条件锁按 need 模拟（done.size 起始 = completed 数，与实际解锁状态一致）；
    // 钥匙锁瓶即将被解锁，验证时视作普通空瓶（keyLocks 置空）
    const lockInfo = { condLocks: this.locks.filter((l) => l.type === 'cond'), keyLocks: [] };
    const nodeLimit = this.capacity >= 5 ? 200000 : 60000;

    for (let attempt = 0; attempt < 300; attempt++) {
      for (let i = layers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [layers[i], layers[j]] = [layers[j], layers[i]];
      }
      const bottles = [];
      let k = 0; // 已消耗层数
      for (let i = 0; i < this.bottles.length; i++) {
        if (this.removed.has(i)) {
          bottles.push([]); // 已收走的完成瓶保持空置
          continue;
        }
        if (frozen.has(i)) {
          // 锁瓶整体保持原样（层序不动）；隐藏层同步揭示——打乱道具语义即"隐藏层全部揭示"，
          // 且求解器对未揭示的负值层无法模拟其倒出（顶层匹配永不成立）
          bottles.push(this.bottles[i].map((c) => (c >= 0 ? c : -c - 1)));
          continue;
        }
        if (k < total) {
          const take = Math.min(this.capacity, total - k);
          bottles.push(layers.slice(k, k + take)); // 依次装满，最后一瓶装余量
          k += take;
        } else {
          bottles.push([]);
        }
      }
      if (bottles.some((b, i) => i !== this.bigIndex && this._isFullMono(b))) continue;
      const bigInfo =
        this.special === 'bigBottle'
          ? { idx: this.bigIndex, capacity: this.bigCapacity, color: this.bigColor }
          : null;
      if (!this._solvable(bottles, nodeLimit, this.removed, lockInfo, bigInfo)) continue;
      this.bottles = bottles;
      // 解锁全部钥匙锁瓶（Q7=A）
      for (let k2 = 0; k2 < this.locks.length; k2++) {
        if (this.locks[k2].type === 'key') this.unlocked[k2] = true;
      }
      this.undoStack.push(snapshot);
      return true;
    }
    return false;
  }

  /**
   * 道具·打乱（选瓶模式）：只打乱指定瓶内的层序（隐藏层全部揭示）。
   * 与全场打乱不同，不校验全局可解性（玩家可用撤回兜底）。
   * 锁瓶不可选中；钥匙所在瓶在钥匙未倒出前不可选中（钥匙层位置元数据会失效）。
   * @returns {boolean} 是否成功（空瓶 / 纯色瓶 / 已收走的瓶 / 锁瓶 / 钥匙所在瓶无法打乱）
   */
  shuffleOne(idx) {
    const b = this.bottles[idx];
    if (!b || !b.length || this.removed.has(idx)) return false;
    if (this.special === 'bigBottle' && idx === this.bigIndex) return false; // 大瓶不可打乱（Q6=A）
    if (this.isLocked(idx)) return false; // 锁定瓶不可打乱
    for (let k = 0; k < this.locks.length; k++) {
      const lk = this.locks[k];
      if (lk.type === 'key' && !this.unlocked[k] && lk.keyBottle === idx) return false; // 钥匙所在瓶
    }
    const revealed = b.map((c) => (c >= 0 ? c : -c - 1)); // 隐藏层揭示
    if (revealed.every((c) => c === revealed[0])) return false; // 纯色瓶无需打乱
    const before = b.slice();
    const original = revealed.slice(); // 揭示后的原排列（比较基准，含隐藏层时 before 不适用）
    for (let attempt = 0; attempt < 24; attempt++) {
      for (let i = revealed.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [revealed[i], revealed[j]] = [revealed[j], revealed[i]];
      }
      if (revealed.some((c, i) => c !== original[i])) break; // 保证与原排列不同
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
   * excludeKey（可选，Q5=A）：钥匙层位置 {bottle, depth}，不与隐藏层共存（保证钥匙可见）。
   */
  _markHidden(count, seed, excludeKey = null) {
    const rng = new Rng(seed);
    const candidates = [];
    for (let bi = 0; bi < this.bottles.length; bi++) {
      for (let li = 0; li < this.bottles[bi].length - 1; li++) {
        if (excludeKey && bi === excludeKey.bottle && li === excludeKey.depth) continue;
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

  /** 满瓶纯色判定：按真实色比较（隐藏层取负编码，真实色 = -(值+1)）。
   *  带隐藏层的满纯色瓶同样判定完成——与求解器（按真实色验证）语义对齐，
   *  否则隐藏层恰好同色时真实游戏永不完成、求解器却判定有解。 */
  _isFullMono(b) {
    if (b.length !== this.capacity) return false;
    const c0 = b[0] >= 0 ? b[0] : -b[0] - 1;
    return b.every((c) => (c >= 0 ? c : -c - 1) === c0);
  }

  /** 通关：普通关 = 所有颜色完成分装；特殊关 = 大瓶装满且纯色（R3，装满即集齐） */
  isWin() {
    if (this.special === 'bigBottle') {
      const big = this.bottles[this.bigIndex];
      return big.length === this.bigCapacity && big.every((c) => c === big[0]);
    }
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
