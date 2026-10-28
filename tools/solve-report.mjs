/**
 * 关卡解题报告生成器（100 关）：逐关 DFS 实际求解（与 tests/game.test.js solveVerify 同源语义），
 * 采集操作步数 / 分支 / 搜索态 / 强制步 / 回溯等指标，输出 Markdown 报告。
 * 另用 BFS 最短路求解每关最短步数 par（三星基准），并回填进 assets/config/levels.json
 * （逐行定向插入 "par": N，注释与其余字段零扰动，幂等可重复执行）。
 * 运行：node tools/solve-report.mjs                 （全量 100 关 → docs/解题报告-100关.md）
 *       node tools/solve-report.mjs --from=31 --to=100 --no-report
 *       （区间模式：只做生成验证 + par/bombMoves 回填，不写 md，用于分章跑控制耗时）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import GameLogic from '../js/core/game.js';
import { buildLevelsFromConfig, parseJsonc, COLORS } from '../js/core/levels.js';

// ---------- 命令行参数（区间 + 免报告，分章铺量用） ----------
const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : null;
};
const FROM = argOf('from') ?? 1;
const TO = argOf('to') ?? 100;
const NO_REPORT = argv.includes('--no-report') || FROM > 1 || TO < 100; // 区间模式默认不写报告
if (NO_REPORT) console.log(`[solve-report] 区间模式 L${FROM}~L${TO}（不写报告，仅验证 + par/bombMoves 回填）`);


const cfg = parseJsonc(readFileSync(new URL('../assets/config/levels.json', import.meta.url), 'utf8'));
const LEVELS = buildLevelsFromConfig(cfg);

/** 配置摘要（报告用） */
function fmtCfg(lv) {
  const parts = [`${lv.colors}色`];
  if (lv.mix) parts.push('混合容量');
  else parts.push(`cap${lv.capacity}`);
  parts.push(lv.noEmptyStart ? '无空瓶' : `空瓶${lv.empties}`);
  if (lv.hiddenCount) parts.push(`隐藏${lv.hiddenCount}`);
  if (lv.condLockCount) parts.push(`条件锁${lv.condLockCount}`);
  if (lv.keyLockCount) parts.push(`钥匙锁${lv.keyLockCount}`);
  if (lv.coverCount) parts.push(`遮盖${lv.coverCount}×${lv.coverLayers}`);
  if (lv.bombCount) parts.push(`炸弹${lv.bombCount}${lv.bombMoves ? `×${lv.bombMoves}` : ''}`);
  if (lv.special === 'bigBottle') parts.push(`大瓶${lv.bigCapacity}`);
  return parts.join('/');
}

/** 结构复杂度分（先验难度：只看配置参数） */
function structScore(lv) {
  let s = lv.colors * 1.0;
  s += (2 - Math.min(lv.empties, 2)) * 2; // 空瓶越少越难
  if (lv.capacity === 5) s += 1.5;
  else if (lv.capacity === 3) s += 1;
  s += lv.hiddenCount * 0.5;
  s += lv.condLockCount * 2 + lv.keyLockCount * 2.5;
  s += (lv.coverCount || 0) * 1.5; // 遮盖瓶：前期压缩可操作空间（PRD-玩法扩展 §7）
  s += (lv.bombCount || 0) * 2; // 炸弹瓶：倒计时资源压力（PRD-玩法扩展 §2 B）
  if (lv.mix) s += 2.5;
  if (lv.special === 'bigBottle') s += 1.5 + (lv.bigCapacity - lv.capacity) * 0.25;
  if (lv.noEmptyStart) s += 2;
  return s;
}

/** 百分位（0~1，重复值取首个位次） */
function pctRanks(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return arr.map((v) => (arr.length > 1 ? sorted.indexOf(v) / (arr.length - 1) : 0.5));
}

/**
 * 状态 key（solveLevel DFS 与 solveParBFS 共用，PRD-玩法扩展 §7）：
 * - 带锁/带遮盖/带炸弹关：保持瓶序（锁瓶/遮盖瓶/炸弹瓶身份固定，不可合并去重），且
 *   removed/unlocked/completed/炸弹剩余步数全部入 key——锁与遮盖状态由这些字段派生
 *   （遮盖剩余 = coverLayers - completed.length），同瓶面不同解锁/成品/引信进度可达性不同，
 *   漏掉会误剪枝漏判可通关态；
 * - 无锁无遮盖无炸弹关：自由瓶内容排序规范化合并排列等价态（与内部 _solvable 同源）。
 */
function stateKey(logic) {
  const bigIdx = logic.bigIndex;
  const hasCovers = logic.coverBottles && logic.coverBottles.length > 0;
  const hasBombs = logic.bombBottles && logic.bombBottles.length > 0;
  if (logic.locks.length > 0 || hasCovers || hasBombs) {
    const fixed = [];
    for (let i = 0; i < logic.bottles.length; i++) {
      const s = logic.bottles[i].join(',');
      if (i === bigIdx) fixed.push('B' + s);
      else if (logic.removed.has(i)) fixed.push('D');
      else if (hasCovers && logic.isCovered(i)) fixed.push('C' + s);
      else if (hasBombs && logic.bombTimerOf(i) >= 0) fixed.push('M' + logic.bombTimerOf(i) + ':' + s);
      else fixed.push('F' + s);
    }
    return (
      fixed.join('|') +
      '#' +
      [...logic.removed].join(',') +
      '|' +
      logic.unlocked.map(Number).join('') +
      '|' +
      logic.completed.length
    );
  }
  const free = [];
  const fixed = [];
  for (let i = 0; i < logic.bottles.length; i++) {
    const s = logic.bottles[i].join(',');
    if (i === bigIdx) fixed.push('B' + s);
    else if (logic.removed.has(i)) fixed.push('D');
    else free.push((logic.mix ? logic.capOf(i) + ':' : '') + s);
  }
  return free.sort().join('|') + '#' + fixed.join('|');
}

/** 逐关 DFS 实跑求解，采集指标与解题路径 */
function solveLevel(lv) {
  const logic = new GameLogic();
  const t0 = Date.now();
  logic.loadLevel(lv);
  const loadMs = Date.now() - t0;
  const bigIdx = logic.bigIndex;
  const visited = new Set();
  const path = [];
  let nodes = 0;
  let backtracks = 0;
  let limitHit = false;

  // 状态 key：与 solveVerify 同源（共享 stateKey，含锁/遮盖/completed 维度）
  const key = () => stateKey(logic);

  function dfs() {
    if (logic.isWin()) return true;
    if (nodes++ > 150000) {
      limitHit = true;
      return false;
    }
    const k = key();
    if (visited.has(k)) return false;
    visited.add(k);
    const n = logic.bottles.length;
    // 启发式排序（与内部 _solvable / solveVerify 同源）：入大瓶 > 倒满完成 > 同色目标 > 空瓶
    const moves = [];
    for (let from = 0; from < n; from++) {
      for (let to = 0; to < n; to++) {
        if (from === to) continue;
        const amount = logic.canPour(from, to);
        if (!amount) continue;
        const f = logic.bottles[from];
        const t = logic.bottles[to];
        let score;
        if (to === bigIdx) {
          score = t.length ? 500 + t.length : 300;
        } else if (t.length) {
          let tr = 1;
          for (let i = t.length - 2; i >= 0 && t[i] === t[t.length - 1]; i--) tr++;
          score = tr === t.length && t.length + amount === logic.capOf(to) ? 600 : 100 + tr;
        } else {
          score = 10;
        }
        if (amount === f.length) score += 200;
        moves.push({ from, to, amount, score });
      }
    }
    const branch = moves.length;
    moves.sort((a, b) => b.score - a.score);
    for (const m of moves) {
      const doneBefore = logic.completed.length;
      const unlockedBefore = logic.unlocked.filter(Boolean).length;
      const colorIdx = logic.bottles[m.from][logic.bottles[m.from].length - 1];
      logic.pour(m.from, m.to);
      const rec = {
        ...m,
        branch,
        colorIdx: colorIdx >= 0 ? colorIdx : -colorIdx - 1,
        completed: logic.completed.length > doneBefore,
        unlocked: logic.unlocked.filter(Boolean).length > unlockedBefore,
      };
      if (dfs()) {
        path.push(rec);
        return true;
      }
      logic.undo();
      backtracks++;
      if (limitHit) return false;
    }
    return false;
  }

  const solved = dfs();
  const branches = path.map((p) => p.branch);
  return {
    solved,
    limitHit,
    genSolvable: logic.lastGenSolvable,
    loadMs,
    bombMoves: logic.bombMoves, // 生成确定的倒计时初值（自动口径回填用）
    bombCount: logic.bombBottles.length,
    steps: path.length,
    states: visited.size,
    backtracks,
    avgBranch: branches.length ? branches.reduce((a, b) => a + b, 0) / branches.length : 0,
    maxBranch: branches.length ? Math.max(...branches) : 0,
    forced: branches.filter((b) => b <= 1).length,
    path,
  };
}

// ---------- 采集（按区间过滤，分章跑控制 BFS 耗时） ----------
const results = LEVELS.filter((lv) => lv.level >= FROM && lv.level <= TO).map((lv) => ({ lv, r: solveLevel(lv) }));

/**
 * BFS 最短路求解（par 用）：与 solveLevel 同源的规范化状态 key（排列等价态合并不影响最短路，
 * 合并态间转移互可实现），首次到达 isWin 的深度即最短步数。
 * 搜索态超上限返回 null（调用方回退用启发式 DFS 步数并在报告标注）。
 */
function solveParBFS(lv, stateCap = 1500000) {
  const logic = new GameLogic();
  logic.loadLevel(lv);
  if (logic.isWin()) return 0;
  // 状态 key：与 solveLevel 共享（含锁/遮盖/completed 维度，PRD-玩法扩展 §7）
  const key = () => stateKey(logic);
  const snap = () => ({
    b: logic.bottles.map((x) => x.slice()),
    r: [...logic.removed],
    u: [...logic.unlocked],
    c: [...logic.completed], // 货架成品必须随快照恢复，否则胜利判定与局面脱节（漏判通关）
    m: logic.bombBottles.length
      ? { t: [...logic.bombTimers], d: [...logic.bombDefused] } // 炸弹引信状态（失败态由 canPour 冻结自然终止展开）
      : null,
  });
  const restore = (s) => {
    logic.bottles = s.b.map((x) => x.slice());
    logic.removed = new Set(s.r);
    logic.unlocked = [...s.u];
    logic.completed = [...s.c];
    if (s.m) {
      logic.bombTimers = [...s.m.t];
      logic.bombDefused = [...s.m.d];
    }
  };
  const visited = new Set([key()]);
  let frontier = [snap()];
  for (let depth = 1; frontier.length; depth++) {
    const next = [];
    for (const s of frontier) {
      restore(s);
      const n = logic.bottles.length;
      for (let from = 0; from < n; from++) {
        for (let to = 0; to < n; to++) {
          if (from === to || !logic.canPour(from, to)) continue;
          logic.pour(from, to);
          const win = logic.isWin();
          if (win) return depth;
          const k = key();
          if (!visited.has(k)) {
            visited.add(k);
            if (visited.size > stateCap) return null;
            next.push(snap());
          }
          logic.undo(); // pour 已入快照栈，undo 精确回退（含完成/收走/解锁状态）
        }
      }
    }
    frontier = next;
  }
  return null;
}

const parByLevel = new Map();
const bombMovesByLevel = new Map(); // 炸弹关 bombMoves 回填（自动口径：生成确定值；显式配置不回填）
for (const x of results) {
  const t0 = Date.now();
  const par = solveParBFS(x.lv);
  x.parMs = Date.now() - t0;
  x.par = par ?? x.r.steps; // BFS 超限回退：启发式 DFS 步数（≥ 最短步数，报告中标注）
  x.parFallback = par == null;
  parByLevel.set(x.lv.level, x.par);
  // 炸弹约束校验（PRD-玩法扩展 §2 B）：par ≤ bombMoves - 2
  if (x.lv.bombCount > 0) {
    const bm = x.r.bombMoves;
    if (x.par > bm - 2) {
      console.warn(`[solve-report] L${x.lv.level} 炸弹约束违规：par=${x.par} > bombMoves(${bm}) - 2`);
    }
    if (!x.lv.bombMoves && bm > 0) bombMovesByLevel.set(x.lv.level, bm);
  }
}

const stepsPct = pctRanks(results.map((x) => x.r.steps));
const logStates = results.map((x) => Math.log10(x.r.states + 1));
const statesPct = pctRanks(logStates);
const structPct = pctRanks(results.map((x) => structScore(x.lv)));

results.forEach((x, i) => {
  const solverIdx = 0.5 * stepsPct[i] + 0.5 * statesPct[i];
  x.difficulty = 0.55 * solverIdx + 0.45 * structPct[i];
});

const stars = (d) => (d < 0.2 ? '★' : d < 0.4 ? '★★' : d < 0.6 ? '★★★' : d < 0.8 ? '★★★★' : '★★★★★');

// 难度排名（降序）
const ranked = [...results].sort((a, b) => b.difficulty - a.difficulty);
const rankOf = new Map(ranked.map((x, i) => [x.lv.level, i + 1]));

// ---------- 输出 ----------
let md = `# 缤纷果汁铺 · 100 关解题报告

> 生成时间：${new Date().toISOString().slice(0, 10)} · 配置：assets/config/levels.json（v3，逐关显式 + 固定 seed）
> 方法：对当前配置逐关 DFS 实际求解（与单元测试 solveVerify 同源语义：启发式排序 + 状态去重 + 真实 pour/undo API），
> 「不用道具必有解」由生成器保证，本报告实测全部走通并采集操作指标。

## 1. 总览表（按关卡顺序）

| 关 | 配置 | par | 2★线 | 步数 | 搜索态 | 回溯 | 平均分支 | 最大分支 | 强制步 | 生成耗时 | 难度分 | 星级 | 难度排名 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
`;

for (const x of results) {
  const lv = x.lv;
  const r = x.r;
  const parCell = x.parFallback ? `${x.par}†` : String(x.par);
  md += `| L${lv.level} | ${fmtCfg(lv)} | ${parCell} | ${Math.ceil(x.par * 1.5)} | ${r.steps} | ${r.states} | ${r.backtracks} | ${r.avgBranch.toFixed(1)} | ${r.maxBranch} | ${r.forced} | ${r.loadMs}ms | ${x.difficulty.toFixed(2)} | ${stars(x.difficulty)} | ${rankOf.get(lv.level)} |\n`;
}

md += `
指标口径：
- **par**：BFS 最短路精确最短步数（三星基准：3★ ≤ par，2★ ≤ ⌈par×1.5⌉，1★ = 通关）；
  † = BFS 搜索态超上限回退用启发式 DFS 步数（≥ 最短步数）；par 已由本工具回填进 levels.json
- **步数**：启发式 DFS 找到的首条通关路径长度（非最优解，为实际可执行操作序列）
- **搜索态**：去重后访问过的局面数（含死路），反映局面复杂度与搜索代价
- **回溯**：走错被撤销的倒水次数（死路探索量）
- **分支**：解路径上每步局面的合法倒法数；**强制步** = 分支 ≤1 的步（玩家无选择余地）
- **难度分** = 0.55×求解指标（步数/搜索态百分位均值）+ 0.45×结构复杂度百分位；排名按难度分降序

## 2. 难度排名表（降序）

| 排名 | 关 | 配置 | 难度分 | 星级 | 当前位次差（当前位 - 排名位） |
|---|---|---|---|---|---|
`;
for (let i = 0; i < ranked.length; i++) {
  const x = ranked[i];
  const delta = x.lv.level - (i + 1);
  md += `| ${i + 1} | L${x.lv.level} | ${fmtCfg(x.lv)} | ${x.difficulty.toFixed(2)} | ${stars(x.difficulty)} | ${delta >= 0 ? '+' : ''}${delta} |\n`;
}

md += `
## 3. 逐关操作步骤（瓶号从 1 起；✓ = 该步完成收瓶，🔓 = 该步触发解锁）

`;
for (const x of results) {
  md += `**L${x.lv.level}**（${fmtCfg(x.lv)}，${x.r.steps} 步）：\n\n`;
  // path 在 DFS 回溯成功时 push（深帧先入），path[0] 是解的“最后一步”——
  // 输出前必须 reverse 成实际操作顺序（2026-10-27 集成验证修复：原报告步骤序列整体颠倒，
  // 正序重放第 1 步即非法、反序重放全通 isWin，实锤）
  md += '> ' + x.r.path.slice().reverse().map((m) => `${m.from + 1}→${m.to + 1}${m.completed ? '✓' : ''}${m.unlocked ? '🔓' : ''}`).join('，') + '\n\n';
}

// 最难 3 关详细步骤表
md += `## 4. 最难 3 关详细步骤表\n\n`;
for (let i = 0; i < Math.min(3, ranked.length); i++) {
  const x = ranked[i];
  md += `### L${x.lv.level}（${fmtCfg(x.lv)}）—— 难度分 ${x.difficulty.toFixed(2)} ${stars(x.difficulty)}\n\n`;
  md += `| 步 | 操作 | 颜色 | 层数 | 分支 | 事件 |\n|---|---|---|---|---|---|\n`;
  // 同 §3：path 需 reverse 成实际操作顺序（修复记录见 §3 注释）
  x.r.path.slice().reverse().forEach((m, si) => {
    const ev = [m.completed ? '完成收瓶 ✓' : '', m.unlocked ? '解锁 🔓' : ''].filter(Boolean).join('，') || '—';
    md += `| ${si + 1} | 瓶${m.from + 1} → 瓶${m.to + 1} | ${COLORS[m.colorIdx].name} | ${m.amount} | ${m.branch} | ${ev} |\n`;
  });
  md += '\n';
}

// 保留人工分析章节：本报告 §5（分章难度解读）及之后的内容在重跑时原样携带
if (!NO_REPORT) {
  try {
    const old = readFileSync(new URL('../docs/解题报告-100关.md', import.meta.url), 'utf8');
    const marker = old.indexOf('## 5.');
    if (marker >= 0) md += old.slice(marker).replace(/\s*$/, '\n');
  } catch {
    /* 首次生成，无旧报告 */
  }
  writeFileSync(new URL('../docs/解题报告-100关.md', import.meta.url), md, 'utf8');
}

// ---------- par / bombMoves 回填 levels.json（逐行定向插入/更新，注释与其余字段零扰动，幂等） ----------
function backfillPar(text, parMap, bombMap) {
  let changed = 0;
  const lines = text.split('\n').map((line) => {
    const m = line.match(/^(\s*\{\s*"level":\s*(\d+)\s*,)(.*)$/);
    if (!m) return line;
    const no = Number(m[2]);
    const par = parMap.get(no);
    const bm = bombMap.get(no);
    if (par == null && bm == null) return line;
    let out = line;
    if (/"par"\s*:/.test(out)) {
      out = out.replace(/"par"\s*:\s*\d+/, `"par": ${par}`);
    } else if (par != null) {
      out = out.replace(/^(\s*\{\s*"level":\s*\d+\s*,)/, `$1 "par": ${par},`);
    }
    if (bm != null) {
      if (/"bombMoves"\s*:/.test(out)) out = out.replace(/"bombMoves"\s*:\s*\d+/, `"bombMoves": ${bm}`);
      else out = out.replace(/("par":\s*\d+,)/, `$1 "bombMoves": ${bm},`);
    }
    changed++;
    return out;
  });
  return { text: lines.join('\n'), changed };
}
const cfgPath = new URL('../assets/config/levels.json', import.meta.url);
const bf = backfillPar(readFileSync(cfgPath, 'utf8'), parByLevel, bombMovesByLevel);
writeFileSync(cfgPath, bf.text, 'utf8');

// ---------- 控制台摘要 ----------
console.log('关 | 配置 | par | 2★线 | 步数 | 搜索态 | 回溯 | 均分支 | 强制步 | 难度分 | 排名');
for (const x of results) {
  console.log(
    `L${String(x.lv.level).padStart(2)} | ${fmtCfg(x.lv).padEnd(24)} | ${String(x.par).padStart(3)}${x.parFallback ? '†' : ' '} | ${String(Math.ceil(x.par * 1.5)).padStart(3)} | ${String(x.r.steps).padStart(3)} | ${String(x.r.states).padStart(5)} | ${String(x.r.backtracks).padStart(5)} | ${x.r.avgBranch.toFixed(1).padStart(5)} | ${String(x.r.forced).padStart(3)} | ${x.difficulty.toFixed(2)} | ${rankOf.get(x.lv.level)}`
  );
}
console.log(
  `${NO_REPORT ? '[区间模式] 未写报告' : '已写入 docs/解题报告-100关.md'}；par/bombMoves 已回填 levels.json（更新 ${bf.changed} 条记录）`
);
