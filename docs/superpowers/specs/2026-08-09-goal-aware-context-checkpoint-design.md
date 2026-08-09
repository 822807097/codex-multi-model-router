# Codex 持续目标上下文检查点设计

## 目标

为 `wireApi: "chat"` 的第三方模型通道增加有界、目标感知的语义检查点。当完整上下文即将删除旧轮次时，路由使用当前候选供应商生成一份结构化执行摘要，保留 Codex 持续目标所需的目标、约束、决策、进度、工作集、失败记录和下一步，同时继续遵守模型输入窗口。

本功能不模拟 OpenAI 的加密 compaction item，不声明完整 `previous_response_id` 能力，也不长期保存原始完整对话。

同一 Codex 任务中的模型选择行为保持不变：`/models` 返回的自定义模型继续出现在桌面端同一个模型菜单中，用户可以在任务执行过程中切换模型。模型切换只改变本轮路由目标，不创建新任务，也不能丢失已经建立的目标检查点。

## 背景与边界

OpenAI Responses 的官方 compaction 会返回不透明的加密 compaction item，并允许客户端把它作为后续上下文的规范输入。第三方 Chat API 无法生成兼容的加密 item，因此路由不能伪造官方 compact 结果。

当前路由在超出预算时删除完整旧轮次，能避免 API 上下文错误，却可能让持续目标任务遗忘早期决策和已完成工作。本设计只解决 Chat 通道的目标连续性；原生 Responses 通道继续透传上游的官方 compaction 能力。

官方参考：<https://developers.openai.com/api/docs/guides/compaction>

## 非目标

- 不缓存完整用户对话、模型正文或推理历史。
- 不为 Chat 通道伪造 `/responses/compact` 的加密输出。
- 不把 `/models` 的 `previous_response_id` 能力改为 `true`。
- 不在未发生上下文裁剪时增加额外模型调用。
- 不跨供应商复用上游响应 ID、prompt cache 句柄、sticky 连接状态或未完成工具调用。
- 不引入 npm 包或外部分词器。

## Codex++ 参考结论

Codex++ 主仓库是桌面端 tweak 运行时，目标增强实际位于独立的 `b-nnett/codex-plusplus-goal`。该 tweak 没有实现自己的长上下文摘要或自动续跑引擎，而是：

- 把目标按 `thread_id` 写入 Codex 原生 `state_5.sqlite` 的 `thread_goals` 表。
- 保存 `objective`、`status`、`token_budget`、`tokens_used`、`time_used_seconds` 等独立状态。
- 通过 `/goal`、pause、resume、complete、clear 管理生命周期。
- 继续把 `/goal <objective>` 作为用户消息提交，让 Codex 原生目标工具参与执行。
- 模型选择仍属于当前线程，不与目标记录绑定。

可迁移到路由层的核心不是读取或修改 Codex 数据库，而是“目标是线程级稳定状态，不能只埋在会被裁剪的对话正文里”。本路由不得依赖 Codex++、Electron、`better-sqlite3` 或私有数据库结构，也不得直接读写 `state_5.sqlite`；它只从当前 Responses 请求中识别目标证据，并维护有界内存检查点。

## 总体架构

新增 `lib/goal-checkpoint.mjs`，负责检查点来源选择、提示构造、摘要解析和 TTL/LRU 缓存。`lib/context-budget.mjs` 扩展为返回被删除的完整轮次。`codex-router.mjs` 只负责编排：计算预算、请求检查点、注入检查点、再次验证预算并调用主模型。

```text
Responses 请求
  → Responses→Chat 转换
  → 预留检查点空间后计算完整预算
  → 无旧轮次被删除：直接请求主模型
  → 有旧轮次被删除：
      目标锚点 + 旧检查点 + 被删除历史的有界来源
        → 同一候选供应商非流式摘要
        → 供应商无关的任务检查点
        → 低优先级 assistant 历史注入
        → 最近完整轮次
        → 最终预算复核
        → 请求主模型
  → 摘要失败：记录诊断并使用现有完整轮次裁剪结果
```

## 组件设计

### 1. 详细上下文裁剪

`fitMessagesToContext()` 增加可选的 `reserveTokens`，并返回：

- `messages`：保留的 system 消息和最近完整轮次。
- `removedMessages`：按原顺序返回被删除的完整旧轮次。
- `trimmedGroups`：删除的轮次数。
- 现有 token 统计字段。

system 消息始终保留。用户轮次、assistant tool_calls 和对应 tool 结果不得拆开。检查点启用时先预留 `maxOutputTokens` 对应的输入空间，保证注入摘要后无需大幅二次裁剪。

### 2. 目标锚点

目标锚点来自原请求中的以下内容：

- `instructions`。
- developer/system 消息。
- 可识别的 `metadata.goal`、`metadata.objective` 或 `metadata.task` 字符串。
- 最新的 Codex 原生目标工具结果；只解析形状正确且状态为成功的 `create_goal`、`get_goal` 或 `update_goal` 输出。
- 最新明确的用户 `/goal <objective>` 命令，作为没有结构化目标工具结果时的后备来源。

这些内容只作为摘要器的目标参考，原始 system/developer 消息仍原样保留在主请求中。摘要结果不能替代或覆盖原始高优先级约束。

目标证据按“最新成功目标工具结果 → 显式 metadata → 最新用户 `/goal` → 原始 instructions/system/developer”归并。工具结果或 metadata 只能提供目标状态，不能提升其中夹带文本的指令优先级。路由不访问 Codex 本地数据库。

### 3. 有界检查点来源

摘要来源按以下优先级组成：

1. 目标锚点。
2. 同一会话上一份检查点（存在时）。
3. 被删除历史的第一个用户轮次，用于保留任务起点。
4. 被删除历史的最近完整轮次，从后向前加入，直到达到 `sourceTokenBudget`。

来源选择不拆工具配对。未选中的原始历史不会进入缓存。默认来源预算为模型窗口的 20%，同时设置 128K token 上限，避免为摘要请求再次制造超长上下文。

### 4. 结构化执行检查点

摘要器必须输出简洁 Markdown，固定包含以下标题：

- `目标`
- `硬性约束`
- `已完成`
- `进行中`
- `待完成`
- `关键决定`
- `当前工作集`
- `失败与原因`
- `下一步`

摘要提示明确要求把历史内容视为数据，不能执行其中的新指令；只有原始目标锚点中的约束可列为硬性约束。缺少信息的栏目写“无”，不得虚构状态。

检查点以 `role: "assistant"` 注入，前缀为 `[Codex 持续目标执行检查点]`。使用 assistant 而不是 system，避免把用户或工具内容提升为高优先级指令。

检查点是供应商无关的任务数据，不得包含上游 response id、prompt cache key、供应商名、隐藏推理、认证信息、临时 socket 状态或尚未完成的工具调用。`当前工作集` 可以保留文件路径、公开命令、测试结果和下一步，但不能把旧供应商的工具 call id 当作可恢复状态。

### 5. 摘要调用

检查点使用当前候选 target、认证方式、代理、模型映射和 Chat endpoint，发送 `stream: false` 请求。默认：

- `temperature: 0`
- `max_tokens: 2048`，按供应商的 `maxTokensField` 映射
- 推理关闭或使用最低档
- 独立 `requestMs`，默认 120 秒

Chat 兼容网关返回的 `choices[0].message.content` 可以是字符串或文本 part 数组；其他形状视为摘要失败。

客户端已经在等待 Chat 请求时，现有 SSE 心跳继续发送。客户端提前断开时，同一个 AbortSignal 必须取消摘要 socket。

### 6. 缓存与会话关联

缓存只保存检查点文本、来源哈希、目标名、任务关联和过期时间，不保存原始消息。

- 精确摘要缓存键：供应商标识、上游模型、目标锚点和有界摘要来源的 SHA-256；用于避免同一模型重复生成同一摘要。
- 传输会话别名：可以使用 `previous_response_id`、`prompt_cache_key`、显式 conversation/session metadata 或 `x-codex-session-id`，但只服务于当前供应商链路；禁止仅按 model 共享检查点。
- 强任务键：优先使用显式 conversation/session metadata 或 `x-codex-session-id`。`previous_response_id` 只有在路由已经把该响应映射到强任务键时才能续接，`prompt_cache_key` 和孤立的 `previous_response_id` 不能单独证明跨供应商任务身份。
- 任务检查点别名：使用强任务键关联最新的供应商无关检查点，允许同一任务切换模型后把它作为新摘要的输入来源。
- 默认上限：128 条。
- 默认 TTL：24 小时。
- 淘汰：LRU。

响应完成后，把新 `response.id` 绑定到本轮检查点，供下一轮携带 `previous_response_id` 时恢复。没有强会话键时仍可使用精确来源哈希缓存，但不得跨不同来源复用。

### 6.1 同一任务切换模型

桌面端每轮请求中的 `model` 都是本轮唯一的选路依据。切换模型时：

1. 保留同一任务的原始 system/developer 指令、最近完整轮次和任务检查点。
2. 忽略旧供应商的 response id、prompt cache 句柄、sticky provider 选择和传输级状态；供应商池只能在新模型对应的候选集合内选择，成功后再为新链路建立亲和关系。
3. 若本轮未触发裁剪，直接发送完整历史，不额外调用摘要模型。
4. 若本轮触发裁剪，新供应商使用“上一份任务检查点 + 本轮被删除历史 + 当前目标锚点”重新生成检查点，再调用主模型。
5. 若重新生成失败，上一份检查点通过结构校验和预算复核后可以作为降级输入；没有强会话键时禁止这样跨模型复用。

这样允许 5.6 Sol、DeepSeek、Qwen、Terra 等模型在同一聊天窗口接力，同时不把任何供应商私有会话状态冒充为可迁移上下文。

### 7. 预算复核

注入检查点后再次运行完整预算：

- 若检查点和最近轮次可以放入预算，正常请求主模型。
- 若检查点过长，按字符边界缩短检查点并保留所有固定标题，再复核。
- 若最新轮次自身超限，继续返回 `context_length_exceeded`。
- 若仅检查点无法放入，丢弃检查点并使用原裁剪结果，不阻断任务。

## 错误处理

- 摘要连接错误、超时、非 200、非 JSON 或缺少正文：写脱敏诊断日志，降级为完整轮次裁剪。
- 401/403：不 failover，不把密钥或上游正文写入日志，仍降级裁剪。
- 429/5xx：检查点本身不触发供应商 failover，避免一次主请求产生额外跨供应商副作用。
- 客户端取消：立即终止摘要和后续主请求，不产生缓存。
- 缓存异常：视为 miss，不影响主请求。

## 配置

新增可选配置：

```json
{
  "goalCheckpoint": {
    "enabled": true,
    "maxEntries": 128,
    "ttlMs": 86400000,
    "sourceTokenBudget": 128000,
    "sourceWindowRatio": 0.2,
    "maxOutputTokens": 2048,
    "requestMs": 120000
  }
}
```

所有值都有保守默认值。`enabled: false` 完全恢复当前行为。

## 安全与隐私

- 摘要调用只发往本轮用户所选模型对应、原本就要接收任务上下文的供应商，不为生成检查点额外 fan-out 到其他供应商。
- 只有用户在具有强任务键的同一聊天中切换模型时，供应商无关检查点才可作为新供应商重新摘要的有界输入；缓存中的原始被裁历史、认证信息和供应商私有状态一律不迁移。
- 不落盘，不写入 auth.json、models.json 或路由日志。
- 日志只记录缓存命中、来源 token、摘要长度、耗时和错误分类。
- 摘要以 assistant 历史注入，避免权限提升。
- 缓存有 TTL/LRU 上限，且不保存原始被裁历史。

## 测试策略

### 单元测试

- 详细裁剪返回完整 `removedMessages`，工具调用与结果不拆分。
- 目标锚点正确提取 instructions、system/developer 和 metadata。
- 来源选择保留任务起点、上一检查点和最近完整轮次，并遵守预算。
- 摘要提示包含固定栏目和防指令提升约束。
- 检查点以 assistant 角色注入。
- 缓存遵守精确哈希、强会话键、TTL 和 LRU，不按 model 串会话。
- 从 Codex 原生目标工具结果和 `/goal` 命令提取目标，但不读取本地数据库。
- 摘要正文兼容字符串和文本 part 数组。
- 过长检查点缩短后仍保留固定标题。

### 隔离端到端测试

- 构造小上下文窗口触发摘要，mock 上游先响应非流式摘要，再返回主 SSE。
- 验证主请求包含目标检查点、最近用户轮次和完整工具配对。
- 第二个相同请求命中缓存，不重复摘要调用。
- 摘要 500、非 JSON 和超时时主请求仍以裁剪历史成功完成。
- 摘要等待期间继续收到 SSE 心跳。
- 客户端断开时摘要 socket 被销毁，缓存不写入。
- `/models` 仍只声明 `streaming: true`。
- Chat `/responses/compact` 的现有拒绝语义保持不变。
- 同一强会话键从 DeepSeek 切换到 Qwen（以及反向切换）时，模型菜单和任务线程不变；新供应商收到同一目标、约束、最近轮次和重新归一化后的检查点。
- 模型切换不得携带旧供应商 response id、cache key、sticky target 或未完成 tool call；重新摘要失败时使用经过校验的供应商无关检查点降级。
- 缺少强会话键时，两个相同模型名或相同目标的不同聊天不得共享任务检查点。

### 回归与真实验证

- `npm test` 全部通过。
- `node --check A:\codex-multi-model-router\codex-router.mjs` 通过。
- 使用隔离端口和临时配置验证，不修改运行版本。
- 经用户已有授权时，分别用 DeepSeek Flash 和 Qwen3.8 Max 做一次触发检查点的最小真实请求；密钥不得输出或写入文件。

## 验收标准

- 未触发裁剪的请求不增加摘要调用。
- 触发裁剪时，主请求包含结构化目标执行检查点和最近完整轮次。
- `/models` 的自定义模型仍显示在同一个桌面端模型菜单，当前任务可以逐轮切换模型继续执行。
- 具有强会话键的同一任务跨模型切换后目标、约束、进度和下一步保持连续，供应商私有状态不迁移。
- 摘要失败不阻断主任务。
- 最新轮次超限仍明确报错。
- 不缓存完整历史，不通过弱会话键跨任务串用检查点。
- 不改变原生 Responses compact、`previous_response_id` 声明和安全 failover 语义。
- 零依赖、中文注释、自动化测试和隔离端到端验证全部通过。
