// ---------- 谷歌订阅通道派发器：chat 请求 → Antigravity generateContent ----------
// 在路由的 chat 上游派发点拦截 platform:'google' 的目标：
// 1. authManager 谷歌账号池选号（优先级/套餐排序 + 轮换），429/403/401/凭据失效
//    自动冷却当前账号并换池内下一个账号重试（sub2api 式故障转移）
// 2. chat 体 → Gemini request（google-bridge）→ 外层 {project, model, request, ...}
// 3. 流式走 :streamGenerateContent?alt=sse 并转回 chat SSE；非流式走 :generateContent
//    转回 chat JSON——对下游完全呈现为一个标准 chat 上游，桥接/统计/错误处理零改动。
// 返回形状与 openHttpsStream 对齐：{status, headers, stream, socket}。

import fs from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import { rawHttpsRequest } from './transport.mjs';
import {
  chatToGenerateRequest,
  generateResponseToChatCompletion,
  createGeminiSseToChatTransform,
} from './google-bridge.mjs';
import { googleUserAgent, discoverGoogleProject } from './auth/google-sub-auth.mjs';

// generateContent 端点回退顺序对齐 Antigravity 官方客户端：daily → autopush → prod。
// 实测（2026-08-28）：部分 Pro 账号 prod 端点 RESOURCE_EXHAUSTED 而 daily 正常出活，
// 且两端点模型覆盖不完全一致（如 gemini-3.1-pro-high 仅 prod 认识）——逐端点尝试，
// 非 200 都换下一个端点，三端点全拒以最后状态定夺。
const GENERATE_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];

// 「账号×模型」级分钟配额冷却（跨请求状态）：key = `${accountId}|${model}` → 恢复时间戳。
const modelAccountCooldown = new Map();

// ---- 「单请求超分钟配额桶」识别（2026-09-01 QA-10 实锤）----
// 谷歌按「输入 token」做分钟配额预检：智能体客户端全量重发烧出的 1MB+ 上下文
// 单次请求自己就装不进分钟配额桶——表现为同一请求每轮重试必 429（等待重置无效，
// 换号无效：账号池里每个账号的桶都装不下同级请求）。识别到这种形态后快速失败，
// 不再空耗上游与重试预算，错误信息直接给出可执行指引。
const OVERSIZED_429_MIN_BYTES = 500 * 1024;   // 请求体 ≥500KB 才参与判定（小请求永不误伤）
const OVERSIZED_429_WINDOW_MS = 10 * 60_000;  // 429 历史窗口
const OVERSIZED_429_REPEATS = 3;              // 窗口内 ≥3 次相似尺寸 429 → 判定成立
const model429History = new Map();            // key = model → [{ts, account, bodyBytes}]

export function recordGoogle429(model, accountId, bodyBytes, now = Date.now()) {
  const list = (model429History.get(model) || []).filter((e) => now - e.ts < OVERSIZED_429_WINDOW_MS);
  list.push({ ts: now, account: accountId, bodyBytes });
  model429History.set(model, list.slice(-8));
}

/** 返回 0 = 不快速失败；>0 = 命中（值为窗口内相似尺寸 429 次数） */
export function isRepeatOversized429(model, bodyBytes, now = Date.now()) {
  if (!Number.isFinite(bodyBytes) || bodyBytes < OVERSIZED_429_MIN_BYTES) return 0;
  const list = (model429History.get(model) || []).filter(
    (e) => now - e.ts < OVERSIZED_429_WINDOW_MS
      && Math.abs(e.bodyBytes - bodyBytes) <= bodyBytes * 0.25,
  );
  return list.length >= OVERSIZED_429_REPEATS ? list.length : 0;
}

export function _resetGoogle429History() {
  model429History.clear();
}

// ---- 谷歌通道上下文自动精简（2026-09-01）----
// 智能体客户端（Codex 桌面端等）每轮都全量重发整个会话历史：长会话请求体线性膨胀，
// 反复撞击谷歌「分钟级输入 token 配额桶」造成持续性 429（等待/换号都可能无效）。
// 日志实证（2026-09-01）：3.4MB 请求在桶空闲时能成功、1.5MB 连续两次成功——桶是
// 「消耗量×频率」问题而非硬尺寸问题；把每轮重发量压下来才是治本。
// 业界通行解法是客户端侧上下文压缩（Claude Code /compact、Codex 自动压缩）；客户端
// 不感知通道侧配额时，由网关在谷歌通道入口裁掉最旧的完整旧轮次兜底：
// 只在 user 消息边界切割（assistant tool_calls 与 tool 结果永不被拆散），
// system 前缀永远保留；预算以内不动一个字节。
const CONTEXT_SLIM_DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * 把 chat messages 裁剪到序列化字节预算内（保留 system 前缀 + 尽可能多的最近完整轮次）。
 * @returns {{messages: Array, dropped: number, beforeBytes: number, afterBytes: number}|null}
 *   null = 无需或无法精简（未超预算 / 没有可用的 user 切割点 / 预算非正）。
 */
export function slimChatMessagesToByteBudget(messages, maxBytes) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return null;
  const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const beforeBytes = bytesOf(messages);
  if (beforeBytes <= maxBytes) return null;
  let prefixEnd = 0;
  while (prefixEnd < messages.length && messages[prefixEnd]?.role === 'system') prefixEnd += 1;
  // 每条消息 +1 字节覆盖 JSON 数组逗号/括号边界；后缀字节从尾部累加，一次遍历。
  const sizes = messages.map((m) => bytesOf(m) + 1);
  const suffix = new Array(messages.length + 1).fill(0);
  for (let i = messages.length - 1; i >= prefixEnd; i -= 1) suffix[i] = suffix[i + 1] + sizes[i];
  const prefixBytes = (prefixEnd > 0 ? bytesOf(messages.slice(0, prefixEnd)) : 0) + 2;
  // 从最早的 user 边界向后找第一个能装下的切割点：保留尽可能多的近期上下文。
  for (let i = prefixEnd; i < messages.length; i += 1) {
    if (messages[i]?.role !== 'user') continue;
    if (prefixBytes + suffix[i] <= maxBytes) {
      const kept = messages.slice(0, prefixEnd).concat(messages.slice(i));
      return { messages: kept, dropped: i - prefixEnd, beforeBytes, afterBytes: bytesOf(kept) };
    }
  }
  return null; // 连最新一个完整轮次都装不下：不硬拆单轮内容，交给上游/快速失败给出明确报错
}

function googleErrorBody(status, message, model) {
  return {
    error: {
      message,
      type: 'google_upstream_error',
      code: status,
      ...(model ? { model } : {}),
    },
  };
}

function pickProjectId(account, credentials) {
  const raw = credentials?.projectId || account?.metadata?.projectId || '';
  return raw && raw !== '{}' ? raw : '';
}

/**
 * 用谷歌账号池执行一次 chat→generateContent 调用，返回 chat 形态的上游结果。
 * @param {{
 *   chatBody: object, target: object, model: string,
 *   authManager: object, proxy?: object, openStream?: Function, signal?: object, timeouts?: object,
 *   log?: Function,
 * }} params
 */
export async function openGoogleChatStream({
  chatBody,
  target,
  model,
  authManager,
  proxy,
  openStream,
  signal,
  timeouts,
  contextSlimMaxBytes,
  log = () => {},
}) {
  const upstreamModelName = typeof target.upstreamModel === 'string' && target.upstreamModel
    ? target.upstreamModel
    : model;
  // 档位变体合成（Antigravity Tools 式）：slug 以 -high/-medium/-low 结尾时剥离为
  // thinkingLevel，上游模型名用 target.upstreamModel（一键接入时映射到 -tiered 载体）。
  const levelMatch = /-(high|medium|low)$/i.exec(model);
  const thinkingLevel = levelMatch ? levelMatch[1].toLowerCase() : '';
  const isClaudeModel = /claude/i.test(upstreamModelName);
  // 上下文自动精简：超预算时裁掉最旧完整轮次（详见 CONTEXT_SLIM 注释块）。
  // 不修改调用方传入的 chatBody——故障转移时原 body 还要给其他 target 复用。
  let effectiveChatBody = chatBody;
  const slimBudget = Number.isFinite(contextSlimMaxBytes)
    ? contextSlimMaxBytes
    : CONTEXT_SLIM_DEFAULT_MAX_BYTES;
  let slimApplied = null;
  if (slimBudget > 0 && Array.isArray(chatBody?.messages)) {
    slimApplied = slimChatMessagesToByteBudget(chatBody.messages, slimBudget);
    if (slimApplied) {
      effectiveChatBody = { ...chatBody, messages: slimApplied.messages };
      log({
        event: 'google.channel.context_slim',
        model,
        budget_bytes: slimBudget,
        before_bytes: slimApplied.beforeBytes,
        after_bytes: slimApplied.afterBytes,
        dropped_messages: slimApplied.dropped,
      });
    }
  }
  const generateRequest = chatToGenerateRequest(effectiveChatBody, {
    thinkingLevel,
    isClaude: isClaudeModel,
    log,
  });
  const stream = chatBody.stream === true;

  // ---- 账号池故障转移（sub2api 式负载均衡）----
  // 429（模型分钟级配额）/403（账号无订阅许可）/401/凭据失效 → 冷却当前账号并
  // 自动换池内下一个账号重试；全部账号不可用才把错误回给客户端。
  // 400（请求对某端点非法）不换账号——同模型在其他账号结果一致，由端点回退处理。
  const triedAccounts = new Set();
  const maxAccountAttempts = 4;
  // 429 是「账号×模型」级的分钟配额（实测 zm635 的 3.7-tiered 限流时 2.5-flash 照常 200）：
  // 冷却必须只影响该账号的该模型——账号级冷却会让一个模型的限流连累其他所有模型
  // （2026-08-29 实测踩中：扫描序列里 2.5-pro 的 429 把 claude-sonnet 也打成 503）。
  const modelLimited = (accountId, modelName) => {
    const until = modelAccountCooldown.get(`${accountId}|${modelName}`);
    return Boolean(until && Date.now() < until);
  };
  const coolModelAccount = (accountId, modelName, ms) => {
    modelAccountCooldown.set(`${accountId}|${modelName}`, Date.now() + ms);
    if (modelAccountCooldown.size > 512) {
      const now = Date.now();
      for (const [key, until] of modelAccountCooldown) {
        if (until <= now) modelAccountCooldown.delete(key);
      }
    }
  };
  let bestFailure = null; // {status, message}：429（可等待恢复）优先于 403/其他呈现
  const noteFailure = (status, message) => {
    // 429 最新一次优先（账号尝试数会递增）；已有 429 时不被后续 403/其他覆盖
    if (!bestFailure || status === 429 || bestFailure.status !== 429) {
      bestFailure = { status, message };
    }
  };
  const errorResponse = (status, message, retryAfterSeconds = null) => ({
    status,
    headers: {
      'content-type': 'application/json',
      // 429 带标准 retry-after：守规范的智能体客户端（ZCode 等）会等待而不是立即重试；
      // retryAfterSeconds = 0 表示「重试无意义」（单请求超配额桶），刻意省略让客户端
      // 尽快烧完自己的重试预算、把最终错误暴露出来
      ...(status === 429 && retryAfterSeconds !== 0 ? { 'retry-after': String(retryAfterSeconds || 60) } : {}),
    },
    stream: Readable.from([Buffer.from(JSON.stringify(googleErrorBody(status, message, model)), 'utf8')]),
    socket: null,
  });

  // 大请求反复 429 → 快速失败（判定依据见 OVERSIZED_429_* 注释块）
  const bodyBytesEstimate = Buffer.byteLength(JSON.stringify(generateRequest));
  const oversizedRepeats = isRepeatOversized429(upstreamModelName, bodyBytesEstimate);
  if (oversizedRepeats) {
    const mb = (bodyBytesEstimate / (1024 * 1024)).toFixed(2);
    log({
      event: 'google.channel.oversized_429_fastfail',
      model: upstreamModelName,
      body_bytes: bodyBytesEstimate,
      repeats: oversizedRepeats,
    });
    const slimNote = slimApplied
      ? `（网关已自动精简上下文 ${(slimApplied.beforeBytes / 1048576).toFixed(2)}MB→${mb}MB 仍超限，精简预算可通过 config.json googleChannel.contextSlimMaxBytes 调小）`
      : '';
    return errorResponse(
      429,
      `${model} 已连续 ${oversizedRepeats} 次对同级别请求（本次 ${mb}MB）触发分钟级配额 429：单请求即超该模型的分钟配额桶，等待重试不会恢复${slimNote}。请在客户端切换其他模型（各模型配额独立），或精简上下文/新开会话后重试`,
      0,
    );
  }

  for (let attemptNo = 0; attemptNo < maxAccountAttempts; attemptNo += 1) {
    if (signal?.aborted) break;
    // 不按模型过滤账号：accountSupportsModel 的套餐清单是 ChatGPT Codex 语义，
    // 对谷歌账号会把 gemini 全部判不支持；订阅模型边界由 Antigravity 后端自己管。
    let account = authManager?.acquireAccount({ provider: 'google' });
    const unavailable = (acc) => !acc || triedAccounts.has(acc.id) || modelLimited(acc.id, upstreamModelName);
    let rollGuard = 0;
    while (unavailable(account) && rollGuard < 8) {
      account = authManager.acquireAccount({ provider: 'google' });
      rollGuard += 1;
    }
    if (unavailable(account)) break; // 池内没有该模型可用的未尝试账号了
    triedAccounts.add(account.id);

    let credentials = null;
    try {
      credentials = await authManager.getValidCredentials(account.id);
    } catch (error) {
      authManager.markCooldown?.(account.id, 60_000);
      noteFailure(502, `谷歌账号凭据刷新失败：${error.message || '未知错误'}`);
      continue;
    }
    if (!credentials?.accessToken) {
      authManager.markCooldown?.(account.id, 60 * 60_000);
      noteFailure(502, '谷歌账号没有可用凭据（请重新授权绑定）');
      continue;
    }

    let projectId = pickProjectId(account, credentials);
    if (!projectId) {
      try {
        const discovered = await discoverGoogleProject({ accessToken: credentials.accessToken, proxy });
        projectId = discovered.projectId || '';
        if (projectId) {
          authManager.updateAccount(account.id, { metadata: { ...(account.metadata || {}), projectId } });
        }
      } catch { /* 无 project 继续尝试，由上游报错给出明确信息 */ }
    }

    const outerBody = JSON.stringify({
      ...(projectId ? { project: projectId } : {}),
      model: upstreamModelName,
      request: generateRequest,
      userAgent: 'antigravity',
      requestId: `agent-${randomUUID()}`,
    });
    const baseHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${credentials.accessToken}`,
      'user-agent': googleUserAgent(),
      // Antigravity 官方客户端固定头（缺这组会被 codeassist 后端拒）
      'x-goog-api-client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'client-metadata': JSON.stringify({ ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }),
      // Claude 系思考模型需要交错思考 beta 头（对齐官方客户端）
      ...(/claude/i.test(upstreamModelName) && (/-thinking$/i.test(upstreamModelName) || Boolean(thinkingLevel))
        ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' }
        : {}),
    };

    const attempt = async (baseUrl) => {
      const path = stream ? '/v1internal:streamGenerateContent?alt=sse' : '/v1internal:generateContent';
      const options = {
        protocol: 'https',
        host: new URL(baseUrl).hostname,
        path,
        method: 'POST',
        viaProxy: true,
        proxy,
        headers: {
          ...baseHeaders,
          ...(stream ? { accept: 'text/event-stream' } : {}),
        },
        body: outerBody,
        signal,
        timeouts: timeouts || { connectMs: 10_000, responseHeaderMs: 30_000, requestMs: 300_000 },
      };
      if (openStream) return openStream(options);
      return rawHttpsRequest(options);
    };

    log({
      event: 'google.channel.request',
      account: account.id,
      model: upstreamModelName,
      stream,
      has_project: Boolean(projectId),
      tool_count: Array.isArray(generateRequest.tools) ? generateRequest.tools[0]?.functionDeclarations?.length || 0 : 0,
      attempt_no: attemptNo + 1,
    });

    let upstream = null;
    let lastError = null;
    for (const baseUrl of GENERATE_ENDPOINTS) {
      // 客户端已断开：不再打下一个端点（abort 后的请求注定失败还白耗超时）
      if (signal?.aborted) break;
      try {
        upstream = await attempt(baseUrl);
        // 非 200 全部换端点再试：429=限流（被拒不计费）/403/404/5xx/400（两端点
        // 模型覆盖不一致，如 gemini-3.1-pro-high 仅 prod 认识）——三端点全拒以最后状态定夺。
        if (upstream.status !== 200) {
          // 非 200 全部换端点再试；被放弃的中间响应在换端点前先读完错误体
          //（保留 403/401/400 的具体原因给最终错误信息），再释放连接
          //（池化 socket 等空闲超时才回收，429 故障转移路径会常态性积压连接）
          let snippet = typeof upstream.bodyText === 'string' ? upstream.bodyText : '';
          if (!snippet && upstream.stream) snippet = (await readAll(upstream.stream).catch(() => '')).slice(0, 64 * 1024);
          upstream._errorSnippet = snippet.slice(0, 300);
          try { upstream.stream?.destroy?.(); } catch { /* 已销毁 */ }
          try { upstream.socket?.destroy?.(); } catch { /* 已销毁 */ }
          lastError = upstream;
          continue;
        }
        break;
      } catch (error) {
        lastError = error;
      }
    }
    // H2：abort 在首个端点响应前 break 时 upstream/lastError 均为 null——
    // 直接跳出账号循环，由外层统一收口（upstream.status 会空指针崩溃）。
    if (!upstream) {
      if (lastError) {
        const message = lastError instanceof Error ? lastError.message : '谷歌上游连接失败';
        authManager.markCooldown?.(account.id, 60_000);
        noteFailure(502, message);
      }
      break;
    }
    if (upstream.status === 200) {
      // 本地周计数（订阅页展示）+ 账号活跃度
      authManager.recordQuotaUsage?.(account.id);
      if (stream) {
        const transform = createGeminiSseToChatTransform(model);
        // 错误传播：pipe 只转发 end 不转发 error/close——上游断流时 transform
        // 永不收口，消费方挂死并占用并发名额（审查 H1）。error→destroy、
        // close（无 end 的异常关闭）→正常收口让 SSE 补 finish 帧。
        upstream.stream.on('error', (error) => transform.destroy(error));
        upstream.stream.once('close', () => {
          if (!transform.writableEnded && !upstream.stream.readableEnded) transform.end();
        });
        upstream.stream.pipe(transform);
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
          stream: transform,
          socket: upstream.socket || null,
        };
      }
      // 非流式：整读 Gemini JSON → chat completion JSON
      //（rawHttpsRequest 返回缓冲形态 bodyText；stream 字段仅流式存在）
      const bodyText = typeof upstream.bodyText === 'string'
        ? upstream.bodyText
        : await readAll(upstream.stream).catch(() => '');
      let geminiJson = null;
      try { geminiJson = JSON.parse(bodyText); } catch { /* 上游返回了非法 JSON */ }
      if (!geminiJson) {
        return {
          status: 502,
          headers: { 'content-type': 'application/json' },
          stream: Readable.from([Buffer.from(JSON.stringify(googleErrorBody(502, '谷歌上游返回了无法解析的响应', model)), 'utf8')]),
          socket: upstream.socket || null,
        };
      }
      // Antigravity 把 Gemini 响应包在 response 字段里；兼容裸形态
      const gemini = geminiJson?.response && typeof geminiJson.response === 'object'
        ? geminiJson.response
        : geminiJson;
      const chatJson = generateResponseToChatCompletion(gemini, model);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        stream: Readable.from([Buffer.from(JSON.stringify(chatJson), 'utf8')]),
        socket: upstream.socket || null,
      };
    }

    // ---- 非成功状态：按类别冷却账号并换下一个账号 ----
    // rawHttpsRequest（非流）返回缓冲形态 {status, headers, bodyText}；流式才有 stream。
    // 换端点时已把错误体快照挂到 _errorSnippet（此时流仍可读），此处优先取快照——
    // 兜底 readAll 对已销毁流会立即抛 ERR_STREAM_PREMATURE_CLOSE 导致错误信息全空（审查 ✗8）。
    const snippet = typeof upstream.bodyText === 'string'
      ? upstream.bodyText
      : (upstream._errorSnippet || await readAll(upstream.stream).catch(() => ''));
    let message = snippet.slice(0, 300);
    try {
      const parsed = JSON.parse(snippet);
      // codeassist 错误体可能是 [{error:{message,...}}] 数组或 {error:{...}} 对象
      const errObj = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
      message = errObj?.message || parsed?.message || errObj?.status || message;
    } catch { /* 非 JSON 错误体用原文 */ }
    if (upstream.status === 429) {
      // 上游 429 的真实原因有多种（分钟/日/周配额、账号暂时锁定），统一叫「分钟级」
      // 会误导（2026-09-02 实锤：账号日配额耗尽时全部模型同拒，用户被提示「等1分钟」
      // 白等）。把上游 message 关键词带进错误文案，区分恢复预期。
      const detail = String(message || '').slice(0, 160);
      const quotaKind = /daily|per[_ -]?day|日/i.test(detail) ? '日配额'
        : /weekly|per[_ -]?week|周/i.test(detail) ? '周配额'
        : '';
      const detailSuffix = quotaKind ? `（上游提示：${quotaKind}，需等重置或换账号，重试无效）`
        : (detail ? `（上游提示：${detail}）` : '');
      // 分钟级「账号×模型」配额：只冷却该账号的该模型 60s（其他模型/换号后照常），
      // 下一请求经选号循环自动优先走未受限的账号。日/周配额语义下 60s 冷却无害
      //（换号仍会发生；单账号池则每次都撞，错误文案已带正确预期）。
      coolModelAccount(account.id, upstreamModelName, 60_000);
      // 429 诊断捕获：每「账号×模型」60s 内只写一次（冷却期内重试本来就会被跳过，
      // 防御性节流），异步写不阻塞请求，尺寸上限 2MB，路径相对 cwd（随仓库走）。
      try {
        if (!modelAccountCooldown.get(`429cap|${account.id}|${upstreamModelName}`)) {
          modelAccountCooldown.set(`429cap|${account.id}|${upstreamModelName}`, Date.now() + 60_000);
          const payload = JSON.stringify({ ts: new Date().toISOString(), account: account.id, model: upstreamModelName, upstreamMessage: detail, outerBody: JSON.parse(outerBody) });
          if (payload.length <= 2 * 1024 * 1024) {
            fs.promises.writeFile('data/google-429-capture.json', payload).catch(() => {});
          }
        }
      } catch { /* 诊断旁路 */ }
      recordGoogle429(upstreamModelName, account.id, bodyBytesEstimate);
      const oversizeHint = bodyBytesEstimate >= OVERSIZED_429_MIN_BYTES
        ? `；请求体 ${(bodyBytesEstimate / 1048576).toFixed(2)}MB 偏大，若连续 429 请直接换模型或精简上下文`
        : '';
      noteFailure(429, `${model} 谷歌配额限制${detailSuffix}${oversizeHint}（已自动尝试 ${triedAccounts.size} 个账号）${quotaKind ? '' : '，约 1 分钟后自动恢复，或临时换用其他模型'}`);
      continue;
    }
    if (upstream.status === 403) {
      // 该账号无 Antigravity 使用许可（如 Free 套餐）：长冷却避免反复撞墙
      authManager.markCooldown?.(account.id, 30 * 60_000);
      noteFailure(403, `账号 ${account.email || account.id} 无该模型使用许可：${message.slice(0, 120)}`);
      continue;
    }
    if (upstream.status === 401) {
      authManager.markCooldown?.(account.id, 60 * 60_000);
      noteFailure(401, `账号 ${account.email || account.id} 凭据被拒，请重新授权：${message.slice(0, 120)}`);
      continue;
    }
    // 400/其他：不换账号（同模型结果一致），直接返回
    noteFailure(upstream.status, message);
    return errorResponse(upstream.status, message);
  }

  if (bestFailure) {
    return errorResponse(bestFailure.status, bestFailure.message);
  }
  // 池里其实有账号、但对该模型全部不可用/冷却中：按账号实际状态给出可等待指引
  const googleAccounts = authManager?.listAccounts?.('google') || [];
  if (googleAccounts.length > 0) {
    const now = Date.now();
    const recovering = googleAccounts.filter((acc) => acc.status !== 'cooldown' || Number(acc.cooldownUntil || 0) <= now);
    if (recovering.length > 0) {
      // 有账号即将恢复（如请求被客户端中途取消）——通用冷却文案
      return errorResponse(503, '所有谷歌订阅账号都在限流冷却中（分钟级配额，通常约 1 分钟内自动恢复），稍候重试即可');
    }
    return errorResponse(503, '所有谷歌订阅账号都处于冷却中（限流约 1 分钟恢复；无许可/凭据问题的账号冷却更长），请稍后重试或在订阅页检查账号状态');
  }
  return errorResponse(503, '没有可用的谷歌订阅账号（未绑定或全部冷却中）');
}

async function readAll(stream) {
  if (!stream) return '';
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
