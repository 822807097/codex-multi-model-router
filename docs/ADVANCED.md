# 进阶使用与配置参考

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
- 多个账号同平台时，额度耗尽自动轮换；支持各自独立代理。
- **Cursor Pro**：见下一节。

## Cursor 订阅额度（内置网关）

把 Cursor 订阅额度转成 OpenAI 兼容接口：

- 启动路由时网关随之启动（监听本机 6718）。
- 面板「系统与路由配置 → Cursor 订阅网关」：添加 `crsr_` Key（Cursor 设置 → API KEY）进入账号池，多账号自动轮换、额度耗尽自动切换。
- 模型以 `cursor/grok-4.6`、`cursor/composer-2.5` 等出现在模型菜单；带推理档位/快速档的变体（如 `cursor-grok-4.6-fast`、`-high`、`-xhigh`）由路由自动映射到网关参数（`[effort=high,fast=true]`）。
- 网关的管理密码通过环境变量 `CURSOR_GATEWAY_ADMIN_PASSWORD` 设置（首次请务必配置，不要留空）。

## 视觉中继「借眼看图」

纯文本模型收到图片时，先把图片发给视觉模型生成文字描述，再连同描述交给文本模型。

- 面板「系统与路由配置 → 视觉中继」管理**多个端点**（不同平台/模型）。
- 每个端点配：视觉模型名（如 `qwen3.8-max`）、API 地址、路径前缀、密钥环境变量名、协议、代理。
- 端点额度耗尽（429/配额错误）自动冷却并切换下一个。
- 图片会做去重缓存（concurrency / cache 可调），同一张图并发请求只触发一次视觉调用。

## 用量看板与令牌追踪

「使用统计」页：最近 7/30 天的 Token 总量、调用次数、活跃天数、最常用模型、GitHub 风格活跃热力图、按天多模型堆叠柱状图、各模型消耗明细（含思考 token、缓存命中）。

## 客户端 API 密钥（可选）

在「API 密钥管理」创建 `sk-router-*` 密钥后，路由进入鉴权模式：客户端必须带 `Authorization: Bearer <Key>` 才能调用。密钥只存哈希，吊销立即生效。创建时还能一键把配置同步进 Codex（写入 `config.toml` + 系统环境变量）。不创建任何密钥 = 开放直连（适合本机独占场景）。

## 开发与调试

- 全量单测：`npm test`（约 600+ 用例，覆盖路由、鉴权、密钥池、订阅、视觉中继、管理 API 等）。
- 调试日志：运行目录下 `router.log`（结构化 JSON）、`router-console.out.log`（进程控制台）。崩溃/启动失败先看 console 日志。
- 优雅重启：面板顶栏；或 `scripts/restart-router.ps1`（Windows）/ `scripts/restart-router.sh`。重启会等旧进程排空在跑任务后再接管新进程。
- 管理 API 只接受本机回环 Host + 精确同源；CSP 允许同源脚本与样式，禁止第三方脚本注入。
