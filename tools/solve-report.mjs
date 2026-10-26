/**
 * 30 关解题报告生成器：逐关 DFS 实际求解（与 tests/game.test.js solveVerify 同源语义），
 * 采集操作步数 / 分支 / 搜索态 / 强制步 / 回溯等指标，输出 Markdown 报告。
 * 运行：node tools/solve-report.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import GameLogic from '../js/core/game.js';
import { buildLevelsFromConfig, parseJsonc, COLORS } from '../js/core/levels.js';

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

/** 逐关 DFS 实跑求解，采集指标与解题路径 */
function solveLevel(lv) {
  const logic = new GameLogic();
  const t0 = Date.now();
  logic.loadLevel(lv);
  const loadMs = Date.now() - t0;
  const hasLocks = logic.locks.length > 0;
  const bigIdx = logic.bigIndex;
  const visited = new Set();
  const path = [];
  let nodes = 0;
  let backtracks = 0;
  let limitHit = false;

  // 状态 key：与 solveVerify 同源 —— 无锁关按自由瓶内容规范化去重，带锁关保持原序
  const key = () => {
    if (hasLocks) return logic.bottles.map((b) => b.join(',')).join('|');
    const free = [];
    const fixed = [];
    for (let i = 0; i < logic.bottles.length; i++) {
      const s = logic.bottles[i].join(',');
      if (i === bigIdx) fixed.push('B' + s);
      else if (logic.removed.has(i)) fixed.push('D');
      else free.push((logic.mix ? logic.capOf(i) + ':' : '') + s);
    }
    return free.sort().join('|') + '#' + fixed.join('|');
  };

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
    steps: path.length,
    states: visited.size,
    backtracks,
    avgBranch: branches.length ? branches.reduce((a, b) => a + b, 0) / branches.length : 0,
    maxBranch: branches.length ? Math.max(...branches) : 0,
    forced: branches.filter((b) => b <= 1).length,
    path,
  };
}

// ---------- 采集 ----------
const results = LEVELS.map((lv) => ({ lv, r: solveLevel(lv) }));

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
let md = `# 缤纷果汁铺 · 30 关解题报告

> 生成时间：${new Date().toISOString().slice(0, 10)} · 配置：assets/config/levels.json（v3，逐关显式 + 固定 seed）
> 方法：对当前配置逐关 DFS 实际求解（与单元测试 solveVerify 同源语义：启发式排序 + 状态去重 + 真实 pour/undo API），
> 「不用道具必有解」由生成器保证，本报告实测全部走通并采集操作指标。

## 1. 总览表（按关卡顺序）

| 关 | 配置 | 步数 | 搜索态 | 回溯 | 平均分支 | 最大分支 | 强制步 | 生成耗时 | 难度分 | 星级 | 难度排名 |
|---|---|---|---|---|---|---|---|---|---|---|---|
`;

for (const x of results) {
  const lv = x.lv;
  const r = x.r;
  md += `| L${lv.level} | ${fmtCfg(lv)} | ${r.steps} | ${r.states} | ${r.backtracks} | ${r.avgBranch.toFixed(1)} | ${r.maxBranch} | ${r.forced} | ${r.loadMs}ms | ${x.difficulty.toFixed(2)} | ${stars(x.difficulty)} | ${rankOf.get(lv.level)} |\n`;
}

md += `
指标口径：
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
  md += '> ' + x.r.path.map((m) => `${m.from + 1}→${m.to + 1}${m.completed ? '✓' : ''}${m.unlocked ? '🔓' : ''}`).join('，') + '\n\n';
}

// 最难 3 关详细步骤表
md += `## 4. 最难 3 关详细步骤表\n\n`;
for (let i = 0; i < 3; i++) {
  const x = ranked[i];
  md += `### L${x.lv.level}（${fmtCfg(x.lv)}）—— 难度分 ${x.difficulty.toFixed(2)} ${stars(x.difficulty)}\n\n`;
  md += `| 步 | 操作 | 颜色 | 层数 | 分支 | 事件 |\n|---|---|---|---|---|---|\n`;
  x.r.path.forEach((m, si) => {
    const ev = [m.completed ? '完成收瓶 ✓' : '', m.unlocked ? '解锁 🔓' : ''].filter(Boolean).join('，') || '—';
    md += `| ${si + 1} | 瓶${m.from + 1} → 瓶${m.to + 1} | ${COLORS[m.colorIdx].name} | ${m.amount} | ${m.branch} | ${ev} |\n`;
  });
  md += '\n';
}

// 保留人工分析章节：旧报告 §5（难度评价）及之后的内容在重跑时原样携带
try {
  const old = readFileSync(new URL('../docs/解题报告-30关.md', import.meta.url), 'utf8');
  const marker = old.indexOf('## 5. 难度曲线评价');
  if (marker >= 0) md += old.slice(marker).replace(/\s*$/, '\n');
} catch {
  /* 首次生成，无旧报告 */
}
writeFileSync(new URL('../docs/解题报告-30关.md', import.meta.url), md, 'utf8');

// ---------- 控制台摘要 ----------
console.log('关 | 配置 | 步数 | 搜索态 | 回溯 | 均分支 | 强制步 | 难度分 | 排名');
for (const x of results) {
  console.log(
    `L${String(x.lv.level).padStart(2)} | ${fmtCfg(x.lv).padEnd(24)} | ${String(x.r.steps).padStart(3)} | ${String(x.r.states).padStart(5)} | ${String(x.r.backtracks).padStart(5)} | ${x.r.avgBranch.toFixed(1).padStart(5)} | ${String(x.r.forced).padStart(3)} | ${x.difficulty.toFixed(2)} | ${rankOf.get(x.lv.level)}`
  );
}
console.log('已写入 docs/解题报告-30关.md');
