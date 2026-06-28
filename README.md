# Trae Local API

将 Trae IDE 变成本地 OpenAI/Anthropic 兼容 API 服务，让 Claude Code、Cursor、Cline 等第三方工具直接调用 Trae 底层模型。

支持四个 Trae 版本:Trea CN、TRAE SOLO CN、Trae SG(国际版)、TRAE SOLO(国际版)。

## 功能

- 自动解密四版本认证数据(CN/SOLO/SOLO-SG 使用 tc 加密,SG 使用明文 JSON)
- 提供 OpenAI (`/v1/chat/completions`) 和 Anthropic (`/v1/messages`) 兼容接口
- Token 过期自动刷新，自动保存到 `.env`
- Claude 模型名自动映射到 Trae 内部模型
- 支持流式输出
- 3 级 API 端点回退
- 完整支持 Claude Code 工具调用(tool_use content block)
- 自适应 CN/SG 两种 SSE 事件格式(CN 带 `event:output` 前缀,SG 大部分 data 行无 event 前缀)

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置版本(可选)

在 `.env` 中设置 `TRAE_EDITION`(不设置默认 `cn`):

| 值 | 对应 IDE | storage.json 路径 | 加密格式 | 上游端点 |
|----|----------|-------------------|----------|----------|
| `cn` | Trae CN 国内版 | `%APPDATA%\Trae CN\User\globalStorage\storage.json` | tc 加密 | `trae-api-cn.mchost.guru` |
| `solo` | TRAE SOLO CN 独立部署版 | `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json` | tc 加密 | `trae-api-cn.mchost.guru` |
| `sg` | Trae 国际版 | `%APPDATA%\Trae\User\globalStorage\storage.json` | 明文 JSON | `a0ai-api-sg.byteintlapi.com` |
| `solo-sg` | TRAE SOLO 国际版 | `%APPDATA%\TRAE SOLO\User\globalStorage\storage.json` | tc 加密 | `a0ai-api-sg.byteintlapi.com` |

> **CN 与 SG 差异**:
> - CN/SOLO 与 SG/SOLO-SG 分别走国内/国际上游端点
> - SG 版 `storage.json` 中认证字段为明文 JSON,其他三版均为 `tc` 加密
> - SSE 事件格式:CN 每条 `data:` 前都有 `event:output`;SG 大部分 `data:` 行无 `event:` 前缀(本项目已自动适配)
> - SOLO CN 与 CN 共用 chat API 端点,SOLO SG 与 SG 共用 chat API 端点,仅认证文件路径不同

### 3. 一键启动

```bash
# Windows 双击即可
start.bat

# 或命令行
npm start
```

首次运行会自动从对应 IDE 的 `storage.json` 解密认证数据并保存到 `.env`，之后直接读取 `.env` 启动。

### 4. 连接 Claude Code

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:9220"
$env:ANTHROPIC_API_KEY = "trae-local-api"
claude
```

### 5. 连接 Cursor

- Base URL: `http://localhost:9220/v1`
- API Key: `trae-local-api`
- Model: `auto`

### 6. Python 调用

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9220/v1", api_key="trae-local-api")

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

## 手动解密

```bash
npm run setup
```

解密本机 Trae CN 配置并保存到 `.env`。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/status` | 服务状态 |
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | OpenAI 格式对话 |
| POST | `/v1/messages` | Anthropic 格式对话 |

## 模型映射

| 请求模型 | 映射到 | 档位 |
|----------|--------|------|
| claude-opus-4-7/4-6/4-5 | glm-5.2 | T1 |
| claude-sonnet-4-6/4-5/4 | glm-5.2 | T1 |
| claude-3.5/3.7-sonnet | glm-5.2 | T1 |
| claude-haiku-4-5 | glm-5.1 | T2 |
| gpt-4o | DeepSeek-V4-Pro | T2 |
| auto | glm-5.2 | T1 |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TRAE_EDITION` | Trae 版本 (cn/solo/sg/solo-sg) | cn |
| `TRAE_TOKEN` | 解密后的 JWT Token | (自动生成) |
| `TRAE_REFRESH_TOKEN` | 刷新用 Token | (自动生成) |
| `TRAE_USER_ID` | 用户 ID | (自动生成) |
| `TRAE_API_HOST` | Token 刷新服务地址(随版本自动设置) | (自动生成) |
| `API_KEY` | 本服务的 API Key | trae-local-api |
| `PORT` | 监听端口 | 9220 |

## 前置条件

- Node.js >= 18
- 已安装并登录任一 Trae IDE:Trea CN / TRAE SOLO CN / Trae(国际版) / TRAE SOLO(国际版)
- 对应 IDE 的 `%APPDATA%` 目录下存在 `globalStorage/storage.json`

## 项目结构

```
trae-local-api/
├── start.bat              # 一键启动脚本
├── setup.js               # 自动解密配置
├── src/
│   ├── server.js          # Express 服务器
│   ├── auth.js            # 认证管理
│   ├── trae-decrypt.js    # tc 加密解密
│   ├── trae-client.js     # Trae API 客户端
│   ├── openai-format.js   # OpenAI 格式转换
│   └── anthropic-format.js # Anthropic 格式转换
└── .env                   # 自动生成的配置
```

## tc 加密协议

Trae CN / TRAE SOLO CN / TRAE SOLO(国际版) 对本地存储的认证数据使用自定义的 "tc" 加密格式:

1. Base64 解码 → `[6B Header][32B RandomBytes][N EncryptedData]`
2. Header `0x74 0x63` ("tc") 标识 AES 类型
3. 密钥派生：`SHA-512(RandomBytes)` → XOR 盐值 → `SHA-512` → Key(16B) + IV(16B)
4. AES-128-CBC 解密 → `[64B SHA-512 Hash][Plaintext JSON]`
5. 哈希验证 → 明文 `{ token, refreshToken, userId, ... }`

> **Trae SG(国际版)例外**:该版本 `iCubeAuthInfo://icube.cloudide` 字段直接存储明文 JSON,无需解密,`trae-decrypt.js` 中会自动识别并跳过解密流程。
