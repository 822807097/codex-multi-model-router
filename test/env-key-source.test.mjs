import test from 'node:test';
import assert from 'node:assert/strict';

import { createEnvKeySource, parseRegQueryOutput } from '../lib/env-key-source.mjs';

test('parseRegQueryOutput 解析 REG_SZ / REG_EXPAND_SZ 值', () => {
  assert.equal(parseRegQueryOutput([
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    TEST_KEY    REG_SZ    sk-new-value',
    '',
  ].join('\r\n')), 'sk-new-value');
  assert.equal(parseRegQueryOutput(
    '    TEST_KEY    REG_EXPAND_SZ    %USERPROFILE%\\x',
  ), '%USERPROFILE%\\x');
  assert.equal(parseRegQueryOutput('没有匹配行'), null);
  assert.equal(parseRegQueryOutput(''), null);
});

test('getKey 首次读取进程环境并缓存，换值前保持旧值', async () => {
  const env = { OPEN_CODE_KEY: 'old-key' };
  const source = createEnvKeySource({
    env,
    platform: 'win32',
    execFile: (_cmd, _args, _opts, cb) => cb(new Error('not found'), ''),
  });
  assert.equal(source.getKey('OPEN_CODE_KEY'), 'old-key');
  env.OPEN_CODE_KEY = 'process-env-mutated';
  // 缓存优先：进程环境即使被改，读到的仍是缓存值
  assert.equal(source.getKey('OPEN_CODE_KEY'), 'old-key');
  assert.equal(source.getKey(undefined), undefined);
  assert.equal(source.getKey(''), undefined);
});

test('refreshNow 检测到同名变量值变化后更新缓存并返回 true', async () => {
  const env = { OPEN_CODE_KEY: 'old-key' };
  const registry = {
    'HKCU\\Environment': {},
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment': {
      OPEN_CODE_KEY: 'new-key-from-registry',
    },
  };
  const calls = [];
  const execFile = (_cmd, args, _opts, cb) => {
    calls.push(args);
    const hive = args[1];
    const name = args[3];
    const value = registry[hive]?.[name];
    if (value === undefined) { cb(new Error('reg query exit 1'), ''); return; }
    cb(null, `\nHKEY_LOCAL_MACHINE\\...\n    ${name}    REG_SZ    ${value}\n`);
  };
  const logged = [];
  const source = createEnvKeySource({ env, platform: 'win32', execFile, log: (n) => logged.push(n) });

  assert.equal(source.getKey('OPEN_CODE_KEY'), 'old-key');
  const changed = await source.refreshNow('OPEN_CODE_KEY');
  assert.equal(changed, true);
  assert.equal(source.getKey('OPEN_CODE_KEY'), 'new-key-from-registry');
  assert.deepEqual(logged, ['OPEN_CODE_KEY']);
  // 用户 hive 优先于机器 hive 查询顺序
  assert.equal(calls[0][1], 'HKCU\\Environment');
});

test('refreshNow 值未变化或查询失败时返回 false 且保留旧值', async () => {
  const env = { K: 'same' };
  const execFile = (_cmd, args, _opts, cb) => {
    if (args[1] === 'HKCU\\Environment') { cb(new Error('exit 1'), ''); return; }
    cb(null, '\n    K    REG_SZ    same\n');
  };
  const source = createEnvKeySource({ env, platform: 'win32', execFile });
  assert.equal(source.getKey('K'), 'same');
  assert.equal(await source.refreshNow('K'), false);

  const failing = createEnvKeySource({
    env: { K: 'x' },
    platform: 'win32',
    execFile: (_c, _a, _o, cb) => cb(new Error('reg.exe missing'), ''),
  });
  assert.equal(failing.getKey('K'), 'x');
  assert.equal(await failing.refreshNow('K'), false);
  assert.equal(failing.getKey('K'), 'x');
});

test('用户级 hive 值优先于机器级', async () => {
  const registry = {
    'HKCU\\Environment': { KEY: 'user-value' },
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment': { KEY: 'machine-value' },
  };
  const execFile = (_cmd, args, _opts, cb) => {
    const value = registry[args[1]]?.[args[3]];
    if (value === undefined) { cb(new Error('exit 1'), ''); return; }
    cb(null, `    ${args[3]}    REG_SZ    ${value}\n`);
  };
  const source = createEnvKeySource({ env: { KEY: 'old' }, platform: 'win32', execFile });
  assert.equal(source.getKey('KEY'), 'old');
  assert.equal(await source.refreshNow('KEY'), true);
  assert.equal(source.getKey('KEY'), 'user-value');
});

test('非 Windows 平台不执行注册表刷新', async () => {
  let called = false;
  const source = createEnvKeySource({
    env: { K: 'v' },
    platform: 'linux',
    execFile: () => { called = true; },
  });
  assert.equal(source.getKey('K'), 'v');
  assert.equal(await source.refreshNow('K'), false);
  assert.equal(called, false);
});

test('同名 key 并发刷新只执行一次查询', async () => {
  let queryCount = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const execFile = (_cmd, _args, _opts, cb) => {
    queryCount += 1;
    setTimeout(() => {
      cb(null, '    K    REG_SZ    fresh\n');
      release();
    }, 10);
  };
  const source = createEnvKeySource({ env: { K: 'old' }, platform: 'win32', execFile });
  assert.equal(source.getKey('K'), 'old');
  const first = source.refreshNow('K');
  const second = source.refreshNow('K');
  const third = source.refreshNow('K');
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  await gate;
  // 一次刷新 = 两个 hive 各查一次（并行）；所有等待者共享同一个刷新结果。
  assert.equal(queryCount, 2);
  assert.equal(source.getKey('K'), 'fresh');
});
