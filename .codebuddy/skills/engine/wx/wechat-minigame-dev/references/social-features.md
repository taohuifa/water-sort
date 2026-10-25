# 社交功能与关系链

## 开放数据域架构

微信小游戏使用**双域架构**保护用户隐私：
- **主域（Main Context）**：游戏逻辑，可存储数据但不能直接读取好友数据
- **开放数据域（Open Data Context）**：独立沙箱，可读取关系链数据，但渲染结果只能通过 sharedCanvas 投影到主域

```
主域                    开放数据域
  │                          │
  │── postMessage ──────────>│  发送指令
  │<─ sharedCanvas ──────────│  接收渲染结果
  │                          │
  │  wx.setUserCloudStorage  │  wx.getFriendCloudStorageData
  │  (主域和开放数据域均可)   │  wx.getGroupCloudStorageData
  │                          │  (只能在开放数据域调用)
```

---

## 存储游戏数据（主域）

```javascript
// 存储当前用户的游戏数据（主域调用）
function saveScore(score) {
  wx.setUserCloudStorage({
    KVDataList: [
      { key: 'score', value: String(score) },
      { key: 'level', value: String(currentLevel) },
      { key: 'updateTime', value: String(Date.now()) }
    ],
    success: () => console.log('数据已同步到微信云'),
    fail: (err) => console.error('存储失败', err)
  });
}

// 删除某个 key
wx.removeUserCloudStorage({
  keyList: ['oldData'],
  success: () => console.log('删除成功')
});
```

---

## 好友排行榜（开放数据域）

### game.json 配置
```json
{
  "openDataContext": "open-data"
}
```

### 主域：向开放数据域发送指令
```javascript
// main.js
const openDataContext = wx.getOpenDataContext();
const sharedCanvas = openDataContext.canvas;

// 配置 sharedCanvas 尺寸（和显示区域一致）
sharedCanvas.width = 750;
sharedCanvas.height = 500;

// 发送渲染指令给开放数据域
openDataContext.postMessage({
  type: 'SHOW_LEADERBOARD',
  payload: {
    scene: 'friend_rank',  // 'friend_rank' | 'group_rank'
    width: 750,
    height: 500
  }
});

// 将 sharedCanvas 渲染到主 Canvas 上
function renderLeaderboard() {
  const ctx = mainCanvas.getContext('2d');
  ctx.drawImage(sharedCanvas, 0, 0); // 每帧调用
}
```

### 开放数据域（open-data/index.js）
```javascript
// open-data/index.js
const canvas = wx.getSharedCanvas();
const ctx = canvas.getContext('2d');

// 监听主域消息
wx.onMessage((data) => {
  if (data.type === 'SHOW_LEADERBOARD') {
    renderLeaderboard(data.payload);
  }
});

async function renderLeaderboard({ width, height }) {
  // 获取好友数据
  wx.getFriendCloudStorageData({
    keyList: ['score'],
    success: (res) => {
      const friends = res.data
        .filter(user => user.KVDataList.length > 0)
        .map(user => ({
          nickname: user.nickname,
          avatarUrl: user.avatarUrl,
          score: parseInt(user.KVDataList.find(k => k.key === 'score')?.value || '0')
        }))
        .sort((a, b) => b.score - a.score); // 降序排列
      
      drawRankList(ctx, friends, width, height);
    },
    fail: (err) => console.error('获取好友数据失败', err)
  });
}

function drawRankList(ctx, players, width, height) {
  ctx.clearRect(0, 0, width, height);
  
  players.forEach((player, index) => {
    const y = 60 + index * 80;
    
    // 绘制排名
    ctx.fillStyle = '#333';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(`${index + 1}`, 20, y);
    
    // 绘制头像（异步加载）
    const img = canvas.createImage();
    img.onload = () => ctx.drawImage(img, 60, y - 35, 50, 50);
    img.src = player.avatarUrl;
    
    // 绘制昵称和分数
    ctx.fillStyle = '#333';
    ctx.font = '24px sans-serif';
    ctx.fillText(player.nickname, 125, y - 8);
    ctx.fillStyle = '#ff6600';
    ctx.fillText(`${player.score}分`, 125, y + 20);
  });
}
```

---

## 获取群排行榜

当用户从群聊分享卡片进入游戏时，可获取群成员数据：

```javascript
// 在开放数据域中
wx.getGroupCloudStorageData({
  shareTicket: wx.getLaunchOptionsSync().shareTicket, // 从启动参数获取
  keyList: ['score'],
  success: (res) => {
    const groupMembers = res.data;
    // 渲染群排行榜...
  }
});
```

---

## 分享转发

```javascript
// 设置全局分享配置
wx.onShareAppMessage(() => {
  return {
    title: '我在玩XXX游戏，你来挑战我吗？',
    imageUrl: 'https://your-cdn.com/share-image.png', // 建议 5:4 比例，最大 750KB
    query: `fromUid=${currentUser.openid}&score=${currentScore}`, // 携带自定义参数
  };
});

// 主动触发分享（需要用户点击触发，不能自动调用）
function shareGame() {
  wx.shareAppMessage({
    title: `我的最高分是 ${bestScore}，来挑战我！`,
    imageUrl: captureScreenshot(), // 截图作为分享图
  });
}

// 获取来源分享参数（好友分享进入时）
const launchOptions = wx.getLaunchOptionsSync();
const query = launchOptions.query; // { fromUid: '...', score: '...' }
```

---

## 潜在好友功能（基础库 2.9.0+）

展示对游戏感兴趣但还未玩过的好友：

```javascript
// 在开放数据域中
wx.getPotentialFriendList({
  success: (res) => {
    const potentialFriends = res.list; // [{ openId, nickname, avatarUrl }]
    // 渲染"邀请好友"列表
  }
});
```
