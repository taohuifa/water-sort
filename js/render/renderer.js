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
    this.capacity = 4; // 本关瓶容量（setupBoard 注入，决定层高与瓶高比例）
    this.bigIdx = -1; // 大瓶下标（特殊关，setupBoard 注入；普通关 -1）
    this.bigCapacity = 0; // 大瓶容量（特殊关）
    this.levelScroll = 0; // 关卡选择页竖向滚动偏移
    this.levelScrollMax = 0; // 滚动上限（drawLevelSelect 按内容高度计算）
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
    this.images = {}; // 美化资源图（背景 / 货架木板），加载完成前走降级绘制
    this.loadImages();
  }

  /** 加载代码包内资源图（失败静默降级为纯绘制） */
  loadImages() {
    if (typeof wx === 'undefined' || !wx.createImage) return;
    const load = (key, src, onload) => {
      const img = wx.createImage();
      img.onload = () => {
        this.images[key] = img;
        if (onload) onload();
      };
      img.onerror = () => {}; // 加载失败保持降级绘制
      img.src = src;
    };
    load('bg', 'assets/images/bg-juice-bar.jpg'); // 游戏页
    load('bgMenu', 'assets/images/bg-menu.jpg'); // 菜单页
    load('bgLevels', 'assets/images/bg-levels.jpg'); // 关卡选择页
    load('bgSettings', 'assets/images/bg-settings.jpg'); // 设置页
    load('plank', 'assets/images/shelf-plank.png'); // 货架木板
    load('bottle', 'assets/images/bottle-glass.png'); // 玻璃瓶素材
    load('iconBack', 'assets/images/icon-back.png');
    load('iconUndo', 'assets/images/icon-undo.png');
    load('iconShuffle', 'assets/images/icon-shuffle.png');
    load('iconAdd', 'assets/images/icon-add.png');
    load('iconRestart', 'assets/images/icon-restart.png');
    for (let c = 0; c < 8; c++) {
      load(`liquid${c}`, `assets/images/backup/liquid-${c}.png`); // 各色液柱贴图（已由滤色缓存取代，仅降级回退用）
      load(`drink${c}`, `assets/images/backup/drink-${c}.png`); // 货架成品奶茶杯贴图（同上）
    }
    load('liquidHidden', 'assets/images/backup/liquid-hidden.png'); // 隐藏层神秘灰紫液柱（同上）
    // 白模板滤色方案：三张模板 + 启动时离屏合成各色缓存（合成失败走上方原贴图/矢量降级）
    load('liquidWhite', 'assets/images/liquid-white.png', () => this.buildLiquidTints());
    load('drinkBase', 'assets/images/drink-base.png');
    load('drinkJuice', 'assets/images/drink-juice.png', () => this.buildDrinkTints());
  }

  /** '#RRGGBB' -> [r,g,b] */
  hexRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  /**
   * 白模板滤色：模板字节 = 光影比值 × 127.5（2.0 余量编码），
   * 逐像素乘目标色得彩色贴图，写入离屏画布缓存。运行时与普通贴图同样 drawImage。
   */
  tintCanvas(img, rgb) {
    const w = img.width;
    const h = img.height;
    // 小游戏离屏画布：createOffscreenCanvas 优先（部分环境没有），退回第二次 wx.createCanvas()
    const oc = typeof wx.createOffscreenCanvas === 'function'
      ? wx.createOffscreenCanvas({ type: '2d', width: w, height: h })
      : wx.createCanvas();
    oc.width = w;
    oc.height = h;
    const octx = oc.getContext('2d');
    octx.drawImage(img, 0, 0);
    const id = octx.getImageData(0, 0, w, h);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.min(255, (d[i] * 2 * rgb[0]) / 255);
      d[i + 1] = Math.min(255, (d[i + 1] * 2 * rgb[1]) / 255);
      d[i + 2] = Math.min(255, (d[i + 2] * 2 * rgb[2]) / 255);
    }
    octx.putImageData(id, 0, 0);
    return oc;
  }

  /** 液柱滤色缓存：8 色 + 隐藏层灰紫（#9E8FB5） */
  buildLiquidTints() {
    try {
      const tpl = this.images.liquidWhite;
      this.liquidTint = COLORS.map(c => this.tintCanvas(tpl, this.hexRgb(c.main)));
      this.liquidTintHidden = this.tintCanvas(tpl, [0x9e, 0x8f, 0xb5]);
    } catch (e) {
      this.liquidTint = null; // 离屏画布不可用时降级
    }
  }

  /** 奶茶杯果汁区滤色缓存（杯体结构由 drink-base 提供） */
  buildDrinkTints() {
    try {
      const tpl = this.images.drinkJuice;
      this.drinkTint = COLORS.map(c => this.tintCanvas(tpl, this.hexRgb(c.main)));
    } catch (e) {
      this.drinkTint = null;
    }
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
    this.settingsKeyBtn = { x: W / 2 - 110, y: this.H * 0.42 + 80, w: 220, h: 48 }; // 兑换码输入（GM 指令）
    // 广告补给确认浮层
    this.adConfirmWatchBtn = { x: W / 2 - 90, y: this.H / 2 - 44, w: 180, h: 48 };
    this.adConfirmCancelBtn = { x: W / 2 - 90, y: this.H / 2 + 24, w: 180, h: 48 };
    // 特殊关首进引导浮层（S-10，静态图文，复用弹层样式）
    this.bigIntroBtn = { x: W / 2 - 90, y: this.H / 2 + 96, w: 180, h: 48 };
    // 关卡选择页（卡片 rect 在 drawLevelSelect 中按关卡数计算）
    this.levelBtns = [];
    this.shelf = {
      boardX: 24,
      boardW: W - 48,
      rowY: [150], // 单行货架：与背景吧台横板融合，8 色上限恰好放下
      slotW: 40,
      perRow: 8,
    };
  }

  /**
   * 每关根据瓶数与容量计算瓶子网格布局。瓶高随容量线性伸缩（cap=4 基准，每 ±1 层 ±11%，Q1=A）。
   * bigIdx >= 0（特殊关，S-07）：普通瓶分上下两行环绕，大瓶居中独占中带——
   * 宽度为普通瓶 1.8 倍，高度按 bigCapacity 走同一 ±11%/层 伸缩公式；
   * 尺寸由「行宽不越界」与「2·bh + 2·gapY + bigH ≤ 安全区高」联立约束解出。
   */
  setupBoard(bottleCount, capacity = 4, bigIdx = -1, bigCapacity = 0) {
    this.capacity = capacity;
    this.bigIdx = bigIdx;
    this.bigCapacity = bigIdx >= 0 ? bigCapacity : 0;
    const n = bottleCount;
    const margin = 18;
    const gapX = 12;
    const gapY = 30;
    const playTop = 252;
    const playBottom = this.H - 128;
    const availW = this.W - margin * 2;
    const availH = playBottom - playTop;

    this.bottleRects = [];
    if (bigIdx >= 0 && bigCapacity > 0 && bigIdx < n) {
      // 特殊关布局：上排 ⌈(n-1)/2⌉ 个普通瓶 / 中带大瓶 / 下排余量普通瓶（R2 棋盘形态）
      const normals = n - 1;
      const topCount = Math.max(1, Math.ceil(normals / 2));
      const botCount = normals - topCount;
      const cols = Math.max(topCount, botCount, 1);
      const aspectN = 3.0 * (1 + (capacity - 4) * 0.11);
      // 竖向预算（特殊关专属收紧，普通关不受影响）：上界贴近货架、下界贴近按钮排
      const sTop = 248;
      const sBottom = this.H - 116;
      const sAvailH = sBottom - sTop;
      const vGap = 14; // 上排/大瓶/下排之间的行距（比普通关 30 紧，换取瓶宽）
      // 宽度约束：行内不越界（含 48px 常规上限）；大瓶宽由高度反推（天然 1:3 比例），仅需防越界
      const wCap = Math.min(48, (availW - (cols - 1) * gapX) / cols);
      // 高度约束（统一层厚：大瓶层厚 = 普通瓶层厚，bigH = bigCap/cap × bh）：
      // 上排 bh + vGap + bigH + vGap + 下排 bh ≤ sAvailH
      const bigRows = bigCapacity / capacity; // 大瓶折算普通瓶高的倍数
      const hCap = (sAvailH - 2 * vGap) / (aspectN * (2 + bigRows));
      const bw = Math.max(20, Math.min(wCap, hCap));
      const bh = bw * aspectN;
      const bigH = bigRows * bh;
      // 大瓶宽度按玻璃贴图天然比例 1:3 由高度反推（固定倍数会在不同容量下拉伸变形）
      const bigW = Math.min(bigH / 3, availW);
      const totalH = 2 * bh + 2 * vGap + bigH;
      const startY = sTop + (sAvailH - totalH) / 2;
      let k = 0;
      for (let r = 0; r < 2; r++) {
        const count = r === 0 ? topCount : botCount;
        if (count <= 0) continue;
        const rowW = count * bw + (count - 1) * gapX;
        const x0 = (this.W - rowW) / 2;
        const y = r === 0 ? startY : startY + bh + vGap + bigH + vGap;
        for (let c = 0; c < count; c++) {
          this.bottleRects[k++] = { x: x0 + c * (bw + gapX), y, w: bw, h: bh };
        }
      }
      this.bottleRects[bigIdx] = { x: (this.W - bigW) / 2, y: startY + bh + vGap, w: bigW, h: bigH };
      return;
    }

    const cols = Math.max(2, Math.ceil(n / 2));
    const rows = Math.ceil(n / cols);

    const aspect = 3.0 * (1 + (capacity - 4) * 0.11); // 瓶高随容量伸缩，画布安全区由下方压缩逻辑 clamp
    let bw = Math.min(48, (availW - (cols - 1) * gapX) / cols);
    let bh = bw * aspect; // 细长试管瓶（贴合参考图俯视角贴图比例）
    const needH = rows * bh + (rows - 1) * gapY;
    if (needH > availH) {
      bh = (availH - (rows - 1) * gapY) / rows;
      bw = bh / aspect;
    }
    const gridW = cols * bw + (cols - 1) * gapX;
    const gridH = rows * bh + (rows - 1) * gapY;
    const startX = (this.W - gridW) / 2;
    const startY = playTop + (availH - gridH) / 2;

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

  /** 瓶 i 的绘制容量（大瓶 = bigCapacity，其余 = this.capacity；S-07 层高自适应） */
  bottleCap(i) {
    return i === this.bigIdx && this.bigCapacity > 0 ? this.bigCapacity : this.capacity;
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
    this.drawBackground(state.scene);
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
    if (state.bigIntro) this.drawBigIntro(); // 特殊关首进引导浮层（最顶层）
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
    ctx.font = 'bold 14px sans-serif';
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

  /** 通用圆形小按钮（返回/图标）。opts.icon 提供素材图标键名，缺省画文字 */
  drawCircleButton(btn, label, opts = {}) {
    const { ctx } = this;
    ctx.fillStyle = opts.fill || 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(btn.x, btn.y, btn.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = opts.stroke || '#E8C9A0';
    ctx.lineWidth = 2;
    ctx.stroke();
    const icon = opts.icon && this.images[opts.icon];
    if (icon) {
      // 图标占按钮直径的 70%
      const d = btn.r * 1.4;
      ctx.drawImage(icon, btn.x - d / 2, btn.y - d / 2, d, d);
      return;
    }
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
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = '#7A5C3E';
    ctx.fillText('JuiceSort · 倒水排序', this.W / 2, this.H * 0.17 + 32);

    // 装饰瓶子
    const deco = [
      [[0, 0, 1, 1], null],
      [[2, 3, 2, 3], [4]],
      [[5, 6, 5, 6], [7]],
    ];
    const bw = 32;
    const bh = bw * 3.0; // 细长试管瓶，与游戏内一致
    const gap = 26;
    const startX = this.W / 2 - ((deco.length * bw + (deco.length - 1) * gap) / 2);
    const savedCap = this.capacity; // 菜单装饰瓶恒按容量 4 绘制（不受本关容量影响）
    this.capacity = 4;
    deco.forEach((d, i) => {
      const rect = {
        x: startX + i * (bw + gap),
        y: this.H * 0.24,
        w: bw,
        h: bh,
      };
      this.drawBottle(rect, d[0], false, false);
      if (d[1]) {
        const rect2 = { x: rect.x + rect.w / 2 - 8, y: rect.y + rect.h + 10, w: 16, h: 16 * 3.0 };
        this.drawBottle(rect2, d[1], false, false);
      }
    });
    this.capacity = savedCap;

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

    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#8A6234';
    ctx.fillText(`已通关 ${state.cleared} / ${this.levelCount} 关`, this.W / 2, this.menuSettingsBtn.y + 110);
  }

  // ---------- 设置页 ----------

  drawSettings(state) {
    const { ctx } = this;
    this.drawCircleButton(this.backBtn, '←', { icon: 'iconBack' });
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
    // 兑换码输入入口（GM 指令，测试验收用）
    this.drawTextButton(this.settingsKeyBtn, '输入兑换码', {
      fill: 'rgba(255,255,255,0.92)',
      stroke: '#E8C9A0',
      text: '#8A6234',
      size: 15,
    });
    // 底部提示区（页脚）：加深为统一提示色 #8A6234
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#8A6234';
    ctx.textAlign = 'center';
    ctx.fillText(`当前进度：已通关 ${state.cleared} / ${this.levelCount} 关`, this.W / 2, this.H - 96);
    ctx.fillText('清除存档进度，从第 1 关重新开始', this.W / 2, this.H - 74);
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
    this.drawCircleButton(this.backBtn, '←', { icon: 'iconBack' });
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8A5A22';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('选择关卡', this.W / 2, this.H * 0.09);
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#8A6234';
    ctx.fillText(`已通关 ${state.cleared} / ${this.levelCount} 关 · 通关解锁下一关`, this.W / 2, this.H * 0.09 + 26);

    // 自适应列数（Q6=A）：宽屏 4 列，窄屏 3 列；30 关竖向滚动
    const cols = this.W >= 414 ? 4 : 3;
    const margin = 20;
    const gapX = 12;
    const gapY = 14;
    const cardW = (this.W - margin * 2 - (cols - 1) * gapX) / cols;
    const cardH = 62;
    const rows = Math.ceil(this.levelCount / cols);
    const gridTop = this.H * 0.09 + 52;
    const availH = this.H - 60 - gridTop;
    const contentH = rows * cardH + (rows - 1) * gapY;
    this.levelScrollMax = Math.max(0, contentH - availH);
    this.levelScroll = Math.max(0, Math.min(this.levelScroll, this.levelScrollMax));

    this.levelBtns = [];
    for (let i = 0; i < this.levelCount; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = margin + col * (cardW + gapX);
      const y = gridTop + row * (cardH + gapY) - this.levelScroll;
      if (y > this.H || y + cardH < gridTop) {
        // 屏外卡片仍登记命中区域（与绘制位置一致），仅跳过绘制
        this.levelBtns.push({ x, y, w: cardW, h: cardH });
        continue;
      }
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

      // 关卡号（左）+ 状态标识（右，窄卡片用紧凑标识）
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = !unlocked ? 'rgba(150,132,106,0.6)' : cleared ? '#4E8A2A' : '#8A6234';
      ctx.font = 'bold 21px sans-serif';
      ctx.fillText(String(i + 1), x + 14, y + cardH / 2);
      ctx.textAlign = 'right';
      if (!unlocked) {
        this.drawLock(x + cardW - 24, y + cardH / 2);
      } else if (cleared) {
        ctx.fillStyle = '#4E8A2A';
        ctx.font = 'bold 17px sans-serif';
        ctx.fillText('✓', x + cardW - 14, y + cardH / 2);
      } else if (state.specials && state.specials[i]) {
        // 特殊关静态角标（R7/S-09）：未通关的特殊关显示「特殊」，已通关仍为 ✓
        ctx.fillStyle = '#5B8DEF';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText('特殊', x + cardW - 12, y + cardH / 2);
      } else {
        ctx.fillStyle = '#E07B2A';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText('挑战', x + cardW - 12, y + cardH / 2);
      }
      ctx.textBaseline = 'alphabetic';
    }

    // 滚动位置指示（内容超出时可滚动时显示细滚动条）
    if (this.levelScrollMax > 0) {
      const barH = Math.max(36, (availH / contentH) * (availH - 8));
      const barY = gridTop + 4 + (this.levelScroll / this.levelScrollMax) * (availH - 8 - barH);
      ctx.fillStyle = 'rgba(176, 158, 130, 0.4)';
      this.rr(this.W - 8, barY, 4, barH, 2);
      ctx.fill();
    }
  }

  /** 关卡选择页竖向滚动（main.js 触摸驱动）。dy 为本次位移（向下拖为正） */
  scrollLevels(dy) {
    this.levelScroll = Math.max(0, Math.min(this.levelScroll - dy, this.levelScrollMax));
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
    ctx.font = 'bold 14px sans-serif';
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

  // ---------- 特殊关首进引导浮层（R8 / S-10，静态图文 + 矢量示意瓶，无图片依赖） ----------

  drawBigIntro() {
    const { ctx } = this;
    ctx.save();
    // 遮罩 + 卡片
    ctx.fillStyle = 'rgba(43, 28, 12, 0.55)';
    ctx.fillRect(0, 0, this.W, this.H);
    const cw = 302;
    const ch = 366;
    const cx = (this.W - cw) / 2;
    const cy = (this.H - ch) / 2 - 40;
    ctx.fillStyle = '#FFF9F0';
    this.rr(cx, cy, cw, ch, 18);
    ctx.fill();

    // 标题
    ctx.textAlign = 'center';
    ctx.fillStyle = '#7A4E1D';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText('特殊订单！', this.W / 2, cy + 46);

    // 中央大瓶示意（矢量，复用 drawBottle：8 层容量、装 3 层示意）
    const bw = 34;
    const bh = bw * 3.0 * (1 + (8 - 4) * 0.11); // cap=8 伸缩比例
    const savedCap = this.capacity;
    this.capacity = 8;
    this.drawBottle(
      { x: this.W / 2 - bw / 2, y: cy + 58, w: bw, h: bh },
      [0, 0, 0],
      false,
      false
    );
    this.capacity = savedCap;
    // 左右两个小普通瓶对照（瓶身更小，突出「大瓶」）
    const sw = 17;
    const sh = sw * 3.0;
    this.drawBottle({ x: this.W / 2 - 86, y: cy + 58 + (bh - sh) * 0.6, w: sw, h: sh }, [1], false, false);
    this.drawBottle({ x: this.W / 2 + 69, y: cy + 58 + (bh - sh) * 0.6, w: sw, h: sh }, [2], false, false);

    // 正文（PRD R8 文案）
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#7A5C4E';
    const lines = [
      '本关没有货架订单。',
      '大瓶底部已预置一层限定色果汁，只收该色，',
      '集齐装满即通关！',
      '普通瓶装满不会收走，放心当中转瓶用。',
    ];
    lines.forEach((t, i) => ctx.fillText(t, this.W / 2, cy + 222 + i * 21));

    // 按钮
    const b = this.bigIntroBtn;
    b.x = (this.W - b.w) / 2;
    b.y = cy + ch - 64;
    ctx.fillStyle = '#FF9838';
    this.rr(b.x, b.y, b.w, b.h, 24);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 18px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('开始挑战', this.W / 2, b.y + b.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  drawBackground(scene) {
    const { ctx } = this;
    // 分场景背景：菜单 / 关卡选择 / 设置 / 游戏（默认）
    const key = { menu: 'bgMenu', levelSelect: 'bgLevels', settings: 'bgSettings' }[scene] || 'bg';
    const bg = this.images[key];
    if (bg) {
      // cover 铺满：等比缩放居中裁切
      const s = Math.max(this.W / bg.width, this.H / bg.height);
      const dw = bg.width * s;
      const dh = bg.height * s;
      ctx.drawImage(bg, (this.W - dw) / 2, (this.H - dh) / 2, dw, dh);
      return;
    }
    // 降级：渐变背景 + 顶部装饰横幅
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, '#FFF6E8');
    g.addColorStop(0.55, '#FFEFD9');
    g.addColorStop(1, '#FBE3C4');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.fillStyle = 'rgba(255, 152, 56, 0.14)';
    ctx.fillRect(0, 0, this.W, 56);
  }

  drawTopBar(state) {
    const { ctx } = this;
    this.drawCircleButton(this.backBtn, '←', { icon: 'iconBack' });
    ctx.textBaseline = 'middle';
    // 顶栏文字：奶油色填充 + 深棕描边（游戏经典描边字），任何背景上都清晰
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(74, 48, 22, 0.9)';
    const drawOutlined = (text, tx, align) => {
      ctx.textAlign = align;
      ctx.strokeText(text, tx, this.topSafe + 18);
      ctx.fillText(text, tx, this.topSafe + 18);
    };
    ctx.fillStyle = '#FFF6E8';
    ctx.font = 'bold 19px sans-serif';
    drawOutlined('缤纷果汁铺', this.W / 2, 'center');
    // 关卡与步数行：与标题同行（左右两侧）
    ctx.font = 'bold 14px sans-serif';
    drawOutlined(`第 ${state.levelIndex + 1} / ${this.levelCount} 关`, 16, 'left');
    drawOutlined(`步数 ${state.logic.moveCount}`, this.W - 16, 'right');
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
  }

  drawShelf(state) {
    const { ctx } = this;
    const s = this.shelf;
    const plank = this.images.plank;
    for (const rowY of s.rowY) {
      if (plank) {
        // 木板资源图（透明底，含下缘侧面），高度略大于内容以盖住落点
        ctx.drawImage(plank, s.boardX, rowY - 7, s.boardW, 18);
      } else {
        ctx.fillStyle = '#C08A57';
        this.rr(s.boardX, rowY, s.boardW, 9, 4.5);
        ctx.fill();
        ctx.fillStyle = 'rgba(122, 78, 40, 0.28)';
        ctx.fillRect(s.boardX + 6, rowY + 9, s.boardW - 12, 3);
      }
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

  /** 货架上的成品饮料：奶茶杯贴图（降级：果汁杯 + 奶盖 + 吸管矢量绘制） */
  drawDrink(x, y, colorId, scale = 1) {
    const { ctx } = this;
    // 白模板滤色：染色果汁层垫底，杯体结构（玻璃/奶盖/吸管）覆盖其上
    const juice = this.drinkTint && this.drinkTint[colorId];
    const cupBase = this.images.drinkBase;
    if (juice && cupBase) {
      const dh = 42 * scale;
      const dw = dh * (cupBase.width / cupBase.height);
      ctx.drawImage(juice, x - dw / 2, y - dh, dw, dh);
      ctx.drawImage(cupBase, x - dw / 2, y - dh, dw, dh);
      return;
    }
    const img = this.images[`drink${colorId}`];
    if (img) {
      const dh = 42 * scale;
      const dw = dh * (img.width / img.height);
      ctx.drawImage(img, x - dw / 2, y - dh, dw, dh);
      return;
    }
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
      const badge = anims.badgeOf(i);

      // 已收走的完成瓶不再绘制（正在倒入/徽章展示中的完成瓶除外，保证动画连贯）
      if (logic.removed && logic.removed.has(i) && !(pour && pour.to === i) && !badge) continue;

      // 确定本帧显示的层数组（倒水动画期间的中间态）
      let layers;
      if (pour && pour.from === i) {
        const moved = anims.pourMoved(pour);
        layers = pour.fromContentBefore.slice(0, pour.fromContentBefore.length - moved);
      } else if (pour && pour.to === i) {
        const moved = anims.pourMoved(pour);
        layers = pour.toContentBefore.slice().concat(new Array(moved).fill(pour.color));
      } else if (badge) {
        layers = badge.layers; // 徽章阶段停留展示完成时的满色瓶
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
      // 钥匙层角标：该瓶为钥匙所在瓶且未解锁时，在钥匙层上叠加钥匙图形
      // （倒水动画涉及该瓶时跳过，避免角标与中间态错位）
      let keyIdx = -1;
      if (logic.locks) {
        for (let k = 0; k < logic.locks.length; k++) {
          const lk = logic.locks[k];
          if (lk.type === 'key' && !logic.unlocked[k] && lk.keyBottle === i) keyIdx = lk.keyDepth;
        }
      }
      if (pour && (pour.from === i || pour.to === i)) keyIdx = -1;
      this.ctx.save();
      this.ctx.translate(cx + shakeX, bottom);
      this.ctx.rotate(angle);
      this.ctx.translate(-cx, -bottom);
      this.ctx.translate(0, -lift);
      this.drawBottle(rect, layers, selected === i, !!flying, keyIdx, this.bottleCap(i));
      this.ctx.restore();
      // 满瓶完成标记：金色 ✓ 徽章叠加在瓶口（随后才起飞去货架）
      if (badge) this.drawCompleteBadge(rect, badge.t);
      // 锁瓶角标（R4/R5）：未解锁的锁瓶在瓶口上方绘制锁形 + 进度/钥匙提示（矢量）
      if (logic.locks) {
        for (let k = 0; k < logic.locks.length; k++) {
          const lk = logic.locks[k];
          if (lk.bottle !== i || logic.unlocked[k]) continue;
          if (lk.type === 'cond') this.drawCondLockBadge(rect, logic.completed.length, lk.need);
          else this.drawKeyLockBadge(rect);
        }
      }
    }

    // 倒水流线
    if (pour) {
      this.drawStream(pour, anims);
    }
  }

  /** 玻璃瓶 + 分层液体。layers: 颜色 ID 数组，index 0 为底层；keyLayerIdx: 钥匙层下标（-1 无）；
   *  cap：本瓶绘制容量（大瓶 = bigCapacity，缺省 this.capacity） */
  drawBottle(rect, layers, isSelected, ghost, keyLayerIdx = -1, cap = this.capacity) {
    const { ctx } = this;
    const { x, y, w, h } = rect;
    const sprite = this.images.bottle;

    // 素材模式：贴图为真半透明玻璃（俯视角瓶口自带），液体先画、玻璃覆在上层
    if (sprite) {
      this.drawBottleLiquid(rect, layers, true, keyLayerIdx, cap);
      ctx.save();
      if (ghost) ctx.globalAlpha = 0.5;
      ctx.drawImage(sprite, x, y, w, h);
      ctx.restore();
      // 选中态：琥珀色描边（宽度随瓶宽放大，大瓶 1.8× 更醒目）
      if (isSelected) {
        ctx.save();
        ctx.strokeStyle = '#FFB300';
        ctx.lineWidth = w > 60 ? 4 : 3;
        this.rr(x - 1, y - 1, w + 2, h + 2, w * 0.2);
        ctx.stroke();
        ctx.restore();
      }
      return;
    }

    // 降级模式：纯 Canvas 绘制（液体先画，被半透明玻璃覆盖）
    const neckH = h * 0.14;
    const bodyY = y + neckH;
    const bodyH = h - neckH;
    const neckW = w * 0.46;
    const neckX = x + (w - neckW) / 2;

    this.drawBottleLiquid(rect, layers, false, keyLayerIdx, cap);

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

  /**
   * 瓶内液体分层。层值 < 0 为「?」隐藏层。
   * fit=true（玻璃贴图模式）：收进贴图轮廓内并按圆角裁剪，避免液体溢出玻璃。
   * keyLayerIdx >= 0（可选）：在该层上叠加金色钥匙角标（R5 钥匙层提示，矢量绘制）。
   * cap（可选）：本瓶绘制容量（大瓶 = bigCapacity，缺省 this.capacity；层高 = innerH/cap）。
   */
  drawBottleLiquid(rect, layers, fit, keyLayerIdx = -1, cap = this.capacity) {
    if (!layers.length) return;
    const { ctx } = this;
    const { x, y, w, h } = rect;
    const innerX = fit ? x + w * 0.09 : x + 3.5;
    const innerW = fit ? w * 0.82 : w - 7;
    const innerY = fit ? y + h * 0.13 : y + h * 0.08; // 顶部压到玻璃肩部之下
    const innerH = fit ? h * 0.83 : h * 0.92 - 3.5; // 底部贴近瓶底圆弧
    const layerH = innerH / cap;
    const bottomY = innerY + innerH;
    let topY = bottomY;
    let topColor = null;
    let topUsedTex = false;
    // 分带组合渲染：连续同色合并为一带，每带 = 直筒(按带高拉伸) + 圆底帽；
    // 非底带的圆底帽下凸压住下一带顶部，形成弧形交界；仅最顶带画圆顶。
    // 素材 132x140 紧凑胶囊：圆顶 0~44 / 直筒 45~77 / 圆底 78~140。
    ctx.save();
    if (fit) {
      this.rr(innerX, innerY, innerW, innerH, innerW * 0.45); // 内轮廓大圆角（近胶囊形），贴合试管圆底
      ctx.clip();
    }
    const bands = [];
    for (let i = 0; i < layers.length; i++) {
      const raw = layers[i];
      const hidden = raw < 0;
      const colorId = hidden ? -raw - 1 : raw;
      const last = bands[bands.length - 1];
      if (last && last.colorId === colorId && last.hidden === hidden) last.count++;
      else bands.push({ colorId, hidden, count: 1 });
    }
    const liW = innerW;
    const liX = x + w / 2 - liW / 2;
    const domeH = Math.min(layerH * 0.65, 20); // 顶帽（圆顶）绘制高度
    const botH = Math.min(layerH * 0.55, 16); // 底帽（圆底）绘制高度
    const CURVE_FRAC = 62 / 80; // 底帽切片 [60,140) 中弧线部分（78~140）占比
    let idx = 0; // 该带最底层在 layers 中的下标
    for (let b = 0; b < bands.length; b++) {
      const band = bands[b];
      const bh = band.count * layerH;
      const ly = bottomY - (idx + band.count) * layerH; // 带顶
      const yBot = ly + bh;
      idx += band.count;
      const isTop = b === bands.length - 1;
      const isBottom = b === 0;
      const def = band.hidden ? null : COLORS[band.colorId];
      const c = band.hidden ? '#9E8FB5' : def ? def.main : '#AAA';
      const deep = band.hidden ? '#8A7BA6' : def && def.deep ? def.deep : c;
      topY = ly;
      topColor = c;
      const tex = fit && !band.hidden
        ? (this.liquidTint && this.liquidTint[band.colorId]) || this.images[`liquid${band.colorId}`]
        : fit && band.hidden
          ? this.liquidTintHidden || this.images.liquidHidden
          : null;
      if (tex) {
        // 切片：顶帽 [0,60)（圆顶+短直筒）/ 直筒窄条 [62,74) / 底帽 [60,140)（直筒引导+圆底）
        const sy = isTop ? ly + domeH : ly;
        if (yBot > sy) {
          ctx.drawImage(tex, 0, 62, tex.width, 12, liX, sy, liW, yBot - sy); // 直筒按带高拉伸
        }
        const lead = botH * (1 - CURVE_FRAC); // 底帽直筒引导段高度
        if (isBottom) {
          // 底带：圆底贴瓶底
          ctx.drawImage(tex, 0, 60, tex.width, 80, liX, yBot - botH, liW, botH);
        } else {
          // 上带：圆底下凸压住下一带顶部，形成弧形交界
          ctx.drawImage(tex, 0, 60, tex.width, 80, liX, yBot - lead, liW, botH);
        }
        if (isTop) {
          ctx.drawImage(tex, 0, 0, tex.width, 60, liX, ly, liW, domeH);
          topUsedTex = true;
        }
      } else {
        // 降级：带内纵向渐变（上亮下暗）
        const grad = ctx.createLinearGradient(0, ly, 0, yBot);
        grad.addColorStop(0, c);
        grad.addColorStop(1, deep);
        ctx.fillStyle = grad;
        ctx.fillRect(liX, ly, liW, bh + 0.6); // 微重叠防缝隙
      }
      if (band.hidden) { // 隐藏带的「?」标记：居中于本带未被上带圆底帽覆盖的可见区
        // 圆底帽由「上面的带」下凸侵入本带顶部（顶带之上无带，不受侵入）——底/中带均会被侵入
        const coverTop = isTop ? 0 : botH * CURVE_FRAC;
        const midY = ly + (coverTop + bh) / 2; // 可见区 [ly+coverTop, yBot] 的中心
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.font = `bold ${Math.max(10, layerH * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', x + w / 2, midY + 0.5);
        ctx.textBaseline = 'alphabetic';
      }
    }
    // 顶部液面高光：贴图模式自带，仅降级模式代码绘制
    if (topColor && !topUsedTex) {
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.beginPath();
      ctx.ellipse(x + w / 2, topY - 2, innerW / 2 - 2, 2.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // 钥匙层角标（R5）：金色钥匙图形叠在该层可见区中心，矢量绘制（无贴图依赖）。
    // 钥匙层若为本带顶层且本带之上还有带，层顶会被上带圆底帽侵入 coverK，
    // 按层几何中心画会骑在分界弧上——改按可见区 [layerTop+coverK, layerBottom] 居中。
    if (keyLayerIdx >= 0 && keyLayerIdx < layers.length) {
      let coverK = 0;
      let acc = 0;
      for (const bnd of bands) {
        const bandTopLayer = acc + bnd.count - 1;
        if (keyLayerIdx <= bandTopLayer) {
          if (keyLayerIdx === bandTopLayer && bandTopLayer < layers.length - 1) {
            coverK = botH * CURVE_FRAC;
          }
          break;
        }
        acc += bnd.count;
      }
      const layerTop = bottomY - (keyLayerIdx + 1) * layerH;
      const ky = layerTop + coverK + (layerH - coverK) / 2;
      const ks = Math.max(5, Math.min(layerH * 0.45, 12));
      // 水平微调：钥匙图形（圆头在左、杆在右）视觉重心略偏左，右移 0.22s 使观感居中
      this.drawKeyGlyph(x + w / 2 + ks * 0.22, ky, ks);
    }
    ctx.restore();
  }

  /** 金色钥匙矢量图形（圆头 + 杆 + 两齿），R5 钥匙层/钥匙锁瓶角标用 */
  drawKeyGlyph(cx, cy, s) {
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(74, 48, 22, 0.85)'; // 深棕描边保证任何液体颜色上可读
    ctx.lineWidth = 3.4;
    this._keyPath(cx, cy, s);
    ctx.stroke();
    ctx.strokeStyle = '#FFD54F';
    ctx.lineWidth = 2;
    this._keyPath(cx, cy, s);
    ctx.stroke();
    ctx.restore();
  }

  _keyPath(cx, cy, s) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(cx - s * 0.9, cy, s * 0.55, 0, Math.PI * 2); // 圆头
    ctx.moveTo(cx - s * 0.35, cy);
    ctx.lineTo(cx + s, cy); // 杆
    ctx.moveTo(cx + s * 0.35, cy);
    ctx.lineTo(cx + s * 0.35, cy + s * 0.5); // 齿 1
    ctx.moveTo(cx + s * 0.7, cy);
    ctx.lineTo(cx + s * 0.7, cy + s * 0.5); // 齿 2
  }

  /** 条件锁瓶角标（R4）：锁形 + 完成进度「已完成/need」，矢量绘制 */
  drawCondLockBadge(rect, done, need) {
    const { ctx } = this;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y - 4; // 底板下沿压住瓶口：贴合瓶口悬挂，不再悬浮脱节
    const bw = Math.max(40, Math.min(52, rect.w + 14)); // 底板宽随瓶宽自适应，窄瓶不横向溢出
    const bx = cx - bw / 2;
    ctx.save();
    // 底板
    ctx.fillStyle = 'rgba(62, 42, 24, 0.88)';
    this.rr(bx, cy - 10, bw, 20, 10);
    ctx.fill();
    // 锁体 + 锁梁（棕色）
    ctx.strokeStyle = '#E8C9A0';
    ctx.fillStyle = '#E8C9A0';
    ctx.lineWidth = 1.6;
    this.rr(bx + 4, cy - 2, 10, 8, 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx + 9, cy - 2, 3.2, Math.PI, 0);
    ctx.stroke();
    // 进度文本
    ctx.fillStyle = '#FFF6E8';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.min(done, need)}/${need}`, bx + 18, cy + 0.5);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  /** 钥匙锁瓶角标（R5）：金色锁形 + 钥匙图形暗示，矢量绘制 */
  drawKeyLockBadge(rect) {
    const { ctx } = this;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y - 4; // 底板下沿压住瓶口：贴合瓶口悬挂，不再悬浮脱节
    const bw = Math.max(40, Math.min(52, rect.w + 14)); // 底板宽随瓶宽自适应，窄瓶不横向溢出
    const bx = cx - bw / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(62, 42, 24, 0.88)';
    this.rr(bx, cy - 10, bw, 20, 10);
    ctx.fill();
    // 金色锁体 + 锁梁
    ctx.strokeStyle = '#FFD54F';
    ctx.fillStyle = '#FFD54F';
    ctx.lineWidth = 1.6;
    this.rr(bx + 5, cy - 2, 10, 8, 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx + 10, cy - 2, 3.2, Math.PI, 0);
    ctx.stroke();
    // 钥匙提示
    this.drawKeyGlyph(bx + bw - 13, cy, 7);
    ctx.restore();
  }

  /** 满瓶完成标记：瓶口金色 ✓ 圆徽 + 扩散光环（easeOutBack 弹出，停留展示后起飞） */
  drawCompleteBadge(rect, t) {
    const { ctx } = this;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h * 0.16; // 瓶口/瓶颈区域
    // easeOutBack 弹出（轻微过冲回弹）
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const p = t - 1;
    const s = Math.min(Math.max(1 + c3 * p * p * p + c1 * p * p, 0), 1.18);
    const r = Math.max(10, rect.w * 0.36) * s;
    if (r <= 0.5) return;
    ctx.save();
    // 扩散光环（前 70% 渐隐外扩）
    if (t < 0.7) {
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255, 214, 90, ${((0.55 * (0.7 - t)) / 0.7).toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.arc(cx, cy, r * (1 + t * 1.4), 0, Math.PI * 2);
      ctx.stroke();
    }
    // 金色圆徽（径向渐变 + 白描边）
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.2, cx, cy, r);
    g.addColorStop(0, '#FFE082');
    g.addColorStop(1, '#FFA000');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
    // 白色对勾
    ctx.beginPath();
    ctx.lineWidth = Math.max(2.5, r * 0.26);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#FFFFFF';
    ctx.moveTo(cx - r * 0.42, cy + r * 0.02);
    ctx.lineTo(cx - r * 0.08, cy + r * 0.38);
    ctx.lineTo(cx + r * 0.46, cy - r * 0.32);
    ctx.stroke();
    ctx.restore();
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
      [this.undoBtn, '撤回', state.logic.undoStack.length > 0, 0, 'iconUndo'],
      [this.shuffleBtn, '打乱', state.props.shuffle > 0, state.props.shuffle, 'iconShuffle'],
      [this.addBottleBtn, '加瓶', state.props.addBottle > 0, state.props.addBottle, 'iconAdd'],
      [this.restartBtn, '重开', true, 0, 'iconRestart'],
    ];
    for (const [btn, label, enabled, uses, icon] of entries) {
      ctx.save();
      ctx.globalAlpha = enabled ? 1 : 0.35;
      this.drawCircleButton(btn, label, { icon });
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
    // 文案（特殊关：集齐 X 色，收集完成！X = 大瓶内目标色名称，R7 / S-09）
    let title = isLast ? '恭喜全部通关！' : '关卡完成！';
    let titleSize = 24;
    if (state.logic.special === 'bigBottle') {
      const big = state.logic.bottles[state.logic.bigIndex] || [];
      const c = big.length ? big[0] : 0;
      title = `集齐 ${COLORS[c] ? COLORS[c].name : '目标'}色，收集完成！`;
      titleSize = 20; // 文案较长，降一号保证卡片内不溢出
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#7A4E1D';
    ctx.font = `bold ${titleSize}px sans-serif`;
    ctx.fillText(title, this.W / 2, cy + 58);
    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = '#7A5C3E';
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
