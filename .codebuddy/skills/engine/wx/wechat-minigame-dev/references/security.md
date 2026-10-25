# 安全与合规

## 目录
1. [登录安全](#登录安全)
2. [数据加密与验签](#数据加密与验签)
3. [反外挂与作弊防护](#反外挂与作弊防护)
4. [代码保护](#代码保护)
5. [内容安全](#内容安全)
6. [隐私合规](#隐私合规)
7. [审核合规清单](#审核合规清单)

---

## 登录安全

```javascript
// ❌ 危险：将 session_key 返回给前端
// 服务端响应中绝对不要包含 session_key
function badLogin(code) {
  const { openid, session_key } = await code2Session(code);
  return { openid, session_key }; // ❌ 泄露 session_key！
}

// ✅ 正确：只返回自定义 token
function goodLogin(code) {
  const { openid, session_key } = await code2Session(code);
  const token = generateSecureToken(openid); // 生成自己的 token
  await redis.set(`token:${token}`, JSON.stringify({ openid, session_key }), 'EX', 7200);
  return { token, openid }; // ✅ 只返回 token
}
```

### 防重放攻击
```javascript
// code 只能用一次，服务端验证
const usedCodes = new Set(); // 生产环境用 Redis

async function safeCode2Session(code) {
  if (usedCodes.has(code)) {
    throw new Error('code 已使用，疑似重放攻击');
  }
  usedCodes.add(code);
  
  const result = await code2Session(code);
  return result;
}
```

---

## 数据加密与验签

### 验证微信回调数据签名
```javascript
const crypto = require('crypto');

// 验证微信服务器消息的真实性（防伪造）
function verifyWechatSignature(rawBody, signature, timestamp, nonce, token) {
  const arr = [token, timestamp, nonce, rawBody].sort();
  const str = arr.join('');
  const hash = crypto.createHash('sha1').update(str).digest('hex');
  return hash === signature;
}
```

### 解密用户数据（服务端）
```javascript
// 解密 wx.getUserInfo 返回的加密数据
function decryptWechatData(sessionKey, encryptedData, iv) {
  const sessionKeyBuffer = Buffer.from(sessionKey, 'base64');
  const encryptedDataBuffer = Buffer.from(encryptedData, 'base64');
  const ivBuffer = Buffer.from(iv, 'base64');

  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', sessionKeyBuffer, ivBuffer);
    decipher.setAutoPadding(true);
    let decoded = decipher.update(encryptedDataBuffer, 'binary', 'utf8');
    decoded += decipher.final('utf8');
    return JSON.parse(decoded);
  } catch (err) {
    throw new Error('解密失败，session_key 可能已过期');
  }
}
```

---

## 反外挂与作弊防护

### 服务端验证关键数据
```javascript
// ❌ 危险：直接信任客户端上报的分数
app.post('/save-score', (req, res) => {
  const { score } = req.body;
  db.saveScore(userId, score); // ❌ 分数可以随意篡改
});

// ✅ 服务端验证分数合理性
app.post('/save-score', (req, res) => {
  const { score, gameTime, sessionId } = req.body;
  
  // 1. 验证 token
  const userId = verifyToken(req.headers.authorization);
  
  // 2. 检查分数合理性
  const maxPossibleScore = gameTime * MAX_SCORE_PER_SECOND;
  if (score > maxPossibleScore) {
    return res.status(400).json({ error: '分数异常' });
  }
  
  // 3. 检查提交频率（防刷分）
  const lastSubmit = await redis.get(`last_submit:${userId}`);
  if (lastSubmit && Date.now() - lastSubmit < MIN_GAME_DURATION) {
    return res.status(429).json({ error: '提交过于频繁' });
  }
  
  // 4. 验证游戏会话（防重复提交）
  const isValidSession = await validateGameSession(sessionId, userId);
  if (!isValidSession) {
    return res.status(400).json({ error: '无效的游戏会话' });
  }
  
  await db.saveScore(userId, score);
  await redis.set(`last_submit:${userId}`, Date.now());
});
```

### 关键逻辑放服务端
```javascript
// ❌ 危险：在前端计算奖励
function claimReward() {
  const reward = calculateReward(playerLevel, score); // 前端计算
  sendToServer({ reward }); // 服务器直接信任
}

// ✅ 正确：服务端计算和验证所有奖励
async function claimReward(gameResult) {
  const { score, levelId, sessionId } = gameResult;
  
  const response = await wx.request({
    url: 'https://api.game.com/claim-reward',
    method: 'POST',
    data: { score, levelId, sessionId } // 只发原始数据
    // 服务端根据这些数据自己计算奖励
  });
  
  // 使用服务端返回的奖励数量，不信任本地计算
  addCoins(response.data.coins);
}
```

---

## 代码保护

```javascript
// project.config.json：开启代码保护
{
  "setting": {
    "minified": true,      // 代码压缩混淆
    "uglifyFileName": true // 文件名混淆
  }
}
```

微信小游戏后台还支持更高级的代码保护（加密打包），在"开发管理 → 代码保护"中开启。

---

## 内容安全

```javascript
// 检查用户输入的昵称/文字是否含违规内容（服务端调用）
// POST https://api.weixin.qq.com/wxa/msg_sec_check
async function checkTextSafety(text, openId) {
  const accessToken = await getAccessToken();
  const response = await axios.post(
    `https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${accessToken}`,
    {
      content: text,
      openid: openId,
      scene: 1,  // 1=资料, 2=评论, 3=论坛, 4=社交日志
      version: 2,
    }
  );
  
  if (response.data.result?.suggest !== 'pass') {
    throw new Error('内容违规');
  }
}

// 检查图片内容安全
async function checkImageSafety(imageUrl) {
  const response = await axios.post(
    `https://api.weixin.qq.com/wxa/img_sec_check?access_token=${accessToken}`,
    { media_url: imageUrl, version: 2, openid: userOpenId, scene: 1 }
  );
  return response.data.result?.suggest === 'pass';
}
```

---

## 隐私合规

```javascript
// 基础库 3.0.1+ 必须处理隐私授权
wx.onNeedPrivacyAuthorization((resolve) => {
  // 展示隐私弹窗
  showPrivacyDialog({
    onAgree: () => resolve({ buttonId: 'agree-btn', event: 'agree' }),
    onRefuse: () => resolve({ buttonId: 'refuse-btn', event: 'refuse' })
  });
});
```

---

## 审核合规清单

提交审核前务必检查：

### 必须具备
- [ ] 隐私政策链接（可在小游戏内展示或链接到网页）
- [ ] 用户协议链接
- [ ] 游戏内有"关于"或"帮助"入口
- [ ] 未成年人保护措施（防沉迷，充值限制提示）

### 功能合规
- [ ] 不强制要求用户分享才能继续游戏（违规）
- [ ] 虚拟支付展示清晰的价格和商品说明
- [ ] 广告不遮挡关键游戏区域，有关闭按钮
- [ ] 随机抽奖（扭蛋）需展示概率

### 技术合规
- [ ] 不使用未申请的敏感权限
- [ ] 不在后台持续运行（除音乐外）
- [ ] 不收集非必要的用户信息
