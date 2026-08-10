import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addConfigValue,
  createConfigState,
  isConfigDirty,
  removeConfigValue,
  serializeConfigState,
  updateConfigValue,
} from '../web/config-state.mjs';

function apiPayload() {
  return {
    revision: 'revision-1',
    secretDeleteConfirmation: 'confirmation-1',
    config: {
      _comment: '这段说明必须保留',
      port: 15730,
      customExtension: {
        enabled: true,
        unknownOption: 'keep-me',
      },
      targets: [
        {
          name: 'deepseek',
          model: 'deepseek-chat',
          headers: {
            authorization: { $preserveSecret: 'secret-token' },
          },
        },
        {
          name: 'bailian',
          model: 'qwen-max',
          _comment: '数组内注释也必须保留',
        },
      ],
    },
  };
}

test('从管理 API 响应建立独立且未修改的编辑状态', () => {
  const payload = apiPayload();
  const state = createConfigState(payload);

  assert.equal(state.revision, 'revision-1');
  assert.equal(state.secretDeleteConfirmation, 'confirmation-1');
  assert.equal(isConfigDirty(state), false);
  assert.notEqual(state.config, payload.config);

  state.config.customExtension.enabled = false;
  assert.equal(payload.config.customExtension.enabled, true);
});

test('按 JSON Pointer 更新嵌套字段且不丢未知字段、注释或数组顺序', () => {
  const initial = createConfigState(apiPayload());
  const updated = updateConfigValue(initial, '/targets/1/model', 'qwen3.8-max');

  assert.equal(updated.config.targets[1].model, 'qwen3.8-max');
  assert.equal(updated.config.targets[0].name, 'deepseek');
  assert.equal(updated.config.targets[1].name, 'bailian');
  assert.equal(updated.config._comment, '这段说明必须保留');
  assert.equal(updated.config.targets[1]._comment, '数组内注释也必须保留');
  assert.equal(updated.config.customExtension.unknownOption, 'keep-me');
  assert.deepEqual(updated.config.targets[0].headers.authorization, {
    $preserveSecret: 'secret-token',
  });
  assert.equal(initial.config.targets[1].model, 'qwen-max');
});

test('同时接受 path 数组并正确解码 JSON Pointer 转义', () => {
  const payload = apiPayload();
  payload.config['route/name'] = { 'tilde~key': 'old' };
  const initial = createConfigState(payload);

  const byPath = updateConfigValue(initial, ['targets', 0, 'model'], 'deepseek-v4');
  const byPointer = updateConfigValue(byPath, '/route~1name/tilde~0key', 'new');

  assert.equal(byPointer.config.targets[0].model, 'deepseek-v4');
  assert.equal(byPointer.config['route/name']['tilde~key'], 'new');
});

test('修改后标记为脏，恢复原值后重新标记为干净', () => {
  const initial = createConfigState(apiPayload());
  const changed = updateConfigValue(initial, '/port', 16730);
  const reverted = updateConfigValue(changed, '/port', 15730);

  assert.equal(isConfigDirty(changed), true);
  assert.equal(changed.dirty, true);
  assert.equal(isConfigDirty(reverted), false);
  assert.equal(reverted.dirty, false);
});

test('序列化只提交 API 所需数据并返回与编辑状态隔离的副本', () => {
  const state = updateConfigValue(createConfigState(apiPayload()), '/port', 16730);
  const payload = serializeConfigState(state);

  assert.deepEqual(payload, {
    revision: 'revision-1',
    config: {
      ...state.config,
    },
    secretDeleteConfirmation: 'confirmation-1',
    secretDeletes: [],
  });
  assert.notEqual(payload.config, state.config);
  assert.notEqual(payload.config.targets, state.config.targets);

  payload.config.targets[0].model = 'changed-after-serialize';
  assert.equal(state.config.targets[0].model, 'deepseek-chat');
});

test('拒绝越界路径和会污染对象原型的路径', () => {
  const state = createConfigState(apiPayload());

  assert.throws(
    () => updateConfigValue(state, '/targets/8/model', 'missing'),
    /配置路径不存在/,
  );
  assert.throws(
    () => updateConfigValue(state, '/__proto__/polluted', true),
    /配置路径不安全/,
  );
  assert.equal({}.polluted, undefined);
});

test('只在已有父对象上新增缺失末级字段并保持配置结构', () => {
  const initial = createConfigState(apiPayload());
  const added = addConfigValue(initial, '/customExtension/newOption', 'new-value');
  const withNull = addConfigValue(added, ['customExtension', 'optionalProxy'], null);

  assert.equal(added.config.customExtension.newOption, 'new-value');
  assert.equal(withNull.config.customExtension.optionalProxy, null);
  assert.equal(Object.hasOwn(initial.config.customExtension, 'newOption'), false);
  assert.equal(added.dirty, true);
  assert.equal(isConfigDirty(added), true);
  assert.equal(added.config._comment, '这段说明必须保留');
  assert.equal(added.config.customExtension.unknownOption, 'keep-me');
  assert.deepEqual(added.config.targets.map((target) => target.name), ['deepseek', 'bailian']);
});

test('受限新增拒绝覆盖字段、中间容器、数组写入和危险路径', () => {
  const state = createConfigState(apiPayload());

  assert.throws(
    () => addConfigValue(state, '/customExtension/enabled', false),
    /配置字段已存在/,
  );
  assert.throws(
    () => addConfigValue(state, '/missing/child', true),
    /配置父路径不存在/,
  );
  assert.throws(
    () => addConfigValue(state, '/targets/2', { name: 'extra' }),
    /配置父路径必须是对象/,
  );
  assert.throws(
    () => addConfigValue(state, '/targets/8/model', 'missing'),
    /配置父路径不存在/,
  );
  assert.throws(
    () => addConfigValue(state, '/customExtension/__proto__', true),
    /配置路径不安全/,
  );
  assert.throws(
    () => addConfigValue(state, '/customExtension/undefinedValue', undefined),
    /配置值必须是有效 JSON 值/,
  );
  assert.equal({}.polluted, undefined);
  assert.equal(isConfigDirty(state), false);
});

test('新增字段后再受限删除可恢复原配置和干净状态', () => {
  const initial = createConfigState(apiPayload());
  const added = addConfigValue(initial, '/customExtension/temporary', 'value');
  const removed = removeConfigValue(added, '/customExtension/temporary');

  assert.equal(added.dirty, true);
  assert.equal(Object.hasOwn(removed.config.customExtension, 'temporary'), false);
  assert.equal(removed.dirty, false);
  assert.equal(isConfigDirty(removed), false);
  assert.equal(Object.hasOwn(added.config.customExtension, 'temporary'), true);
  assert.equal(removed.config.customExtension.unknownOption, 'keep-me');
  assert.deepEqual(removed.config.targets.map((target) => target.name), ['deepseek', 'bailian']);
});

test('受限删除拒绝数组、危险路径和不存在的父路径或字段', () => {
  const state = createConfigState(apiPayload());

  assert.throws(
    () => removeConfigValue(state, '/targets/0'),
    /配置父路径必须是对象/,
  );
  assert.throws(
    () => removeConfigValue(state, '/targets/8/model'),
    /配置父路径不存在/,
  );
  assert.throws(
    () => removeConfigValue(state, '/customExtension/missing'),
    /配置字段不存在/,
  );
  assert.throws(
    () => removeConfigValue(state, '/customExtension/__proto__'),
    /配置路径不安全/,
  );
  assert.equal({}.polluted, undefined);
  assert.equal(isConfigDirty(state), false);
});
