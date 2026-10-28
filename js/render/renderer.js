import { COLORS } from '../core/levels.js';
import Rng from '../core/rng.js';

/**
 * 渲染层：Canvas 2D 绘制所有内容 —— 背景、吧台货架、玻璃瓶与液体分层、
 * 选中态、倒水流线、成品饮料、底部操作栏、通关面板。
 * 只读逻辑层数据，不做任何游戏规则判断。
 */
const BOTTLE_TOP_FRAC = 0.32; // 三段式：瓶口段（唇边+颈+肩）占素材高比例
const BOTTLE_BOT_FRAC = 0.12; // 三段式：圆底段占素材高比例
export const BOTTLE_ASPECT = 2.0; // 瓶形高宽比（矮胖奶瓶体态；容量伸缩公式在此基准上 ±11%/层）

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
    this.caps = null; // 每瓶容量（混合关，setupBoard 注入；null = 均一容量）
    this.levelScroll = 0; // 关卡选择页竖向滚动偏移
    this.levelScrollMax = 0; // 滚动上限（drawLevelSelect 按内容高度计算）
    this.pressed = null; // 按下态按钮 key（R1，main.js bindTouch 命中检测写入 / 清除；仅视觉反馈）
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
    load('iconRevive', 'assets/images/icon-revive.png'); // 续杯图标（AI 生成，与既有金黄圆钮图标同风格）
    load('iconRestart', 'assets/images/icon-restart.png');
    // 加载进度条（PRD-关卡生成异步化与加载界面 F-04）：位图外框 + 果汁填充（源裁剪显示进度）
    load('loadingBarFrame', 'assets/images/loading-bar.png');
    load('loadingBarFill', 'assets/images/loading-fill.png');
    // 液体模板（8 色 + 隐藏灰紫）：位图三段拼接（顶盖/主体/底盖），规范见 art-rendering.md；
    // 9 色由白模 liquid-src/liquid-tpl-white.png 离线滤色生成（tools/process-liquid-ai.ps1）
    for (let c = 0; c < 8; c++) {
      load(`liquidTpl${c}`, `assets/images/liquid-tpl-${c}.png`);
    }
    load('liquidTplHidden', 'assets/images/liquid-tpl-hidden.png');
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
    // 5 钮道具栏（PRD-限时与步数限制 F-10：+续杯）：间距压缩为 ±140/±70，r 28→27 防窄屏越界
    this.undoBtn = { x: W / 2 - 140, y: btnY, r: 27 };
    this.shuffleBtn = { x: W / 2 - 70, y: btnY, r: 27 };
    this.addBottleBtn = { x: W / 2, y: btnY, r: 27 };
    this.reviveBtn = { x: W / 2 + 70, y: btnY, r: 27 };
    this.restartBtn = { x: W / 2 + 140, y: btnY, r: 27 };
    this.nextBtn = { x: W / 2 - 80, y: this.H / 2 + 42, w: 160, h: 48 }; // 实际尺寸/位置由 drawWinPanel 每帧覆写（140×46，面板内定位）
    this.winBackBtn = { x: W / 2 - 80, y: this.H / 2 + 42, w: 100, h: 46 }; // 通关面板副按钮「返回」（drawWinPanel 内重定位）
    // 暂停浮层
    this.pauseResumeBtn = { x: W / 2 - 90, y: this.H / 2 - 44, w: 180, h: 48 };
    this.pauseExitBtn = { x: W / 2 - 90, y: this.H / 2 + 24, w: 180, h: 48 };
    // 失败弹窗（PRD-玩法扩展 §2 B：重开 / 广告复活，布局与暂停浮层同构）
    this.failReviveBtn = { x: W / 2 - 90, y: this.H / 2 - 44, w: 180, h: 48 };
    this.failRestartBtn = { x: W / 2 - 90, y: this.H / 2 + 24, w: 180, h: 48 };
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
  setupBoard(bottleCount, capacity = 4, bigIdx = -1, bigCapacity = 0, caps = null, seed = 0, bigLayout = null) {
    this.capacity = capacity;
    this.bigIdx = bigIdx;
    this.bigCapacity = bigIdx >= 0 ? bigCapacity : 0;
    this.caps = caps; // 每瓶容量（混合关；null = 均一容量）
    const n = bottleCount;
    const margin = 12; // 页边距收紧，瓶子整体放大
    const gapX = 12;
    const gapY = 48; // 行距（含散布纵向抖动 ±22px 的余量，保证行间不重叠）
    const playTop = 252;
    const playBottom = this.H - 128;
    const availW = this.W - margin * 2;
    const availH = playBottom - playTop;

    this.bottleRects = [];
    if (bigIdx >= 0 && bigCapacity > 0 && bigIdx < n) {
      // 特殊关布局（bigLayout 可配置）：rows（默认）= 上排/中带大瓶/下排（R2 棋盘）；
      // sides = 大瓶居中、普通瓶左右两列夹持（吧台摆位）；ring = 普通瓶上排 + 左右两列环绕大瓶。
      // 三种模式均保证瓶与瓶/大瓶不重叠。
      const aspectN = BOTTLE_ASPECT * (1 + (capacity - 4) * 0.11);
      // 竖向预算（特殊关专属收紧，普通关不受影响）：上界贴近货架、下界贴近按钮排
      const sTop = 248;
      const sBottom = this.H - 116;
      const sAvailH = sBottom - sTop;
      const vGap = 14; // 上排/大瓶/下排之间的行距（比普通关 30 紧，换取瓶宽）
      const bigRows = bigCapacity / capacity; // 大瓶折算普通瓶高的倍数
      const mode = bigLayout === 'sides' || bigLayout === 'ring' ? bigLayout : 'rows';
      if (mode === 'ring') {
        // —— 圆形环绕：普通瓶沿椭圆均布围住居中大瓶（自正上方起），重叠则整体放大半径迭代 ——
        const normalsC = n - 1;
        const edge = gapX * 2; // 瓶与大瓶/画布边缘的间距
        // 尺寸预算：环带总高 = bigH + 2×edge + 2×bh ≤ sAvailH；宽 = 2bw + bigW + 2×edge ≤ availW
        const hCapBh = (sAvailH - 2 * edge) / (bigRows + 2);
        const wCapBw = (availW - 2 * edge) / (2 + (bigRows * aspectN) / BOTTLE_ASPECT);
        const bw = Math.max(20, Math.min(60, hCapBh / aspectN, wCapBw));
        const bh = bw * aspectN;
        const bigH = bigRows * bh;
        const bigW = Math.min(bigH / BOTTLE_ASPECT, availW - 2 * bw - 2 * edge);
        const cx = this.W / 2;
        const cy = sTop + sAvailH / 2;
        this.bottleRects[bigIdx] = { x: cx - bigW / 2, y: cy - bigH / 2, w: bigW, h: bigH };
        const idxs = [];
        for (let i = 0; i < n; i++) if (i !== bigIdx) idxs.push(i);
        const m = idxs.length;
        let rx = bigW / 2 + edge + bw / 2;
        let ry = bigH / 2 + edge + bh / 2;
        for (let iter = 0; iter < 40; iter++) {
          const pts = idxs.map((_, a) => {
            const th = -Math.PI / 2 + (a * 2 * Math.PI) / m;
            return { x: cx + rx * Math.cos(th), y: cy + ry * Math.sin(th) };
          });
          let clash = false;
          for (let a = 0; a < m && !clash; a++) {
            for (let b = a + 1; b < m; b++) {
              if (Math.abs(pts[a].x - pts[b].x) < bw + 2 && Math.abs(pts[a].y - pts[b].y) < bh + 2) {
                clash = true;
                break;
              }
            }
          }
          if (!clash) break;
          rx *= 1.04;
          ry *= 1.04;
        }
        idxs.forEach((i, a) => {
          const th = -Math.PI / 2 + (a * 2 * Math.PI) / m;
          this.bottleRects[i] = {
            x: cx + rx * Math.cos(th) - bw / 2,
            y: Math.max(sTop, Math.min(cy + ry * Math.sin(th) - bh / 2, sBottom - bh)), // 出界兜底钳制
            w: bw,
            h: bh,
          };
        });
        return;
      }
      if (mode !== 'rows') {
        // —— sides 夹持模式：普通瓶左右两列站立，大瓶正中，互不重叠 ——
        const normalsS = n - 1;
        const topCount = mode === 'ring' ? Math.min(normalsS, Math.max(1, Math.round(normalsS / 3))) : 0;
        const perCol = Math.ceil((normalsS - topCount) / 2);
        const colGap = 14; // 列内瓶距
        // 高度预算解 bh：sides → colH ≤ sAvailH；ring → bh + vGap + max(colH, bigH) ≤ sAvailH
        const hCapBh =
          mode === 'sides'
            ? (sAvailH - (perCol - 1) * colGap) / perCol
            : (sAvailH - vGap - (perCol - 1) * colGap) / (1 + Math.max(perCol, bigRows));
        // 宽度预算：2×列宽 + 大瓶宽 + 4×gapX ≤ availW（bigW = bigRows×bh/BOTTLE_ASPECT）
        const wCapBw = (availW - 4 * gapX) / (2 + (bigRows * aspectN) / BOTTLE_ASPECT);
        const bw = Math.max(20, Math.min(60, hCapBh / aspectN, wCapBw));
        const bh = bw * aspectN;
        const bigH = bigRows * bh;
        const bigW = Math.min(bigH / BOTTLE_ASPECT, availW - 2 * bw - 4 * gapX);
        const colH = perCol * bh + (perCol - 1) * colGap;
        const blockH = Math.max(colH, bigH);
        const topY = mode === 'ring' ? sTop + (sAvailH - (bh + vGap + blockH)) / 2 : 0;
        const baseline =
          mode === 'ring' ? topY + bh + vGap + blockH : sTop + (sAvailH - blockH) / 2 + blockH;
        const colEdge = gapX * 2; // 列与大瓶水平间距
        const leftX = this.W / 2 - bigW / 2 - colEdge - bw;
        const rightX = this.W / 2 + bigW / 2 + colEdge;
        const normalIdxs = [];
        for (let i = 0; i < n; i++) if (i !== bigIdx) normalIdxs.push(i);
        this.bottleRects[bigIdx] = { x: (this.W - bigW) / 2, y: baseline - bigH, w: bigW, h: bigH };
        let placed = 0;
        if (mode === 'ring') {
          const rowW = topCount * bw + (topCount - 1) * gapX;
          const tx0 = (this.W - rowW) / 2;
          for (let c = 0; c < topCount; c++, placed++) {
            this.bottleRects[normalIdxs[placed]] = { x: tx0 + c * (bw + gapX), y: topY, w: bw, h: bh };
          }
        }
        normalIdxs.slice(placed).forEach((i, t) => {
          const x = t % 2 === 0 ? leftX : rightX;
          const slot = Math.floor(t / 2);
          this.bottleRects[i] = { x, y: baseline - (slot + 1) * bh - slot * colGap, w: bw, h: bh };
        });
        return;
      }
      // rows 模式（R2 棋盘）：上排 ⌈(n-1)/2⌉ 个普通瓶 / 中带大瓶 / 下排余量普通瓶
      const normals = n - 1;
      const topCount = Math.max(1, Math.ceil(normals / 2));
      const botCount = normals - topCount;
      const cols = Math.max(topCount, botCount, 1);
      // 宽度约束：行内不越界（含 60px 常规上限）；大瓶宽由高度反推（瓶形 1:BOTTLE_ASPECT 比例），仅需防越界
      const wCap = Math.min(60, (availW - (cols - 1) * gapX) / cols);
      // 高度约束（统一层厚：大瓶层厚 = 普通瓶层厚，bigH = bigCap/cap × bh）：
      // 上排 bh + vGap + bigH + vGap + 下排 bh ≤ sAvailH
      const hCap = (sAvailH - 2 * vGap) / (aspectN * (2 + bigRows));
      const bw = Math.max(20, Math.min(wCap, hCap));
      const bh = bw * aspectN;
      const bigH = bigRows * bh;
      // 大瓶宽度按玻璃贴图瓶形比例 1:BOTTLE_ASPECT 由高度反推（固定倍数会在不同容量下拉伸变形）
      const bigW = Math.min(bigH / BOTTLE_ASPECT, availW);
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

    // 混合容量关与普通关同布局：每关内瓶子统一尺寸（大小一致），液体按各自容量在瓶内分层。
    // （旧「瓶高 ∝ 容量」口径已废除；caps 仅在绘制层高时经 bottleCap 生效）

    // 列数自适应：候选 2..⌈n/2⌉ 中选「瓶宽×瓶高」最大的列数——
    // 宽约束（含散布余量）与高约束（行数×瓶高 + 行距 ≤ 棋盘高）取小，
    // 瓶子尽量撑满棋盘（宽排/密排自动择优），瓶形 1:aspect 保持不变
    const aspect = BOTTLE_ASPECT * (1 + (capacity - 4) * 0.11);
    let cols = 2;
    let bw = 16;
    let bh = bw * aspect;
    for (let c = 2, cMax = Math.max(2, Math.ceil(n / 2)); c <= cMax; c++) {
      const rowsC = Math.ceil(n / c);
      let w = Math.min(76, (availW - (c - 1) * (gapX + 8)) / c);
      let h = w * aspect;
      const needH = rowsC * h + (rowsC - 1) * gapY;
      if (needH > availH) {
        h = (availH - (rowsC - 1) * gapY) / rowsC;
        w = h / aspect;
      }
      w = Math.max(16, w);
      if (w * h > bw * bh) {
        cols = c;
        bw = w;
        bh = h;
      }
    }
    const rows = Math.ceil(n / cols);
    const gridH = rows * bh + (rows - 1) * gapY;
    const startY = playTop + (availH - gridH) / 2;

    // 离散散布：行内瓶距随机（rng 可复现）+ 每瓶纵向抖动（±22px < 行距 48px，钳制安全区保证不重叠）
    const rng = new Rng((seed ^ 0x5f3759df) >>> 0);
    let rowXs = null;
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      if (c === 0) rowXs = this._scatterRowXs(Math.min(cols, n - r * cols), bw, availW, rng);
      const dy = (rng.next() * 2 - 1) * 22;
      const yy = Math.max(playTop, Math.min(startY + r * (bh + gapY) + dy, playBottom - bh)); // 安全区钳制
      this.bottleRects.push({
        x: rowXs[c],
        y: yy,
        w: bw,
        h: bh,
      });
    }
  }

  /** 一行 m 瓶的离散 x 坐标：瓶距 = 基础缝 12px + 随机份额（上限 26px/缝），瓶群整体居中（2026-10-28：集中布局，避免大屏少量瓶时过度离散） */
  _scatterRowXs(m, bw, availW, rng) {
    const baseGap = 12;
    const maxExtraPerGap = 26;
    const slack = Math.max(0, availW - m * bw - (m - 1) * baseGap);
    const extraTotal = Math.min(slack, (m - 1) * maxExtraPerGap); // 只吸收少量剩余宽度，其余让位给居中
    const weights = [];
    let wSum = 0;
    for (let i = 0; i < m - 1; i++) {
      const w = 0.35 + rng.next();
      weights.push(w);
      wSum += w;
    }
    const clusterW = m * bw + (m - 1) * baseGap + extraTotal;
    let x = (this.W - clusterW) / 2;
    const xs = [];
    for (let i = 0; i < m; i++) {
      xs.push(x);
      x += bw + baseGap + (i < m - 1 ? (extraTotal * weights[i]) / (wSum || 1) : 0);
    }
    return xs;
  }

  /** 瓶 i 的绘制容量（混合关 = caps[i]；大瓶 = bigCapacity；其余 = this.capacity；S-07 层高自适应） */
  bottleCap(i) {
    if (i === this.bigIdx && this.bigCapacity > 0) return this.bigCapacity;
    if (this.caps && this.caps[i]) return this.caps[i];
    return this.capacity;
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

  /**
   * 触摸按下命中检测（R1）：按场景 / 浮层列出当前可交互按钮，返回按钮 key 或 null。
   * ctx = {scene, winPanel, bigIntro, adConfirm, pauseOverlay, cleared}；
   * 仅用于按下态视觉反馈，不参与 onTap 点击派发（派发逻辑零改动）。
   *
   * ⚠️ 同步契约：本函数的分支顺序与命中区域是 main.js onTap 分支的手工镜像——
   * 修改 onTap（分支顺序 / 新增浮层 / 新增按钮）必须同步修改本函数，
   * 由 smoke「hitButton/onTap 命中矩阵」用例守护（tests/smoke.render.test.js）。
   */
  hitButton(px, py, ctx) {
    const { scene } = ctx;
    if (scene === 'menu') {
      if (this.inRect(px, py, this.menuPlayBtn)) return 'menuPlayBtn';
      if (this.inRect(px, py, this.menuSettingsBtn)) return 'menuSettingsBtn';
      return null;
    }
    if (scene === 'settings') {
      if (this.inCircle(px, py, this.backBtn)) return 'backBtn';
      if (this.inRect(px, py, this.settingsSoundToggle)) return 'settingsSoundToggle';
      if (this.inRect(px, py, this.settingsResetBtn)) return 'settingsResetBtn';
      if (this.inRect(px, py, this.settingsKeyBtn)) return 'settingsKeyBtn';
      return null;
    }
    if (scene === 'levelSelect') {
      if (this.inCircle(px, py, this.backBtn)) return 'backBtn';
      for (let i = 0; i < this.levelBtns.length; i++) {
        // 未解锁卡片（i > cleared，与 main.selectLevel 解锁口径一致）返回 null：无按下态
        if (this.inRect(px, py, this.levelBtns[i]) && i <= (ctx.cleared ?? 0)) {
          return 'level:' + i;
        }
      }
      return null;
    }
    // game 场景（浮层按 onTap 同序：winPanel → adConfirm → failPanel → bigIntro → pauseOverlay → 常规；
    // adConfirm 先于 failPanel：续杯补给浮层覆盖失败弹窗，与 failReviveBtn 同坐标须先派发）
    if (ctx.winPanel) {
      if (this.inRect(px, py, this.nextBtn)) return 'nextBtn';
      if (this.inRect(px, py, this.winBackBtn)) return 'winBackBtn';
      return null;
    }
    if (ctx.adConfirm) {
      if (this.inRect(px, py, this.adConfirmWatchBtn)) return 'adConfirmWatchBtn';
      if (this.inRect(px, py, this.adConfirmCancelBtn)) return 'adConfirmCancelBtn';
      return null;
    }
    if (ctx.failPanel) {
      if (this.inRect(px, py, this.failReviveBtn)) return 'failReviveBtn';
      if (this.inRect(px, py, this.failRestartBtn)) return 'failRestartBtn';
      return null;
    }
    if (ctx.bigIntro) return this.inRect(px, py, this.bigIntroBtn) ? 'bigIntroBtn' : null;
    if (ctx.pauseOverlay) {
      if (this.inRect(px, py, this.pauseResumeBtn)) return 'pauseResumeBtn';
      if (this.inRect(px, py, this.pauseExitBtn)) return 'pauseExitBtn';
      return null;
    }
    if (this.inCircle(px, py, this.backBtn)) return 'backBtn';
    if (this.inCircle(px, py, this.undoBtn)) return 'undoBtn';
    if (this.inCircle(px, py, this.shuffleBtn)) return 'shuffleBtn';
    if (this.inCircle(px, py, this.addBottleBtn)) return 'addBottleBtn';
    if (this.inCircle(px, py, this.reviveBtn)) return 'reviveBtn';
    if (this.inCircle(px, py, this.restartBtn)) return 'restartBtn';
    return null;
  }

  /** 按下态填充加深一档：hex 色乘 0.88（同色系变暗，不新造色板基调）；非 hex 原样返回 */
  _darken(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return hex;
    const d = (h) => Math.round(parseInt(h, 16) * 0.88).toString(16).padStart(2, '0');
    return `#${d(m[1])}${d(m[2])}${d(m[3])}`;
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
    } else if (state.scene === 'loading') {
      this.drawLoading(state);
    } else {
      this.drawGame(state);
    }
    this.drawToast();
  }

  /**
   * 加载页（PRD-关卡生成异步化与加载界面 F-04）：位图进度条（美术素材，遵守美术禁令——
   * 果汁填充按进度 drawImage 源裁剪，非程序化绘图）+ 关卡号文本辅助。
   * 进度口径 = 生成耗时 / 总预算（封顶 95%，兜底瞬间不出满条）。
   */
  drawLoading(state) {
    const { ctx } = this;
    const cx = this.W / 2;
    const cy = this.H * 0.46;
    const frame = this.images.loadingBarFrame;
    const fill = this.images.loadingBarFill;
    // 条高按外框素材等比（框变形会毁手绘细节）；素材未就绪降级 26px
    const barW = Math.min(360, this.W * 0.72);
    const barH = frame ? (barW * frame.height) / frame.width : 26;
    const bx = cx - barW / 2;
    const by = cy - barH / 2;
    const budget = state.genBudgetMs || 1;
    const p = Math.max(0.04, Math.min(0.95, (state.genElapsedMs || 0) / budget));
    if (fill) {
      // 果汁填充：按进度裁源宽（填充先画、外框后画套住，与液体/玻璃同层级口径）。
      // 嵌入玻璃槽：框素材剖面实测 —— 内槽纵向 50%~79% 框高、左右边框各约 8% 框宽
      const fx = bx + barW * 0.085;
      const fw = barW * 0.83;
      const fy = by + barH * 0.5;
      const fh = barH * 0.28;
      const sw = Math.max(1, Math.round(fill.width * p));
      const dw = Math.max(2, fw * p);
      ctx.drawImage(fill, 0, 0, sw, fill.height, fx, fy, dw, fh);
    }
    if (frame) {
      ctx.drawImage(frame, bx, by, barW, barH);
    } else if (!fill) {
      // 素材未就绪兜底（与图片加载降级同口径）：描边槽 + 色块
      ctx.strokeStyle = '#6b4a2f';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, barW, barH);
      ctx.fillStyle = '#e8a33d';
      ctx.fillRect(bx + 3, by + 3, (barW - 6) * p, barH - 6);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#5b3d24';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(`正在配液… 第 ${state.levelIndex + 1} 关`, cx, by - 22);
    ctx.fillStyle = '#a9805e';
    ctx.font = '13px sans-serif';
    ctx.fillText('新鲜果汁制作中', cx, by + barH + 26);
  }

  drawGame(state) {
    this.drawTopBar(state);
    this.drawShelf(state);
    this.drawBottles(state);
    if (state.bombFlashIdx >= 0 && !state.failPanel) this.drawBombFlash(state); // 引爆红色闪光（PRD-玩法扩展 §2 B）
    this.drawBottomBar(state);
    if (state.stuck && !state.winPanel && !state.failPanel && !state.anims.blocking()) {
      this.drawStuckTip();
    }
    if (state.shuffleSelecting) this.drawShuffleHint();
    if (state.failPanel) {
      this.drawFailPanel(state);
      // 续杯补给确认浮层覆盖失败弹窗（PRD-限时与步数限制 F-10：库存 0 → 看广告补 1 自动使用）
      if (state.adConfirm) this.drawAdConfirm(state);
    } else if (state.winPanel) this.drawWinPanel(state);
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

  /** 通用文字按钮。style.pressed：按下态（中心缩放 0.88 + 填充加深一档，R1，圆形与矩形统一） */
  drawTextButton(btn, label, style) {
    const { ctx } = this;
    ctx.save();
    if (style.pressed) {
      const cx = btn.x + btn.w / 2;
      const cy = btn.y + btn.h / 2;
      ctx.translate(cx, cy);
      ctx.scale(0.88, 0.88);
      ctx.translate(-cx, -cy);
    }
    let fill = style.fill;
    if (style.pressed) fill = fill.startsWith('#') ? this._darken(fill) : '#FBE3C4';
    ctx.fillStyle = fill;
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
    ctx.restore();
  }

  /**
   * 通用圆形小按钮（返回/图标）。opts.icon 提供素材图标键名，缺省画文字。
   * opts.pressed：按下态（中心缩放 0.88 + 填充加深一档，R1）。
   * opts.active：生效中态（橙色高亮描边 + 呼吸脉冲环 + 微暖填充，R2，二段式道具通用）；
   * active 与 pressed 可叠加——pressed 缩放与加深作用在 active 样式之上。
   */
  drawCircleButton(btn, label, opts = {}) {
    const { ctx } = this;
    ctx.save();
    if (opts.pressed) {
      ctx.translate(btn.x, btn.y);
      ctx.scale(0.88, 0.88);
      ctx.translate(-btn.x, -btn.y);
    }
    if (opts.active) {
      // 呼吸脉冲环：时间正弦调制外环半径与透明度（周期约 1.2s）
      const pulse = 0.5 + 0.5 * Math.sin((Date.now() / 1200) * Math.PI * 2);
      ctx.strokeStyle = `rgba(224, 123, 42, ${(0.3 + 0.45 * pulse).toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(btn.x, btn.y, btn.r + 4 + 3 * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
    let fill = opts.fill || 'rgba(255,255,255,0.92)';
    if (opts.active) fill = '#FFEFD9'; // 微暖填充（色板既有色）
    if (opts.pressed) fill = fill.startsWith('#') ? this._darken(fill) : '#FBE3C4'; // 按下加深一档
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(btn.x, btn.y, btn.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = opts.active ? '#E07B2A' : opts.stroke || '#E8C9A0';
    ctx.lineWidth = opts.active ? 3 : 2;
    ctx.stroke();
    const icon = opts.icon && this.images[opts.icon];
    if (icon) {
      // 图标占按钮直径的 70%
      const d = btn.r * 1.4;
      ctx.drawImage(icon, btn.x - d / 2, btn.y - d / 2, d, d);
      ctx.restore();
      return;
    }
    ctx.fillStyle = opts.text || '#8A6234';
    ctx.font = `bold ${opts.size || 15}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, btn.x, btn.y + 1);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
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
    const bh = bw * BOTTLE_ASPECT; // 矮胖奶瓶，与游戏内一致
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
        const rect2 = { x: rect.x + rect.w / 2 - 8, y: rect.y + rect.h + 10, w: 16, h: 16 * BOTTLE_ASPECT };
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
      pressed: this.pressed === 'menuPlayBtn',
    });
    this.drawTextButton(this.menuSettingsBtn, '设置', {
      fill: 'rgba(255,255,255,0.92)',
      stroke: '#E8C9A0',
      text: '#8A6234',
      pressed: this.pressed === 'menuSettingsBtn',
    });

    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#8A6234';
    ctx.fillText(`已通关 ${state.cleared} / ${this.levelCount} 关`, this.W / 2, this.menuSettingsBtn.y + 110);
  }

  // ---------- 设置页 ----------

  drawSettings(state) {
    const { ctx } = this;
    this.drawCircleButton(this.backBtn, '←', { icon: 'iconBack', pressed: this.pressed === 'backBtn' });
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8A5A22';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('设置', this.W / 2, this.H * 0.2);

    // 音效开关行
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7A5C3E';
    ctx.font = 'bold 17px sans-serif';
    ctx.fillText('游戏音效', this.W / 2 - 110, this.settingsSoundToggle.y + 21);
    this.drawToggle(this.settingsSoundToggle, state.soundOn !== false, this.pressed === 'settingsSoundToggle');

    this.drawTextButton(this.settingsResetBtn, '重置关卡进度', {
      fill: '#E5533D',
      text: '#FFFFFF',
      pressed: this.pressed === 'settingsResetBtn',
    });
    // 兑换码输入入口（GM 指令，测试验收用）
    this.drawTextButton(this.settingsKeyBtn, '输入兑换码', {
      fill: 'rgba(255,255,255,0.92)',
      stroke: '#E8C9A0',
      text: '#8A6234',
      size: 15,
      pressed: this.pressed === 'settingsKeyBtn',
    });
    // 底部提示区（页脚）：加深为统一提示色 #8A6234
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#8A6234';
    ctx.textAlign = 'center';
    ctx.fillText(`当前进度：已通关 ${state.cleared} / ${this.levelCount} 关`, this.W / 2, this.H - 96);
    ctx.fillText('清除存档进度，从第 1 关重新开始', this.W / 2, this.H - 74);
  }

  /** iOS 风格开关。pressed：按下态（中心缩放 0.88，R1） */
  drawToggle(t, on, pressed = false) {
    const { ctx } = this;
    ctx.save();
    if (pressed) {
      const cx = t.x + t.w / 2;
      const cy = t.y + t.h / 2;
      ctx.translate(cx, cy);
      ctx.scale(0.88, 0.88);
      ctx.translate(-cx, -cy);
    }
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
    this.drawCircleButton(this.backBtn, '←', { icon: 'iconBack', pressed: this.pressed === 'backBtn' });
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8A5A22';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('选择关卡', this.W / 2, this.H * 0.09);
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#8A6234';
    ctx.fillText(`已通关 ${state.cleared} / ${this.levelCount} 关 · 通关解锁下一关`, this.W / 2, this.H * 0.09 + 26);
    // 道具背包数量（PRD-道具背包 + 续杯 F-10）：图标 + 数量行（图标辅助识别，不再纯文字）
    const inv = state.inv || { undo: 0, shuffle: 0, addBottle: 0, revive: 0 };
    const items = [
      ['iconUndo', inv.undo],
      ['iconShuffle', inv.shuffle],
      ['iconAdd', inv.addBottle],
      ['iconRevive', inv.revive || 0],
    ];
    const slotGap = 82;
    const rowW = (items.length - 1) * slotGap;
    const iy = this.H * 0.09 + 46;
    items.forEach(([key, count], i) => {
      const x = this.W / 2 - rowW / 2 + i * slotGap;
      const icon = this.images[key]; // 图标未加载完成时降级为纯文字
      if (icon) ctx.drawImage(icon, x - 24, iy - 9, 18, 18);
      ctx.font = 'bold 13px sans-serif';
      ctx.fillStyle = '#7A5C3E';
      ctx.textAlign = 'left';
      ctx.fillText(`×${count}`, x - 2, iy + 5);
    });
    ctx.textAlign = 'center';

    // 自适应列数（Q6=A）：宽屏 4 列，窄屏 3 列；30 关竖向滚动
    const cols = this.W >= 414 ? 4 : 3;
    const margin = 20;
    const gapX = 12;
    const gapY = 14;
    const cardW = (this.W - margin * 2 - (cols - 1) * gapX) / cols;
    const cardH = 62;
    const rows = Math.ceil(this.levelCount / cols);
    const gridTop = this.H * 0.09 + 70;
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
      const cardPressed = this.pressed === 'level:' + i; // 卡片按下态（R1）

      // 卡片（按下态：中心缩放 0.88，白底加深一档）
      ctx.save();
      if (cardPressed) {
        const ccx = x + cardW / 2;
        const ccy = y + cardH / 2;
        ctx.translate(ccx, ccy);
        ctx.scale(0.88, 0.88);
        ctx.translate(-ccx, -ccy);
      }
      ctx.fillStyle = !unlocked
        ? 'rgba(210,195,170,0.35)'
        : cleared
          ? 'rgba(139,212,80,0.16)'
          : cardPressed
            ? '#FBE3C4'
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
      // 已获星数（PRD-三星评价；纯文本，只读 state.best，锁定卡与无纪录卡不显示）
      const rec = state.best && state.best[i + 1];
      if (unlocked && rec && rec.stars) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#F5A623';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars), x + cardW / 2, y + cardH - 8);
        ctx.textAlign = 'right';
      }
      ctx.textBaseline = 'alphabetic';
      ctx.restore(); // 卡片按下态变换收束
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
      pressed: this.pressed === 'pauseResumeBtn',
    });
    this.drawTextButton(this.pauseExitBtn, '退出 · 返回菜单', {
      fill: 'rgba(255,255,255,0.92)',
      stroke: '#E8C9A0',
      text: '#8A6234',
      size: 16,
      pressed: this.pressed === 'pauseExitBtn',
    });
    ctx.restore();
  }

  // ---------- 广告补给确认浮层（道具用尽后的激励视频点位） ----------

  drawAdConfirm(state) {
    const { ctx } = this;
    const label = { undo: '撤回', shuffle: '打乱', addBottle: '加瓶', revive: '续杯' }[state.adConfirm] || '道具';
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
      pressed: this.pressed === 'adConfirmWatchBtn',
    });
    this.drawTextButton(this.adConfirmCancelBtn, '取消', {
      fill: 'rgba(255,255,255,0.92)',
      stroke: '#E8C9A0',
      text: '#8A6234',
      size: 16,
      pressed: this.pressed === 'adConfirmCancelBtn',
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
    const bh = bw * BOTTLE_ASPECT * (1 + (8 - 4) * 0.11); // cap=8 伸缩比例
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
    const sh = sw * BOTTLE_ASPECT;
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

    // 按钮（drawTextButton：与手写绘制视觉一致，且统一支持按下态 R1）
    const b = this.bigIntroBtn;
    b.x = (this.W - b.w) / 2;
    b.y = cy + ch - 64;
    this.drawTextButton(b, '开始挑战', {
      fill: '#FF9838',
      text: '#FFFFFF',
      size: 18,
      pressed: this.pressed === 'bigIntroBtn',
    });
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
    const logic = state.logic;
    this.drawCircleButton(this.backBtn, '←', { icon: 'iconBack', pressed: this.pressed === 'backBtn' });
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
    // 关卡号（左）
    ctx.font = 'bold 14px sans-serif';
    drawOutlined(`第 ${state.levelIndex + 1} / ${this.levelCount} 关`, 16, 'left');
    // 顶部居中：mm:ss 倒计时（PRD-限时与步数限制 F-06②，替代原标题位；不限时关留空）。
    // ≤10s 数字转红 + 呼吸脉冲（字号 ±8%）；表现层只读 logic.timeLeft/timeLimit，不做规则判定
    if (logic.timeLimit > 0) {
      const urgent = logic.timeLeft <= 10;
      const t = Math.max(0, logic.timeLeft);
      const label = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
      const pulse = urgent ? 1 + 0.08 * Math.sin((Date.now() / 250) * Math.PI * 2) : 1;
      ctx.font = `bold ${Math.round(19 * pulse)}px sans-serif`;
      ctx.fillStyle = urgent ? '#E5533D' : '#FFF6E8';
      drawOutlined(label, this.W / 2, 'center');
    }
    // 右上角：步数 N/M（F-06③，仅步限关显示；剩余 ≤5 变红；无限关不显示）
    if (logic.moveLimit > 0) {
      const remain = logic.moveLimit - logic.moveCount;
      ctx.font = 'bold 14px sans-serif';
      ctx.fillStyle = remain <= 5 ? '#E5533D' : '#FFF6E8';
      drawOutlined(`步数: ${logic.moveCount}/${logic.moveLimit}`, this.W - 16, 'right');
    }
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
      // 遮盖瓶（PRD-玩法扩展 §2 A）：内容对玩家不可见（按空瓶绘制瓶体），叠加纸袋遮罩
      const covered = logic.isCovered && logic.isCovered(i);
      this.ctx.save();
      this.ctx.translate(cx + shakeX, bottom);
      this.ctx.rotate(angle);
      this.ctx.translate(-cx, -bottom);
      this.ctx.translate(0, -lift);
      this.drawBottle(rect, covered ? [] : layers, selected === i, !!flying, keyIdx, this.bottleCap(i));
      // 特性组件与瓶子绑定：遮盖/炸弹/完成/锁角标在同一变换内绘制，随瓶抖动/倾斜/上浮一起动
      if (covered) this.drawCoverMask(rect, logic.coverLeft());
      // 炸弹瓶倒计时角标（PRD-玩法扩展 §2 B）：炸弹图标 + 剩余步数，临近引爆红色警示
      const bombTimer = logic.bombTimerOf ? logic.bombTimerOf(i) : -1;
      if (bombTimer >= 0) this.drawBombBadge(rect, bombTimer);
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
      this.ctx.restore();
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

    // 素材模式：玻璃瓶素材三段绘制——瓶口/瓶底按宽等比固定不变形，
    // 仅瓶中直筒随瓶高伸缩（对齐参考图：不同容量瓶只有中段长短不同）。
    // 层级：液体先画（微透明），半透明玻璃瓶后画套住液体（描边实心、玻璃前壁透出液体）
    if (sprite) {
      this.drawBottleLiquid(rect, layers, true, keyLayerIdx, cap); // 液体不透明（不做透明度处理）
      ctx.save();
      if (ghost) ctx.globalAlpha = 0.5;
      const bTopPx = sprite.height * BOTTLE_TOP_FRAC; // 瓶口段（唇边+颈+肩）源像素
      const bBotPx = sprite.height * BOTTLE_BOT_FRAC; // 瓶底段（圆底）源像素
      const bMidPx = sprite.height - bTopPx - bBotPx;
      const segTopH = bTopPx * (w / sprite.width); // 按宽等比固定（不随瓶高拉伸，仅瓶身中段伸缩）
      const segBotH = bBotPx * (w / sprite.width);
      const segMidH = h - segTopH - segBotH;
      if (segMidH > 0) {
        ctx.drawImage(sprite, 0, 0, sprite.width, bTopPx, x, y, w, segTopH);
        ctx.drawImage(sprite, 0, bTopPx, sprite.width, bMidPx, x, y + segTopH, w, segMidH);
        ctx.drawImage(sprite, 0, bTopPx + bMidPx, sprite.width, bBotPx, x, y + segTopH + segMidH, w, segBotH);
      } else {
        // 瓶过矮：整体拉伸兜底
        ctx.drawImage(sprite, x, y, w, h);
      }
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
    const innerX = fit ? x + w * 0.1 : x + 3.5;
    const innerW = fit ? w * 0.8 : w - 7; // 液宽/瓶外轮廓 ≈ 0.80（新 AI 瓶描边+玻璃壁较厚）
    // 素材模板模式（顶盖+主体+底盖位图三段拼接）：liquid-tpl-{0..7,hidden}.png
    // （规范见 .codebuddy/rules/art-rendering.md：美术元素一律位图素材，禁止 API 绘图）
    const tplOn = fit && this.images.liquidTpl0 && this.images.liquidTpl0.width
      && this.images.liquidTplHidden && this.images.liquidTplHidden.width;
    let innerY = fit ? y + h * 0.22 : y + h * 0.08; // 液体顶贴参考图（瓶口段下沿）
    let innerH = fit ? h * 0.73 : h * 0.92 - 3.5; // 底部止于瓶底圆角区之上
    if (tplOn) {
      // 顶盖平顶位于瓶口段下沿，底盖深入圆底区（U 形）；
      // 段高按宽等比固定（与 drawBottle 玻璃三段同口径），截距由混合关布局补偿保证层厚一致
      const spriteG = this.images.bottle;
      const segTopHG = spriteG.height * BOTTLE_TOP_FRAC * (w / spriteG.width);
      const segBotHG = spriteG.height * BOTTLE_BOT_FRAC * (w / spriteG.width);
      innerY = y + segTopHG;
      innerH = (y + h - segBotHG * 0.4) - innerY;
    }
    const layerH = innerH / cap;
    const bottomY = innerY + innerH;
    let topY = bottomY;
    let topColor = null;
    let topUsedTex = false;
    ctx.save();
    if (fit && !tplOn) {
      this.rr(innerX, innerY, innerW, innerH, innerW * 0.14); // 内轮廓小圆角（降级模式）
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
      // 模板位图三段拼接（素材：参考图直抠 liquid-tpl-{0..7,hidden}.png，规范见
      // .codebuddy/rules/art-rendering.md：美术元素一律位图素材，禁止 API 绘图）。
      // 顶盖（平顶+表面亮盘）只画在整柱顶带；每个液体块都有圆弧底——底带 U 形
      // 圆底收在瓶底内，中/顶带的 U 形底盖下沉挂在下一带顶部（下带先画、弧叠其上，
      // 参考图边界弧）；主体取源中段纯色柱区拉伸——中间色块拉伸复制控制长度。
      const tpl = tplOn
        ? this.images[band.hidden ? 'liquidTplHidden' : `liquidTpl${band.colorId}`]
        : null;
      if (tpl && tpl.width) {
        const s = liW / tpl.width;
        // 顶盖穹顶压扁（参考图液面为扁平椭圆，非全高）；弧底压扁系数：参考图
        // 分界为浅弧+亮边沿弧走（瓶底 U 切片直接用太深且两侧收窄），底带保持全高
        const TOP_CAP_SQUASH = 0.55;
        const ARC_CAP_SQUASH = 0.45;
        // 切片比例按当前主图 liquid-tpl.png（128x141 矮胖版，AI 生成+清边）标定：
        // 顶面椭圆 0~12.5%、U 底 ~8%、中段纯色——折算屏幕尺寸与旧参考图抠图版一致
        const srcTopH = tpl.height * 0.2;   // 顶盖源段：0~20%（含顶面亮盘）
        const srcBotY = tpl.height * 0.88;  // 底盖源段：88~100%（浅弧/U 底）
        const srcBotH = tpl.height * 0.12;
        const srcMidY = tpl.height * 0.4;   // 主体源段：40%~50%（纯色柱）
        const srcMidH = tpl.height * 0.10;
        let segTop = isTop ? srcTopH * s * TOP_CAP_SQUASH : 0;
        let segBot = srcBotH * s * (isBottom ? 1 : ARC_CAP_SQUASH);
        // 底带：弧底收在本带内（瓶底位置）；中/顶带：弧底下沉到下一带顶部（不占本带高度）
        let segMid;
        let capBotY;
        if (isBottom) {
          segMid = bh - segTop - segBot;
          capBotY = ly + bh - segBot;
          if (segMid < 0) {
            // 带太矮：顶/底盖等比压缩保形，主体为 0
            const factor = bh / (segTop + segBot);
            segTop *= factor;
            segBot *= factor;
            segMid = 0;
            capBotY = ly + segTop;
          }
        } else {
          capBotY = ly + bh; // 弧底平缘对齐本带底边，弧部叠在下一带上
          segMid = bh - segTop;
          if (segMid < 0) segTop = bh; // 极矮顶带：顶盖压缩到整带高
        }
        if (segMid > 0) {
          ctx.drawImage(tpl, 0, srcMidY, tpl.width, srcMidH, liX, ly + segTop, liW, segMid + 0.6);
        }
        if (segBot > 0) {
          ctx.drawImage(tpl, 0, srcBotY, tpl.width, srcBotH, liX, capBotY, liW, segBot);
        }
        if (segTop > 0) {
          ctx.drawImage(tpl, 0, 0, tpl.width, srcTopH, liX, ly, liW, segTop);
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
        const coverTop = 0; // 直线分层无圆底帽侵入
        const midY = ly + (coverTop + bh) / 2; // 可见区 [ly+coverTop, yBot] 的中心
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.font = `bold ${Math.max(10, layerH * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', x + w / 2, midY + 0.5);
        ctx.textBaseline = 'alphabetic';
      }
    }
    // 分界无直线分隔线（参考图：浅弧亮边即分界，弧底素材自带）；liquidSep 素材保留待清理
    // 模板素材自带描边/高光/阴影，代码不再叠加
    // 顶部液面高光：仅降级模式代码绘制
    if (topColor && !topUsedTex && !tplOn) {
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
            coverK = 0; // 直线分层无圆底帽侵入
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

  /** 遮盖瓶纸袋遮罩（PRD-玩法扩展 §2 A）：牛皮纸袋覆盖整瓶 + 中央剩余层数徽章。
   *  程序化矢量绘制（交互提示类 UI，非美术素材占位；位图素材待美术走管线后替换此方法） */
  drawCoverMask(rect, left) {
    const { ctx } = this;
    const { x, y, w, h } = rect;
    // 只盖瓶身中段：露出瓶口/瓶颈/肩（上段）与瓶底圆弧线（下段），与瓶子三段式对齐
    const sprite = this.images.bottle;
    let topH = h * BOTTLE_TOP_FRAC, botH = h * BOTTLE_BOT_FRAC;
    if (sprite) {
      topH = sprite.height * BOTTLE_TOP_FRAC * (w / sprite.width);
      botH = sprite.height * BOTTLE_BOT_FRAC * (w / sprite.width);
    }
    const bx = x + w * 0.04;
    const bw = w * 0.92;
    const by = y + topH * 0.92; // 上沿压住肩部下沿，瓶口/瓶颈可见
    const bh = h - botH * 0.72 - (by - y); // 下沿收在瓶底圆弧线上方，底部线条可见
    const r = w * 0.14;
    ctx.save();
    // 袋体（牛皮纸色）
    ctx.fillStyle = '#C99C63';
    this.rr(bx, by, bw, bh, r);
    ctx.fill();
    // 袋口折边（深色，含翻盖 V 形）
    ctx.fillStyle = '#A87A46';
    ctx.beginPath();
    ctx.moveTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.lineTo(bx + bw - r, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
    ctx.lineTo(bx + bw, by + bh * 0.16);
    ctx.lineTo(bx + bw / 2, by + bh * 0.28);
    ctx.lineTo(bx, by + bh * 0.16);
    ctx.closePath();
    ctx.fill();
    // 中缝折痕
    ctx.strokeStyle = 'rgba(90, 58, 26, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx + bw / 2, by + bh * 0.30);
    ctx.lineTo(bx + bw / 2, by + bh - 6);
    ctx.stroke();
    // 剩余层数徽章
    const cx = bx + bw / 2;
    const cy = by + bh * 0.58;
    const br = Math.max(11, w * 0.26);
    ctx.fillStyle = 'rgba(62, 42, 24, 0.92)';
    ctx.beginPath();
    ctx.arc(cx, cy, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFF3DC';
    ctx.font = `bold ${Math.round(br * 1.2)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(left), cx, cy + 1);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  /**
   * 炸弹瓶倒计时角标（PRD-玩法扩展 §2 B）：炸弹图形 + 剩余步数数字；
   * 剩余 ≤2 时底板转红 + 瓶身红色警示描边（呼吸脉冲）。
   * 程序化矢量占位（交互提示类 UI，非美术素材；位图素材待美术走管线后替换此方法）
   */
  drawBombBadge(rect, left) {
    const { ctx } = this;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y - 14; // 悬挂在瓶口上方（与锁瓶角标同位口径），不遮挡瓶口
    const bw = Math.max(40, Math.min(56, rect.w + 18));
    const bx = cx - bw / 2;
    const urgent = left <= 2;
    ctx.save();
    // 底板
    ctx.fillStyle = urgent ? 'rgba(178, 34, 24, 0.92)' : 'rgba(62, 42, 24, 0.88)';
    this.rr(bx, cy - 10, bw, 20, 10);
    ctx.fill();
    // 炸弹图形：圆身 + 引线 + 火花
    const gx = bx + 13;
    const gy = cy + 1;
    ctx.fillStyle = '#FFF6E8';
    ctx.beginPath();
    ctx.arc(gx, gy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FFD54F';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(gx + 3.5, gy - 3.5);
    ctx.quadraticCurveTo(gx + 7, gy - 7, gx + 9, gy - 5);
    ctx.stroke();
    // 剩余步数
    ctx.fillStyle = urgent ? '#FFE082' : '#FFF6E8';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(left), bx + 28, cy + 0.5);
    ctx.textBaseline = 'alphabetic';
    // 临近引爆警示：瓶身红色呼吸描边
    if (urgent) {
      ctx.strokeStyle = `rgba(229, 57, 53, ${(0.45 + 0.4 * Math.sin((Date.now() / 300) * Math.PI * 2)).toFixed(3)})`;
      ctx.lineWidth = 2.5;
      this.rr(rect.x - 1.5, rect.y - 1.5, rect.w + 3, rect.h + 3, rect.w * 0.2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 爆炸动画（PRD-限时与步数限制 F-11）：引爆反馈三层叠加，全部由 failDelay 相位 p（0~0.6s → 0~1）驱动，
   * 复用既有 bombFlashIdx/bombFlashT，零新状态字段、无随机数（帧间稳定，冒烟可复现）：
   * ① 双层冲击波圆环扩散（延迟 0 / 0.15s 起，半径外扩 + 透明度线性衰减）；
   * ② 10 个粒子从瓶心固定角度/速度飞散淡出（异色交替）；
   * ③ 瓶身红色闪光（现有，透明度线性衰减）。
   * 程序化矢量占位（交互反馈类允许）；位图爆炸素材走美术管线后替换本方法即可（待美术）。
   */
  drawBombFlash(state) {
    const r = this.bottleRects[state.bombFlashIdx];
    if (!r) return;
    const p = Math.min(Math.max((state.bombFlashT || 0) / 0.6, 0), 1); // 相位 0~1
    if (p >= 1) return;
    const { ctx } = this;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h * 0.5;
    ctx.save();
    // ① 双层冲击波圆环
    for (const [delay, spread, width] of [[0, 1, 4], [0.15, 0.8, 2.5]]) {
      const q = (p - delay) / (1 - delay);
      if (q <= 0 || q >= 1) continue;
      ctx.strokeStyle = `rgba(255, 152, 56, ${(0.7 * (1 - q)).toFixed(3)})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(cx, cy, r.h * 0.2 + q * r.h * 0.9 * spread, 0, Math.PI * 2);
      ctx.stroke();
    }
    // ② 粒子飞散（固定角度/速度，无随机）
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * Math.PI * 2 + 0.35;
      const dist = r.h * 0.15 + p * r.h * (0.5 + (i % 3) * 0.12);
      const a = Math.max(0, 0.85 * (1 - p));
      ctx.fillStyle = i % 2 ? `rgba(255, 214, 90, ${a.toFixed(3)})` : `rgba(229, 57, 53, ${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, Math.max(0.5, 3 * (1 - p * 0.6)), 0, Math.PI * 2);
      ctx.fill();
    }
    // ③ 瓶身红色闪光（透明度随相位线性衰减，现有口径）
    const alpha = Math.max(0, 0.6 * (1 - p));
    if (alpha > 0.01) {
      ctx.fillStyle = `rgba(229, 57, 53, ${alpha.toFixed(3)})`;
      this.rr(r.x - 2, r.y - 2, r.w + 4, r.h + 4, r.w * 0.2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** 失败弹窗（PRD-玩法扩展 §2 B + PRD-限时与步数限制 F-06/F-10）：
   *  文案按 failReason 区分；「续杯 · 继续」消耗 revive（库存 0 置灰，仍可点 → 广告补给自动使用）*/
  drawFailPanel(state) {
    const { ctx } = this;
    const reason = (state.logic && state.logic.failReason) || 'bomb';
    const copy = {
      time: { title: '时间到！', desc: '倒计时归零，未能在时限内完成' },
      moves: { title: '步数用完！', desc: '步数已用尽，未能完成分装' },
      bomb: { title: '炸弹爆炸了！', desc: '引信倒计时归零，果汁瓶被引爆' },
    }[reason] || { title: '炸弹爆炸了！', desc: '引信倒计时归零，果汁瓶被引爆' };
    const hasRevive = !!state.inv && state.inv.revive > 0;
    ctx.save();
    ctx.fillStyle = 'rgba(43, 28, 12, 0.55)';
    ctx.fillRect(0, 0, this.W, this.H);
    const cw = 286;
    const ch = 236;
    const cx = (this.W - cw) / 2;
    const cy = (this.H - ch) / 2 - 30;
    ctx.fillStyle = '#FFF9F0';
    this.rr(cx, cy, cw, ch, 18);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#B22218';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(copy.title, this.W / 2, this.H / 2 - 96);
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = '#7A5C3E';
    ctx.fillText(copy.desc, this.W / 2, this.H / 2 - 66);
    // 主按钮「续杯 · 继续」：库存 0 置灰（点击仍弹广告确认浮层补 1 后自动使用）
    ctx.save();
    if (!hasRevive) ctx.globalAlpha = 0.35;
    this.drawTextButton(this.failReviveBtn, hasRevive ? '续杯 · 继续' : '续杯 · 看广告补充', {
      fill: '#FF9838',
      text: '#FFFFFF',
      size: 17,
      pressed: this.pressed === 'failReviveBtn',
    });
    ctx.restore();
    this.drawTextButton(this.failRestartBtn, '重开本关', {
      fill: 'rgba(255,255,255,0.92)',
      stroke: '#E8C9A0',
      text: '#8A6234',
      size: 16,
      pressed: this.pressed === 'failRestartBtn',
    });
    ctx.restore();
  }

  /** 条件锁瓶角标（R4）：锁形 + 完成进度「已完成/need」，矢量绘制 */
  drawCondLockBadge(rect, done, need) {
    const { ctx } = this;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y - 14; // 悬挂在瓶口上方（底板下沿留 4px 间隙），不遮挡瓶口
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
    const cy = rect.y - 14; // 悬挂在瓶口上方（底板下沿留 4px 间隙），不遮挡瓶口
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
    const cy = rect.y - 18; // 悬挂在瓶口上方，不遮挡瓶口
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
      // 道具化撤回（PRD-道具背包）：可撤 = 有步可撤 且 背包 undo 存量 > 0
      [this.undoBtn, '撤回', state.logic.undoStack.length > 0 && state.inv.undo > 0, state.inv.undo, 'iconUndo'],
      [this.shuffleBtn, '打乱', state.inv.shuffle > 0, state.inv.shuffle, 'iconShuffle'],
      [this.addBottleBtn, '加瓶', state.inv.addBottle > 0, state.inv.addBottle, 'iconAdd'],
      // 续杯（PRD-限时与步数限制 F-10）：库存展示位，消耗入口在失败弹窗（库存 0 置灰仍可点提示）
      [this.reviveBtn, '续杯', true, state.inv.revive || 0, 'iconRevive'],
      [this.restartBtn, '重开', true, 0, 'iconRestart'],
    ];
    for (const [btn, label, enabled, uses, icon] of entries) {
      ctx.save();
      ctx.globalAlpha = enabled ? 1 : 0.35;
      this.drawCircleButton(btn, label, {
        icon,
        // R2 生效中态：打乱选瓶模式时打乱钮呈现 active（与顶部文字提示双通道）
        active: btn === this.shuffleBtn && state.shuffleSelecting,
        // R1 按下态：按 key 匹配
        pressed:
          (btn === this.undoBtn && this.pressed === 'undoBtn') ||
          (btn === this.shuffleBtn && this.pressed === 'shuffleBtn') ||
          (btn === this.addBottleBtn && this.pressed === 'addBottleBtn') ||
          (btn === this.reviveBtn && this.pressed === 'reviveBtn') ||
          (btn === this.restartBtn && this.pressed === 'restartBtn'),
      });
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
    // 星级 + 最佳纪录（PRD-三星评价；纯文本渲染，winStats 由胶水层结算产出，此处只读）
    const ws = state.winStats;
    if (ws) {
      ctx.font = 'bold 22px sans-serif';
      ctx.fillStyle = '#F5A623';
      ctx.fillText('★'.repeat(ws.stars) + '☆'.repeat(3 - ws.stars), this.W / 2, cy + 90);
      ctx.font = 'bold 15px sans-serif';
      ctx.fillStyle = '#7A5C3E';
      ctx.fillText(`本关共 ${ws.moves} 步 · 最佳 ${ws.bestMoves} 步`, this.W / 2, cy + 116);
      if (ws.newRecord) {
        ctx.font = 'bold 13px sans-serif';
        ctx.fillStyle = '#F5A623';
        ctx.fillText('（新纪录！）', this.W / 2, cy + 138);
      }
    } else {
      ctx.font = 'bold 15px sans-serif';
      ctx.fillStyle = '#7A5C3E';
      ctx.fillText(`本关共 ${state.logic.moveCount} 步`, this.W / 2, cy + 92);
    }
    // 双按钮（方案 A）：左「返回」回主菜单（视觉弱化），右主按钮进下一关 / 末关回第 1 关
    const back = this.winBackBtn;
    back.x = cx + 16;
    back.y = cy + 158;
    this.drawTextButton(back, '返回', {
      fill: 'rgba(255,255,255,0.92)',
      stroke: '#E8C9A0',
      text: '#8A6234',
      size: 16,
      pressed: this.pressed === 'winBackBtn',
    });
    const b = this.nextBtn;
    b.x = cx + 130;
    b.y = cy + 158;
    b.w = 140;
    b.h = 46;
    this.drawTextButton(b, isLast ? '回到第 1 关' : '下一关', {
      fill: '#FF9838',
      text: '#FFFFFF',
      size: 16,
      pressed: this.pressed === 'nextBtn',
    });
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
