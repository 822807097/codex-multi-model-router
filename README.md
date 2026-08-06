# codex-multi-model-router

Codex 桌面端本地多模型路由代理，让官方 GPT、DeepSeek、Qwen 等模型在同一选择器里共存，并为文本模型提供视觉中继能力。

## 特性

- **多模型共存**：官方 GPT 系列、DeepSeek、Qwen 等模型同时出现在 Codex 桌面端选择器中，会话内可热切换
- **视觉中继**：为不支持图片的文本模型（如 DeepSeek）提供"借眼"能力——收到图片时先调用视觉模型生成描述，注入上下文后转发
- **零依赖**：纯 Node.js 实现，无需任何 npm 包，Node >= 18 即可运行
- **密钥安全**：API Key 全部通过环境变量注入，配置文件无明文
- **官方登录态复用**：自动读取 Codex 桌面端 auth.json，临期自动 refresh，无需二次登录
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

### 3. 配置文件

编辑 `~/.codex/config.toml`：

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
[OK]  官方腿 -> 200 流式正常
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
      "envKey": "DEEPSEEK_API_KEY"
    },
    {
      "match": "^qwen",
      "name": "bailian",
      "host": "token-plan.cn-beijing.maas.aliyuncs.com",
      "prefix": "/compatible-mode/v1",
      "viaProxy": false,
      "vision": true,
      "envKey": "BAILIAN_API_KEY"
    }
  ],
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
- `proxy`：本地代理地址（官方腿 CONNECT 隧道用）
- `paths`：auth.json / models.json 路径（null = 使用 CODEX_HOME 默认位置）
- `oauth`：ChatGPT OAuth client_id 和 token 刷新提前量（秒）

**targets[]** — 路由规则，按请求体 `model` 字段匹配，命中第一条即用之
- `match`：正则字符串，匹配模型 ID
- `host`：上游域名
- `prefix`：上游路径前缀（请求路径 `/v1/responses` 会去掉 `/v1` 后拼到 `prefix` 后）
- `viaProxy`：`true` = 经本地代理 CONNECT 隧道（国内连 chatgpt.com 需要）
- `vision`：`false` = 该腿是文本模型，收到图片时走视觉中继；`true` = 原样透传
- `envKey`：该腿 API key 所在的环境变量名（官方腿不用，走 auth.json）

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

## 常见问题

### 桌面端选择器不显示自定义模型

检查 `config.toml` 的 `[model_providers.router]` 是否包含 `requires_openai_auth = true`。这是桌面端门控钥匙，缺少则前端隐藏自定义模型。

### 发图时报 "This model does not support image inputs"

检查 `models.json` 里该模型的 `input_modalities` 是否包含 `"image"`。前端按此字段决定是否允许贴图。

### 视觉中继描述不准确

视觉中继依赖视觉模型的图片理解能力。对截图类图片（报错截图、UI 图）效果最好，因为提示词让它重点提取文字/代码/界面元素。

### 官方腿 429

OpenAI 官方额度用尽，链路正常，等额度重置或升级套餐。

### 改完环境变量 key 后不生效

路由进程启动时才读取环境变量，必须执行 `restart-router.ps1` 后再跑 `test-router.ps1` 验证。

## 技术细节

- **TLS 隧道**：官方腿经本地代理 HTTP CONNECT 隧道出海，裸写 HTTP/1.1 请求（Node `http.request` 的 `createConnection` 实测不生效）
- **Chunked 解码**：上游 chunked 响应透传时必须先解包，否则 Node `ServerResponse` 会再套一层 chunked 封装，客户端解析直接坏掉（SSE 尤甚）
- **原子写入**：`auth.json`、`models.json` 修改均先写 tmp 再 rename，避免桌面端并发读到半写文件
- **Token 自动刷新**：access_token 距过期不足 30 秒时自动 refresh 并原子写回 auth.json

## License

MIT
