import GameLogic from './core/game.js';
import { LEVELS } from './core/levels.js';
import Renderer from './render/renderer.js';
import Anims from './render/anims.js';

const LEVEL_KEY = 'juicesort_level';

/**
 * 游戏入口：Canvas 初始化、屏幕适配、触摸交互、主循环、关卡切换与进度保存。
 * 交互规则（方案 2.2）：点源瓶选中 → 点目标瓶倒水；点自己取消；非法则抖动提示。
 */
export default class Main {
  constructor() {
    // ---------- Canvas 与屏幕适配 ----------
    const canvas = wx.createCanvas();
    const ctx = canvas.getContext('2d');
    const info = wx.getSystemInfoSync();
    const dpr = Math.min(info.pixelRatio || 2, 2);
    this.screenW = info.screenWidth;
    this.screenH = info.screenHeight;
    canvas.width = Math.round(this.screenW * dpr);
    canvas.height = Math.round(this.screenH * dpr);
    ctx.scale(dpr, dpr);

    // ---------- 模块组装 ----------
    this.logic = new GameLogic();
    this.anims = new Anims();
    this.renderer = new Renderer(ctx, this.screenW, this.screenH);
    this.selected = -1;
    this.winPanel = false;
    this.winDelay = 0;

    // 进度恢复（退出自动保存关卡进度）
    this.levelIndex = 0;
    const saved = wx.getStorageSync(LEVEL_KEY);
    if (typeof saved === 'number' && saved >= 0 && saved < LEVELS.length) {
      this.levelIndex = saved;
    }

    this.loadLevel(this.levelIndex);
    this.bindTouch();

    // ---------- 主循环 ----------
    this.lastTs = Date.now();
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }

  loadLevel(idx) {
    this.levelIndex = idx;
    this.selected = -1;
    this.winPanel = false;
    this.winDelay = 0;
    this.logic.loadLevel(LEVELS[idx]);
    this.renderer.setupBoard(this.logic.bottles.length);
    this.renderer.displayedCompleted = 0;
    wx.setStorageSync(LEVEL_KEY, idx);
  }

  nextLevel() {
    this.loadLevel((this.levelIndex + 1) % LEVELS.length);
  }

  // ---------- 触摸交互 ----------

  bindTouch() {
    wx.onTouchStart((e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      this.onTap(t.clientX, t.clientY);
    });
  }

  onTap(x, y) {
    // 通关面板
    if (this.winPanel) {
      if (this.renderer.inRect(x, y, this.renderer.nextBtn)) this.nextLevel();
      return;
    }
    // 倒水/飞行动画期间锁输入（抖动不影响）
    if (this.anims.blocking()) return;

    // 底部按钮
    if (this.renderer.inCircle(x, y, this.renderer.undoBtn)) {
      this.undo();
      return;
    }
    if (this.renderer.inCircle(x, y, this.renderer.restartBtn)) {
      this.loadLevel(this.levelIndex);
      return;
    }

    // 瓶子
    const idx = this.renderer.getBottleAt(x, y);
    if (idx >= 0) this.tapBottle(idx);
  }

  tapBottle(idx) {
    const { logic } = this;

    // 未选中：选中非空瓶
    if (this.selected === -1) {
      if (logic.bottles[idx].length > 0) this.selected = idx;
      return;
    }

    // 点自己：取消选中
    if (this.selected === idx) {
      this.selected = -1;
      return;
    }

    // 合法倒水
    if (logic.canPour(this.selected, idx) > 0) {
      const from = this.selected;
      const to = idx;
      const fromContentBefore = logic.bottles[from].slice();
      const toContentBefore = logic.bottles[to].slice();
      const res = logic.pour(from, to);
      this.selected = -1;
      if (res) {
        this.anims.addPour({
          from,
          to,
          color: res.color,
          amount: res.amount,
          fromContentBefore,
          toContentBefore,
          onDone: () => {
            if (res.completedColor >= 0) this.startFly(to, res.completedColor);
          },
        });
      }
      return;
    }

    // 非法：抖动提示 + 切换选中（目标可作源时）
    this.anims.addShake(idx);
    this.selected = logic.bottles[idx].length > 0 ? idx : -1;
  }

  /** 成品饮料从瓶位飞向货架 */
  startFly(bottleIdx, color) {
    const rect = this.renderer.bottleRect(bottleIdx);
    const slot = this.renderer.displayedCompleted;
    this.anims.addFly({
      bottleIdx,
      color,
      slot,
      x0: rect.x + rect.w / 2,
      y0: rect.y + rect.h * 0.4,
      onDone: () => {
        this.renderer.displayedCompleted = this.logic.completed.length;
      },
    });
  }

  undo() {
    if (this.logic.undo()) {
      this.selected = -1;
      this.renderer.displayedCompleted = this.logic.completed.length;
    }
  }

  // ---------- 主循环 ----------

  tick() {
    const now = Date.now();
    const dt = Math.min((now - this.lastTs) / 1000, 0.05);
    this.lastTs = now;

    this.anims.update(dt);

    // 通关判定（等所有动画落地后再弹面板）
    if (this.logic.isWin() && !this.winPanel && this.anims.allDone()) {
      this.winDelay += dt;
      if (this.winDelay > 0.45) this.winPanel = true;
    }

    this.renderer.draw({
      logic: this.logic,
      selected: this.selected,
      anims: this.anims,
      winPanel: this.winPanel,
      levelIndex: this.levelIndex,
      stuck: !this.logic.hasAnyMove(),
    });

    requestAnimationFrame(this.tick);
  }
}
