# codex-multi-model-router

一个运行在你自己电脑上的**本地多模型路由代理**：让 Codex 桌面端能同时使用**官方 GPT 与任意国内外模型**（DeepSeek、Qwen、GLM、Kimi、硅基流动、OpenRouter……），互相之间可以随时切换，并且不用装任何 npm 依赖（纯 Node.js 实现）。

> **它不是某个模型的专属工具**：只要供应商提供 OpenAI 兼容 API，都能接入。本文档中的模型名（DeepSeek / Qwen 等）只是**默认配置里的示例**，你可以任意替换成自己用的模型。
>
> **写给第一次使用的人**：本文档从「下载项目」到「桌面端出现模型」的每一步都写了操作方法和预期结果。遇到问题请先看文末的「常见问题」，大部分坑都列在里面。

---

## 目录

- [一、它解决了什么问题](#一它解决了什么问题)
- [二、准备工作（5 分钟）](#二准备工作5-分钟)
- [三、新手完整配置教程（7 步）](#三新手完整配置教程7-步)
- [四、日常使用与运维](#四日常使用与运维)
- [五、config.json 完整配置参考](#五configjson-完整配置参考)
- [六、接入任意 OpenAI 兼容模型](#六接入任意-openai-兼容模型)
- [七、网络与代理（逐通道可选）](#七网络与代理逐通道可选)
- [八、常见问题（新手问答）](#八常见问题新手问答)
- [九、技术细节](#九技术细节)

---

## 一、它解决了什么问题

Codex 桌面端**同一时间只能配置一个模型供应商**，官方 GPT 和第三方模型无法在同一个选择器里共存。本项目在中间加了一个"路由器"：

```
Codex 桌面端 ──▶ 127.0.0.1:15730 (router，本项目)
   ├─ 官方通道（gpt-*/codex-* 等）──▶ chatgpt.com（复用桌面端 ChatGPT 登录态，可经代理）
   ├─ 供应商 A（默认示例：deepseek-v4-flash）──▶ 你的任意 OpenAI 兼容 API
   ├─ 供应商 B（默认示例：qwen*）──▶ 你的任意 OpenAI 兼容 API
   └─ ……按需继续新增
```

你只需要把 Codex 桌面端的 `base_url` 指向这个路由器，路由器根据请求里的 `model` 字段把请求转发给对应的上游。

**主要能力**：
- 官方 GPT 与任意国内外模型在同一个模型菜单里共存，会话内随时切换
- 长任务自动生成「目标检查点」，切换模型不丢任务进度（九栏目摘要：目标、约束、已完成、进行中……）
- 文本模型收图时自动「借眼」：先让视觉模型看图写描述，再发给文本模型
- 官方登录态自动复用 + 自动续期，第三方 key 全部走环境变量，不写进配置文件

---

## 二、准备工作（5 分钟）

### 1. 确认 Node.js 已安装（版本 ≥ 18）

打开终端（Windows 按 `Win + R` 输入 `powershell` 回车），输入：

```powershell
node -v
```

- 看到 `v18.x` 或更高的版本号（如 `v22.14.0`）→ 继续
- 提示 `'node' 不是内部或外部命令` → 去 <https://nodejs.org> 下载 LTS 版安装，装完**重新打开终端**再试

### 2. 下载本项目

把项目下载/解压到一个固定目录，例如：

- Windows：`D:\codex-multi-model-router`
- 或直接用 git 克隆：`git clone https://github.com/822807097/codex-multi-model-router.git`

> 建议目录路径**不要包含中文和空格**，避免部分脚本出问题。

### 3. 了解几个关键文件

| 文件 | 作用 | 要不要改 |
|------|------|---------|
| `codex-router.mjs` | 路由主程序 | 不用改 |
| `lib/` | 路由的模块代码 | 不用改 |
| `config.json` | 路由自己的配置（端口、各模型通道、key 变量名） | **要改**（按需） |
| `models.template.json` | 模型目录模板（桌面端选择器显示哪些模型） | 复制一份改名后**要改** |
| `scripts/` | 启动/停止/重启/测试脚本（.ps1 给 Windows，.sh 给 Linux/macOS） | 不用改 |

> **本项目零 npm 依赖**：不需要执行 `npm install`。`package.json` 只是方便用 npm 命令的人，直接 `node codex-router.mjs` 就能运行。

### 4. 搞定 API Key（按需准备，变量名可自定义）

> 下面的变量名是**默认配置使用的约定**。接新模型时可以任意命名（例如 `GLM_API_KEY`、`KIMI_API_KEY`），只要 `config.json` 对应通道的 `envKey` 填同一个名字即可（见第 2 步）。

| 模型 | 去哪里申请 | 默认环境变量名 |
|------|-----------|---------------|
| 官方 GPT / Codex | **不需要 key**（复用桌面端 ChatGPT 登录态，见下文第 6 步） | - |
| DeepSeek（默认示例模型） | <https://platform.deepseek.com> 创建 API Key | `DEEPSEEK_API_KEY` |
| Qwen（默认示例模型，兼作视觉中继） | 阿里云百炼/Token Plan 创建 API Key | `aliyun_video_key` |
| 其他任意模型（GLM/Kimi 等） | 各供应商控制台 | 任意自定义，如 `ZHIPU_API_KEY` |

**Windows 设置环境变量（推荐 GUI 方式）**：
1. 按 `Win + S` 搜索「编辑系统环境变量」并打开
2. 点「环境变量」→ 在「用户变量」区点「新建」
3. 变量名填 `DEEPSEEK_API_KEY`，变量值填你的 key，确定
4. 同样的方法再建 `aliyun_video_key`
5. **关掉所有已打开的终端窗口再重开**（环境变量只对之后启动的程序生效）

或者用命令行（PowerShell，效果相同）：

```powershell
setx DEEPSEEK_API_KEY "sk-你的key"
setx aliyun_video_key "sk-你的key"
```

> 环境变量设置成**用户级**即可。路由的启动脚本会自动从用户/系统环境读取这些 key 注入到路由进程，所以**改完 key 后记得重启路由**（见「四、日常运维」）。

---

## 三、新手完整配置教程（7 步）

> 全程约 10 分钟。核心思路：**告诉路由「有哪些模型、key 在哪」→ 告诉 Codex「去找路由」→ 启动路由 → 重启桌面端**。

### 第 1 步：创建模型目录 models.json

桌面端的选择器里显示哪些模型，由 `models.json` 决定。

把项目里的 `models.template.json` **复制**一份到 Codex 数据目录，并改名为 `models.json`：

- 默认位置：`C:\Users\你的用户名\.codex\models.json`（Linux/macOS 为 `~/.codex/models.json`）
- 如果你设置了 `CODEX_HOME` 环境变量，则放在 `$CODEX_HOME\models.json`

```powershell
# Windows PowerShell 示例（把「你的用户名」替换成实际的）
Copy-Item D:\codex-multi-model-router\models.template.json "$env:USERPROFILE\.codex\models.json"
```

模板里默认包含 `deepseek-v4-flash` 和 `qwen3.8-max` 两个**示例模型**，可以直接用；想换模型/加模型：删除或修改对应条目，再按第六节为你的模型加一条通道配置即可。每个模型条目里 `slug` 是桌面端显示和路由匹配用的模型 ID（必须与 `config.json` 中 `targets[].match` 对应）。

### 第 2 步：告诉路由模型通道和 key 的环境变量名

打开 `config.json`，确认 `targets` 数组里的通道与你准备用的模型和 key 对应（以下是**默认配置示例**，`envKey` 就是第二步设置的环境变量名，`match` 是模型 ID 匹配规则，均可按你的模型修改）：

```json
{
  "match": "^deepseek-v4-flash$",
  "name": "deepseek-responses",
  "envKey": "DEEPSEEK_API_KEY",
  "wireApi": "responses"
},
{
  "match": "^qwen",
  "name": "bailian",
  "envKey": "aliyun_video_key",
  "wireApi": "chat"
}
```

- `match`：模型 ID 的匹配规则（正则），命中哪个通道就转发到哪个供应商
- `envKey`：**这个通道的 key 存在哪个环境变量里**

> 默认配置已经正确，**不需要改**。当你换 key 变量名、加新模型或换供应商时才动这里（示例见第六节）。

### 第 3 步：修改 Codex 桌面端配置 config.toml

找到 Codex 的配置文件（和 models.json 同一个目录）：

- Windows：`C:\Users\你的用户名\.codex\config.toml`
- Linux/macOS：`~/.codex/config.toml`

**没有这个文件就新建一个**。用记事本打开，把内容改成（有旧内容建议先备份）：

```toml
model = "gpt-5.6-terra"   # 示例：默认模型，可改成任意已配置模型的 slug
model_provider = "router"
model_catalog_json = "C:/Users/你的用户名/.codex/models.json"

[model_providers.router]
name = "LocalRouter"
base_url = "http://127.0.0.1:15730/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

| 配置项 | 含义 | 注意事项 |
|--------|------|---------|
| `model = "gpt-5.6-terra"` | 默认使用的模型（示例值） | 可以填任意已在 models.json 里的 slug，如 `deepseek-v4-flash`、`qwen3.8-max` 或你自定义的模型 |
| `model_provider = "router"` | 默认供应商指向路由 | 与下面的 `[model_providers.router]` 名字一致 |
| `model_catalog_json` | 模型目录路径 | 必须是**绝对路径**，正斜杠 `/` 或双反斜杠 `\\` |
| `base_url = "http://127.0.0.1:15730/v1"` | 路由的地址 | 端口必须和 `config.json` 里的 `port` 一致（默认 15730） |
| `wire_api = "responses"` | 桌面端用 Responses 协议和路由通信 | 固定写 `"responses"` |
| `requires_openai_auth = true` | **门控钥匙** | 没有这一行，桌面端选择器里**不显示**自定义模型 |
| `supports_websockets = false` | 不用 WebSocket | 固定写 `false` |

### 第 4 步：启动路由

**Windows（PowerShell）**，在项目目录下执行：

```powershell
cd D:\codex-multi-model-router\scripts
.\start-router.ps1
```

第一次运行如果报错：

```
无法加载文件 ...因为在此系统上禁止运行脚本
```

说明 PowerShell 执行策略限制了脚本，执行下面这条命令（只需一次）再重新启动：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

看到类似下面的输出就是启动成功（`targets` 列出的是**当前 config.json 里配置的通道**，会随你的配置变化）：

```
[2026-08-09T10:00:00.000Z] codex-router listening on 127.0.0.1:15730
  config: D:\codex-multi-model-router\config.json
  targets: openai, deepseek-responses, deepseek-chat, bailian   # 默认配置示例
```

> `start-router.ps1` 是**前台运行**（窗口关掉路由就停了）。想要后台无窗口运行，改用：
> ```powershell
> wscript start-router-silent.vbs
> ```

**Linux/macOS（bash）**：

```bash
cd codex-multi-model-router/scripts
chmod +x *.sh
./start-router.sh
# 后台运行：
# nohup ./start-router.sh > /tmp/codex-router.log 2>&1 &
```

### 第 5 步：验证路由工作正常

**方法一：浏览器访问**，打开 <http://127.0.0.1:15730/healthz>，应看到（`targets` 随你的配置变化）：

```json
{"ok":true,"targets":["openai","deepseek-responses","deepseek-chat","bailian"]}
```

**方法二：跑一键测试脚本**（要求路由已启动、两个 key 都已设置）：

```powershell
cd D:\codex-multi-model-router\scripts
.\test-router.ps1
```

预期输出（耗时数值不重要，重要的是 `[OK]`；模型名是**默认配置示例**，你配置了哪些模型就测哪些）：

```
[路由] 运行中 targets: openai, deepseek-responses, deepseek-chat, bailian
[env] DEEPSEEK_API_KEY 已设置
[env] aliyun_video_key 已设置
[OK]  deepseek-v4-flash -> 回复: OK (1124ms)
[OK]  qwen3.8-max -> 回复: OK (1776ms)
[OK]  视觉中继 deepseek+图片 -> 回复: red
[OK]  官方通道 -> 200 流式正常
总结: 全部通过
```

- 出现 `[env] ... 未设置` → 回「二、4」检查环境变量，设好之后**新开终端**再试
- 出现 `[FAIL]` 或超时 → 看文末「常见问题」

> 单元测试（不需要路由运行，也不消耗 API 额度）：
> ```powershell
> cd D:\codex-multi-model-router
> npm test
> ```

### 第 6 步：确认 ChatGPT 登录态（官方模型用）

官方 GPT / Codex 模型**不需要 API Key**，它复用 Codex 桌面端自己的 ChatGPT 登录态：

1. 打开 Codex 桌面端，确认已经登录 ChatGPT（设置里能看到账号）
2. 登录后会自动生成 `auth.json` 在你的 Codex 数据目录（`C:\Users\你的用户名\.codex\auth.json`），路由会自动读取它，临期还会自动续期

> 注意：`auth.json` 是**你的登录凭据**，不要把它复制进项目目录，也不要提交到任何 Git 仓库。本项目 `.gitignore` 已排除它。

### 第 7 步：重启 Codex 桌面端

**完全退出 Codex**（任务管理器里确认 `ChatGPT.exe` 全部关闭）再重新打开。

现在模型菜单里应该能看到你在 models.json 里配置的全部模型（默认配置示例：官方 GPT 系列 + `DeepSeek-V4-Flash` + `Qwen3.8-Max`）。随便选一个发消息试试：

- 选官方模型 → 走你的 ChatGPT 账号
- 选你配置的任意第三方模型（如 `DeepSeek-V4-Flash`、`Qwen3.8-Max`）→ 走对应供应商 API
- 任务进行到一半切换到另一个模型 → 继续对话，路由会自动保持任务连续性

> 如果菜单里没有自定义模型 → 检查 `config.toml` 里的 `requires_openai_auth = true` 是否还在，并确认 `model_catalog_json` 路径正确。

---

## 四、日常使用与运维

所有脚本在 `scripts/` 目录，Windows 用 `.ps1`，Linux/macOS 用 `.sh`（自动备份 `config.toml`，带时间戳，永不覆盖）。

| 场景 | 命令（Windows PowerShell） | 说明 |
|------|---------------------------|------|
| 启动路由 | `.\start-router.ps1` | 前台运行，方便看日志 |
| 无窗口启动 | `wscript start-router-silent.vbs` | 适合开机自启 |
| 查看状态 | `.\status-router.ps1` | 显示 PID + 健康检查 |
| 停止路由 | `.\stop-router.ps1` | 停止路由 |
| **改完配置/key 后重启** | `.\restart-router.ps1` | **无感重启**：不打断正在跑的任务，改配置后必须执行 |
| 一键验收 | `.\test-router.ps1` | 测试所有模型通道 |
| 恢复官方配置 | `.\restore-official.ps1` | 移除路由，恢复纯官方 |
| 恢复自定义配置 | `.\restore-custom.ps1` | 恢复自定义模型组合 |

**三个最重要的操作习惯**：

1. **改完 `config.json` 或环境变量 key → 必须 `restart-router.ps1`**，否则不生效（路由只在启动时读取配置）
2. **路由重启不会打断正在跑的 Codex 任务**（旧进程排空在跑任务，新进程接管新请求），可以放心重启
3. **不要手动删 auth.json / models.json**，它们是桌面端和路由共用的

---

## 五、config.json 完整配置参考

`config.json` 与 `codex-router.mjs` 在同一目录，是路由的全部可调参数。默认值已可开箱即用，以下逐字段说明，方便按需修改。

### 顶层字段

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `15730` | 路由监听端口，必须与桌面端 `config.toml` 的 `base_url` 端口一致 |
| `proxy` | `127.0.0.1:10808` | 本地 HTTP CONNECT 代理地址（所有 `viaProxy: true` 的通道共用）。v2rayN 等请填 **HTTP/混合端口**，不是 SOCKS 端口 |
| `paths` | `null` | 手动指定 auth.json / models.json 路径；`null` = 使用 `CODEX_HOME` 下的默认位置 |
| `oauth` | 见右 | ChatGPT 登录态相关：`client_id`（公开常量）、`refresh_skew_seconds`（提前多少秒刷新）、`viaProxy`（null = 刷新请求跟随官方目标网络策略） |
| `timeouts` | 见右 | 分层超时（毫秒）：`connectMs` 建连 15s、`responseHeaderMs` 等响应头 120s、`streamIdleMs` 流空闲 10min、`requestMs` 控制请求 10min |
| `heartbeatMs` | `15000` | Chat 通道 SSE 心跳间隔（毫秒） |
| `providerPool` | 见右 | 供应商粘性缓存：`maxEntries` 2048 条、`ttlMs` 24h |
| `responseHistory` | 见右 | previous_response_id 工具调用历史：`maxEntries` 512 条、`ttlMs` 24h |
| `goalCheckpoint` | 见右 | 持续目标检查点（长任务裁剪时自动摘要），详见下方专节 |
| `supportsResponses` | 见右 | 兼容旧配置名：`slugs` 列出的模型在 `/models` 中声明 `{ "streaming": true }` |
| `modelCapabilities` | 见右 | 按模型正则配置上下文窗口/输出预算，优先级高于 target 与全局默认值 |
| `modelContext` | 见右 | 启动时把上下文窗口写回 models.json，让桌面端据此做滑动窗口/压缩 |
| `visionRelay` | 见右 | 视觉中继（文本模型「借眼」看图），详见下方专节 |

### targets[]（模型通道，核心）

路由按请求的 `model` 字段匹配 `targets`，**同一模型可配置多条目标**用于会话粘性和故障换腿。

| 字段 | 说明 |
|------|------|
| `match` | 正则字符串，匹配模型 ID，如 `"^qwen"` 匹配所有 qwen 开头的模型 |
| `name` | 通道名（日志里显示） |
| `host` | 上游域名，如 `api.deepseek.com` |
| `prefix` | 上游路径前缀，如 `/v1`、`/backend-api/codex` |
| `viaProxy` | `true` = 经顶层 `proxy` 的 CONNECT 隧道；`false` = 直连。每个通道独立选择 |
| `envKey` | 该通道 API key 所在的环境变量名（官方通道不用填，走 auth.json） |
| `wireApi` | `"responses"` = 原样透传上游原生 Responses（上游支持时优先）；`"chat"` = 做 Responses↔Chat 真流式转换（上游只支持 Chat API 时用） |
| `platform` | 供应商适配器：`openai` / `deepseek` / `dashscope` / `siliconflow` / `openrouter` / `minimax` / `generic` |
| `vision` | `false` = 文本模型，收到图片走视觉中继；`true` = 原样透传 |
| `protocol` / `port` | 默认 `https`/443；`http` 仅用于受信任的本机/内网网关（始终直连） |
| `chatPath` | Chat 端点，默认 `/chat/completions` |
| `includeUsage` | 是否发送 `stream_options.include_usage`，默认 `true`；不兼容的旧网关设 `false` |
| `reasoningMode` | 推理字段映射覆盖：`reasoning_effort` / `openrouter` / `enable_thinking` / `reasoning_split` / `none` |
| `authType` / `authHeader` | 默认 `bearer`；兼容 `x-api-key` 或自定义认证头 |
| `upstreamModel` / `modelMap` | 把桌面端模型 slug 映射成上游实际接受的模型名 |
| `timeouts` | 单目标覆盖顶层超时 |

**故障换腿规则（安全设计）**：只有连接失败、HTTP 408、429、5xx 会在**尚未输出模型事件时**换到下一候选目标；客户端取消、400、401、403、上下文超限**不会**重试。

**官方通道（`platform: "openai"`）自动适配**：请求未显式声明 `store` 时自动注入 `store: false`，并移除 `max_output_tokens`（chatgpt.com 会以 400 拒绝这两类请求）。只在你没声明时生效，不覆盖你的明确意图。

### goalCheckpoint（持续目标检查点）

长任务超出上下文预算、需要裁剪旧轮次时，路由自动让当前模型生成一份「九栏目执行摘要」注入对话，保证切换模型后目标、进度、关键决定不丢失。

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 总开关 |
| `maxEntries` / `ttlMs` | `128` / `86400000` | 内存检查点数量上限与存活时间（毫秒） |
| `maxResponseIdsPerTask` | `128` | 单任务最多保留的最近响应别名 |
| `sourceTokenBudget` | `128000` | 单次摘要来源的 token 硬上限 |
| `sourceWindowRatio` | `0.2` | 摘要来源最多占模型窗口的比例 |
| `maxOutputTokens` | `2048` | 摘要最大输出 token |
| `requestMs` | `120000` | 摘要调用超时（毫秒） |

摘要响应体另有 256 KiB 硬上限。检查点只缓存摘要文本和关联元数据，**不缓存完整对话**；跨模型接力需要强任务键（conversation/session metadata 或 `x-codex-session-id` 请求头），不同聊天不会互相串用检查点。

### visionRelay（视觉中继）

| 字段 | 说明 |
|------|------|
| `host` / `prefix` / `model` | 视觉模型地址和模型名（默认阿里云 qwen3.8-max） |
| `envKey` | 视觉模型 key 的环境变量名（默认 `aliyun_video_key`） |
| `viaProxy` | 视觉 API 是否走顶层代理，默认 `false` |
| `prompt` / `maxTokens` | 视觉提示词与最大输出 |

### 环境变量优先级

环境变量优先级高于 `config.json`：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CODEX_HOME` | Codex 数据目录（auth.json / models.json / config.toml 所在） | `~/.codex` |
| `CODEX_AUTH_PATH` | 覆盖 auth.json 路径 | `$CODEX_HOME/auth.json` |
| `CODEX_CATALOG_PATH` | 覆盖 models.json 路径 | `$CODEX_HOME/models.json` |
| `ROUTER_CONFIG_PATH` | 覆盖路由 config.json 路径（多实例/隔离测试用） | 与程序同目录 |
| `ROUTER_PORT` | 监听端口 | `config.json:port` 或 `15730` |
| `ROUTER_HEARTBEAT_MS` | 心跳间隔覆盖 | `config.json:heartbeatMs` 或 `15000` |
| `V2RAY_HOST` / `V2RAY_PORT` | 代理地址覆盖 | `config.json:proxy` 或 `127.0.0.1:10808` |
| `DEEPSEEK_API_KEY` | DeepSeek key（**默认配置约定，可自定义**） | - |
| `aliyun_video_key` | 阿里云 Token Plan key，Qwen + 视觉中继共用（**默认配置约定，可自定义**） | - |

---

## 六、接入任意 OpenAI 兼容模型

**这是本项目最核心的能力**：默认配置里的 DeepSeek / Qwen 只是开箱即用的预置示例，**任何提供 OpenAI 兼容 API 的供应商（GLM、Kimi、硅基流动、OpenRouter……）都能接入**。接入一个全新模型只需三步：

**① 在 `config.json` 的 `targets` 数组加一条通道**（`wireApi: "chat"` 走通用转换）：

```json
{
  "match": "^glm-",
  "name": "glm",
  "platform": "generic",
  "host": "open.bigmodel.cn",
  "prefix": "/api/paas/v4",
  "viaProxy": false,
  "vision": true,
  "envKey": "ZHIPU_API_KEY",
  "wireApi": "chat"
}
```

**② 设置环境变量**：`setx ZHIPU_API_KEY "sk-你的key"`（变量名与 `envKey` 一致）

**③ 在 `models.json` 加模型条目**，slug 与 `match` 对应，并包含 `input_modalities`（想发图必须含 `"image"`）：

```json
{
  "slug": "glm-4.7",
  "display_name": "GLM-4.7",
  "supported_in_api": true,
  "input_modalities": ["text", "image"]
}
```

最后 `restart-router.ps1` 重启路由、重启桌面端即可。

> 其他参考配置：Kimi `api.moonshot.cn`、硅基流动 `api.siliconflow.cn`（platform `siliconflow`）、OpenRouter `openrouter.ai`（platform `openrouter`）。具体 endpoint 以前缀和官方文档为准。
> 文本模型设 `vision: false` 可启用视觉中继「借眼」；原生视觉模型设 `vision: true`。

---

## 七、网络与代理（逐通道可选）

`viaProxy` 是**每条通道独立**的网络开关，官方通道和自定义通道可以分别选择直连或代理：

| 通道 | `viaProxy: false` | `viaProxy: true` |
|------|-------------------|------------------|
| 官方 GPT / Codex | 直连 `chatgpt.com` | 经顶层 `proxy` 的 HTTP CONNECT 隧道 |
| DeepSeek / Qwen / 其他 | 直连各自 API | 经同一个本地代理 |

默认配置按常见国内网络：**官方 GPT 走代理，DeepSeek / Qwen 直连**。如果你的网络环境不同，把对应通道的 `viaProxy` 反过来即可（例如官方模型直连：把 openai 通道的 `viaProxy` 改为 `false`；OAuth 刷新会自动跟随官方通道策略，不需要单独改）。

代理地址在顶层 `proxy` 或环境变量 `V2RAY_HOST` / `V2RAY_PORT`。协议是 HTTP CONNECT，**v2rayN 等客户端请填 HTTP/混合端口**（不是仅 SOCKS 端口）。如果 `viaProxy: true` 但代理没开，请求会明确失败并按安全规则决定是否换腿。

---

## 八、常见问题（新手问答）

### 启动类

**Q1：`start-router.ps1` 报「禁止运行脚本」**
执行一次 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，再重新运行。

**Q2：启动报 `Error: listen EADDRINUSE`（端口被占用）**
路由已经在运行，或端口被其他程序占用。先 `.\status-router.ps1` 看状态；确认是路由就直接 `.\restart-router.ps1`；如果是别的程序占了 15730，改 `config.json` 的 `port`（同时改桌面端 `config.toml` 的 `base_url`）。

**Q3：启动后 `healthz` 打不开 / 提示连接被拒绝**
路由没在运行。看启动窗口的报错；或先跑 `Set-ExecutionPolicy` 那条命令再启动。

### 模型显示类

**Q4：桌面端选择器里没有自定义模型**
`config.toml` 缺 `requires_openai_auth = true`；或 `model_catalog_json` 路径不对；或改完没**完全退出并重开** Codex（任务管理器确认 `ChatGPT.exe` 全关）。

**Q5：选择器里有模型但发消息报错**
先跑 `.\test-router.ps1` 定位是哪个通道失败。常见原因：key 没设置/设置后没重启路由/额度用尽。

### Key 与鉴权类

**Q6：日志或测试报 401 Unauthorized**
key 没设置、设置错、或**改完 key 没重启路由**（路由只在启动时读环境变量）。另外改完环境变量要**新开终端**。

**Q7：`[env] 未设置` 警告**
环境变量没找到。用 GUI 或 `setx` 设置（用户级即可），重开终端，`restart-router.ps1`。

**Q8：官方模型报 401 / 登录态失效**
打开 Codex 桌面端重新登录 ChatGPT，路由会自动读取新 `auth.json`；登录态临期时路由会自动续期。

### 上游错误类

**Q9：429 Too Many Requests**
额度用尽：DeepSeek 去平台充值；阿里云 Token Plan 检查周配额（如提示 `quota will reset at ...`，到期自动恢复）；官方 GPT 等套餐重置。链路本身是正常的。

**Q10：`insufficient_quota`（阿里云）**
Token Plan 周配额耗尽，提示里带重置时间，到期自动恢复，无需改任何配置。

**Q11：官方模型报「Store must be set to false」或「Unsupported parameter: max_output_tokens」**
这是旧版本或绕过路由直连才会出现。当前版本已自动适配（注入 `store: false`、移除 `max_output_tokens`），升级到最新版即可。

### 功能类

**Q12：发图时报「This model does not support image inputs」**
`models.json` 里该模型的 `input_modalities` 缺 `"image"`。前端按此字段决定能否贴图。

**Q13：文本模型收到图后回答很模糊**
视觉中继是「借眼」方案（先让视觉模型写 2-4 句描述），适合理解截图内容（报错、UI、代码）。要做精确的 GUI 自动化操作（browser / computer-use 插件），请切换到原生视觉模型（qwen3.8-max 或官方 GPT）。

**Q14：第三方模型不执行工具、只描述计划**
路由已自动转换 `tools` 定义；若仍不执行，检查桌面端请求是否带了 `tools` 字段（Codex 通常默认带）。

**Q15：子代理并行（collaboration）不可用**
这是 Codex 对**官方模型**开放的运行时特性，第三方模型会被标记 `unsupported call` 并自动降级为单代理并行 shell，属正常行为。

**Q16：切换模型会丢任务进度吗**
不会。未触发裁剪时完整历史照常发送；触发裁剪时路由自动生成目标检查点（目标/约束/进度/决定/工作集/失败/下一步），新模型基于检查点继续。供应商私有状态（response id、cache key 等）不会迁移。

**Q17：更新路由会不会打断正在跑的任务**
不会。`restart-router.ps1` 先让旧进程释放端口并排空在跑任务，新进程立即接管新请求。

### 安全类

**Q18：auth.json 会被误传到 Git 吗**
不会。`.gitignore` 已排除 `auth.json`、`models.json`、日志、备份。请勿手动把它们复制进项目目录。

**Q19：为什么仓库里有 `client_id`，是不是泄露**
`app_EMoamEEZ73f0CkXaXp7hrann` 是 Codex 应用的**公开 OAuth 客户端标识**（类似应用 ID，GitHub 上所有同类项目都公开），不是机密；真正的凭据是本地 `auth.json` 里的令牌，从未进仓库。

---

## 九、技术细节

- **逐通道 TLS 隧道**：任何 HTTPS 目标都可通过 `viaProxy` 选择直连或本地 HTTP CONNECT 代理；裸写 HTTP/1.1 请求避免 `createConnection` 兼容问题
- **Chunked 解码**：上游 chunked 响应先解包再透传，避免 Node 再套一层 chunked 导致客户端解析失败（SSE 尤甚）
- **Responses↔Chat 转换**：上游 `stream: true`；状态机实时转换文本、`reasoning_content`/`<think>` 和并行工具调用，正常断流时补齐 Responses 生命周期
- **分层超时**：建连、响应头、流空闲和控制请求分别计时；客户端断开立即取消上游 socket
- **SSE 保活**：Chat 通道在视觉中继和认证之前立即建立 SSE，每 15 秒发注释心跳
- **目标感知裁剪**：只删完整旧轮次；确实裁剪时才生成九栏目检查点，失败先复用同任务旧检查点，再降级为普通裁剪
- **摘要内存边界**：检查点响应 256 KiB，其他非流式控制响应默认 8 MiB 上限
- **跨模型隔离**：检查点可在强任务键下跨模型接力，精确摘要缓存、response id、cache key、供应商粘性按上游链路隔离
- **无感更新**：`server.close()` 立即释放端口保留连接；`closeIdleConnections()` 关空闲连接；在跑任务自然结束
- **并发安全**：进程级异常兜底只记日志不退出；token 刷新 single-flight 防竞态
- **原子写入**：auth.json、models.json 修改均先写 tmp 再 rename，避免并发读到半写文件
- **Token 自动刷新**：access_token 距过期不足 30 秒自动 refresh 并原子写回 auth.json

## License

MIT
