import {
  compactSeenDataImages,
  convertResponsesTools,
  planToolCycleCompaction,
  responsesToChatMessages,
} from './chat-protocol.mjs';
import { fitMessagesToContext, resolveModelCapability } from './context-budget.mjs';
import {
  buildCheckpointMessages,
  buildCheckpointSource,
  extractCheckpointText,
  extractGoalAnchor,
  normalizeCheckpoint,
} from './goal-checkpoint.mjs';
import {
  applyCheckpointProviderOptions,
  applyChatProviderOptions,
} from './provider-adapters.mjs';

export function upstreamModel(target, requestedModel) {
  return target.modelMap?.[requestedModel]
    || target.upstreamModel
    || target.model
    || requestedModel;
}

function joinUpstreamPath(prefix = '', endpoint = '') {
  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${left}${right}` || '/';
}

function statusFailure(status, message) {
  const error = new Error(message);
  error.status = status;
  error.code = String(status || 502);
  return error;
}

export function createChatRequestBuilder(options) {
  const config = options.config;
  const goalCheckpoints = options.goalCheckpoints;
  const flog = options.flog || (() => {});

  function checkpointConfig(capability) {
    const configured = config.goalCheckpoint || {};
    return {
      enabled: configured.enabled !== false,
      maxOutputTokens: Math.max(256, Number(configured.maxOutputTokens) || 2_048),
      requestMs: Math.max(1_000, Number(configured.requestMs) || 120_000),
      sourceTokenBudget: Math.max(128, Math.min(
        Number(configured.sourceTokenBudget) || 128_000,
        Math.floor(capability.contextWindow * (Number(configured.sourceWindowRatio) || 0.2)),
      )),
    };
  }

  function injectCheckpoint(messages, checkpoint) {
    // 检查点属于低优先级 assistant 历史，必须位于原始系统指令之后。
    let cursor = 0;
    while (cursor < messages.length && messages[cursor]?.role === 'system') cursor += 1;
    return [
      ...messages.slice(0, cursor),
      { role: 'assistant', content: checkpoint },
      ...messages.slice(cursor),
    ];
  }

  async function requestCheckpoint(target, provider, model, headers, source, context, settings) {
    const requestBody = applyCheckpointProviderOptions({
      model: upstreamModel(target, model),
      messages: buildCheckpointMessages(source),
      stream: false,
      temperature: 0,
      [provider.maxTokensField]: settings.maxOutputTokens,
    }, provider);
    const response = await options.request({
      protocol: target.protocol,
      host: target.host,
      port: target.port || (target.protocol === 'http' ? 80 : 443),
      path: joinUpstreamPath(target.prefix, provider.chatPath),
      viaProxy: target.viaProxy === true || Boolean(target.proxyUrl),
      proxy: target.proxyUrl || options.proxy,
      headers: { ...headers, accept: 'application/json' },
      body: JSON.stringify(requestBody),
      signal: context.signal,
      timeouts: { ...context.timeouts, requestMs: settings.requestMs },
      maxResponseBytes: 256 * 1024,
    });
    if (response.status !== 200) {
      throw statusFailure(response.status || 502, `checkpoint upstream ${response.status || 502}`);
    }
    let parsed;
    try { parsed = JSON.parse(response.bodyText); } catch {
      throw new Error('checkpoint upstream returned non-JSON body');
    }
    const text = extractCheckpointText(parsed);
    if (!text) throw new Error('checkpoint upstream returned empty content');
    return normalizeCheckpoint(text, settings.maxOutputTokens);
  }

  // 官方→第三方续接的子代理任务清洗：见 buildChatRequest 内调用点注释。
const AGENT_MESSAGE_TOOL_RE = /^(spawn_agent|followup_task|send_message)$/;
const ENCRYPTED_AGENT_MESSAGE_PLACEHOLDER =
  '（此任务的原始文本在上一官方会话中是加密块，无法解密恢复。请忽略占位，直接用明文重新向子代理下发完整、明确、可独立执行的任务指令。）';

function sanitizeEncryptedAgentMessages(input) {
  let count = 0;
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type !== 'function_call' || !AGENT_MESSAGE_TOOL_RE.test(item.name || '')) continue;
    if (typeof item.arguments !== 'string' || !item.arguments.includes('gAAAA')) continue;
    try {
      const args = JSON.parse(item.arguments);
      if (typeof args.message === 'string' && args.message.startsWith('gAAAA')) {
        args.message = ENCRYPTED_AGENT_MESSAGE_PLACEHOLDER;
        item.arguments = JSON.stringify(args);
        count += 1;
      }
    } catch { /* 参数非合法 JSON 时保持原样，交由既有校验链处理 */ }
  }
  return count;
}

async function buildChatRequest(attemptBody, target, provider, model, context) {
    const compactedInput = compactSeenDataImages(attemptBody.input);
    if (compactedInput !== attemptBody.input) {
      flog({
        event: 'context.images.compacted',
        request_id: context.requestId,
        model,
        target: target.name,
        wire_api: 'chat',
      });
    }
    // 官方会话续接第三方模型时，历史里官方调用的 spawn_agent/followup_task/send_message
    // 携带加密 message（gAAAA…，桌面端与官方间加密）。第三方模型看到样例会照葫芦画瓢
    // 输出无效加密串，子代理解不开 →「没有收到具体任务指令」→ 误判 fork 机制不可靠
    // （2026-09-03 实锤）。替换为明文占位，让模型用明文重新下发任务。
    const sanitizedAgentCalls = sanitizeEncryptedAgentMessages(compactedInput);
    if (sanitizedAgentCalls > 0) {
      flog({
        event: 'chat.encrypted_agent_message_sanitized',
        request_id: context.requestId,
        model,
        target: target.name,
        count: sanitizedAgentCalls,
      });
    }
    const converted = convertResponsesTools(attemptBody.tools, compactedInput, {
      // 特殊工具（web_search/computer_use/mcp_read 等无 function 名称）无法进 chat 通道：
      // 丢弃可见化，便于发现「目录声明的能力与实际转发不符」。
      onDrop: ({ type }) => flog({
        event: 'chat.dropped_tool',
        request_id: context.requestId,
        model,
        target: target.name,
        tool_type: type,
      }),
    });
    const baseRequest = {
      model: upstreamModel(target, model),
      messages: responsesToChatMessages(compactedInput, {
        autonomy: config.chatConversion?.autonomy,
        instructions: attemptBody.instructions,
        vision: target.vision !== false,
        toolContext: converted.context,
        onNormalize: (info) => flog({
          event: `chat.${info.event}`,
          request_id: context.requestId,
          model,
          target: target.name,
          ...(info.item_type ? { item_type: info.item_type } : {}),
          ...(info.id_prefix ? { id_prefix: info.id_prefix } : {}),
          ...(info.moved_outputs !== undefined ? { moved_outputs: info.moved_outputs } : {}),
        }),
      }),
    };
    if (converted.tools) baseRequest.tools = converted.tools;

    const capability = resolveModelCapability(config, target, model);
    const baseline = fitMessagesToContext(baseRequest.messages, converted.tools, capability);
    if (!baseline.fits) {
      const error = new Error(
        `最新轮次超过模型输入预算 (${baseline.messageTokens} > ${baseline.messageBudget} tokens)`,
      );
      error.code = 'context_length_exceeded';
      throw error;
    }

    let fitted = baseline;
    let checkpointInfo = null;
    const taskKey = context.taskKey || null;
    const requestSequence = context.requestSequence ?? null;
    const settings = checkpointConfig(capability);
    const cyclePlan = settings.enabled
      ? planToolCycleCompaction(baseRequest.messages)
      : { messages: baseRequest.messages, removedMessages: [], compactedCycles: 0 };
    const needsCheckpoint = cyclePlan.compactedCycles > 0 || baseline.trimmedGroups > 0;
    if (settings.enabled && needsCheckpoint) {
      const reserved = fitMessagesToContext(cyclePlan.messages, converted.tools, capability, {
        reserveTokens: settings.maxOutputTokens,
      });
      if (reserved.fits) {
        const previousCheckpoint = taskKey ? goalCheckpoints.getTask(taskKey) : null;
        const removed = new Set([
          ...cyclePlan.removedMessages,
          ...reserved.removedMessages,
        ]);
        const source = buildCheckpointSource({
          goalAnchor: extractGoalAnchor(attemptBody),
          previousCheckpoint,
          removedMessages: baseRequest.messages.filter((message) => removed.has(message)),
          tokenBudget: settings.sourceTokenBudget,
        });
        const exactKey = JSON.stringify([
          target.name,
          target.protocol || 'https',
          `${target.host}:${target.port || (target.protocol === 'http' ? 80 : 443)}`,
          target.prefix || '',
          provider.chatPath,
          upstreamModel(target, model),
          source.hash,
        ]);
        let checkpoint = goalCheckpoints.getExact(exactKey);
        let persistCheckpoint = Boolean(checkpoint);
        if (!checkpoint) {
          try {
            checkpoint = await requestCheckpoint(
              target,
              provider,
              model,
              context.headers,
              source,
              context,
              settings,
            );
            persistCheckpoint = true;
            flog({
              event: 'context.checkpoint.created',
              request_id: context.requestId,
              model,
              target: target.name,
              wire_api: 'chat',
              source_tokens: source.estimatedTokens,
              chars: checkpoint.length,
            });
          } catch (error) {
            if (context.signal?.aborted || error?.name === 'AbortError') throw error;
            // 旧检查点不包含本轮新移除的工具周期；主动压缩失败时必须回退完整基线。
            checkpoint = cyclePlan.compactedCycles > 0 ? null : previousCheckpoint;
            persistCheckpoint = false;
            flog({
              event: 'context.checkpoint.fallback',
              request_id: context.requestId,
              model,
              target: target.name,
              wire_api: 'chat',
              error_code: error.code || 'checkpoint_failed',
              error_stage: 'checkpoint_request',
            });
          }
        }
        if (checkpoint) {
          const withCheckpoint = injectCheckpoint(reserved.messages, checkpoint);
          const verified = fitMessagesToContext(withCheckpoint, converted.tools, capability);
          if (verified.fits && verified.messages.some((message) => message.content === checkpoint)) {
            fitted = verified;
            checkpointInfo = {
              taskKey,
              exactKey,
              checkpoint,
              persistCheckpoint,
              requestSequence,
            };
            if (cyclePlan.compactedCycles > 0) {
              flog({
                event: 'context.tool_cycles.compacted',
                request_id: context.requestId,
                model,
                target: target.name,
                wire_api: 'chat',
                cycles: cyclePlan.compactedCycles,
              });
            }
          }
        }
      }
    }

    baseRequest.messages = fitted.messages;
    if (fitted.trimmedGroups > 0) {
      flog({
        event: 'context.trimmed',
        request_id: context.requestId,
        model,
        target: target.name,
        wire_api: 'chat',
        groups: fitted.trimmedGroups,
        tokens: fitted.messageTokens,
        budget: fitted.messageBudget,
      });
    }
    return {
      request: applyChatProviderOptions(baseRequest, attemptBody, provider, converted.context),
      toolContext: converted.context,
      toolCount: converted.tools?.length || 0,
      checkpointInfo,
    };
  }

  return { buildChatRequest };
}
