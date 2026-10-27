/**
 * 激励视频广告封装（方案 7 变现场景的道具补给点位）。
 *
 * 降级策略：adUnitId 未配置（开发模式）、广告拉取失败、show 失败，
 * 均直接发放奖励，保证开发/测试流程不依赖真实广告位。
 * 上线流程：在 mp 后台「流量主」申请激励视频广告位，
 * 把 adUnitId 填入 assets/config/ads.jsonc 即接入真实广告。
 */
export default class Ads {
  constructor({ adUnitId = '' } = {}) {
    this.adUnitId = adUnitId;
    this.ad = null;
    this.pending = false; // 一次广告在途标志（防 show() 异步期间重复触发双发奖励）
    if (adUnitId && typeof wx !== 'undefined' && wx.createRewardedVideoAd) {
      try {
        this.ad = wx.createRewardedVideoAd({ adUnitId });
        this.ad.onError(() => {
          this.ad = null; // 拉取失败后降级为直接发放
        });
      } catch (e) {
        this.ad = null;
      }
    }
  }

  /**
   * 观看激励视频后发放奖励。
   * @param {Function} onReward 奖励回调（看完广告或降级时调用）
   */
  watch(onReward) {
    if (this.pending) return; // 在途广告未结束前忽略重复触发
    if (!this.ad) {
      onReward(); // 开发模式：直接发放
      return;
    }
    this.pending = true;
    const settle = () => {
      this.pending = false;
    };
    const handler = (res) => {
      this.ad.offClose(handler);
      settle();
      if (!res || res.isEnded) onReward(); // 中途关闭不发放
    };
    this.ad.onClose(handler);
    this.ad.show().catch(() => {
      // show 失败：load 一次重试，再失败则降级发放
      this.ad
        .load()
        .then(() => this.ad.show())
        .catch(() => {
          this.ad.offClose(handler);
          settle();
          onReward();
        });
    });
  }
}
