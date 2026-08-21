// Codex 桌面端接入管理：一键恢复官方直连 / 一键接入路由（含模型动态加载）。
// 读写 CODEX_HOME 下的 config.toml 与 models.json，所有覆盖前先做时间戳备份。
import fs from 'node:fs';
import path from 'node:path';

// 官方存量模型（恢复「官方直连」时仅保留这些；其余为路由自定义/第三方模型）。
export const OFFICIAL_MODEL_SLUGS = Object.freeze([
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2',
  'codex-auto-review',
]);

export function filterOfficialModels(catalogEntries) {
  return catalogEntries.filter((entry) => OFFICIAL_MODEL_SLUGS.includes(entry.slug));
}

export function selectModels(catalogEntries, slugs) {
  const list = Array.isArray(slugs) ? slugs : [];
  const wanted = new Set(list.map((slug) => String(slug)));
  return catalogEntries.filter((entry) => wanted.has(entry.slug));
}

// 桌面端目录安全校验（2026-08 实锤的必填：supported_in_api / priority / base_instructions 等）
export function assertDesktopSafeModels(entries) {
  for (const entry of entries) {
    if (!entry || typeof entry.slug !== 'string' || !entry.slug) {
      throw new Error('模型条目缺少 slug');
    }
    if (typeof entry.display_name !== 'string' || !entry.display_name) {
      throw new Error(`${entry.slug}: display_name 必填`);
    }
    if (typeof entry.supported_in_api !== 'boolean') {
      throw new Error(`${entry.slug}: supported_in_api 缺失（桌面端必填布尔）`);
    }
    if (!Number.isSafeInteger(entry.priority) || entry.priority < 0) {
      throw new Error(`${entry.slug}: priority 缺失（桌面端必填非负整数）`);
    }
    if (typeof entry.base_instructions !== 'string' || !entry.base_instructions.trim()) {
      throw new Error(`${entry.slug}: base_instructions 缺失（桌面端必填）`);
    }
  }
}

// 官方直连的 config.toml：不声明任何 model_providers，桌面端走内置 OpenAI 官方通道。
export function buildOfficialConfigToml(defaultModel = 'gpt-5.6-sol') {
  return `model = "${defaultModel}"\n`;
}

// 接入路由的 config.toml：路由作为唯一 provider（本机回环，开放直连；wire_api=responses）。
export function buildRouterConfigToml(defaultModel = 'gpt-5.6-sol') {
  return [
    `model = "${defaultModel}"`,
    '',
    '[model_providers.router]',
    'name = "LocalRouter"',
    'base_url = "http://127.0.0.1:15730/v1"',
    'wire_api = "responses"',
    '',
  ].join('\n');
}

export function parseConfigTomlModel(content) {
  const match = /^model\s*=\s*"([^"]+)"/m.exec(String(content || ''));
  return match ? match[1] : '';
}

export function detectAccessMode(tomlContent, modelSlugs) {
  if (String(tomlContent || '').includes('model_providers.router')) return 'router';
  const custom = (modelSlugs || []).some((slug) => !OFFICIAL_MODEL_SLUGS.includes(slug));
  return custom ? 'router' : 'official';
}

export function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 原子写入（先写 .tmp 再 rename），任一覆盖前都备份成 <file>.bak-<UTCts>。
 * @returns {string|null} 备份文件路径（不存在原文件时返回 null）
 */
export function writeWithBackup(filePath, content) {
  const backup = fs.existsSync(filePath)
    ? `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    : null;
  if (backup) fs.copyFileSync(filePath, backup);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
  return backup;
}

/** 组装最终 models.json（保留原文件全部既有字段，仅按规则筛选条目）。 */
export function buildModelsJson(entries) {
  const sorted = [...entries].sort((a, b) => {
    const pa = Number.isSafeInteger(a.priority) ? a.priority : 0;
    const pb = Number.isSafeInteger(b.priority) ? b.priority : 0;
    return pa - pb;
  });
  return `${JSON.stringify({ models: sorted }, null, 2)}\n`;
}

export function resolveDesktopPaths(codexHome) {
  const home = codexHome || process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex');
  return {
    configToml: path.join(home, 'config.toml'),
    modelsJson: path.join(home, 'models.json'),
  };
}