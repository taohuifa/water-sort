import GameLogic from './core/game.js';
import { buildLevelsFromConfig, parseJsonc, COLORS } from './core/levels.js';
import Renderer from './render/renderer.js';
import Anims from './render/anims.js';
import Audio from './render/audio.js';
import Ads from './runtime/ads.js';

const CLEARED_KEY = 'juicesort_cleared'; // 已通关关数（解锁进度）
const SOUND_KEY = 'juicesort_sound'; // 音效开关
const INTRO_KEY = 'juicesort_big_intro'; // 特殊关首进引导已读标志（R8/S-10）
// 配置文件用 .json 扩展名（微信代码包读取白名单要求），内容为 JSONC（带注释），
// 加载时由 parseJsonc 剥离注释
const LEVEL_CONFIG_PATH = 'assets/config/levels.json'; // 关卡难度曲线配置
const ADS_CONFIG_PATH = 'assets/config/ads.json'; // 广告位配置

// 外部配置加载（JSONC 内容带注释，加载时剥离注释）
const readConfig = (path) => parseJsonc(wx.getFileSystemManager().readFileSync(path, 'utf8'));
const LEVEL_CONFIG = readConfig(LEVEL_CONFIG_PATH);
const LEVELS = buildLevelsFromConfig(LEVEL_CONFIG);
const LEVEL_COUNT = LEVELS.length;
const ADS_CONFIG = readConfig(ADS_CONFIG_PATH);
// 特殊关标记（关卡选择页角标用，S-09）
const SPECIAL_FLAGS = LEVELS.map((l) => l.special === 'bigBottle');

/**
 * 游戏入口：Canvas 初始化、屏幕适配、场景状态机（menu/settings/game）、
 * 触摸交互、主循环、关卡切换与进度保存。
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
    this.renderer.setLevelCount(LEVEL_COUNT); // 渲染层不再直接依赖 levels 模块常量
    this.selected = -1;
    this.winPanel = false;
    this.winDelay = 0;
    this.scene = 'menu'; // 'menu' | 'settings' | 'levelSelect' | 'game'
    this.pauseOverlay = false;
    this.props = { shuffle: 1, addBottle: 1 }; // 道具剩余次数（每关重置）
    this.adConfirm = null; // 广告补给确认浮层：null | 'shuffle' | 'addBottle'
    this.shuffleSelecting = false; // 打乱选瓶模式：点瓶打乱其层序
    this.bigIntro = false; // 特殊关首进引导浮层（本机已读后不再弹出）
    this.bigIntroShown = wx.getStorageSync(INTRO_KEY) === true;

    // ---------- 音效（WebAudio 合成，开关持久化） ----------
    this.soundOn = wx.getStorageSync(SOUND_KEY) !== false; // 默认开
    this.audio = new Audio(this.soundOn);

    // ---------- 广告（开发模式自动降级直接发放） ----------
    this.ads = new Ads({ adUnitId: ADS_CONFIG.rewardedAdUnitId });

    // 进度恢复：cleared = 已通关关数，第 1 ~ cleared+1 关可挑战
    this.cleared = 0;
    const savedCleared = wx.getStorageSync(CLEARED_KEY);
    if (typeof savedCleared === 'number' && savedCleared > 0) {
      this.cleared = Math.min(savedCleared, LEVEL_COUNT);
    }

    this.bindTouch();

    // ---------- 主循环 ----------
    this.lastTs = Date.now();
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);

    // 自动化/调试挂载：供 miniprogram-automator evaluate 驱动场景切换与截图
    if (typeof GameGlobal !== 'undefined') GameGlobal.main = this;
  }

  /** 菜单 → 关卡选择页 */
  openLevelSelect() {
    this.scene = 'levelSelect';
    this.renderer.levelScroll = 0; // 每次进入选择页滚动复位
  }

  /** 关卡选择页 → 进入指定关卡（前一关通关才解锁） */
  selectLevel(idx) {
    if (idx < 0 || idx >= LEVEL_COUNT || idx > this.cleared) return; // 未解锁
    this.scene = 'game';
    this.pauseOverlay = false;
    this.loadLevel(idx);
  }

  loadLevel(idx) {
    this.levelIndex = idx;
    this.selected = -1;
    this.winPanel = false;
    this.winDelay = 0;
    this.props = { ...LEVELS[idx].props }; // 道具每关按曲线注入（≥10 关出厂 0，仅广告补给）
    this.shuffleSelecting = false;
    this.logic.loadLevel(LEVELS[idx]);
    this.refreshBoard(); // 容量/大瓶参数化布局
    this.renderer.displayedCompleted = 0;
    // 特殊关首进引导（本机已读不再弹，重置进度后恢复，R8/AC-12）
    this.bigIntro = !!LEVELS[idx].special && !this.bigIntroShown;
  }

  /** 按当前逻辑局面的瓶数/容量/大瓶参数重算布局（loadLevel / undo / addBottle 共用，S-08） */
  refreshBoard() {
    this.renderer.setupBoard(
      this.logic.bottles.length,
      this.logic.capacity,
      this.logic.bigIndex,
      this.logic.bigCapacity
    );
  }

  nextLevel() {
    this.loadLevel((this.levelIndex + 1) % LEVEL_COUNT);
  }

  // ---------- 触摸交互 ----------

  /**
   * 触摸事件：start 记录起点 → move 累计位移（关卡选择页驱动竖向滚动）→
   * end 时位移 < 8px 视为点击派发 onTap（拖动滚动不误触卡片）。
   */
  bindTouch() {
    wx.onTouchStart((e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      this._touchStart = { x: t.clientX, y: t.clientY };
      this._touchLastY = t.clientY;
      this._touchMoved = false;
    });
    wx.onTouchMove((e) => {
      const t = e.touches && e.touches[0];
      if (!t || !this._touchStart) return;
      const dy = t.clientY - this._touchLastY;
      this._touchLastY = t.clientY;
      if (Math.abs(t.clientY - this._touchStart.y) > 8) this._touchMoved = true;
      if (this.scene === 'levelSelect' && this._touchMoved) {
        this.renderer.scrollLevels(dy);
      }
    });
    wx.onTouchEnd(() => {
      if (this._touchStart && !this._touchMoved) {
        this.onTap(this._touchStart.x, this._touchStart.y);
      }
      this._touchStart = null;
    });
  }

  onTap(x, y) {
    // ---------- 菜单页 ----------
    if (this.scene === 'menu') {
      if (this.renderer.inRect(x, y, this.renderer.menuPlayBtn)) {
        this.audio.play('button');
        this.openLevelSelect();
      } else if (this.renderer.inRect(x, y, this.renderer.menuSettingsBtn)) {
        this.audio.play('button');
        this.scene = 'settings';
      }
      return;
    }

    // ---------- 关卡选择页 ----------
    if (this.scene === 'levelSelect') {
      if (this.renderer.inCircle(x, y, this.renderer.backBtn)) {
        this.audio.play('button');
        this.scene = 'menu';
        return;
      }
      for (let i = 0; i < this.renderer.levelBtns.length; i++) {
        if (this.renderer.inRect(x, y, this.renderer.levelBtns[i])) {
          this.audio.play('button');
          this.selectLevel(i);
          return;
        }
      }
      return;
    }

    // ---------- 设置页 ----------
    if (this.scene === 'settings') {
      if (this.renderer.inCircle(x, y, this.renderer.backBtn)) {
        this.audio.play('button');
        this.scene = 'menu';
      } else if (this.renderer.inRect(x, y, this.renderer.settingsSoundToggle)) {
        this.toggleSound();
      } else if (this.renderer.inRect(x, y, this.renderer.settingsResetBtn)) {
        this.audio.play('button');
        this.resetProgress();
      } else if (this.renderer.inRect(x, y, this.renderer.settingsKeyBtn)) {
        this.openKeyInput();
      }
      return;
    }

    // ---------- 游戏页 ----------
    if (this.winPanel) {
      if (this.renderer.inRect(x, y, this.renderer.nextBtn)) {
        this.audio.play('button');
        this.nextLevel();
      }
      return;
    }

    // 特殊关首进引导浮层（点「开始挑战」关闭并记住已读；期间屏蔽其他输入）
    if (this.bigIntro) {
      if (this.renderer.inRect(x, y, this.renderer.bigIntroBtn)) {
        this.audio.play('button');
        this.bigIntro = false;
        this.bigIntroShown = true;
        wx.setStorageSync(INTRO_KEY, true);
      }
      return;
    }

    // 广告补给确认浮层（看广告 / 取消）
    if (this.adConfirm) {
      if (this.renderer.inRect(x, y, this.renderer.adConfirmWatchBtn)) {
        const type = this.adConfirm;
        this.adConfirm = null;
        this.audio.play('button');
        // 看激励视频补充道具（开发模式直接发放）
        this.ads.watch(() => {
          this.props[type]++;
          this.renderer.showToast(type === 'shuffle' ? '已补充 1 次打乱' : '已补充 1 次加瓶');
        });
      } else if (this.renderer.inRect(x, y, this.renderer.adConfirmCancelBtn)) {
        this.adConfirm = null;
        this.audio.play('button');
      }
      return;
    }

    // 暂停浮层（继续 / 退出）
    if (this.pauseOverlay) {
      if (this.renderer.inRect(x, y, this.renderer.pauseResumeBtn)) {
        this.audio.play('button');
        this.pauseOverlay = false;
      } else if (this.renderer.inRect(x, y, this.renderer.pauseExitBtn)) {
        this.audio.play('button');
        this.pauseOverlay = false;
        this.scene = 'menu'; // 退出，返回开始菜单（进度保留）
      }
      return;
    }

    // 左上角返回按钮 → 弹出菜单
    if (this.renderer.inCircle(x, y, this.renderer.backBtn)) {
      this.audio.play('button');
      this.pauseOverlay = true;
      this.selected = -1;
      return;
    }

    // 倒水/飞行动画期间锁输入（抖动不影响）
    if (this.anims.blocking()) return;

    // 打乱选瓶模式：点瓶执行打乱，再点「打乱」取消，其他区域忽略
    if (this.shuffleSelecting) {
      if (this.renderer.inCircle(x, y, this.renderer.shuffleBtn)) {
        this.useShuffle();
        return;
      }
      const sel = this.renderer.getBottleAt(x, y, this.logic);
      if (sel >= 0) this.applyShuffleOne(sel);
      return;
    }

    // 底部按钮
    if (this.renderer.inCircle(x, y, this.renderer.undoBtn)) {
      this.audio.play('button');
      this.undo();
      return;
    }
    if (this.renderer.inCircle(x, y, this.renderer.shuffleBtn)) {
      this.useShuffle();
      return;
    }
    if (this.renderer.inCircle(x, y, this.renderer.addBottleBtn)) {
      this.useAddBottle();
      return;
    }
    if (this.renderer.inCircle(x, y, this.renderer.restartBtn)) {
      this.audio.play('button');
      this.loadLevel(this.levelIndex);
      return;
    }

    // 瓶子
    const idx = this.renderer.getBottleAt(x, y, this.logic);
    if (idx >= 0) this.tapBottle(idx);
  }

  /** 设置页：音效开关切换（持久化） */
  toggleSound() {
    this.soundOn = !this.soundOn;
    this.audio.setEnabled(this.soundOn);
    wx.setStorageSync(SOUND_KEY, this.soundOn);
    this.audio.play('button');
    this.renderer.showToast(this.soundOn ? '音效已开启' : '音效已关闭');
  }

  /** 清除关卡存档，解锁进度归零；特殊关引导已读标志一并重置（AC-12） */
  resetProgress() {
    wx.removeStorageSync(CLEARED_KEY);
    wx.removeStorageSync(INTRO_KEY);
    this.cleared = 0;
    this.bigIntroShown = false;
    this.renderer.showToast('已重置，将从第 1 关开始');
  }

  /**
   * 设置页兑换码输入：微信原生弹窗输入框（wx.showModal editable），
   * 确认后按 GM 指令处理。无该 API 的环境（Node 冒烟测试）降级为提示。
   */
  openKeyInput() {
    this.audio.play('button');
    if (typeof wx === 'undefined' || !wx.showModal) {
      this.renderer.showToast('当前环境不支持输入');
      return;
    }
    wx.showModal({
      title: '输入兑换码',
      editable: true,
      placeholderText: '请输入兑换码',
      success: (res) => {
        if (res.confirm) this.applyKey(res.content);
      },
    });
  }

  /** 校验输入的兑换码。unlock_all：解锁全部关卡（测试验收用），大小写不敏感。 */
  applyKey(code) {
    const key = String(code == null ? '' : code).trim().toLowerCase();
    if (!key) return;
    if (key === 'unlock_all') {
      this.cleared = LEVEL_COUNT;
      wx.setStorageSync(CLEARED_KEY, this.cleared);
      this.renderer.showToast(`兑换成功：已解锁全部 ${LEVEL_COUNT} 关`);
      this.audio.play('win');
    } else {
      this.renderer.showToast('兑换码无效');
      this.audio.play('invalid');
    }
  }

  tapBottle(idx) {
    const { logic } = this;

    // 锁定瓶：不可选中/切换选中，播放非法反馈（R4/R5 锁瓶交互）
    if (logic.isLocked(idx)) {
      this.audio.play('invalid');
      this.anims.addShake(idx);
      this.selected = -1;
      return;
    }

    // 未选中：选中非空瓶
    if (this.selected === -1) {
      if (logic.bottles[idx].length > 0) {
        this.selected = idx;
        this.audio.play('tap');
      }
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
        this.audio.play('pour');
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
    this.audio.play('invalid');
    this.anims.addShake(idx);
    // 大瓶瓶口颜色限制：错色倒入时明确提示限定色
    if (
      logic.special === 'bigBottle' &&
      idx === logic.bigIndex &&
      logic.bigColor >= 0 &&
      logic.bottles[this.selected] &&
      logic.bottles[this.selected].length > 0
    ) {
      const def = COLORS[logic.bigColor];
      if (def) this.renderer.showToast(`大瓶只收「${def.name}」`);
    }
    this.selected = logic.bottles[idx].length > 0 ? idx : -1;
  }

  /** 成品饮料从瓶位飞向货架 */
  startFly(bottleIdx, color) {
    this.audio.play('complete');
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
      // 加瓶/撤加瓶会改变瓶数，布局需重算（幂等）
      this.refreshBoard();
    }
  }

  /**
   * 道具·打乱（选瓶模式）：点击后进入选择态，由玩家点选要打乱的单个瓶子。
   * 次数在真正执行打乱时才扣减；用尽后转为广告补给点位。
   */
  useShuffle() {
    if (this.anims.blocking()) return;
    if (this.props.shuffle <= 0) {
      this.adConfirm = 'shuffle';
      return;
    }
    this.shuffleSelecting = !this.shuffleSelecting;
    this.selected = -1;
    this.renderer.showToast(this.shuffleSelecting ? '点选一个瓶子，打乱它的层次' : '已取消打乱');
  }

  /** 执行选瓶打乱（失败则保持选择态，可换瓶重试） */
  applyShuffleOne(idx) {
    if (this.logic.shuffleOne(idx)) {
      this.audio.play('button');
      this.props.shuffle--;
      this.shuffleSelecting = false;
      this.renderer.showToast('已打乱该瓶');
    } else {
      this.audio.play('invalid');
      this.renderer.showToast('空瓶或纯色瓶无法打乱');
    }
  }

  /** 道具·加瓶子（用尽后转为广告补给点位） */
  useAddBottle() {
    if (this.anims.blocking()) return;
    if (this.props.addBottle <= 0) {
      this.adConfirm = 'addBottle';
      return;
    }
    if (this.logic.addBottle()) {
      this.audio.play('button');
      this.props.addBottle--;
      this.selected = -1;
      this.refreshBoard();
      this.renderer.showToast('已增加一个空瓶');
    }
  }

  // ---------- 主循环 ----------

  tick() {
    const now = Date.now();
    const dt = Math.min((now - this.lastTs) / 1000, 0.05);
    this.lastTs = now;

    this.anims.update(dt);

    // 通关判定（等所有动画落地后再弹面板）
    if (
      this.scene === 'game' &&
      this.logic.isWin() &&
      !this.winPanel &&
      !this.pauseOverlay &&
      this.anims.allDone()
    ) {
      this.winDelay += dt;
      if (this.winDelay > 0.45) {
        this.winPanel = true;
        this.audio.play('win');
        // 记录解锁进度：打通本关才能挑战下一关
        const newCleared = Math.min(this.levelIndex + 1, LEVEL_COUNT);
        if (newCleared > this.cleared) {
          this.cleared = newCleared;
          wx.setStorageSync(CLEARED_KEY, this.cleared);
        }
      }
    }

    this.renderer.draw({
      scene: this.scene,
      pauseOverlay: this.pauseOverlay,
      adConfirm: this.adConfirm,
      soundOn: this.soundOn,
      cleared: this.cleared,
      hasProgress: this.cleared > 0,
      props: this.props,
      logic: this.logic,
      selected: this.selected,
      anims: this.anims,
      winPanel: this.winPanel,
      levelIndex: this.levelIndex,
      shuffleSelecting: this.shuffleSelecting,
      stuck: this.scene === 'game' && !this.logic.hasAnyMove(),
      bigIntro: this.bigIntro,
      specials: SPECIAL_FLAGS,
    });

    requestAnimationFrame(this.tick);
  }
}
