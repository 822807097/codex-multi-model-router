# Router Post-Audit Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before checking off a task. Do not modify `A:\CodexData\router\config.json`, deploy, publish, restart/stop the running router, upgrade dependencies, or commit/push unless the user explicitly authorizes that action.

**Goal:** 在保持现有管理 API 成功路径、模型路由能力和零依赖架构的前提下，修复 2026-08-13 只读审查确认的资源、正则、明文认证、本地管理边界、配置写入和密钥轮换隐患，并让管理页准确表达“配置就绪”与“上游真实可用”的区别。

**Architecture:** 采用兼容优先的分波硬化。纯校验与策略进入现有 `lib/` 模块，入口只负责编排；所有新边界先由失败测试锁定。会导致当前 1 GB/2 GB 活动配置无法启动的硬限制、真实上游探测和任何运行环境变更均留在人工决策闸门之后，不由代理自动执行。

**Tech Stack:** Node.js >= 18、原生 HTTP/Web Components/ES Modules、`node:test`、零第三方依赖。

---

## 审查基线（2026-08-13）

- `npm test`：570/570 通过；`node --check web/app.js` 与 `node --check codex-router.mjs` 通过。
- 工作树干净，`npm ls --all --omit=optional` 为空。
- 运行服务只监听 `127.0.0.1:15730`，当前 6 条通道均使用 HTTPS。
- 运行服务读取 `A:\CodexData\router\config.json`，其中 `maxRequestBytes=1073741824`、`maxBufferedRequestBytes=2147483648`；仓库 `config.json` 默认是 64 MiB/128 MiB。
- 当前 Node `buffer.constants.MAX_STRING_LENGTH=536870888`，小于活动配置允许的单请求正文。
- 管理页刷新后为新版 UI；1920px 无横向溢出，应用自身控制台无错误。浏览器扩展错误不属于项目。
- 伪造 `Host`、跨站 `Origin` 的只读管理请求仍返回 200；跨站 PUT 预检返回 404，因此普通 CSRF 被浏览器阻断，但 DNS rebinding/点击劫持防线不足。
- 灾难性正则 `^(a+)+$` 对 17/21/23/25 字符输入实测约 2/4/17/67 ms，呈指数增长。

## 不可突破的执行边界

- 不修改运行中的 `A:\CodexData\router\config.json`、用户 Codex 配置或凭据文件。
- 不部署、不发布、不重启或停止服务，不访问或输出 API Key、Token、Authorization 原值。
- 不升级依赖、不增加第三方包或 CDN，继续保持原生 Web Components 与 ES Modules。
- 不删除配置预检、模型预检、影响摘要、删除确认、撤销、冲突保护、双基线同步和手动重启提示。
- 不把健康检查变成会消耗模型 token 的自动探测；真实探测必须另行获得用户批准。
- 不自动提交或推送 Git；每个任务完成后只更新本文复选框和验证记录。

## 关键设计决定

1. **资源限制先告警、后硬限制。** 先让 1 GB/2 GB 配置在预检和 UI 中变成高风险警告，避免代码更新后下一次人工重启直接失败。活动配置由用户手动降限并确认后，才实施硬上限。
2. **模型标识先严格校验，再执行正则。** 请求中的 `model` 必须是非空字符串并设置长度上限；配置正则增加长度、嵌套量词和反向引用检查，现有六条规则必须保持合法。
3. **带凭据的明文 HTTP 仅允许回环地址。** `localhost`、`127.0.0.1`、`::1` 可继续用于隔离测试和可信本机上游；远程 HTTP 目标在服务端预检失败。
4. **管理接口保持本机无登录设计，但收紧浏览器边界。** 校验管理路径的 Host；拒绝跨站不安全方法；增加 CSP、`frame-ancestors 'none'`、`X-Content-Type-Options` 等响应头。无 `Origin` 的本机 CLI 调用继续可用。
5. **不新增“假健康探测”。** 第一阶段只把文案改为“进程在线”“配置/凭据存在，未探测上游”。安全、低成本的运行历史指标另立决策点。
6. **单文件配置保存复用已验证的文件原语。** 不继续维护 `admin-api.mjs` 中较弱的平行写入实现；revision、文件身份、临时文件和备份均由 `json-file-store.mjs` 统一保证。

## 实施任务

### Task 0: 固化计划并登记持续目标

**Files:**
- Create: `docs/superpowers/plans/2026-08-13-router-post-audit-hardening.md`

- [x] 写入审查基线、边界、设计决定、任务顺序和验证门槛。
- [x] 创建持续目标，objective 引用本文路径并重复“不修改活动配置/不部署/不重启”。
- [x] 每个后续任务开始前读取本文，以复选框作为唯一进度源。

### Task 1: 资源限制高风险告警（兼容阶段）

**Files:**
- Modify: `lib/router-config.mjs`
- Modify: `web/app.js`
- Test: `test/router-config.test.mjs`
- Test: `test/admin-integration.test.mjs`

- [x] 在 `test/router-config.test.mjs` 增加失败测试：超过 256 MiB 的单请求或超过 512 MiB 的总缓冲生成稳定 `request_limit_high_risk` warning，默认 64 MiB/128 MiB 不告警，现有正整数兼容行为不变。
- [x] 运行 `node --test test/router-config.test.mjs`，保存 RED 证据。
- [x] 在 `inspectRequestLimits()` 中只增加 warning，不把 1 GB/2 GB 变成启动错误；warning 不回显环境值或路径。
- [x] 在总览和“本机服务”摘要中以文字与图标显示高资源风险；不得只用颜色表达。
- [x] 运行 `node --test test/router-config.test.mjs test/admin-integration.test.mjs`，确认通过。

**人工决策闸门 A：** 只有用户明确批准并手动把活动配置降到安全范围后，才另建任务把 256 MiB/512 MiB 变为硬上限。代理不得自行修改活动配置。

### Task 2: 模型标识与路由正则抗阻塞边界

**Files:**
- Modify: `lib/router-config.mjs`
- Modify: `lib/router-handler.mjs`
- Modify: `lib/model-routing-plan.mjs`
- Modify: `web/model-routing-state.mjs`
- Test: `test/router-config.test.mjs`
- Test: `test/router-integration.test.mjs`
- Test: `test/model-routing-plan.test.mjs`
- Test: `test/admin-model-routing-state.test.mjs`

- [x] 写失败测试：`model` 为数组/对象/数字、空字符串或超过 256 字符时，在任何 `RegExp.test()` 前返回稳定 400 `invalid_model`。
- [x] 写失败测试：路由正则超过 1024 字符、包含反向引用或嵌套无界量词时返回 `target_match_unsafe`；当前六条生产规则和专属精确规则继续通过。
- [x] 运行四个定向测试文件，确认 RED 原因分别是缺少请求边界和正则安全检查。
- [x] 抽出共享的纯正则检查函数，Node 与浏览器状态模块保持同一规则；不得在浏览器执行服务端路由正则。
- [x] 在 `router-handler.mjs` 解析 JSON 后立即验证模型标识，再调用 `providerPool.candidates()`。
- [x] 增加指数回溯回归测试，但测试输入必须在 100 ms 内完成，禁止把会卡住测试进程的正则直接跑到长输入。
- [x] 运行定向测试与 `npm test`。

### Task 3: 禁止向远程明文 HTTP 上游发送凭据

**Files:**
- Modify: `lib/router-config.mjs`
- Test: `test/router-config.test.mjs`
- Test: `test/router-integration.test.mjs`

- [x] 写失败测试：`protocol:http` + 远程主机 + `envKey` 或官方登录态产生 `target_insecure_auth_transport`；`127.0.0.1`、`localhost`、`::1` 的隔离上游继续合法。
- [x] 运行定向测试确认 RED。
- [x] 实现不做 DNS 解析的规范化回环主机判断，拒绝用户信息、尾点和可疑变体绕过。
- [x] 保留 HTTPS、HTTP 本机隔离测试和现有代理语义。
- [x] 运行 `node --test test/router-config.test.mjs test/router-integration.test.mjs`。

### Task 4: 本地管理接口浏览器边界与安全响应头

**Files:**
- Create: `lib/admin-request-policy.mjs`
- Modify: `lib/admin-api.mjs`
- Test: `test/admin-request-policy.test.mjs`
- Test: `test/admin-api.test.mjs`
- Test: `test/admin-integration.test.mjs`

- [x] 为允许的 `127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>` 和拒绝任意 Host 写纯函数测试。
- [x] 为同源 Origin、缺失 Origin 的本机 CLI、`Sec-Fetch-Site: cross-site`、跨站 PUT/DELETE 写失败测试；普通 GET 的兼容策略在测试中明确。
- [x] 为 HTML/JS/CSS/JSON 响应写安全头断言：`Content-Security-Policy`、`frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`。
- [x] 实现纯策略模块并在进入管理 API/静态资源前调用；错误响应不得泄露路径、堆栈或请求头内容。
- [x] 运行三个定向测试文件。
- [x] 用隔离测试服务器复现伪造 Host/Origin 被拒绝；不得对 15730 执行写请求。

### Task 5: 高级配置保存复用加固 JSON 写入器

**Files:**
- Modify: `lib/json-file-store.mjs`
- Modify: `lib/admin-api.mjs`
- Test: `test/json-file-store.test.mjs`
- Test: `test/admin-api.test.mjs`

- [x] 为单文件“expected revision + 可验证备份 + fsync + 原子替换”增加失败测试：外部替换、符号链接、revision 变化、备份失败和 rename 失败都保留原文件。
- [x] 运行定向测试确认 RED。
- [x] 在 `json-file-store.mjs` 增加单一职责的 revision 条件提交函数，内部复用 `readRevisionedJson()`、`prepareJsonWrite()` 和 `copyAndVerify()`。
- [x] 删除 `admin-api.mjs` 中重复的 `readLimitedJson()`/`atomicWriteConfig()` 路径，统一映射 revision 冲突与安全错误码。
- [x] 保留现有敏感占位、未知字段、注释、`.bak` 恢复语义和手动重启提示。
- [x] 运行 `node --test test/json-file-store.test.mjs test/admin-api.test.mjs`。

### Task 6: 密钥轮换的并发共享与按目标重试

**Files:**
- Modify: `lib/env-key-source.mjs`
- Modify: `lib/router-handler.mjs`
- Test: `test/env-key-source.test.mjs`
- Test: `test/router-integration.test.mjs`

- [x] 写失败测试：同名 key 并发刷新只查询两个 hive 一次，但所有等待者收到相同结果；不同 envKey 的备用目标各自拥有一次刷新机会。
- [x] 运行定向测试确认 RED。
- [x] 把 `refreshInFlight` 从 `Set` 改为共享 Promise 的 `Map`，完成后精确清理同一 Promise。
- [x] 把请求级 `keyRetried` 布尔值改为按 envKey/target 记录的有界 `Set`，同一目标仍最多重试一次。
- [x] 确认日志只记录环境变量名，不记录值。
- [x] 运行 `node --test test/env-key-source.test.mjs test/router-integration.test.mjs`。

### Task 7: 管理页健康语义纠偏（不增加探测请求）

**Files:**
- Modify: `web/app.js`
- Modify: `docs/admin-ui-redesign.md`
- Test: `test/admin-integration.test.mjs`

- [x] 把“服务状态：运行中”改为“路由进程：在线”，把“全部模型凭据与通道就绪”改为“配置与凭据存在；未探测上游”。
- [x] 对 `envSet`、启动 warnings、待重启分别使用准确文字，避免把配置存在误写成可请求成功。
- [x] `channelEnvReady()` 在运行时状态缺失对应目标时返回未知/待确认，不再默认 `true`。
- [x] 保持现有管理 API 响应结构，不增加自动上游请求。
- [x] 运行 `node --test test/admin-integration.test.mjs`，并在 390/768/1280 宽度检查文案换行与状态层级。

**人工决策闸门 B：** 如需“最近成功率、冷却模型、上游真实连通性”，先单独设计不含敏感信息的有界运行指标；任何主动模型探测都必须获得用户批准。

### Task 8: 多标签页确认令牌互不覆盖

**Files:**
- Modify: `lib/admin-api.mjs`
- Test: `test/admin-api.test.mjs`

- [x] 写失败测试：两个标签分别取得检查点或敏感删除确认后，两个 token 在 TTL 内都可各消费一次；错误 token 不消耗正确 token。
- [x] 将单例 `checkpointConfirmation` 和按 revision 覆盖的删除确认改为有界 token Map，绑定 revision/操作类型/到期时间。
- [x] 限制缓存数量并按最旧项淘汰，延续模型路由确认 token 的实现模式。
- [x] 运行 `node --test test/admin-api.test.mjs`。

### Task 9: 全量验证与审查闭环

**Files:**
- Review: all files changed by Tasks 1-8
- Update: `docs/superpowers/plans/2026-08-13-router-post-audit-hardening.md`

- [x] 运行 `npm test`，记录测试总数、失败数和耗时。
- [x] 运行 `node --check codex-router.mjs`、`node --check web/app.js` 和 `git diff --check`。
- [x] 运行 `npm ls --all --omit=optional`，确认仍为零第三方依赖。
- [x] 在隔离实例验证 Host/Origin、远程 HTTP、正则、资源 warning、revision race 和多标签 token；不向真实供应商发请求。
- [x] 在真实浏览器检查控制台、网络、焦点返回、弹窗滚动、390/768/1280 横向溢出和浅/深色对比。
- [x] 复核预检、保存、编辑、删除、撤销、冲突、双基线同步、敏感字段隔离和手动重启提示。
- [x] 运行代码质量与安全审查；所有高/中风险发现关闭或明确记录为人工决策闸门。
- [x] 确认没有修改活动配置、部署、发布、重启、提交或推送。

## 完成定义

- Tasks 1-9 的复选框有对应命令输出或浏览器证据，不以“应该通过”代替验证。
- 当前六条 HTTPS 通道配置仍可通过预检，现有管理 API 成功响应结构保持兼容。
- 恶意/错误模型标识、危险正则和远程明文认证在到达网络层前被稳定拒绝。
- 高资源配置不再静默显示“无问题”；硬限制仍受人工决策闸门 A 控制。
- 管理页明确区分“进程在线、配置就绪、上游未探测”。
- 570 项既有测试全部保留，新回归测试加入全量套件。
- 未触碰运行配置与凭据，未部署、未重启、未发布、未提交远程仓库。

## 进度日志

- 2026-08-13：完成只读风险审查；确认 3 个高优先级、4 个中优先级和若干低优先级隐患。
- 2026-08-13：创建本计划；下一步为登记持续目标并从 Task 1 的 RED 测试开始。
- 2026-08-13：已登记持续目标；开始 Task 1 资源限制高风险告警的 TDD RED 阶段。
- 2026-08-13：完成 Task 1。后端测试先以 82/83 失败锁定缺失 warning；前端测试先以 1/2 失败锁定缺失展示。最终定向测试 85/85 通过，`node --check web/app.js` 与 `git diff --check` 通过；未修改活动配置，硬限制仍停在人工决策闸门 A。
- 2026-08-13：完成 Task 2。四文件 RED 为 163/167，通过失败原因分别锁定 `invalid_model` 与 `target_match_unsafe`；共享浏览器模块静态映射另以 404 完成 RED。最终四文件 167/167、静态资源 26/26、全量 574/574 通过，相关 `node --check` 与 `git diff --check` 通过；灾难性模式只做约 0.43ms 的源码检查，未对长输入执行正则。
- 2026-08-13：完成 Task 3。定向 RED 为 98/100，证明远程明文凭据通道仍会监听；实现后定向测试 100/100、`node --check lib/router-config.mjs` 与 `git diff --check` 通过。严格允许 `127.0.0.1`、`localhost`（大小写归一）和 `::1`，拒绝用户信息、尾点、括号 IPv6 及数字/缩写 IPv4 变体；未做 DNS 解析或网络探测。
- 2026-08-13：完成 Task 4。纯策略先从模块缺失修正为行为 RED（0/3），真实管理 API/隔离入口也因缺少安全头失败；最终三个定向文件 36/36、全量 580/580、相关 `node --check` 与 `git diff --check` 通过。伪造 Host、跨站 GET/PUT/DELETE 仅对隔离实例测试，未向 15730 写入。`npm audit --omit=optional` 因仓库无 lockfile 返回 `ENOLOCK`；未生成 lockfile或改变零依赖策略。
- 2026-08-13：完成 Task 5。首次 RED 为 31/33（管理保存竞态错误返回 200，条件提交导出缺失）；补充同 revision 文件身份替换后再次以 34/36 RED 锁定稳定冲突码。最终定向测试 69/69、全量 592/592、`node --check` 与 `git diff --check` 通过。高级配置保存现统一复用 revision 条件提交、可验证 `.bak`、fsync 和原子替换；备份失败返回安全 `config_write_failed`，敏感占位、未知字段、重启提示和旧 revision 409 均由测试保留。所有竞态与失败注入仅使用临时目录，未修改活动配置或运行服务。
- 2026-08-13：完成 Task 6。定向 RED 为 21/23：同名 key 的三个等待者得到 `[true,false,false]`，且全局 `keyRetried` 令第二个 envKey 无刷新机会。修复测试夹具的 `messages`/Buffer 契约后，最终定向 23/23、全量 593/593、相关 `node --check` 与 `git diff --check` 通过。刷新 Map 只查询两个 hive 一轮并把同一布尔结果交给所有等待者；路由以请求内 target+envKey Set 限制每个组合最多刷新一次。隔离用例确认日志仅含环境变量名，不含注入的 key 值；未读取真实注册表凭据或访问真实上游。
- 2026-08-13：完成 Task 7。静态断言先锁定新文案和 `channelEnvReady()` 三态，定向测试 2/2、全量 593/593、`node --check web/app.js` 与 `git diff --check` 通过。隔离只读浏览器从当前 `web/` 加载 24 个 mock 模型：1280×900、768×900、390×844 均无横向溢出且控制台 0 error/0 warning；移动菜单可见并正确切换 `aria-expanded`，运行态缺失的通道显示“凭据状态待确认”。验证未读取活动配置、未访问真实上游，结束后已关闭隔离标签和服务器并重置临时 viewport。
- 2026-08-13：完成 Task 8。多标签 RED 为 33/35：同 revision 的第二次配置 GET 覆盖第一个敏感删除确认，第二次检查点 GET 覆盖第一个清空确认；有界/TTL 回归另以 35/37 RED 证明测试能捕获无界与不过期实现。最终定向 37/37、全量 597/597、`node --check lib/admin-api.mjs` 与 `git diff --check` 通过。两类确认均为带操作类型和 60 秒到期时间的有界 token Map（各 64 项），错误 token 不消耗正确 token，成功操作同步消费一次；所有用例仅操作临时目录与隔离内存检查点。
- 2026-08-14：完成 Task 9。安全差异扫描 `73a734a2-8417-4ffd-8b5a-71ea06ddd10b` 未发现高/中风险；唯一低风险的重复前缀正则绕过先以定向 RED 复现，再由共享静态检查拒绝 `^(a|aa)+$` 及简单包装变体，修复后相关定向 154/154。最终安全/并发定向组 230/230、全量 `npm test` 598/598（0 失败，4.55 秒）通过；三个 `node --check`、`git diff --check` 和空依赖树均通过。
- 2026-08-14：真实浏览器连接标准 Node 隔离管理 API，完成配置预检/保存、模型编辑/撤销/预检/影响摘要/保存、删除取消与焦点返回、revision 冲突、放弃草稿和双基线重同步。390×844、768×900、1280×900 均无横向溢出；390px 模型弹窗使用 619px 高可滚动正文承载 1334px 内容，高级选项默认折叠且敏感输入数为 0；移动导航含 4 个入口，控制台 0 error/0 warning。静态资源与三个管理 API 均为 200，伪造 Host 和跨站 Origin 均为 403。
- 2026-08-14：浏览器审查额外发现并以 TDD 修复两项 UI 缺陷：移动端搜索标签错误继承 `flex-basis: 180px`（实测高度从 180px 降为 36px），以及弱化小字对比度不足（修复后浅色最不利背景 ≥4.54:1、深色最不利背景 ≥4.78:1）。隔离标签、两台临时服务器、视口覆盖和临时目录均已清理；用户原 15730 标签保留，活动配置、服务进程、依赖、部署与 Git 远端均未触碰。
