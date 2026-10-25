# 网络与通信

## HTTP 请求（wx.request）

### 基础用法
```javascript
// 完整配置示例
wx.request({
  url: 'https://api.your-game.com/v1/player/data',
  method: 'GET',  // GET | POST | PUT | DELETE | HEAD | OPTIONS | TRACE | CONNECT
  data: { playerId: 'xxx' },
  header: {
    'Authorization': `Bearer ${wx.getStorageSync('token')}`,
    'content-type': 'application/json'
  },
  timeout: 10000,  // 毫秒，默认 60000
  success: (res) => {
    // ⚠️ HTTP 4xx/5xx 也走 success 回调，必须判断 statusCode
    if (res.statusCode === 200) {
      handleData(res.data);
    } else if (res.statusCode === 401) {
      reLogin(); // Token 过期，重新登录
    }
  },
  fail: (err) => {
    // 网络异常（无网络、请求超时、域名不合法等）
    console.error('请求失败', err);
  }
});
```

### Promise 封装（推荐封装成工具函数）
```javascript
// utils/request.js
function request(options) {
  return new Promise((resolve, reject) => {
    wx.request({
      ...options,
      header: {
        'Authorization': `Bearer ${wx.getStorageSync('token')}`,
        'content-type': 'application/json',
        ...(options.header || {})
      },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject({ code: res.statusCode, data: res.data });
        }
      },
      fail: reject
    });
  });
}

// 使用
const playerData = await request({ url: 'https://api.your-game.com/player', method: 'GET' });
```

### 重要限制
- 最多 **10 个**并发 HTTP 请求
- 只支持 HTTPS（本地调试可临时关闭）
- 域名必须在微信公众平台后台"服务器域名"中配置
- 不支持 IP 地址和 localhost（本地调试除外）
- 不能修改 Referer header

---

## WebSocket 实时通信

适合：实时对战、聊天、排行榜实时更新

```javascript
class GameWebSocket {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectCount = 0;
    this.maxReconnect = 5;
  }

  connect() {
    this.socket = wx.connectSocket({
      url: this.url,
      header: { 'Authorization': wx.getStorageSync('token') }
    });

    this.socket.onOpen(() => {
      console.log('WebSocket 已连接');
      this.reconnectCount = 0;
      clearTimeout(this.reconnectTimer);
    });

    this.socket.onMessage((res) => {
      const msg = JSON.parse(res.data);
      this.handleMessage(msg);
    });

    this.socket.onClose(() => {
      console.log('WebSocket 断开，尝试重连...');
      this.scheduleReconnect();
    });

    this.socket.onError((err) => {
      console.error('WebSocket 错误', err);
    });
  }

  send(data) {
    this.socket?.send({ data: JSON.stringify(data) });
  }

  scheduleReconnect() {
    if (this.reconnectCount < this.maxReconnect) {
      const delay = Math.min(1000 * 2 ** this.reconnectCount, 30000); // 指数退避
      this.reconnectTimer = setTimeout(() => {
        this.reconnectCount++;
        this.connect();
      }, delay);
    }
  }

  close() {
    this.socket?.close({ code: 1000 });
  }
}

// 使用
const ws = new GameWebSocket('wss://realtime.your-game.com/game');
ws.connect();
ws.send({ type: 'MOVE', position: { x: 100, y: 200 } });
```

### WebSocket 限制
- 最多 **5 个**并发连接（同一 URL 也计入）
- 只支持 WSS 协议

---

## UDP Socket（局域网/P2P 对战）

适合：局域网多人游戏、低延迟通信

```javascript
const udp = wx.createUDPSocket();
udp.bind(8888); // 绑定本地端口

udp.onMessage((res) => {
  const data = new Uint8Array(res.message);
  // 处理接收到的数据
});

// 发送数据
udp.send({
  address: '192.168.1.100', // 目标 IP
  port: 8888,
  message: new ArrayBuffer(16) // 二进制数据
});

// 广播
udp.send({
  address: '255.255.255.255',
  port: 8888,
  message: encodeMessage({ type: 'HELLO' })
});

udp.close(); // 使用完毕关闭
```

---

## 文件上传与下载

```javascript
// 上传文件（如游戏截图上传到服务器）
wx.uploadFile({
  url: 'https://api.your-game.com/upload',
  filePath: tempFilePath, // 本地临时文件路径
  name: 'file', // 服务器接收的字段名
  formData: { type: 'screenshot' }, // 额外表单数据
  success: (res) => {
    const { imageUrl } = JSON.parse(res.data);
    console.log('上传成功', imageUrl);
  }
});

// 下载资源（游戏资源包、配置文件等）
const downloadTask = wx.downloadFile({
  url: 'https://cdn.your-game.com/assets/level2.zip',
  success: (res) => {
    if (res.statusCode === 200) {
      // res.tempFilePath 是下载后的临时文件路径
      // 保存为持久文件
      wx.getFileSystemManager().saveFile({
        tempFilePath: res.tempFilePath,
        filePath: `${wx.env.USER_DATA_PATH}/level2.zip`,
      });
    }
  }
});

// 监听下载进度（适合显示加载进度条）
downloadTask.onProgressUpdate((res) => {
  updateProgressBar(res.progress); // 0-100
  console.log(`已下载 ${res.totalBytesWritten} / ${res.totalBytesExpectedToWrite} 字节`);
});
```

---

## 网络状态监听

```javascript
// 获取当前网络状态
wx.getNetworkType({
  success: (res) => {
    // res.networkType: 'wifi' | '2g' | '3g' | '4g' | '5g' | 'none' | 'unknown'
    if (res.networkType === 'none') {
      showNoNetworkUI();
    }
  }
});

// 监听网络变化
wx.onNetworkStatusChange((res) => {
  if (!res.isConnected) {
    showNoNetworkUI();
  } else {
    hideNoNetworkUI();
    reconnectServer(); // 网络恢复后重连
  }
});
```
