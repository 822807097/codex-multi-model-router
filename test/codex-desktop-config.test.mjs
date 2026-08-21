import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OFFICIAL_MODEL_SLUGS,
  filterOfficialModels,
  selectModels,
  assertDesktopSafeModels,
  buildOfficialConfigToml,
  buildRouterConfigToml,
  parseConfigTomlModel,
  detectAccessMode,
  writeWithBackup,
  buildModelsJson,
} from '../lib/codex-desktop-config.mjs';

function entry(slug, extra = {}) {
  return {
    slug,
    display_name: slug,
    supported_in_api: true,
    priority: 1,
    base_instructions: `instructions for ${slug}`,
    description: '',
    experimental_supported_tools: [],
    ...extra,
  };
}

const CATALOG = [
  entry('gpt-5.6-sol', { priority: 0 }),
  entry('gpt-5.5'),
  entry('deepseek-v4-flash'),
  entry('cursor-grok-4.6'),
];

test('filterOfficialModels 只保留官方模型', () => {
  const official = filterOfficialModels(CATALOG);
  assert.deepEqual(official.map((e) => e.slug), ['gpt-5.6-sol', 'gpt-5.5']);
});

test('selectModels 按 slug 选择且保持优先级排序', () => {
  const picked = selectModels(CATALOG, ['cursor-grok-4.6', 'gpt-5.5', 'gpt-5.6-sol']);
  assert.deepEqual(picked.map((e) => e.slug).sort(), ['cursor-grok-4.6', 'gpt-5.5', 'gpt-5.6-sol']);
});

test('assertDesktopSafeModels 拒绝残缺条目（桌面必填字段）', () => {
  assert.doesNotThrow(() => assertDesktopSafeModels([entry('ok')]));
  assert.throws(() => assertDesktopSafeModels([{ ...entry('x'), supported_in_api: undefined }]), /supported_in_api/);
  assert.throws(() => assertDesktopSafeModels([{ ...entry('x'), priority: undefined }]), /priority/);
  assert.throws(() => assertDesktopSafeModels([{ ...entry('x'), base_instructions: '' }]), /base_instructions/);
});

test('官方/路由 config.toml 构建与 model 行解析', () => {
  const official = buildOfficialConfigToml('gpt-5.6-sol');
  assert.match(official, /^model = "gpt-5.6-sol"/);
  assert.doesNotMatch(official, /model_providers/);
  const router = buildRouterConfigToml('gpt-5.5');
  assert.match(router, /model_providers\.router/);
  assert.match(router, /base_url = "http:\/\/127\.0\.0\.1:15730\/v1"/);
  assert.equal(parseConfigTomlModel(router), 'gpt-5.5');
});

test('detectAccessMode 识别官方直连与路由接入', () => {
  assert.equal(detectAccessMode(buildOfficialConfigToml(), ['gpt-5.6-sol']), 'official');
  assert.equal(detectAccessMode(buildRouterConfigToml(), ['gpt-5.6-sol']), 'router');
  // 官方 toml 但目录里出现自定义模型 → 视为接入路由状态（说明仍用自定义目录）
  assert.equal(detectAccessMode(buildOfficialConfigToml(), ['deepseek-v4-flash']), 'router');
});

test('writeWithBackup 原子写入并生成时间戳备份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-test-'));
  const file = path.join(dir, 'models.json');
  fs.writeFileSync(file, 'old');
  const backup = writeWithBackup(file, 'new');
  assert.ok(backup && fs.existsSync(backup));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(fs.readFileSync(backup, 'utf8'), 'old');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildModelsJson 输出可解析且按 priority 排序', () => {
  const json = buildModelsJson([entry('b', { priority: 5 }), entry('a', { priority: 1 })]);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.models.map((e) => e.slug), ['a', 'b']);
});