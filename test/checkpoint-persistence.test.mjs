import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GoalCheckpointStore } from '../lib/goal-checkpoint.mjs';
import {
  computeCheckpointNamespace,
  createCheckpointPersistence,
} from '../lib/checkpoint-persistence.mjs';

const CHECKPOINT = '目标\n持久化长任务\n\n硬性约束\n零依赖\n\n已完成\n配置\n\n进行中\n保存\n\n待完成\n恢复\n\n关键决定\n默认关闭\n\n当前工作集\n状态文件\n\n失败与原因\n无\n\n下一步\n冷启动';

test('持久化关闭时不创建文件且保持原内存 store', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'checkpoint-disabled-'));
  const snapshotPath = path.join(tempDir, 'checkpoint.json');
  const store = new GoalCheckpointStore();
  try {
    const persistence = createCheckpointPersistence({
      store,
      config: { enabled: false, path: snapshotPath },
      namespace: 'namespace',
    });
    assert.equal(persistence.store, store);
    assert.equal(persistence.status().mode, 'disabled');
    await persistence.close();
    assert.equal(fs.existsSync(snapshotPath), false);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('快照冷重启恢复且文件不包含原始索引或凭据', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'checkpoint-roundtrip-'));
  const snapshotPath = path.join(tempDir, 'checkpoint.json');
  const namespace = computeCheckpointNamespace({
    stateGeneration: 'generation-1',
    targets: [{ name: 'api', host: 'api.example.test', envKey: 'SECRET_KEY', wireApi: 'chat' }],
    getKey: () => 'super-secret-value',
  });
  try {
    const first = createCheckpointPersistence({
      store: new GoalCheckpointStore(),
      config: { enabled: true, path: snapshotPath, debounceMs: 5 },
      namespace,
    });
    first.store.remember({
      taskKey: 'raw-task-id',
      exactKey: 'raw-exact-id',
      checkpoint: CHECKPOINT,
      responseId: 'raw-response-id',
    });
    await first.flush();
    await first.close();

    const serialized = await fsp.readFile(snapshotPath, 'utf8');
    assert.doesNotMatch(serialized, /raw-task-id|raw-exact-id|raw-response-id|super-secret-value/);
    assert.match(serialized, /"version": 1/);
    assert.match(serialized, /"checksum": "[a-f0-9]{64}"/);

    const second = createCheckpointPersistence({
      store: new GoalCheckpointStore(),
      config: { enabled: true, path: snapshotPath, debounceMs: 5 },
      namespace,
    });
    assert.equal(second.store.getTask('raw-task-id'), CHECKPOINT);
    assert.equal(second.status().loadedEntries, 1);
    await second.close();
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('身份 namespace 变化时保留旧文件但不载入旧检查点', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'checkpoint-namespace-'));
  const snapshotPath = path.join(tempDir, 'checkpoint.json');
  try {
    const first = createCheckpointPersistence({
      store: new GoalCheckpointStore(),
      config: { enabled: true, path: snapshotPath },
      namespace: 'namespace-a',
    });
    first.store.remember({ taskKey: 'task', checkpoint: CHECKPOINT });
    await first.flush();
    await first.close();
    const before = await fsp.readFile(snapshotPath, 'utf8');

    const second = createCheckpointPersistence({
      store: new GoalCheckpointStore(),
      config: { enabled: true, path: snapshotPath },
      namespace: 'namespace-b',
    });
    assert.equal(second.store.getTask('task'), null);
    assert.equal(second.status().namespaceMismatch, true);
    await second.close();
    assert.equal(await fsp.readFile(snapshotPath, 'utf8'), before);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('同一路径的第二实例只读运行且不能覆盖首实例快照', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'checkpoint-lock-'));
  const snapshotPath = path.join(tempDir, 'checkpoint.json');
  try {
    const first = createCheckpointPersistence({
      store: new GoalCheckpointStore(),
      config: { enabled: true, path: snapshotPath },
      namespace: 'shared',
    });
    first.store.remember({ taskKey: 'first', checkpoint: CHECKPOINT });
    await first.flush();

    const second = createCheckpointPersistence({
      store: new GoalCheckpointStore(),
      config: { enabled: true, path: snapshotPath },
      namespace: 'shared',
    });
    assert.equal(second.status().mode, 'readonly');
    second.store.remember({ taskKey: 'second', checkpoint: `${CHECKPOINT}\nsecond` });
    await second.flush();
    await second.close();
    await first.close();

    const loaded = createCheckpointPersistence({
      store: new GoalCheckpointStore(),
      config: { enabled: true, path: snapshotPath },
      namespace: 'shared',
    });
    assert.equal(loaded.store.getTask('first'), CHECKPOINT);
    assert.equal(loaded.store.getTask('second'), null);
    await loaded.close();
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('持久化关闭时可恢复清空正常清理内存且明确没有磁盘备份', async () => {
  const store = new GoalCheckpointStore();
  store.remember({ taskKey: 'disabled-task', checkpoint: CHECKPOINT });
  const persistence = createCheckpointPersistence({
    store,
    config: { enabled: false },
    namespace: 'disabled',
  });

  const result = await persistence.clearRecoverably();

  assert.equal(result.removed, 1);
  assert.equal(result.backupPath, null);
  assert.match(result.recoveryHint, /仅清空当前内存/);
  assert.equal(store.getTask('disabled-task'), null);
});

test('可写持久化清空前创建时间戳备份并确认空快照落盘', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'checkpoint-clear-backup-'));
  const snapshotPath = path.join(tempDir, 'checkpoint.json');
  try {
    const persistence = createCheckpointPersistence({
      store: new GoalCheckpointStore(),
      config: { enabled: true, path: snapshotPath },
      namespace: 'clear-backup',
    });
    persistence.store.remember({ taskKey: 'clear-task', checkpoint: CHECKPOINT });
    await persistence.flush();

    const result = await persistence.clearRecoverably();

    assert.equal(result.removed, 1);
    assert.match(result.backupPath, /checkpoint\.json\.clear-\d{8}T\d{6}\d{3}Z-[a-f0-9-]+\.bak$/);
    assert.equal(fs.existsSync(result.backupPath), true);
    assert.match(result.recoveryHint, /恢复/);
    const backup = JSON.parse(await fsp.readFile(result.backupPath, 'utf8'));
    const cleared = JSON.parse(await fsp.readFile(snapshotPath, 'utf8'));
    assert.equal(backup.store.entries.length, 1);
    assert.equal(cleared.store.entries.length, 0);
    assert.equal(cleared.store.responses.length, 0);
    await persistence.close();
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('清空快照落盘失败时不报告成功并尽量恢复原内存状态', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'checkpoint-clear-failure-'));
  const snapshotPath = path.join(tempDir, 'checkpoint.json');
  const persistence = createCheckpointPersistence({
    store: new GoalCheckpointStore(),
    config: { enabled: true, path: snapshotPath },
    namespace: 'clear-failure',
  });
  const originalRename = fs.renameSync;
  try {
    persistence.store.remember({ taskKey: 'restore-task', checkpoint: CHECKPOINT });
    await persistence.flush();
    fs.renameSync = (source, destination) => {
      if (destination === snapshotPath) throw Object.assign(new Error('simulated clear write failure'), { code: 'EIO' });
      return originalRename(source, destination);
    };

    await assert.rejects(
      persistence.clearRecoverably(),
      (error) => error.code === 'checkpoint_clear_failed'
        && typeof error.backupPath === 'string',
    );
    assert.equal(persistence.store.getTask('restore-task'), CHECKPOINT);
    assert.equal(JSON.parse(await fsp.readFile(snapshotPath, 'utf8')).store.entries.length, 1);
  } finally {
    fs.renameSync = originalRename;
    await persistence.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('只读持久化拒绝可恢复清空且不改变内存快照', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'checkpoint-clear-readonly-'));
  const snapshotPath = path.join(tempDir, 'checkpoint.json');
  try {
    const writer = createCheckpointPersistence({
      store: new GoalCheckpointStore(),
      config: { enabled: true, path: snapshotPath },
      namespace: 'clear-readonly',
    });
    writer.store.remember({ taskKey: 'readonly-task', checkpoint: CHECKPOINT });
    await writer.flush();
    const reader = createCheckpointPersistence({
      store: new GoalCheckpointStore(),
      config: { enabled: true, path: snapshotPath },
      namespace: 'clear-readonly',
    });

    await assert.rejects(
      reader.clearRecoverably(),
      (error) => error.code === 'persistence_readonly',
    );
    assert.equal(reader.store.getTask('readonly-task'), CHECKPOINT);
    await reader.close();
    await writer.close();
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('仅剩 response 歧义哨兵时清空也标脏并落盘', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'checkpoint-clear-response-only-'));
  const snapshotPath = path.join(tempDir, 'checkpoint.json');
  try {
    const store = new GoalCheckpointStore();
    store.remember({ taskKey: 'task-a', checkpoint: `${CHECKPOINT}\nA`, responseId: 'shared' });
    store.remember({ taskKey: 'task-b', checkpoint: `${CHECKPOINT}\nB`, responseId: 'shared' });
    for (const id of [...store.entries.keys()]) store.removeEntry(id);
    assert.equal(store.exportSnapshot().entries.length, 0);
    assert.equal(store.exportSnapshot().responses.length, 1);

    const persistence = createCheckpointPersistence({
      store,
      config: { enabled: true, path: snapshotPath },
      namespace: 'response-only',
    });
    assert.equal(persistence.store.clear(), 0);
    assert.equal(await persistence.flush(), true);
    const snapshot = JSON.parse(await fsp.readFile(snapshotPath, 'utf8'));
    assert.equal(snapshot.store.responses.length, 0);
    await persistence.close();
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
