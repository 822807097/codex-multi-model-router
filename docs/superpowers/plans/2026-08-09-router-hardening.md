# Router Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every behavior change. Do not commit, deploy, restart, stop, or touch the running router directory.

**Goal:** 修复路由审查中确认的 P0/P1 安全、协议、状态和资源边界问题，并补齐回归测试与文档。

**Architecture:** 保留 `codex-router.mjs` 作为编排入口，把纯策略放进现有 `lib/` 模块。路由默认 fail closed；Chat 转换和 HTTP framing 严格校验；有界状态仅保存完成任务所需的最小元数据。

**Tech Stack:** Node.js >= 18、`node:` 内置模块、`node:test`，零第三方依赖。

---

### Task 1: 供应商候选与工具历史隔离

**Files:**
- Modify: `lib/provider-pool.mjs`
- Modify: `lib/response-history.mjs`
- Test: `test/provider-pool.test.mjs`
- Test: `test/response-history.test.mjs`

- [x] 先增加未知模型无候选、新聊天不继承 model affinity、previous ID 未命中时不跨任务恢复 call ID 的失败测试。
- [x] 运行 `node --test test/provider-pool.test.mjs test/response-history.test.mjs`，确认失败原因与目标行为一致。
- [x] 删除隐式首目标回退与默认 model affinity；移除危险的全局 call ID 恢复。
- [x] 重跑定向测试并确认全绿。

### Task 2: Chat SSE 与工具别名严格化

**Files:**
- Modify: `lib/chat-stream.mjs`
- Modify: `lib/chat-protocol.mjs`
- Test: `test/chat-stream.test.mjs`
- Test: `test/chat-protocol.test.mjs`

- [x] 为重复真实 delta、index 缺失切换、畸形 JSON、content_filter、无界 SSE 事件和三工具别名碰撞写失败测试。
- [x] 运行 `node --test test/chat-stream.test.mjs test/chat-protocol.test.mjs` 并保存 RED 证据。
- [x] 按严格 delta、工具别名映射、失败终态和缓冲上限实现最小修复。
- [x] 重跑定向测试，确认事件生命周期及完整工具参数正确。

### Task 3: HTTP framing 完整性

**Files:**
- Modify: `lib/transport.mjs`
- Test: `test/transport.test.mjs`

- [x] 为非默认端口 Host、截断 chunked、截断 Content-Length 和非法控制响应写失败测试。
- [x] 运行 `node --test test/transport.test.mjs` 并确认 RED。
- [x] 在请求头和响应体状态机中加入端口与 framing 校验。
- [x] 重跑定向测试，确认截断响应全部拒绝。

### Task 4: 主路由认证、请求头与资源策略

**Files:**
- Create: `lib/request-policy.mjs`
- Modify: `codex-router.mjs`
- Modify: `config.json`
- Test: `test/request-policy.test.mjs`
- Test: `test/router-integration.test.mjs`

- [x] 为显式官方身份、第三方头白名单、未知模型 400、混合协议 failover 拒绝、非字符串 previous ID 和请求体资源上限写失败测试。
- [x] 运行相应定向测试确认 RED。
- [x] 实现纯请求策略模块，并让主入口只通过该模块决定认证、头转发和官方 body 适配。
- [x] 视觉缓存改哈希 + single-flight，限制图片数量与并发。
- [x] 重跑定向测试。

### Task 5: 检查点安全与并发顺序

**Files:**
- Modify: `lib/goal-checkpoint.mjs`
- Modify: `codex-router.mjs`
- Test: `test/goal-checkpoint.test.mjs`
- Test: `test/router-integration.test.mjs`

- [x] 为工具输出脱敏、凭据模式清理和旧请求不得覆盖新检查点写失败测试。
- [x] 运行定向测试确认 RED。
- [x] 实现有界安全来源和任务版本条件写入。
- [x] 重跑定向测试。

### Task 6: 配置、脚本与 README 对齐

**Files:**
- Modify: `README.md`
- Modify: `config.json`
- Modify: `scripts/test-router.ps1`
- Modify: `scripts/test-router.sh`
- Modify: `scripts/start-router.sh`
- Modify: `test/live-providers.mjs`

- [x] 修正 key 名、默认 DeepSeek 原生 Responses live 覆盖、合法 JSON 示例和模型切换能力边界。
- [x] 恢复 `docs/demo-model-switching.png` 的 README 展示。
- [x] 明确目标检查点仅在 Chat 裁剪链路生效，以及原生/Chat 切换所需的完整历史条件。

### Task 7: 集成审查与完成验证

**Files:**
- Review: all modified files

- [x] 运行 `npm test`。
- [x] 运行 `node --check A:\codex-multi-model-router\codex-router.mjs`。
- [x] 运行零依赖检查与 `git diff --check`。
- [x] 使用独立代码质量审查复核凭据边界、错误生命周期和内存上限。
- [x] 确认未部署、未提交、未操作运行版本。
