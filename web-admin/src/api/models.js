import request from './request.js';

export function getModelRouting(config = {}) {
  return request({
    url: '/model-routing',
    method: 'get',
    ...config,
  });
}

export function getModels(config = {}) {
  return request({
    url: '/models',
    method: 'get',
    ...config,
  });
}

export function testModelLatency(model, targetName) {
  return request({
    url: '/models/test',
    method: 'post',
    data: { model, targetName },
    // 真实探测要等上游响应头，思考型模型 TTFT 可能超过默认超时
    timeout: 35_000,
  });
}

/**
 * 联合模型路由事务：读取当前双文件 revision → 预检（必要时携带确认令牌）→ 提交。
 * model.* / target.* 全部共用这一条写入路径（通道/模型动态管理）。
 */
export async function commitModelOperations(operations) {
  const state = await request({ url: '/model-routing', method: 'get' });
  const payload = {
    configRevision: state.configRevision,
    catalogRevision: state.catalogRevision,
    operations,
  };
  const validated = await request({
    url: '/model-routing/validate',
    method: 'post',
    data: payload,
  });
  if (validated.confirmation) {
    // 后端返回 { token, expiresAt } 对象；契约要求字符串 token
    payload.confirmation = typeof validated.confirmation === 'string'
      ? validated.confirmation
      : validated.confirmation.token;
  }
  return request({
    url: '/model-routing',
    method: 'put',
    data: payload,
  });
}

export function createModel(modelData) {
  return commitModelOperations([{
    kind: 'model.create',
    model: {
      slug: modelData.slug,
      display_name: modelData.display_name || modelData.slug,
      input_modalities: modelData.input_modalities || ['text'],
    },
  }]);
}

/**
 * 自动拉取：从目标通道的上游接口获取全部可用模型列表。
 * 错误提示由调用方（弹窗内 Alert）呈现，需传 skipGlobalError: true。
 */
export function fetchTargetModels(targetName, config = {}) {
  return request({
    url: '/targets/fetch-models',
    method: 'post',
    data: { targetName },
    // 上游列表接口可能较慢（尤其代理通道），放宽超时
    timeout: 30_000,
    ...config,
  });
}

/** 批量写入勾选的模型（单次联合事务，共享同一对 revision）。 */
export function createModels(slugs) {
  return commitModelOperations(slugs.map((slug) => ({
    kind: 'model.create',
    model: {
      slug,
      display_name: slug,
      input_modalities: ['text'],
    },
  })));
}

/**
 * 更新模型条目。patch 只允许 catalog 模型字段
 * （slug 重命名 / display_name / description / input_modalities /
 *   default_reasoning_level / context_window 等）。
 */
export function updateModel(slug, patch) {
  return commitModelOperations([{ kind: 'model.update', slug, patch }]);
}

export function deleteModel(slug) {
  return commitModelOperations([{ kind: 'model.delete', slug }]);
}

// 模型显示名批量加/去平台前缀（走双文件联合事务）
// 通道连通性测试（已保存配置或编辑中表单配置，真实请求上游 /models）
export function testTargetConnection(data) {
  return request({
    url: '/targets/test',
    method: 'post',
    data,
    timeout: 35_000,
  });
}

export function prefixModelPlatform(mode) {
  return request({
    url: '/models/prefix-platform',
    method: 'post',
    data: { mode },
  });
}
