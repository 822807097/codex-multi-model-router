# codex-multi-model-router

一个运行在你自己电脑上的**本地多模型路由代理**：让 Codex 桌面端能同时使用**官方 GPT 与任意国内外模型**（DeepSeek、Qwen、GLM、Kimi、硅基流动、OpenRouter……），互相之间可以随时切换，并且不用装任何 npm 依赖（纯 Node.js 实现）。

> **它不是某个模型的专属工具**：只要供应商提供 OpenAI 兼容 API，都能接入。本文档中的模型名（DeepSeek / Qwen 等）只是**默认配置里的示例**，你可以任意替换成自己用的模型。
>
> 文档按「准备 → 配置 → 启动 → 验证」顺序编排，每一步都给出操作命令与预期结果；遇到问题先看文末「常见问题」。

---

## 目录

- [一、它解决了什么问题](#一它解决了什么问题)
- [二、准备工作（5 分钟）](#二准备工作5-分钟)
- [三、完整配置教程（7 步）](#三完整配置教程7-步)
- [四、日常使用与运维](#四日常使用与运维)
- [五、config.json 完整配置参考](#五configjson-完整配置参考)
- [六、接入任意 OpenAI 兼容模型](#六接入任意-openai-兼容模型)
- [七、网络与代理（逐通道可选）](#七网络与代理逐通道可选)
- [八、常见问题](#八常见问题)
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
- 官方 GPT 与任意国内外模型在同一个模型菜单里共存，同一任务窗口内随时切换
- Chat 兼容通道在上下文裁剪时自动生成「目标检查点」，帮助新模型延续目标和进度（九栏目摘要：目标、约束、已完成、进行中……）
- 文本模型收图时自动「借眼」：先让视觉模型看图写描述，再发给文本模型
- 官方登录态自动复用 + 自动续期，第三方 key 全部走环境变量，不写进配置文件

### 官方模型与自定义模型共存

![官方模型与自定义模型在同一任务的模型菜单中共存](docs/demo-model-switching.png)

上图是**同一个 Codex 任务窗口**里的模型菜单：官方 `5.6 Sol`、`5.6 Terra`、`5.6 Luna`、`5.5`、`5.2`，以及自定义的 `DeepSeek-V4-Flash`、`DeepSeek-V4-Pro`、`Qwen3.8-Max` 同时出现在一个选择器中。自定义名称来自 `models.json`，路由再按模型 slug 匹配 `config.json` 中的 `targets[].match`，所以还可以继续加入 GLM、Kimi、OpenRouter 等任意 OpenAI 兼容模型。

任务执行过程中可以直接切换模型，**不用新建聊天，也不用改变 Codex 的 `base_url`**；切换只影响下一次模型请求，当前任务的消息、工具结果和工作区保持不变。跨 Chat/Responses 协议切换时，路由会使用客户端全量历史、有界工具调用历史和目标检查点续接；如果客户端只提供了无法恢复的供应商私有增量状态，路由会明确拒绝，而不会让新模型在历史缺失的情况下盲目继续。

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

## 三、完整配置教程（7 步）

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
[
  {
    "match": "^deepseek-v4-flash$",
    "name": "deepseek-responses",
    "platform": "deepseek",
    "host": "api.deepseek.com",
    "prefix": "/v1",
    "viaProxy": false,
    "vision": false,
    "envKey": "DEEPSEEK_API_KEY",
    "wireApi": "responses"
  },
  {
    "match": "^qwen",
    "name": "bailian",
    "platform": "dashscope",
    "host": "token-plan.cn-beijing.maas.aliyuncs.com",
    "prefix": "/compatible-mode/v1",
    "viaProxy": false,
    "vision": true,
    "envKey": "aliyun_video_key",
    "wireApi": "chat"
  }
]
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
- 任务进行到一半切换到另一个模型 → 完整历史照常续接；工具回传可通过有界历史补齐，无法恢复的私有增量状态会返回明确错误

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

### 本地管理页

路由启动后可访问 `http://127.0.0.1:15730/admin`（端口以你的实际配置为准）。管理页继续使用项目现有的 `node:http`，前端为原生 Web Components，不需要安装 npm 包，也不会加载 CDN 资源。

![Codex Router 本地管理页](docs/admin-ui.png)

管理页用于查看运行状态、模型通道、直连/代理方式和检查点统计，也可以通过结构化表单预检并原子保存 `config.json`。它不会显示或编辑 API Key、Token、OAuth 登录态或静态 `Authorization` 请求头；敏感值始终留在本地路由进程和配置文件中。未知扩展字段、数组顺序和 `_comment` 会在表单修改后保留。

“自定义模型”区域可在不手写 JSON 的情况下新增、编辑、改名、删除和撤销模型草稿：

- **新建专属通道**是默认且最省心的方式：会为 slug 自动生成精确匹配规则，模型与通道一起预检、一起保存；删除该模型时可选择同时删除这个专属通道。
- **复用已匹配通道**不会改动已有通道的正则匹配规则，适合已有宽匹配通道已覆盖新 slug 的情况；共享通道删除模型时始终保留，避免误伤其他模型。
- 保存前会显示影响范围；涉及删除或替换时需要确认。保存使用目录和路由配置的双 revision 校验及同一事务写入，外部文件已变化时会拒绝覆盖并提示重新载入。

管理页保存的是下一次启动使用的目录与路由配置。保存成功后手动重启路由，再重启 Codex，新的自定义模型才会出现在桌面端同一个模型选择器中；官方模型与已有自定义模型仍会保留，可在同一任务中切换继续执行。

保存成功只修改配置文件，不会热加载或控制进程。页面会明确提示“需要人工重启”，请在当前长任务结束或合适时机由你自己执行重启。管理页与模型接口一样仅绑定 `127.0.0.1`，设计前提是这台电脑及当前本机账户可信；它不提供公网部署、用户登录、终端、文件浏览或自动启停功能。

---

## 五、config.json 完整配置参考

`config.json` 与 `codex-router.mjs` 在同一目录，是路由的全部可调参数。默认值已可开箱即用，以下逐字段说明，方便按需修改。

### 启动配置预检

路由会在监听端口前一次性检查所有可静态判定的配置问题：

- `error`：端口、正则、wire API、路径、认证形状或资源预算无效，路由不会启动。
- `warning`：某个供应商 Key 尚未设置、目标重复，或配置组合可能无效；其他模型通道仍可继续使用。

旧版本会忽略非法 target 正则，并把部分显式非法数值回退为默认值；当前版本会列出稳定错误码和字段路径后退出。诊断只显示环境变量名称，不显示 Key、Token 或非法原值。相对 `paths.auth`、`paths.catalog` 以及对应环境覆盖会按 `config.json` 所在目录解析，并给出提示，避免工作目录变化后路径漂移。

### 顶层字段

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `15730` | 路由监听端口，必须与桌面端 `config.toml` 的 `base_url` 端口一致 |
| `proxy` | `127.0.0.1:10808` | 本地 HTTP CONNECT 代理地址（所有 `viaProxy: true` 的通道共用）。v2rayN 等请填 **HTTP/混合端口**，不是 SOCKS 端口 |
| `paths` | `null` | 手动指定 auth.json / models.json 路径；`null` = 使用 `CODEX_HOME` 下的默认位置 |
| `oauth` | 见右 | ChatGPT 登录态相关：`client_id`（公开常量）、`refresh_skew_seconds`（提前多少秒刷新）、`viaProxy`（null = 刷新请求跟随官方目标网络策略） |
| `timeouts` | 见右 | 分层超时（毫秒）：`connectMs` 建连 15s、`responseHeaderMs` 等响应头 120s、`streamIdleMs` 流空闲 10min、`requestMs` 控制请求 10min |
| `heartbeatMs` | `15000` | Chat 通道 SSE 心跳间隔（毫秒） |
| `maxRequestBytes` | `67108864` | 单个客户端请求体上限（64 MiB），超限返回 413 |
| `maxConcurrentRequests` | `8` | 同时处理的请求数上限，超限返回 503 和 `Retry-After` |
| `maxBufferedRequestBytes` | `134217728` | 所有正在收取的请求体合计上限（128 MiB） |
| `providerPool` | 见右 | 供应商亲和缓存：`maxEntries` 2048、`ttlMs` 24h；键以带类型域的 SHA-256 保存；`allowDefaultTarget:false` 让未知模型拒绝，`modelAffinity:false` 禁止跨任务模型级全局粘性 |
| `responseHistory` | 见右 | previous_response_id 对应的**工具调用元数据**：`maxEntries` 512、`maxEntryBytes` 1 MiB、`maxBytes` 16 MiB、`ttlMs` 24h；键以 SHA-256 保存，不缓存用户对话或模型正文 |
| `goalCheckpoint` | 见右 | 持续目标检查点（长任务裁剪时自动摘要），详见下方专节 |
| `supportsResponses` | 见右 | 兼容旧配置名：`slugs` 列出的模型在 `/models` 中声明 `{ "streaming": true }` |
| `modelCapabilities` | 见右 | 按模型正则配置上下文窗口/输出预算，优先级高于 target 与全局默认值 |
| `modelContext` | 见右 | 启动时把上下文窗口写回 models.json，让桌面端据此做滑动窗口/压缩 |
| `visionRelay` | 见右 | 视觉中继（文本模型「借眼」看图），详见下方专节 |

### targets[]（模型通道，核心）

路由按请求的 `model` 字段匹配 `targets`，**同一模型可配置多条目标**用于会话粘性和故障切换备用目标。

| 字段 | 说明 |
|------|------|
| `match` | 正则字符串，匹配模型 ID，如 `"^qwen"` 匹配所有 qwen 开头的模型 |
| `name` | 通道名（日志里显示） |
| `host` | 上游域名，如 `api.deepseek.com` |
| `prefix` | 上游路径前缀，如 `/v1`、`/backend-api/codex` |
| `viaProxy` | `true` = 经顶层 `proxy` 的 CONNECT 隧道；`false` = 直连。每个通道独立选择 |
| `envKey` | 该通道 API key 所在的环境变量名（官方通道不用填，走 auth.json） |
| `wireApi` | `"responses"` = 原样透传上游原生 Responses（上游支持时优先）；`"chat"` = 做 Responses↔Chat 真流式转换（上游只支持 Chat API 时用） |
| `useOpenAiAuth` | 只有显式设为 `true` 才允许读取 Codex 的 ChatGPT 登录态；自定义 OpenAI 兼容通道不要设置 |
| `platform` | 供应商适配器：`openai` / `deepseek` / `dashscope` / `siliconflow` / `openrouter` / `minimax` / `generic` |
| `vision` | `false` = 文本模型，收到图片走视觉中继；`true` = 原样透传 |
| `protocol` / `port` | 默认 `https`/443；`http` 仅用于受信任的本机/内网网关（始终直连） |
| `chatPath` | Chat 端点，默认 `/chat/completions` |
| `includeUsage` | 是否发送 `stream_options.include_usage`，默认 `true`；不兼容的旧网关设 `false` |
| `cumulativeToolCallDeltas` | 默认 `false`，按标准真 delta 拼接；只有确认网关每帧重复累计工具名/参数时才设 `true` |
| `maxAccumulatedResponseBytes` / `maxToolCalls` | Chat 转换单响应累计文本/参数字节和工具调用数上限；默认 64 MiB / 128 |
| `stateDomain` | 可选的供应商私有状态域；只有你确认多个**相同 `wireApi`** 的 target 共享同一 response/cache 后端时才给它们配置相同值。Chat 与 Responses 即使同名也强制分域；未配置时按 wire API、端点、认证配置及固定 `target.headers` 的 SHA-256 摘要隔离 |
| `reasoningMode` | 推理字段映射覆盖：`reasoning_effort` / `openrouter` / `enable_thinking` / `reasoning_split` / `none` |
| `authType` / `authHeader` | 默认 `bearer`；兼容 `x-api-key` 或自定义认证头 |
| `forwardHeaders` | 额外转发给该目标的客户端请求头；认证、Cookie、Host、账户/会话标识等敏感头始终禁止转发。请求时动态值不属于静态状态域，不能用它在同一 target 内按任务切换租户 |
| `upstreamModel` / `modelMap` | 把桌面端模型 slug 映射成上游实际接受的模型名 |
| `timeouts` | 单目标覆盖顶层超时 |

**故障切换备用目标规则（安全设计）**：只有以下三类情况会在**尚未输出模型事件**且**存在备用目标**时切换到下一候选目标：

1. **连接类错误码**：`ECONNREFUSED`、`ECONNRESET`、`EHOSTUNREACH`、`ENETUNREACH`、`ENOTFOUND`、`EAI_AGAIN`、`ETIMEDOUT`、`EPIPE`
2. **网络/传输类错误**：错误消息含 `connect` / `socket` / `network` / `dns` / `tls` 关键词，或为超时、上游在响应头前关闭连接、hang up 等（即使没有标准错误码）
3. **HTTP 状态**：408、429、5xx

客户端主动取消、400、401、403、上下文超限**不会**重试；一旦开始输出模型事件，**绝不重放切换**。自动故障切换只在相同 `wireApi` 的候选目标之间进行，避免把一种协议的供应商私有状态误交给另一种协议。

**官方通道（`useOpenAiAuth: true`）自动适配**：请求未显式声明 `store` 时自动注入 `store: false`，并移除 `max_output_tokens`（chatgpt.com 会以 400 拒绝这两类请求）。`name` 或 `platform` 写成 `openai` 不会隐式获得读取登录态的权限，第三方通道也不会收到 Cookie、ChatGPT Account ID 或 Codex session ID。

Chat 转换还会把 Responses 的对象型 `tool_choice`（function / custom / tool_search）改成 Chat `function` 结构，并同步使用工具转换后的安全别名，避免工具表已改名但强制选择仍指向原名。

### 模型切换与状态边界

路由不冒充完整会话数据库，也不会在 `/models` 中声明 `previous_response_id` 能力。切换模型时按以下规则处理：

1. 客户端发送可独立使用的完整历史：可以跨协议或跨供应商状态域切换；路由会移除上一供应商私有的 `previous_response_id` 和 `prompt_cache_key`。
2. 客户端只发送工具输出：若 `previous_response_id` 命中有界工具历史，路由会补回对应的 assistant 工具调用，再转换给 Chat 上游。
3. 客户端只发送普通增量且历史无法恢复：返回 `400 cross_protocol_state_unavailable`，避免静默丢历史。即使两个 target 都是 Responses，只要 host/prefix/认证配置不同也默认视为不同状态域；确实共享后端时可显式设置相同 `stateDomain`。
4. 两个任务或供应商返回相同 response id 时，路由用 conversation/session 强作用域分别恢复；缺少强作用域时返回 `400 ambiguous_response_id`，不会猜测目标或注入其他任务的工具历史。

同一协议内的原生 Responses 状态仍由对应供应商维护；路由只缓存有界工具调用元数据，不缓存完整聊天正文。

> **运行中切换身份必须重启路由**：更换 ChatGPT 账号、替换环境变量中的 API key，或修改组织/项目/租户等身份请求头后，请重启路由以清空内存中的供应商亲和、工具历史和检查点索引，并建议新建 Codex 任务。只有客户端会发送完整、可独立使用的历史时才能继续旧任务；不能再依赖旧身份的 `previous_response_id` 或 `prompt_cache_key`。状态域会区分认证方式、认证头和 `envKey` 等配置，但不会保存或比较动态凭据正文，也不会自动识别登录账号已经切换。

若必须使用不同 Organization/Project/租户，请优先拆成不同 target，并设置不同 `stateDomain`；不要通过 `forwardHeaders` 在同一 target 内按请求动态切换租户，因为这类请求时值不会被持久化为 response 状态快照。

### goalCheckpoint（持续目标检查点）

Chat 兼容通道的长任务超出上下文预算、需要裁剪旧轮次时，路由自动让当前模型生成一份「九栏目执行摘要」注入对话，尽量保留切换模型后所需的目标、进度和关键决定。原生 Responses 通道由上游和 Codex 自己管理上下文，不经过这条 Chat 裁剪链路。

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 总开关 |
| `maxEntries` / `ttlMs` | `128` / `86400000` | 内存检查点数量上限与存活时间（毫秒） |
| `maxResponseIdsPerTask` | `128` | 单任务最多保留的最近响应别名 |
| `maxResponseIndexes` | `16384`；字段省略时为 `maxEntries × maxResponseIdsPerTask` | 全局 response 别名索引上限；使用独立 TTL/LRU，碰撞后保持保守歧义直到索引淘汰 |
| `sourceTokenBudget` | `128000` | 单次摘要来源的 token 硬上限 |
| `sourceWindowRatio` | `0.2` | 摘要来源最多占模型窗口的比例 |
| `maxOutputTokens` | `2048` | 摘要最大输出 token |
| `requestMs` | `120000` | 摘要调用超时（毫秒） |
| `persistence.enabled` | `false` | 冷重启恢复开关；默认只使用内存，不创建任何状态文件 |
| `persistence.path` | `null` | 启用时必须显式填写快照路径；相对路径按 `config.json` 所在目录解析 |
| `persistence.stateGeneration` | `default` | 手工切换状态代际；修改后旧快照保留但不会载入 |
| `persistence.debounceMs` / `maxBytes` | `1000` / `16777216` | 串行延迟写回间隔与快照硬上限 |
| `persistence.lockHeartbeatMs` / `lockStaleMs` | `5000` / `30000` | 重叠进程写锁心跳与陈旧判定；后者至少是前者三倍 |

摘要响应体另有 256 KiB 硬上限。检查点只缓存摘要文本和关联元数据，**不缓存完整对话**；task、精确来源和 response 三类外部键均先加入类型域再保存为固定长度 SHA-256。跨模型接力需要强任务键（conversation/session metadata 或 `x-codex-session-id` 请求头），不同聊天不会互相串用检查点。

启用冷重启持久化后，快照使用版本号、SHA-256 校验、同目录临时文件、同步落盘、原子替换和最后良好备份。文件只含规范化九栏目摘要、哈希索引、过期时间与 response 歧义哨兵，不含原始 task/response/session ID、请求正文、工具结果来源、API Key、OAuth Token 或认证头。namespace 同时绑定 `stateGeneration` 和当前目标身份；账号、Key、静态租户身份或代际变化时，旧文件保持原样，当前实例从空检查点启动。

同一路径同时运行两个版本时，仅持有锁的实例可写；第二实例会以只读模式载入快照，不能覆盖第一实例。优雅退出会先排空在跑请求，再串行刷新检查点并释放自身锁。持久化故障只降级为内存/只读模式，不中断模型请求。

### visionRelay（视觉中继）

`visionRelay` 让**本身只接受文本的模型**也能在 Codex 中处理截图、报错图片、界面和代码图片。它不是让文本模型突然获得原生视觉能力，而是在本机路由中增加一个可配置的“视觉翻译”步骤：

```text
Codex 中的图片
  └─ target.vision = true  ──▶ 原图直接发给原生视觉模型
  └─ target.vision = false ──▶ 视觉中继读取图片并生成文字描述
                                  └─▶ 描述替换图片后发给文本模型
```

![文本模型通过视觉中继理解 Codex 中的截图](docs/demo-vision-relay.png)

上图中当前任务选择的是文本模型，但它仍能解释用户发送的 Codex 截图：真正读取图片的是 `visionRelay.model` 指定的视觉模型，文本模型收到的是整理后的文字描述。原图不会继续发送给文本模型的上游，但会发送给你配置的视觉模型供应商，因此涉及隐私的图片应选择你信任的供应商。

启用时需要同时满足：

1. 文本模型对应的 `targets[]` 设置 `"vision": false`，让路由拦截用户消息和工具结果中的图片。
2. `models.json` 中该模型的 `input_modalities` 包含 `"image"`，否则 Codex 前端会在发送前禁用图片输入。
3. `visionRelay.host`、`prefix`、`model` 和 `envKey` 指向一个真正支持图片的模型，并已设置对应的 Key 环境变量。

原生视觉模型应设置 `"vision": true`，路由会保留原始图片 part，不经过中继。视觉中继更适合识别错误提示、界面元素、代码和普通截图；它生成的是压缩后的文字描述，不适合像素级坐标、精细图像测量或 GUI 自动化，这些任务应切换到原生视觉模型或使用 browser/computer-use 工具。

| 字段 | 说明 |
|------|------|
| `host` / `prefix` / `model` | 视觉模型地址和模型名（默认阿里云 qwen3.8-max） |
| `envKey` | 视觉模型 key 的环境变量名（默认 `aliyun_video_key`） |
| `viaProxy` | 视觉 API 是否走顶层代理，默认 `false` |
| `prompt` / `maxTokens` | 视觉提示词与最大输出 |
| `concurrency` | 整个路由进程共享的视觉描述总并发上限，默认 `3`、有效范围 `1..8`；不是每个客户端请求各自拥有 3 个名额 |
| `maxImagesPerRequest` | 单个请求最多处理的图片数，默认 `8` |
| `cacheMaxEntries` / `cacheMaxBytes` | 图片描述缓存的条目/字节上限，默认 `64` / `1048576`；缓存键为 SHA-256，不保留 data URL |

相同图片在多个请求中并发出现时只发起一次真实视觉调用（single-flight），只有缓存未命中的真实调用占用全局并发名额。等待者共享结果但可各自取消；仍有等待者时，单个客户端断开不会误取消其他任务，最后一个等待者离开才会终止共享上游。

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
| `ROUTER_ENV_KEYS` | 启动/测试脚本需要额外检查的 key 名称，多个名称用逗号分隔；配置中的 `envKey` 会自动读取 | - |
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

代理地址在顶层 `proxy` 或环境变量 `V2RAY_HOST` / `V2RAY_PORT`。协议是 HTTP CONNECT，**v2rayN 等客户端请填 HTTP/混合端口**（不是仅 SOCKS 端口）。如果 `viaProxy: true` 但代理没开，请求会明确失败并按安全规则决定是否切换备用目标。

---

## 八、常见问题

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
通常不会。未触发 Chat 裁剪时完整历史照常发送；触发 Chat 裁剪时路由生成目标检查点（目标/约束/进度/决定/工作集/失败/下一步）。跨协议时可用全量历史或有界工具历史续接；只有供应商私有 response id、cache key 且没有可恢复历史时会明确返回 400，防止新模型在缺历史的情况下继续。

**Q17：更新路由会不会打断正在跑的任务**
不会。`restart-router.ps1` 先让旧进程释放端口并排空在跑任务，新进程立即接管新请求。

---

## 九、技术细节

- **逐通道 TLS 隧道**：任何 HTTPS 目标都可通过 `viaProxy` 选择直连或本地 HTTP CONNECT 代理；裸写 HTTP/1.1 请求避免 `createConnection` 兼容问题
- **Chunked 解码**：上游 chunked 响应先解包再透传，避免 Node 再套一层 chunked 导致客户端解析失败（SSE 尤甚）
- **Responses↔Chat 转换**：上游 `stream: true`；状态机实时转换文本、`reasoning_content`/`<think>` 和并行工具调用，正常断流时补齐 Responses 生命周期
- **原生 Responses 观察**：SSE 原样透传，同时有界观察终态 response，用于记录响应亲和与工具调用；单事件上限 1 MiB
- **分层超时**：建连、响应头、流空闲和控制请求分别计时；客户端断开立即取消上游 socket
- **SSE 保活**：Chat 通道在视觉中继和认证之前立即建立 SSE，每 15 秒发注释心跳
- **目标感知裁剪**：只删完整旧轮次；确实裁剪时才生成九栏目检查点，失败先复用同任务旧检查点，再降级为普通裁剪
- **资源硬边界**：请求体 64 MiB、全局缓冲 128 MiB、默认 8 并发；工具历史单条 1 MiB/全局 16 MiB，视觉调用全进程默认 3 并发；检查点响应 256 KiB，其他非流式控制响应默认 8 MiB
- **跨模型隔离**：检查点可在强任务键下跨模型接力，精确摘要缓存、response id、cache key、供应商粘性按上游链路隔离
- **无感更新**：`server.close()` 立即释放端口保留连接；`closeIdleConnections()` 关空闲连接；在跑任务自然结束
- **并发安全**：token 刷新 single-flight 防竞态；未捕获异常会触发优雅排空后退出，避免带损坏状态继续服务
- **原子写入**：auth.json、models.json 修改均先写 tmp 再 rename，避免并发读到半写文件
- **Token 自动刷新**：access_token 距过期不足 30 秒自动 refresh 并原子写回 auth.json

## License

MIT
