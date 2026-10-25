import { COLORS } from '../core/levels.js';

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
    this.toast = null; // 顶部提示条 {text, expire}
    this.levelCount = 0; // 关卡总数（由入口注入，配置见 resources/levels.json）
    this.initSafeArea();
    this.layoutUI();
  }

  /** 顶部安全区：获取胶囊按钮位置，顶栏内容避开它（标题画在胶囊下方） */
  initSafeArea() {
    let capCenterY = 30; // 胶囊垂直中心（fallback：开发者工具默认位置）
    let capBottom = 56;
    try {
      if (typeof wx !== 'undefined' && wx.getMenuButtonBoundingClientRect) {
        const m = wx.getMenuButtonBoundingClientRect();
        if (m && m.height > 0) {
          capCenterY = m.top + m.height / 2;
          capBottom = m.bottom;
        }
      }
    } catch (e) {
      // 获取失败使用默认值
    }
    this.capCenterY = capCenterY;
    this.topSafe = capBottom + 8; // 胶囊下缘之下才是可安全绘制区
  }

  /** 设置关卡总数（入口加载 resources/levels.json 后注入） */
  setLevelCount(n) {
    this.levelCount = n;
  }

  /** UI 固定区域（按钮 / 货架 / 面板） */
  layoutUI() {
    const W = this.W;
    // 游戏页（返回按钮与右上角胶囊垂直居中对齐）
    this.backBtn = { x: 34, y: this.capCenterY, r: 18 };
    const btnY = this.H - 86;
    this.undoBtn = { x: W / 2 - 114, y: btnY, r: 28 };
    this.shuffleBtn = { x: W / 2 - 38, y: btnY, r: 28 };
    this.addBottleBtn = { x: W / 2 + 38, y: btnY, r: 28 };
    this.restartBtn = { x: W / 2 + 114, y: btnY, r: 28 };
    this.nextBtn = { x: W / 2 - 80, y: this.H / 2 + 42, w: 160, h: 48 };
    // 暂停浮层
    this.pauseResumeBtn = { x: W / 2 - 90, y: this.H / 2 - 44, w: 180, h: 48 };
    this.pauseExitBtn = { x: W / 2 - 90, y: this.H / 2 + 24, w: 180, h: 48 };
    // 菜单页
    this.menuPlayBtn = { x: W / 2 - 110, y: this.H * 0.52, w: 220, h: 56 };
    this.menuSettingsBtn = { x: W / 2 - 110, y: this.H * 0.52 + 76, w: 220, h: 56 };
    // 设置页
    this.settingsSoundToggle = { x: W / 2 + 30, y: this.H * 0.29, w: 52, h: 30 }; // 音效开关
    this.settingsResetBtn = { x: W / 2 - 110, y: this.H * 0.42, w: 220, h: 56 };
    // 广告补给确认浮层
    this.adConfirmWatchBtn = { x: W / 2 - 90, y: this.H / 2 - 44, w: 180, h: 48 };
    this.adConfirmCancelBtn = { x: W / 2 - 90, y: this.H / 2 + 24, w: 180, h: 48 };
    // 关卡选择页（卡片 rect 在 drawLevelSelect 中按关卡数计算）
    this.levelBtns = [];
    this.shelf = {
      boardX: 24,
      boardW: W - 48,
      rowY: [150, 218], // 首层须低于顶栏文字行（topSafe+44），避免遮挡
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

  getBottleAt(px, py, logic) {
    for (let i = 0; i < this.bottleRects.length; i++) {
      if (logic && logic.removed && logic.removed.has(i)) continue; // 已收走的瓶不可点击
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

  // ---------- 主绘制（按场景分发） ----------

  draw(state) {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.W, this.H);
    this.drawBackground();
    if (state.scene === 'menu') {
      this.drawMenu(state);
    } else if (state.scene === 'settings') {
      this.drawSettings(state);
    } else if (state.scene === 'levelSelect') {
      this.drawLevelSelect(state);
    } else {
      this.drawGame(state);
    }
    this.drawToast();
  }

  drawGame(state) {
    this.drawTopBar(state);
    this.drawShelf(state);
    this.drawBottles(state);
    this.drawBottomBar(state);
    if (state.stuck && !state.winPanel && !state.anims.blocking()) {
      this.drawStuckTip();
    }
    if (state.shuffleSelecting) this.drawShuffleHint();
    if (state.winPanel) this.drawWinPanel(state);
    else if (state.adConfirm) this.drawAdConfirm(state);
    else if (state.pauseOverlay) this.drawPauseOverlay();
  }

  /** 顶部提示条 */
  showToast(text) {
    this.toast = { text, expire: Date.now() + 1600 };
  }

  drawToast() {
    if (!this.toast || Date.now() > this.toast.expire) return;
    const { ctx } = this;
    const y = this.topSafe + 6; // 顶部安全区之下
    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = '#3E2A18';
    this.rr(this.W / 2 - 130, y, 260, 34, 17);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#FFF6E8';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.toast.text, this.W / 2, y + 18);
    ctx.restore();
  }

  /** 通用文字按钮 */
  drawTextButton(btn, label, style) {
    const { ctx } = this;
    ctx.fillStyle = style.fill;
    this.rr(btn.x, btn.y, btn.w, btn.h, Math.min(btn.h / 2, 24));
    ctx.fill();
    if (style.stroke) {
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = style.text;
    ctx.font = `bold ${style.size || 17}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, btn.x + btn.w / 2, btn.y + btn.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }

  /** 通用圆形小按钮（返回/图标） */
  drawCircleButton(btn, label, opts = {}) {
    const { ctx } = this;
    ctx.fillStyle = opts.fill || 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(btn.x, btn.y, btn.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = opts.stroke || '#E8C9A0';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = opts.text || '#8A6234';
    ctx.font = `bold ${opts.size || 15}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, btn.x, btn.y + 1);
    ctx.textBaseline = 'alphabetic';
  }

  // ---------- 菜单页 ----------

  drawMenu(state) {
    const { ctx } = this;
    // 标题
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8A5A22';
    ctx.font = 'bold 40px sans-serif';
    ctx.fillText('缤纷果汁铺', this.W / 2, this.H * 0.17);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#B98F5E';
    ctx.fillText('JuiceSort · 倒水排序', this.W / 2, this.H * 0.17 + 32);

    // 装饰瓶子
    const deco = [
      [[0, 0, 1, 1], null],
      [[2, 3, 2, 3], [4]],
      [[5, 6, 5, 6], [7]],
    ];
    const bw = 52;
    const bh = bw * 1.28;
    const gap = 26;
    const startX = this.W / 2 - ((deco.length * bw + (deco.length - 1) * gap) / 2);
    deco.forEach((d, i) => {
      const rect = {
        x: startX + i * (bw + gap),
        y: this.H * 0.24,
        w: bw,
        h: bh,
      };
      this.drawBottle(rect, d[0], false, false);
      if (d[1]) {
        const rect2 = { x: rect.x + rect.w / 2 - 13, y: rect.y + rect.h + 10, w: 26, h: 26 * 1.28 };
        this.drawBottle(rect2, d[1], false, false);
      }
    });

    // 开始 / 设置按钮
    const playLabel = state.hasProgress ? '继续闯关' : '开始游戏';
    this.drawTextButton(this.menuPlayBtn, playLabel, {
      fill: '#FF9838',
      text: '#FFFFFF',
      size: 19,
    });
    this.drawTextButton(this.menuSettingsBtn, '设置', {
      fill: 'rgba(255,255,255,0.92)',
      stroke: '#E8C9A0',
      text: '#8A6234',
    });

    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#C7A87F';
    ctx.fillText(`已通关 ${state.cleared} / ${this.levelCount} 关`, this.W / 2, this.menuSettingsBtn.y + 110);
  }

  // ---------- 设置页 ----------

  drawSettings(state) {
    const { ctx } = this;
    this.drawCircleButton(this.backBtn, '←');
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8A5A22';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('设置', this.W / 2, this.H * 0.2);

    // 音效开关行
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7A5C3E';
    ctx.font = 'bold 17px sans-serif';
    ctx.fillText('游戏音效', this.W / 2 - 110, this.settingsSoundToggle.y + 21);
    this.drawToggle(this.settingsSoundToggle, state.soundOn !== false);

    this.drawTextButton(this.settingsResetBtn, '重置关卡进度', {
      fill: '#E5533D',
      text: '#FFFFFF',
    });
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#B08C64';
    ctx.textAlign = 'center';
    ctx.fillText('清除存档进度，从第 1 关重新开始', this.W / 2, this.settingsResetBtn.y + 44);
    ctx.fillText(`当前进度：已通关 ${state.cleared} / ${this.levelCount} 关`, this.W / 2, this.settingsResetBtn.y + 68);
  }

  /** iOS 风格开关 */
  drawToggle(t, on) {
    const { ctx } = this;
    ctx.save();
    // 轨道
    ctx.fillStyle = on ? '#8BD450' : '#D8C9B2';
    this.rr(t.x, t.y, t.w, t.h, t.h / 2);
    ctx.fill();
    // 圆点
    const cx = on ? t.x + t.w - t.h / 2 : t.x + t.h / 2;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(cx, t.y + t.h / 2, t.h / 2 - 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---------- 关卡选择页 ----------

  drawLevelSelect(state) {
    const { ctx } = this;
    this.drawCircleButton(this.backBtn, '←');
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8A5A22';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('选择关卡', this.W / 2, this.H * 0.09);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#B08C64';
    ctx.fillText(`已通关 ${state.cleared} / ${this.levelCount} 关 · 通关解锁下一关`, this.W / 2, this.H * 0.09 + 26);

    const cols = 2;
    const margin = 20;
    const gapX = 14;
    const gapY = 14;
    const cardW = (this.W - margin * 2 - gapX) / 2;
    const rows = Math.ceil(this.levelCount / cols);
    const gridTop = this.H * 0.09 + 52;
    const availH = this.H - 60 - gridTop;
    const needH = rows * 62 + (rows - 1) * gapY;
    const cardH = needH > availH ? (availH - (rows - 1) * gapY) / rows : 62; // 压缩高度防出屏

    this.levelBtns = [];
    for (let i = 0; i < this.levelCount; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = margin + col * (cardW + gapX);
      const y = gridTop + row * (cardH + gapY);
      this.levelBtns.push({ x, y, w: cardW, h: cardH });

      const cleared = i < state.cleared; // 已通关
      const unlocked = i <= state.cleared; // 已解锁（含当前待挑战）

      // 卡片
      ctx.fillStyle = !unlocked
        ? 'rgba(210,195,170,0.35)'
        : cleared
          ? 'rgba(139,212,80,0.16)'
          : 'rgba(255,255,255,0.92)';
      this.rr(x, y, cardW, cardH, 12);
      ctx.fill();
      ctx.strokeStyle = !unlocked ? 'rgba(176,158,130,0.35)' : cleared ? '#8BD450' : '#E8C9A0';
      ctx.lineWidth = cleared ? 2.5 : 2;
      ctx.stroke();

      // 关卡号
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = !unlocked ? 'rgba(150,132,106,0.6)' : cleared ? '#4E8A2A' : '#8A6234';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(String(i + 1), x + 18, y + cardH / 2);

      // 状态标识
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'right';
      if (!unlocked) {
        this.drawLock(x + cardW - 32, y + cardH / 2);
      } else if (cleared) {
        ctx.fillStyle = '#4E8A2A';
        ctx.fillText('已通关 ✓', x + cardW - 14, y + cardH / 2);
      } else {
        ctx.fillStyle = '#E07B2A';
        ctx.fillText('可挑战', x + cardW - 14, y + cardH / 2);
      }
      ctx.textBaseline = 'alphabetic';
    }
  }

  /** 小锁图标 */
  drawLock(cx, cy) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(150,132,106,0.75)';
    ctx.fillStyle = 'rgba(150,132,106,0.75)';
    ctx.lineWidth = 2;
    this.rr(cx - 7, cy - 2, 14, 11, 2.5); // 锁体
    ctx.fill();
    ctx.beginPath(); // 锁梁
    ctx.arc(cx, cy - 3, 4.5, Math.PI, 0);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- 游戏内暂停浮层 ----------

  drawPauseOverlay() {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(43, 28, 12, 0.5)';
    ctx.fillRect(0, 0, this.W, this.H);
    this.drawTextButton(this.pauseResumeBtn, '继续游戏', {
      fill: '#FF9838',
      text: '#FFFFFF',
      size: 18,
    });
    this.drawTextButton(this.pauseExitBtn, '退出 · 返回菜单', {
      fill: 'rgba(255,255,255,0.92)',
      stroke: '#E8C9A0',
      text: '#8A6234',
      size: 16,
    });
    ctx.restore();
  }

  // ---------- 广告补给确认浮层（道具用尽后的激励视频点位） ----------

  drawAdConfirm(state) {
    const { ctx } = this;
    const label = state.adConfirm === 'shuffle' ? '打乱' : '加瓶';
    ctx.save();
    ctx.fillStyle = 'rgba(43, 28, 12, 0.5)';
    ctx.fillRect(0, 0, this.W, this.H);
    // 标题与说明
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFF6E8';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(`补充${label}道具`, this.W / 2, this.H / 2 - 96);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = 'rgba(255,246,232,0.85)';
    ctx.fillText(`观看一段视频广告，补充 1 次「${label}」`, this.W / 2, this.H / 2 - 66);
    this.drawTextButton(this.adConfirmWatchBtn, '看广告 · 补充', {
      fill: '#FF9838',
      text: '#FFFFFF',
      size: 17,
    });
    this.drawTextButton(this.adConfirmCancelBtn, '取消', {
      fill: 'rgba(255,255,255,0.92)',
      stroke: '#E8C9A0',
      text: '#8A6234',
      size: 16,
    });
    ctx.restore();
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
    this.drawCircleButton(this.backBtn, '←');
    ctx.textBaseline = 'middle';
    // 标题画在胶囊按钮下方，避免被遮挡
    ctx.fillStyle = '#B0793B';
    ctx.textAlign = 'center';
    ctx.font = 'bold 19px sans-serif';
    ctx.fillText('缤纷果汁铺', this.W / 2, this.topSafe + 18);
    // 关卡与步数行：与标题同行（左右两侧），彻底避开货架成品饮料区
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#9C7A52';
    ctx.fillText(`第 ${state.levelIndex + 1} / ${this.levelCount} 关`, 16, this.topSafe + 18);
    ctx.textAlign = 'right';
    ctx.fillText(`步数 ${state.logic.moveCount}`, this.W - 16, this.topSafe + 18);
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

      // 已收走的完成瓶不再绘制（正在倒入的完成瓶除外，保证倒水动画连贯）
      if (logic.removed && logic.removed.has(i) && !(pour && pour.to === i)) continue;

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

    // 液体（先画，被玻璃覆盖）。层值 < 0 为「?」隐藏层
    if (layers.length) {
      const innerX = x + 3.5;
      const innerW = w - 7;
      const layerH = (bodyH - 7) / 4;
      const bottomY = bodyY + bodyH - 3.5;
      let topY = bottomY;
      for (let i = 0; i < layers.length; i++) {
        const raw = layers[i];
        const hidden = raw < 0;
        const colorId = hidden ? -raw - 1 : raw;
        const c = hidden ? '#9E8FB5' : COLORS[colorId] ? COLORS[colorId].main : '#AAA';
        const ly = bottomY - (i + 1) * layerH;
        topY = ly;
        ctx.fillStyle = c;
        ctx.fillRect(innerX, ly, innerW, layerH + 0.6); // 微重叠防缝隙
        if (hidden) {
          ctx.fillStyle = 'rgba(255,255,255,0.92)';
          ctx.font = `bold ${Math.max(10, layerH * 0.7)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('?', x + w / 2, ly + layerH / 2 + 0.5);
          ctx.textBaseline = 'alphabetic';
        }
      }
      // 顶层液面高光
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
    const entries = [
      [this.undoBtn, '撤回', state.logic.undoStack.length > 0, 0],
      [this.shuffleBtn, '打乱', state.props.shuffle > 0, state.props.shuffle],
      [this.addBottleBtn, '加瓶', state.props.addBottle > 0, state.props.addBottle],
      [this.restartBtn, '重开', true, 0],
    ];
    for (const [btn, label, enabled, uses] of entries) {
      ctx.save();
      ctx.globalAlpha = enabled ? 1 : 0.35;
      this.drawCircleButton(btn, label);
      // 剩余次数角标
      if (enabled && uses > 0) {
        ctx.fillStyle = '#E5533D';
        ctx.beginPath();
        ctx.arc(btn.x + btn.r * 0.72, btn.y - btn.r * 0.72, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(uses), btn.x + btn.r * 0.72, btn.y - btn.r * 0.72 + 0.5);
        ctx.textBaseline = 'alphabetic';
      }
      ctx.restore();
    }
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

  /** 打乱选瓶模式提示（顶栏下常驻，直到打乱执行或取消） */
  drawShuffleHint() {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = '#E07B2A';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('点选要打乱的瓶子（再点「打乱」取消）', this.W / 2, this.topSafe + 44);
    ctx.restore();
  }

  drawWinPanel(state) {
    const { ctx } = this;
    const isLast = state.levelIndex >= this.levelCount - 1;
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
