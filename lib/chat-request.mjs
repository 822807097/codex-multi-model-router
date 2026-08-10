import {
  convertResponsesTools,
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
      viaProxy: target.viaProxy,
      proxy: options.proxy,
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

  async function buildChatRequest(attemptBody, target, provider, model, context) {
    const converted = convertResponsesTools(attemptBody.tools, attemptBody.input);
    const baseRequest = {
      model: upstreamModel(target, model),
      messages: responsesToChatMessages(attemptBody.input, {
        autonomy: config.chatConversion?.autonomy,
        instructions: attemptBody.instructions,
        vision: target.vision !== false,
        toolContext: converted.context,
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
    if (settings.enabled && baseline.trimmedGroups > 0) {
      const reserved = fitMessagesToContext(baseRequest.messages, converted.tools, capability, {
        reserveTokens: settings.maxOutputTokens,
      });
      if (reserved.fits) {
        const previousCheckpoint = taskKey ? goalCheckpoints.getTask(taskKey) : null;
        const source = buildCheckpointSource({
          goalAnchor: extractGoalAnchor(attemptBody),
          previousCheckpoint,
          removedMessages: reserved.removedMessages,
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
            flog(`CHECKPOINT ${model} | provider=${target.name} | source_tokens=${source.estimatedTokens} | chars=${checkpoint.length}`);
          } catch (error) {
            if (context.signal?.aborted || error?.name === 'AbortError') throw error;
            checkpoint = previousCheckpoint;
            persistCheckpoint = false;
            flog(`CHECKPOINT_FALLBACK ${model} | provider=${target.name} | ${error.code || error.message}`);
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
          }
        }
      }
    }

    baseRequest.messages = fitted.messages;
    if (fitted.trimmedGroups > 0) {
      flog(`TRIM ${model} | groups=${fitted.trimmedGroups} | tokens=${fitted.messageTokens}/${fitted.messageBudget}`);
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
