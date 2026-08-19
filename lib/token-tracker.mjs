import fs from 'node:fs';
import path from 'node:path';

function getHourSlot(timestamp) {
  const date = new Date(timestamp);
  date.setMinutes(0, 0, 0);
  return date.toISOString().slice(0, 13) + ':00:00.000Z';
}

export function createTokenTracker(options = {}) {
  const now = options.now || (() => Date.now());
  const storagePath = options.storagePath || null;
  const autoSaveIntervalMs = options.autoSaveIntervalMs || 60000;
  // 持久化钩子：每条真实使用记录同步转交（如写入 SQLite token_logs 供 Dashboard 统计）；
  // 失败必须静默，统计旁路不得影响路由请求。
  const onRecord = typeof options.onRecord === 'function' ? options.onRecord : null;

  // 全局汇总统计
  const globalSummary = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    totalDurationMs: 0,
  };

  // 模型维度统计 Map<modelName, ModelStats>
  const modelStats = new Map();

  // 时间线统计 Map<hourIsoString, HourStats>
  const timelineStats = new Map();

  function recordUsage(entry) {
    if (!entry || typeof entry !== 'object') return;

    const model = typeof entry.model === 'string' && entry.model ? entry.model : 'unknown';
    const targetId = typeof entry.targetId === 'string' && entry.targetId
      ? entry.targetId
      : (typeof entry.target === 'string' && entry.target ? entry.target : 'default');
    // 兼容两种入参：扁平字段（inputTokens…）与 OpenAI usage 对象（input_tokens…）。
    const raw = entry.usage && typeof entry.usage === 'object' ? entry.usage : entry;
    const toCount = (...candidates) => {
      for (const candidate of candidates) {
        const value = Math.max(0, Number(candidate));
        if (Number.isFinite(value) && value > 0) return value;
      }
      return 0;
    };
    // 兼容 OpenAI 标准 usage（prompt_tokens/completion_tokens）与 Responses 风格字段
    const input = toCount(raw.inputTokens, raw.input_tokens, raw.prompt_tokens);
    const output = toCount(raw.outputTokens, raw.output_tokens, raw.completion_tokens);
    const reasoning = toCount(
      raw.reasoningTokens,
      raw.reasoning_tokens,
      raw.output_tokens_details?.reasoning_tokens,
    );
    const cached = toCount(
      raw.cachedTokens,
      raw.cached_tokens,
      raw.input_tokens_details?.cached_tokens,
    );
    const total = input + output;
    const duration = Math.max(0, Number(entry.durationMs) || 0);
    const isSuccess = entry.success !== false;
    const ts = Number(entry.timestamp) || now();

    // 1. 更新全局
    globalSummary.totalRequests += 1;
    if (isSuccess) {
      globalSummary.successfulRequests += 1;
    } else {
      globalSummary.failedRequests += 1;
    }
    globalSummary.inputTokens += input;
    globalSummary.outputTokens += output;
    globalSummary.reasoningTokens += reasoning;
    globalSummary.cachedTokens += cached;
    globalSummary.totalTokens += total;
    globalSummary.totalDurationMs += duration;

    // 2. 更新模型维度明细
    let m = modelStats.get(model);
    if (!m) {
      m = {
        model,
        targetId,
        requests: 0,
        successCount: 0,
        failCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        lastActiveAt: ts,
      };
      modelStats.set(model, m);
    }

    m.requests += 1;
    if (isSuccess) {
      m.successCount += 1;
    } else {
      m.failCount += 1;
    }
    m.inputTokens += input;
    m.outputTokens += output;
    m.reasoningTokens += reasoning;
    m.cachedTokens += cached;
    m.totalTokens += total;
    m.totalDurationMs += duration;
    m.avgDurationMs = Math.round(m.totalDurationMs / m.requests);
    m.lastActiveAt = Math.max(m.lastActiveAt || 0, ts);

    // 3. 更新时间线槽位
    const hourSlot = getHourSlot(ts);
    let t = timelineStats.get(hourSlot);
    if (!t) {
      t = {
        slot: hourSlot,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
      };
      timelineStats.set(hourSlot, t);
    }
    t.requests += 1;
    t.inputTokens += input;
    t.outputTokens += output;
    t.reasoningTokens += reasoning;
    t.cachedTokens += cached;
    t.totalTokens += total;

    if (onRecord) {
      try {
        onRecord({
          timestamp: ts,
          model,
          target: targetId,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: reasoning,
          cachedTokens: cached,
          totalTokens: total,
          durationMs: duration,
          isError: !isSuccess,
        });
      } catch { /* 落库失败不影响统计与请求 */ }
    }
  }

  function getSummary() {
    return {
      ...globalSummary,
      avgDurationMs: globalSummary.totalRequests > 0
        ? Math.round(globalSummary.totalDurationMs / globalSummary.totalRequests)
        : 0,
    };
  }

  function getModelBreakdown() {
    return Array.from(modelStats.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  }

  function getTimeline(query = {}) {
    const hours = Math.max(1, Math.min(168, Number(query.hours) || 24));
    const list = Array.from(timelineStats.values()).sort((a, b) => a.slot.localeCompare(b.slot));
    if (list.length <= hours) return list;
    return list.slice(-hours);
  }

  function exportState() {
    return {
      version: 1,
      updatedAt: now(),
      summary: getSummary(),
      models: getModelBreakdown(),
      timeline: Array.from(timelineStats.values()),
    };
  }

  function importState(state) {
    if (!state || typeof state !== 'object') return;
    if (state.summary) {
      Object.assign(globalSummary, state.summary);
    }
    if (Array.isArray(state.models)) {
      modelStats.clear();
      for (const item of state.models) {
        if (item && item.model) {
          modelStats.set(item.model, { ...item });
        }
      }
    }
    if (Array.isArray(state.timeline)) {
      timelineStats.clear();
      for (const item of state.timeline) {
        if (item && item.slot) {
          timelineStats.set(item.slot, { ...item });
        }
      }
    }
  }

  function saveToDisk() {
    if (!storagePath) return;
    try {
      const data = JSON.stringify(exportState(), null, 2);
      const tmpPath = `${storagePath}.tmp.${Date.now()}`;
      fs.mkdirSync(path.dirname(storagePath), { recursive: true });
      fs.writeFileSync(tmpPath, data, 'utf-8');
      fs.renameSync(tmpPath, storagePath);
    } catch {
      // 容错：写盘失败不阻断内存计数
    }
  }

  function loadFromDisk() {
    if (!storagePath) return;
    try {
      if (fs.existsSync(storagePath)) {
        const text = fs.readFileSync(storagePath, 'utf-8');
        importState(JSON.parse(text));
      }
    } catch {
      // 容错：读盘失败从空状态开始
    }
  }

  // 初始化加载
  if (storagePath) {
    loadFromDisk();
  }

  function reset() {
    globalSummary.totalRequests = 0;
    globalSummary.successfulRequests = 0;
    globalSummary.failedRequests = 0;
    globalSummary.inputTokens = 0;
    globalSummary.outputTokens = 0;
    globalSummary.reasoningTokens = 0;
    globalSummary.cachedTokens = 0;
    globalSummary.totalTokens = 0;
    globalSummary.totalDurationMs = 0;
    modelStats.clear();
    timelineStats.clear();
    saveToDisk();
  }

  return {
    recordUsage,
    getSummary,
    getModelBreakdown,
    getTimeline,
    exportState,
    importState,
    saveToDisk,
    loadFromDisk,
    reset,
  };
}
