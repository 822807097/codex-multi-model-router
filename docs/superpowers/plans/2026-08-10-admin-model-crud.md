# Admin Custom Model CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在零依赖本地管理页中完成 `models.json` 模型条目与 `config.json targets[]` 的新增、编辑、删除、联合预检和可恢复联合保存。

**Architecture:** 浏览器只提交白名单实体操作，不提交完整敏感 config；纯函数计划层在服务端当前原始文档上应用操作并做绑定分析；通用 JSON 文件原语和 journal 事务层负责双 revision、同步落盘、回滚与启动恢复；运行路由使用启动时 catalog 快照，保存后统一等待人工重启激活。

**Tech Stack:** Node.js 18+ 内置模块、`node:test`、原生 Web Components、`node:http`、无 npm 依赖。

**Repository rule:** 用户明确禁止本任务执行 git commit / push；计划中的每个阶段只做测试检查点，不创建提交。

---

### Task 1: 有界 JSON 文件与 revision 原语

**Files:**
- Create: `lib/json-file-store.mjs`
- Create: `test/json-file-store.test.mjs`

- [x] **Step 1: 写失败测试**

覆盖以下期望 API：

```js
const record = readRevisionedJson(filePath, { maxBytes });
assert.deepEqual(record, { bytes, value, revision });

const prepared = prepareJsonWrite(filePath, value, { fileSystem });
assert.match(prepared.tempPath, /\.tmp-\d+-[a-f0-9-]+$/);
prepared.sync();
prepared.replace();
prepared.cleanup();
```

测试严格 UTF-8、大小上限、普通文件要求、唯一临时名、结尾换行、SHA-256 基于实际写入 bytes，以及 write/open/fsync/rename 任一步失败时只清理本事务临时文件。

- [x] **Step 2: 验证 RED**

Run: `node --test test/json-file-store.test.mjs`

Expected: FAIL，原因是 `lib/json-file-store.mjs` 不存在或导出未定义。

- [x] **Step 3: 最小实现**

导出：

```js
export function sha256Bytes(bytes) {}
export function readRevisionedJson(filePath, options = {}) {}
export function encodeJson(value) {}
export function prepareJsonWrite(filePath, value, options = {}) {}
export function copyAndVerify(source, destination, expectedHash, options = {}) {}
```

所有路径由调用方注入；模块不解析浏览器输入路径。生产注释使用中文。

- [x] **Step 4: 验证 GREEN**

Run: `node --test test/json-file-store.test.mjs`

Expected: 全部通过。

- [x] **Step 5: 检查点**

Run: `node --check lib/json-file-store.mjs && node --check test/json-file-store.test.mjs`

不提交 Git。

### Task 2: 模型目录与路由联合计划纯函数

**Files:**
- Create: `lib/model-routing-plan.mjs`
- Create: `test/model-routing-plan.test.mjs`
- Modify: `lib/model-catalog.mjs`
- Modify: `test/model-catalog.test.mjs`

- [x] **Step 1: 写模型目录校验失败测试**

期望接口：

```js
const result = inspectModelCatalog(catalog);
assert.deepEqual(result.errors, []);
assert.deepEqual(result.warnings, []);
```

覆盖根类型、models 数组、普通对象条目、slug/display_name、slug 唯一性、input_modalities、上下文数值范围和未知字段保留。

- [x] **Step 2: 验证 RED**

Run: `node --test test/model-routing-plan.test.mjs`

Expected: FAIL，缺少 `inspectModelCatalog`。

- [x] **Step 3: 实现目录校验并验证 GREEN**

导出：

```js
export function inspectModelCatalog(catalog) {}
export function escapeModelSlug(slug) {}
```

Run: `node --test test/model-routing-plan.test.mjs`

- [x] **Step 4: 写实体操作失败测试**

期望接口：

```js
const result = applyModelRoutingOperations({
  catalog,
  config,
  configRevision,
  operations,
});
assert.deepEqual(result.catalog.models.map((item) => item.slug), expectedSlugs);
```

覆盖 `model.create/update/delete`、`target.create/update/delete`、`reference.replaceSlug/removeSlug`；操作不可修改输入，保留未知字段和顺序，禁止 target patch 的 `headers`、`auth` 或凭据正文。

- [x] **Step 5: 验证 RED 后实现操作层**

导出：

```js
export function targetReference(configRevision, index, target) {}
export function exposeModelRoutingState(catalog, config, configRevision, env = {}) {}
export function applyModelRoutingOperations(input) {}
```

targetRef 必须绑定 revision、index 和稳定身份摘要；revision 变化后旧引用拒绝。

- [x] **Step 6: 写联合绑定失败测试**

覆盖：

- 每个保留 slug 至少命中一个 target。
- 精确 target 不误命中其他 slug。
- 删除 target 后模型不能变成无路由。
- 专属、共享、宽正则、多 target 删除矩阵。
- slug 改名同步更新精确数组引用，不改任意能力正则。
- 图片模态与 `vision` / `visionRelay` 的错误和警告。

- [x] **Step 7: 实现联合预检并验证 GREEN**

```js
export function inspectModelRoutingPlan(input) {
  return { catalog, config, errors, warnings, impact, operationDigest };
}
```

内部复用 `inspectRouterConfig()`，错误使用稳定 code/path。

- [x] **Step 8: 将目录读取复用 revision 原语**

`readModelCatalogFile()` 继续保持兼容；管理事务使用 `readRevisionedJson()`。保留原测试并增加目录普通文件和严格结构测试。

- [x] **Step 9: 检查点**

Run: `node --test test/model-routing-plan.test.mjs test/model-catalog.test.mjs`

不提交 Git。

### Task 3: 可恢复双文件事务

**Files:**
- Create: `lib/model-routing-transaction.mjs`
- Create: `test/model-routing-transaction.test.mjs`

- [x] **Step 1: 写成功事务失败测试**

期望接口：

```js
const transaction = createModelRoutingTransaction({ configPath, catalogPath, fileSystem });
const result = await transaction.commit({ configRevision, catalogRevision, config, catalog });
assert.equal(result.restartRequired, true);
```

断言双文件新内容、双新 revision、txid、journal committed/清理策略及备份 hash。

- [x] **Step 2: 验证 RED 后实现 prepared → committed 主路径**

导出：

```js
export function transactionJournalPath(configPath) {}
export function createModelRoutingTransaction(options) {}
export function recoverModelRoutingTransaction(options) {}
```

使用进程内 Promise mutex；同一事务的所有 temp/backup 名包含 txid。

- [x] **Step 3: 写双 revision 并发失败测试**

在准备临时文件后模拟外部修改 config 或 catalog；提交必须返回 `revision_conflict`，两份外部文件不被覆盖。

- [x] **Step 4: 实现提交前二次 revision 核对**

冲突时只清理当前 tx 临时文件和未激活 journal，不删除外部文件。

- [x] **Step 5: 写每个 I/O 阶段故障注入测试**

覆盖两个文件各自的 write、open、fsync、backup、rename、最终 hash 校验；第二次替换失败必须恢复第一次，且不能返回成功。

- [x] **Step 6: 实现回滚状态**

稳定错误码：

```text
transaction_rolled_back
transaction_in_doubt
revision_conflict
```

`transaction_in_doubt` 返回 txid，但不把路径或配置正文返回浏览器。

- [x] **Step 7: 写 journal 各 phase 恢复测试**

模拟 prepared、config-replaced、catalog-replaced、committed，以及两旧、两新、单边新组合；有效 temp 优先 roll-forward，否则使用已验证备份 rollback。

- [x] **Step 8: 实现启动恢复并验证 GREEN**

Run: `node --test test/model-routing-transaction.test.mjs`

- [x] **Step 9: 检查点**

Run: `node --check lib/model-routing-transaction.mjs`

不提交 Git。

### Task 4: 管理 API 联合 CRUD

**Files:**
- Modify: `lib/admin-api.mjs`
- Modify: `codex-router.mjs`
- Modify: `test/admin-api.test.mjs`
- Modify: `test/admin-integration.test.mjs`

- [x] **Step 1: 写 GET 失败测试**

`GET /_admin/api/model-routing` 应返回双 revision、模型视图、targetRef、bindings、references 和 envSet；不得返回 configPath/catalogPath、环境值、静态敏感头值或凭据正文。

- [x] **Step 2: 验证 RED 后接入 catalogPath 与 GET**

入口只把预检后的 `CATALOG_PATH` 注入 `createAdminHandler()`；API 不接受客户端路径。

- [x] **Step 3: 写 validate 失败测试**

`POST /_admin/api/model-routing/validate` 应应用实体操作并返回 errors/warnings/impact；破坏性操作返回绑定双 revision 和 operationDigest 的一次性 confirmation。

- [x] **Step 4: 实现 validate**

请求体继续使用 2 MiB 上限和严格 UTF-8；confirmation 使用有界缓存和 60 秒过期。

- [x] **Step 5: 写 PUT 失败测试**

覆盖成功、双侧 revision 冲突、错误 confirmation、重复 token、事务回滚、in-doubt 映射以及操作中夹带 `headers/auth/apiKey` 拒绝。

- [x] **Step 6: 实现 PUT**

先重新计划，再校验 confirmation，最后调用事务层；成功返回双新 revision、txid、`restartRequired:true`、`clientRestartRequired:true`。

- [x] **Step 7: 集成测试**

使用临时 config/models 和随机端口验证新增、编辑、删除完整 HTTP 流程，不调用供应商。

- [x] **Step 8: 检查点**

Run: `node --test test/admin-api.test.mjs test/admin-integration.test.mjs`

不提交 Git。

### Task 5: 启动恢复与活动 catalog 快照

**Files:**
- Modify: `codex-router.mjs`
- Modify: `lib/router-handler.mjs`
- Modify: `test/router-handler.test.mjs`
- Modify: `test/router-integration.test.mjs`

- [x] **Step 1: 写旧进程不热暴露新目录的失败测试**

启动 handler 时注入 catalog 对象；之后改磁盘 models 文件，`GET /models` 仍返回启动快照。

- [x] **Step 2: 验证 RED 后改为 catalog 快照**

`createRouterHandler({ catalog })` 使用结构隔离的启动快照，不在每次 `/models` 重读磁盘。

- [x] **Step 3: 写启动 journal 恢复测试**

入口在解析正式 config 前调用 `recoverModelRoutingTransaction({ configPath })`；测试用隔离 child process 和临时目录验证单边提交可恢复后再监听。

- [x] **Step 4: 实现入口恢复顺序**

恢复只读取 config 同目录固定 journal；journal 自带已验证 catalog 绝对路径。没有 journal 时零额外写入。

- [x] **Step 5: 检查点**

Run: `node --test test/router-handler.test.mjs test/router-integration.test.mjs`

不提交 Git。

### Task 6: 浏览器联合草稿状态

**Files:**
- Create: `web/model-routing-state.mjs`
- Create: `test/admin-model-routing-state.test.mjs`
- Modify: `lib/admin-api.mjs`（静态资源映射）

- [x] **Step 1: 写状态 API 失败测试**

期望：

```js
let state = createModelRoutingState(payload);
state = addModelDraft(state, draft);
state = updateModelDraft(state, slug, patch);
state = removeModelDraft(state, slug, options);
state = undoModelRoutingChange(state);
assert.equal(isModelRoutingDirty(state), false);
```

覆盖新增、编辑、删除、撤销、取消无污染、操作顺序和序列化隔离。

- [x] **Step 2: 验证 RED 后实现最小纯状态模块**

导出：

```js
export function createModelRoutingState(payload) {}
export function addModelDraft(state, draft) {}
export function updateModelDraft(state, slug, patch) {}
export function removeModelDraft(state, slug, options) {}
export function undoModelRoutingChange(state) {}
export function isModelRoutingDirty(state) {}
export function serializeModelRoutingOperations(state) {}
```

- [x] **Step 3: 验证 GREEN 与静态资源**

Run: `node --test test/admin-model-routing-state.test.mjs test/admin-integration.test.mjs`

不提交 Git。

### Task 7: 模型管理 UI

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/styles.css`

- [x] **Step 1: 先扩展集成测试的静态断言**

断言页面包含“自定义模型”“新增自定义模型”，脚本引用 `model-routing-state.mjs`，无外部 CDN/npm 资源。

- [x] **Step 2: 实现模型列表骨架**

新增独立 section、空状态、卡片、绑定/凭据状态和加载错误状态；沿用现有颜色、字号、按钮和响应式体系。

- [x] **Step 3: 实现新增/编辑两步 dialog**

基础字段先展示，高级通道字段使用 `<details>`；专属通道默认精确 match，复用通道使用 targetRef 选择器；不渲染 headers/auth/Key 控件。

- [x] **Step 4: 实现删除确认和撤销**

确认框列出模型、精确引用、专属/共享通道影响；共享 target 默认不删除；草稿区提供撤销最近操作。

- [x] **Step 5: 实现联合预检和保存**

模型草稿与高级 config 草稿互斥；预检展示 impact/errors/warnings；保存携带 confirmation；成功后重新载入双基线并显示人工重启路由和 Codex 提示。

- [x] **Step 6: 语法和敏感控件扫描**

Run:

```powershell
node --check web/app.js
rg -n "api.?key|authorization|cookie|token" web/app.js web/index.html
```

人工检查命中仅为禁止说明，不存在凭据输入框。

不提交 Git。

### Task 8: 文档、浏览器与最终审计

**Files:**
- Modify: `README.md`
- Modify: `docs/admin-ui.png`（仅在最终页面稳定后更新）

- [x] **Step 1: 更新 README**

说明模型 CRUD、字段含义、专属/共享通道删除规则、双 revision、可恢复事务、保存后人工重启，以及不支持页面输入 Key。

- [x] **Step 2: 启动隔离实例**

只使用新临时目录、临时 config/models、随机端口和 `ROUTER_TEST_SHUTDOWN=1`；不得访问 `A:\CodexData\router`，不得调用供应商。

- [x] **Step 3: 真实浏览器验收**

依次验证新增专属模型、新增复用通道、编辑、slug 改名、删除专属模型和通道、共享通道保留、撤销、revision 冲突、人工重启提示、0 console error/warning、375px 无横向溢出和键盘可访问名称。

- [x] **Step 4: 关闭隔离实例**

只调用该实例自己的 `POST /_admin/shutdown`，确认临时端口停止监听。

- [x] **Step 5: 全量门禁**

Run:

```powershell
node --test "test/*.test.mjs"
node --check A:\codex-multi-model-router\codex-router.mjs
$files = rg --files -g "*.mjs"
foreach ($file in $files) { node --check $file; if ($LASTEXITCODE -ne 0) { exit 1 } }
Get-Content -Raw config.json | ConvertFrom-Json | Out-Null
Get-Content -Raw models.template.json | ConvertFrom-Json | Out-Null
git diff --check
```

- [x] **Step 6: 完成审计**

逐项对照设计目标，确认 CRUD、联合校验、双 revision、敏感保护、可恢复保存、人工重启提示、零依赖和浏览器验收均有直接证据；不部署、不提交、不推送。
