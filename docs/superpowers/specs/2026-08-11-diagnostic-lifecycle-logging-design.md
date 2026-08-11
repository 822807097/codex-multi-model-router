# 路由诊断生命周期日志设计

## 目标

为本地多模型路由补齐可关联、可检索、可自动清理的诊断日志，使一次失败能够明确归因到路由拒绝、上游容量、上游网络、协议转换、failover 或客户端提前断开。

日志仅用于本机短期诊断，不承担审计、计费或长期分析职责。

## 范围

- 保持 `ROUTER_LOG` 现有入口及核心活动文件路径不变；上下文维护事件写入独立文件。
- 使用 JSON Lines，每行记录一个独立生命周期事件。
- 为每个 Responses 请求生成本地 `request_id`，同一请求的所有事件共享该 ID。
- 记录请求接收、上游尝试、上游响应、failover、完成、失败及客户端断开。
- 按自然日轮转活动日志，并删除修改时间超过 72 小时的归档。
- 保留单文件 50MB 上限作为异常流量下的磁盘保护。

不包含日志查询 UI、远程日志上传、指标服务、分布式追踪或供应商 API 调用测试。

## 日志事件

公共字段：

- `ts`：ISO 8601 UTC 时间。
- `event`：事件名称。
- `request_id`：本地生成的随机关联 ID。
- `model`：客户端选择的模型 slug。
- `method`、`path`：本地请求方法和不含查询参数的路径。
- `elapsed_ms`：相对请求接收时刻的毫秒数。

请求形状字段：

- `body_bytes`、`input_items`。
- `has_previous_response_id`。
- `stream`。
- 角色或输入类型计数，但不记录任何正文。

路由与上游字段：

- `target`、`wire_api`、`attempt`、`failover_count`。
- `upstream_status`。
- `upstream_request_id`：仅从明确允许的响应头中提取并限制长度。
- `first_byte_ms`、`duration_ms`。

终态与错误字段：

- `outcome`：`completed`、`upstream_error`、`router_rejected`、`timeout`、`client_disconnected` 或 `stream_error`。
- `error_code`、`error_stage`。
- 不记录上游响应正文，也不直接写入可能包含正文片段的异常 message。

## 事件流

一次正常请求：

1. `request.received`
2. `route.attempt`
3. `upstream.response`
4. `request.completed`

发生 failover：

1. `request.received`
2. `route.attempt`
3. `route.failover`
4. 新目标的 `route.attempt`
5. `upstream.response`
6. `request.completed`

终止场景使用单一终态事件：`request.failed` 或 `request.disconnected`。终态写入必须幂等，避免响应流错误和 close 事件造成重复结算。

## 模块边界

新增独立诊断日志模块，负责：

- JSON 安全编码和字段白名单。
- 顺序异步追加。
- 每日轮转、50MB 轮转及 72 小时归档清理。
- 写入失败隔离，日志故障不得影响请求转发。

路由处理器负责创建请求上下文和记录路由决策；响应管线负责记录上游状态、流完成、流错误和客户端关闭。入口按事件名前缀拆分文件：`router.log` 保存核心请求生命周期，`router-context.log` 保存历史恢复、上下文裁剪和目标检查点。两类事件继续共享 `request_id`，通过窄回调传递结构化字段，不共享文件系统状态。

## 轮转与保留

- `ROUTER_LOG` 指向核心活动日志，例如 `router.log`；`ROUTER_CONTEXT_LOG` 可覆盖上下文活动日志，未设置时由核心路径派生为 `router-context.log`。
- 两个活动文件独立执行以下轮转和清理规则，避免高频上下文维护事件挤占核心故障链路。
- 首次写入或日期变化时检查活动文件；属于更早日期时归档为带 UTC 日期的文件。
- 活动文件超过 50MB 时使用带日期和序号的归档名轮转。
- 清理低频随写入触发，删除同目录、同基名且修改时间早于当前时间 72 小时的归档。
- 绝不删除活动文件或不符合各自归档命名规则的文件。

## 隐私与健壮性

- 只接受代码定义的字段白名单，不序列化任意请求、响应或异常对象。
- 不记录 Authorization、Cookie、API Key、请求正文、响应正文、工具参数或模型输出。
- 所有字符串设置长度上限并移除换行控制字符。
- 日志写入、轮转和清理错误全部吞掉并可选输出本地控制台警告，但不改变 HTTP 结果。
- 写入队列保持顺序，并使用 `unref` 或按需执行，避免阻止进程退出。

## 测试与验收

- 先用失败测试定义 JSONL 格式、字段白名单和请求 ID 关联。
- 验证原生 Responses 503 能记录目标、状态码和上游 request-id。
- 验证 Chat failover 的两次尝试和一次 failover 共用同一请求 ID。
- 验证成功流、流错误和客户端断开各自只产生一个终态。
- 验证密钥、请求正文和上游错误正文不会进入日志。
- 使用受控时间和临时目录验证每日轮转、50MB 兜底及超过 72 小时清理。
- 运行定向测试、完整 `node --test`、所有 `.mjs` 语法检查及 `git diff --check`。

## 非目标与约束

- 不写入或修改 `A:\\CodexData\\router`。
- 不运行启动、停止或重启脚本，不结束任何 Node 进程。
- 不调用真实模型供应商。
- 不提交、不推送。
- 继续保持零 npm 依赖，代码注释使用中文。
