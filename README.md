<div align="center">

# Codex Multi-Model Router

**本地多模型路由代理 · Local-First Multi-Model Router & Gateway**

![License](https://img.shields.io/badge/license-MIT-green) ![Node](https://img.shields.io/badge/Node.js-18%2B-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

**简体中文** | [English](./README.en.md)

</div>

**English** — A local-first multi-model router & gateway: use official ChatGPT quota, DeepSeek / Qwen / GLM / Kimi / Grok, and your Claude / Gemini / ChatGPT / Cursor subscription accounts in one model menu, for the OpenAI Codex desktop app, Claude Code, or any OpenAI-compatible client. Runs 100% on your own machine; no cloud account required.

一个运行在你自己电脑上的**本地多模型路由代理**：让 OpenAI Codex 桌面端（以及任意 OpenAI 兼容客户端）在一个菜单里同时使用**官方 ChatGPT 额度、DeepSeek / Qwen / GLM / Kimi / Grok 等国内外模型、Claude / Gemini / ChatGPT 订阅账号额度、以及 Cursor 订阅额度**，并且可以随时切换。

> **小白一句话**：装好 Node.js → 启动 → 打开网页管理面板 → 点几下把模型和密钥加进去 → 客户端填一个地址就能用。

**关键词 Keywords**：Codex 多模型路由 · Claude Code Router · Gemini CLI · 订阅额度池 · OpenAI 兼容代理 · 本地网关 · 模型切换器 · API 网关 · 免切换 · Codex Router · Subscription Quota Pool · OpenAI-Compatible Proxy · Local Gateway · Model Switcher

---

**目录**

- [一、它是什么 / 能做什么](#一它是什么--能做什么)
- [二、准备工作（3 分钟）](#二准备工作3-分钟)
- [三、启动与打开管理面板](#三启动与打开管理面板)
- [四、小白入门：加第一个模型](#四小白入门加第一个模型)
- [五、让客户端连上来（Codex / Trae / Qoder / OpenCode）](#五让客户端连上来codex--trae--qoder--opencode)
- [六、常用功能一览](#六常用功能一览)
- [七、常见问题（遇到问题先看这里）](#七常见问题遇到问题先看这里)
- [八、安全说明](#八安全说明)
- [九、目录与开发](#九目录与开发)
- [十、反馈与交流](#十反馈与交流)

## 一、它是什么 / 能做什么

你的 Codex 桌面端「同一时间只能配置一个模型供应商」。本项目在中间加一个「路由器」：

```
Codex 桌面端/任意客户端 ──▶ 127.0.0.1:15730（本项目）
   ├─ 官方通道（gpt-*/codex-*）──────▶ chatgpt.com（复用桌面端登录态）
   ├─ DeepSeek / Qwen / GLM / Kimi ──▶ 各厂商 OpenAI 兼容 API（GLM 支持 Coding Plan 订阅额度：同一把 key 走 /api/coding/paas/v4 即计费订阅套餐，务必给订阅通道配密钥，否则会兜底到按量通道被「余额不足」429）
   ├─ Claude / Gemini / ChatGPT 订阅 ─▶ 用你的会员账号额度（多账号自动轮换）
   ├─ Cursor Pro 订阅 ────────────────▶ 通过内置网关多账号额度池
   └─ …… 任意 OpenAI 兼容接口
```

你只需要把客户端的 `base_url` 指向 `http://127.0.0.1:15730/v1`，路由器按请求里的 `model` 字段转发到对应的上游。

**核心能力：**

| 能力 | 说明 |
| --- | --- |
| 多模型同菜单共存 | 官方 GPT 与任意第三方程在同一个选择器里，随时切换，不用改配置 |
| 网页管理面板 | 浏览器打开即可增删改模型、测速、一键接入厂商、管理密钥池与订阅账号 |
| 图文双通道 | 支持 `/v1/responses`（Codex）、`/v1/chat/completions`（通用），原生流式 |
| **谷歌订阅通道** | Google AI Pro 会员一键接入：gemini / claude 全系 25+ 模型经路由直用订阅额度；账号池故障转移、思考档位变体、工具 Schema 自动净化 |
| **Codex 账号一键切换** | 管理页一键把 Codex 桌面端切换到任意已绑定的 ChatGPT 账号（自动备份原登录、自动重启，双向互切） |
| **订阅额度实时面板** | ChatGPT 账号显示 5 小时 / 周额度进度条与重置时间（与 Codex CLI 官方额度条同源数据） |
| 视觉中继「借眼看图」 | 纯文本模型收到图片时，自动让视觉模型描写后再交给文本模型；支持多端点、额度耗尽自动切换 |
| ChatGPT 订阅生图 | `/v1/images/generations` 与 `/v1/images/edits` 翻译成官方 Responses + image_generation 通道，用 ChatGPT 订阅账号额度出图（`api.openai.com` 上游，平台 key 兜底） |
| 多账号订阅额度池 | Claude / Gemini / ChatGPT / Cursor 会员账号可以绑多个，额度耗尽自动换下一个；每个账号可设「额度消耗顺序」 |
| 通道密钥池 | 同一个厂商可以挂多把 API Key，优先级轮换 + 额度冷却持久化 |
| 自由分组管理 | 模型卡片可自由编辑 / 删除 / 自建分组（分组只是本页展示，不写桌面端目录） |
| 代理逐通道配置 | 每通道可直连 / 走全局代理 / 走自定义节点（支持粘贴 ss / trojan / vless / socks5 / http 链接） |
| **任意模型续接任务（不用新开窗口）** | 官方额度用完 / 想换模型时，直接在任务中途切换，同一会话从断点继续跑：官方订阅切自定义模型、GLM 切 DeepSeek 都行，协议转换（工具调用 / 推理格式 / 会话元数据）由路由自动完成 |
| 跨模型接续 | 上下文裁剪时自动生成「目标检查点」，切换模型后任务目标不断线 |
| 用量看板 | 网页里看按天 Token 趋势、活跃热力图、各模型消耗 |
| API 密钥鉴权（可选） | 为自己的客户端签发 `sk-router-*` 密钥，可管控谁能访问 |

界面预览：

**管理面板（Web UI，浏览器打开 `http://127.0.0.1:15730/admin`）**

| 使用统计 | 分组自定义模型 |
| --- | --- |
| ![使用统计](docs/admin-usage.png) | ![分组自定义模型](docs/admin-model-groups.png) |
| ![平台订阅管理](docs/admin-subscriptions.png) | ![API 密钥管理](docs/admin-api-keys.png) |
| ![系统与路由配置](docs/admin-system.png) | ![路由通道列表](docs/admin-channels.png) |

**Codex 桌面端联动**

![官方与自定义模型同菜单共存](docs/demo-model-switching.png)
![同一任务跨模型继续回答](docs/demo-cross-model-continuation.png)

**官方额度用完，自定义模型无缝续接（不用新开窗口）**

ChatGPT 官方订阅额度耗尽时，任务不需要重来：在同一个会话的模型选择器里切到自定义模型（如 `zhipu/GLM-5.3-Flash`），点「从断点处继续」即可——路由会自动迁移该会话的连接元数据、转换协议格式，带着全部上下文和工具继续执行。反过来自定义模型切回官方、或任意两家自定义模型互切，同样适用。

> 前提：已在管理面板「Codex 桌面端接入」以 API-key 形态接入路由（官方额度耗尽时桌面端会锁模型，API-key 形态不受影响）。

## 二、准备工作（3 分钟）

1. 安装 **Node.js 18 或更高版本**（[nodejs.org](https://nodejs.org)，一路下一步即可）。
2. 准备你**自己的**模型服务商 API Key（例如 DeepSeek 开放平台、阿里云百炼、硅基流动、OpenRouter 等）。本项目**自身不含任何内置密钥**。
3. 下载并解压本项目源码到任意目录，例如 `D:\codex-multi-model-router`。

不需要安装任何 npm 依赖（纯 Node.js 实现，`npm start` 直接跑）。

## 三、启动与打开管理面板

### Windows

```powershell
cd D:\codex-multi-model-router
.\scripts\start-router.ps1
```

### macOS / Linux

```bash
cd ~/codex-multi-model-router
./scripts/start-router.sh
```

看到日志里出现 `codex-router listening on 127.0.0.1:15730` 说明启动成功。

浏览器打开管理面板：

```
http://127.0.0.1:15730/admin
```

> 管理面板只监听本机（127.0.0.1），并且在同源 + 防跨站策略保护下工作，不会暴露到局域网。

## 四、小白入门：加第一个模型

在管理面板里加模型的路径非常多，最省事的是「一键接入厂商」：

1. 进入 **「分组自定义模型」** 页面。
2. 点右上角 **「一键接入厂商」**，会看到内置的常用厂商列表（DeepSeek、通义、GLM、OpenRouter 等），按地区分类。
3. 选一个厂商，把你在该平台申请的 API Key 填进去（可以填多把，额度耗尽自动换），点 **「一键接入」**。
4. 路由会自动：创建好通道 → 把密钥放进通道密钥池 → 把默认模型写进目录。

之后在客户端模型菜单里就能看到这些模型了。

如果你想完全手动添加一个「任意 OpenAI 兼容模型」：

- 在 **「系统与路由配置」→ 已启用的路由目标通道** 点「添加通道」：填通道名称、匹配正则（例如 `^deepseek-`）、服务器地址（例如 `api.deepseek.com`）、路径前缀（通常 `/v1`）、密钥环境变量名。
- 在 **「分组自定义模型」** 页点「添加自定义模型」，把模型 Slug 和它要走的通道对上。

> **密钥怎么填：** 本项目坚持「密钥不进配置文件」。请把密钥放进**环境变量**（Windows 命令行执行 `setx 变量名 你的密钥`，例如 `setx DEEPSEEK_API_KEY sk-xxx`），然后在通道里只填**变量名**。管理面板里的「通道密钥池」也可以直接填明文 Key，它存在路由自己的本地数据库里，不会写进 `config.json`。

## 五、让客户端连上来（Codex / Trae / Qoder / OpenCode）

### 通用方式（任意 OpenAI 兼容客户端）

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:15730/v1` |
| API Key | 管理面板「API 密钥管理」里创建的 `sk-router-...`（不创建时走开放直连） |
| Chat 接口 | `POST /v1/chat/completions`（通用） |
| Codex 接口 | `POST /v1/responses`（Codex 专用） |
| 模型列表 | `GET /v1/models` |

### Codex 桌面端

整个项目的主要使用场景——让桌面端能选到所有模型、且能正常打开。模型目录由管理面板「分组自定义模型」页动态管理，写进桌面端读取的 `models.json`：

- 确保桌面端读取的目录文件就是路由器写的这一个（本机默认是 `$CODEX_HOME\models.json`）。
- 桌面端的连接配好 `base_url = http://127.0.0.1:15730/v1` 即可，模型自动出现在右下角选择器。
- 跨 Chat / Responses 切换时，路由器会用全量历史 + 目标检查点续接，不会丢失任务上下文。

> 桌面端对 `models.json` 有严格的字段完整性要求。本项目在写入新模型时会**自动补全所有桌面端必填字段**（含 `supported_in_api`、`priority`、`base_instructions` 等），保证目录永远可被桌面端解析，不会因为漏字段导致应用打不开。

### Trae / Qoder / OpenCode 等

它们大都支持「OpenAI 兼容」配置，把 Base URL 填成上面的地址即可。也可以到「API 密钥管理」页看你创建的 Key 对应的接入指引，里面有现成配置模板。

## 六、常用功能一览

详细说明见 [docs/ADVANCED.md](docs/ADVANCED.md)，这里先给你「这东西能干嘛」的地图：

- **平台会员订阅授权**（管理面板）
  - Claude / Gemini / ChatGPT 会员账号：一键 OAuth 授权或手动填 Token，多账号自动轮换，Token 自动续期。
  - **谷歌 AI Pro**：订阅页 Google 账号卡「一键接入路由通道」→ 自动拉取订阅模型清单（gemini / claude 全系）并写入路由；支持思考档位（`-high` / `-medium` / `-low` 自动合成变体）。智能体发来的工具定义若带 Gemini 不支持的字段（`$schema` / `propertyNames` 等）会自动净化，不会再 400。
  - **额度面板**：每个 ChatGPT 账号实时显示 5 小时 / 周额度进度条（数据与 Codex CLI 内置额度条同源，随响应头自动捕获），点「刷新」即更新；谷歌账号显示本地 7 天请求计数。
  - **账号消耗顺序**：每个账号卡有「额度消耗顺序」数字框，数字越小越先消耗该账号额度（留空 = 自动按套餐档位 Pro 优先）。
  - **Codex 账号一键切换**：ChatGPT 账号卡「切换 Codex 到此账号」→ 自动退出当前登录（备份）→ 写入该账号凭据 → 自动重启桌面端；双向互切，切换后约 10 秒可用。
  - Cursor Pro 订阅：内置网关把订阅额度转成 OpenAI 兼容接口，面板里直接加/删 `crsr_` Key 进账号池。
- **通道密钥池**：同通道多把 Key，优先级轮换 + 429 冷却持久化，池全冷却再回退环境变量。
- **分组自定义模型**：模型卡片可自由编辑 / 删除；输入新分组名即自建分组（存浏览器本地，不写桌面端目录）；「一键接入厂商」可拉取真实模型清单勾选添加。
- **优雅重启**：面板顶栏「优雅重启服务」在不停当前任务的情况下换新代码。
- **用量统计**：按天 Token 趋势、活跃热力图、模型消耗 Breakdown。
- **Codex 插件全适配**：自动把 Codex 的工具声明（shell、文件编辑、MCP、联网搜索等）转换成各上游通用工具格式。

## 七、常见问题（遇到问题先看这里）

**Q：客户端提示连不上 15730？**
先确认路由进程在跑（日志有 `listening`），再确认填的是 `http://127.0.0.1:15730/v1` 而不是 `https` 或外网 IP。管理面板能打开但客户端连不上，多半是端口/地址填错。

**Q：某个模型一直报「额度不足 / 429」？**
该通道密钥可能真的用完了，或订阅账号额度耗尽。到「通道密钥池」看冷却状态，或到「平台订阅」页检查账号状态；额度会自动续，不用改配置。ChatGPT 账号的 5 小时 / 周额度看账号卡上的进度条即可。

**Q：谷歌模型报 429「分钟级配额限制」？**
谷歌按「账号 × 模型」分钟窗口限流（智能体每轮带全量上下文，消耗快）。路由会自动换账号重试；若全部账号都在窗口内，等约 1 分钟自动恢复——错误信息里会写明。持续数小时不行的是日/周配额用尽，只能等重置或换其他模型（如 `claude-sonnet-4-6` / `gemini-2.5-flash` 系）。另外智能体客户端常发 `max_tokens=128000`，路由已自动钳制到安全值，不会因此预检 429。若单个任务上下文积累过大（数百条消息、请求体 1MB+），该请求可能一次就装满分钟配额桶——表现为同一请求每轮必 429、等待重置也无效；路由识别到这种形态会快速失败并给出指引，此时请切换其他模型或精简上下文/新开会话。

**Q：订阅页 ChatGPT 账号显示「暂无额度数据」？**
额度随官方通道响应头返回，没有独立查询接口。让该账号产生一次请求（用官方模型对话一轮）后点「刷新」即可显示。

**Q：模型报「Unknown model / 找不到模型」？**
客户端请求的模型名不在目录里。到「分组自定义模型」页确认该模型存在，且它的通道匹配正则能命中。

**Q：加了新模型 / 改了配置，好像没生效？**
改的是磁盘配置，已加载进内存的路由需要重启。用面板顶栏「优雅重启服务」，或在命令行执行 `.\scripts\restart-router.ps1` / `bash scripts/restart-router.sh`。

**Q：官方周/分钟额度耗尽后，桌面端只显示 Luna、路由的自定义模型选不到了？**
这是 ChatGPT 桌面端官方策略：官方账号额度耗尽时会锁定模型选择器（降级档）。在「一键接入路由」弹窗勾选 **「API-key 接入（官方额度耗尽也能用自定义模型）」** 重新接入：路由自动生成一把桌面端专用 Key 写入配置，桌面端识别为 LocalRouter、不再关联官方额度——额度耗尽可能照常选用 deepseek / gemini / claude 等自定义模型继续任务。不勾选则复用官方登录态（默认，额度充裕场景更省心）。

**Q：桌面端打不开、报 config_load 错误？**
先看桌面端日志分辨原因：`unknown variant` / `missing field` 属于 `models.json` 字段问题，`usage limit` 属于额度问题。本项目写模型时会自动补全完整字段，正常情况下不会再出现前者；若偶发，到「分组自定义模型」页随便保存一次该模型即可触发补全修复。

**Q：代理连不上 / 需要全局代理？**
见 [docs/ADVANCED.md「网络与代理」](docs/ADVANCED.md)。逐通道可配代理，自定义代理支持直接粘贴机场节点链接（ss / trojan / vless / socks5 / http）。

## 八、安全说明

- **凭据只从环境变量或本地密钥服务读取**：源码、文档、示例配置和测试里都不含任何可用密钥字面量。
- API Key 以哈希形式存储（`sk-router-` 前缀 + SHA-256），吊销即时生效；通道密钥池里的明文 Key 只存本地 SQLite，不写入 `config.json`。
- 管理面板仅绑定本机回环地址，并做 Host/Origin/跨站（CSP、同源）校验。
- `data/`（运行时数据库：账号、密钥、登录态）已加入 `.gitignore`，提交/开源时不会带出。

## 九、目录与开发

```
codex-router.mjs          # 程序入口：组装各模块并启动 15730 监听
config.json               # 示例配置（不含密钥）；真实密钥走环境变量
models.json               # （由管理面板写入的模型目录，不入库）
lib/                      # 核心模块（路由、管理 API、鉴权、密钥池、订阅、视觉中继……）
web-admin/                # 管理面板前端源码（Vue 3 + Element Plus）
web/                      # 前端构建产物（面板运行时使用）
scripts/                  # 启动 / 停止 / 重启 / 恢复官方直连等脚本
```

开发：

```bash
cd web-admin && npm run build   # 重新构建管理面板前端
```

已内置同一模型多通道 provider 亲和、请求预算与超时、响应历史、跨模型目标检查点、通道级/账号级额度冷却、令牌追踪与用量统计等机制；会在写入模型目录时自动保证桌面端必填字段完整，避免配置被写坏。

## 十、反馈与交流

用得好请点个 Star；遇到问题欢迎反馈：

- **微信**：`b6356120`（添加请备注「路由器」，会拉交流群）
- **GitHub Issues**：[提交 Issue](https://github.com/822807097/codex-multi-model-router/issues)

提问题时尽量附上：用的哪个模型、报错原文、管理面板对应页面的截图，定位更快。

---

<div align="center">

**MIT License** · 本项目仅做本地网关聚合，与 OpenAI / Anthropic / Google / Cursor 等公司无任何关联；请遵守各平台的服务条款，风险自担。

This project is a local gateway aggregator only and is not affiliated with OpenAI / Anthropic / Google / Cursor. Please comply with each platform's terms of service — use at your own risk.

</div>
