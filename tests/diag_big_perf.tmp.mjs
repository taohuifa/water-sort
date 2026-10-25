/**
 * // DIAG（临时脚本，S-05 性能实测用，测完即删）
 * 特殊关 L10/L20/L30 发牌+求解耗时实测（PC · Node）。
 * 预算：目标 <500ms / 硬顶 2s；超线按梯度 bigCapacity 8→6、colors 6→5 降级。
 */
import { readFileSync } from 'node:fs';
import GameLogic from '../js/core/game.js';
import { buildLevelsFromConfig, parseJsonc } from '../js/core/levels.js';

const curve = parseJsonc(readFileSync(new URL('../assets/config/levels.json', import.meta.url), 'utf8'));
const LEVELS = buildLevelsFromConfig(curve);

console.log('== S-05 特殊关性能实测（DIAG） ==');
let allOk = true;
for (const i of [9, 19, 29]) {
  const cfg = LEVELS[i];
  // 每关跑 3 次取最坏值（首次含 JIT 预热）
  const times = [];
  let solvable = true;
  for (let r = 0; r < 3; r++) {
    const logic = new GameLogic();
    const t0 = performance.now();
    logic.loadLevel(cfg);
    times.push(performance.now() - t0);
    if (!logic.lastGenSolvable) solvable = false;
    if (r === 2) {
      // 结构自检：大瓶末位且空；目标色 bigCapacity 层；干扰色 capacity 层
      const normals = logic.bottles.slice(0, -1);
      const big = logic.bottles[logic.bigIndex];
      console.log(
        `  L${i + 1}: colors=${cfg.colors} cap=${cfg.capacity} big=${cfg.bigCapacity} ` +
          `普通瓶=${normals.length} 总瓶=${logic.bottles.length} 大瓶层数=${big.length}`
      );
      const count = new Array(cfg.colors).fill(0);
      for (const b of normals) for (const c of b) count[c]++;
      const targetColors = count.filter((n) => n === cfg.bigCapacity).length;
      const others = count.filter((n) => n === cfg.capacity).length;
      console.log(
        `    每色总量分布: ${count.join(',')} → 目标色种数=${targetColors}（应=1）干扰色种数=${others}（应=${cfg.colors - 1}）`
      );
      if (targetColors !== 1 || others !== cfg.colors - 1) {
        allOk = false;
        console.log('    !! 每色总量分布异常');
      }
    }
  }
  const worst = Math.max(...times);
  const ok = solvable && worst < 2000;
  if (!ok || worst > 500) allOk = false;
  console.log(
    `  L${i + 1} 耗时: 3次=[${times.map((t) => t.toFixed(1)).join(', ')}]ms 最坏=${worst.toFixed(1)}ms ` +
      `可解=${solvable} → ${worst < 500 ? '达标(<500ms)' : worst < 2000 ? '超目标但<2s' : '!!超硬顶'}`
  );
}
console.log(allOk ? '== 全部达标（<500ms） ==' : '== 存在超线项，需按降级梯度调整 ==');
process.exit(allOk ? 0 : 1);
