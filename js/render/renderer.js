import { COLORS, LEVELS } from '../core/levels.js';

/**
 * 渲染层：Canvas 2D 绘制所有内容 —— 背景、吧台货架、玻璃瓶与液体分层、
 * 选中态、倒水流线、成品饮料、底部操作栏、通关面板。
 * 只读逻辑层数据，不做任何游戏规则判断。
 */
export default class Renderer {
  constructor(ctx, screenW, screenH) {
    this.ctx = ctx;
    this.W = screenW;
    this.H = screenH;
    this.bottleRects = [];
    this.displayedCompleted = 0; // 货架上已显示的成品数（飞行动画落地后才 +1）
    this.layoutUI();
  }

  /** UI 固定区域（按钮 / 货架 / 面板） */
  layoutUI() {
    const W = this.W;
    this.undoBtn = { x: W / 2 - 100, y: this.H - 86, r: 30 };
    this.restartBtn = { x: W / 2 + 100, y: this.H - 86, r: 30 };
    this.nextBtn = { x: W / 2 - 80, y: this.H / 2 + 42, w: 160, h: 48 };
    this.shelf = {
      boardX: 24,
      boardW: W - 48,
      rowY: [128, 204],
      slotW: 56,
      perRow: 4,
    };
  }

  /** 每关根据瓶数计算瓶子网格布局 */
  setupBoard(bottleCount) {
    const n = bottleCount;
    const cols = Math.max(2, Math.ceil(n / 2));
    const rows = Math.ceil(n / cols);
    const margin = 18;
    const gapX = 12;
    const gapY = 30;
    const playTop = 252;
    const playBottom = this.H - 128;
    const availW = this.W - margin * 2;
    const availH = playBottom - playTop;

    let bw = Math.min(66, (availW - (cols - 1) * gapX) / cols);
    let bh = bw * 1.28;
    const needH = rows * bh + (rows - 1) * gapY;
    if (needH > availH) {
      bh = (availH - (rows - 1) * gapY) / rows;
      bw = bh / 1.28;
    }
    const gridW = cols * bw + (cols - 1) * gapX;
    const gridH = rows * bh + (rows - 1) * gapY;
    const startX = (this.W - gridW) / 2;
    const startY = playTop + (availH - gridH) / 2;

    this.bottleRects = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      this.bottleRects.push({
        x: startX + c * (bw + gapX),
        y: startY + r * (bh + gapY),
        w: bw,
        h: bh,
      });
    }
  }

  bottleRect(idx) {
    return this.bottleRects[idx];
  }

  /** 货架第 slot 个成品的落点（杯底中心） */
  shelfSlotPos(slot) {
    const s = this.shelf;
    const row = Math.floor(slot / s.perRow);
    const col = slot % s.perRow;
    const x = s.boardX + 16 + col * s.slotW + s.slotW / 2;
    const y = s.rowY[Math.min(row, s.rowY.length - 1)];
    return { x, y };
  }

  getBottleAt(px, py) {
    for (let i = 0; i < this.bottleRects.length; i++) {
      const r = this.bottleRects[i];
      if (px >= r.x - 6 && px <= r.x + r.w + 6 && py >= r.y - 16 && py <= r.y + r.h + 8) {
        return i;
      }
    }
    return -1;
  }

  inCircle(px, py, c) {
    return c && (px - c.x) ** 2 + (py - c.y) ** 2 <= c.r * c.r;
  }

  inRect(px, py, r) {
    return r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  // ---------- 主绘制 ----------

  draw(state) {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.W, this.H);
    this.drawBackground();
    this.drawTopBar(state);
    this.drawShelf(state);
    this.drawBottles(state);
    this.drawBottomBar(state);
    if (state.stuck && !state.winPanel && !state.anims.blocking()) {
      this.drawStuckTip();
    }
    if (state.winPanel) this.drawWinPanel(state);
  }

  drawBackground() {
    const { ctx } = this;
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, '#FFF6E8');
    g.addColorStop(0.55, '#FFEFD9');
    g.addColorStop(1, '#FBE3C4');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);
    // 顶部装饰横幅
    ctx.fillStyle = 'rgba(255, 152, 56, 0.14)';
    ctx.fillRect(0, 0, this.W, 56);
  }

  drawTopBar(state) {
    const { ctx } = this;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#B0793B';
    ctx.textAlign = 'center';
    ctx.font = 'bold 19px sans-serif';
    ctx.fillText('缤纷果汁铺', this.W / 2, 30);
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#9C7A52';
    ctx.fillText(`第 ${state.levelIndex + 1} / ${LEVELS.length} 关`, 16, 82);
    ctx.textAlign = 'right';
    ctx.fillText(`步数 ${state.logic.moveCount}`, this.W - 16, 82);
    ctx.textBaseline = 'alphabetic';
  }

  drawShelf(state) {
    const { ctx } = this;
    const s = this.shelf;
    for (const rowY of s.rowY) {
      ctx.fillStyle = '#C08A57';
      this.rr(s.boardX, rowY, s.boardW, 9, 4.5);
      ctx.fill();
      ctx.fillStyle = 'rgba(122, 78, 40, 0.28)';
      ctx.fillRect(s.boardX + 6, rowY + 9, s.boardW - 12, 3);
    }
    // 已完成的成品饮料
    for (let i = 0; i < this.displayedCompleted; i++) {
      const p = this.shelfSlotPos(i);
      this.drawDrink(p.x, p.y, state.logic.completed[i]);
    }
    // 飞行中的成品
    for (const a of state.anims.list) {
      if (a.type !== 'fly') continue;
      const t = a.t;
      const target = this.shelfSlotPos(a.slot);
      const x = a.x0 + (target.x - a.x0) * t;
      const y = a.y0 + (target.y - a.y0) * t - Math.sin(Math.PI * t) * 70;
      const scale = 1 + 0.25 * Math.sin(Math.PI * t);
      this.drawDrink(x, y, a.color, scale);
    }
  }

  /** 货架上的成品饮料：果汁杯 + 奶盖 + 吸管 */
  drawDrink(x, y, colorId, scale = 1) {
    const { ctx } = this;
    const color = COLORS[colorId] ? COLORS[colorId].main : '#999';
    const w = 26 * scale;
    const h = 36 * scale;
    ctx.save();
    ctx.translate(x, y);
    // 杯身
    ctx.fillStyle = color;
    this.rr(-w / 2, -h, w, h, 5 * scale);
    ctx.fill();
    // 奶盖
    ctx.fillStyle = '#FFFDF6';
    this.rr(-w / 2, -h, w, h * 0.3, 5 * scale);
    ctx.fill();
    // 吸管
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.moveTo(w * 0.12, -h + 2);
    ctx.lineTo(w * 0.34, -h - 9 * scale);
    ctx.stroke();
    ctx.restore();
  }

  drawBottles(state) {
    const { logic, selected, anims } = state;
    const pour = anims.activePour();

    for (let i = 0; i < logic.bottles.length; i++) {
      const rect = this.bottleRects[i];
      const flying = anims.flyOf(i);

      // 确定本帧显示的层数组（倒水动画期间的中间态）
      let layers;
      if (pour && pour.from === i) {
        const moved = anims.pourMoved(pour);
        layers = pour.fromContentBefore.slice(0, pour.fromContentBefore.length - moved);
      } else if (pour && pour.to === i) {
        const moved = anims.pourMoved(pour);
        layers = pour.toContentBefore.slice().concat(new Array(moved).fill(pour.color));
      } else {
        layers = logic.bottles[i];
      }

      let lift = selected === i ? 12 : 0;
      let angle = 0;
      if (pour && pour.from === i) {
        // 源瓶倒水：上浮 + 朝目标倾斜
        lift += 14 * Math.sin(Math.PI * Math.min(pour.t, 1));
        const toRect = this.bottleRects[pour.to];
        const dir = toRect.x + toRect.w / 2 < rect.x + rect.w / 2 ? -1 : 1;
        angle = dir * 0.42 * Math.sin(Math.PI * Math.min(pour.t, 1));
      }
      const shakeX = anims.shakeOffset(i);

      const cx = rect.x + rect.w / 2;
      const bottom = rect.y + rect.h;
      this.ctx.save();
      this.ctx.translate(cx + shakeX, bottom);
      this.ctx.rotate(angle);
      this.ctx.translate(-cx, -bottom);
      this.ctx.translate(0, -lift);
      this.drawBottle(rect, layers, selected === i, !!flying);
      this.ctx.restore();
    }

    // 倒水流线
    if (pour) {
      this.drawStream(pour, anims);
    }
  }

  /** 玻璃瓶 + 分层液体。layers: 颜色 ID 数组，index 0 为底层 */
  drawBottle(rect, layers, isSelected, ghost) {
    const { ctx } = this;
    const { x, y, w, h } = rect;
    const neckH = h * 0.14;
    const bodyY = y + neckH;
    const bodyH = h - neckH;
    const neckW = w * 0.46;
    const neckX = x + (w - neckW) / 2;

    // 液体（先画，被玻璃覆盖）
    if (layers.length) {
      const innerX = x + 3.5;
      const innerW = w - 7;
      const layerH = (bodyH - 7) / 4;
      const bottomY = bodyY + bodyH - 3.5;
      for (let i = 0; i < layers.length; i++) {
        const c = COLORS[layers[i]] ? COLORS[layers[i]].main : '#AAA';
        const ly = bottomY - (i + 1) * layerH;
        ctx.fillStyle = c;
        ctx.fillRect(innerX, ly, innerW, layerH + 0.6); // 微重叠防缝隙
      }
      // 顶层液面高光
      const topY = bottomY - layers.length * layerH;
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.beginPath();
      ctx.ellipse(x + w / 2, topY, innerW / 2, 2.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 玻璃瓶身
    ctx.lineWidth = 2;
    ctx.strokeStyle = isSelected ? '#FFB300' : 'rgba(255,255,255,0.88)';
    ctx.fillStyle = ghost ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.17)';
    this.rr(x, bodyY, w, bodyH, w * 0.22);
    ctx.fill();
    ctx.stroke();
    // 瓶颈
    this.rr(neckX, y, neckW, neckH + 5, 3.5);
    ctx.fill();
    ctx.stroke();
    // 瓶口
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + 1.5, neckW / 2, 3.2, 0, 0, Math.PI * 2);
    ctx.stroke();
    // 玻璃高光
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.2, bodyY + bodyH * 0.72);
    ctx.lineTo(x + w * 0.2, bodyY + bodyH * 0.3);
    ctx.stroke();
  }

  /** 倒水流线：源瓶口 → 目标瓶口的弧线 */
  drawStream(pour, anims) {
    const { ctx } = this;
    const t = Math.min(pour.t, 1);
    const alpha = Math.sin(Math.PI * t); // 起止淡入淡出
    if (alpha <= 0.02) return;
    const from = this.bottleRects[pour.from];
    const to = this.bottleRects[pour.to];
    const x0 = from.x + from.w / 2;
    const y0 = from.y - 24; // 源瓶口（含上浮与倾斜的近似位置）
    const x1 = to.x + to.w / 2;
    const y1 = to.y - 4;
    const my = Math.min(y0, y1) - 42;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = COLORS[pour.color] ? COLORS[pour.color].main : '#AAA';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo((x0 + x1) / 2, my, x1, y1);
    ctx.stroke();
    // 落点水花
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.ellipse(x1, y1 + 3, 7, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawBottomBar(state) {
    const { ctx } = this;
    const canUndo = state.logic.undoStack.length > 0;
    for (const [btn, label, enabled] of [
      [this.undoBtn, '撤回', canUndo],
      [this.restartBtn, '重开', true],
    ]) {
      ctx.save();
      ctx.globalAlpha = enabled ? 1 : 0.35;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.arc(btn.x, btn.y, btn.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#E8C9A0';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#8A6234';
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, btn.x, btn.y + 1);
      ctx.restore();
    }
    ctx.textBaseline = 'alphabetic';
  }

  drawStuckTip() {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(229, 57, 53, 0.92)';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('没有可行的倒法了，试试撤回或重开', this.W / 2, 236);
    ctx.restore();
  }

  drawWinPanel(state) {
    const { ctx } = this;
    const isLast = state.levelIndex >= LEVELS.length - 1;
    ctx.save();
    // 遮罩
    ctx.fillStyle = 'rgba(43, 28, 12, 0.55)';
    ctx.fillRect(0, 0, this.W, this.H);
    // 卡片
    const cw = 286;
    const ch = 236;
    const cx = (this.W - cw) / 2;
    const cy = (this.H - ch) / 2 - 30;
    ctx.fillStyle = '#FFF9F0';
    this.rr(cx, cy, cw, ch, 18);
    ctx.fill();
    // 文案
    ctx.textAlign = 'center';
    ctx.fillStyle = '#7A4E1D';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(isLast ? '恭喜全部通关！' : '关卡完成！', this.W / 2, cy + 58);
    ctx.font = '15px sans-serif';
    ctx.fillStyle = '#A3866A';
    ctx.fillText(`本关共 ${state.logic.moveCount} 步`, this.W / 2, cy + 92);
    // 按钮
    const b = this.nextBtn;
    b.x = (this.W - b.w) / 2;
    b.y = cy + 128;
    ctx.fillStyle = '#FF9838';
    this.rr(b.x, b.y, b.w, b.h, 24);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 18px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(isLast ? '重新开始' : '下一关', this.W / 2, b.y + b.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  /** 圆角矩形路径 */
  rr(x, y, w, h, r) {
    const { ctx } = this;
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
