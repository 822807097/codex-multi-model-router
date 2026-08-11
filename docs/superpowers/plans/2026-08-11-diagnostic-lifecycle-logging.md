# Diagnostic Lifecycle Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为本地路由增加脱敏、可关联、保留三天的 JSONL 请求生命周期诊断日志。

**Architecture:** 文件写入、轮转和保留策略集中在独立 `diagnostic-log` 模块；请求级状态机集中在 `request-diagnostics` 模块。入口把核心请求生命周期和上下文维护事件写入两个独立 JSONL 文件，两者共享 `request_id`；路由处理器和响应管线不接触文件系统。

**Tech Stack:** Node.js 18+ 内置模块、ESM、`node:test`、JSON Lines；零 npm 依赖。

**约束：** 不更新 `A:\\CodexData\\router`，不启停进程，不调用真实供应商，不执行 Git commit/push。计划中的阶段终点使用 `git diff --check` 代替提交。

---

## 文件结构

- 新建 `lib/diagnostic-log.mjs`：字段白名单、JSONL 顺序写入、UTC 每日轮转、50MB 兜底轮转和 72 小时归档清理。
- 新建 `lib/request-diagnostics.mjs`：请求 ID、耗时、公共字段、最后一次上游状态及幂等终态。
- 新建 `test/diagnostic-log.test.mjs`：文件格式、脱敏、轮转与保留测试。
- 新建 `test/request-diagnostics.test.mjs`：请求关联和终态幂等测试。
- 修改 `lib/router-handler.mjs`：接入请求生命周期事件、路由尝试、上游响应、failover 和错误分类。
- 修改 `lib/response-pipeline.mjs`：把流错误通过窄回调报告给请求诊断状态机。
- 修改 `codex-router.mjs`：创建核心与上下文两个日志器、按事件分类注入并在优雅退出前刷新两条队列。
- 修改 `lib/chat-request.mjs`：把检查点/裁剪文本日志改为结构化事件，保证日志文件全部为 JSONL。
- 修改相关测试和 `README.md`：覆盖集成行为并说明日志格式与三天保留策略。

### Task 1: JSONL 文件日志器

**Files:**
- Create: `lib/diagnostic-log.mjs`
- Create: `test/diagnostic-log.test.mjs`

- [ ] **Step 1: 写入字段白名单和脱敏失败测试**

测试在临时目录创建日志器，写入包含允许字段以及 `authorization`、`prompt`、嵌套异常对象的事件，刷新后逐行 `JSON.parse`，断言只保留允许字段、字符串无换行且长度受限。

- [ ] **Step 2: 运行红灯测试**

Run: `node --test test/diagnostic-log.test.mjs`

Expected: FAIL，原因是 `lib/diagnostic-log.mjs` 尚不存在。

- [ ] **Step 3: 实现最小顺序 JSONL 写入**

导出接口：

```js
export function createDiagnosticLog({
  filePath,
  maxBytes = 50 * 1024 * 1024,
  retentionMs = 72 * 60 * 60 * 1000,
  cleanupIntervalMs = 60 * 60 * 1000,
  now = Date.now,
} = {}) {
  return {
    write(event) {},
    flush() {},
  };
}
```

`write` 只接受普通对象，补充 `ts`，按代码定义的允许字段顺序编码；任何文件错误都被写入链隔离，不影响调用方。

- [ ] **Step 4: 运行绿灯测试**

Run: `node --test test/diagnostic-log.test.mjs`

Expected: PASS。

- [ ] **Step 5: 写入每日轮转、50MB 轮转和 72 小时清理失败测试**

使用可控 `now` 和临时文件 mtime，验证：旧 UTC 日期的活动文件先归档；超限文件使用同日序号归档；仅删除同基名、符合归档命名规则且年龄严格超过 72 小时的文件；活动文件和无关文件保留。

- [ ] **Step 6: 实现轮转和低频清理并复测**

Run: `node --test test/diagnostic-log.test.mjs`

Expected: PASS，且临时目录中只存在活动文件、三天内归档和无关文件。

- [ ] **Step 7: 检查本阶段差异**

Run: `git diff --check -- lib/diagnostic-log.mjs test/diagnostic-log.test.mjs`

Expected: exit 0。

### Task 2: 请求级诊断状态机

**Files:**
- Create: `lib/request-diagnostics.mjs`
- Create: `test/request-diagnostics.test.mjs`

- [ ] **Step 1: 写入关联 ID、耗时和终态幂等失败测试**

期望接口：

```js
const lifecycle = createRequestDiagnostics({
  write,
  requestId: 'req_test',
  method: 'POST',
  path: '/v1/responses',
  now,
});

lifecycle.received({ body_bytes: 128 });
lifecycle.parsed({ model: 'gpt-test', input_items: 3 });
lifecycle.attempt({ target: 'official', wire_api: 'responses', attempt: 1 });
lifecycle.upstream({ upstream_status: 503, upstream_request_id: 'up_req' });
lifecycle.fail({ error_code: 'server_overloaded', error_stage: 'upstream_headers' });
lifecycle.complete();
```

断言所有事件共享 `request_id`，耗时单调，`fail` 后的 `complete` 不产生第二个终态。

- [ ] **Step 2: 运行红灯测试**

Run: `node --test test/request-diagnostics.test.mjs`

Expected: FAIL，原因是模块尚不存在。

- [ ] **Step 3: 实现最小状态机**

导出 `createRequestId()` 和 `createRequestDiagnostics()`；状态机维护开始时间、模型、最后目标、尝试次数、failover 次数和待定失败，提供 `received`、`parsed`、`attempt`、`upstream`、`markFailure`、`finish`、`disconnect`、`streamError` 方法。

- [ ] **Step 4: 运行绿灯测试并检查差异**

Run: `node --test test/request-diagnostics.test.mjs && git diff --check -- lib/request-diagnostics.mjs test/request-diagnostics.test.mjs`

Expected: tests PASS，diff check exit 0。

### Task 3: 接入路由和响应流

**Files:**
- Modify: `lib/router-handler.mjs`
- Modify: `lib/response-pipeline.mjs`
- Modify: `test/router-handler.test.mjs`
- Modify: `test/response-pipeline.test.mjs`
- Modify: `test/router-integration.test.mjs`

- [ ] **Step 1: 写入上游状态和流终态失败测试**

扩展响应管线测试，模拟正常原生流、Chat 流错误和客户端 close；断言回调分别报告完成、`stream_error` 和 `client_disconnected`，且不重复终态。

- [ ] **Step 2: 写入 503 与 failover 关联失败测试**

在隔离路由测试中设置临时 `ROUTER_LOG`：原生目标返回 503 和安全 `x-request-id`；Chat 主目标返回 503 后备用目标成功。读取 JSONL 后断言 503 字段完整、两次 Chat 尝试和 failover 共用一个请求 ID，并断言密钥、提示词及上游错误正文不在文件中。

- [ ] **Step 3: 运行红灯测试**

Run: `node --test test/response-pipeline.test.mjs test/router-integration.test.mjs`

Expected: FAIL，缺少生命周期事件或结构化字段。

- [ ] **Step 4: 在处理器中接入请求上下文**

每个 POST 代理请求创建一次 lifecycle；在长度拒绝、并发拒绝、JSON/协议验证、候选选择、每次上游尝试、上游响应和 failover 分支调用对应方法。错误分类只传 `status`、`code` 和阶段，不传响应正文或异常 message。

- [ ] **Step 5: 在响应管线中报告流错误**

为 `pipeNativeResponse` 和 `pipeChatResponse` 增加可选的窄回调对象；原有调用签名保持兼容。回调仅报告成功结束或流错误，文件写入仍由入口日志器负责。

- [ ] **Step 6: 运行绿灯和路由回归测试**

Run: `node --test test/request-diagnostics.test.mjs test/response-pipeline.test.mjs test/router-handler.test.mjs test/router-integration.test.mjs`

Expected: PASS，真实供应商测试文件不会运行。

- [ ] **Step 7: 检查本阶段差异**

Run: `git diff --check -- lib/router-handler.mjs lib/response-pipeline.mjs test/router-handler.test.mjs test/response-pipeline.test.mjs test/router-integration.test.mjs`

Expected: exit 0。

### Task 4: 入口、旧诊断事件和文档

**Files:**
- Modify: `codex-router.mjs`
- Modify: `lib/chat-request.mjs`
- Modify: `README.md`
- Modify: `test/chat-request.test.mjs`

- [ ] **Step 1: 写入入口日志格式集成失败测试**

隔离入口设置 `ROUTER_LOG`，完成一次请求和优雅关闭后，断言核心与派生上下文文件的每个非空行都可 `JSON.parse`；核心文件包含请求终态，上下文文件包含历史恢复或裁剪事件，且相同请求可用 `request_id` 跨文件关联。

- [ ] **Step 2: 运行红灯测试**

Run: `node --test test/router-integration.test.mjs`

Expected: FAIL，现有入口仍写文本行。

- [ ] **Step 3: 替换入口写入器并结构化旧事件**

入口创建两个 `createDiagnosticLog` 实例，核心事件写入 `ROUTER_LOG`，`history.*`/`context.*` 写入 `ROUTER_CONTEXT_LOG` 或派生的 `*-context.log`；优雅退出前刷新两条队列。`HISTORY`、`CHECKPOINT`、`CHECKPOINT_FALLBACK` 和 `TRIM` 改为字段受限的结构化事件。

- [ ] **Step 4: 更新 README**

说明 `ROUTER_LOG` 为 JSONL 活动文件、事件关联方式、三天保留、UTC 每日轮转、50MB 兜底及明确不记录的敏感信息，并给出 PowerShell 按 `request_id` 检索示例。

- [ ] **Step 5: 运行入口和构建器测试**

Run: `node --test test/chat-request.test.mjs test/router-integration.test.mjs`

Expected: PASS。

### Task 5: 完整验证与完成审计

**Files:**
- Verify: all changed project files

- [ ] **Step 1: 运行完整测试**

Run: `node --test "test/*.test.mjs"`

Expected: 全部 PASS、0 fail、0 cancelled。

- [ ] **Step 2: 检查全部 ESM 语法**

Run: `Get-ChildItem -Recurse -Include '*.mjs' -File | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { throw "syntax failed: $($_.FullName)" } }`

Expected: exit 0。

- [ ] **Step 3: 检查格式和变更范围**

Run: `git diff --check; git status --short`

Expected: diff check exit 0；状态中没有 `A:\\CodexData\\router`、启动脚本或无关生成物的新修改。

- [ ] **Step 4: 按设计逐项审计**

逐项确认请求关联、供应商、协议、状态、耗时、failover、中断、每日轮转、72 小时清理、50MB 兜底、脱敏和文档都有直接测试或源码证据。任何缺失都返回对应任务补齐，不能以全量测试通过代替需求覆盖。
