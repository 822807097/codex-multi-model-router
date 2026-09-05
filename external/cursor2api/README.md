# cursor2api

<p align="center">
  <strong>面向 Cursor Composer 的 OpenAI / Anthropic 兼容 API 网关</strong><br>
  同时支持 <code>Responses</code> · <code>Messages</code> · <code>Chat Completions</code> 三种协议
</p>

<p align="center">
  <a href="https://github.com/NGLSG/cursor2api">GitHub</a>
  ·
  <a href="#快速部署">快速部署</a>
  ·
  <a href="#api">API 文档</a>
  ·
  <a href="#客户端接入">客户端接入</a>
</p>

> [!NOTE]
> 本项目仅供技术研究与学习交流。使用时请务必遵循 Cursor 官方使用条款及当地法律法规。

## 项目简介

**cursor2api** 是一个轻量级 API 网关，把一把或多把 **Cursor API Key**（`crsr_…`）转成标准 HTTP 接口。客户端只需配置 `baseUrl` + 网关 `apiKey`，即可接入 Cursor 上的 Composer、Claude、GPT 等模型，无需为每个工具单独写适配层。

与仅支持单一 OpenAI Chat 格式的早期版本不同，**当前版本完整支持三种主流协议**：

| 协议 | 端点 | 典型客户端 |
| :-- | :-- | :-- |
| **Responses** | `POST /v1/responses` | **Codex**、Cherry Studio |
| **Messages** | `POST /v1/messages` | **Claude Code**（Anthropic 兼容） |
| **Chat Completions** | `POST /v1/chat/completions` | OpenCode、Cline、Continue、VS Code 插件等 |

另有 `GET /v1/models`（动态模型列表）和 `GET /health`（健康检查）。Codex / Claude Code 的工具调用经 `@cursor/sdk` 本地 Bridge 转发。

支持 **Windows / Linux / macOS** 本地部署；可选 [Windows 托盘应用](desktop/README.md)（仅 Windows）；也保留 Cloudflare Worker 远程部署路径。

### 目录结构

```
cursor2api/
├── sidecar/          # 跨平台 API 网关（Responses / Messages / Chat）— Linux 部署核心
├── scripts/          # SDK Bridge、server.mjs 等
├── worker/           # 协议转换逻辑 + Cloudflare Worker
├── server.mjs        # 本地启动 CLI（start / stop / claude / codex）
├── desktop/          # 可选：Windows Tauri 托盘应用（Linux 不需要）
└── ...
```

| 目录 | 平台 | Linux 服务器需要？ |
| :-- | :-- | :-- |
| `sidecar/` + `server.mjs` | 全平台 | ✅ |
| `scripts/cursor-sdk-local-agent-bridge.mjs` | 全平台 | ✅ |
| `desktop/` | 仅 Windows | ❌ |
| `worker/`（Cloudflare） | 云端 | 可选 |

### 项目架构

```mermaid
flowchart LR
    classDef access fill:#e1f5fe,stroke:#01579b
    classDef core fill:#fff3e0,stroke:#e65100
    classDef bridge fill:#f3e5f5,stroke:#4a148c
    classDef upstream fill:#fce4ec,stroke:#880e4f

    subgraph Access["接入域"]
        direction LR
        Codex["Codex<br/>Responses"]
        Claude["Claude Code<br/>Messages"]
        ChatClients["OpenCode / Cline<br/>Chat Completions"]
    end

    subgraph Core["网关核心域"]
        direction LR
        Sidecar["Sidecar 服务<br/>Bun · 协议转换"]
        OpenAI["worker/openai.ts<br/>Responses · Chat"]
        Anthropic["anthropic.ts<br/>Messages"]
        OpenAI --- Anthropic
        Sidecar --> OpenAI
        Sidecar --> Anthropic
    end

    subgraph Bridge["SDK Bridge 域"]
        NodeBridge["Node Bridge<br/>@cursor/sdk"]
    end

    Upstream["🌐 Cursor 后端"]

    Codex --> Sidecar
    Claude --> Sidecar
    ChatClients --> Sidecar
    Sidecar --> NodeBridge
    NodeBridge --> Upstream

    class Codex,Claude,ChatClients access
    class Sidecar,OpenAI,Anthropic core
    class NodeBridge bridge
    class Upstream upstream
```

Sidecar 负责三种协议的入站解析与出站整形；SDK Bridge 用官方 `@cursor/sdk` 与 Cursor 后端通信（gRPC / HTTP2）。**只需你的 Cursor Key，无需额外后端密钥。**

### 核心能力

| 模块 | 能力 |
| :-- | :-- |
| **接口** | Responses、Chat Completions、Anthropic Messages；流式 SSE + 非流式 JSON |
| **客户端** | Codex、Claude Code、Cherry Studio，以及 OpenAI / Anthropic 兼容 SDK |
| **模型** | `GET /v1/models` 动态拉取所有 Cursor Key 的可用模型交集（Composer、Claude、GPT 等） |
| **工具** | Codex `exec` 等 Responses 工具、Claude Code 读写文件等 Messages 工具，经 SDK Bridge 转发 |
| **上下文** | Claude Code 1M 上下文（`claude-opus-5[1m]` 或 `anthropic-beta` 头） |
| **可靠性** | 多 Key 自动路由和账单熔断；SDK 瞬时断连自动重试；Bridge 凭据定期刷新 |
| **部署** | 本地 sidecar + bridge；可选 Windows Tauri 托盘；Cloudflare Worker |

### 协议边界

三种协议独立入口、统一后端，客户端按自身能力选择对应端点：

| 协议 | 鉴权方式 | 流式 | 工具调用 | 适用场景 |
| :-- | :-- | :-- | :-- | :-- |
| **Responses** | `Authorization: Bearer sk-…` | SSE | ✅ Codex 工具链 | Codex、Cherry Studio（Responses 模式） |
| **Messages** | `x-api-key: sk-…` 或 Bearer | SSE | ✅ Claude Code 工具 | Claude Code CLI |
| **Chat Completions** | `Authorization: Bearer sk-…` | SSE / JSON | 取决于客户端 | 通用 OpenAI 兼容 Agent |

## 快速部署

### 环境要求

| 依赖 | 版本 |
| :-- | :-- |
| Node.js | 20+（SDK Bridge **必须**用 Node） |
| Bun | 1.3+（Sidecar 服务） |
| Cursor 账号 | 已开通 API / Composer 权限 |

### 本地部署（推荐）

```bash
git clone https://github.com/NGLSG/cursor2api.git
cd cursor2api
npm ci   # 或 bun install

# 启动 Sidecar + SDK Bridge（前台，持续输出日志）
npm run dev
# 按 Ctrl+C 停止

# 停止
node server.mjs stop

# 查看状态
node server.mjs status
```

`npm run dev`、`start:local` 和 `node server.mjs start` 都启动同一套服务，并持续占用当前终端输出日志：

```bash
npm run start:local
npm run stop:local
```

启动后打开 `http://127.0.0.1:6718/dashboard`。首次访问设置管理员密码，随后导入 Cursor Key 并创建客户端使用的独立 `sk-…` API Key。前端、控制台、管理 API 和 `/v1/*` 网关均由 `6718` 端口上的同一个进程提供。

#### 获取 Cursor API Key

1. 打开 [cursor.com/dashboard](https://cursor.com/dashboard)。
2. 在左侧功能栏选择 **API KEY**。
3. 点击 **新建**，按 Cursor 页面提示创建密钥。
4. 复制页面显示的 `crsr_...` 密钥，并粘贴到网关控制台的“添加 Cursor 账号”中。

密钥只用于网关连接 Cursor；客户端应使用控制台创建的独立 `sk-...` Key，不要把 `crsr_...` 直接配置给 OpenAI、Anthropic 或其他客户端。

验证服务：

```bash
curl http://127.0.0.1:6718/health
export CURSOR_API_KEYS="team-a=crsr_KEY_A,team-b=crsr_KEY_B"
# 在 Dashboard 创建客户端 Key 后设置它
export CURSOR2API_API_KEY="sk_LOCAL_CLIENT_KEY"
node server.mjs models
curl -H "Authorization: Bearer $CURSOR2API_API_KEY" http://127.0.0.1:6718/v1/models
```

<details>
<summary>手动分进程启动（高级）</summary>

```bash
# 终端 1 — SDK Bridge
export CURSOR_SDK_BRIDGE_HOST=127.0.0.1
export CURSOR_SDK_BRIDGE_PORT=6719
export CURSOR_SDK_BRIDGE_TOKEN=$(openssl rand -hex 16)
node scripts/cursor-sdk-local-agent-bridge.mjs

# 终端 2 — Sidecar API
export PORT=6718
export CURSOR_SDK_BRIDGE_URL=http://127.0.0.1:6719/sdk
bun run sidecar/server.ts
```

</details>

### 默认地址

| 用途 | 地址 |
| :-- | :-- |
| OpenAI 兼容（Codex / Chat） | `http://127.0.0.1:6718/v1` |
| Anthropic 兼容（Claude Code） | `http://127.0.0.1:6718/v1` |
| 凭据管理后台 | `http://127.0.0.1:6718/dashboard` |
| 健康检查 | `http://127.0.0.1:6718/health` |

建议客户端使用 **`127.0.0.1`** 而非 `localhost`，避免 IPv6 解析导致连不上。

### 远程部署

**Cloudflare Worker**（仓库自带 `worker/` + D1）：

```bash
npm run deploy
```

**自建 VPS / Linux**：与本地相同，启动 sidecar + bridge 后用 systemd 或 Docker 守护进程即可。

### Docker Compose（预构建镜像）

仓库提供两个容器：预编译的 API Sidecar 和 Node SDK Bridge。镜像会发布到
Docker Hub（`docker.io/<用户名>/cursor2api-api` 和
`docker.io/<用户名>/cursor2api-bridge`）；保留的标准 Compose 也可以根据仓库中的
Dockerfile 本地构建。

```bash
cp .env.docker.example .env
# 编辑 .env，设置 ADMIN_PASSWORD、CURSOR_SDK_BRIDGE_TOKEN、ENCRYPTION_KEY
# Cursor Key 可以预先通过 CURSOR_API_KEY(S) 配置，也可以启动后在 Dashboard 导入

# 使用仓库中的 Compose（可拉取镜像，也可 `--build` 本地构建）
docker compose pull
docker compose up
```

Compose 同样只对外暴露一个 `6718` 端口。打开 `http://127.0.0.1:6718/dashboard`，使用 `.env` 中的 `ADMIN_PASSWORD` 登录即可管理凭据并创建客户端 Key。

`docker compose up` 默认以前台模式运行并持续输出两个容器的日志，按 `Ctrl+C`
停止。另一个终端可以检查状态：

```bash
docker compose ps
curl http://127.0.0.1:6718/health
```

没有可用的预构建镜像时，直接在仓库目录执行 `docker compose up --build` 即可本地
编译并启动。停止并清理容器和网络：

```bash
docker compose down
```

#### 直接拉 Docker Hub 镜像部署

服务器不需要安装 Node、Bun，也不需要克隆源码。准备一个空目录，下载 Docker Hub
专用 Compose 文件和环境变量模板，然后直接启动：

```bash
mkdir -p cursor2api && cd cursor2api
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/NGLSG/Cursor2API/master/docker-compose.dockerhub.yml
curl -fsSLo .env https://raw.githubusercontent.com/NGLSG/Cursor2API/master/.env.docker.example
# 编辑 .env：至少设置 ADMIN_PASSWORD、CURSOR_SDK_BRIDGE_TOKEN、ENCRYPTION_KEY
docker compose pull
docker compose up -d
docker compose ps
```

默认使用 `docker.io/nglsg/cursor2api-api:latest` 和
`docker.io/nglsg/cursor2api-bridge:latest`。如果你发布到自己的 Docker Hub
命名空间，在 `.env` 中修改 `CURSOR2API_IMAGE_NAMESPACE`；指定版本时设置
`CURSOR2API_IMAGE_TAG`，例如 `v0.2.0`。控制台地址为
`http://服务器地址:6718/dashboard`，日志和停止命令分别是：

```bash
docker compose logs -f
docker compose down
```

Docker Hub 自动发布需要在 GitHub 仓库配置 `DOCKERHUB_USERNAME` 和
`DOCKERHUB_TOKEN` 两个 Actions Secrets。推送 `master` 或 `v*` 标签后会发布 API
和 Bridge 两个镜像。

## 客户端接入

### Codex（Responses 协议）

`~/.codex/config.toml`：

```toml
model = "composer-2.5"   # 或 /v1/models 返回的任意 id
model_provider = "cursorapi"

[model_providers.cursorapi]
name = "Cursor API"
base_url = "http://127.0.0.1:6718/v1"
wire_api = "responses"
env_key = "CODEX_API_KEY"
```

```bash
export CODEX_API_KEY="sk_LOCAL_CLIENT_KEY"
codex

# 或一键启动（需已配置 codex profile，默认 cursor6718）
node server.mjs codex
node server.mjs codex --profile cursor6718 -- "你的提示词"
```

**实机效果** — Codex 经 cursor2api 调用终端 `exec`、扫描代码库、输出结构化分析：

![Codex 经 cursor2api 调用 exec 工具并生成项目概览](docs/screenshots/codex-demo.png)

### Claude Code（Messages 协议）

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:6718"
export ANTHROPIC_API_KEY="sk_LOCAL_CLIENT_KEY"
claude

# 或一键启动（自动注入上述环境变量）
export CURSOR2API_API_KEY="sk_LOCAL_CLIENT_KEY"
node server.mjs claude
node server.mjs claude -- "你的提示词"
```

### OpenCode / Cline 等（Chat 协议）

| 配置项 | 值 |
| :-- | :-- |
| Base URL | `http://127.0.0.1:6718/v1` |
| API Key | Dashboard 创建的 `sk-…` |
| Model | 从 `GET /v1/models` 选择 |

### Cherry Studio

| 配置项 | 值 |
| :-- | :-- |
| Base URL | `http://127.0.0.1:6718/v1` |
| API 类型 | OpenAI 兼容 / Responses API |
| API Key | Dashboard 创建的 `sk-…` |

### 客户端对照表

| 客户端 | Base URL | 协议 |
| :-- | :-- | :-- |
| Codex | `http://127.0.0.1:6718/v1` | Responses |
| Claude Code | `http://127.0.0.1:6718` | Messages |
| Cherry Studio | `http://127.0.0.1:6718/v1` | Responses / Chat |
| OpenCode / Cline | `http://127.0.0.1:6718/v1` | Chat |

## 模型与路由

cursor2api **不使用固定模型清单**。单 Key 模式下，`GET /v1/models` 实时读取该 Cursor 账号可用模型；多 Key 网关模式下，它会并行读取每把 Key 的模型目录并仅返回交集。

对话请求根据传入的 `model` 自动选择支持该模型的 Cursor Key。某把 Key 返回账单、额度或余额错误时，网关会将该 Key 的对应模型标记为禁用并切换到下一把 Key；限流、网络和临时 SDK 错误不会形成永久禁用。Docker 的禁用状态保存在 `router-data` 卷，Cloudflare Worker 则保存在 D1。

常见模型示例（以实际 `/v1/models` 返回为准）：

| 模型 | 类型 | 网关接口能力 |
| :-- | :-- | :-- |
| `composer-2.5` / `composer-2.5-fast` | 对话 | Responses、Chat、Messages |
| `claude-opus-5` / `claude-sonnet-5` 等 | 对话 | Responses、Chat、Messages |
| `gpt-5.6-sol-max` 等 | 对话 | Responses、Chat、Messages |

客户端应以 **`GET /v1/models` 返回的当前可服务模型** 为准。

## API

多 Key 网关模式下，推理接口使用在控制台创建的独立客户端 Key：

```http
Authorization: Bearer sk_YOUR_CLIENT_KEY
```

Anthropic 客户端也可使用：

```http
x-api-key: sk_YOUR_CLIENT_KEY
```

| 方法 | 路径 | 用途 |
| :-- | :-- | :-- |
| `GET` | `/health` | 健康检查 |
| `GET` | `/v1/models` | 当前可服务模型列表 |
| `POST` | `/v1/responses` | Responses JSON / SSE（Codex） |
| `POST` | `/v1/chat/completions` | Chat Completions JSON / SSE |
| `POST` | `/v1/messages` | Anthropic Messages JSON / SSE（Claude Code） |
| `POST` | `/v1/messages/count_tokens` | Claude Code 预发送 token 估算 |

### 请求示例

**Responses（Codex）：**

```bash
curl http://127.0.0.1:6718/v1/responses \
  -H "Authorization: Bearer sk_YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "input": "分析这个项目结构",
    "stream": true
  }'
```

**Messages（Claude Code）：**

```bash
curl http://127.0.0.1:6718/v1/messages \
  -H "x-api-key: sk_YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-5",
    "max_tokens": 4096,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

**Chat Completions（通用）：**

```bash
curl http://127.0.0.1:6718/v1/chat/completions \
  -H "Authorization: Bearer sk_YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

## 配置说明

本地进程管理 CLI（[`server.mjs`](server.mjs)）：

| 命令 | 说明 |
| :-- | :-- |
| `node server.mjs start [--port 6718]` | 前台启动 Sidecar + Bridge |
| `node server.mjs stop` | 停止运行中的进程 |
| `node server.mjs status` | 查看运行状态 |
| `node server.mjs models [--json]` | 列出可用模型 |
| `node server.mjs claude [-- ...]` | 注入 Anthropic 环境变量并启动 Claude Code |
| `node server.mjs codex [--profile NAME] [-- ...]` | 注入 CODEX_API_KEY 并启动 Codex |

Sidecar 与 Bridge 通过环境变量配置，参考 [`.env.example`](.env.example)：

| 变量 | 说明 | 默认值 |
| :-- | :-- | :-- |
| `PORT` | Sidecar 监听端口 | `8787`（脚本默认 `6718`） |
| `HOST` | 绑定地址 | `127.0.0.1` |
| `CURSOR_API_KEY` | 单把 Cursor Key；可与 Key 池合并 | — |
| `CURSOR_API_KEYS` | 多把 Cursor Key，支持逗号/换行、`label=key` 或 JSON 数组 | — |
| `ADMIN_PASSWORD` | 控制台管理员密码；Compose 中必填 | — |
| `PUBLIC_BASE_URL` | 可选的对外网关地址，控制台也可更新 | 请求地址 |
| `LOCAL_AUTH_STATE_PATH` | 管理员凭据与客户端 Key 的状态文件 | 与路由状态相邻 |
| `CURSOR2API_API_KEY` | CLI 使用的客户端 `sk-…` Key | — |
| `CURSOR_ROUTER_STATE_PATH` | Key+模型禁用状态文件 | 内存（Compose 使用数据卷） |
| `CURSOR_SDK_BRIDGE_URL` | Bridge 地址 | — |
| `CURSOR_SDK_BRIDGE_TOKEN` | Bridge 鉴权 Token | — |
| `CURSOR_SDK_BRIDGE_HOST` | Bridge 绑定地址 | `127.0.0.1` |
| `CURSOR_SDK_BRIDGE_PORT` | Bridge 端口 | 随机 |

> [!TIP]
> SDK Bridge **必须用 Node 运行**（不能换 Bun）：`@cursor/sdk` 依赖 sqlite3 原生模块和 gRPC over HTTP/2。

运行时日志与进程状态：`~/.cursor2api/`（Windows 为 `%USERPROFILE%\.cursor2api\`）

## 常见问题

| 现象 | 处理 |
| :-- | :-- |
| 刚启动第一次请求失败 | SDK Bridge 冷启动约 10–15 秒，等一会重试 |
| 客户端连不上但 curl 正常 | 改用 `127.0.0.1`，不要用 `localhost` |
| `401 unauthorized` | Key 无效 / 已撤销，或启动后才设置 Key — 重启服务 |
| Codex 工具不执行 | 确认 `wire_api = "responses"` 且设置了 `CODEX_API_KEY` |
| Claude Code 404 | Base URL **不要**带 `/v1` |
| 偶发 `socket connection closed` | SDK 瞬时故障，服务自动重试最多 3 次 |
| Cherry Studio 校验报错 | 确保 SSE 错误事件格式正确（本版本已修复） |

## 生产检查

- Sidecar 默认绑定 `127.0.0.1`，仅本机可访问；公网暴露请前置反向代理 + HTTPS + 访问控制。
- **不要**将 `crsr_…` Key、`.dev.vars`、签名证书提交到仓库。
- Bridge Token 每次启动随机生成，仅 loopback 内共享。
- 远程 VPS 部署时限制防火墙，仅允许可信 IP 访问 API 端口。

## 开发验证

```bash
npm test              # vitest（worker + bridge）
npm run typecheck
npm run test:sidecar   # 或 cd sidecar && bun test
```

## 可选组件

| 组件 | 说明 |
| :-- | :-- |
| [Windows 托盘应用](desktop/README.md) | Tauri 2 系统托盘，默认端口 8787，Credential Manager 存 Key，一键配置 Agent |
| [Cloudflare Worker](worker/) | 远程多用户网关（需自行部署到 CF 账号） |

## 相关文档

- [Windows 托盘应用](desktop/README.md)
- [构建契约](desktop/BUILD_CONTRACT.md)
- [变更日志](CHANGELOG.md)
- [上游项目 composer-api](https://github.com/standardagents/composer-api)

## 致谢

基于 **[standardagents/composer-api](https://github.com/standardagents/composer-api)**（MIT）fork 并扩展。

**[NGLSG/cursor2api](https://github.com/NGLSG/cursor2api)** 新增：跨平台 sidecar 部署、**Responses / Messages / Chat 三协议**、Codex 工具转发、Claude Code Anthropic 适配、动态模型列表、Cherry Studio SSE 修复、可选 Windows 托盘应用。

Powered by [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) 与 Cursor Composer 模型。

[LINUX DO](https://linux.do/)提供的交流社区
## License

[MIT](LICENSE)
