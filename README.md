# codex-multi-model-router

Codex 桌面端本地多模型路由代理，让官方 GPT、DeepSeek、Qwen 等模型在同一选择器里共存，并为文本模型提供视觉中继能力。

## 特性

- **多模型共存**：官方 GPT 系列、DeepSeek、Qwen 等模型同时出现在 Codex 桌面端选择器中，会话内可热切换
- **Responses ↔ Chat 协议转换**：对 `wireApi: "chat"` 的通道，把 Codex 的 Responses 请求转成 Chat 格式发给 DeepSeek/Qwen（其 Chat API 更稳定），响应再转回 Responses，解决第三方模型“闪跳/从头重推”问题
- **工具调用转换**：自动转换 `tools` 定义与 `tool_calls`/`tool` 结果，让第三方模型真正执行工具而不是只描述
- **视觉中继**：为不支持图片的文本模型（如 DeepSeek）提供“借眼”能力——收到图片时先调用视觉模型生成描述，注入上下文后转发
- **无感更新**：`/_admin/shutdown` 优雅退出 + 新进程立即接管，更新路由不打断在跑任务
- **并发安全**：Node 事件循环 + 每请求独立状态 + 进程级异常兕底，多任务并发不崩溃
- **1M 上下文**：`modelContext` 配置写回 models.json，支持 DeepSeek-V4-Flash 1M 上下文窗口
- **零依赖**：纯 Node.js 实现，无需任何 npm 包，Node >= 18 即可运行
- **密钥安全**：API Key 全部通过环境变量注入，配置文件无明文
- **官方登录态复用**：自动读取 Codex 桌面端 auth.json，临期自动 refresh（single-flight 防并发竞态），无需二次登录
- **一键运维**：提供启动/停止/重启/状态/测试/恢复官方配置/恢复自定义配置 7 个脚本

## 演示

### 多模型共存 + 深度推理

DeepSeek-V4-Flash 在 Codex 桌面端处理复杂代码审查任务，支持会话内热切换模型：

![DeepSeek 代码审查](docs/demo-deepseek-coding.png)

### 视觉中继：文本模型"借眼"看图

给 DeepSeek-V4-Flash 发送截图，路由自动调用 Qwen3.8-Max 生成图片描述，DeepSeek 基于描述回答：

![视觉中继截图识别](docs/demo-vision-relay.png)

## 架构

```
Codex 桌面端 ──▶ 127.0.0.1:15730 (router)
   ├─ gpt-*/codex-*  ──▶ 本地代理隧道 ──▶ chatgpt.com（复用桌面端登录态）
   ├─ deepseek-*     ──▶ api.deepseek.com（环境变量 key，直连）
   └─ qwen*          ──▶ 阿里云 Token Plan（环境变量 key，直连）
```

视觉中继流程（文本模型收到图片时）：
```
用户发图 / 插件回传截图 → 路由拦截 → 调用视觉模型写描述 → 替换为 [image description: ...] → 转发给文本模型
```

中继覆盖两类图片来源：
- **用户直接贴图**（user 消息的 content）
- **浏览器/电脑操作插件回传的屏幕截图**（function_call_output 的 output）

> 注意：视觉中继是“借眼”方案，适合理解截图内容（报错、UI、代码）。若要做**精确的 GUI 自动化操作**（browser / computer-use 插件），建议切换到原生视觉模型（qwen3.8-max 或官方 GPT），因为 2-4 句描述不足以支撑像素级定位。

## 快速开始

### 1. 环境变量

设置以下 Machine 级环境变量：

```
DEEPSEEK_API_KEY=sk-xxx
BAILIAN_API_KEY=sk-xxx
```

### 2. 模型目录

复制 `models.template.json` 到 `~/.codex/models.json`（或 `CODEX_HOME/models.json`），按需增改模型条目。

**注意**：自定义模型必须包含 `input_modalities: ["text", "image"]` 才能在桌面端发图（前端门控）。

### 3. 配置文件（Codex 接入路由）

编辑 `~/.codex/config.toml`（不存在则新建）：

```toml
model = "gpt-5.6-terra"
model_provider = "router"
model_catalog_json = "~/.codex/models.json"

[model_providers.router]
name = "LocalRouter"
base_url = "http://127.0.0.1:15730/v1"
wire_api = "responses"
requires_openai_auth = true   # 门控钥匙：让桌面端按官方身份放行自定义模型
supports_websockets = false
```

**字段说明**：
- `model_provider = "router"`：把默认供应商指向路由
- `base_url`：路由监听地址（与 config.json 的 `port` 一致）
- `wire_api = "responses"`：桌面端以 Responses API 与路由通信
- `requires_openai_auth = true`：**关键**，桌面端选择器显示自定义模型的前提（门控钥匙）
- `model_catalog_json`：模型目录，决定选择器里有哪些模型

**关键**：`requires_openai_auth = true` 是桌面端选择器显示自定义模型的前提。

### 4. 启动路由

**Windows (PowerShell)**：

```powershell
cd scripts
.\start-router.ps1
```

或使用无窗口启动（适合开机自启）：

```powershell
wscript start-router-silent.vbs
```

**Linux/macOS (bash)**：

```bash
cd scripts
chmod +x *.sh
./start-router.sh
```

后台运行：

```bash
nohup ./start-router.sh > /tmp/codex-router.log 2>&1 &
```

**npm 用户**：

```bash
npm install
codex-router start
```

### 5. 验证

```bash
# Windows
.\test-router.ps1

# Linux/macOS
./test-router.sh

# 或 npm
codex-router test
```

预期输出：
```
[路由] 运行中 targets: openai, deepseek, bailian
[env] DEEPSEEK_API_KEY 已设置
[env] BAILIAN_API_KEY 已设置
[OK]  deepseek-v4-flash -> 回复: OK (1124ms)
[OK]  qwen3.8-max -> 回复: OK (1776ms)
[OK]  视觉中继 deepseek+图片 -> 回复: red
[OK]  官方通道 -> 200 流式正常
总结: 全部通过
```

### 6. 重启 Codex 桌面端

完全退出 Codex（任务管理器确认 ChatGPT.exe 全关）再重开，选择器应显示全部模型。

## 运维脚本

所有脚本提供 PowerShell (`.ps1`) 和 bash (`.sh`) 双版本，自动备份 `config.toml`（带时间戳，永不覆盖）。

| 脚本 | 功能 |
|------|------|
| `start-router.ps1` / `start-router.sh` | 前台启动路由（便于看日志） |
| `start-router-silent.vbs` | 无窗口启动（Windows 开机自启用） |
| `stop-router.ps1` / `stop-router.sh` | 停止路由 |
| `restart-router.ps1` / `restart-router.sh` | 重启路由（改完配置/key 后执行） |
| `status-router.ps1` / `status-router.sh` | 查看路由状态（PID + 健康检查） |
| `test-router.ps1` / `test-router.sh` | 一键验收（改完 key/URL 后运行） |
| `restore-official.ps1` / `restore-official.sh` | 一键恢复官方配置（移除路由，停止服务） |
| `restore-custom.ps1` / `restore-custom.sh` | 一键恢复自定义模型组合 |

**npm 用户**可直接使用 `codex-router <command>`（见 `package.json` 的 `scripts` 字段）。

## 配置说明

所有可修改参数集中在 `config.json`（与 `codex-router.mjs` 同目录），修改后执行 `restart-router.ps1` 生效。

### config.json 结构

```json
{
  "port": 15730,
  "proxy": { "host": "127.0.0.1", "port": 10808 },
  "paths": { "auth": null, "catalog": null },
  "oauth": { "client_id": "app_EMoamEEZ73f0CkXaXp7hrann", "refresh_skew_seconds": 30 },
  "targets": [
    {
      "match": "^(gpt-|codex-|o\\d|computer-use)",
      "name": "openai",
      "host": "chatgpt.com",
      "prefix": "/backend-api/codex",
      "viaProxy": true,
      "vision": true
    },
    {
      "match": "^deepseek-",
      "name": "deepseek",
      "host": "api.deepseek.com",
      "prefix": "",
      "viaProxy": false,
      "vision": false,
      "envKey": "DEEPSEEK_API_KEY",
      "wireApi": "chat"
    },
    {
      "match": "^qwen",
      "name": "bailian",
      "host": "token-plan.cn-beijing.maas.aliyuncs.com",
      "prefix": "/compatible-mode/v1",
      "viaProxy": false,
      "vision": true,
      "envKey": "BAILIAN_API_KEY",
      "wireApi": "chat"
    }
  ],
  "supportsResponses": {
    "slugs": ["deepseek-v4-flash", "qwen3.8-max"]
  },
  "modelContext": {
    "enabled": true,
    "contextWindow": 1048576,
    "autoCompactTokenLimit": 1000000,
    "slugs": ["deepseek-v4-flash", "deepseek-v4-pro", "qwen3.8-max"]
  },
  "visionRelay": {
    "host": "token-plan.cn-beijing.maas.aliyuncs.com",
    "prefix": "/compatible-mode/v1",
    "model": "qwen3.8-max",
    "envKey": "BAILIAN_API_KEY",
    "prompt": "Describe this image concisely (2-4 sentences) for a coding assistant that cannot see it.",
    "maxTokens": 300
  }
}
```

### 字段说明

**顶层**
- `port`：路由监听端口（默认 15730）
- `proxy`：本地代理地址（官方通道 CONNECT 隧道用）
- `paths`：auth.json / models.json 路径（null = 使用 CODEX_HOME 默认位置）
- `oauth`：ChatGPT OAuth client_id 和 token 刷新提前量（秒）

**targets[]** — 路由规则，按请求体 `model` 字段匹配，命中第一条即用之
- `match`：正则字符串，匹配模型 ID
- `host`：上游域名
- `prefix`：上游路径前缀（请求路径 `/v1/responses` 会去掉 `/v1` 后拼到 `prefix` 后）
- `viaProxy`：`true` = 经本地代理 CONNECT 隧道（国内连 chatgpt.com 需要）
- `vision`：`false` = 该通道是文本模型，收到图片时走视觉中继；`true` = 原样透传
- `envKey`：该通道 API key 所在的环境变量名（官方通道不用，走 auth.json）
- `wireApi`：`"chat"` = 做 Responses→Chat 协议转换（推荐第三方模型，解决闪跳）；默认/不填 = 原样转发 Responses

**supportsResponses** — 精确声明哪些模型原生支持 Responses 协议（`previous_response_id`），在 `/models` 端点声明能力

**modelContext** — 路由启动时写回 models.json 的上下文窗口配置
- `contextWindow`/`max_context_window`：上下文窗口（DeepSeek-V4-Flash 支持 1M）
- `autoCompactTokenLimit`：超过即触发桌面端压缩
- `slugs`：作用的模型列表

**visionRelay** — 视觉中继配置
- 文本模型（`vision: false`）收到 `input_image` 时，调用这里配置的视觉模型生成描述
- `prompt`：发给视觉模型的提示词
- `maxTokens`：视觉模型最大输出 token 数

### 环境变量优先级

环境变量优先级高于 `config.json`：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CODEX_HOME` | Codex 数据目录 | `~/.codex` |
| `CODEX_AUTH_PATH` | 覆盖 auth.json 路径 | `$CODEX_HOME/auth.json` |
| `CODEX_CATALOG_PATH` | 覆盖 models.json 路径 | `$CODEX_HOME/models.json` |
| `ROUTER_PORT` | 监听端口 | `config.json:port` 或 `15730` |
| `V2RAY_HOST` | 代理主机 | `config.json:proxy.host` 或 `127.0.0.1` |
| `V2RAY_PORT` | 代理端口 | `config.json:proxy.port` 或 `10808` |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | - |
| `BAILIAN_API_KEY` | 阿里云百炼 API Key | - |

## 网络与代理（v2rayN 可选）

官方 GPT 通道（`chatgpt.com`）在**国内直连不通**，默认经本地代理（v2rayN 等）的 CONNECT 隧道出海（`viaProxy: true`）。

**如果你不用代理客户端**（如在海外、或有其他直连方式），把 openai 通道的 `viaProxy` 设为 `false` 即可直连：

```json
{
  "match": "^(gpt-|codex-|o\\d|computer-use)",
  "name": "openai",
  "host": "chatgpt.com",
  "prefix": "/backend-api/codex",
  "viaProxy": false,   // 不用代理，直连
  "vision": true
}
```

- `viaProxy: true`：经 `proxy.host:proxy.port`（默认 127.0.0.1:10808）CONNECT 隧道，适合国内 + v2rayN
- `viaProxy: false`：直连上游，适合海外/有直连条件
- 第三方通道（deepseek/qwen）国内可直连，默认 `viaProxy: false`

代理端口可在 config.json 的 `proxy` 字段或环境变量 `V2RAY_HOST`/`V2RAY_PORT` 调整。

## 常见问题

### 桌面端选择器不显示自定义模型

检查 `config.toml` 的 `[model_providers.router]` 是否包含 `requires_openai_auth = true`。这是桌面端门控钥匙，缺少则前端隐藏自定义模型。

### 发图时报 "This model does not support image inputs"

检查 `models.json` 里该模型的 `input_modalities` 是否包含 `"image"`。前端按此字段决定是否允许贴图。

### 视觉中继描述不准确

视觉中继依赖视觉模型的图片理解能力。对截图类图片（报错截图、UI 图）效果最好，因为提示词让它重点提取文字/代码/界面元素。

### 官方通道 429

OpenAI 官方额度用尽，链路正常，等额度重置或升级套餐。

### 第三方模型“闪跳”（从头重推/重复执行工具）

Codex 桌面端对第三方模型每轮重发全量历史，若上游 Responses 支持不完善，模型会“看不懂”历史而从头重推。解决：给该通道设 `wireApi: "chat"`，路由转成 Chat 格式（丢弃 reasoning、正确映射 tool_calls/tool），模型即可连贯续接。

### 第三方模型不执行工具、只描述计划

Chat 请求必须带 `tools` 定义模型才会发 `tool_calls`。路由已自动转换 `tools`；若仍不执行，检查桌面端是否发送了 tools 字段。

### 子代理并行（collaboration）不可用

子代理并行是 Codex 桌面端对**官方模型**开放的运行时编排特性，第三方模型被标记 `unsupported call`。模型会自动降级为单代理并行 shell，属正常行为（cc-switch/Codex++ 同样如此）。

### 更新路由会打断在跑任务吗

不会。`restart-router.ps1` 先 `POST /_admin/shutdown` 让旧进程释放端口并排空在跑任务，新进程立即接管新请求；在跑的流式任务在旧进程上自然结束。

### 改完环境变量 key 后不生效

路由进程启动时才读取环境变量，必须执行 `restart-router.ps1` 后再跑 `test-router.ps1` 验证。

## 技术细节

- **TLS 隧道**：官方通道经本地代理 HTTP CONNECT 隧道出海，裸写 HTTP/1.1 请求（Node `http.request` 的 `createConnection` 实测不生效）
- **Chunked 解码**：上游 chunked 响应透传时必须先解包，否则 Node `ServerResponse` 会再套一层 chunked 封装，客户端解析直接坏掉（SSE 尤甚）
- **Responses↔Chat 转换**：`wireApi: "chat"` 的通道非流式拿完整 Chat 响应，再由路由自生成规范 Responses SSE（保证 `response.completed` 一定发出，避免“stream closed before completion”）
- **无感更新**：`server.close()` 立即释放监听端口但保留已有连接；`closeIdleConnections()` 关空闲连接让 close 完成，在跑任务自然结束
- **并发安全**：`uncaughtException`/`unhandledRejection` 进程级兕底只记日志不退出；token 刷新 single-flight 防竞态
- **原子写入**：`auth.json`、`models.json` 修改均先写 tmp 再 rename，避免桌面端并发读到半写文件
- **Token 自动刷新**：access_token 距过期不足 30 秒时自动 refresh 并原子写回 auth.json

## License

MIT
