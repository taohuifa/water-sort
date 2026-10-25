---
name: weixin-minigame-helper
version: 1.0.1
description: |
  微信小游戏CLI工具：预览、真机测试、上传发布。通过shell执行命令操作小游戏。

  触发条件：工作目录含game.js，或用户提到游戏/预览/运行/真机/上传/发布相关内容。
  触发词：预览、运行、跑一下、看看效果、真机预览、扫码体验、上传、发布、设置AppID/密钥。
  代码修改后自动执行run预览。

  执行动作：
  - 预览/运行 → run命令，返回H5预览链接
  - 真机/上传 → preview/publish命令，返回二维码图片
  - 配置 → set_ci_config命令保存AppID和密钥

  预览链接格式：https://{workspace_id}-{port}.gz.cloudide.woa.com/index.html
  真机二维码保存到项目temp目录。代码写完必须预览，缺配置时引导用户配置。
---

# 使用指南

## 🔴 最重要的规则

> **执行命令前的必要条件**：
> **执行任何 CLI 命令之前，必须先获取当前的 `workspace-id`！**
>
> `workspace-id` 用于生成正确的预览链接格式：`https://{workspace_id}-{port}.gz.cloudide.woa.com/index.html`
>
> 获取方式：从当前环境上下文中获取，或询问用户确认当前工作空间的 ID。
>
> **触发判断（宽松匹配）：**
> - 用户在开发小游戏，或工作目录有 `game.js`，或用户提到"游戏"相关内容 → 本 Skill 生效
> - 用户说了任何与"预览"、"运行"、"看看效果"相关的话 → 立即执行预览流程
> - **不需要用户精确说出"微信小游戏预览"才触发，"帮我预览"、"预览一下"、"跑起来看看"等口语表达都应触发**
>
> **自动预览规则：**
> 每当你为用户生成或修改了小游戏代码，代码写入完成后，必须立即执行 `run` CLI 命令让用户看到效果。不要等用户要求——这是自动的。

## CLI 命令参考

**环境变量说明：**
- `CLI_ROOT`：当前 Skill 文件（SKILL.md）所在的目录。执行 CLI 命令时，使用此变量定位 CLI 入口。

所有命令的基础格式：
```bash
node ${CLI_ROOT}/dist/cli/index.js <command> [options]
```

| 命令 | 功能 | 参数 |
|------|------|------|
| `run` | 启动/复用游戏预览 | `--workspace <dir>` `--workspace-id <id>` |
| `stop` | 停止预览服务 | `--workspace <dir>` `--workspace-id <id>` |
| `status` | 查看服务状态 | `--workspace <dir>` `--workspace-id <id>` |
| `logs` | 获取游戏日志 | `--workspace <dir>` `--workspace-id <id>` `[--filter <regex>]` |
| `preview` | 真机预览 | `--workspace <dir>` `--workspace-id <id>` |
| `publish` | 发布到微信 | `--workspace <dir>` `--workspace-id <id>` `--version <v>` `[--desc <d>]` |
| `set_ci_config` | 设置 CI 配置 | `--workspace <dir>` `--workspace-id <id>` `[--appid <id>]` `[--private-key <key>]` |

**重要**：所有命令都需要 `--workspace-id` 参数，用于计算管理服务器端口和生成对应的预览地址。

**所有命令输出 JSON 格式**，便于解析。

### 命令详解

#### `run` - 启动预览

```bash
node ${CLI_ROOT}/dist/cli/index.js run --workspace /path/to/game --workspace-id abc123
```

输出示例（新启动，配置缺失）：
```json
{"status":"started","url":"https://abc123-8234.gz.cloudide.woa.com/index.html","port":8234,"configMissing":true,"configPageUrl":"https://abc123-8234.gz.cloudide.woa.com/ci-config.html"}
```

输出示例（新启动，配置完整）：
```json
{"status":"started","url":"https://abc123-8234.gz.cloudide.woa.com/index.html","port":8234,"configMissing":false,"configPageUrl":"https://abc123-8234.gz.cloudide.woa.com/ci-config.html"}
```

输出示例（复用已有服务）：
```json
{"status":"reused","url":"https://abc123-8234.gz.cloudide.woa.com/index.html","port":8234,"configMissing":false,"configPageUrl":"https://abc123-8234.gz.cloudide.woa.com/ci-config.html"}
```

#### `stop` - 停止预览

```bash
node ${CLI_ROOT}/dist/cli/index.js stop --workspace /path/to/game --workspace-id abc123
```

输出示例：
```json
{"status":"stopped","port":8234}
```

#### `status` - 查看状态

```bash
node ${CLI_ROOT}/dist/cli/index.js status --workspace /path/to/game --workspace-id abc123
```

输出示例：
```json
{"status":"running","gameDir":"/path/to/game","workspaceId":"abc123","port":8234,"url":"https://...","startedAt":"2026-03-15T11:20:00.000Z","appId":"wx1234567890"}
```

#### `logs` - 获取日志

```bash
node ${CLI_ROOT}/dist/cli/index.js logs --workspace /path/to/game --workspace-id abc123
node ${CLI_ROOT}/dist/cli/index.js logs --workspace /path/to/game --workspace-id abc123 --filter "error|warn"
```

输出示例：
```json
{"status":"success","count":5,"logs":[{"timestamp":1710123456789,"level":"log","message":"Game started"},...]}
```

#### `preview` - 真机预览

```bash
node ${CLI_ROOT}/dist/cli/index.js preview --workspace /path/to/game --workspace-id abc123
```

**注意**：
- `--workspace-id` 参数是必需的
- CLI 会自动生成完整的二维码访问 URL（`qrcodeUrl` 字段）
- 执行此命令前需要先运行 `run` 命令启动预览服务

输出示例（成功）：
```json
{"success":true,"configMissing":false,"message":"Real device preview QR code generated successfully.","qrcodePath":"/path/to/game/temp/preview-qrcode-1710123456789.jpg","qrcodeUrl":"https://abc123-8234.gz.cloudide.woa.com/preview-qrcode/preview-qrcode-1710123456789.jpg","appId":"wx1234567890"}
```

输出示例（配置缺失）：
```json
{"success":false,"configMissing":true,"missingItems":["WeChat AppID","Private key"],"message":"Real device preview requires WeChat AppID and a code upload private key.","configPageUrl":"https://abc123-8234.gz.cloudide.woa.com/ci-config.html"}
```

**二维码图片访问**：
- CLI 会自动生成完整的二维码访问 URL（`qrcodeUrl` 字段）和本地图片路径（`qrcodePath` 字段）
- **优先直接发送图片给用户，而不是返回链接**
- 二维码会保存到游戏项目的 `temp` 目录下

**二维码图片发送规则（重要！）**：
1. 解析返回结果中的 `qrcodePath` 字段（本地图片文件路径）
2. 检查图片文件大小：
   - **小于 2MB**：直接发送图片文件给用户（最佳体验）
   - **大于等于 2MB**：返回 `qrcodeUrl` 链接给用户，让用户打开链接再查看二维码
3. 如果没有直接发送图片的能力，则返回 `qrcodeUrl` 链接

#### `publish` - 发布到微信

```bash
node ${CLI_ROOT}/dist/cli/index.js publish --workspace /path/to/game --workspace-id abc123 --version 1.0.0 --desc "Initial release"
```

**注意**：
- `--workspace-id` 参数是必需的
- 执行此命令前需要先运行 `run` 命令启动预览服务

输出示例（成功）：
```json
{"success":true,"configMissing":false,"message":"Mini Game v1.0.0 published successfully.","version":"1.0.0","appId":"wx1234567890"}
```

#### `set_ci_config` - 设置 CI 配置

当用户需要配置 AppID 和密钥时，使用此命令将配置保存到项目的 `.weixin-minigame-helper.json` 文件中。

```bash
node ${CLI_ROOT}/dist/cli/index.js set_ci_config --workspace /path/to/game --workspace-id abc123 --appid wx1234567890 --private-key "-----BEGIN PRIVATE KEY-----..."
```

参数说明：
- `--workspace`: 游戏项目目录（必填）
- `--workspace-id`: 工作空间ID（必填）
- `--appid`: 微信 AppID（可选，不传则保留原值）
- `--private-key`: 代码上传密钥内容（可选，不传则保留原值）

输出示例：
```json
{"success":true,"message":"CI config saved successfully.","configPath":"/path/to/game/.weixin-minigame-helper.json","appId":"wx1234567890","hasPrivateKey":true}
```

**注意**：密钥内容会以明文形式保存在项目目录中，请确保项目目录安全。

#### 配置页面

当预览服务器启动后，如果 CI 配置缺失，CLI 会返回 `configPageUrl` 字段。

配置页面访问路径：将预览 URL 中的 `/index.html` 替换为 `/ci-config.html` 即可访问配置页面。

例如：
- 预览 URL：`https://abc123-8234.gz.cloudide.woa.com/index.html`
- 配置页面：`https://abc123-8234.gz.cloudide.woa.com/ci-config.html`

配置页面功能：
- 显示本机公网 IP（用于配置微信 IP 白名单）
- 提供详细的配置步骤说明
- 表单验证 AppID 和密钥格式
- 提交后自动保存到 `.weixin-minigame-helper.json` 文件
- 配置保存成功后，服务器会自动更新配置，无需重启

## 工作流程

### 场景一：生成/修改小游戏代码后自动预览（最常见）

这是最典型的场景。用户让你写一个小游戏或修改游戏代码，你完成代码编写后：

1. **确保游戏目录中有 `game.js` 文件**（这是微信小游戏的入口文件）
2. **立即执行 CLI 命令**：
   ```bash
   node ${CLI_ROOT}/dist/cli/index.js run --workspace <游戏目录> --workspace-id <当前环境ID>
   ```
3. **管理服务器自动启动**：如果管理服务器未运行，CLI 会自动启动它
4. **解析 JSON 输出**，获取 `url` 字段
5. **告诉用户打开链接**：将预览链接返回给用户，用户打开链接即可预览游戏

**注意**：
- 管理服务器是常驻进程，会在后台持续运行
- 使用 `status` 命令检查服务器状态
- 使用 `stop` 命令停止服务器

### 场景二：查看日志调试问题

当游戏运行中出现问题时：
1. 执行 CLI 命令获取日志：
   ```bash
   node ${CLI_ROOT}/dist/cli/index.js logs --workspace <游戏目录> --workspace-id <workspace-id>
   ```
2. 可用 `--filter` 参数过滤，如 `--filter "error|warn"` 只看错误和警告
3. 日志格式: `timestamp`, `level`, `message`

### 场景三：真机测试

当用户要求在真机上测试：

**如果 CLI 返回 `configMissing: true`：**
1. 检查输出中的 `configPageUrl` 字段
2. 告诉用户：**"请打开以下链接配置你的 AppID 和密钥："**
3. 将 `configPageUrl` 返回给用户
4. 用户在配置页面填写完成后，告诉用户：**"配置完成！现在可以重新进行真机预览了。"**
5. 重新执行 `preview` 命令

**如果已配置好：**
1. 执行 CLI 命令（**必须传入 --workspace-id 参数**）：
   ```bash
   node ${CLI_ROOT}/dist/cli/index.js preview --workspace <游戏目录> --workspace-id <workspace-id>
   ```
2. 解析输出中的 `qrcodeUrl` 字段，**直接将 `qrcodeUrl` 返回给用户**，用户可以直接打开链接用微信扫码


### 场景四：发布到微信平台

1. 确认用户要发布的版本号和描述
2. 执行 CLI 命令（**必须传入 --workspace-id 参数**）：
   ```bash
   node ${CLI_ROOT}/dist/cli/index.js publish --workspace <游戏目录> --workspace-id <workspace-id> --version 1.0.0 --desc "Release notes"
   ```
3. 成功后告知用户新版本已上传，等待审核
4. **如果 CLI 返回了 `qrcodeUrl`**：直接将 `qrcodeUrl` 返回给用户，用户可以直接打开链接用微信扫码

### 场景五：识别并设置 APPID 和密钥

当用户消息中包含 APPID 或密钥时，自动识别并调用 `set_ci_config` 命令保存配置。

**APPID 格式识别规则**：
- 以 `wx` 开头
- 由字母和数字组成
- 总长度为 18 位
- 正则表达式：`^wx[a-zA-Z0-9]{16}$`
- 示例：`wx1234567890abcdef`、`wxABCD1234efgh5678`

**密钥格式识别规则**：
- 以 `-----BEGIN PRIVATE KEY-----` 开头
- 以 `-----END RSA PRIVATE KEY-----` 结尾
- 中间为 Base64 编码的密钥内容

**处理流程**：
1. 从用户消息中提取 APPID（匹配 `wx` 开头的 18 位字符串）
2. 从用户消息中提取密钥（匹配 `-----BEGIN PRIVATE KEY-----` ... `-----END RSA PRIVATE KEY-----`）
3. 执行 `set_ci_config` 命令保存配置：
   ```bash
   node ${CLI_ROOT}/dist/cli/index.js set_ci_config --workspace <游戏目录> --workspace-id <workspace-id> --appid <提取的AppID> --private-key "<提取的密钥>"
   ```
4. 告知用户配置已保存成功

**注意事项**：
- 如果只提供了 APPID 或密钥其中一个，只更新提供的那个配置项
- 密钥内容可能包含换行符，提取时需保留完整格式
- 保存密钥时使用双引号包裹，确保特殊字符正确传递

## 微信小游戏项目结构

一个标准的微信小游戏项目应包含：

```
game-dir/
├── game.js              # 入口文件（必须）
├── game.json            # 游戏配置
├── project.config.json  # 微信开发者工具项目配置（含 appid）
└── ... 其他资源文件
```

## 注意事项

- 游戏目录**必须**包含 `game.js` 文件
- **所有命令都需要 `--workspace-id` 参数**，用于计算管理服务器端口
- 管理服务器端口根据 workspaceId 哈希计算（8000-9000范围），相同 workspaceId 复用同一端口
- 预览页面在移动端 H5 中打开，适配移动端显示
- 真机测试和发布需要微信 AppID 和代码上传密钥
- 配置通过 `set_ci_config` 命令保存到项目的 `.weixin-minigame-helper.json` 文件中
- 返回的链接不要使用markdown的代码块语法，直接返回文本链接，前后各加一个空格，这样子用户可以直接点开链接

### ⚠️ IP 白名单错误处理

如果 `preview` 或 `publish` 命令返回错误消息中包含 `IP_WHITELIST_ERROR`，说明当前服务器 IP 不在微信小程序后台的白名单中。

**处理方式（二选一）**：
1. **添加服务器 IP 到白名单**：在微信公众平台后台【开发 - 开发管理 - 开发设置 - 小程序代码上传】中添加服务器 IP
2. **关闭 IP 白名单保护**：在微信公众平台后台【开发 - 开发管理 - 开发设置 - 小程序代码上传】中关闭 IP 白名单保护

**提示用户**：告诉用户当前服务器 IP（可从配置页面 `/ci-config.html` 获取），并提供上述两种解决方案。

## ⚠️ 重要约束

> **配置 AppID 和密钥的唯一方式**：
>
> **所有 AppID 和密钥的配置必须通过 ci-config 配置页面完成，禁止使用其他方式配置。**
>
> **配置流程**：
> 1. 当 `run`、`preview` 或 `publish` 命令返回 `configMissing: true` 时，CLI 会返回 `configPageUrl`
> 2. 告诉用户：**"请打开以下链接配置你的 AppID 和密钥："**
> 3. 将 `configPageUrl` 返回给用户
> 4. 用户在配置页面填写 AppID 和密钥后，配置会自动保存到项目的 `.weixin-minigame-helper.json` 文件
> 5. 配置页面会显示"配置完成！请回到对话框继续操作。"
> 6. 用户回来后，重新执行相应命令
>
> **禁止的做法**：
> - ❌ 跳过配置步骤
> - ❌ 使用测试账号或模拟数据
> - ❌ 使用其他用户的 AppID
> - ❌ 尝试绕过配置要求
> - ❌ 直接编辑 `.weixin-minigame-helper.json` 文件（应通过配置页面操作）