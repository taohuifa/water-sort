# 支付与广告变现

## 目录
1. [激励视频广告](#激励视频广告)
2. [Banner 广告](#banner-广告)
3. [插屏广告](#插屏广告)
4. [原生模板广告](#原生模板广告)
5. [虚拟支付 2.0](#虚拟支付-20)
6. [游戏币系统](#游戏币系统)
7. [变现策略建议](#变现策略建议)

---

## 激励视频广告

激励视频是小游戏最高效的变现方式（用户看广告换奖励），接入要点：

```javascript
class RewardedVideoAd {
  constructor(adUnitId) {
    this.ad = wx.createRewardedVideoAd({ adUnitId });
    this.isLoaded = false;
    
    this.ad.onLoad(() => {
      this.isLoaded = true;
      console.log('激励视频广告加载成功');
    });
    
    this.ad.onError((err) => {
      this.isLoaded = false;
      console.error('广告加载失败', err.errCode, err.errMsg);
    });
    
    this.ad.onClose((res) => {
      // res.isEnded: true = 看完了, false = 提前关闭
      this.isLoaded = false; // 关闭后需要重新加载
      this.ad.load(); // 预加载下一次
    });
  }

  // 展示广告，返回 Promise<boolean>（true=看完并发放奖励）
  async show() {
    return new Promise((resolve) => {
      // 先确保广告已加载
      const showAd = () => {
        this.ad.show().catch((err) => {
          console.error('广告展示失败', err);
          resolve(false);
        });
      };

      if (this.isLoaded) {
        showAd();
      } else {
        // 未加载，先 load 再 show
        this.ad.load().then(showAd).catch(() => resolve(false));
      }

      // 监听关闭事件来决定是否发放奖励
      this.ad.onClose((res) => {
        this.isLoaded = false;
        this.ad.load(); // 预加载
        resolve(res.isEnded); // isEnded=true 才发放奖励
      });
    });
  }
}

// 初始化（游戏启动时预加载）
const rewardedAd = new RewardedVideoAd('adunit-xxxxxxxxxxxx');

// 用户点击"看广告得双倍金币"时调用
async function onWatchAdForReward() {
  const isCompleted = await rewardedAd.show();
  if (isCompleted) {
    giveReward('double_coins', 100);
    showToast('恭喜获得双倍金币！');
  } else {
    showToast('请观看完整广告才能获得奖励哦');
  }
}
```

---

## Banner 广告

```javascript
// 创建并显示 Banner 广告
const bannerAd = wx.createBannerAd({
  adUnitId: 'adunit-xxxxxxxxxxxx',
  style: {
    left: 0,
    top: wx.getSystemInfoSync().windowHeight - 100, // 底部显示
    width: wx.getSystemInfoSync().windowWidth,
    height: 100,
  }
});

bannerAd.onResize((size) => {
  // 广告尺寸可能与设置不同，需要根据实际尺寸调整布局
  bannerAd.style.top = wx.getSystemInfoSync().windowHeight - size.height;
  bannerAd.style.left = (wx.getSystemInfoSync().windowWidth - size.width) / 2;
});

bannerAd.onError((err) => console.error('Banner 广告错误', err));

// 在合适的时机显示/隐藏
bannerAd.show().catch(console.error);
// bannerAd.hide(); // 进入战斗时隐藏，退出后显示

// 游戏销毁时
// bannerAd.destroy();
```

---

## 插屏广告

适合在关卡切换、死亡复活等自然间隔展示：

```javascript
const interstitialAd = wx.createInterstitialAd({
  adUnitId: 'adunit-xxxxxxxxxxxx'
});

interstitialAd.onLoad(() => console.log('插屏广告已加载'));
interstitialAd.onError((err) => console.error('插屏广告错误', err));
interstitialAd.onClose(() => {
  // 广告关闭后继续游戏流程
  proceedToNextScene();
});

// 在关卡结算页面展示
async function showInterstitialOnGameOver() {
  try {
    await interstitialAd.show();
  } catch (err) {
    // 广告未加载或展示失败，直接跳过
    proceedToNextScene();
  }
}
```

---

## 原生模板广告

融入游戏 UI 风格，用户体验更好：

```javascript
const customAd = wx.createCustomAd({
  adUnitId: 'adunit-xxxxxxxxxxxx',
  style: {
    left: 10,
    top: 10,
  }
});

customAd.onLoad(() => customAd.show());
customAd.onError(console.error);
```

---

## 虚拟支付 2.0

> ⚠️ 需要在微信公众平台完成虚拟支付 2.0 签约，仅支持个体工商户和企业。

```javascript
// 发起虚拟支付（购买道具/皮肤等）
wx.requestVirtualPayment({
  offerId: 'your-offer-id',  // 在开放平台创建的商品 ID
  currencyType: 'CNY',
  buyQuantity: 1,
  env: 0,  // 0=生产环境, 1=沙盒
  success: (res) => {
    // 支付成功，需要到服务端验证并发货
    verifyAndDeliverItem(res.offerId, res.openId);
  },
  fail: (err) => {
    if (err.errCode === -2) {
      // 用户取消支付
      console.log('用户取消了支付');
    } else {
      console.error('支付失败', err);
    }
  }
});
```

### 服务端发货验证（重要）
```javascript
// 必须在服务端验证支付结果，防止刷单
async function verifyAndDeliverItem(offerId, openId) {
  // 调用微信支付通知回调验证（服务端监听支付通知）
  // 参考：https://pay.weixin.qq.com/wiki/doc/apiv3/
  // 验证成功后再在数据库中添加道具
}
```

---

## 游戏币系统

```javascript
// 查询游戏币余额
wx.getGameClubData({
  success: (res) => {
    console.log('游戏币余额', res.data.balance);
  }
});

// 消耗游戏币（购买道具）
wx.payWithGameClub({
  offerId: 'your-offer-id',
  success: (res) => {
    // 扣款成功，发货
  }
});
```

---

## 变现策略建议

| 策略 | 优点 | 适用场景 |
|------|------|---------|
| 激励视频 | 转化高，用户主动观看 | 复活、加速、额外奖励 |
| Banner | 被动曝光，零打扰 | 大厅、菜单页面 |
| 插屏 | 高曝光 | 关卡切换，每隔2-3关一次 |
| 虚拟支付 | 高 ARPU | 皮肤、道具、限定内容 |

**最佳实践**：激励视频 + Banner 组合是最常见的小游戏变现方案，激励视频给用户价值感，Banner 保底收益。
