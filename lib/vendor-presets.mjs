// ---------- 厂商预设库（cc-switch 式多厂商支持） ----------
// 数据形态对齐 cc-switch codexProviderPresets，但只保留本路由需要的最小字段：
// base_url 拆分（host/prefix/protocol/port）、wireApi、套餐/额度类型标注、默认模型清单、默认 match。
// 模型清单为人工维护的写死默认值（供「一键接入」直接写 catalog，cc-switch 同法），
// 接入后随时可用「自动拉取模型」从上游 /models 覆盖。
// Claude / Gemini 不设 API-key 预设：路由 targets 只支持 OpenAI 兼容 chat/responses，
// 其订阅额度已走 OAuth 一键授权（lib/auth/*），API-key 直连属后续工作。
// 安全约束：本文件不含任何真实凭据；密钥一律经密钥池（DB 明文/env_ref 注册表）注入。

export const VENDOR_PRESETS = [
  // ---------- 国内官方 ----------
  {
    id: 'deepseek',
    name: 'DeepSeek',
    category: 'cn_official',
    planLabel: 'API 按量计费',
    quotaWindow: null,
    host: 'api.deepseek.com',
    // 与既有 deepseek-chat 通道同 host+prefix（''），去重命中只追加 key，不重建通道
    prefix: '',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^deepseek-',
    websiteUrl: 'https://platform.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { slug: 'deepseek-v4-flash', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'deepseek-v4-pro', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'deepseek-chat', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'deepseek-reasoner', contextWindow: 131072, defaultReasoningLevel: 'high' },
    ],
  },
  {
    id: 'zhipu-glm',
    name: '智谱 GLM（Coding Plan）',
    category: 'cn_official',
    planLabel: 'GLM Coding Plan 订阅（周额度）',
    quotaWindow: 'weekly',
    host: 'open.bigmodel.cn',
    prefix: '/api/coding/paas/v4',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^glm-',
    websiteUrl: 'https://open.bigmodel.cn',
    apiKeyUrl: 'https://www.bigmodel.cn/claude-code',
    models: [
      { slug: 'glm-5.3', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'glm-5.2', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'glm-5.1', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'glm-5.1-flash', contextWindow: 131072, defaultReasoningLevel: 'low' },
    ],
  },
  {
    id: 'zhipu-glm-api',
    name: '智谱 GLM（开放平台 API）',
    category: 'cn_official',
    planLabel: '智谱开放平台 API（按量计费，需 API Key）',
    quotaWindow: 'paygo',
    host: 'open.bigmodel.cn',
    prefix: '/api/paas/v4',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^glm-',
    websiteUrl: 'https://open.bigmodel.cn',
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [
      { slug: 'glm-5.3', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'glm-5.2', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'glm-5.1', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'glm-5.1-flash', contextWindow: 131072, defaultReasoningLevel: 'low' },
    ],
  },
  {
    id: 'bailian',
    name: '通义百炼',
    category: 'cn_official',
    planLabel: '百炼 token-plan 套餐（5 小时窗口）',
    quotaWindow: '5h',
    host: 'token-plan.cn-beijing.maas.aliyuncs.com',
    prefix: '/compatible-mode/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^qwen',
    websiteUrl: 'https://bailian.console.aliyun.com',
    apiKeyUrl: 'https://bailian.console.aliyun.com/#/api-key',
    models: [
      { slug: 'qwen3.8-max', contextWindow: 1000000, defaultReasoningLevel: 'high' },
      { slug: 'qwen3.7-max', contextWindow: 262144, defaultReasoningLevel: 'high' },
      { slug: 'qwen3.7-plus', contextWindow: 1000000, defaultReasoningLevel: 'high' },
      { slug: 'qwen3.6-plus', contextWindow: 1000000, defaultReasoningLevel: 'high' },
      { slug: 'qwen3-coder-plus', contextWindow: 262144, defaultReasoningLevel: 'high' },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi / Moonshot',
    category: 'cn_official',
    planLabel: 'Kimi For Coding 订阅（按套餐额度）',
    quotaWindow: null,
    host: 'api.moonshot.cn',
    prefix: '/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^kimi',
    websiteUrl: 'https://platform.kimi.com',
    apiKeyUrl: 'https://platform.kimi.com/console/api-keys',
    models: [
      { slug: 'kimi-k2.7-code', contextWindow: 200000, defaultReasoningLevel: 'high' },
      { slug: 'kimi-k2.6', contextWindow: 200000, defaultReasoningLevel: 'high' },
      { slug: 'kimi-k3', contextWindow: 200000, defaultReasoningLevel: 'high' },
      { slug: 'kimi-for-coding', contextWindow: 200000, defaultReasoningLevel: 'high' },
    ],
  },
  {
    id: 'doubao',
    name: '豆包 / 火山方舟',
    category: 'cn_official',
    planLabel: '火山方舟 API（按量）',
    quotaWindow: 'usage',
    host: 'ark.cn-beijing.volces.com',
    prefix: '/api/v3',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^doubao',
    websiteUrl: 'https://console.volcengine.com/ark',
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    models: [
      { slug: 'doubao-seed-2-1-pro-260628', contextWindow: 262144, defaultReasoningLevel: 'high' },
      { slug: 'doubao-seed-2-1-plus-260628', contextWindow: 262144, defaultReasoningLevel: 'high' },
      { slug: 'doubao-seed-2-1-flash-260628', contextWindow: 262144, defaultReasoningLevel: 'high' },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    category: 'cn_official',
    planLabel: 'MiniMax Coding Plan 订阅',
    quotaWindow: 'usage',
    host: 'api.minimaxi.com',
    prefix: '/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^minimax',
    websiteUrl: 'https://platform.minimaxi.com',
    apiKeyUrl: 'https://platform.minimaxi.com/subscribe/coding-plan',
    models: [
      { slug: 'MiniMax-M3', contextWindow: 1000000, defaultReasoningLevel: 'medium' },
      { slug: 'MiniMax-M2.5', contextWindow: 1000000, defaultReasoningLevel: 'medium' },
      { slug: 'Ling-2.6-1T', contextWindow: 1000000, defaultReasoningLevel: 'medium' },
    ],
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    category: 'cn_official',
    planLabel: '腾讯云 TokenHub（按量）',
    quotaWindow: 'usage',
    host: 'tokenhub.tencentmaas.com',
    prefix: '/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^hy3',
    websiteUrl: 'https://cloud.tencent.com/product/tokenhub',
    apiKeyUrl: 'https://console.cloud.tencent.com/tokenhub/apikey',
    models: [
      { slug: 'hy3', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'hy3-preview', contextWindow: 131072, defaultReasoningLevel: 'high' },
    ],
  },
  {
    id: 'qianfan',
    name: '百度千帆',
    category: 'cn_official',
    planLabel: '千帆 Token Plan 订阅',
    quotaWindow: 'usage',
    host: 'qianfan.baidubce.com',
    prefix: '/v2/tokenplan/personal',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^ernie-',
    websiteUrl: 'https://cloud.baidu.com/product/codingplan.html',
    apiKeyUrl: 'https://console.bce.baidu.com/qianfan/resource/token-plan',
    models: [
      { slug: 'ernie-5.1', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'ernie-5.1-turbo', contextWindow: 131072, defaultReasoningLevel: 'medium' },
    ],
  },
  {
    id: 'stepfun',
    name: '阶跃 StepFun',
    category: 'cn_official',
    planLabel: 'Step Plan 订阅',
    quotaWindow: 'usage',
    host: 'api.stepfun.com',
    prefix: '/step_plan/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^step-',
    websiteUrl: 'https://platform.stepfun.com/step-plan',
    apiKeyUrl: 'https://platform.stepfun.com/interface-key',
    models: [
      { slug: 'step-3.7-flash', contextWindow: 131072, defaultReasoningLevel: 'medium' },
      { slug: 'step-3.5-flash-2603', contextWindow: 131072, defaultReasoningLevel: 'medium' },
    ],
  },
  {
    id: 'xiaomi-mimo',
    name: '小米 MiMo',
    category: 'cn_official',
    planLabel: 'MiMo 平台 API（按量）',
    quotaWindow: 'usage',
    host: 'api.xiaomimimo.com',
    prefix: '/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^mimo-',
    websiteUrl: 'https://platform.xiaomimimo.com',
    apiKeyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
    models: [
      { slug: 'mimo-v2.5-pro', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'mimo-v2.5', contextWindow: 131072, defaultReasoningLevel: 'high' },
    ],
  },

  // ---------- 聚合网关 ----------
  {
    id: 'siliconflow',
    name: '硅基流动',
    category: 'aggregator',
    planLabel: '聚合网关（按量）',
    quotaWindow: 'usage',
    host: 'api.siliconflow.cn',
    prefix: '/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^(Pro/|zai-org/|deepseek-ai/)',
    websiteUrl: 'https://siliconflow.cn',
    apiKeyUrl: 'https://cloud.siliconflow.cn',
    models: [
      { slug: 'Pro/MiniMaxAI/MiniMax-M2.5', contextWindow: 1000000, defaultReasoningLevel: 'medium' },
      { slug: 'MiniMaxAI/MiniMax-M3', contextWindow: 1000000, defaultReasoningLevel: 'medium' },
      { slug: 'zai-org/glm-5.1', contextWindow: 131072, defaultReasoningLevel: 'high' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'aggregator',
    planLabel: '聚合网关（按量）',
    quotaWindow: 'usage',
    host: 'openrouter.ai',
    prefix: '/api/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^(deepseek/|openai/|anthropic/|google/)',
    websiteUrl: 'https://openrouter.ai',
    apiKeyUrl: 'https://openrouter.ai/keys',
    models: [
      { slug: 'deepseek/deepseek-v4-flash-0731', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'openai/gpt-5.6-sol', contextWindow: 278528, defaultReasoningLevel: 'low' },
      { slug: 'anthropic/claude-sonnet-4.5', contextWindow: 200000, defaultReasoningLevel: 'medium' },
    ],
  },

  // ---------- 国外官方 ----------
  {
    id: 'openai-api',
    name: 'OpenAI API',
    category: 'official',
    planLabel: 'OpenAI API（按量）',
    quotaWindow: 'usage',
    host: 'api.openai.com',
    prefix: '/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^gpt-',
    websiteUrl: 'https://platform.openai.com',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { slug: 'gpt-5.6-sol', contextWindow: 278528, defaultReasoningLevel: 'low' },
      { slug: 'gpt-5.6-terra', contextWindow: 278528, defaultReasoningLevel: 'low' },
      { slug: 'gpt-5.6-luna', contextWindow: 278528, defaultReasoningLevel: 'low' },
      { slug: 'gpt-5.5', contextWindow: 278528, defaultReasoningLevel: 'low' },
      { slug: 'gpt-5.4', contextWindow: 278528, defaultReasoningLevel: 'low' },
      { slug: 'gpt-5.4-mini', contextWindow: 131072, defaultReasoningLevel: 'low' },
    ],
  },
  {
    id: 'xai-grok',
    name: 'xAI (Grok)',
    category: 'official',
    planLabel: 'xAI API（按量）',
    quotaWindow: 'usage',
    host: 'api.x.ai',
    prefix: '/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^grok-(?!4\\.5$)',
    websiteUrl: 'https://x.ai/api',
    apiKeyUrl: 'https://console.x.ai',
    models: [
      { slug: 'grok-4.5', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'grok-4.5-mini', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'grok-3.5', contextWindow: 131072, defaultReasoningLevel: 'high' },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    category: 'official',
    planLabel: 'Mistral API（按量）',
    quotaWindow: 'usage',
    host: 'api.mistral.ai',
    prefix: '/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^(mistral|codestral|open-mistral)',
    websiteUrl: 'https://mistral.ai',
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
    models: [
      { slug: 'mistral-large-latest', contextWindow: 131072, defaultReasoningLevel: 'medium' },
      { slug: 'codestral-latest', contextWindow: 262144, defaultReasoningLevel: 'medium' },
      { slug: 'open-mistral-nemo', contextWindow: 131072, defaultReasoningLevel: 'low' },
    ],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    category: 'official',
    planLabel: 'NVIDIA NIM（按量）',
    quotaWindow: 'usage',
    host: 'integrate.api.nvidia.com',
    prefix: '/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    defaultMatch: '^(moonshotai/|deepseek-ai/|nvidia/)',
    websiteUrl: 'https://build.nvidia.com',
    apiKeyUrl: 'https://build.nvidia.com/settings/api-keys',
    models: [
      { slug: 'moonshotai/kimi-k2.7-code', contextWindow: 200000, defaultReasoningLevel: 'high' },
      { slug: 'deepseek-ai/deepseek-v4-pro', contextWindow: 131072, defaultReasoningLevel: 'high' },
      { slug: 'deepseek-ai/deepseek-v4-flash', contextWindow: 131072, defaultReasoningLevel: 'high' },
    ],
  },
];

export function getVendorPreset(id) {
  return VENDOR_PRESETS.find((preset) => preset.id === id) || null;
}

// 预设 → config targets[] 条目（密钥走池，不设 envKey）
export function buildTargetFromPreset(preset) {
  return {
    name: preset.id,
    host: preset.host,
    prefix: preset.prefix,
    protocol: preset.protocol || 'https',
    ...(preset.port ? { port: preset.port } : {}),
    wireApi: preset.wireApi || 'chat',
    match: preset.defaultMatch,
    // 密钥来自通道密钥池；预设接入不落 envKey
  };
}

// host+prefix 去重键：与既有 target 判重，命中则只入 key 池不重建
export function presetTargetKey(preset) {
  const protocol = preset.protocol || 'https';
  const port = preset.port ? `:${preset.port}` : '';
  const prefix = preset.prefix || '';
  return `${protocol}://${preset.host}${port}${prefix}`;
}

export function targetKeyOf(target) {
  const protocol = target.protocol || 'https';
  const port = target.port ? `:${target.port}` : '';
  const prefix = target.prefix || '';
  return `${protocol}://${target.host}${port}${prefix}`;
}

export function presetCategoryLabel(category) {
  return {
    official: '官方（国际）',
    cn_official: '国内官方',
    aggregator: '聚合网关',
  }[category] || category;
}
