# 云开发（CloudBase）

微信小游戏云开发（WX CloudBase）让你无需自建服务器，直接在小游戏中使用云数据库、云存储、云函数。所有资源通过 `wx.cloud.*` API 访问。

> **最低基础库**：2.2.3（覆盖率 97%+）  
> **注意**：不支持游客模式和测试号，必须填写正式 AppID。

---

## 目录

1. [初始化](#初始化)
2. [云数据库](#云数据库)
3. [云存储](#云存储)
4. [云函数](#云函数)
5. [权限控制](#权限控制)
6. [跨账号环境共享](#跨账号环境共享)
7. [实际应用示例](#实际应用示例)

---

## 初始化

在 `game.js` 入口处完成初始化，整个游戏只需调用一次：

```javascript
// game.js
wx.cloud.init({
  env: 'your-env-id',   // 云环境 ID，在云开发控制台获取
  traceUser: true,       // 是否将用户访问记录到用户管理中
});
```

如果需要同时访问多个环境（如正式环境 + 测试环境）：

```javascript
// 创建自定义实例（访问特定环境）
const testCloud = new wx.cloud.Cloud({
  resourceEnv: 'test-env-id',
  traceUser: false,
});
await testCloud.init();

// 后续使用 testCloud.database() / testCloud.callFunction() 等
```

**配置 `project.config.json`**（指定云函数目录）：
```json
{
  "appid": "wx1234567890abcdef",
  "cloudfunctionRoot": "cloudfunctions/",
  "compileType": "game"
}
```

---

## 云数据库

云数据库是文档型 NoSQL 数据库，数据以 JSON 文档形式存储在"集合（Collection）"中。

### 获取数据库引用

```javascript
const db = wx.cloud.database();

// 访问特定环境的数据库
const db = wx.cloud.database({ env: 'production-env-id' });

// 获取集合引用（集合不存在时会自动创建）
const scores = db.collection('scores');
const players = db.collection('players');
```

### 新增数据（add）

```javascript
// 插入单条记录
// _openid 字段会被自动填充为当前用户的 openid
const result = await db.collection('scores').add({
  data: {
    score: 9800,
    level: 5,
    timestamp: db.serverDate(), // 使用服务器时间，避免客户端时间篡改
    metadata: { combo: 3, stars: 2 },
  }
});
console.log('新记录 ID:', result._id);
```

### 查询数据（get / where）

```javascript
// 查询当前用户的所有记录（小程序端默认只能查自己的数据）
const res = await db.collection('scores')
  .orderBy('score', 'desc')   // 按分数降序
  .limit(10)                  // 最多返回10条
  .get();

console.log('排行榜数据:', res.data);

// 带条件查询（使用 Command 操作符）
const _ = db.command;

const highScores = await db.collection('scores')
  .where({
    score: _.gte(5000),            // score >= 5000
    level: _.in([3, 4, 5]),        // level 在指定数组中
    timestamp: _.gte(new Date(Date.now() - 86400000)), // 最近24小时
  })
  .orderBy('score', 'desc')
  .limit(20)
  .get();

// 分页查询
async function getScorePage(page, pageSize = 20) {
  const res = await db.collection('scores')
    .orderBy('score', 'desc')
    .skip(page * pageSize)   // 跳过前 N 条
    .limit(pageSize)
    .get();
  return res.data;
}

// 查询单条（按 _id）
const player = await db.collection('players').doc('specific-doc-id').get();
console.log(player.data);

// 聚合查询（统计总数，注意：count 在小程序端需要有权限）
const countResult = await db.collection('scores')
  .where({ level: 5 })
  .count();
console.log('总数:', countResult.total);
```

**查询操作符速查表：**

| 操作符 | 含义 | 示例 |
|--------|------|------|
| `_.eq(val)` | 等于 | `score: _.eq(100)` |
| `_.neq(val)` | 不等于 | `status: _.neq('deleted')` |
| `_.gt(val)` | 大于 | `score: _.gt(0)` |
| `_.gte(val)` | 大于等于 | `level: _.gte(3)` |
| `_.lt(val)` | 小于 | `time: _.lt(60)` |
| `_.lte(val)` | 小于等于 | `age: _.lte(18)` |
| `_.in([])` | 在数组中 | `type: _.in(['a','b'])` |
| `_.nin([])` | 不在数组中 | `banned: _.nin([true])` |
| `_.and([])` | 逻辑与 | `_.and([_.gt(1), _.lt(10)])` |
| `_.or([])` | 逻辑或 | `score: _.or([_.lt(0), _.gt(100)])` |
| `_.exists(true)` | 字段存在 | `avatar: _.exists(true)` |

### 更新数据（update / set）

```javascript
// 更新指定字段（其他字段保留）
await db.collection('players').doc(playerId).update({
  data: {
    bestScore: 9999,
    lastPlayTime: db.serverDate(),
    // 数值原子操作（安全地增加，避免并发问题）
    totalGames: db.command.inc(1),
    coins: db.command.inc(50),
    // 数组操作
    achievements: db.command.push('first_win'),
    badges: db.command.addToSet('veteran'),  // 不重复添加
  }
});

// 整体替换文档（set 会覆盖整条记录）
await db.collection('settings').doc(docId).set({
  data: {
    theme: 'dark',
    language: 'zh-CN',
    notifications: true,
  }
});

// 批量更新（where + update，仅云函数端支持，小程序端每次最多更新1条）
// ⚠️ 以下代码只能在云函数中执行
await db.collection('scores')
  .where({ season: 'S1' })
  .update({
    data: { archived: true }
  });
```

### 删除数据（remove）

```javascript
// 删除单条记录（按 _id）
await db.collection('scores').doc(docId).remove();

// 批量删除（仅云函数端）
await db.collection('temp_data')
  .where({ expired: true })
  .remove();
```

### 实时数据监听（watch）

```javascript
// 监听集合变化，适合实时多人游戏同步房间状态
const watcher = db.collection('rooms').doc(roomId).watch({
  onChange(snapshot) {
    // snapshot.type: 'init' | 'update' | 'replace' | 'remove'
    // snapshot.docChanges: 变更的文档列表
    console.log('房间数据变化:', snapshot.docs[0]);
    updateRoomUI(snapshot.docs[0]);
  },
  onError(err) {
    console.error('监听出错', err);
    // 可尝试重连
  }
});

// 停止监听（离开房间时）
watcher.close();
```

---

## 云存储

云存储用于保存游戏截图、用户头像、关卡地图等文件资源，无需自建 CDN。

### 上传文件

```javascript
// 上传本地文件到云存储
async function uploadGameScreenshot(tempFilePath, userId) {
  const cloudPath = `screenshots/${userId}/${Date.now()}.jpg`;
  
  const result = await wx.cloud.uploadFile({
    cloudPath,          // 云端路径（自定义，要保证唯一）
    filePath: tempFilePath, // 本地临时文件路径
  });
  
  // result.fileID：云文件 ID（格式：cloud://env-id.xxx/...）
  // 可以永久存储这个 ID，后续通过 ID 访问文件
  console.log('上传成功，fileID:', result.fileID);
  return result.fileID;
}

// 监听上传进度
const uploadTask = wx.cloud.uploadFile({
  cloudPath: 'saves/savefile.json',
  filePath: tempFilePath,
});

uploadTask.onProgressUpdate((res) => {
  console.log(`上传进度: ${res.progress}%`);
});

const uploadResult = await uploadTask;
```

### 下载文件

```javascript
// 通过 fileID 下载文件到本地
async function downloadCloudFile(fileID) {
  const result = await wx.cloud.downloadFile({ fileID });
  // result.tempFilePath：下载后的本地临时路径（有效期约5分钟）
  return result.tempFilePath;
}

// 将云存储图片直接显示（微信组件支持直接用 fileID）
// 在 Canvas 中使用需要先下载或获取临时 URL
const img = canvas.createImage();
img.src = tempFilePath; // 使用下载后的本地路径
```

### 获取临时访问链接

```javascript
// 批量获取文件的临时 HTTPS 链接（有效期约10分钟）
// 适合分享给其他用户访问，或用于 img src
async function getFileURLs(fileIDs) {
  const result = await wx.cloud.getTempFileURL({
    fileList: fileIDs,
  });
  
  return result.fileList.map(item => ({
    fileID: item.fileID,
    tempFileURL: item.tempFileURL, // HTTPS 链接，可放到 <image> 或 Canvas
    status: item.status,           // 0 = 成功
  }));
}

// 使用示例
const urls = await getFileURLs(['cloud://xxx/avatar.jpg', 'cloud://xxx/map.png']);
urls.forEach(({ fileID, tempFileURL }) => {
  console.log(`${fileID} → ${tempFileURL}`);
});
```

### 删除文件

```javascript
// 删除云存储文件（只能删除自己上传的，或在云函数中删除）
await wx.cloud.deleteFile({
  fileList: ['cloud://env.xxx/path/to/file.jpg'],
});
```

---

## 云函数

云函数运行在服务端（Node.js 环境），无需管理服务器。最大优势：**调用时自动注入 openid，无需前端传递，防止伪造**。

### 编写云函数

在项目 `cloudfunctions/` 目录下，每个子目录就是一个云函数：

```
cloudfunctions/
├── saveScore/
│   ├── index.js      # 云函数入口
│   └── package.json
├── getLeaderboard/
│   └── index.js
└── sendGift/
    └── index.js
```

**示例：安全保存分数**（`cloudfunctions/saveScore/index.js`）：

```javascript
// 云函数中使用 wx-server-sdk
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV }); // 自动使用当前环境

const db = cloud.database();

exports.main = async (event, context) => {
  // 自动注入的用户信息（前端无法伪造）
  const { OPENID, APPID } = cloud.getWXContext();
  
  const { score, levelId, gameTime } = event;
  
  // 服务端验证：防止作弊
  const maxPossibleScore = gameTime * 100; // 每秒最多100分
  if (score > maxPossibleScore || score < 0) {
    return { success: false, error: '分数异常' };
  }
  
  try {
    // 查询当前最高分
    const existing = await db.collection('scores')
      .where({ _openid: OPENID, levelId })
      .orderBy('score', 'desc')
      .limit(1)
      .get();
    
    const currentBest = existing.data[0]?.score ?? 0;
    
    if (score > currentBest) {
      // 更新最高分
      if (existing.data.length > 0) {
        await db.collection('scores').doc(existing.data[0]._id).update({
          data: { score, gameTime, updatedAt: db.serverDate() }
        });
      } else {
        await db.collection('scores').add({
          data: { score, levelId, gameTime, _openid: OPENID, createdAt: db.serverDate() }
        });
      }
      return { success: true, isNewBest: true, bestScore: score };
    }
    
    return { success: true, isNewBest: false, bestScore: currentBest };
  } catch (err) {
    console.error('保存分数失败', err);
    return { success: false, error: err.message };
  }
};
```

**云函数内操作云存储**：

```javascript
// cloudfunctions/processImage/index.js
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  
  // 云函数拥有完整存储权限（不受用户权限限制）
  const downloadResult = await cloud.downloadFile({
    fileID: event.fileID,
  });
  
  // 处理文件内容...
  const processedBuffer = processImage(downloadResult.fileContent);
  
  // 上传处理后的文件
  await cloud.uploadFile({
    cloudPath: `processed/${OPENID}/${Date.now()}.jpg`,
    fileContent: processedBuffer,
  });
  
  return { success: true };
};
```

### 在小游戏中调用云函数

```javascript
// 基础调用
async function saveScore(score, levelId, gameTime) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'saveScore',           // 云函数名称（对应目录名）
      data: { score, levelId, gameTime }, // 传入参数（event 对象）
    });
    
    // res.result：云函数 return 的值
    // res.requestID：请求 ID，用于排查问题
    return res.result;
  } catch (err) {
    console.error('调用云函数失败', err);
    throw err;
  }
}

// 使用
const result = await saveScore(9800, 'level_1', 120);
if (result.isNewBest) {
  showNewRecordAnimation();
}
```

### 云函数定时触发器

在云函数目录中添加 `config.json`：

```json
{
  "triggers": [
    {
      "name": "dailyReset",
      "type": "timer",
      "config": "0 0 0 * * * *"
    }
  ]
}
```

```javascript
// cloudfunctions/dailyReset/index.js
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const db = cloud.database();
  const today = new Date().toISOString().split('T')[0];
  
  // 每天零点重置每日任务完成状态
  await db.collection('daily_progress')
    .where({ date: db.command.neq(today) })
    .update({
      data: { completed: false, date: today }
    });
  
  console.log('每日重置完成');
  return { success: true };
};
```

---

## 权限控制

### 数据库权限模式

云数据库提供两种权限控制方式（在控制台按集合配置）：

**简易权限（4种预设）：**

| 权限模式 | 读 | 写 | 适用场景 |
|---------|----|----|---------|
| 仅创建者可读写 | 自己 | 自己 | 用户存档、私人数据 |
| 所有人可读，仅创建者可写 | 所有人 | 自己 | 公开排行榜 |
| 仅创建者可读，所有人可写 | 自己 | 所有人 | 用户上报日志 |
| 所有人可读写 | 所有人 | 所有人 | 公告、配置 |

> **最佳实践**：分数等关键数据用"仅创建者可读写"，通过**云函数**做统一写入（云函数拥有管理员权限）。

**安全规则（精细控制）：**

```javascript
// 在控制台"安全规则"中配置（JSON 格式）
// 示例：只允许读取公开字段，写入需要验证
{
  "read": true,
  "write": "doc._openid == auth.openid"
}

// 更复杂的规则示例：只允许更新特定字段
{
  "read": "auth != null",
  "create": "auth != null && request.data.score is number",
  "update": "doc._openid == auth.openid && request.data.keys().hasOnly(['nickname', 'avatar'])",
  "delete": false
}
```

---

## 跨账号环境共享

"环境共享"允许**同一主体**下的多个小游戏/小程序共用同一套云开发资源（数据库、存储、云函数），避免重复建设。典型场景：同一公司旗下多款游戏共享用户体系、道具库存、全局排行榜。

> **前提条件**：  
> - 双方必须属于**同一主体**（同一企业主体注册的账号）  
> - 资源方需在云开发控制台 → 更多 → 环境共享 中开启并授权  
> - 开发者工具版本 ≥ 1.03.2009140  
> - 被共享方 `wx-server-sdk` 版本 ≥ 2.3.0（云函数内调用时）

### 核心概念

| 术语 | 说明 |
|------|------|
| **资源方**（Provider） | 拥有云开发环境的小游戏，负责授权 |
| **使用方**（Consumer） | 共享资源的小游戏，使用资源方的环境 |
| `resourceAppid` | 资源方的 AppID，使用方初始化时指定 |
| `resourceEnv` | 要共享的云开发环境 ID |
| `cloudbase_auth` | 资源方必须部署的鉴权云函数，用于验证使用方身份 |

**单层授权限制**：A 授权 B、B 授权 C，但 A 不能直接访问 C 的资源，B 也不能将 A 的资源转授给 C。

### 资源方：部署 cloudbase_auth 鉴权函数

资源方必须在自己的云开发环境中部署 `cloudbase_auth` 云函数。使用方调用 `cloud.init()` 时会自动触发此函数做身份验证：

```javascript
// cloudfunctions/cloudbase_auth/index.js（部署在资源方环境中）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();

  // FROM_APPID：使用方（调用方）的 AppID
  // FROM_OPENID：使用方用户的 OpenID（在使用方小游戏下的 openid）
  const { FROM_APPID, FROM_OPENID, FROM_UNIONID } = wxContext;

  // 白名单验证：只允许指定的小游戏访问
  const ALLOWED_APPIDS = ['wx_game_b_appid', 'wx_game_c_appid'];
  if (!ALLOWED_APPIDS.includes(FROM_APPID)) {
    return { errCode: 1, errMsg: '无访问权限' };
  }

  // 返回 auth 对象，内容会注入到安全规则的 auth 变量中
  // 可以在数据库安全规则中用 auth.appid、auth.openid 做精细权限控制
  return {
    errCode: 0,
    errMsg: 'ok',
    auth: JSON.stringify({
      appid: FROM_APPID,
      openid: FROM_OPENID,
      unionid: FROM_UNIONID ?? '',
    }),
  };
};
```

### 使用方：初始化并访问共享环境

使用方不能用 `wx.cloud.init()` 访问别人的环境，必须用 `new wx.cloud.Cloud()` 创建独立实例：

```javascript
// game.js 或初始化模块
// ⚠️ 必须 await init() 完成后才能调用任何 API
const sharedCloud = new wx.cloud.Cloud({
  resourceAppid: 'wx_resource_provider_appid', // 资源方 AppID
  resourceEnv: 'shared-env-id',                // 资源方的环境 ID
  traceUser: true,
});

await sharedCloud.init(); // 此时会触发资源方的 cloudbase_auth 验证

// 之后就可以用 sharedCloud 访问资源方的数据库、云函数、存储
```

### 使用方：调用共享环境的各项资源

```javascript
// ---- 调用共享环境的云函数 ----
const result = await sharedCloud.callFunction({
  name: 'getSharedLeaderboard',
  data: { gameType: 'puzzle', limit: 50 },
});
console.log(result.result);

// ---- 访问共享环境的数据库 ----
const sharedDb = sharedCloud.database();

// 查询共享数据库（受资源方权限规则约束）
const res = await sharedDb.collection('global_items').get();

// ⚠️ 注意：在共享环境数据库中，_openid 是使用方用户在【资源方】下的 openid
// 如果资源方开启了 UnionID 机制，同一用户在不同小游戏下 openid 不同
// 但 unionid 相同，可以用 unionid 关联跨账号的用户数据

// ---- 访问共享环境的云存储 ----
const uploadResult = await sharedCloud.uploadFile({
  cloudPath: `shared-assets/${Date.now()}.png`,
  filePath: tempFilePath,
});
console.log('上传到共享存储:', uploadResult.fileID);
```

### 资源方云函数内：以使用方身份调用微信接口

当资源方的云函数需要以**使用方**（消费方）身份调用微信生态接口（如发送订阅消息、微信支付），必须显式指定 AppID：

```javascript
// 资源方云函数内（cloudfunctions/sendNotify/index.js）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const { FROM_APPID, FROM_OPENID } = cloud.getWXContext();

  // ✅ 指定 appid 为使用方 AppID，以使用方身份发消息
  await cloud.openapi({ appid: FROM_APPID }).subscribeMessage.send({
    touser: FROM_OPENID,
    templateId: 'template_id_in_consumer_account',
    page: 'pages/index',
    data: { thing1: { value: '您的游戏任务已完成' } },
  });

  // ✅ 以使用方身份发起微信支付
  await cloud.cloudPay({ appid: FROM_APPID }).unifiedOrder({
    body: '道具购买',
    outTradeNo: `ORDER_${Date.now()}`,
    totalFee: 100,
    envId: 'shared-env-id',
    functionName: 'payCallback',
  });
};
```

### 关键注意事项

**1. openid 跨账号不一致**

同一个用户在不同小游戏下的 `openid` 是**不同的**。使用方用户的 openid 是在使用方小游戏下的值，资源方无法直接用来关联自己的用户表。

```javascript
// 解决方案：用 unionid 关联（需要两个账号都绑定同一开放平台）
// 在 cloudbase_auth 中返回 unionid，数据库用 unionid 做跨账号用户关联

// 数据库安全规则（资源方配置）示例：
// {
//   "read": "auth.unionid == doc.unionid",
//   "write": "auth.unionid == doc.unionid"
// }
```

**2. 数据库权限与 _openid 字段**

共享环境数据库中，`_openid` 字段存储的是**资源方**视角下用户的 openid（由资源方的安全规则决定）。使用方写入数据时，若安全规则基于 `_openid`，需要特别注意这个字段的值是哪个账号维度的。

**3. init() 必须 await**

`sharedCloud.init()` 是异步的，内部会请求并完成 `cloudbase_auth` 鉴权流程。**必须 await** 后才能调用任何 API，否则会报"未初始化"错误。

```javascript
// ❌ 错误：未等待初始化完成就调用
const sharedCloud = new wx.cloud.Cloud({ resourceAppid: '...', resourceEnv: '...' });
sharedCloud.init(); // 没有 await！
sharedCloud.callFunction({ name: 'xxx' }); // 报错：cloud has not been initialized

// ✅ 正确
await sharedCloud.init();
await sharedCloud.callFunction({ name: 'xxx' });
```

**4. 终止共享后立即失效**

资源方或使用方任意一方在控制台解除共享关系后，使用方的所有 API 调用**立即失败**。应在游戏中做好降级处理：

```javascript
async function callSharedFunction(name, data) {
  try {
    const res = await sharedCloud.callFunction({ name, data });
    return res.result;
  } catch (err) {
    // errCode: -501000 表示无权访问（共享已解除或未授权）
    if (err.errCode === -501000) {
      console.error('共享环境访问权限已失效，请检查授权状态');
      // 降级到本地环境或提示用户
      return fallbackToLocalEnv(name, data);
    }
    throw err;
  }
}
```

**5. 共享上限与计费**

- 一个环境最多可共享给 **10 个**其他小程序/公众号
- 共享环境的所有费用由**资源方**承担（计费归属资源方）
- 使用方的访问量会计入资源方的配额消耗，大规模共享前需评估配额是否充足

---

## 实际应用示例

### 云开发版存档系统

```javascript
// CloudSaveManager.js：用云数据库替代本地文件存档
class CloudSaveManager {
  constructor() {
    this.db = wx.cloud.database();
    this.collection = this.db.collection('game_saves');
  }
  
  // 保存存档（自动用 openid 隔离，每个用户只有自己的数据）
  async save(slotId, saveData) {
    const data = {
      slotId,
      saveData,
      version: '1.0',
      savedAt: this.db.serverDate(),
    };
    
    // 查询是否已有该槽位的存档
    const existing = await this.collection
      .where({ slotId })
      .limit(1)
      .get();
    
    if (existing.data.length > 0) {
      await this.collection.doc(existing.data[0]._id).update({ data });
    } else {
      await this.collection.add({ data });
    }
  }
  
  // 读取存档
  async load(slotId) {
    const res = await this.collection
      .where({ slotId })
      .limit(1)
      .get();
    return res.data[0]?.saveData ?? null;
  }
  
  // 列出所有存档槽位
  async listSaves() {
    const res = await this.collection
      .orderBy('savedAt', 'desc')
      .get();
    return res.data;
  }
  
  // 删除存档
  async deleteSave(slotId) {
    const existing = await this.collection.where({ slotId }).get();
    if (existing.data.length > 0) {
      await this.collection.doc(existing.data[0]._id).remove();
    }
  }
}

export const cloudSave = new CloudSaveManager();
```

### 云开发版全球排行榜

```javascript
// 通过云函数实现防作弊的全球排行榜

// ---- 云函数：cloudfunctions/getGlobalRank/index.js ----
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const db = cloud.database();
  const { limit = 50, levelId = 'all' } = event;
  
  // 云函数有管理员权限，可以读取所有用户的数据
  const query = db.collection('scores');
  const whereClause = levelId !== 'all' ? query.where({ levelId }) : query;
  
  const res = await whereClause
    .orderBy('score', 'desc')
    .limit(limit)
    .get();
  
  // 关联用户昵称（从 players 集合）
  const openids = res.data.map(r => r._openid);
  const playersRes = await db.collection('players')
    .where({ _openid: db.command.in(openids) })
    .field({ _openid: true, nickname: true, avatar: true })
    .get();
  
  const playerMap = {};
  playersRes.data.forEach(p => { playerMap[p._openid] = p; });
  
  return res.data.map((entry, index) => ({
    rank: index + 1,
    score: entry.score,
    nickname: playerMap[entry._openid]?.nickname ?? '匿名玩家',
    avatar: playerMap[entry._openid]?.avatar ?? '',
  }));
};

// ---- 小游戏端调用 ----
async function showGlobalLeaderboard() {
  const res = await wx.cloud.callFunction({
    name: 'getGlobalRank',
    data: { limit: 50, levelId: 'level_1' },
  });
  renderLeaderboard(res.result);
}
```

### 云开发版礼包码兑换

```javascript
// cloudfunctions/redeemCode/index.js
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { code } = event;
  const db = cloud.database();
  const _ = db.command;
  
  try {
    // 事务操作：原子性地检查并消费礼包码
    const result = await db.runTransaction(async transaction => {
      // 查找有效的礼包码
      const codeRes = await transaction.collection('gift_codes')
        .where({ code, used: false, expireAt: _.gte(new Date()) })
        .limit(1)
        .get();
      
      if (codeRes.data.length === 0) {
        return { success: false, error: '无效或已使用的礼包码' };
      }
      
      const giftCode = codeRes.data[0];
      
      // 检查该用户是否已兑换过
      const alreadyUsed = await transaction.collection('redemption_records')
        .where({ code, _openid: OPENID })
        .count();
      
      if (alreadyUsed.total > 0) {
        return { success: false, error: '您已兑换过此礼包码' };
      }
      
      // 标记礼包码已使用
      await transaction.collection('gift_codes')
        .doc(giftCode._id)
        .update({ data: { used: true, usedBy: OPENID, usedAt: db.serverDate() } });
      
      // 记录兑换历史
      await transaction.collection('redemption_records').add({
        data: { code, _openid: OPENID, rewards: giftCode.rewards, redeemedAt: db.serverDate() }
      });
      
      // 发放奖励
      await transaction.collection('player_assets')
        .where({ _openid: OPENID })
        .update({
          data: {
            coins: _.inc(giftCode.rewards.coins ?? 0),
            gems: _.inc(giftCode.rewards.gems ?? 0),
          }
        });
      
      return { success: true, rewards: giftCode.rewards };
    });
    
    return result;
  } catch (err) {
    return { success: false, error: '兑换失败，请稍后重试' };
  }
};
```

---

## 云开发 vs 自建服务器

| 对比项 | 云开发 | 自建服务器 |
|--------|--------|-----------|
| 上手成本 | 极低（无需服务器知识）| 较高（需要运维）|
| 开发速度 | 快（前后端一体）| 慢（需前后端分离）|
| 身份验证 | 自动注入 openid | 需手动验证 token |
| 适合规模 | 中小型游戏（DAU < 50万）| 大型游戏 |
| 费用 | 按量付费，免费额度够小项目用 | 固定成本 |
| 数据库 | 文档型，灵活但无 JOIN | 关系型，支持复杂查询 |
| 可控性 | 受腾讯云限制 | 完全自主 |

> **推荐**：独立开发者和小团队优先考虑云开发，快速验证想法；成熟商业项目且 DAU > 10万时，考虑迁移到自建后端或混合架构。
