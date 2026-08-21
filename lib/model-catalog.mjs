import fs from 'node:fs';

const DEFAULT_MAX_CATALOG_BYTES = 16 * 1024 * 1024;

// 模型目录的纯变换集中在这里；文件适配器只负责有界读取和原子替换。

export function applyModelContextToCatalog(catalog, modelContext) {
  const nextCatalog = structuredClone(catalog);
  if (!modelContext || modelContext.enabled === false) {
    return { catalog: nextCatalog, changed: false };
  }

  let changed = false;
  const slugs = modelContext.slugs || [];
  for (const model of nextCatalog.models || []) {
    if (slugs.length > 0 && !slugs.includes(model.slug)) continue;
    if (modelContext.contextWindow && model.context_window !== modelContext.contextWindow) {
      model.context_window = modelContext.contextWindow;
      changed = true;
    }
    if (modelContext.contextWindow && model.max_context_window !== modelContext.contextWindow) {
      model.max_context_window = modelContext.contextWindow;
      changed = true;
    }
    if (
      modelContext.autoCompactTokenLimit !== undefined
      && model.auto_compact_token_limit !== modelContext.autoCompactTokenLimit
    ) {
      model.auto_compact_token_limit = modelContext.autoCompactTokenLimit;
      changed = true;
    }
  }

  return { catalog: nextCatalog, changed };
}

export function buildModelList(catalog, supportsResponses) {
  const responseSlugs = supportsResponses?.slugs || [];
  return catalog.models.map((model) => {
    const item = {
      id: model.slug,
      object: 'model',
      created: 0,
      owned_by: 'local-router',
    };
    // 对外只声明能力子集；previous_response_id / parallel_tool_calls 是桌面端决定
    // 「链式增量续聊还是每轮全量重发」的关键信号——不声明会全量重发整个对话，
    // 同一任务的周额度消耗成倍放大（直连官方无此开销）。
    if (responseSlugs.includes(model.slug)) {
      item.capabilities = {
        streaming: true,
        previous_response_id: true,
        parallel_tool_calls: true,
      };
    }
    return item;
  });
}

export function readModelCatalogFile(catalogPath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CATALOG_BYTES;
  const stat = fileSystem.statSync(catalogPath);
  if (stat.size > maxBytes) throw new Error('模型目录文件超过大小上限');

  const bytes = fileSystem.readFileSync(catalogPath);
  if (bytes.length > maxBytes) throw new Error('模型目录文件超过大小上限');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

export function updateModelCatalogFile(catalogPath, modelContext, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const catalog = readModelCatalogFile(catalogPath, { ...options, fileSystem });
  const result = applyModelContextToCatalog(catalog, modelContext);
  if (!result.changed) return result;

  const tempPath = `${catalogPath}.tmp`;
  fileSystem.writeFileSync(tempPath, JSON.stringify(result.catalog, null, 2));
  fileSystem.renameSync(tempPath, catalogPath);
  return result;
}
