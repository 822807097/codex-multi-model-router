# Codex 持续目标检查点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Chat 转换通道增加只在旧轮次被裁剪时生成的目标感知检查点，并保证同一强任务键跨 DeepSeek、Qwen、OpenAI 等模型切换时任务语义连续、供应商私有状态隔离。

**Architecture:** `lib/context-budget.mjs` 负责返回被删除的完整轮次；新的 `lib/goal-checkpoint.mjs` 负责目标提取、来源选择、固定栏目校验和 TTL/LRU 内存关联；`codex-router.mjs` 负责编排当前候选供应商的非流式摘要调用与主流式请求。检查点是 assistant 历史数据，不伪造 Responses compaction item，也不声明 `previous_response_id` 能力。

**Tech Stack:** Node.js ESM、`node:` 内置模块、`node:test`、裸 HTTP/1.1 传输；零 npm 运行依赖。

---

### Task 1: 详细上下文裁剪

**Files:**
- Modify: `lib/context-budget.mjs`
- Modify: `test/context-budget.test.mjs`

- [ ] **Step 1: 写失败测试**

测试 `fitMessagesToContext(messages, tools, capability, { reserveTokens })` 返回 `removedMessages`，并断言删除结果包含完整 user/assistant tool_calls/tool 组，system 与最新轮次仍保留。

- [ ] **Step 2: 运行定向测试确认失败**

Run: `node --test test/context-budget.test.mjs`

Expected: FAIL，因为当前结果没有 `removedMessages`，也不接受 `reserveTokens`。

- [ ] **Step 3: 实现最小接口**

在模块内按 leading system 与用户轮次分组，预算计算增加：

```js
const reserveTokens = Math.max(0, Number(options.reserveTokens) || 0);
const messageBudget = Math.max(0, contextBudget - maxOutput - protocolReserve - toolTokens - reserveTokens);
return { messages, removedMessages, fits, trimmedGroups, messageTokens, toolTokens, messageBudget, contextBudget };
```

删除只以完整组为单位，最新组自身超限时仍返回 `fits: false`。

- [ ] **Step 4: 运行定向测试确认通过**

Run: `node --test test/context-budget.test.mjs`

Expected: PASS。

### Task 2: 目标锚点、检查点格式与有界存储

**Files:**
- Create: `lib/goal-checkpoint.mjs`
- Create: `test/goal-checkpoint.test.mjs`

- [ ] **Step 1: 写目标提取失败测试**

覆盖最新成功 `get_goal/create_goal/update_goal` 工具结果、metadata、`/goal <objective>`、instructions 与 developer/system；断言工具结果优先且不会读取本地数据库。

- [ ] **Step 2: 写跨模型存储失败测试**

覆盖强任务键、孤立 `previous_response_id` 不得作为跨供应商身份、同供应商精确缓存、强任务键跨供应商取得供应商无关检查点、TTL/LRU 淘汰和 response id 到任务键映射。

- [ ] **Step 3: 实现公开接口**

```js
export function extractGoalAnchor(body) {}
export function resolveStrongTaskKey(body, headers, store) {}
export function buildCheckpointSource(options) {}
export function buildCheckpointMessages(source) {}
export function extractCheckpointText(chatResponse) {}
export function normalizeCheckpoint(text, maxTokens) {}
export class GoalCheckpointStore {}
```

固定栏目为目标、硬性约束、已完成、进行中、待完成、关键决定、当前工作集、失败与原因、下一步；缺栏摘要视为失败。缓存只保存检查点、哈希、关联和过期时间，不保存原始来源消息。

- [ ] **Step 4: 运行新单元测试**

Run: `node --test test/goal-checkpoint.test.mjs`

Expected: PASS。

### Task 3: 非流式摘要与主请求编排

**Files:**
- Modify: `codex-router.mjs`
- Modify: `test/router-integration.test.mjs`

- [ ] **Step 1: 写隔离集成失败测试**

mock Chat 上游先收到 `stream:false` 摘要请求并返回九栏目检查点，再收到 `stream:true` 主请求；断言只有触发裁剪才摘要，主请求含 assistant 检查点、最近轮次和完整工具组，等待摘要期间仍有心跳。

- [ ] **Step 2: 实现摘要调用**

复用当前 target 的 host、prefix、认证、代理、`provider.maxTokensField` 与 `rawHttpsRequest()`：

```js
const summaryRequest = {
  model: upstreamModel(target, requestedModel),
  messages: buildCheckpointMessages(source),
  stream: false,
  temperature: 0,
  [provider.maxTokensField]: checkpointConfig.maxOutputTokens,
};
```

非 200、非 JSON、正文缺失、超时和格式错误都抛给检查点降级分支，不能触发供应商 failover。

- [ ] **Step 3: 实现异步 Chat 准备流程**

先做无预留预算；没有裁剪时直接发主请求。有裁剪时预留检查点空间、选择有界来源、命中精确缓存或向当前供应商摘要、注入 assistant 检查点并最终复核。摘要失败时优先使用强任务键的已校验检查点，否则回退当前完整轮次裁剪。

- [ ] **Step 4: 响应完成后记录检查点**

只在 `response.completed` 对应的 transform `response` 事件到达后写入内存存储，同时把新 `response.id` 映射到强任务键；客户端取消、摘要失败或主请求失败不产生新缓存。

- [ ] **Step 5: 运行集成测试**

Run: `node --test test/router-integration.test.mjs`

Expected: PASS。

### Task 4: 同任务跨模型接力

**Files:**
- Modify: `test/router-integration.test.mjs`
- Modify: `codex-router.mjs`

- [ ] **Step 1: 写 DeepSeek→Qwen 风格切换测试**

在同一 `x-codex-session-id` 下先请求模型 A 产生检查点，再请求模型 B；断言 B 的摘要来源包含上一份任务检查点，但 B 的请求不携带 A 的 response id、cache key、sticky target 或未完成 tool call。

- [ ] **Step 2: 写弱身份隔离测试**

两个没有强任务键、目标文本相同的请求切换模型，断言不能取得彼此检查点。

- [ ] **Step 3: 完成候选目标隔离**

继续以每轮 `body.model` 作为候选集合唯一依据；旧 affinity 只在新候选集合仍包含同一 target 时有效，成功后为新模型链路重新绑定。

- [ ] **Step 4: 运行跨模型集成测试**

Run: `node --test test/router-integration.test.mjs`

Expected: PASS。

### Task 5: 回归、语法与真实供应商验证

**Files:**
- Verify only: `codex-router.mjs`, `lib/*.mjs`, `test/*.test.mjs`

- [ ] **Step 1: 运行完整自动化测试**

Run: `npm test`

Expected: 全部 PASS，无未关闭句柄。

- [ ] **Step 2: 运行硬性语法检查**

Run: `node --check A:\codex-multi-model-router\codex-router.mjs`

Expected: exit code 0，无输出。

- [ ] **Step 3: 隔离真实验证**

使用随机本地端口、临时配置和临时 catalog，分别让 DeepSeek Flash 与 Qwen3.8 Max 触发检查点并在同一强任务键下换模；只从环境变量读取密钥，不输出、不写文件。子路由仅通过 `/_admin/shutdown` 优雅退出。

- [ ] **Step 4: 完成逐项审计**

核对九栏目、只在裁剪时摘要、摘要失败降级、客户端取消、TTL/LRU、跨模型连续、供应商私有状态隔离、`/models` 仅 streaming、compact 拒绝、零依赖、中文注释、不部署、不提交和未触碰运行目录。

> 用户明确禁止 Git 提交和推送，因此本计划故意省略所有 commit 步骤。
