# 进阶使用与配置参考

**简体中文** | [English](./ADVANCED.en.md)

> 面向已经按 [README](../README.md) 跑通的基本用户。本文讲「还能怎么配得更好」。

## 环境变量与端口

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `ROUTER_PORT` | 路由监听端口 | `15730` |
| `CODEX_HOME` | Codex 桌面端配置目录（指向 `config.toml` / `models.json` 所在目录） | 可选，桌面端自行管理 |
| `ROUTER_DB_PATH` | 指定本地 SQLite 数据库路径（测试/多实例隔离用） | `data/router.db` |
| `CURSOR_GATEWAY_PORT` | 内置 Cursor 网关端口 | `6718` |
| `CURSOR_GATEWAY_ADMIN_PASSWORD` | 管理面板与 Cursor 网关之间鉴权用的管理员密码（**必须自行设置**） | 无（未设置时面板的 Cursor 页会提示） |
| `CURSOR_KEY` | 添加 Cursor 账号时的兜底 Key（面板可留空取用） | 无 |

> 各模型供应商的 Key 一律通过环境变量传入，见下节。

## config.json（示例配置，不含密钥）

仓库里的 `config.json` 是结构齐全的**示例**，不包含任何真实密钥。核心结构：

```jsonc
{
  "port": 15730,
  "proxy": { "host": "127.0.0.1", "port": 10808 },   // 全局代理（viaProxy=true 通道共用）
  "timeouts": { "connectMs": 15000, "responseHeaderMs": 120000, "streamIdleMs": 600000, "requestMs": 600000 },
  "maxConcurrentRequests": 8,
  "targets": [
    {
      "name": "deepseek-chat",
      "match": "^deepseek-",          // 哪些模型 slugs 走这个通道
      "host": "api.deepseek.com",
      "prefix": "/v1",
      "protocol": "https",
      "wireApi": "chat",              // chat（通用）或 responses（Codex 官方格式）
      "envKey": "DEEPSEEK_API_KEY",   // 在你的环境变量里查这个变量名
      "viaProxy": false,
      "vision": true
    }
  ],
  "visionRelay": { "endpoints": [ { "model": "...", "host": "...", "prefix": "...", "envKey": "...", "protocol": "https" } ] }
}
```

- 修改配置后**必须重启路由**才生效（面板顶栏「优雅重启服务」即可）。
- 全程不把密钥写进该文件；管理面板直接改写的也是这个文件，但敏感字段会被脱敏占位 + 一次性令牌保护。

## 通道（target）与匹配

- `match` 是正则：`^deepseek-` 匹配所有以此开头的模型；精确匹配单个模型用 `^模型名$`。
- 顺序遍历、**首个命中者优先**。多个通道命中同一模型时，路由记录成功供应商做亲和，避免来回跳。
- `wireApi`：不确定就选 `chat`（DeepSeek、GLM、通义等通用厂商）；`responses` 是 Codex 官方格式。
- `upstreamModel`：可把请求里的模型名重写为上游实际名称（例如把桌面的 `grok-4.6[effort=high,fast=true]` 换成上游接受的参数形式）。

## 网络与代理（逐通道）

每个通道三种方式（管理面板里用下拉选择，小白友好）：

1. **直连**：不代理。
2. **全局代理**：走 `config.json` 顶部 `proxy` 配置（对应本机代理软件，如 v2rayN 的 HTTP/混合端口）。
3. **自定义代理（节点）**：填协议/服务器/端口/密码，或**直接粘贴完整节点链接**自动识别：
   - `ss://`（Shadowsocks 机场节点）
   - `trojan://` / `vless://`（机场节点）
   - `socks5://` / `http://`（本地代理软件）

订阅账号（Claude/Gemini/ChatGPT）也可以各自配置独立代理，不影响其他通道。

## 通道密钥池（同通道多 Key）

适用场景：同一个平台开了多个账号/多把 Key，某一把被 429 冷却时自动换下一把。

- 面板「分组自定义模型 → 密钥池」即可添加。
- 每把 Key 有**优先级**（数字小的先用）+ **冷却状态**（额度耗尽自动冷却，到点恢复）。
- 优先级相同则轮流使用；池内全部冷却才回退到 `envKey` 环境变量。
- 冷却状态持久化到本地数据库，重启不丢。

## 多账号订阅额度池

面板「平台会员订阅授权」：

- **Claude / Gemini / ChatGPT**：按平台「一键授权」（OAuth，浏览器自动打开登录）或手动填 Refresh Token 导入。Token 自动续期并持久化到本地。
- 每个账号显示套餐、配额进度、可用模型；可**拉取上游可用模型**并逐个真机测速。
- **ChatGPT 账号额度面板**：5 小时 / 周窗口实时进度条 + 重置时间，数据随官方通道响应头自动捕获（与 Codex CLI 内置额度条同源）；行名按窗口实际时长标注，无数据的窗口不显示。
- **额度消耗顺序**：账号卡数字框，1 = 最先消耗；留空自动按套餐（Pro 优先）。多账号故障转移按 `优先级 → 套餐 → 轮换` 选号。
- **Codex 账号一键切换**：ChatGPT 账号卡「切换 Codex 到此账号」。执行顺序：完全退出桌面端（轮询确认）→ 备份原 auth.json → 写入该账号凭据 → 自动重启桌面端（约 10 秒）。双向互切；进行中重复点击返回「切换进行中」提示。
- 多个账号同平台时，额度耗尽自动轮换；支持各自独立代理。

## 谷歌订阅通道（Google AI Pro）

用 Google AI Pro 会员额度直接跑 gemini / claude 全系模型：

- **一键接入**：绑定 Google 账号后，订阅页账号卡「一键接入路由通道」→ 拉取订阅模型清单（gemini / claude / gpt-oss 系 25+ 个）→ 每模型建专属通道并写入桌面端目录。重复点击幂等（已存在的跳过）。
- **协议桥接**：`/v1/chat/completions` 与 `/v1/responses` 双协议自动转换到 Antigravity generateContent；流式 / 非流式、工具调用、多模态图片全部支持。
- **思考档位变体**：`-tiered` 后缀的模型是思考档位载体，接入时自动合成 `-high` / `-medium` / `-low` 三个友好名（上游认载体名，档位由 thinkingLevel 参数控制）。
- **工具 Schema 净化**：智能体客户端的工具定义是完整 JSON Schema（含 `$schema` / `propertyNames` / `additionalProperties` 等 Gemini 不支持的字段），路由按允许清单递归净化；`$ref` 从 `$defs` 解析，`type` 数组转 `type + nullable`。
- **输出预算钳制**：`max_tokens` / `max_completion_tokens` 统一钳到 32768——谷歌按「输入 + 输出预留」做分钟配额预检，128k 预留会秒回 429。
- **账号池故障转移**：429（账号×模型 60 秒冷却）/ 403 无许可（30 分钟）/ 401（60 分钟）/ 凭据失效 → 自动换池内下一个账号；Claude 系思考模型自动带 VALIDATED 工具模式与 interleaved-thinking beta 头。
- **额度说明**：谷歌无公开配额接口（按分钟/按模型限额）；面板显示本地 7 天请求计数，触发限流时错误信息带恢复指引。

## Cursor 订阅额度（内置网关）

把 Cursor 订阅额度转成 OpenAI 兼容接口：

- 启动路由时网关随之启动（监听本机 6718）。
- 面板「系统与路由配置 → Cursor 订阅网关」：添加 `crsr_` Key（Cursor 设置 → API KEY）进入账号池，多账号自动轮换、额度耗尽自动切换。
- 模型以 `cursor/grok-4.6`、`cursor/composer-2.5` 等出现在模型菜单；带推理档位/快速档的变体（如 `cursor-grok-4.6-fast`、`-high`、`-xhigh`）由路由自动映射到网关参数（`[effort=high,fast=true]`）。
- 网关的管理密码通过环境变量 `CURSOR_GATEWAY_ADMIN_PASSWORD` 设置（首次请务必配置，不要留空）。

## 视觉中继「借眼看图」

纯文本模型收到图片时，先把图片发给视觉模型生成文字描述，再连同描述交给文本模型。

- 面板「系统与路由配置 → 视觉中继」管理**多个端点**（不同平台/模型）。
- 每个端点配：视觉模型名、API 地址、路径前缀、密钥环境变量名、协议、代理。
- 端点额度耗尽（429/配额错误）自动冷却并切换下一个。
- 图片会做去重缓存（concurrency / cache 可调），同一张图并发请求只触发一次视觉调用。

**示例：英伟达免费视觉模型（NVIDIA NIM / build.nvidia.com）**

```jsonc
{
  "model": "nvidia/nemotron-nano-12b-v2-vl",  // 英伟达自家 VLM，支持文本+图片（一次最多4张文档图）
  "host": "integrate.api.nvidia.com",
  "prefix": "/v1",
  "protocol": "https",
  "envKey": "NVIDIA_API_KEY",                 // nvapi- 密钥，只放环境变量/注册表
  "viaProxy": false                             // 国内网络若直连不通再改 true 走全局代理
}
```

- 免费额度：约 **40 请求/分钟、每日约 1 万次**，共享端点可能被他人流量节流（API Trial ToS）；生产级需付费部署专用 NIM 端点。
- 更强免费档 `meta/llama-3.2-90b-vision-instruct` 同一地址也可绑定，但免费档冷启动可能极慢（实测 150 秒不响应），日常建议用 12B 档。

## 图像生成 API（外部智能体调用，OpenAI 兼容）

路由器对外提供 OpenAI 兼容的图像生成接口，ZCode / Trae / Qoder / OpenCode 等任意工具都能直接调用：

```
POST http://127.0.0.1:15730/v1/images/generations
Authorization: Bearer <sk-router-...>（开启鉴权时）
Content-Type: application/json
```

```jsonc
{ "model": "gpt-image-2", "prompt": "一只红色猫头鹰图标，扁平风格", "n": 1, "size": "1024x1024" }
```

- 上游为 OpenAI 平台 `api.openai.com/v1/images/generations`（模型 `gpt-image-2`，**按张计费**，不是订阅 Plus/Pro 额度）。
- 凭据：**平台 API key 优先**（`OPENAI_IMAGE_API_KEY`，回退 `OPENAI_API_KEY`，只从环境变量读取）；未配置 key 时才尝试 ChatGPT 登录态 token（实测 chatgpt.com 类 token 会被上游 401，故 key 才是图片接口的可靠凭据）。未配置任何凭据时返回 `401 image_provider_unconfigured` 的可读提示。响应为标准 `{ object:"list", created, data:[{b64_json|url}] }`。
- Codex 桌面端的「画图」走的是另一条路：官方模型通过 `image_generation` 工具由 Codex 宿主用订阅额度执行（已默认启用，不消耗本接口的 API 余额）。
- 说明：为什么没有「订阅额度」的公开生图接口——OpenAI 的 Plus/Pro 生图额度只存在于官方应用与 Codex 工具内部，`/v1/images/generations` 只认平台 API key 计费；本接口严格对齐该公开契约。

## 用量看板与令牌追踪

「使用统计」页：最近 7/30 天的 Token 总量、调用次数、活跃天数、最常用模型、GitHub 风格活跃热力图、按天多模型堆叠柱状图、各模型消耗明细（含思考 token、缓存命中）。

## 客户端 API 密钥（可选）

在「API 密钥管理」创建 `sk-router-*` 密钥后，路由进入鉴权模式：客户端必须带 `Authorization: Bearer <Key>` 才能调用。密钥只存哈希，吊销立即生效。创建时还能一键把配置同步进 Codex（写入 `config.toml` + 系统环境变量）。不创建任何密钥 = 开放直连（适合本机独占场景）。

## 开发与调试

- 全量单测：`npm test`（约 600+ 用例，覆盖路由、鉴权、密钥池、订阅、视觉中继、管理 API 等）。
- 调试日志：运行目录下 `router.log`（结构化 JSON）、`router-console.out.log`（进程控制台）。崩溃/启动失败先看 console 日志。
- 优雅重启：面板顶栏；或 `scripts/restart-router.ps1`（Windows）/ `scripts/restart-router.sh`。重启会等旧进程排空在跑任务后再接管新进程。
- 管理 API 只接受本机回环 Host + 精确同源；CSP 允许同源脚本与样式，禁止第三方脚本注入。

## 反馈与交流

遇到问题或想交流用法：

- **微信**：`b6356120`（添加请备注「路由器」，会拉交流群）
- **GitHub Issues**：见仓库 Issues 页

提问题时附上：模型名、报错原文、面板截图，定位更快。
