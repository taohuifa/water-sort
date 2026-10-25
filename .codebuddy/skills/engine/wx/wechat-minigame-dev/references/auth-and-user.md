# 登录鉴权与用户信息

## 登录完整流程

### 前端代码
```javascript
// game.js 或登录模块
async function login() {
  try {
    // 第一步：获取临时登录凭证 code
    const { code } = await wx.login();
    
    // 第二步：发送 code 到自己的服务器
    const res = await wx.request({
      url: 'https://your-server.com/api/login',
      method: 'POST',
      data: { code },
    });
    
    if (res.statusCode === 200) {
      // 第三步：保存服务端返回的自定义 token
      wx.setStorageSync('token', res.data.token);
      wx.setStorageSync('openid', res.data.openid);
      return res.data;
    }
  } catch (err) {
    console.error('登录失败', err);
    throw err;
  }
}
```

### 服务端代码（Node.js 示例）
```javascript
const axios = require('axios');

async function wxLogin(code) {
  const appid = 'your_appid';
  const secret = 'your_appsecret';
  
  // 调用微信接口换取 openid 和 session_key
  const { data } = await axios.get(
    `https://api.weixin.qq.com/sns/jscode2session`,
    { params: { appid, secret, js_code: code, grant_type: 'authorization_code' } }
  );
  
  if (data.errcode) {
    throw new Error(`微信登录失败: ${data.errmsg}`);
  }
  
  const { openid, session_key, unionid } = data;
  
  // ⚠️ session_key 只能在服务端使用，绝对不要返回给前端！
  // 生成自己的登录 token，与 openid 关联存储
  const token = generateToken(openid);
  await saveUserSession(openid, session_key, token); // 存到数据库/Redis
  
  return { token, openid }; // 只返回 token 和 openid
}
```

---

## 检查登录状态

```javascript
// 检查 session_key 是否过期（服务端 session_key 可能已更新）
async function checkLoginStatus() {
  try {
    await wx.checkSession(); // 若 session_key 未过期则 resolve，否则 reject
    // session_key 有效，无需重新登录
    return true;
  } catch (e) {
    // session_key 已过期，需要重新登录
    await login();
    return false;
  }
}
```

---

## 获取用户信息

### 新版本推荐方式（基础库 2.21.2+）
微信已于 2022 年调整隐私政策，头像和昵称改为用户自行填写：

```javascript
// 使用头像昵称填写能力（推荐新游戏使用）
// 在 WXML 中（如使用游戏框架有 UI 能力时）：
// <button open-type="chooseAvatar" bind:chooseavatar="onChooseAvatar">
// <input type="nickname" bind:blur="onNicknameBlur">

// 或通过 getUserProfile（仍可用但每次都会弹授权）
wx.getUserProfile({
  desc: '用于展示您的游戏头像和昵称', // 必填，说明用途
  success: (res) => {
    const { avatarUrl, nickName } = res.userInfo;
    // 注意：此方式每次调用都会弹出授权弹窗
  }
});
```

### 检查已有授权
```javascript
async function checkUserInfoAuth() {
  const { authSetting } = await wx.getSetting();
  
  if (authSetting['scope.userInfo']) {
    // 已授权，可直接获取
    const res = await wx.getUserInfo();
    return res.userInfo;
  } else {
    // 未授权，需要引导用户点击授权按钮
    return null;
  }
}
```

---

## 获取手机号码（需企业主体）

```javascript
// 只能通过 button 的 open-type="getPhoneNumber" 触发
// 在支持 WXML 的游戏框架中：
// <button open-type="getPhoneNumber" bind:getphonenumber="getPhoneNumber">

function getPhoneNumber(e) {
  if (e.detail.code) {
    // 将 code 发送到服务器，服务器调用 phonenumber.getPhoneNumber 接口解密
    wx.request({
      url: 'https://your-server.com/api/phone',
      method: 'POST',
      data: { code: e.detail.code },
    });
  }
}
```

---

## 用户数据解密（服务端）

微信部分接口返回加密数据，需用 `session_key` 在服务端解密：

```javascript
const crypto = require('crypto');

function decryptData(sessionKey, encryptedData, iv) {
  const sessionKeyBuffer = Buffer.from(sessionKey, 'base64');
  const encryptedDataBuffer = Buffer.from(encryptedData, 'base64');
  const ivBuffer = Buffer.from(iv, 'base64');
  
  const decipher = crypto.createDecipheriv('aes-128-cbc', sessionKeyBuffer, ivBuffer);
  decipher.setAutoPadding(true);
  
  let decoded = decipher.update(encryptedDataBuffer, 'binary', 'utf8');
  decoded += decipher.final('utf8');
  
  return JSON.parse(decoded);
}
```

---

## 隐私协议合规要点

1. **必须**在首次收集用户数据前展示隐私政策链接
2. 使用 `wx.getPrivacySetting()` 检查用户是否已同意隐私协议（基础库 3.0.1+）
3. 若未同意，需弹出协议授权弹窗后才能调用涉及个人信息的 API

```javascript
// 检查隐私授权状态（基础库 3.0.1+）
wx.getPrivacySetting({
  success(res) {
    if (res.needAuthorization) {
      // 需要用户同意隐私协议
      wx.openPrivacyContract({ /* ... */ });
    }
  }
});
```
