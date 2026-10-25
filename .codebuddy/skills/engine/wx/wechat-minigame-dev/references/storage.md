# 文件系统与本地存储

## 文件系统概述

微信小游戏的文件系统按用途分为三种：

| 类型 | 路径前缀 | 持久性 | 配额 | 典型用途 |
|------|---------|--------|------|---------|
| 临时文件 | `wxfile://tmp_` | 仅本次启动 | 无限制 | 下载文件、录音、截图 |
| 缓存文件 | `wxfile://` | 跨启动持久 | 与用户文件共享 200MB | 缓存下载的资源 |
| 用户文件 | `wx.env.USER_DATA_PATH/` | 跨启动持久 | 与缓存文件共享 200MB | 存档、配置文件 |

---

## 文件管理器（FileSystemManager）

```javascript
const fs = wx.getFileSystemManager();

// 写入文件（用户目录）
const saveDir = wx.env.USER_DATA_PATH;

fs.writeFile({
  filePath: `${saveDir}/save.json`,
  data: JSON.stringify({ level: 5, coins: 100 }),
  encoding: 'utf8',
  success: () => console.log('存档保存成功'),
  fail: (err) => console.error('保存失败', err)
});

// 同步写入（适合小数据，如配置）
try {
  fs.writeFileSync(`${saveDir}/config.json`, JSON.stringify(config), 'utf8');
} catch (e) {
  console.error('同步写入失败', e);
}

// 读取文件
fs.readFile({
  filePath: `${saveDir}/save.json`,
  encoding: 'utf8',
  success: (res) => {
    const saveData = JSON.parse(res.data);
    loadGame(saveData);
  },
  fail: () => {
    // 文件不存在，使用默认值
    loadDefaultGame();
  }
});

// 同步读取
try {
  const data = fs.readFileSync(`${saveDir}/save.json`, 'utf8');
  return JSON.parse(data);
} catch (e) {
  return null; // 文件不存在
}
```

---

## 游戏存档管理

```javascript
class SaveManager {
  constructor() {
    this.saveDir = wx.env.USER_DATA_PATH;
    this.fs = wx.getFileSystemManager();
  }

  save(slot, data) {
    const filePath = `${this.saveDir}/save_slot${slot}.json`;
    const saveData = {
      ...data,
      timestamp: Date.now(),
      version: '1.0.0'
    };
    
    this.fs.writeFileSync(filePath, JSON.stringify(saveData), 'utf8');
  }

  load(slot) {
    const filePath = `${this.saveDir}/save_slot${slot}.json`;
    try {
      const raw = this.fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      return null; // 存档不存在
    }
  }

  getSaveList() {
    return [1, 2, 3].map(slot => {
      const save = this.load(slot);
      return save ? { slot, ...save } : { slot, empty: true };
    });
  }

  delete(slot) {
    try {
      this.fs.unlinkSync(`${this.saveDir}/save_slot${slot}.json`);
    } catch (e) {}
  }
}

const saveManager = new SaveManager();
```

---

## 缓存下载的资源文件

```javascript
// 下载资源并持久化缓存，避免重复下载
async function getCachedOrDownload(url) {
  const fs = wx.getFileSystemManager();
  const saveDir = wx.env.USER_DATA_PATH;
  
  // 用 URL 生成唯一文件名
  const filename = url.split('/').pop();
  const localPath = `${saveDir}/${filename}`;
  
  // 检查本地是否已有缓存
  try {
    fs.accessSync(localPath); // 如果文件不存在会抛异常
    return localPath; // 已缓存，直接返回本地路径
  } catch (e) {
    // 未缓存，下载
  }
  
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode === 200) {
          // 将临时文件保存为持久文件
          fs.saveFile({
            tempFilePath: res.tempFilePath,
            filePath: localPath,
            success: () => resolve(localPath),
            fail: reject
          });
        }
      },
      fail: reject
    });
  });
}
```

---

## 键值存储（小数据）

对于简单的键值数据（如设置项、用户偏好），使用 `wx.setStorageSync` 更简便：

```javascript
// 存储（同步）
wx.setStorageSync('musicVolume', 0.8);
wx.setStorageSync('sfxEnabled', true);
wx.setStorageSync('userId', 'xxx');

// 读取（同步）
const volume = wx.getStorageSync('musicVolume') ?? 1.0; // 默认值
const sfxEnabled = wx.getStorageSync('sfxEnabled') ?? true;

// 删除
wx.removeStorageSync('oldKey');

// 清空所有 Storage（谨慎使用！）
wx.clearStorageSync();

// 异步版本（适合大数据，不阻塞主线程）
wx.getStorage({
  key: 'largeData',
  success: (res) => handleData(res.data),
  fail: () => useDefault()
});
```

> ⚠️ Storage 建议存储量：单个 key 不超过 1MB，总量不超过 10MB。大数据请用文件系统。
