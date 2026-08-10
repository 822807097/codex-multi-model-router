# 路由配置预检设计

日期：2026-08-10
状态：已批准（2026-08-10）

## 1. 范围

本规格只覆盖持续优化路线图的阶段一：把配置解析、静态预检、环境覆盖和 target 正则编译移入独立模块。主请求循环、SSE 解析、检查点持久化和管理 UI 不在本轮实现范围。

参考 sub2api 的集中配置校验思路，但使用 Node.js 内置模块重新设计，不复制其 LGPL 源码，不引入 Viper、Gin 或其他依赖。

## 2. 目标

1. 在绑定端口前一次性报告全部可确定的配置错误。
2. 将警告与错误分开；未使用供应商缺少 Key 只警告。
3. 统一解析当前环境覆盖、默认值和有效运行参数。
4. target 正则只编译一次，并保持原配置顺序。
5. 诊断稳定、中文、带字段 path 且不包含秘密值。
6. 保持所有合法配置的现有行为和未知扩展字段。

## 3. 非目标

- 不读取 auth.json、models.json 或任何检查点文件。
- 不探测代理、DNS、供应商端点或 API Key 是否有效。
- 不热加载配置。
- 不修改 provider 选择、failover、状态域和协议转换行为。
- 不增加 Web 认证、浏览器限制或公网安全校验。
- 不重命名配置字段，不引入 schema 框架或配置类层级。

## 4. 模块接口

新增 'lib/router-config.mjs'：

~~~js
export class RouterConfigError extends Error {
  issues;
}

export function inspectRouterConfig(rawConfig, context = {}) {
  // -> { errors, warnings }
}

export function prepareRouterConfig(rawConfig, context = {}) {
  // -> { config, runtime, targets, warnings }
}

export function formatConfigIssues(issues) {
  // -> string[]
}
~~~

'context' 固定为：

~~~js
{
  configPath,
  baseDir,
  env,
  defaultCodexHome,
}
~~~

- 'configPath' 是入口已经确定的配置文件绝对路径。
- 'baseDir' 是配置文件所在目录，用于解析相对路径。
- 'env' 是入口显式传入的普通键值对象；模块不得自行读取 'process.env'。
- 'defaultCodexHome' 由入口根据当前平台和用户目录计算。

测试可以只传需要的字段。实现不得把完整 'env'、环境变量值或 rawConfig 序列化到错误消息。

## 5. 输出结构

### 5.1 ConfigIssue

每条问题为：

~~~js
{
  severity: 'error' | 'warning',
  code: '稳定机器码',
  path: 'JSON Pointer 风格路径',
  message: '中文说明',
}
~~~

path 使用 '/targets/0/match'、'/proxy/port' 等 JSON Pointer 风格。根配置使用空字符串。数组索引按原始配置位置生成，不能因过滤非法 target 而改变。

同一路径可以有多个不同 code。返回顺序固定为配置遍历顺序，再按跨字段检查顺序；同一输入必须产生完全相同的顺序。

### 5.2 prepared config

'config' 是保留未知字段和 '_comment' 的结构化克隆。模块只为内部准备结果读取字段，不删除或重排用户字段。

'runtime' 至少包含：

~~~js
{
  port,
  configPath,
  codexHome,
  authPath,
  catalogPath,
  proxy: { host, port },
  heartbeatMs,
  maxRequestBytes,
  requestBudget: { maxActive, maxBytes },
  oauth: { clientId, refreshSkewSeconds },
  visionRelay,
}
~~~

'targets' 为原顺序的浅克隆，每项把 'match' 替换为已编译 RegExp，并保留原始 match 文本在 'matchSource'。其他 provider 私有字段原样保留。

## 6. 值语义和兼容规则

### 6.1 缺失与显式非法

- 字段不存在或为 'undefined' 时沿用当前默认值。
- 'null' 不做全局归一化；每个现有字段先用行为刻画测试确认当前是“未配置”、显式关闭还是非法，再保持对应语义。
- 显式提供空字符串、零、负数、NaN 形态字符串或错误类型时，不再静默回退默认值；只要路由会消费该字段，就返回稳定错误。
- 未被路由消费的未知字段不验证、不删除。

环境变量优先级保持当前顺序：

1. 对应环境变量。
2. config.json 字段。
3. 现有内置默认值。

环境变量存在但值非法时必须报环境覆盖对应的错误，不能退回 config.json。

### 6.2 路径

- 'ROUTER_CONFIG_PATH' 由入口解析，因此本模块只接收已确定的配置路径。
- 'CODEX_AUTH_PATH'、'CODEX_CATALOG_PATH' 优先于配置字段。
- auth/catalog 相对路径按配置文件目录解析并给出 warning；仍允许使用。
- 不检查 auth/catalog 文件当前是否存在，避免未使用官方通道阻止启动。

### 6.3 target 顺序

所有合法 target 保持原顺序。非法 target 不再跳过；只要存在 target error，'prepareRouterConfig' 整体失败，因此不会产生部分运行配置。

## 7. 错误目录

首版至少覆盖以下稳定 code：

| code | 适用范围 |
| --- | --- |
| 'config_root_invalid' | 根配置不是普通对象 |
| 'targets_required' | targets 缺失、不是数组或为空 |
| 'target_name_invalid' | name 缺失、空或类型错误 |
| 'target_match_invalid' | match 缺失、类型错误或正则无法编译 |
| 'target_host_invalid' | host 缺失、空、类型错误或含 CR/LF |
| 'target_port_invalid' | target port 不是 1..65535 整数 |
| 'target_protocol_invalid' | protocol 不是 http/https |
| 'target_wire_api_invalid' | provider 解析后不是 chat/responses |
| 'target_path_invalid' | 非空 prefix/chatPath 等路径不以 / 开头，或路径含 CR/LF；空 prefix 合法 |
| 'target_auth_conflict' | provider adapter 会解释为替代凭据的字段与官方登录态冲突；普通自定义 header 不因此报错 |
| 'target_env_key_invalid' | 非官方 target 缺 envKey 或名称非法 |
| 'target_headers_invalid' | headers 不是普通对象，或 header 名值非法 |
| 'target_forward_headers_invalid' | forwardHeaders 不是字符串数组或包含非法名称 |
| 'port_invalid' | 路由监听端口非法 |
| 'proxy_invalid' | 代理 host/port 非法 |
| 'timeout_invalid' | 超时字段不是有限正数 |
| 'heartbeat_invalid' | 心跳不是有限正数 |
| 'request_limit_invalid' | 请求体、缓冲或并发上限非法 |
| 'request_budget_conflict' | 全局缓冲小于单请求上限 |
| 'response_history_invalid' | 历史容量、字节或 TTL 非法 |
| 'response_history_conflict' | 单条上限大于全局上限 |
| 'checkpoint_invalid' | 检查点容量、TTL、token 或比例非法 |
| 'checkpoint_conflict' | response 索引等跨字段上限矛盾 |
| 'vision_relay_invalid' | 视觉中继必填字段、并发或容量非法 |
| 'model_capability_invalid' | 模型能力正则或预算非法 |
| 'model_context_invalid' | 目录上下文或压缩配置非法 |
| 'oauth_invalid' | OAuth boolean、超时、client id 或 skew 非法 |
| 'path_invalid' | paths.auth/catalog 类型非法 |

JSON 文件本身无法解析时，入口创建同结构的 'config_json_invalid' 错误并使用同一格式化函数；因为没有结构化对象，此错误不参与聚合。

## 8. 警告目录

首版至少覆盖：

| code | 说明 |
| --- | --- |
| 'env_missing' | 当前环境未设置 target/视觉中继需要的变量，只显示变量名 |
| 'target_name_duplicate' | target name 重复 |
| 'target_duplicate' | 目标身份字段和 match 完全相同 |
| 'target_wire_api_mixed' | 相同 match 文本或已知模型样本命中不同 wire API |
| 'proxy_ignored_for_http' | HTTP target 配置 viaProxy:true，但当前传输不会使用 CONNECT |
| 'state_domain_suspicious' | 显式状态域跨不同端点或认证方式复用 |
| 'relative_path' | auth/catalog 使用相对路径 |
| 'forward_header_ignored' | forwardHeaders 包含路由不会透传的 hop-by-hop 字段 |

任意正则相交不可判定，本阶段不尝试构建正则分析器。

## 9. 条件验证

- 只有存在 'vision:false' target 时，才按现有默认值补齐并验证视觉中继的 host、prefix、model 和 envKey；本阶段不新增视觉中继禁用语义。
- 官方 ChatGPT target 不要求 envKey；其他 target 必须有 envKey，除非 provider adapter 明确定义另一种现有认证方式。
- provider 私有的 max token 字段、额外 headers 和模型映射只验证路由实际读取的公共形状。
- 'modelContext.enabled:false' 时不验证其业务数值，但仍拒绝会破坏结构遍历的错误容器类型。
- 'goalCheckpoint.enabled:false' 时保留配置并只验证容器类型；启用时执行完整范围和跨字段校验。

## 10. 启动集成

入口流程调整为：

~~~text
确定配置路径
→ 限量读取 UTF-8 文本
→ JSON.parse
→ prepareRouterConfig
→ 输出 warnings
→ 构造运行依赖
→ applyModelContext
→ createServer
→ listen
~~~

任何 error 都在 'http.createServer' 和 'listen' 之前输出，设置非零退出码。诊断按行写入 stderr，不输出原始配置片段。

本轮只替换 'codex-router.mjs' 现有 90–134 行附近的配置准备逻辑，服务和请求 handler 暂不迁移。

## 11. 测试

新增 'test/router-config.test.mjs'，使用表驱动和最小配置工厂：

1. 每个稳定 error code 至少有一个失败测试。
2. 多个独立错误必须一次返回，path 和顺序稳定。
3. 随仓 config.json 在显式模拟的环境变量集合下零 errors。
4. 缺 Key 只产生 warning；warning 不包含模拟 secret 值。
5. 'prepareRouterConfig' 的 target 顺序、RegExp 行为和当前候选匹配一致。
6. 环境覆盖优先级与当前实现一致；非法覆盖不能回退。
7. 未知顶层、target 和 provider 字段、数组顺序、'_comment' 全部保留。
8. CR/LF host、path 和 header 被拒绝，诊断不回显恶意值。
9. 完全重复 target、相同 match 混用 wire API、HTTP 代理和相对路径产生稳定 warning。
10. 错误对象、格式化文本和 JSON 序列化结果不得出现 API Key、Token 或敏感 header 值。

集成测试使用临时目录和临时配置：

- 非法配置子进程在绑定端口前退出，stderr 包含全部稳定 code。
- 合法配置使用临时端口启动，'/healthz' 正常，再通过 '/_admin/shutdown' 优雅关闭。
- 不启动、停止或重启当前运行版本，不访问 'A:\\CodexData\\router'。

## 12. 文档

同步更新：

- 'README.md'：新增启动预检说明、错误/警告区别和非法配置失败时机变化。
- 'config.json'：保持中文注释，必要时补充范围约束，不改示例合法行为。
- 入口顶部注释：说明配置由 'lib/router-config.mjs' 统一准备。

## 13. 完成标准

阶段一完成需要同时满足：

1. 'lib/router-config.mjs' 和测试实现全部通过。
2. 随仓 config.json 预检零错误。
3. 当前所有 165 项及新增测试全量通过。
4. 所有 '.mjs' 与绝对路径入口语法检查通过。
5. JSON、脚本静态解析、零外部依赖和 'git diff --check' 通过。
6. README 与配置中文注释同步。
7. 未部署、未提交、未推送、未触碰运行版本。

阶段一通过后只代表配置预检完成，不代表持续优化目标完成。
