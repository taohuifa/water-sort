import GameLogic, { BOMB_REVIVE_BONUS, MOVE_REVIVE_BONUS, TIME_REVIVE_BONUS } from './core/game.js';
import { buildLevelsFromConfig, parseJsonc, COLORS } from './core/levels.js';
import { applyGrant, canConsume, consume, mergeInventory } from './core/inventory.js';
import { calcStars, mergeRecord, sanitizeRecord } from './core/stars.js';
import Renderer from './render/renderer.js';
import Anims from './render/anims.js';
import Audio from './render/audio.js';
import Ads from './runtime/ads.js';

const CLEARED_KEY = 'juicesort_cleared'; // 已通关关数（解锁进度）
const SOUND_KEY = 'juicesort_sound'; // 音效开关
const INTRO_KEY = 'juicesort_big_intro'; // 特殊关首进引导已读标志（R8/S-10）
const INV_KEY = 'juicesort_inventory'; // 全局道具背包（PRD-道具背包）
const GRANT_KEY = 'juicesort_granted'; // 首入赠送已发放标记（{[关卡号]: true}）
const BEST_KEY = 'juicesort_best'; // 每关最佳纪录（{[关卡号]: {bestMoves, stars}}，PRD-三星评价）
// 配置文件用 .json 扩展名（微信代码包读取白名单要求），内容为 JSONC（带注释），
// 加载时由 parseJsonc 剥离注释
const LEVEL_CONFIG_PATH = 'assets/config/levels.json'; // 关卡难度曲线配置
const ADS_CONFIG_PATH = 'assets/config/ads.json'; // 广告位配置
// 载入分帧预算（PRD-关卡生成异步化与加载界面 F-03）：每帧喂给 stepGenerate 的毫秒数
// （60fps 帧预算 16.7ms 的一半，留余量给渲染；单次 attempt 原子执行可瞬时超出，PRD 已知取舍）
const LOAD_SLICE_MS = 6;

// 运行环境判定：正式版 = release；开发者工具/体验版/Node 冒烟桩读不到 → 非 release
// （容错与调试能力只在非正式版保留，兑换码后门同理）
const IS_RELEASE = (() => {
  try {
    return (
      typeof wx !== 'undefined' &&
      wx.getAccountInfoSync &&
      wx.getAccountInfoSync().miniProgram.envVersion === 'release'
    );
  } catch (e) {
    return false;
  }
})();

// 外部配置加载（JSONC 内容带注释，加载时剥离注释）。
// 失败降级到内置兜底：配置损坏不再白屏（关卡表降为 1 关可玩、广告走开发模式直发）
const readConfig = (path, fallback) => {
  try {
    return parseJsonc(wx.getFileSystemManager().readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`[config] ${path} 加载失败，降级使用内置兜底`, e);
    return fallback;
  }
};
const LEVEL_CONFIG = readConfig(LEVEL_CONFIG_PATH, {
  levelCount: 1,
  defaults: { colors: 4, empties: 2 },
});
const LEVELS = buildLevelsFromConfig(LEVEL_CONFIG);
const LEVEL_COUNT = LEVELS.length;
const ADS_CONFIG = readConfig(ADS_CONFIG_PATH, { rewardedAdUnitId: '' });
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
    this.failPanel = false; // 失败弹窗（PRD-玩法扩展 §2 B：重开 / 广告复活）
    this.failDelay = 0; // 引爆闪光累计时长（0.6s 后弹失败面板）
    this.failFlashIdx = -1; // 引爆瓶下标（-1 = 无闪光；时间/步数失败无闪光，仅延时弹窗）
    this.failLatch = false; // 失败检测门闩（首次 isFailed 记录闪光/计时起点，避免时间/步数失败每帧重置）
    this.scene = 'menu'; // 'menu' | 'settings' | 'levelSelect' | 'game'
    this.pauseOverlay = false;
    this.inv = mergeInventory(wx.getStorageSync(INV_KEY)); // 全局道具背包（PRD-道具背包，废除每关出厂 props）
    this.granted = this._readGranted(); // 首入赠送已发放标记
    this.best = this._readBest(); // 每关最佳纪录（PRD-三星评价，{[关卡号]: {bestMoves, stars}}）
    this.winStats = null; // 本次通关结算态 {moves, stars, bestMoves, newRecord}（loadLevel 时清零）
    this.adConfirm = null; // 广告补给确认浮层：null | 'shuffle' | 'addBottle'
    this.shuffleSelecting = false; // 打乱选瓶模式：点瓶打乱其层序
    this.bigIntro = false; // 特殊关首进引导浮层（本机已读后不再弹出）
    this.bigIntroShown = wx.getStorageSync(INTRO_KEY) === true;
    this._dbgSig = ''; // 调试状态快照签名（devtools automation 观测用）

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

    // 自动化/调试挂载：供 miniprogram-automator evaluate 驱动场景切换与截图（正式版不挂载）
    if (!IS_RELEASE && typeof GameGlobal !== 'undefined') GameGlobal.main = this;
    this.debugBridge = !IS_RELEASE; // 调试状态桥开关：正式版关闭（省去每 2s 心跳写 storage）
  }

  /** 菜单 → 关卡选择页 */
  openLevelSelect() {
    this.scene = 'levelSelect';
    this.renderer.levelScroll = 0; // 每次进入选择页滚动复位
  }

  /** 关卡选择页 → 进入指定关卡（前一关通关才解锁） */
  selectLevel(idx) {
    if (idx < 0 || idx >= LEVEL_COUNT || idx > this.cleared) return; // 未解锁
    this.beginLevelLoad(idx);
  }

  /**
   * 统一载入入口（PRD-关卡生成异步化与加载界面 F-03）：记录待载关 → loading 场景分帧生成。
   * selectLevel / nextLevel / 重开 / 复活重开全部走这里；对局态先清零（加载页不带旧局残影）。
   */
  beginLevelLoad(idx) {
    this.pendingLevel = idx;
    this.levelIndex = idx;
    this.selected = -1;
    this.winPanel = false;
    this.winDelay = 0;
    this.failPanel = false; // 失败流程态随关卡重置（PRD-玩法扩展 §2 B）
    this.failDelay = 0;
    this.failFlashIdx = -1;
    this.failLatch = false;
    this.shuffleSelecting = false;
    this.winStats = null; // 新局清空上一局结算态（PRD-三星评价）
    this.scene = 'loading';
    this.pauseOverlay = false;
    this._loadPainted = false; // 首帧只画不推进：保证每关至少渲染一帧加载页（用户拍板：所有关卡都渲染）
    this.logic.beginGenerate(LEVELS[idx]);
  }

  /** 帧驱动：推进生成预算片；完成即收尾（首入赠送 / 布局 / 特殊关引导）切 game。返回进度 {done, attempts, elapsedMs} */
  stepLoading() {
    const r = this.logic.stepGenerate(LOAD_SLICE_MS);
    if (r.done) {
      const idx = this.pendingLevel;
      this._grantFirstEntry(idx); // 首入赠送（解锁后第一次进入，防重复发放）
      this.refreshBoard(); // 容量/大瓶参数化布局
      this.renderer.displayedCompleted = 0;
      // 特殊关首进引导（本机已读不再弹，重置进度后恢复，R8/AC-12）
      this.bigIntro = !!LEVELS[idx].special && !this.bigIntroShown;
      this.scene = 'game';
    }
    return r;
  }

  /** 同步载入（测试/外部工具用）：一次跑满生成再收尾，行为与旧 loadLevel 完全一致 */
  loadLevel(idx) {
    this.beginLevelLoad(idx);
    while (!this.logic.stepGenerate(Infinity).done);
    this.stepLoading(); // done 必真，仅触发收尾切 game
  }

  // ---------- 道具背包（PRD-道具背包，账本与持久化归胶水层，core 只管局面） ----------

  /** 读首入赠送标记存档（旧档无此 key / 值非法时回退空表） */
  _readGranted() {
    try {
      const saved = wx.getStorageSync(GRANT_KEY);
      return saved && typeof saved === 'object' ? saved : {};
    } catch (e) {
      return {};
    }
  }

  /** 背包持久化（每次发放 / 消耗 / 广告补给后调用） */
  saveInventory() {
    try {
      wx.setStorageSync(INV_KEY, this.inv);
    } catch (e) { /* storage 不可用时静默（背包仍在内存生效） */ }
  }

  /** 首入赠送：该关配置了 grant 且未发放过 → 叠加进背包，记录并持久化（一次性） */
  _grantFirstEntry(idx) {
    const lv = LEVELS[idx];
    const no = lv.level;
    if (this.granted[no] || !lv.grant) return;
    this.inv = applyGrant(this.inv, lv.grant);
    this.granted[no] = true;
    // 写序（F-03「宁重发不吞发」）：先写库存、后写标记 —— 两写之间中断时，
    // 下次进关会重发（可接受），而不是标记在先导致赠送被吞（不可接受）
    this.saveInventory();
    try {
      wx.setStorageSync(GRANT_KEY, this.granted);
    } catch (e) { /* 同上 */ }
  }

  // ---------- 三星评价（PRD-玩法扩展 §2 C：账本与持久化归胶水层，星级计算归 core） ----------

  /** 读最佳纪录存档（旧档无此 key / 条目非法时逐条清洗剔除） */
  _readBest() {
    const out = {};
    try {
      const saved = wx.getStorageSync(BEST_KEY);
      if (saved && typeof saved === 'object') {
        for (const no of Object.keys(saved)) {
          const rec = sanitizeRecord(saved[no]);
          if (rec) out[no] = rec;
        }
      }
    } catch (e) { /* storage 不可用时静默（空表起局） */ }
    return out;
  }

  /** 通关结算（winPanel 弹出时机调用）：算星级 + 更新最佳纪录（更优才写档） */
  _recordResult() {
    const lv = LEVELS[this.levelIndex];
    const moves = this.logic.moveCount;
    const stars = calcStars(moves, lv.par);
    const no = lv.level;
    const merged = mergeRecord(this.best[no] || null, moves, stars);
    this.winStats = {
      moves,
      stars,
      bestMoves: merged ? merged.bestMoves : this.best[no].bestMoves,
      newRecord: !!merged,
    };
    if (merged) {
      this.best[no] = merged;
      try {
        wx.setStorageSync(BEST_KEY, this.best);
      } catch (e) { /* storage 不可用时静默（纪录仍在内存生效） */ }
    }
  }

  /** 按当前逻辑局面的瓶数/容量/大瓶参数重算布局（loadLevel / undo / addBottle 共用，S-08） */
  refreshBoard() {
    this.renderer.setupBoard(
      this.logic.bottles.length,
      this.logic.capacity,
      this.logic.bigIndex,
      this.logic.bigCapacity,
      this.logic.mix ? this.logic.caps : null
    );
  }

  nextLevel() {
    this.beginLevelLoad((this.levelIndex + 1) % LEVEL_COUNT);
  }

  // ---------- 触摸交互 ----------

  /**
   * 触摸事件：start 记录起点 + 对当前场景按钮命中检测记录按下态（R1，仅视觉反馈，
   * 不影响点击派发时序）→ move 累计位移（关卡选择页驱动竖向滚动，超阈值清按下态）→
   * end 时位移 < 8px 视为点击派发 onTap（拖动滚动不误触卡片）并清除按下态。
   */
  bindTouch() {
    wx.onTouchStart((e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      this._touchStart = { x: t.clientX, y: t.clientY };
      this._touchLastY = t.clientY;
      this._touchMoved = false;
      // 按下态（R1）：命中检测记录 pressed，分支顺序与 onTap 一致
      this.renderer.pressed = this.renderer.hitButton(t.clientX, t.clientY, {
        scene: this.scene,
        winPanel: this.winPanel,
        failPanel: this.failPanel,
        bigIntro: this.bigIntro,
        adConfirm: this.adConfirm,
        pauseOverlay: this.pauseOverlay,
        cleared: this.cleared, // 解锁进度：未解锁关卡卡片无按下态（S-04）
      });
    });
    wx.onTouchMove((e) => {
      const t = e.touches && e.touches[0];
      if (!t || !this._touchStart) return;
      const dy = t.clientY - this._touchLastY;
      this._touchLastY = t.clientY;
      if (Math.abs(t.clientY - this._touchStart.y) > 8) {
        this._touchMoved = true;
        this.renderer.pressed = null; // 位移超阈值（与 onTap 取消阈值同源）清除按下态
      }
      if (this.scene === 'levelSelect' && this._touchMoved) {
        this.renderer.scrollLevels(dy);
      }
    });
    wx.onTouchEnd(() => {
      this.renderer.pressed = null; // 抬手即清除按下态（onTap 派发逻辑不变）
      if (this._touchStart && !this._touchMoved) {
        this.onTap(this._touchStart.x, this._touchStart.y);
      }
      this._touchStart = null;
    });
    wx.onTouchCancel(() => {
      this.renderer.pressed = null; // 触摸被打断同样清除（AC-08 无残留）
      this._touchStart = null;
    });
  }

  onTap(x, y) {
    this.renderer.pressed = null; // 场景切换 / 浮层开关均由 onTap 分支置位，入口统一清按下态（AC-08）
    // loading 场景吞掉一切点击（PRD 拍板 Q3：无返回/取消，生成期间不接受交互）
    if (this.scene === 'loading') return;
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
      } else if (this.renderer.inRect(x, y, this.renderer.winBackBtn)) {
        this.audio.play('button');
        this.winPanel = false;
        this.scene = 'menu'; // 返回开始菜单（进度保留，与暂停退出一致）
      }
      return;
    }

    // 广告补给确认浮层（看广告 / 取消）——置于失败弹窗之前：续杯库存 0 的补给浮层
    // 覆盖在失败弹窗之上（adConfirm 与 failReviveBtn 同坐标，必须先于 failPanel 分支派发）
    if (this.adConfirm) {
      if (this.renderer.inRect(x, y, this.renderer.adConfirmWatchBtn)) {
        const type = this.adConfirm;
        this.adConfirm = null;
        this.audio.play('button');
        // 看激励视频补充道具（开发模式直接发放）；续杯补给后自动使用（PRD-限时与步数限制 F-10）
        const label = { undo: '撤回', shuffle: '打乱', addBottle: '加瓶', revive: '续杯' }[type] || type;
        this.ads.watch(() => {
          this.inv[type] = (this.inv[type] || 0) + 1;
          this.saveInventory();
          if (type === 'revive') this._useRevive();
          else this.renderer.showToast(`已补充 1 次${label}`);
        });
      } else if (this.renderer.inRect(x, y, this.renderer.adConfirmCancelBtn)) {
        this.adConfirm = null;
        this.audio.play('button');
      }
      return;
    }

    // 失败弹窗（PRD-玩法扩展 §2 B + PRD-限时与步数限制 F-10）：重开本关 / 续杯继续
    if (this.failPanel) {
      if (this.renderer.inRect(x, y, this.renderer.failRestartBtn)) {
        this.audio.play('button');
        this.beginLevelLoad(this.levelIndex); // 重开：bombs/timers/timeLeft/moveLimit 随关卡重建
      } else if (this.renderer.inRect(x, y, this.renderer.failReviveBtn)) {
        this.audio.play('button');
        // 统一续杯语义：库存 > 0 消耗 1 个复活；库存 0 → 广告确认浮层（补 1 后自动使用）
        if (canConsume(this.inv, 'revive')) this._useRevive();
        else this.adConfirm = 'revive';
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

    // 广告补给确认浮层已提前至失败弹窗之前处理（续杯补给覆盖失败弹窗，见上）

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
    if (this.renderer.inCircle(x, y, this.renderer.reviveBtn)) {
      // 续杯在局内仅作库存展示（消耗入口在失败弹窗，PRD-限时与步数限制 F-10）
      this.audio.play('button');
      this.renderer.showToast(
        canConsume(this.inv, 'revive') ? '失败后点「续杯 · 继续」消耗' : '续杯不足：失败弹窗可看广告补充'
      );
      return;
    }
    if (this.renderer.inCircle(x, y, this.renderer.restartBtn)) {
      this.audio.play('button');
      this.beginLevelLoad(this.levelIndex);
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

  /** 清除关卡存档，解锁进度归零；特殊关引导已读标志、最佳星数纪录与首入赠送标记一并重置（AC-12；背包资产保留） */
  resetProgress() {
    wx.removeStorageSync(CLEARED_KEY);
    wx.removeStorageSync(INTRO_KEY);
    wx.removeStorageSync(BEST_KEY);
    wx.removeStorageSync(GRANT_KEY); // 赠送标记重置：章首/每 5 关赠送可重新获得（F-04 用户拍板口径）
    this.cleared = 0;
    this.bigIntroShown = false;
    this.best = {};
    this.granted = {};
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

  /** 校验输入的兑换码。unlock_all：解锁全部关卡（测试验收用），大小写不敏感。
   *  正式版一律无效（GM 后门只在开发工具/体验版可用）。 */
  applyKey(code) {
    const key = String(code == null ? '' : code).trim().toLowerCase();
    if (!key) return;
    if (IS_RELEASE) {
      this.renderer.showToast('兑换码无效');
      this.audio.play('invalid');
      return;
    }
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

    // 失败态：禁止瓶子操作（除撤回/重开，PRD-玩法扩展 §2 B），反馈与锁定瓶同级
    if (logic.isFailed()) {
      this.audio.play('invalid');
      this.anims.addShake(idx);
      this.selected = -1;
      return;
    }

    // 锁定瓶：不可选中/切换选中，播放非法反馈（R4/R5 锁瓶交互）
    if (logic.isLocked(idx)) {
      this.audio.play('invalid');
      this.anims.addShake(idx);
      this.selected = -1;
      return;
    }

    // 遮盖瓶：未揭示不可选中/交互，非法反馈与锁定瓶同级（PRD-玩法扩展 §2 A）
    if (logic.isCovered(idx)) {
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
            if (res.guardBlocked) {
              // 回收守卫拦截（PRD-按钮反馈与混合关回收守卫 FR-06）：动画完成后提示，每次触发都提示
              this.renderer.showToast(`这瓶装不下该色全部 ${this.logic.capOf(to)} 层，暂不收走`);
            }
            if (res.completedColor >= 0) {
              // 满瓶先打完成标记（满色瓶 + ✓ 徽章停留展示），标记结束后再起飞去货架
              this.audio.play('complete');
              this.anims.addBadge({
                bottleIdx: to,
                layers: toContentBefore.concat(new Array(res.amount).fill(res.color)),
                onDone: () => this.startFly(to, res.completedColor),
              });
            }
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

  /** 成品饮料从瓶位飞向货架（完成音效已前移至徽章弹出时机） */
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

  /** 撤回（道具化）：消耗背包 undo 1 个；耗尽转广告补给点位；undoStack 空时无效 */
  undo() {
    if (!canConsume(this.inv, 'undo')) {
      if (this.logic.undoStack.length > 0) this.adConfirm = 'undo';
      return;
    }
    if (this.logic.undoStack.length === 0) return;
    if (this.logic.undo()) {
      consume(this.inv, 'undo');
      this.saveInventory();
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
    if (this.logic.isFailed()) {
      this.audio.play('invalid'); // 失败态点击反馈（与 tapBottle 口径一致，F-02）
      return;
    }
    if (!canConsume(this.inv, 'shuffle')) {
      this.adConfirm = 'shuffle';
      return;
    }
    this.shuffleSelecting = !this.shuffleSelecting;
    this.selected = -1;
    this.renderer.showToast(this.shuffleSelecting ? '点选一个瓶子，打乱它的层次' : '已取消打乱');
  }

  /** 执行选瓶打乱（失败则保持选择态，可换瓶重试；成功才扣背包） */
  applyShuffleOne(idx) {
    if (this.logic.shuffleOne(idx)) {
      this.audio.play('button');
      consume(this.inv, 'shuffle');
      this.saveInventory();
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
    if (this.logic.isFailed()) {
      this.audio.play('invalid'); // 失败态点击反馈（与 tapBottle 口径一致，F-02）
      return;
    }
    if (!canConsume(this.inv, 'addBottle')) {
      this.adConfirm = 'addBottle';
      return;
    }
    if (this.logic.addBottle()) {
      this.audio.play('button');
      consume(this.inv, 'addBottle');
      this.saveInventory();
      this.selected = -1;
      this.refreshBoard();
      this.renderer.showToast('已增加一个空瓶');
    }
  }

  /**
   * 续杯·继续（PRD-限时与步数限制 F-10 统一复活语义，替代旧「undo×3 + 引信重置」广告复活）：
   * 消耗背包 revive 1 个 → core applyRevive 按 failReason 加成（时 +60 / 步限上限 +10 / 引信 +10 封顶初值）
   * → 解除失败态继续（不回退局面）。库存判定与广告补给入口在 onTap 分支。
   */
  _useRevive() {
    const reason = this.logic.applyRevive();
    consume(this.inv, 'revive');
    this.saveInventory();
    this.failPanel = false;
    this.failDelay = 0;
    this.failFlashIdx = -1;
    this.failLatch = false;
    this.selected = -1;
    this.renderer.displayedCompleted = this.logic.completed.length;
    // bomb 加成走 BOMB_REVIVE_BONUS（与 MOVE_REVIVE_BONUS 当前同值，独立调参）
    const bonus = { time: `时间 +${TIME_REVIVE_BONUS} 秒`, moves: `步数上限 +${MOVE_REVIVE_BONUS}`, bomb: `引信 +${BOMB_REVIVE_BONUS}` }[reason] || '继续';
    this.renderer.showToast(`续杯成功！${bonus}`);
  }

  // ---------- 主循环 ----------

  /**
   * 调试状态快照（devtools automation 观测桥，协议见 skill ADAPTATION.md）：
   * 逻辑层与渲染层分离，外部工具经渲染层 wx.getStorageSync 读本快照判断场景。
   * 状态签名变化立即写；稳态下每 2s 心跳刷新时间戳（供读取方判活）。
   * btns 为自描述按钮表（工具零硬编码）：
   *   对象型 {xy, scenes, when?}——scenes=可用场景；when={字段:true=真值/其他=严格相等}
   *   数组型 {alias, base, list, scenes}——tbtn <alias> <序号>（base 起算）
   */
  syncDebugState() {
    const R = this.renderer;
    const cRect = (b) => (b ? [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)] : null);
    const cCircle = (b) => (b ? [Math.round(b.x), Math.round(b.y)] : null);
    const moves = this.logic.moveCount;
    const par = (LEVELS[this.levelIndex] || {}).par || 0;
    const stars = this.winStats ? this.winStats.stars : 0; // 结算星级（PRD-三星评价）
    // 遮盖瓶（PRD-玩法扩展 §2 A）：与 bottles 平行的遮盖摘要（未揭示瓶 = 剩余层数，其余 0）
    // + 解封计数器（= 已收集成品数）；二者入签名，揭示瞬间即写
    const covers = this.logic.bottles.map((_, i) => (this.logic.isCovered(i) ? this.logic.coverLeft() : 0));
    const completedCount = this.logic.completed.length;
    // 炸弹瓶（PRD-玩法扩展 §2 B）：与 bottles 平行的炸弹摘要（活跃炸弹 = 剩余步数，其余 0）+ 失败态
    const bombs = this.logic.bottles.map((_, i) => {
      const t = this.logic.bombTimerOf(i);
      return t >= 0 ? t : 0;
    });
    const fail = this.failPanel;
    // 限时/步限（PRD-限时与步数限制 F-07）：剩余秒（整数）+ 步限上限 + 失败原因，全部入签名
    const timeLeft = Math.max(0, Math.round(this.logic.timeLeft));
    const moveLimit = this.logic.moveLimit;
    const failReason = this.logic.failReason || '';
    // 生成进度（PRD-关卡生成异步化 F-05）：loading 场景观测用；签名只含 attempts（attempt 间即写），
    // elapsedMs 变化太频不入签名（依赖 attempts 变化或 2s 心跳捎带刷新）
    const gp = this.scene === 'loading' ? this.logic.genProgress() : null;
    const genAttempts = gp ? gp.attempts : 0;
    const genElapsedMs = gp ? Math.round(gp.elapsedMs) : 0;
    const sig = [this.scene, this.pauseOverlay, this.levelIndex, this.selected,
      this.winPanel, this.adConfirm, this.shuffleSelecting, this.cleared,
      this.bigIntro, R.levelScroll,
      this.inv.undo, this.inv.shuffle, this.inv.addBottle, this.inv.revive,
      moves, par, stars, covers.join(','), completedCount,
      bombs.join(','), fail, timeLeft, moveLimit, failReason, genAttempts].join('|');
    const now = Date.now();
    if (sig === this._dbgSig && now - this._dbgTs < 2000) return;
    this._dbgSig = sig;
    this._dbgTs = now;
    try {
      wx.setStorageSync('__dbg_state', {
        scene: this.scene, pause: this.pauseOverlay, level: this.levelIndex,
        sel: this.selected, win: this.winPanel, ad: this.adConfirm,
        shuf: this.shuffleSelecting, cleared: this.cleared, intro: this.bigIntro, t: now,
        invUndo: this.inv.undo, invShuffle: this.inv.shuffle, invAddBottle: this.inv.addBottle,
        invRevive: this.inv.revive, // 续杯库存（PRD-限时与步数限制 F-07）
        moves, par, stars, // 三星评价：当前步数 / 关卡 par / 结算星级（非结算态 0）
        timeLeft, moveLimit, failReason, // 限时/步限：剩余秒（整数）/ 上限（0=无限）/ 失败原因（''=未失败）
        covers, completedCount, // 遮盖瓶：各瓶剩余遮盖层数摘要（0=无遮盖或已揭示）/ 解封计数器
        bombs, fail, // 炸弹瓶：各瓶剩余引信摘要（0=无炸弹或已拆除）/ 失败弹窗态
        genAttempts, genElapsedMs, // 生成进度（loading 场景观测；非 loading 为 0/0）
        btns: {
          play: {xy: cRect(R.menuPlayBtn), scenes: ['menu']},
          settings: {xy: cRect(R.menuSettingsBtn), scenes: ['menu']},
          back: {xy: cCircle(R.backBtn), scenes: ['levelSelect', 'settings', 'game']},
          pause_resume: {xy: cRect(R.pauseResumeBtn), scenes: ['game'], when: {pause: true}},
          pause_exit: {xy: cRect(R.pauseExitBtn), scenes: ['game'], when: {pause: true}},
          next: {xy: cRect(R.nextBtn), scenes: ['game'], when: {win: true}},
          win_back: {xy: cRect(R.winBackBtn), scenes: ['game'], when: {win: true}},
          fail_revive: {xy: cRect(R.failReviveBtn), scenes: ['game'], when: {fail: true}},
          fail_restart: {xy: cRect(R.failRestartBtn), scenes: ['game'], when: {fail: true}},
          undo: {xy: cCircle(R.undoBtn), scenes: ['game']},
          shuffle: {xy: cCircle(R.shuffleBtn), scenes: ['game']},
          add_bottle: {xy: cCircle(R.addBottleBtn), scenes: ['game']},
          revive: {xy: cCircle(R.reviveBtn), scenes: ['game']},
          restart: {xy: cCircle(R.restartBtn), scenes: ['game']},
          sound_toggle: {xy: cRect(R.settingsSoundToggle), scenes: ['settings']},
          settings_reset: {xy: cRect(R.settingsResetBtn), scenes: ['settings']},
          settings_key: {xy: cRect(R.settingsKeyBtn), scenes: ['settings']},
          ad_watch: {xy: cRect(R.adConfirmWatchBtn), scenes: ['game'], when: {ad: true}},
          ad_cancel: {xy: cRect(R.adConfirmCancelBtn), scenes: ['game'], when: {ad: true}},
          big_intro: {xy: cRect(R.bigIntroBtn), scenes: ['game'], when: {intro: true}},
          levels: {alias: 'level', base: 1, scenes: ['levelSelect'], list: R.levelBtns.map((b) => cRect(b))},
          bottles: {alias: 'bottle', base: 0, scenes: ['game'], list: R.bottleRects.map((b) => cRect(b))},
        },
      });
    } catch (e) { /* storage 不可用时静默（不影响游戏） */ }
  }

  tick() {
    const now = Date.now();
    const dt = Math.min((now - this.lastTs) / 1000, 0.05);
    this.lastTs = now;

    this.anims.update(dt);

    // 载入推进（PRD-关卡生成异步化与加载界面 F-03）：loading 场景每帧喂生成预算片，
    // 完成后 stepLoading 内部收尾切 game（本帧即画对局首帧）。
    // 首帧例外：只画不推进 —— 否则快关同帧完成生成、加载页一帧都渲染不出（用户拍板：所有关卡都渲染 loading）
    if (this.scene === 'loading') {
      if (this._loadPainted) this.stepLoading();
      else this._loadPainted = true;
    }

    // 限时推进（PRD-限时与步数限制 F-05）：任一浮层打开时停喂即暂停（win/fail/pause/ad/bigIntro），
    // core 零感知暂停态；失败/胜利面板弹出后同样停喂，重开 loadLevel 重置满值
    if (
      this.scene === 'game' &&
      !this.winPanel &&
      !this.failPanel &&
      !this.pauseOverlay &&
      !this.adConfirm &&
      !this.bigIntro
    ) {
      this.logic.tickTime(dt);
    }

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
        this._recordResult(); // 三星结算：算星级 + 更新最佳纪录（更优才写档）
        // 记录解锁进度：打通本关才能挑战下一关
        const newCleared = Math.min(this.levelIndex + 1, LEVEL_COUNT);
        if (newCleared > this.cleared) {
          this.cleared = newCleared;
          wx.setStorageSync(CLEARED_KEY, this.cleared);
        }
      }
    }

    // 失败判定（PRD-玩法扩展 §2 B + PRD-限时与步数限制 F-02/F-03）：炸弹引信归零 / 时间归零 / 步数达限
    // 门闩 failLatch：首次失败记录闪光下标与计时起点（时间/步数失败无引爆瓶，
    // 旧逻辑依赖 failFlashIdx 置位会导致 failDelay 每帧重置、面板永弹不出）；!isWin() 守卫
    // 步限关「最后一步恰好通关」不误判失败（通关面板优先，与 core isFailed 的 OR 语义解耦）
    if (this.scene === 'game' && !this.winPanel && !this.logic.isWin() && this.logic.isFailed()) {
      if (!this.failLatch) {
        this.failLatch = true;
        this.failDelay = 0;
        this.failFlashIdx =
          this.logic.failReason === 'bomb'
            ? this.logic.bombBottles.findIndex(
                (bi, k) => !this.logic.bombDefused[k] && this.logic.bombTimers[k] <= 0
              )
            : -1; // 时间/步数失败无引爆瓶闪光，仅延时弹窗
        this.audio.play('invalid'); // 引爆音（暂复用非法音，待音频侧补充爆炸音）
      }
      // 动画与暂停期间不推进弹窗计时（与通关面板同口径）
      if (!this.pauseOverlay && this.anims.allDone()) {
        this.failDelay += dt;
        if (this.failDelay > 0.6) this.failPanel = true;
      }
    } else {
      // 失败态解除（0.6s 闪光窗口内撤销，或续杯加成）→ 复位门闩与闪光残影，
      // 让下次引爆/失败正常记录新下标/新时长（B-01）
      this.failLatch = false;
      if (this.failFlashIdx >= 0 && !this.logic.isFailed()) {
        this.failFlashIdx = -1;
        this.failDelay = 0;
      }
    }

    this.renderer.draw({
      scene: this.scene,
      pauseOverlay: this.pauseOverlay,
      adConfirm: this.adConfirm,
      soundOn: this.soundOn,
      cleared: this.cleared,
      hasProgress: this.cleared > 0,
      inv: this.inv, // 全局道具背包（PRD-道具背包；渲染层只读显示）
      best: this.best, // 每关最佳纪录（PRD-三星评价；渲染层只读显示）
      logic: this.logic,
      selected: this.selected,
      anims: this.anims,
      winPanel: this.winPanel,
      winStats: this.winStats, // 三星结算态（PRD-三星评价；渲染层只读显示）
      failPanel: this.failPanel, // 失败弹窗（PRD-玩法扩展 §2 B；渲染层只读显示）
      bombFlashIdx: this.failFlashIdx, // 引爆闪光瓶下标（-1 = 无）
      bombFlashT: this.failDelay, // 闪光已持续时长（透明度衰减用）
      levelIndex: this.levelIndex,
      shuffleSelecting: this.shuffleSelecting,
      stuck: this.scene === 'game' && !this.logic.isFailed() && !this.logic.hasAnyMove(),
      bigIntro: this.bigIntro,
      specials: SPECIAL_FLAGS,
      // 生成进度（F-04 加载页进度条用；非 loading 场景为 0/0）
      genElapsedMs: this.scene === 'loading' && this.logic.genProgress() ? this.logic.genProgress().elapsedMs : 0,
      genBudgetMs: this.scene === 'loading' && this.logic.genProgress() ? this.logic.genProgress().budgetMs : 0,
    });

    if (this.debugBridge) this.syncDebugState();

    requestAnimationFrame(this.tick);
  }
}
