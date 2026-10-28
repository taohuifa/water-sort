import Rng from './rng.js';
import { CAPACITY } from './levels.js';

/** 续杯复活加成（PRD-限时与步数限制 §2 C）：时间 +60s / 步限上限 +10 / 炸弹引信 +10（封顶初值） */
export const TIME_REVIVE_BONUS = 60;
export const MOVE_REVIVE_BONUS = 10;
// 炸弹引信加成与 MOVE_REVIVE_BONUS 当前同值，独立导出便于分开调参
export const BOMB_REVIVE_BONUS = 10;

// 单关生成总耗时预算（PRD-关卡生成异步化 Q4：原 5s 收紧至 3s；2026-10-28 D 方案放宽至 9s——
// 慢引擎（devtools/真机）单 attempt ≈ Node ×10（~2ms），9s ≈ 慢引擎 4000+ attempts，
// 覆盖普查次坏关（38 关 >3000 中保留段最高 3740）；根治方案见 Backlog B-8 牌面预计算缓存）
const GEN_TOTAL_BUDGET_MS = 9000;

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
    this.mix = false; // 混合容量关标记（PRD-混合容量瓶）
    this.caps = []; // 与 bottles 平行的每瓶容量数组（仅混合关填充，其余关为空）
    this.bigColor = -1; // 大瓶限定收集色（瓶口颜色限制：只收该颜色，普通关 -1）
    this.maxBottles = 12; // 加瓶上限（配置可覆盖：levels.json defaults/levels[n].maxBottles）
    // 遮盖瓶（PRD-玩法扩展 §2 A）：coverBottles = 开局遮盖瓶下标（生成期恒定，不入快照）；
    // 剩余层数由已完成成品数派生（coverLeft = max(0, coverLayers - completed.length)），随局面可复算
    this.coverBottles = [];
    this.coverLayers = 0; // 每瓶遮盖层数（0 = 本关无遮盖）
    // 炸弹瓶（PRD-玩法扩展 §2 B）：bombTimers/bombDefused 为真实状态（受操作历史影响，不可派生），
    // 随 undoStack 记录（bombsBefore）回滚；失败态 failed 由倒计时实时派生（isFailed），无独立快照字段
    this.bombBottles = []; // 开局炸弹瓶下标（生成期恒定，不入快照）
    this.bombMoves = 0; // 倒计时初值（0 = 本关无炸弹）
    this.bombTimers = []; // 与 bombBottles 平行的剩余步数
    this.bombDefused = []; // 与 bombBottles 平行的拆除标记（倒空即永久拆除）
    // 限时 / 步数限制（PRD-限时与步数限制 §2）：均为本关配置级资源，
    // timeLeft 单向流动（不入 undoStack/快照，撤销不回退，PRD 拍板 5）；失败态/failReason 均为派生量
    this.timeLimit = 0; // 本关时限秒（0 = 不限）
    this.timeLeft = 0; // 剩余秒（浮点累计，tickTime(dt) 驱动；loadLevel 重置满值）
    this.moveLimit = 0; // 步数上限（0 = 无限；续杯 +10 为上限抬升）
    this.lastGenSolLen = -1; // 最近一次生成接受局面的启发式解长（解长约束断言/工具回填用）
    // 增量生成会话状态（PRD-关卡生成异步化 F-01：beginGenerate/stepGenerate 共享，见 beginGenerate）
    this._gen = null;
  }

  /** 载入关卡（同步一次性入口，外部行为不变；内部 = beginGenerate + stepGenerate(∞) 跑满，同 seed 局面完全一致可复现） */
  loadLevel(cfg) {
    this.beginGenerate(cfg);
    while (!this.stepGenerate(Infinity).done);
  }

  /** 是否有生成会话进行中（main 载入流程判断用） */
  isGenerating() {
    return !!this._gen && !this._gen.finalized;
  }

  /** 生成进度快照（加载界面/调试协议消费）：无会话返回 null；special/mix 会话 budgetMs 为 0（同步即完） */
  genProgress() {
    const g = this._gen;
    if (!g) return null;
    return {
      attempts: g.attempt,
      elapsedMs: Date.now() - g.beginTs,
      budgetMs: g.deadline ? GEN_TOTAL_BUDGET_MS : 0,
      pending: !g.finalized,
    };
  }

  /**
   * 增量生成 ① 会话初始化（PRD-关卡生成异步化 F-01）：参数解构 + 字段赋值（原 loadLevel 前半段迁移）。
   * 特殊关/混合关生成毫秒级 → begin 内同步出结果（异步流程对其单帧即过，行为不变）；
   * 普通关进入分帧 attempt 状态机：总预算 GEN_TOTAL_BUDGET_MS（D 方案后 9s，见常量处注释），
   * 预算内未验证出可解局面 → 兜底返回最后尝试（语义与旧实现完全一致）。
   */
  beginGenerate({
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
    mix = false,
    maxBottles = 12,
    coverCount = 0,
    coverLayers = 2,
    bombCount = 0,
    bombMoves = 0,
    timeLimit = 0, // 时限秒（0 = 不限，PRD-限时与步数限制 §2 A）
    moveLimit = 0, // 步数上限（0 = 无限，§2 B）
    level = 0, // 关卡号（仅生成告警定位用，不参与生成逻辑）
  }) {
    this.capacity = capacity;
    this.maxBottles = maxBottles;
    this.colorCount = colors;
    this.noEmptyStart = noEmptyStart;
    // 限时 / 步限（PRD-限时与步数限制）：随关卡载入重置（重开 = 满值重新起局）
    this.timeLimit = timeLimit;
    this.timeLeft = timeLimit;
    this.moveLimit = moveLimit;
    this.special = special === 'bigBottle' ? 'bigBottle' : null;
    this.bigCapacity = this.special ? bigCapacity : 0;
    // 混合容量瓶（PRD-混合容量瓶）：v1 不与大瓶叠加（配置层强制，双保险）
    this.mix = !!mix && !this.special;
    this.caps = []; // 与 bottles 平行的每瓶容量数组（仅混合关填充）
    const g = (this._gen = {
      done: false, // attempt 循环出口（命中可解 / 预算或硬上限耗尽）
      finalized: false, // 局面字段回填恰好一次
      result: null, // 命中可解局面时的生成结果（null = 未命中）
      attempt: 0, // 已执行 attempt 数（dealSeed = seed + (attempt-1)×997，序号与旧 for 循环一致）
      last: { bottles: [], locks: [], covers: [], bombs: [], bombMoves: 0 }, // 最后尝试局面（兜底用）
      beginTs: Date.now(), // 进度字段 elapsedMs 起点（加载界面/调试协议消费）
      coverLayers, // 收尾回填遮盖层数用（原 loadLevel 局部参数）
    });
    if (this.special) {
      // 特殊关（大瓶收集，R1/R2）：大瓶专用发牌分支，大瓶固定排在 bottles 末位
      const gen = this._generateBigBottle(colors, noEmptyStart ? 0 : empties, seed, {
        bigCapacity: this.bigCapacity,
      });
      this.bigIndex = gen.bottles.length - 1;
      this.bigColor = gen.bigColor; // 限定收集色（瓶口颜色限制）
      g.result = gen;
      g.done = true;
      g.attempt = 1;
    } else if (this.mix) {
      // 混合容量关：全瓶容量 3~5 随机（PRD-混合容量瓶 §2）
      this.bigIndex = -1;
      this.bigColor = -1;
      const gen = this._generateMixed(colors, noEmptyStart ? 0 : empties, seed);
      this.caps = gen.caps;
      g.result = gen;
      g.done = true;
      g.attempt = 1;
    } else {
      this.bigIndex = -1;
      this.bigColor = -1;
      // 普通关：attempt 状态机参数（原 _generate 头部迁入）
      g.opts = {
        colors,
        empties: noEmptyStart ? 0 : empties,
        seed,
        noEmptyStart,
        condLockCount,
        condLockNeed,
        keyLockCount,
        hiddenCount,
        coverCount,
        coverLayers,
        bombCount,
        bombMoves,
        timeLimit,
        moveLimit,
        level,
      };
      g.nodeLimit = this.capacity >= 5 ? 200000 : 60000; // nodeLimit 随容量配置化（Q8=B）
      g.deadline = Date.now() + GEN_TOTAL_BUDGET_MS; // 单关生成总耗时预算
      g.maxAttempts = 20000; // 防御性硬上限（正常预算内远达不到）
      this.lastGenSolvable = false;
      this.lastGenSolLen = -1;
    }
  }

  /**
   * 增量生成 ② 推进（F-01）：执行 attempt 循环至多 budgetMs 毫秒。
   * 单次 attempt（洗牌 + 一次求解器验证）原子执行不内部分割（最坏数百 ms，加载界面前提下属可接受抖动）；
   * budgetMs = Infinity 即同步跑满（loadLevel 用）。
   * 循环出口：命中可解局面 → done；总预算耗尽 / MAX_ATTEMPTS 用尽 → done + 兜底（_finalizeGenerate）；
   * 本帧预算片用完 → 未 done，下帧续跑（暂停/恢复语义）。
   * 返回 { done, attempts, elapsedMs } 供加载进度与调试协议消费。
   */
  stepGenerate(budgetMs = 6) {
    const g = this._gen;
    const t0 = Date.now();
    if (!g) return { done: true, attempts: 0, elapsedMs: 0 };
    if (!g.done) {
      while (
        !g.result &&
        Date.now() - t0 < budgetMs &&
        (g.attempt === 0 || Date.now() <= g.deadline) && // 首次必跑（与旧 for 语义一致），之后受总预算约束
        g.attempt < g.maxAttempts
      ) {
        g.attempt++;
        g.result = this._genAttempt(g); // 命中返回结果；未命中返回 null（g.last 已更新为最后尝试）
      }
      if (!g.done) g.done = !!g.result || g.attempt >= g.maxAttempts || Date.now() > g.deadline;
    }
    // 收尾恰好一次（含 special/mix 在 begin 内即 done 的会话）
    if (g.done && !g.finalized) {
      this._finalizeGenerate(g);
      g.finalized = true;
    }
    return { done: g.done, attempts: g.attempt, elapsedMs: Date.now() - g.beginTs };
  }

  /**
   * 增量生成 ③ 收尾（恰好一次）：无结果时走兜底（原 _generate 尾部迁移），
   * 随后完成局面字段回填（原 loadLevel 后半段迁移）。
   */
  _finalizeGenerate(g) {
    if (!g.result) {
      // 兜底：预算内未验证出可解局面，返回最后一次（keyLayer 置空避免隐藏误标）
      if (!this.lastGenSolvable)
        console.warn(
          `[game] 关卡生成 ${GEN_TOTAL_BUDGET_MS}ms 预算内未验证出可解局面，兜底返回最后尝试（存在不可解风险）`
        );
      // 炸弹关兜底防御（F-06）：解长约束未通过验证 → bombMoves 放大为 lastSolLen + 4（解长可得时），
      // 保证兜底局面不违反「解长 ≤ bombMoves − 2」安全余量
      const { bombMoves, moveLimit, timeLimit } = g.opts;
      let bm = g.last.bombMoves || bombMoves;
      if (g.last.bombs.length > 0 && this._lastSolLen > 0) {
        bm = Math.max(bm, this._lastSolLen + 4);
      }
      // 限时/步限兜底防御（同炸弹 F-06 模式）：解长约束未通过验证 → 按 solLen 放大（solLen 可得时），
      // 保证兜底局面不违反「solLen ≤ moveLimit − 2 / solLen × 6 ≤ timeLimit」约束（0 = 不限的关不放大）
      let genMoveLimit = moveLimit;
      let genTimeLimit = timeLimit;
      if (this._lastSolLen > 0) {
        if (genMoveLimit > 0) genMoveLimit = Math.max(genMoveLimit, this._lastSolLen + 2);
        if (genTimeLimit > 0) genTimeLimit = Math.max(genTimeLimit, this._lastSolLen * 6);
      }
      g.result = {
        bottles: g.last.bottles,
        locks: g.last.locks,
        keyLayer: null,
        covers: g.last.covers,
        bombs: g.last.bombs,
        bombMoves: bm,
        moveLimit: genMoveLimit,
        timeLimit: genTimeLimit,
      };
    }
    const gen = g.result;
    this.bottles = gen.bottles;
    this.locks = gen.locks;
    // 遮盖瓶（PRD-玩法扩展 §2 A）：仅普通关管线产出；special/mix 关 gen 无 covers 字段 → 空
    this.coverBottles = gen.covers || [];
    this.coverLayers = this.coverBottles.length > 0 ? g.coverLayers : 0;
    // 炸弹瓶（PRD-玩法扩展 §2 B）：仅普通关管线产出；bombMoves 由生成确定（显式配置或自动口径）
    this.bombBottles = gen.bombs || [];
    this.bombMoves = this.bombBottles.length > 0 ? gen.bombMoves || 0 : 0;
    this.bombTimers = this.bombBottles.map(() => this.bombMoves);
    this.bombDefused = this.bombBottles.map(() => false);
    // 生成兜底可能按解长放大限时/步限（见 _finalizeGenerate 兜底分支），以生成回传值为准；special/mix 管线无此字段
    if (gen.timeLimit != null) this.timeLimit = this.timeLeft = gen.timeLimit;
    if (gen.moveLimit != null) this.moveLimit = gen.moveLimit;
    this.unlocked = gen.locks.map(() => false);
    this._revealTops();
    this.completed = [];
    this.removed = new Set();
    this.undoStack = [];
    this.moveCount = 0;
  }

  // ---------- 关卡生成：随机分层发牌 + 布锁 + 求解器验证，保证必有解 ----------

  /**
   * 单次 attempt（原 _generate 循环体逐行迁移，PRD-关卡生成异步化 F-01）：
   * ① 瓶结构 —— 数量 / 每瓶容量（大小）+ 空瓶
   * ② 机制位置 —— 锁瓶与钥匙深度、隐藏槽位（仅依赖结构、不依赖液体颜色；
   *    散打关瓶装量由 ③ 决定 → 机制延后到 ③ 之后按实际装量放置）
   * ③ 液体打散 —— 洗混装瓶（②选定的隐藏槽位在此应用负编码）
   * ④ 验证 —— 开局无满纯色 + DFS 求解器 + 解长约束（限时/步限/炸弹）
   * 命中可解局面返回生成结果；否则更新 g.last（最后尝试）并返回 null，
   * 重试与总预算由 stepGenerate 驱动（语义与旧 for 循环一致：首次必跑，其后受 deadline 约束）。
   */
  _genAttempt(g) {
    const {
      colors,
      empties,
      seed,
      noEmptyStart = false,
      condLockCount = 0,
      condLockNeed = 2,
      keyLockCount = 0,
      hiddenCount = 0,
      coverCount = 0,
      coverLayers = 2,
      bombCount = 0,
      bombMoves = 0,
      timeLimit = 0,
      moveLimit = 0,
      level = 0,
    } = g.opts;
    const nodeLimit = g.nodeLimit;
    const attempt = g.attempt - 1; // dealSeed 序号与旧 for 循环一致（g.attempt 已在 stepGenerate 内自增）
    const dealSeed = seed + attempt * 997;
    g.lastDealSeed = dealSeed; // 命中牌面的实际 dealSeed 直读（seed 规范化/工具用：记录它即可让运行时首 attempt 命中）
      const rng = new Rng(dealSeed); // 与打散同 rng 序列（同 seed 可复现；重试随 attempt 变化）
      let locks = [];
      let keyLayer = null;
      let covers = [];
      let bombs = [];
      let bottles;
      if (noEmptyStart) {
        // 散打关：③ 打散先定瓶装量 → 机制延后（锁按实际装量，隐藏 _markHidden）
        bottles = this._dealScattered(colors, rng);
        const post = this._placeMechanismsPostDeal(rng, bottles, { condLockCount, condLockNeed, keyLockCount });
        locks = post.locks;
        keyLayer = post.keyLayer;
        // 遮盖瓶（PRD-玩法扩展 §2 A）：打散后按实际锁位补选（非空瓶，避开锁瓶/钥匙瓶），
        // 隐藏标记排除遮盖瓶（遮盖瓶内不放 hidden 层）
        covers = this._pickCoverBottles(bottles, coverCount, locks, keyLayer, rng, level);
        if (hiddenCount > 0) {
          this._markHidden(bottles, hiddenCount, dealSeed + 31, keyLayer, new Set(covers));
        }
        // 炸弹瓶（PRD-玩法扩展 §2 B）：遮盖/隐藏标记后补选（排除含隐藏层瓶，瓶级零重叠）
        bombs = this._pickBombBottles(bottles, bombCount, locks, keyLayer, covers, rng, level);
      } else {
        // 标准关：② 机制位置（结构已知 = 前 colors 瓶满 + empties 空）→ ③ 打散 → 应用隐藏编码
        const mech = this._placeMechanisms(rng, {
          colors,
          condLockCount,
          condLockNeed,
          keyLockCount,
          hiddenCount,
          coverCount,
        });
        locks = mech.locks;
        keyLayer = mech.keyLayer;
        covers = mech.covers || [];
        bottles = this._dealStandard(colors, empties, rng);
        if (mech.hiddenSlots) {
          for (const [bi, li] of mech.hiddenSlots) bottles[bi][li] = -(bottles[bi][li] + 1);
        }
        // 炸弹瓶（PRD-玩法扩展 §2 B）：内容瓶中选，避开锁瓶/钥匙瓶/遮盖瓶/隐藏瓶（v1 信息不叠加）。
        // 独立 rng 流（dealSeed + 53，与 _markHidden 的 dealSeed+31 同思路）——不扰动主洗牌序列，
        // 既有局面（含 seed 固化关）零扰动，par 不变
        if (bombCount > 0) {
          const bombRng = new Rng(dealSeed + 53);
          const hiddenBottles = new Set((mech.hiddenSlots || []).map(([bi]) => bi));
          const bombCands = [];
          for (let bi = 0; bi < colors; bi++) {
            if (locks.some((l) => l.bottle === bi)) continue;
            if (keyLayer && bi === keyLayer.bottle) continue;
            if (covers.includes(bi)) continue;
            if (hiddenBottles.has(bi)) continue;
            bombCands.push(bi);
          }
          for (let i = 0; i < bombCount && bombCands.length > 0; i++) {
            bombs.push(bombCands.splice(bombRng.int(bombCands.length), 1)[0]);
          }
        }
      }
      // ④ 验证：开局不允许直接存在已完成的满瓶纯色
      if (bottles.some((b) => this._isFullMono(b))) {
        g.last = { bottles, locks, covers, bombs, bombMoves: 0 };
        return null;
      }
      const lockInfo = {
        // 求解器精确模拟钥匙倒出
        keyLocks: locks.filter((l) => l.type === 'key'),
        // 条件锁 + 遮盖伪锁同通道（PRD-玩法扩展 §2 A）：遮盖解封与条件锁解锁同构
        // （完成 N 瓶成品揭示），复用 condLock 语义保证「coverLeft > 0 的瓶不可操作」
        condLocks: locks
          .filter((l) => l.type === 'cond')
          .concat(covers.map((b) => ({ bottle: b, type: 'cond', need: coverLayers }))),
      };
      g.last = { bottles, locks, covers, bombs, bombMoves: 0 };
      // 带锁/带遮盖求解器验证局面必有解
      if (this._solvable(bottles, nodeLimit, null, lockInfo)) {
        const solLen = Math.max(1, this._lastSolLen);
        // 限时/步限解长约束（PRD-限时与步数限制 F-04，与炸弹解长约束同模式）：
        // 解长 ≤ moveLimit − 2 且 解长 × 6 ≤ timeLimit，显式配置违例 → 换 seed 重洗。
        // 配置层（levels.js _validateLimits）已按 par 放大的关：solLen ≤ par 恒不触发重洗（零扰动）
        if (moveLimit > 0 && solLen > moveLimit - 2) return null;
        if (timeLimit > 0 && solLen * 6 > timeLimit) return null;
        // 炸弹解长约束（PRD-玩法扩展 §2 B）：解长 ≤ bombMoves - 2（安全余量）。
        // 通关必清空所有瓶 → 可行解路径中途必不引爆，约束即完整约束，求解器无需建模引爆。
        // 胜利条件已由 _solvable 验证，此处用其启发式解长（par 上界）做廉价校准：
        let bm = bombMoves;
        if (bombCount > 0) {
          if (bm > 0) {
            if (solLen > bm - 2) return null; // 显式配置余量不足 → 换 seed 重洗
          } else {
            // 自动口径：解长 + 余量 4，向下不小于 8（par ≤ 启发式解长 → par ≤ bm - 4，方向偏松）
            bm = Math.max(8, solLen + 4);
          }
        }
        this.lastGenSolvable = true;
        this.lastGenSolLen = this._lastSolLen;
        return { bottles, locks, keyLayer, covers, bombs, bombMoves: bm };
      }
    return null; // 本 attempt 未命中（重试与兜底由 stepGenerate / _finalizeGenerate 驱动）
  }

  /**
   * 遮盖瓶选取（散打关用，PRD-玩法扩展 §2 A）：候选 = 非空瓶 − 锁瓶 − 钥匙瓶，
   * rng 驱动可复现。标准关遮盖位在 _placeMechanisms 内随机制位置统一选取。
   */
  _pickCoverBottles(bottles, coverCount, locks, keyLayer, rng, level = 0) {
    if (coverCount <= 0) return [];
    const cands = [];
    for (let bi = 0; bi < bottles.length; bi++) {
      if (bottles[bi].length === 0) continue;
      if (locks.some((l) => l.bottle === bi)) continue;
      if (keyLayer && bi === keyLayer.bottle) continue;
      cands.push(bi);
    }
    const covers = [];
    for (let i = 0; i < coverCount && cands.length > 0; i++) {
      covers.push(cands.splice(rng.int(cands.length), 1)[0]);
    }
    // 防御性告警（F-05）：候选不足按实际上限截断（不炸游戏），提示配置疑似少配
    if (covers.length < coverCount) {
      console.warn(`[game] L${level} coverCount=${coverCount} 候选不足，实际遮盖 ${covers.length} 瓶（请检查 levels.json 配置）`);
    }
    return covers;
  }

  /**
   * 炸弹瓶选取（散打关用，PRD-玩法扩展 §2 B）：候选 = 非空瓶 − 锁瓶 − 钥匙瓶 − 遮盖瓶 − 隐藏瓶，
   * rng 驱动可复现。标准关炸弹位在 _placeMechanisms 内随机制位置统一选取。
   */
  _pickBombBottles(bottles, bombCount, locks, keyLayer, covers, rng, level = 0) {
    if (bombCount <= 0) return [];
    const cands = [];
    for (let bi = 0; bi < bottles.length; bi++) {
      if (bottles[bi].length === 0) continue;
      if (bottles[bi].some((c) => c < 0)) continue; // 含隐藏层瓶不重叠（v1 信息不叠加）
      if (locks.some((l) => l.bottle === bi)) continue;
      if (keyLayer && bi === keyLayer.bottle) continue;
      if (covers.includes(bi)) continue;
      cands.push(bi);
    }
    const bombs = [];
    for (let i = 0; i < bombCount && cands.length > 0; i++) {
      bombs.push(cands.splice(rng.int(cands.length), 1)[0]);
    }
    // 防御性告警（F-05）：候选不足按实际上限截断（不炸游戏），提示配置疑似少配
    if (bombs.length < bombCount) {
      console.warn(`[game] L${level} bombCount=${bombCount} 候选不足，实际炸弹 ${bombs.length} 瓶（请检查 levels.json 配置）`);
    }
    return bombs;
  }

  /**
   * 机制位置放置（阶段②，标准关）：仅依赖瓶结构（前 colors 瓶满 + empties 空），
   * 不依赖液体颜色。返回 hiddenSlots = [[瓶下标, 层下标]]，由调用方在 ③ 打散后应用负编码。
   */
  _placeMechanisms(rng, { colors, condLockCount = 0, condLockNeed = 2, keyLockCount = 0, hiddenCount = 0, coverCount = 0 }) {
    const locks = [];
    let keyLayer = null;
    // 条件锁瓶（方案 B）：内容瓶中选
    const condCands = [];
    for (let i = 0; i < colors; i++) condCands.push(i);
    for (let i = 0; i < condLockCount && condCands.length > 0; i++) {
      locks.push({ bottle: condCands.splice(rng.int(condCands.length), 1)[0], type: 'cond', need: condLockNeed });
    }
    // 钥匙锁瓶（方案 B）：锁在内容瓶上（不与任何锁瓶重叠）；钥匙层 = 内容瓶非顶层
    for (let i = 0; i < keyLockCount; i++) {
      const lockCands = [];
      for (let bi = 0; bi < colors; bi++) if (!locks.some((l) => l.bottle === bi)) lockCands.push(bi);
      if (lockCands.length === 0) continue; // 极端无候选（几乎不可能），跳过该锁
      const lockIdx = lockCands[rng.int(lockCands.length)];
      const keyCands = [];
      for (let bi = 0; bi < colors; bi++) {
        if (bi !== lockIdx && !locks.some((l) => l.bottle === bi)) keyCands.push(bi);
      }
      if (keyCands.length === 0) continue;
      const kb = keyCands[rng.int(keyCands.length)];
      const kd = rng.int(Math.max(1, this.capacity - 1)); // 从底数第 0~cap-2 层（非顶层）
      locks.push({ bottle: lockIdx, type: 'key', keyBottle: kb, keyDepth: kd });
      keyLayer = { bottle: kb, depth: kd }; // v1 仅 1 个钥匙，供隐藏槽位排除
    }
    // 遮盖瓶（PRD-玩法扩展 §2 A）：内容瓶中选，避开锁瓶/钥匙瓶；隐藏槽位候选同步排除遮盖瓶
    // （遮盖瓶内不放 hidden 层），保证「遮盖 / 锁 / 隐藏」三者瓶级零重叠
    const covers = [];
    if (coverCount > 0) {
      const coverCands = [];
      for (let bi = 0; bi < colors; bi++) {
        if (locks.some((l) => l.bottle === bi)) continue;
        if (keyLayer && bi === keyLayer.bottle) continue;
        coverCands.push(bi);
      }
      for (let i = 0; i < coverCount && coverCands.length > 0; i++) {
        covers.push(coverCands.splice(rng.int(coverCands.length), 1)[0]);
      }
    }
    // 隐藏槽位：内容瓶非顶层（避开钥匙层与遮盖瓶）
    const cands = [];
    for (let bi = 0; bi < colors; bi++) {
      if (covers.includes(bi)) continue;
      for (let li = 0; li < this.capacity - 1; li++) {
        if (keyLayer && bi === keyLayer.bottle && li === keyLayer.depth) continue;
        cands.push([bi, li]);
      }
    }
    const hiddenSlots = [];
    for (let i = 0; i < hiddenCount && i < cands.length; i++) {
      const j = i + rng.int(cands.length - i);
      [cands[i], cands[j]] = [cands[j], cands[i]];
      hiddenSlots.push(cands[i]);
    }
    return { locks, keyLayer, hiddenSlots, covers };
  }

  /** 机制位置放置（打散后，散打关用）：锁瓶/钥匙深度按实际瓶装量选取 */
  _placeMechanismsPostDeal(rng, bottles, { condLockCount = 0, condLockNeed = 2, keyLockCount = 0 } = {}) {
    const locks = [];
    let keyLayer = null;
    const condCands = bottles.map((b, i) => (b.length > 0 ? i : -1)).filter((i) => i >= 0);
    for (let i = 0; i < condLockCount && condCands.length > 0; i++) {
      locks.push({ bottle: condCands.splice(rng.int(condCands.length), 1)[0], type: 'cond', need: condLockNeed });
    }
    for (let i = 0; i < keyLockCount; i++) {
      const lockCands = bottles
        .map((b, bi) => (b.length > 0 && !locks.some((l) => l.bottle === bi) ? bi : -1))
        .filter((bi) => bi >= 0);
      if (lockCands.length === 0) continue;
      const lockIdx = lockCands[rng.int(lockCands.length)];
      const keyCands = bottles
        .map((b, bi) => (b.length >= 2 && bi !== lockIdx && !locks.some((l) => l.bottle === bi) ? bi : -1))
        .filter((bi) => bi >= 0);
      if (keyCands.length === 0) continue;
      const kb = keyCands[rng.int(keyCands.length)];
      const kd = rng.int(bottles[kb].length - 1); // 从底数第 0~len-2 层（非顶层）
      locks.push({ bottle: lockIdx, type: 'key', keyBottle: kb, keyDepth: kd });
      keyLayer = { bottle: kb, depth: kd };
    }
    return { locks, keyLayer };
  }

  /**
   * 液体打散（阶段③，标准关）：colors 色 × capacity 层洗混后依次装满前 colors 个瓶，
   * 再附加 empties 个空瓶。
   */
  _dealStandard(colors, empties, rng) {
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
   * 液体打散（阶段③，散打关 R3/Q2=A）：colors 色 × capacity 层随机分布到
   * colors + 1 个瓶，每瓶层数 ∈ [2, capacity]（允许满混合瓶，禁止满纯色由 ④ 校验），
   * 总层数 < (colors+1)×capacity 天然保证至少 1 瓶非满，开局必有合法步。
   */
  _dealScattered(colors, rng) {
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
    if (!this.lastGenSolvable) console.warn('[game] 大瓶关生成 5s 预算内未验证出可解局面，兜底返回最后尝试（存在不可解风险）');
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
   * 混合容量关生成（PRD-混合容量瓶 §2，v2 按用户拍板调整）：
   * ① 每色总量随机 3~5（= 该色的目标容量，收瓶容量与之匹配）——
   *    「满纯色 = 完整色」，不存在拆色残留死局（v1 恒 = capacity 的规则废弃）；
   * ② 瓶子 = colors 个内容瓶（容量 = 各色总量的洗牌错位多重集）+ empties 个空瓶（随机 3~5）；
   * ③ 装牌 = 全部层洗混后依次装满内容瓶（每瓶装满自身容量），空瓶留空；
   * 求解器按 per-bottle 容量验证（状态 key 编入容量，cap3 与 cap5 瓶不可互换去重）。
   */
  _generateMixed(colors, empties, seed) {
    const nodeLimit = this.capacity >= 5 ? 200000 : 60000;
    const deadline = Date.now() + 5000;
    const MAX_ATTEMPTS = 20000;
    const n = colors + empties;
    const sizes = [this.capacity - 1, this.capacity, this.capacity + 1]; // 4 时为 3~5
    let last = { bottles: [], caps: [] };
    this.lastGenSolvable = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0 && Date.now() > deadline) break;
      const rng = new Rng(seed + attempt * 997);
      // ① 每色总量（= 该色目标瓶容量）
      const totals = [];
      let total = 0;
      for (let c = 0; c < colors; c++) {
        const v = sizes[rng.int(3)];
        totals.push(v);
        total += v;
      }
      // ② 内容瓶容量 = 各色总量洗牌错位（多重集一致 → 每色必有同容量瓶可收纳），空瓶随机 3~5
      const caps = totals.slice();
      for (let i = caps.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [caps[i], caps[j]] = [caps[j], caps[i]];
      }
      for (let e = 0; e < empties; e++) caps.push(sizes[rng.int(3)]);
      // ③ 装牌：全部层洗混，依次装满内容瓶
      const layers = [];
      for (let c = 0; c < colors; c++) {
        for (let i = 0; i < totals[c]; i++) layers.push(c);
      }
      for (let i = layers.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [layers[i], layers[j]] = [layers[j], layers[i]];
      }
      const bottles = [];
      let k = 0;
      for (let i = 0; i < n; i++) {
        const take = Math.min(caps[i], total - k);
        bottles.push(take > 0 ? layers.slice(k, k + take) : []);
        k += take;
      }
      // 开局不允许直接存在满纯色瓶（按各瓶自身容量判定）
      last = { bottles, caps };
      if (bottles.some((b, i) => this._isFullMono(b, caps[i]))) continue;
      if (this._solvable(bottles, nodeLimit, null, null, null, caps)) {
        this.lastGenSolvable = true;
        return { bottles, caps, locks: [], keyLayer: null };
      }
    }
    if (!this.lastGenSolvable) console.warn('[game] 混合关生成 5s 预算内未验证出可解局面，兜底返回最后尝试（存在不可解风险）');
    return { bottles: last.bottles, caps: last.caps, locks: [], keyLayer: null };
  }

  /**
   * 可解性验证：DFS 搜索（与游戏规则完全一致的模拟，含完成清空与锁瓶过滤）。
   * 启发式：完成腾瓶 > 腾空源瓶 > 同色目标（越接近满越优）> 空瓶目标；
   * 状态 key 规范化（自由瓶内容排序）合并排列等价状态，大幅剪枝。
   * lockInfo（可选）：
   * - condLocks：条件锁瓶（done.size < need 时冻结；锁状态由完成数推导，Q3=B）；
   * - keyLocks：钥匙锁瓶（精确模拟钥匙层倒出：逐锁 keyState 位串并入状态 key——
   *   剔除模型的简化在 L30 三机制叠加时过保守（可解率≈0），改为与游戏规则一致的模拟；
   *   2026-10-28 修复：keyOut 单布尔 → 逐锁独立，双钥匙关不再「倒一把解全锁」）。
   */
  _solvable(bottles, nodeLimit = 60000, removedSet = null, lockInfo = null, bigInfo = null, mixCaps = null) {
    const cap = this.capacity;
    const bigIdx = bigInfo ? bigInfo.idx : -1; // 特殊关：大瓶下标（普通关 -1）
    const bigCap = bigInfo ? bigInfo.capacity : cap; // 大瓶容量（R4/S-05）
    // 每瓶容量（混合关 = mixCaps；其余关 = 大瓶 bigCap / 统一 cap）
    const capAt = (i) => (mixCaps ? mixCaps[i] : i === bigIdx ? bigCap : cap);
    const bigColor = bigInfo && bigInfo.color >= 0 ? bigInfo.color : -1; // 大瓶限定色（-1 = 不限制）
    const condLocks = (lockInfo && lockInfo.condLocks) || [];
    const keyLocks = (lockInfo && lockInfo.keyLocks) || [];
    // 隐藏层负编码统一解码为真实色：游戏对顶层自动揭示，隐藏不构成额外限制，
    // 求解器按真实色搜索与实际玩法等价（跨隐藏段的连续倒可拆成多次单层倒，可解性不变）
    const bs = bottles.map((b) => b.slice().map((c) => (c >= 0 ? c : -c - 1)));
    const n = bs.length;
    const done = new Set(removedSet || []); // 已收走的瓶（含搜索中新完成的），不参与倒水
    const visited = new Set();
    let nodes = 0;
    // 钥匙倒出状态（逐锁独立，PRD-100关 第5章 keyLockCount=2 起必须区分）：
    // 旧实现为单个全局布尔（v1 每关至多 1 把钥匙的假设），双钥匙关会乐观地「倒一把解全锁」，
    // 与活动 API 的逐锁 unlocked 不一致 → 生成会接受实际不可解局面（2026-10-28 L45 实测修复）
    const keyState = keyLocks.map(() => false);
    this._lastSolLen = -1; // 启发式 DFS 找到的解长（炸弹关解长约束用；未找到 = -1）

    /** 瓶 i 当前是否不可用（对应钥匙未倒出时的钥匙锁瓶；完成数不足时的条件锁瓶） */
    const locked = (i) => {
      for (let k = 0; k < keyLocks.length; k++) {
        if (keyLocks[k].bottle === i && !keyState[k]) return true;
      }
      for (const cl of condLocks) {
        if (cl.bottle === i && done.size < cl.need) return true;
      }
      return false;
    };

    const amountOf = (f, t, ti) => {
      const tcap = capAt(ti); // 目标瓶容量按瓶取（大瓶 bigCap / 混合关 per-bottle，R2 零规则豁免）
      if (!f.length || t.length >= tcap) return 0;
      if (ti === bigIdx && f[f.length - 1] !== bigColor) return 0; // 瓶口颜色限制（与 canPour 一致）
      if (t.length && t[t.length - 1] !== f[f.length - 1]) return 0;
      let run = 1;
      for (let i = f.length - 2; i >= 0 && f[i] === f[f.length - 1]; i--) run++;
      return Math.min(run, tcap - t.length);
    };

    const dfs = (depth = 0) => {
      if (bigIdx >= 0) {
        // 特殊关胜利条件（R4）：大瓶满且纯色 = 通关（替代「全部完成清空」）
        const big = bs[bigIdx];
        if (big.length === bigCap && big.every((c) => c === big[0])) {
          this._lastSolLen = depth; // 解长记录（炸弹关生成约束用）
          return true;
        }
      } else if (bs.every((b) => b.length === 0)) {
        // 完成即清空 → 所有瓶为空 = 通关
        this._lastSolLen = depth;
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
        // 混合关：容量编入自由瓶 key——内容相同但容量不同的瓶（cap3 vs cap5）不可互换去重
        else freeKeys.push((mixCaps ? mixCaps[i] + ':' : '') + s);
      }
      const key =
        freeKeys.sort().join('|') +
        '#' +
        fixedKeys.join('|') +
        (keyLocks.length ? '#K' + keyState.map((b) => (b ? 1 : 0)).join('') : '');
      if (visited.has(key)) return false;
      visited.add(key);

      const moves = [];
      for (let from = 0; from < n; from++) {
        if (done.has(from) || locked(from)) continue;
        if (from === bigIdx) continue; // 大瓶只进不出（与 canPour 同步，防假可解，2026-10-28）
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
            // 倒满即完成（目标整瓶同色）→ 腾出空瓶，最高优先（按该瓶容量判定，混合关 per-bottle）
            score = tr === t.length && t.length + amount === capAt(to) ? 600 : 100 + tr;
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
        // 钥匙层倒出判定（与游戏 pour 逻辑一致：倒出层覆盖钥匙深度位置；逐锁独立解锁）
        const keyWas = keyState.join('');
        for (let k = 0; k < keyLocks.length; k++) {
          const kl = keyLocks[k];
          if (!keyState[k] && kl.keyBottle === m.from && kl.keyDepth >= fromLenBefore - m.amount) {
            keyState[k] = true;
          }
        }
        if (bigIdx < 0 && t.length === capAt(m.to)) {
          // 完成判定按真实色与该瓶容量（与游戏 _isFullMono 一致；shuffle 验证时冻结瓶可能含隐藏层）。
          // 特殊关无「完成清空」语义（R4：普通瓶满纯色不收走），整体跳过。
          // 回收守卫与 pour() 镜像（共用 _colorGathered）：错误容量满瓶不回收、继续参与搜索，
          // 保证求解器与实际玩法等价（PRD-按钮反馈与混合关回收守卫 FR-05）。
          const c0 = t[0] >= 0 ? t[0] : -t[0] - 1;
          if (
            t.every((c) => (c >= 0 ? c : -c - 1) === c0) &&
            this._colorGathered(bs, c0, t.length, done)
          ) {
            t.length = 0; // 完成清空 + 收走，不再参与后续搜索
            done.add(m.to);
          }
        }
        if (dfs(depth + 1)) return true;
        for (let i = 0; i < n; i++) bs[i] = snap[i];
        done.delete(m.to);
        for (let k = 0; k < keyState.length; k++) keyState[k] = keyWas[k] === '1';
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

  /** 瓶 idx 的容量（混合关 = caps[idx]；特殊关大瓶 = bigCapacity；其余 = this.capacity） */
  capOf(idx) {
    if (this.mix) return this.caps[idx] || this.capacity;
    return this.special === 'bigBottle' && idx === this.bigIndex ? this.bigCapacity : this.capacity;
  }

  /** 瓶子是否处于锁定状态（未解锁的锁瓶，不可作为倒水源/目标）。供胶水层/表现层查询 */
  isLocked(idx) {
    for (let k = 0; k < this.locks.length; k++) {
      if (this.locks[k].bottle === idx && !this.unlocked[k]) return true;
    }
    return false;
  }

  // ---------- 遮盖瓶（PRD-玩法扩展 §2 A） ----------

  /**
   * 遮盖剩余层数：由「已收集成品数」派生（每完成一瓶成品全体同步 -1，归零揭示）。
   * completed 随 pour/undo/快照栈精确回滚 → 遮盖状态天然随局面可复算，无独立快照字段。
   */
  coverLeft() {
    return Math.max(0, this.coverLayers - this.completed.length);
  }

  /** 瓶 idx 是否处于遮盖状态（未揭示遮盖瓶不可选中/倒出/倒入，与锁定瓶同级交互锁） */
  isCovered(idx) {
    return this.coverLayers > 0 && this.coverLeft() > 0 && this.coverBottles.includes(idx);
  }

  // ---------- 炸弹瓶（PRD-玩法扩展 §2 B） ----------

  /**
   * 失败判定（派生量，不入快照）：时间归零 ∨ 步数达限 ∷ 任一未拆除炸弹倒计时归零 → 本关失败。
   * undo 回退倒计时/步数后自动解除（时间单向流动不可解除，PRD 拍板 5）；core 只置逻辑态，弹窗 UI 由胶水层接管。
   */
  isFailed() {
    if (this.timeLimit > 0 && this.timeLeft <= 0) return true;
    if (this.moveLimit > 0 && this.moveCount >= this.moveLimit) return true;
    for (let k = 0; k < this.bombBottles.length; k++) {
      if (!this.bombDefused[k] && this.bombTimers[k] <= 0) return true;
    }
    return false;
  }

  /**
   * 失败原因（派生 getter，PRD-限时与步数限制 F-07）：
   * 'bomb' | 'moves' | 'time' | null（未失败）。同拍多机制优先级：炸弹 > 步数 > 时间——
   * 炸弹与步限可在同一次 pour 同时触发，按更具体原因显示；时间单向流动，一旦归零恒失败，顺序无歧义。
   */
  get failReason() {
    for (let k = 0; k < this.bombBottles.length; k++) {
      if (!this.bombDefused[k] && this.bombTimers[k] <= 0) return 'bomb';
    }
    if (this.moveLimit > 0 && this.moveCount >= this.moveLimit) return 'moves';
    if (this.timeLimit > 0 && this.timeLeft <= 0) return 'time';
    return null;
  }

  /**
   * 限时推进（PRD-限时与步数限制 F-02，纯逻辑）：由胶水层每帧喂 dt；浮层打开时胶水层停喂即暂停
   * （core 无需感知暂停态）。时间不入 undoStack/快照，撤销不回退（单向流动）。
   */
  tickTime(dt) {
    if (this.timeLimit <= 0 || this.timeLeft <= 0 || !(dt > 0)) return;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
  }

  /**
   * 续杯复活加成（PRD-限时与步数限制 F-10 统一复活语义，替代旧「undo×3 + 引信重置」广告复活）：
   * 按 failReason 补资源——time → timeLeft + 60；moves → moveLimit + 10（上限抬升，显示跟随）；
   * bomb → 未拆除引信各 +10（封顶各自初值 bombMoves，加成走 BOMB_REVIVE_BONUS，与步限加成独立调参）。加成后失败条件自动解除（库存消耗归胶水层）。
   * @returns {'bomb'|'moves'|'time'|null} 实际加成的失败原因（未失败时 null，调用方不应调用）
   */
  applyRevive() {
    const reason = this.failReason;
    if (reason === 'time') {
      this.timeLeft += TIME_REVIVE_BONUS;
    } else if (reason === 'moves') {
      this.moveLimit += MOVE_REVIVE_BONUS;
    } else if (reason === 'bomb') {
      for (let k = 0; k < this.bombBottles.length; k++) {
        if (!this.bombDefused[k]) {
          // BOMB_REVIVE_BONUS 与 MOVE_REVIVE_BONUS 当前同值，独立调参
          this.bombTimers[k] = Math.min(this.bombTimers[k] + BOMB_REVIVE_BONUS, this.bombMoves);
        }
      }
    }
    return reason;
  }

  /** 瓶 idx 的剩余引信步数（表现层/调试协议查询）；非炸弹瓶或已拆除 → -1 */
  bombTimerOf(idx) {
    const k = this.bombBottles.indexOf(idx);
    if (k < 0 || this.bombDefused[k]) return -1;
    return this.bombTimers[k];
  }

  /** 未拆除炸弹倒计时重置为初值（拆除标记保留——拆除成果不回退）。
   *  注：续杯统一复活语义（F-10）改用引信 +10 封顶（applyRevive），本方法仅测试/维护用途保留 */
  resetBombs() {
    for (let k = 0; k < this.bombBottles.length; k++) {
      if (!this.bombDefused[k]) this.bombTimers[k] = this.bombMoves;
    }
  }

  canPour(from, to) {
    if (from === to) return 0;
    if (this.isFailed()) return 0; // 失败后冻结操作（除撤回/重开，PRD-玩法扩展 §2 B）
    if (this.removed.has(from) || this.removed.has(to)) return 0; // 已收走的瓶不参与
    if (this.isLocked(from) || this.isLocked(to)) return 0; // 未解锁锁瓶不可作源/目标
    if (this.isCovered(from) || this.isCovered(to)) return 0; // 未揭示遮盖瓶不可作源/目标（PRD-玩法扩展 §2 A）
    if (this.special === 'bigBottle' && from === this.bigIndex) return 0; // 大瓶只进不出（2026-10-28 规则修正，与求解器 _solvable 同步）
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
      bombsBefore: this.bombBottles.length
        ? { t: this.bombTimers.slice(), d: this.bombDefused.slice() } // 炸弹倒计时快照（步数资源回退）
        : null,
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
    let guardBlocked = false;
    if (this.special !== 'bigBottle' && this._isFullMono(t, this.capOf(to))) {
      // 回收守卫：场上该真实色总层数 == 该瓶容量（该色已全部聚齐）才回收；
      // 混合关错误容量（色总量 > 瓶容量）满瓶不收走——瓶留场可继续倒出，防不可逆死局
      if (this._colorGathered(this.bottles, color, t.length, this.removed)) {
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
      } else {
        guardBlocked = true; // 供胶水层 toast「这瓶装不下该色全部 N 层，暂不收走」
      }
    }
    // 炸弹瓶结算（PRD-玩法扩展 §2 B）：本次倒液倒空的炸弹瓶拆除（永久，不再倒计时）；
    // 仍未拆除的炸弹倒计时 -1，归零 → isFailed()（胶水层弹失败流程）
    if (this.bombBottles.length) {
      for (let k = 0; k < this.bombBottles.length; k++) {
        const bi = this.bombBottles[k];
        if (!this.bombDefused[k] && this.bottles[bi].length === 0) this.bombDefused[k] = true;
        if (!this.bombDefused[k]) this.bombTimers[k]--;
      }
    }
    this.undoStack.push(record);
    this.moveCount++;
    return { amount, color, completedColor, guardBlocked };
  }

  /** 撤回上一步（倒水 / 打乱 / 加瓶，按栈序恢复到该步之前的状态） */
  undo() {
    const r = this.undoStack.pop();
    if (!r) return false;
    if (r.type === 'shuffle') {
      this.bottles = r.bottles;
      this.completed = r.completed;
      if (r.unlockedBefore) this.unlocked = r.unlockedBefore.slice();
      if (r.bombsBefore) {
        this.bombTimers = r.bombsBefore.t.slice();
        this.bombDefused = r.bombsBefore.d.slice();
      }
    } else if (r.type === 'shuffleOne') {
      this.bottles[r.idx] = r.content;
    } else if (r.type === 'addBottle') {
      // LIFO 保证此时新增瓶必为空（其后所有倒水已先被撤销）
      this.bottles.splice(r.idx, 1);
      if (this.mix) this.caps.splice(r.idx, 1); // 混合关：caps 与 bottles 平行同步
      this.removed.delete(r.idx);
    } else {
      this.bottles[r.from] = r.fromContent;
      this.bottles[r.to] = r.toContent;
      this.completed = r.completedBefore;
      if (r.unlockedBefore) this.unlocked = r.unlockedBefore.slice();
      if (r.removedBefore) this.removed.add(r.to);
      else this.removed.delete(r.to);
      if (r.bombsBefore) {
        this.bombTimers = r.bombsBefore.t.slice();
        this.bombDefused = r.bombsBefore.d.slice();
      }
      if (this.moveCount > 0) this.moveCount--;
    }
    return true;
  }

  // ---------- 道具（方案 4） ----------

  /**
   * shortcut: 全场打乱已被选瓶打乱（shuffleOne）取代，生产代码无调用方、仅测试引用；
   * 产品确认回补「全场重排」玩法时恢复启用，否则应整体删除（含 undo 的 shuffle 分支）。
   *
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
    if (this.isFailed()) return false; // 失败后冻结操作（除撤回/重开）
    const frozen = new Set(); // 不参与重排的瓶（未解锁条件锁瓶整体保持原样）
    for (let k = 0; k < this.locks.length; k++) {
      if (this.locks[k].type === 'cond' && !this.unlocked[k]) frozen.add(this.locks[k].bottle);
    }
    // 遮盖瓶内容冻结（PRD-玩法扩展 §2 A）：瓶处于交互锁状态，与未解锁条件锁瓶同策略
    for (const bi of this.coverBottles) {
      if (this.isCovered(bi)) frozen.add(bi);
    }
    if (this.special === 'bigBottle') frozen.add(this.bigIndex); // 大瓶内容冻结（Q6=A：不打乱大瓶）
    const layers = [];
    for (let i = 0; i < this.bottles.length; i++) {
      if (this.removed.has(i) || frozen.has(i)) continue;
      for (const c of this.bottles[i]) layers.push(c >= 0 ? c : -c - 1); // 隐藏层揭示
    }
    const total = layers.length;
    if (total === 0) return false;
    // 可用瓶须能容纳全部待重排液体（混合关 = 各瓶容量之和；其余关 = 瓶数 × capacity；
    // 冻结瓶层数使 total 可能非整除）
    let activeCount = 0;
    let activeCaps = 0;
    for (let i = 0; i < this.bottles.length; i++) {
      if (!this.removed.has(i) && !frozen.has(i)) {
        activeCount++;
        activeCaps += this.capOf(i);
      }
    }
    if (total > (this.mix ? activeCaps : activeCount * this.capacity)) return false;

    const snapshot = {
      type: 'shuffle',
      bottles: this.bottles.map((b) => b.slice()),
      completed: this.completed.slice(),
      unlockedBefore: this.unlocked.slice(), // 锁状态快照（含 shuffle 解锁的钥匙锁）
      bombsBefore: this.bombBottles.length
        ? { t: this.bombTimers.slice(), d: this.bombDefused.slice() } // 炸弹状态快照（重排可能倒空炸弹瓶）
        : null,
    };
    // 带锁验证信息：条件锁按 need 模拟（done.size 起始 = completed 数，与实际解锁状态一致）；
    // 遮盖瓶注入伪 condLock（need = coverLayers，done 起始同 completed 数 → 与 isCovered 派生一致）；
    // 钥匙锁瓶即将被解锁，验证时视作普通空瓶（keyLocks 置空）
    const lockInfo = {
      condLocks: this.locks
        .filter((l) => l.type === 'cond')
        .concat(this.coverBottles.filter((b) => this.isCovered(b)).map((b) => ({ bottle: b, type: 'cond', need: this.coverLayers }))),
      keyLocks: [],
    };
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
          const take = Math.min(this.capOf(i), total - k);
          bottles.push(layers.slice(k, k + take)); // 依次装满（混合关按各瓶容量），最后一瓶装余量
          k += take;
        } else {
          bottles.push([]);
        }
      }
      if (bottles.some((b, i) => i !== this.bigIndex && this._isFullMono(b, this.capOf(i)))) continue;
      const bigInfo =
        this.special === 'bigBottle'
          ? { idx: this.bigIndex, capacity: this.bigCapacity, color: this.bigColor }
          : null;
      if (!this._solvable(bottles, nodeLimit, this.removed, lockInfo, bigInfo, this.mix ? this.caps : null))
        continue;
      // 重排倒空的炸弹瓶判拆除（倒空即拆除语义一致）；timers 不因打乱变化（快照随 undo 回退）
      if (this.bombBottles.length) {
        for (let k = 0; k < this.bombBottles.length; k++) {
          const bi = this.bombBottles[k];
          if (!this.bombDefused[k] && bottles[bi].length === 0) this.bombDefused[k] = true;
        }
      }
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
   * 道具·打乱（选瓶模式）：只打乱指定瓶内层序（隐藏层全部揭示），按颜色段随机——
   * 连续同色层作为整体参与排列，段内不拆散（打乱后不比分原状更碎，同色段可能合并）。
   * 与全场打乱不同，不校验全局可解性（玩家可用撤回兜底）。
   * 锁瓶不可选中；钥匙所在瓶在钥匙未倒出前不可选中（钥匙层位置元数据会失效）。
   * @returns {boolean} 是否成功（空瓶 / 纯色瓶 / 已收走的瓶 / 锁瓶 / 钥匙所在瓶无法打乱）
   */
  shuffleOne(idx) {
    const b = this.bottles[idx];
    if (!b || !b.length || this.removed.has(idx)) return false;
    if (this.isFailed()) return false; // 失败后冻结操作（除撤回/重开）
    if (this.special === 'bigBottle' && idx === this.bigIndex) return false; // 大瓶不可打乱（Q6=A）
    if (this.isLocked(idx)) return false; // 锁定瓶不可打乱
    if (this.isCovered(idx)) return false; // 遮盖瓶不可打乱（PRD-玩法扩展 §2 A）
    for (let k = 0; k < this.locks.length; k++) {
      const lk = this.locks[k];
      if (lk.type === 'key' && !this.unlocked[k] && lk.keyBottle === idx) return false; // 钥匙所在瓶
    }
    const revealed = b.map((c) => (c >= 0 ? c : -c - 1)); // 隐藏层揭示
    if (revealed.every((c) => c === revealed[0])) return false; // 纯色瓶无需打乱
    const before = b.slice();
    const original = revealed.slice(); // 揭示后的原排列（比较基准，含隐藏层时 before 不适用）
    // 按颜色段打乱：连续同色层为一段，只随机段间排列、段内层序不动（颜色保持连续不拆碎）
    const segs = [];
    for (const c of revealed) {
      if (segs.length && segs[segs.length - 1][0] === c) segs[segs.length - 1].push(c);
      else segs.push([c]);
    }
    let out = revealed;
    for (let attempt = 0; attempt < 24; attempt++) {
      for (let i = segs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [segs[i], segs[j]] = [segs[j], segs[i]];
      }
      out = segs.flat();
      if (out.some((c, i) => c !== original[i])) break; // 保证与原排列不同
    }
    this.bottles[idx] = out;
    this.undoStack.push({ type: 'shuffleOne', idx, content: before });
    return true;
  }

  /**
   * 道具·加瓶子：临时增加一个空瓶中转位（卡关救星）
   * @returns {boolean} 是否成功（达到布局上限则失败）
   */
  addBottle() {
    if (this.isFailed()) return false; // 失败后冻结操作（除撤回/重开）
    if (this.bottles.length >= this.maxBottles) return false; // 上限走配置（levels.json maxBottles，缺省 12）
    this.bottles.push([]);
    if (this.mix) this.caps.push(this.capacity); // 新瓶 = 标准容量中转位（PRD-混合容量瓶 §4.1）
    this.undoStack.push({ type: 'addBottle', idx: this.bottles.length - 1 });
    return true;
  }

  // ---------- 问号隐藏层（方案 3） ----------

  /**
   * 随机把 count 个非顶层液体层标记为隐藏（层值取负，真实色 = -(值+1)）。
   * 隐藏层仅在成为顶层时揭示，倒水规则无需特判。
   * excludeKey（可选，Q5=A）：钥匙层位置 {bottle, depth}，不与隐藏层共存（保证钥匙可见）。
   */
  /** 在给定瓶组上随机标记隐藏层（作用于传入数组，不依赖 this.bottles）。
   *  excludeBottles（可选，PRD-玩法扩展 §2 A）：整瓶排除（遮盖瓶内不放 hidden 层） */
  _markHidden(bottles, count, seed, excludeKey = null, excludeBottles = null) {
    const rng = new Rng(seed);
    const candidates = [];
    for (let bi = 0; bi < bottles.length; bi++) {
      if (excludeBottles && excludeBottles.has(bi)) continue;
      for (let li = 0; li < bottles[bi].length - 1; li++) {
        if (excludeKey && bi === excludeKey.bottle && li === excludeKey.depth) continue;
        candidates.push([bi, li]);
      }
    }
    for (let i = 0; i < count && i < candidates.length; i++) {
      const j = i + rng.int(candidates.length - i);
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      const [bi, li] = candidates[i];
      bottles[bi][li] = -(bottles[bi][li] + 1);
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
   *  否则隐藏层恰好同色时真实游戏永不完成、求解器却判定有解。
   *  cap（可选）= 该瓶容量（混合关 per-bottle，缺省 this.capacity）。 */
  _isFullMono(b, cap = this.capacity) {
    if (b.length !== cap) return false;
    const c0 = b[0] >= 0 ? b[0] : -b[0] - 1;
    return b.every((c) => (c >= 0 ? c : -c - 1) === c0);
  }

  /**
   * 回收守卫（PRD-按钮反馈与混合关回收守卫 §2.3）：
   * 场上（排除 excludedSet 中已收走的瓶——它们完成时已清空）真实色 color 的总层数
   * 是否恰等于 bottleLen——即该色已全部聚齐在指定瓶（瓶层数 == 其容量）时才允许回收。
   * 消除混合关「错误容量回收」不可逆死局：色总量 > 瓶容量时满瓶不收走，可继续倒出。
   * 隐藏层负编码（-c-1）按真实色解码统计；pour 用 this.bottles，_solvable 用局部 bs，
   * 共用本判定防两处漂移。普通关每色总量恒 = capacity → 守卫恒真（零回归）。
   */
  _colorGathered(bottles, color, bottleLen, excludedSet) {
    let total = 0;
    for (let i = 0; i < bottles.length; i++) {
      if (excludedSet && excludedSet.has(i)) continue;
      const b = bottles[i];
      for (let li = 0; li < b.length; li++) {
        const c = b[li];
        if ((c >= 0 ? c : -c - 1) === color) total++;
      }
    }
    return total === bottleLen;
  }

  /** 通关：普通/混合关 = 所有颜色完成分装 且 场上无剩余层（防拆色假通关，PRD-混合容量瓶 §2；
   *  普通关语义等价——completed=colorCount 时场上必然已清空，零回归）；
   *  特殊关 = 大瓶装满且纯色（R3，装满即集齐） */
  isWin() {
    if (this.special === 'bigBottle') {
      const big = this.bottles[this.bigIndex];
      return big.length === this.bigCapacity && big.every((c) => c === big[0]);
    }
    return (
      this.completed.length >= this.colorCount &&
      this.bottles.every((b, i) => this.removed.has(i) || b.length === 0)
    );
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
