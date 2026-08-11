import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createModelRoutingTransaction,
  recoverModelRoutingTransaction,
  transactionJournalPath,
} from '../lib/model-routing-transaction.mjs';
import {
  encodeJson,
  readRevisionedJson,
  sha256Bytes,
} from '../lib/json-file-store.mjs';

async function withTempDir(prefix, callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function sequentialUUID(prefix = 'tx') {
  let count = 0;
  return () => `${prefix}-${++count}`;
}

async function fixture(tempDir) {
  const configDir = path.join(tempDir, 'config');
  const catalogDir = path.join(tempDir, 'catalog');
  await fs.mkdir(configDir);
  await fs.mkdir(catalogDir);
  const configPath = path.join(configDir, 'config.json');
  const catalogPath = path.join(catalogDir, 'models.json');
  await fs.writeFile(configPath, '{"targets":[{"name":"old"}],"secret":"不应进入日志"}\n');
  await fs.writeFile(catalogPath, '{"models":[{"slug":"old"}]}\n');
  return { configPath, catalogPath };
}

test('成功提交跨目录双文件并返回双新 revision，清理 journal 且保留本次备份', async () => {
  await withTempDir('router-model-tx-success-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      randomUUID: sequentialUUID(),
    });

    const result = await transaction.commit({
      configRevision: oldConfig.revision,
      catalogRevision: oldCatalog.revision,
      config: { targets: [{ name: 'new' }], secret: '仍只在配置正文' },
      catalog: { models: [{ slug: 'new' }] },
    });

    const newConfig = readRevisionedJson(configPath);
    const newCatalog = readRevisionedJson(catalogPath);
    assert.deepEqual(newConfig.value, {
      targets: [{ name: 'new' }],
      secret: '仍只在配置正文',
    });
    assert.deepEqual(newCatalog.value, { models: [{ slug: 'new' }] });
    assert.deepEqual(result, {
      configRevision: newConfig.revision,
      catalogRevision: newCatalog.revision,
      txid: 'tx-1',
      restartRequired: true,
    });
    assert.equal(fsSync.existsSync(transactionJournalPath(configPath)), false);
    const configBackup = (await fs.readdir(path.dirname(configPath)))
      .find((name) => name.startsWith('config.json.model-routing.bak-tx-1-'));
    const catalogBackup = (await fs.readdir(path.dirname(catalogPath)))
      .find((name) => name.startsWith('models.json.model-routing.bak-tx-1-'));
    assert.equal(await fs.readFile(path.join(path.dirname(configPath), configBackup), 'utf8'), oldConfig.bytes.toString('utf8'));
    assert.equal(await fs.readFile(path.join(path.dirname(catalogPath), catalogBackup), 'utf8'), oldCatalog.bytes.toString('utf8'));
  });
});

test('调用方任一 revision 过期都会稳定返回 revision_conflict 且不改文件', async (t) => {
  for (const staleSide of ['config', 'catalog']) {
    await t.test(staleSide, async () => {
      await withTempDir(`router-model-tx-stale-${staleSide}-`, async (tempDir) => {
        const { configPath, catalogPath } = await fixture(tempDir);
        const oldConfig = readRevisionedJson(configPath);
        const oldCatalog = readRevisionedJson(catalogPath);
        const transaction = createModelRoutingTransaction({
          configPath,
          catalogPath,
          randomUUID: sequentialUUID(),
        });

        await assert.rejects(
          transaction.commit({
            configRevision: staleSide === 'config' ? '0'.repeat(64) : oldConfig.revision,
            catalogRevision: staleSide === 'catalog' ? '0'.repeat(64) : oldCatalog.revision,
            config: { targets: [] },
            catalog: { models: [] },
          }),
          (error) => error?.code === 'revision_conflict'
            && !error.message.includes(tempDir)
            && !error.message.includes('不应进入日志'),
        );
        assert.deepEqual((await fs.readFile(configPath)), oldConfig.bytes);
        assert.deepEqual((await fs.readFile(catalogPath)), oldCatalog.bytes);
      });
    });
  }
});

test('准备完成后 config 或 catalog 被外部修改时不覆盖外部内容并清理本事务文件', async (t) => {
  for (const changedSide of ['config', 'catalog']) {
    await t.test(changedSide, async () => {
      await withTempDir(`router-model-tx-race-${changedSide}-`, async (tempDir) => {
        const { configPath, catalogPath } = await fixture(tempDir);
        const oldConfig = readRevisionedJson(configPath);
        const oldCatalog = readRevisionedJson(catalogPath);
        const changedPath = changedSide === 'config' ? configPath : catalogPath;
        const externalBytes = Buffer.from(`{"external":"${changedSide}"}\n`);
        const journalPath = transactionJournalPath(configPath);
        const descriptorPaths = new Map();
        let changed = false;
        const fileSystem = {
          ...fsSync,
          openSync(filePath, ...args) {
            const descriptor = fsSync.openSync(filePath, ...args);
            descriptorPaths.set(descriptor, filePath);
            return descriptor;
          },
          closeSync(descriptor) {
            descriptorPaths.delete(descriptor);
            return fsSync.closeSync(descriptor);
          },
          fsyncSync(descriptor) {
            const result = fsSync.fsyncSync(descriptor);
            if (!changed && descriptorPaths.get(descriptor)?.startsWith(`${journalPath}.tmp-`)) {
              changed = true;
              fsSync.writeFileSync(changedPath, externalBytes);
            }
            return result;
          },
        };
        const transaction = createModelRoutingTransaction({
          configPath,
          catalogPath,
          fileSystem,
          randomUUID: sequentialUUID(),
        });

        await assert.rejects(
          transaction.commit({
            configRevision: oldConfig.revision,
            catalogRevision: oldCatalog.revision,
            config: { targets: [{ name: 'ours' }] },
            catalog: { models: [{ slug: 'ours' }] },
          }),
          (error) => error?.code === 'revision_conflict',
        );
        assert.deepEqual(await fs.readFile(changedPath), externalBytes);
        const untouchedPath = changedSide === 'config' ? catalogPath : configPath;
        const untouchedBytes = changedSide === 'config' ? oldCatalog.bytes : oldConfig.bytes;
        assert.deepEqual(await fs.readFile(untouchedPath), untouchedBytes);
        const leftovers = (await fs.readdir(path.dirname(configPath)))
          .concat(await fs.readdir(path.dirname(catalogPath)))
          .filter((name) => name.includes('.tmp-') || name.includes('.bak-') || name.includes('transaction'));
        assert.deepEqual(leftovers, []);
      });
    });
  }
});

test('拒绝相同解析路径或同一实际文件作为双目标', async () => {
  await withTempDir('router-model-tx-same-file-', async (tempDir) => {
    const configPath = path.join(tempDir, 'config.json');
    const aliasPath = path.join(tempDir, 'models.json');
    await fs.writeFile(configPath, '{"value":1}\n');
    await fs.link(configPath, aliasPath);

    for (const catalogPath of [configPath, aliasPath]) {
      assert.throws(
        () => createModelRoutingTransaction({ configPath, catalogPath }),
        (error) => error?.code === 'invalid_transaction_paths'
          && !error.message.includes(tempDir),
      );
    }
    await assert.rejects(
      recoverModelRoutingTransaction({ configPath, catalogPath: aliasPath }),
      (error) => error?.code === 'invalid_transaction_paths',
    );
  });
});

function injectedFileSystem({ operation, side, configPath, catalogPath }) {
  const targetPath = side === 'config' ? configPath : catalogPath;
  const descriptorPaths = new Map();
  let failed = false;
  const failOnce = () => {
    if (failed) return false;
    failed = true;
    return true;
  };
  return {
    ...fsSync,
    openSync(filePath, flags, ...rest) {
      if (
        operation === 'open'
        && filePath.startsWith(`${targetPath}.tmp-`)
        && failOnce()
      ) {
        throw new Error('injected open failure');
      }
      const descriptor = fsSync.openSync(filePath, flags, ...rest);
      descriptorPaths.set(descriptor, filePath);
      return descriptor;
    },
    closeSync(descriptor) {
      descriptorPaths.delete(descriptor);
      return fsSync.closeSync(descriptor);
    },
    writeSync(descriptor, ...args) {
      if (
        operation === 'write'
        && descriptorPaths.get(descriptor)?.startsWith(`${targetPath}.tmp-`)
        && failOnce()
      ) {
        throw new Error('injected write failure');
      }
      return fsSync.writeSync(descriptor, ...args);
    },
    fsyncSync(descriptor) {
      if (
        operation === 'fsync'
        && descriptorPaths.get(descriptor)?.startsWith(`${targetPath}.tmp-`)
        && failOnce()
      ) {
        throw new Error('injected fsync failure');
      }
      if (
        operation === 'backup-fsync'
        && descriptorPaths.get(descriptor)?.startsWith(`${targetPath}.model-routing.bak-tx-1-`)
        && failOnce()
      ) {
        throw new Error('injected backup fsync failure');
      }
      const result = fsSync.fsyncSync(descriptor);
      if (
        operation === 'backup-hash'
        && descriptorPaths.get(descriptor)?.startsWith(`${targetPath}.model-routing.bak-tx-1-`)
        && failOnce()
      ) {
        fsSync.writeFileSync(descriptorPaths.get(descriptor), '{"corrupt":true}\n');
      }
      return result;
    },
    copyFileSync(source, destination, flags) {
      if (
        operation === 'backup'
        && destination.startsWith(`${targetPath}.model-routing.bak-tx-1-`)
        && failOnce()
      ) {
        throw new Error('injected backup failure');
      }
      return fsSync.copyFileSync(source, destination, flags);
    },
  };
}

async function assertOriginalPair(configPath, catalogPath, oldConfig, oldCatalog) {
  assert.deepEqual(await fs.readFile(configPath), oldConfig.bytes);
  assert.deepEqual(await fs.readFile(catalogPath), oldCatalog.bytes);
}

async function assertNoTransactionArtifacts(configPath, catalogPath) {
  const names = (await fs.readdir(path.dirname(configPath)))
    .concat(await fs.readdir(path.dirname(catalogPath)));
  assert.deepEqual(
    names.filter((name) => name.includes('.tmp-') || name.includes('.bak-') || name.includes('transaction')),
    [],
  );
}

async function assertRetainedRollbackEvidence(configPath, catalogPath, txid) {
  const names = (await fs.readdir(path.dirname(configPath)))
    .concat(await fs.readdir(path.dirname(catalogPath)));
  assert.deepEqual(names.filter((name) => name.includes('.tmp-')), []);
  assert.equal(fsSync.existsSync(transactionJournalPath(configPath)), false);
  assert.equal(
    names.filter((name) => name.includes(`.model-routing.bak-${txid}-`)).length,
    2,
  );
  assert.equal(
    names.some((name) => name.includes(`.model-routing.displaced-${txid}-`)),
    true,
  );
}

test('双文件任一侧 prepare write/open/fsync 或 backup copy/fsync/hash 失败都安全中止', async (t) => {
  for (const operation of ['write', 'open', 'fsync', 'backup', 'backup-fsync', 'backup-hash']) {
    for (const side of ['config', 'catalog']) {
      await t.test(`${operation}-${side}`, async () => {
        await withTempDir(`router-model-tx-${operation}-${side}-`, async (tempDir) => {
          const { configPath, catalogPath } = await fixture(tempDir);
          const oldConfig = readRevisionedJson(configPath);
          const oldCatalog = readRevisionedJson(catalogPath);
          const transaction = createModelRoutingTransaction({
            configPath,
            catalogPath,
            fileSystem: injectedFileSystem({ operation, side, configPath, catalogPath }),
            randomUUID: sequentialUUID(),
          });

          await assert.rejects(
            transaction.commit({
              configRevision: oldConfig.revision,
              catalogRevision: oldCatalog.revision,
              config: { secret: '绝不返回', targets: [] },
              catalog: { models: [] },
            }),
            (error) => error?.code === 'transaction_failed'
              && !error.message.includes(tempDir)
              && !error.message.includes('绝不返回'),
          );
          await assertOriginalPair(configPath, catalogPath, oldConfig, oldCatalog);
          await assertNoTransactionArtifacts(configPath, catalogPath);
        });
      });
    }
  }
});

test('第二次替换或任一侧最终 hash 校验失败会用已验证备份回滚且绝不报告成功', async (t) => {
  for (const failure of ['catalog-rename', 'final-config-hash', 'final-catalog-hash']) {
    await t.test(failure, async () => {
      await withTempDir(`router-model-tx-${failure}-`, async (tempDir) => {
        const { configPath, catalogPath } = await fixture(tempDir);
        const oldConfig = readRevisionedJson(configPath);
        const oldCatalog = readRevisionedJson(catalogPath);
        const descriptorPaths = new Map();
        let publishedCount = 0;
        let catalogReadsAfterPublish = 0;
        let injected = false;
        const fileSystem = {
          ...fsSync,
          openSync(filePath, ...args) {
            const descriptor = fsSync.openSync(filePath, ...args);
            descriptorPaths.set(descriptor, filePath);
            return descriptor;
          },
          closeSync(descriptor) {
            descriptorPaths.delete(descriptor);
            return fsSync.closeSync(descriptor);
          },
          renameSync(source, destination) {
            if (
              failure === 'catalog-rename'
              && source === catalogPath
              && destination.includes('.quarantine-')
              && !injected
            ) {
              injected = true;
              throw new Error('injected catalog rename failure');
            }
            return fsSync.renameSync(source, destination);
          },
          linkSync(source, destination) {
            if (destination === configPath || destination === catalogPath) publishedCount += 1;
            return fsSync.linkSync(source, destination);
          },
          readSync(descriptor, ...args) {
            const descriptorPath = descriptorPaths.get(descriptor);
            if (publishedCount >= 2 && descriptorPath === catalogPath) {
              catalogReadsAfterPublish += 1;
            }
            if (
              failure.startsWith('final-')
              && publishedCount >= 2
              && descriptorPath === (failure === 'final-config-hash' ? configPath : catalogPath)
              && (failure !== 'final-catalog-hash' || catalogReadsAfterPublish >= 2)
              && !injected
            ) {
              injected = true;
              throw new Error('injected final hash failure');
            }
            return fsSync.readSync(descriptor, ...args);
          },
        };
        const transaction = createModelRoutingTransaction({
          configPath,
          catalogPath,
          fileSystem,
          randomUUID: sequentialUUID(),
        });

        await assert.rejects(
          transaction.commit({
            configRevision: oldConfig.revision,
            catalogRevision: oldCatalog.revision,
            config: { secret: '绝不返回', targets: [{ name: 'new' }] },
            catalog: { models: [{ slug: 'new' }] },
          }),
          (error) => error?.code === 'transaction_rolled_back'
            && !error.message.includes(tempDir)
            && !error.message.includes('绝不返回'),
        );
        await assertOriginalPair(configPath, catalogPath, oldConfig, oldCatalog);
        await assertRetainedRollbackEvidence(configPath, catalogPath, 'tx-1');
      });
    });
  }
});

test('替换失败且备份恢复也失败时返回 transaction_in_doubt 与 txid，不泄漏路径或正文', async () => {
  await withTempDir('router-model-tx-in-doubt-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    let catalogRenameFailed = false;
    const fileSystem = {
      ...fsSync,
      renameSync(source, destination) {
        if (source === catalogPath && destination.includes('.quarantine-')) {
          catalogRenameFailed = true;
          throw new Error('injected catalog rename failure');
        }
        return fsSync.renameSync(source, destination);
      },
      linkSync(source, destination) {
        if (catalogRenameFailed && destination === configPath && source.includes('.restore-')) {
          throw new Error('injected restore failure');
        }
        return fsSync.linkSync(source, destination);
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID(),
    });

    await assert.rejects(
      transaction.commit({
        configRevision: oldConfig.revision,
        catalogRevision: oldCatalog.revision,
        config: { secret: '绝不返回', targets: [{ name: 'new' }] },
        catalog: { models: [{ slug: 'new' }] },
      }),
      (error) => error?.code === 'transaction_in_doubt'
        && error.txid === 'tx-1'
        && !error.message.includes(tempDir)
        && !error.message.includes('绝不返回'),
    );
    assert.equal(fsSync.existsSync(transactionJournalPath(configPath)), true);
  });
});

async function pendingJournal(tempDir, { phase, configState, catalogState, keepTemps = true }) {
  const { configPath, catalogPath } = await fixture(tempDir);
  const oldConfig = readRevisionedJson(configPath);
  const oldCatalog = readRevisionedJson(catalogPath);
  const txid = 'recover-1';
  const newConfigBytes = encodeJson({ targets: [{ name: 'recovered' }] });
  const newCatalogBytes = encodeJson({ models: [{ slug: 'recovered' }] });
  const configTempPath = `${configPath}.tmp-${process.pid}-${txid}-config`;
  const catalogTempPath = `${catalogPath}.tmp-${process.pid}-${txid}-catalog`;
  const configBackupPath = `${configPath}.model-routing.bak-${txid}-${oldConfig.revision}`;
  const catalogBackupPath = `${catalogPath}.model-routing.bak-${txid}-${oldCatalog.revision}`;
  const configNewHash = sha256Bytes(newConfigBytes);
  const catalogNewHash = sha256Bytes(newCatalogBytes);
  const configQuarantinePath = `${configPath}.model-routing.quarantine-${txid}-${oldConfig.revision}-config`;
  const catalogQuarantinePath = `${catalogPath}.model-routing.quarantine-${txid}-${oldCatalog.revision}-catalog`;
  const configDisplacedPath = `${configPath}.model-routing.displaced-${txid}-${configNewHash}-config`;
  const catalogDisplacedPath = `${catalogPath}.model-routing.displaced-${txid}-${catalogNewHash}-catalog`;
  await fs.writeFile(configBackupPath, oldConfig.bytes);
  await fs.writeFile(catalogBackupPath, oldCatalog.bytes);
  if (keepTemps) {
    await fs.writeFile(configTempPath, newConfigBytes);
    await fs.writeFile(catalogTempPath, newCatalogBytes);
  }
  if (configState === 'new') await fs.writeFile(configPath, newConfigBytes);
  if (catalogState === 'new') await fs.writeFile(catalogPath, newCatalogBytes);
  const journal = {
    version: 1,
    txid,
    phase,
    configPath: path.resolve(configPath),
    catalogPath: path.resolve(catalogPath),
    config: {
      oldHash: oldConfig.revision,
      newHash: configNewHash,
      tempPath: configTempPath,
      backupPath: configBackupPath,
      quarantinePath: configQuarantinePath,
      displacedPath: configDisplacedPath,
    },
    catalog: {
      oldHash: oldCatalog.revision,
      newHash: catalogNewHash,
      tempPath: catalogTempPath,
      backupPath: catalogBackupPath,
      quarantinePath: catalogQuarantinePath,
      displacedPath: catalogDisplacedPath,
    },
  };
  await fs.writeFile(transactionJournalPath(configPath), encodeJson(journal));
  return {
    configPath,
    catalogPath,
    oldConfig,
    oldCatalog,
    newConfigBytes,
    newCatalogBytes,
    journal,
  };
}

test('recover 覆盖 prepared/config-replaced/catalog-replaced/committed 并按双 hash 状态收敛', async (t) => {
  const cases = [
    {
      name: 'prepared 两旧时中止',
      phase: 'prepared',
      configState: 'old',
      catalogState: 'old',
      keepTemps: true,
      outcome: 'aborted',
      finalState: 'old',
    },
    {
      name: 'config-replaced 单边新且另一侧 temp 有效时完成提交',
      phase: 'config-replaced',
      configState: 'new',
      catalogState: 'old',
      keepTemps: true,
      outcome: 'committed',
      finalState: 'new',
    },
    {
      name: 'catalog-replaced 单边新但 temp 缺失时用备份回滚',
      phase: 'catalog-replaced',
      configState: 'new',
      catalogState: 'old',
      keepTemps: false,
      outcome: 'rolled_back',
      finalState: 'old',
    },
    {
      name: 'committed 两新时确认提交并清理',
      phase: 'committed',
      configState: 'new',
      catalogState: 'new',
      keepTemps: false,
      outcome: 'committed',
      finalState: 'new',
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await withTempDir('router-model-tx-recover-phase-', async (tempDir) => {
        const state = await pendingJournal(tempDir, entry);
        const result = await recoverModelRoutingTransaction({
          configPath: state.configPath,
          catalogPath: state.catalogPath,
          randomUUID: sequentialUUID('restore'),
        });

        assert.equal(result.recovered, true);
        assert.equal(result.outcome, entry.outcome);
        assert.equal(result.txid, 'recover-1');
        const expectedConfig = entry.finalState === 'new' ? state.newConfigBytes : state.oldConfig.bytes;
        const expectedCatalog = entry.finalState === 'new' ? state.newCatalogBytes : state.oldCatalog.bytes;
        assert.deepEqual(await fs.readFile(state.configPath), expectedConfig);
        assert.deepEqual(await fs.readFile(state.catalogPath), expectedCatalog);
        assert.equal(fsSync.existsSync(transactionJournalPath(state.configPath)), false);
        const leftovers = (await fs.readdir(path.dirname(state.configPath)))
          .concat(await fs.readdir(path.dirname(state.catalogPath)))
          .filter((name) => name.includes('.tmp-'));
        assert.deepEqual(leftovers, []);
      });
    });
  }
});

test('recover 对称处理 catalog 单边新，并在无法安全判定时返回 transaction_in_doubt', async (t) => {
  await t.test('catalog 单边新时用 config temp 完成提交', async () => {
    await withTempDir('router-model-tx-recover-catalog-new-', async (tempDir) => {
      const state = await pendingJournal(tempDir, {
        phase: 'catalog-replaced',
        configState: 'old',
        catalogState: 'new',
        keepTemps: true,
      });
      const result = await recoverModelRoutingTransaction({
        configPath: state.configPath,
        catalogPath: state.catalogPath,
        randomUUID: sequentialUUID('restore'),
      });
      assert.equal(result.outcome, 'committed');
      assert.deepEqual(await fs.readFile(state.configPath), state.newConfigBytes);
      assert.deepEqual(await fs.readFile(state.catalogPath), state.newCatalogBytes);
    });
  });

  await t.test('目标 hash 既非旧也非新时保持 journal 并报 in_doubt', async () => {
    await withTempDir('router-model-tx-recover-unsafe-', async (tempDir) => {
      const state = await pendingJournal(tempDir, {
        phase: 'config-replaced',
        configState: 'new',
        catalogState: 'old',
        keepTemps: false,
      });
      await fs.writeFile(state.catalogPath, '{"external":true}\n');
      await assert.rejects(
        recoverModelRoutingTransaction({
          configPath: state.configPath,
          catalogPath: state.catalogPath,
        }),
        (error) => error?.code === 'transaction_in_doubt'
          && error.txid === 'recover-1'
          && !error.message.includes(tempDir),
      );
      assert.equal(fsSync.existsSync(transactionJournalPath(state.configPath)), true);
      assert.equal((await fs.readFile(state.catalogPath, 'utf8')), '{"external":true}\n');
    });
  });
});

test('首文件捕获失败时两旧安全中止，journal 只含元数据并同步记录回滚阶段', async () => {
  await withTempDir('router-model-tx-config-rename-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const journalPath = transactionJournalPath(configPath);
    const journalSnapshots = [];
    const fileSystem = {
      ...fsSync,
      renameSync(source, destination) {
        if (source === configPath && destination.includes('.quarantine-')) {
          throw new Error('injected config rename failure');
        }
        const result = fsSync.renameSync(source, destination);
        if (destination === journalPath) journalSnapshots.push(fsSync.readFileSync(destination, 'utf8'));
        return result;
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID(),
    });

    await assert.rejects(
      transaction.commit({
        configRevision: oldConfig.revision,
        catalogRevision: oldCatalog.revision,
        config: { secret: '绝不进入 journal', targets: [] },
        catalog: { models: [] },
      }),
      (error) => error?.code === 'transaction_failed',
    );
    assert.deepEqual(
      journalSnapshots.map((text) => JSON.parse(text).phase),
      ['prepared', 'rolling-back'],
    );
    assert.equal(journalSnapshots.some((text) => text.includes('绝不进入 journal')), false);
    await assertOriginalPair(configPath, catalogPath, oldConfig, oldCatalog);
    await assertNoTransactionArtifacts(configPath, catalogPath);
  });
});

test('成功提交的 journal 依次同步四阶段且不包含配置正文', async () => {
  await withTempDir('router-model-tx-journal-phases-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const journalPath = transactionJournalPath(configPath);
    const journalSnapshots = [];
    const fileSystem = {
      ...fsSync,
      renameSync(source, destination) {
        const result = fsSync.renameSync(source, destination);
        if (destination === journalPath) journalSnapshots.push(fsSync.readFileSync(destination, 'utf8'));
        return result;
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID(),
    });

    await transaction.commit({
      configRevision: oldConfig.revision,
      catalogRevision: oldCatalog.revision,
      config: { secret: '绝不进入 journal', targets: [{ name: 'new' }] },
      catalog: { models: [{ slug: 'new' }] },
    });
    assert.deepEqual(
      journalSnapshots.map((text) => JSON.parse(text).phase),
      ['prepared', 'config-replaced', 'catalog-replaced', 'committed'],
    );
    assert.equal(journalSnapshots.some((text) => text.includes('绝不进入 journal')), false);
  });
});

test('commit 开始先恢复未决 journal，并仅保留最近成功事务的一组备份', async () => {
  await withTempDir('router-model-tx-recover-before-commit-', async (tempDir) => {
    const state = await pendingJournal(tempDir, {
      phase: 'prepared',
      configState: 'old',
      catalogState: 'old',
      keepTemps: true,
    });
    const transaction = createModelRoutingTransaction({
      configPath: state.configPath,
      catalogPath: state.catalogPath,
      randomUUID: sequentialUUID('next'),
    });

    await transaction.commit({
      configRevision: state.oldConfig.revision,
      catalogRevision: state.oldCatalog.revision,
      config: { targets: [{ name: 'after-recovery' }] },
      catalog: { models: [{ slug: 'after-recovery' }] },
    });

    const configNames = await fs.readdir(path.dirname(state.configPath));
    const catalogNames = await fs.readdir(path.dirname(state.catalogPath));
    assert.deepEqual(configNames.filter((name) => name.includes('recover-1')), []);
    assert.deepEqual(catalogNames.filter((name) => name.includes('recover-1')), []);
    assert.deepEqual(
      configNames.filter((name) => name.startsWith('config.json.model-routing.bak-')),
      [`config.json.model-routing.bak-next-1-${state.oldConfig.revision}`],
    );
    assert.deepEqual(
      catalogNames.filter((name) => name.startsWith('models.json.model-routing.bak-')),
      [`models.json.model-routing.bak-next-1-${state.oldCatalog.revision}`],
    );
  });
});

test('同一 journal 的重入提交由 Promise mutex 串行化', async () => {
  await withTempDir('router-model-tx-mutex-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const request = {
      configRevision: oldConfig.revision,
      catalogRevision: oldCatalog.revision,
      config: { targets: [{ name: 'serialized' }] },
      catalog: { models: [{ slug: 'serialized' }] },
    };
    let transaction;
    let secondCommit;
    let startedSecondInsideFsync = false;
    let insideInjectedFsync = false;
    let injected = false;
    const baseUUID = sequentialUUID('mutex');
    const randomUUID = () => {
      if (insideInjectedFsync) startedSecondInsideFsync = true;
      return baseUUID();
    };
    const descriptorPaths = new Map();
    const fileSystem = {
      ...fsSync,
      openSync(filePath, ...args) {
        const descriptor = fsSync.openSync(filePath, ...args);
        descriptorPaths.set(descriptor, filePath);
        return descriptor;
      },
      closeSync(descriptor) {
        descriptorPaths.delete(descriptor);
        return fsSync.closeSync(descriptor);
      },
      fsyncSync(descriptor) {
        if (!injected && descriptorPaths.get(descriptor)?.startsWith(`${configPath}.tmp-`)) {
          injected = true;
          insideInjectedFsync = true;
          secondCommit = transaction.commit(request);
          insideInjectedFsync = false;
        }
        return fsSync.fsyncSync(descriptor);
      },
    };
    transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID,
    });

    const firstResult = await transaction.commit(request);
    await assert.rejects(secondCommit, (error) => error?.code === 'revision_conflict');
    assert.equal(firstResult.restartRequired, true);
    assert.equal(startedSecondInsideFsync, false);
  });
});

test('公共入口把缺失文件和非法 JSON 转为不含路径的稳定错误', async (t) => {
  await t.test('创建事务时目标缺失', async () => {
    await withTempDir('router-model-tx-missing-', async (tempDir) => {
      const missingPath = path.join(tempDir, 'missing-config.json');
      const catalogPath = path.join(tempDir, 'models.json');
      await fs.writeFile(catalogPath, '{"models":[]}\n');
      assert.throws(
        () => createModelRoutingTransaction({ configPath: missingPath, catalogPath }),
        (error) => error?.code === 'transaction_failed'
          && !error.message.includes(tempDir),
      );
    });
  });

  await t.test('提交时目标 JSON 非法', async () => {
    await withTempDir('router-model-tx-invalid-json-', async (tempDir) => {
      const { configPath, catalogPath } = await fixture(tempDir);
      await fs.writeFile(configPath, '{broken');
      const transaction = createModelRoutingTransaction({ configPath, catalogPath });
      await assert.rejects(
        transaction.commit({
          configRevision: '0'.repeat(64),
          catalogRevision: '0'.repeat(64),
          config: {},
          catalog: {},
        }),
        (error) => error?.code === 'transaction_failed'
          && !error.message.includes(tempDir)
          && !error.message.includes('{broken'),
      );
    });
  });
});

test('成功清理只移除可验证的旧事务备份，保留用户同名前缀备份', async () => {
  await withTempDir('router-model-tx-owned-backups-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const manualConfig = `${configPath}.bak-manual`;
    const manualCatalog = `${catalogPath}.bak-manual`;
    const unknownModuleLike = `${configPath}.model-routing.bak-not-ours-${oldConfig.revision}`;
    await fs.writeFile(manualConfig, 'manual-config');
    await fs.writeFile(manualCatalog, 'manual-catalog');
    await fs.writeFile(unknownModuleLike, oldConfig.bytes);
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      randomUUID: sequentialUUID('owned'),
    });

    const firstResult = await transaction.commit({
      configRevision: oldConfig.revision,
      catalogRevision: oldCatalog.revision,
      config: { targets: [{ name: 'new' }] },
      catalog: { models: [{ slug: 'new' }] },
    });

    const firstConfig = readRevisionedJson(configPath);
    const firstCatalog = readRevisionedJson(catalogPath);
    const secondResult = await transaction.commit({
      configRevision: firstConfig.revision,
      catalogRevision: firstCatalog.revision,
      config: { targets: [{ name: 'newer' }] },
      catalog: { models: [{ slug: 'newer' }] },
    });

    assert.equal(await fs.readFile(manualConfig, 'utf8'), 'manual-config');
    assert.equal(await fs.readFile(manualCatalog, 'utf8'), 'manual-catalog');
    assert.deepEqual(await fs.readFile(unknownModuleLike), oldConfig.bytes);
    const configBackups = (await fs.readdir(path.dirname(configPath)))
      .filter((name) => name.startsWith('config.json.model-routing.bak-owned-'));
    const catalogBackups = (await fs.readdir(path.dirname(catalogPath)))
      .filter((name) => name.startsWith('models.json.model-routing.bak-owned-'));
    assert.equal(configBackups.length, 1);
    assert.equal(catalogBackups.length, 1);
    assert.equal(configBackups[0].includes(secondResult.txid), true);
    assert.equal(catalogBackups[0].includes(secondResult.txid), true);
    assert.notEqual(
      configBackups[0],
      `config.json.model-routing.bak-${firstResult.txid}-${oldConfig.revision}`,
    );
  });
});

test('prepared journal 的 config/catalog temp 与 backup 均精确绑定同一 txid', async () => {
  await withTempDir('router-model-tx-owned-paths-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const journalPath = transactionJournalPath(configPath);
    let preparedJournal;
    const fileSystem = {
      ...fsSync,
      renameSync(source, destination) {
        const result = fsSync.renameSync(source, destination);
        if (destination === journalPath && !preparedJournal) {
          preparedJournal = JSON.parse(fsSync.readFileSync(destination, 'utf8'));
        }
        return result;
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID('bound'),
    });
    await transaction.commit({
      configRevision: oldConfig.revision,
      catalogRevision: oldCatalog.revision,
      config: { targets: [] },
      catalog: { models: [] },
    });

    assert.equal(preparedJournal.txid, 'bound-1');
    for (const [name, targetPath] of [['config', configPath], ['catalog', catalogPath]]) {
      const entry = preparedJournal[name];
      assert.equal(path.isAbsolute(entry.tempPath), true);
      assert.equal(path.dirname(entry.tempPath), path.dirname(targetPath));
      assert.match(path.basename(entry.tempPath), new RegExp(`^${path.basename(targetPath).replace('.', '\\.') }\\.tmp-\\d+-bound-1-`));
      assert.equal(
        entry.backupPath,
        `${targetPath}.model-routing.bak-bound-1-${entry.oldHash}`,
      );
      assert.match(
        path.basename(entry.quarantinePath),
        new RegExp(`^${path.basename(targetPath).replace('.', '\\.')}\\.model-routing\\.quarantine-bound-1-`),
      );
      assert.match(
        path.basename(entry.displacedPath),
        new RegExp(`^${path.basename(targetPath).replace('.', '\\.')}\\.model-routing\\.displaced-bound-1-`),
      );
    }
  });
});

test('恢复拒绝 txid 未绑定或越界的 journal 路径并保留 journal 与无关文件', async (t) => {
  for (const tamper of [
    'temp-wrong-txid',
    'temp-other-directory',
    'backup-wrong-hash',
    'quarantine-wrong-txid',
    'displaced-other-directory',
  ]) {
    await t.test(tamper, async () => {
      await withTempDir(`router-model-tx-tamper-${tamper}-`, async (tempDir) => {
        const state = await pendingJournal(tempDir, {
          phase: 'prepared',
          configState: 'old',
          catalogState: 'old',
          keepTemps: true,
        });
        const journalPath = transactionJournalPath(state.configPath);
        const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
        let victimPath;
        if (tamper === 'temp-wrong-txid') {
          victimPath = `${state.configPath}.tmp-${process.pid}-attacker-1-owned`;
          await fs.writeFile(victimPath, 'victim');
          journal.config.tempPath = victimPath;
        } else if (tamper === 'temp-other-directory') {
          victimPath = path.join(tempDir, `config.json.tmp-${process.pid}-recover-1-owned`);
          await fs.writeFile(victimPath, 'victim');
          journal.config.tempPath = victimPath;
        } else if (tamper === 'backup-wrong-hash') {
          victimPath = `${state.configPath}.model-routing.bak-recover-1-${'0'.repeat(64)}`;
          await fs.writeFile(victimPath, 'victim');
          journal.config.backupPath = victimPath;
        } else if (tamper === 'quarantine-wrong-txid') {
          victimPath = `${state.configPath}.model-routing.quarantine-attacker-1-owned`;
          await fs.writeFile(victimPath, 'victim');
          journal.config.quarantinePath = victimPath;
        } else {
          victimPath = path.join(
            tempDir,
            'config.json.model-routing.displaced-recover-1-owned',
          );
          await fs.writeFile(victimPath, 'victim');
          journal.config.displacedPath = victimPath;
        }
        await fs.writeFile(journalPath, encodeJson(journal));

        await assert.rejects(
          recoverModelRoutingTransaction({ configPath: state.configPath }),
          (error) => error?.code === 'transaction_in_doubt'
            && error.txid === 'recover-1'
            && !error.message.includes(tempDir),
        );
        assert.equal(fsSync.existsSync(journalPath), true);
        assert.equal(await fs.readFile(victimPath, 'utf8'), 'victim');
      });
    });
  }
});

test('recover 仅给 configPath 时从固定 journal 安全取得 catalogPath', async () => {
  await withTempDir('router-model-tx-config-only-recover-', async (tempDir) => {
    const state = await pendingJournal(tempDir, {
      phase: 'config-replaced',
      configState: 'new',
      catalogState: 'old',
      keepTemps: true,
    });
    const result = await recoverModelRoutingTransaction({ configPath: state.configPath });
    assert.equal(result.outcome, 'committed');
    assert.deepEqual(await fs.readFile(state.catalogPath), state.newCatalogBytes);
  });
});

test('config-only recover 在 settle 前拒绝 journal 双目标指向同一实际文件', async () => {
  await withTempDir('router-model-tx-recover-post-journal-alias-', async (tempDir) => {
    const state = await pendingJournal(tempDir, {
      phase: 'prepared',
      configState: 'old',
      catalogState: 'old',
      keepTemps: true,
    });
    await fs.unlink(state.catalogPath);
    await fs.link(state.configPath, state.catalogPath);
    const descriptorPaths = new Map();
    let targetRead = false;
    const fileSystem = {
      ...fsSync,
      openSync(filePath, ...args) {
        const descriptor = fsSync.openSync(filePath, ...args);
        descriptorPaths.set(descriptor, filePath);
        return descriptor;
      },
      closeSync(descriptor) {
        descriptorPaths.delete(descriptor);
        return fsSync.closeSync(descriptor);
      },
      readSync(descriptor, ...args) {
        if ([state.configPath, state.catalogPath].includes(descriptorPaths.get(descriptor))) {
          targetRead = true;
        }
        return fsSync.readSync(descriptor, ...args);
      },
    };

    await assert.rejects(
      recoverModelRoutingTransaction({ configPath: state.configPath, fileSystem }),
      (error) => error?.code === 'transaction_in_doubt'
        && error.txid === 'recover-1'
        && !error.message.includes(tempDir),
    );
    assert.equal(targetRead, false);
    assert.equal(fsSync.existsSync(transactionJournalPath(state.configPath)), true);
    assert.deepEqual(await fs.readFile(state.configPath), state.oldConfig.bytes);
    assert.deepEqual(await fs.readFile(state.catalogPath), state.oldConfig.bytes);
  });
});

test('rollback 在备份准备后发现目标被外部修改时不覆盖并保留恢复证据', async () => {
  await withTempDir('router-model-tx-rollback-race-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const externalBytes = Buffer.from('{"external":"rollback-window"}\n');
    const descriptorPaths = new Map();
    let catalogRenameFailed = false;
    let externallyChanged = false;
    const fileSystem = {
      ...fsSync,
      openSync(filePath, ...args) {
        const descriptor = fsSync.openSync(filePath, ...args);
        descriptorPaths.set(descriptor, filePath);
        return descriptor;
      },
      closeSync(descriptor) {
        descriptorPaths.delete(descriptor);
        return fsSync.closeSync(descriptor);
      },
      renameSync(source, destination) {
        if (source === catalogPath && destination.includes('.quarantine-') && !catalogRenameFailed) {
          catalogRenameFailed = true;
          throw new Error('injected catalog rename failure');
        }
        return fsSync.renameSync(source, destination);
      },
      fsyncSync(descriptor) {
        const result = fsSync.fsyncSync(descriptor);
        const descriptorPath = descriptorPaths.get(descriptor);
        if (catalogRenameFailed && !externallyChanged && descriptorPath?.includes('.restore-')) {
          externallyChanged = true;
          fsSync.writeFileSync(configPath, externalBytes);
        }
        return result;
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID('race'),
    });

    await assert.rejects(
      transaction.commit({
        configRevision: oldConfig.revision,
        catalogRevision: oldCatalog.revision,
        config: { targets: [{ name: 'ours' }] },
        catalog: { models: [{ slug: 'ours' }] },
      }),
      (error) => error?.code === 'transaction_in_doubt' && error.txid === 'race-1',
    );
    assert.deepEqual(await fs.readFile(configPath), externalBytes);
    assert.equal(fsSync.existsSync(transactionJournalPath(configPath)), true);
  });
});

test('inode 为 0 时采用 fail-closed，硬链接同文件仍被拒绝', async () => {
  await withTempDir('router-model-tx-zero-inode-', async (tempDir) => {
    const configPath = path.join(tempDir, 'config.json');
    const catalogPath = path.join(tempDir, 'models.json');
    await fs.writeFile(configPath, '{"value":1}\n');
    await fs.link(configPath, catalogPath);
    const zeroInodeFileSystem = {
      ...fsSync,
      lstatSync(filePath, ...args) {
        const stat = fsSync.lstatSync(filePath, ...args);
        return {
          ...stat,
          dev: 0,
          ino: 0,
          isFile: () => stat.isFile(),
          isSymbolicLink: () => stat.isSymbolicLink(),
        };
      },
      fstatSync(descriptor, ...args) {
        const stat = fsSync.fstatSync(descriptor, ...args);
        return { ...stat, dev: 0, ino: 0 };
      },
    };
    assert.throws(
      () => createModelRoutingTransaction({
        configPath,
        catalogPath,
        fileSystem: zeroInodeFileSystem,
      }),
      (error) => error?.code === 'invalid_transaction_paths',
    );
  });
});

test('构造后 commit 前双目标别名化或身份不可验证时 fail-closed 且不产生事务污染', async (t) => {
  const assertNoRoutingArtifacts = async (configPath, catalogPath) => {
    const names = (await fs.readdir(path.dirname(configPath)))
      .concat(await fs.readdir(path.dirname(catalogPath)));
    assert.deepEqual(
      names.filter((name) => name.includes('.model-routing') || name.includes('.tmp-')),
      [],
    );
  };

  await t.test('真实硬链接在构造后替换 catalog', async () => {
    await withTempDir('router-model-tx-post-create-hardlink-', async (tempDir) => {
      const { configPath, catalogPath } = await fixture(tempDir);
      const sameBytes = Buffer.from('{"shared":"same-revision"}\n');
      await fs.writeFile(configPath, sameBytes);
      await fs.writeFile(catalogPath, sameBytes);
      const oldConfig = readRevisionedJson(configPath);
      const oldCatalog = readRevisionedJson(catalogPath);
      const transaction = createModelRoutingTransaction({
        configPath,
        catalogPath,
        randomUUID: sequentialUUID('post-create-alias'),
      });

      await fs.unlink(catalogPath);
      await fs.link(configPath, catalogPath);

      await assert.rejects(
        transaction.commit({
          configRevision: oldConfig.revision,
          catalogRevision: oldCatalog.revision,
          config: { shared: 'new-config', secret: '不得进入错误' },
          catalog: { shared: 'new-catalog' },
        }),
        (error) => error?.code === 'invalid_transaction_paths'
          && !error.message.includes(tempDir)
          && !error.message.includes('不得进入错误'),
      );
      assert.deepEqual(await fs.readFile(configPath), sameBytes);
      assert.deepEqual(await fs.readFile(catalogPath), sameBytes);
      await assertNoRoutingArtifacts(configPath, catalogPath);
    });
  });

  await t.test('构造后 inode 变为 0 时身份不可验证', async () => {
    await withTempDir('router-model-tx-post-create-zero-inode-', async (tempDir) => {
      const { configPath, catalogPath } = await fixture(tempDir);
      const oldConfig = readRevisionedJson(configPath);
      const oldCatalog = readRevisionedJson(catalogPath);
      let zeroInode = false;
      const fileSystem = {
        ...fsSync,
        fstatSync(descriptor, ...args) {
          const stat = fsSync.fstatSync(descriptor, ...args);
          if (!zeroInode) return stat;
          const zeroStat = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat);
          zeroStat.ino = typeof stat.ino === 'bigint' ? 0n : 0;
          return zeroStat;
        },
      };
      const transaction = createModelRoutingTransaction({
        configPath,
        catalogPath,
        fileSystem,
        randomUUID: sequentialUUID('post-create-zero'),
      });
      zeroInode = true;

      await assert.rejects(
        transaction.commit({
          configRevision: oldConfig.revision,
          catalogRevision: oldCatalog.revision,
          config: { targets: [{ name: 'must-not-publish' }] },
          catalog: { models: [{ slug: 'must-not-publish' }] },
        }),
        (error) => ['invalid_transaction_paths', 'transaction_failed'].includes(error?.code)
          && !error.message.includes(tempDir),
      );
      assert.deepEqual(await fs.readFile(configPath), oldConfig.bytes);
      assert.deepEqual(await fs.readFile(catalogPath), oldCatalog.bytes);
      await assertNoRoutingArtifacts(configPath, catalogPath);
    });
  });

  await t.test('预检后发布前同 hash 新 inode 不能绕过身份绑定', async () => {
    await withTempDir('router-model-tx-bound-publish-identity-', async (tempDir) => {
      const { configPath, catalogPath } = await fixture(tempDir);
      const oldConfig = readRevisionedJson(configPath);
      const oldCatalog = readRevisionedJson(catalogPath);
      let replaced = false;
      const fileSystem = {
        ...fsSync,
        copyFileSync(source, destination, flags) {
          const result = fsSync.copyFileSync(source, destination, flags);
          if (
            !replaced
            && destination.startsWith(`${catalogPath}.model-routing.bak-`)
          ) {
            replaced = true;
            fsSync.unlinkSync(configPath);
            fsSync.writeFileSync(configPath, oldConfig.bytes);
          }
          return result;
        },
      };
      const transaction = createModelRoutingTransaction({
        configPath,
        catalogPath,
        fileSystem,
        randomUUID: sequentialUUID('bound-publish'),
      });

      await assert.rejects(
        transaction.commit({
          configRevision: oldConfig.revision,
          catalogRevision: oldCatalog.revision,
          config: { targets: [{ name: 'must-not-overwrite-replacement' }] },
          catalog: { models: [{ slug: 'must-not-publish' }] },
        }),
        (error) => error?.code === 'transaction_in_doubt'
          && !error.message.includes(tempDir),
      );
      assert.deepEqual(await fs.readFile(configPath), oldConfig.bytes);
      assert.deepEqual(await fs.readFile(catalogPath), oldCatalog.bytes);
      assert.equal(fsSync.existsSync(transactionJournalPath(configPath)), true);
    });
  });
});

test('commit 与 config-only recover 共用同一 journal Promise mutex', async () => {
  await withTempDir('router-model-tx-shared-mutex-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    let recoveryPromise;
    let injected = false;
    const descriptorPaths = new Map();
    const fileSystem = {
      ...fsSync,
      openSync(filePath, ...args) {
        const descriptor = fsSync.openSync(filePath, ...args);
        descriptorPaths.set(descriptor, filePath);
        return descriptor;
      },
      closeSync(descriptor) {
        descriptorPaths.delete(descriptor);
        return fsSync.closeSync(descriptor);
      },
      fsyncSync(descriptor) {
        if (!injected && descriptorPaths.get(descriptor)?.startsWith(`${configPath}.tmp-`)) {
          injected = true;
          recoveryPromise = recoverModelRoutingTransaction({ configPath, fileSystem });
        }
        return fsSync.fsyncSync(descriptor);
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID('shared'),
    });
    await transaction.commit({
      configRevision: oldConfig.revision,
      catalogRevision: oldCatalog.revision,
      config: { targets: [] },
      catalog: { models: [] },
    });
    assert.deepEqual(await recoveryPromise, { recovered: false });
  });
});

function injectAtPublishBoundary(fileSystem, targetPath, externalBytes, shouldInject) {
  let injected = false;
  const inject = (source, destination) => {
    if (!injected && destination === targetPath && shouldInject(source, destination)) {
      injected = true;
      fsSync.writeFileSync(targetPath, externalBytes);
    }
  };
  return {
    ...fileSystem,
    renameSync(source, destination) {
      inject(source, destination);
      return fileSystem.renameSync(source, destination);
    },
    linkSync(source, destination) {
      inject(source, destination);
      return fileSystem.linkSync(source, destination);
    },
  };
}

test('commit 发布原语边界出现外部内容时绝不覆盖或报告成功', async () => {
  await withTempDir('router-model-tx-commit-cas-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const externalBytes = Buffer.from('{"external":"commit-boundary"}\n');
    const fileSystem = injectAtPublishBoundary(
      fsSync,
      configPath,
      externalBytes,
      (source) => source.includes('.tmp-'),
    );
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID('commit-cas'),
    });

    await assert.rejects(
      transaction.commit({
        configRevision: oldConfig.revision,
        catalogRevision: oldCatalog.revision,
        config: { targets: [{ name: 'ours' }] },
        catalog: { models: [{ slug: 'ours' }] },
      }),
      (error) => ['revision_conflict', 'transaction_in_doubt'].includes(error?.code),
    );
    assert.deepEqual(await fs.readFile(configPath), externalBytes);
  });
});

test('rollback 发布原语边界出现外部内容时绝不覆盖或报告 rolled_back', async () => {
  await withTempDir('router-model-tx-rollback-cas-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const externalBytes = Buffer.from('{"external":"rollback-boundary"}\n');
    let catalogPublishFailed = false;
    let restoreInjected = false;
    const fileSystem = {
      ...fsSync,
      renameSync(source, destination) {
        if (destination === catalogPath && source.includes('.tmp-') && !catalogPublishFailed) {
          catalogPublishFailed = true;
          throw new Error('injected catalog publish failure');
        }
        if (destination === configPath && source.includes('.restore-') && !restoreInjected) {
          restoreInjected = true;
          fsSync.writeFileSync(configPath, externalBytes);
        }
        return fsSync.renameSync(source, destination);
      },
      linkSync(source, destination) {
        if (destination === catalogPath && source.includes('.tmp-') && !catalogPublishFailed) {
          catalogPublishFailed = true;
          throw new Error('injected catalog publish failure');
        }
        if (destination === configPath && source.includes('.restore-') && !restoreInjected) {
          restoreInjected = true;
          fsSync.writeFileSync(configPath, externalBytes);
        }
        return fsSync.linkSync(source, destination);
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID('rollback-cas'),
    });

    await assert.rejects(
      transaction.commit({
        configRevision: oldConfig.revision,
        catalogRevision: oldCatalog.revision,
        config: { targets: [{ name: 'ours' }] },
        catalog: { models: [{ slug: 'ours' }] },
      }),
      (error) => error?.code === 'transaction_in_doubt',
    );
    assert.deepEqual(await fs.readFile(configPath), externalBytes);
  });
});

test('rollback 复制恢复文件期间同 newHash 新 inode 替换必须保留外部目标并报 in_doubt', async () => {
  await withTempDir('router-model-tx-rollback-bound-identity-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const nextConfig = { targets: [{ name: 'same-hash-external-inode' }] };
    const nextConfigBytes = encodeJson(nextConfig);
    let catalogFailed = false;
    let externalIdentity;
    const fileIdentity = (filePath) => {
      const stat = fsSync.lstatSync(filePath, { bigint: true });
      return { dev: String(stat.dev), ino: String(stat.ino) };
    };
    const fileSystem = {
      ...fsSync,
      renameSync(source, destination) {
        if (
          !catalogFailed
          && source === catalogPath
          && destination.includes('.quarantine-')
        ) {
          catalogFailed = true;
          throw new Error('injected catalog capture failure');
        }
        return fsSync.renameSync(source, destination);
      },
      copyFileSync(source, destination, flags) {
        const result = fsSync.copyFileSync(source, destination, flags);
        if (
          source.startsWith(`${configPath}.model-routing.bak-`)
          && destination.includes('.restore-')
          && externalIdentity === undefined
        ) {
          fsSync.unlinkSync(configPath);
          fsSync.writeFileSync(configPath, nextConfigBytes);
          externalIdentity = fileIdentity(configPath);
        }
        return result;
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID('rollback-bound'),
    });

    await assert.rejects(
      transaction.commit({
        configRevision: oldConfig.revision,
        catalogRevision: oldCatalog.revision,
        config: nextConfig,
        catalog: { models: [{ slug: 'must-not-publish' }] },
      }),
      (error) => error?.code === 'transaction_in_doubt'
        && error.txid === 'rollback-bound-1'
        && !error.message.includes(tempDir),
    );
    assert.deepEqual(await fs.readFile(configPath), nextConfigBytes);
    assert.deepEqual(fileIdentity(configPath), externalIdentity);
    assert.deepEqual(await fs.readFile(catalogPath), oldCatalog.bytes);
    assert.equal(fsSync.existsSync(transactionJournalPath(configPath)), true);
    const configNames = await fs.readdir(path.dirname(configPath));
    assert.equal(
      configNames.some((name) => name.includes('.model-routing.quarantine-rollback-bound-1-')),
      true,
    );
    assert.equal(
      configNames.some((name) => name.includes('.model-routing.bak-rollback-bound-1-')),
      true,
    );
  });
});

test('rollback 当前目标 inode 为 0 时在复制恢复文件前 fail-closed', async () => {
  await withTempDir('router-model-tx-rollback-zero-inode-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const nextConfig = { targets: [{ name: 'zero-inode-new' }] };
    const nextConfigBytes = encodeJson(nextConfig);
    let rollbackStarted = false;
    let restoreCopied = false;
    const fileSystem = {
      ...fsSync,
      renameSync(source, destination) {
        if (
          !rollbackStarted
          && source === catalogPath
          && destination.includes('.quarantine-')
        ) {
          rollbackStarted = true;
          throw new Error('injected catalog capture failure');
        }
        return fsSync.renameSync(source, destination);
      },
      lstatSync(filePath, ...args) {
        const stat = fsSync.lstatSync(filePath, ...args);
        if (!rollbackStarted || filePath !== configPath) return stat;
        const zeroStat = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat);
        zeroStat.ino = typeof stat.ino === 'bigint' ? 0n : 0;
        return zeroStat;
      },
      copyFileSync(source, destination, flags) {
        if (destination.includes('.restore-')) restoreCopied = true;
        return fsSync.copyFileSync(source, destination, flags);
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID('rollback-zero'),
    });

    await assert.rejects(
      transaction.commit({
        configRevision: oldConfig.revision,
        catalogRevision: oldCatalog.revision,
        config: nextConfig,
        catalog: { models: [{ slug: 'must-not-publish' }] },
      }),
      (error) => error?.code === 'transaction_in_doubt'
        && error.txid === 'rollback-zero-1'
        && !error.message.includes(tempDir),
    );
    assert.equal(restoreCopied, false);
    assert.deepEqual(await fs.readFile(configPath), nextConfigBytes);
    assert.deepEqual(await fs.readFile(catalogPath), oldCatalog.bytes);
    assert.equal(fsSync.existsSync(transactionJournalPath(configPath)), true);
  });
});

test('config-only recover 发布原语边界出现外部内容时绝不覆盖或报告 committed', async () => {
  await withTempDir('router-model-tx-recover-cas-', async (tempDir) => {
    const state = await pendingJournal(tempDir, {
      phase: 'config-replaced',
      configState: 'new',
      catalogState: 'old',
      keepTemps: true,
    });
    const externalBytes = Buffer.from('{"external":"recover-boundary"}\n');
    const fileSystem = injectAtPublishBoundary(
      fsSync,
      state.catalogPath,
      externalBytes,
      (source) => source.includes('.tmp-'),
    );

    await assert.rejects(
      recoverModelRoutingTransaction({ configPath: state.configPath, fileSystem }),
      (error) => error?.code === 'transaction_in_doubt',
    );
    assert.deepEqual(await fs.readFile(state.catalogPath), externalBytes);
    assert.equal(fsSync.existsSync(transactionJournalPath(state.configPath)), true);
  });
});

test('recover 处理目标已移入隔离区但尚未无覆盖发布的崩溃点', async (t) => {
  await t.test('正向提交从 quarantine old + temp new 完成', async () => {
    await withTempDir('router-model-tx-recover-forward-gap-', async (tempDir) => {
      const state = await pendingJournal(tempDir, {
        phase: 'config-replaced',
        configState: 'new',
        catalogState: 'old',
        keepTemps: true,
      });
      fsSync.renameSync(state.catalogPath, state.journal.catalog.quarantinePath);

      const result = await recoverModelRoutingTransaction({ configPath: state.configPath });
      assert.equal(result.outcome, 'committed');
      assert.deepEqual(await fs.readFile(state.catalogPath), state.newCatalogBytes);
      assert.equal(fsSync.existsSync(state.journal.catalog.quarantinePath), true);
    });
  });

  await t.test('正向 temp 丢失时从 quarantine 恢复旧文件并用备份回滚', async () => {
    await withTempDir('router-model-tx-recover-forward-no-temp-', async (tempDir) => {
      const state = await pendingJournal(tempDir, {
        phase: 'config-replaced',
        configState: 'new',
        catalogState: 'old',
        keepTemps: true,
      });
      fsSync.renameSync(state.catalogPath, state.journal.catalog.quarantinePath);
      await fs.unlink(state.journal.catalog.tempPath);

      const result = await recoverModelRoutingTransaction({ configPath: state.configPath });
      assert.equal(result.outcome, 'rolled_back');
      await assertOriginalPair(
        state.configPath,
        state.catalogPath,
        state.oldConfig,
        state.oldCatalog,
      );
    });
  });

  await t.test('回滚从 displaced new + backup old 完成', async () => {
    await withTempDir('router-model-tx-recover-rollback-gap-', async (tempDir) => {
      const state = await pendingJournal(tempDir, {
        phase: 'rolling-back',
        configState: 'new',
        catalogState: 'old',
        keepTemps: false,
      });
      fsSync.renameSync(state.configPath, state.journal.config.displacedPath);

      const result = await recoverModelRoutingTransaction({ configPath: state.configPath });
      assert.equal(result.outcome, 'rolled_back');
      await assertOriginalPair(
        state.configPath,
        state.catalogPath,
        state.oldConfig,
        state.oldCatalog,
      );
      assert.equal(fsSync.existsSync(state.journal.config.displacedPath), true);
    });
  });

  await t.test('正向 link 已成功但 phase 未更新时确认提交并保留 quarantine', async () => {
    await withTempDir('router-model-tx-recover-forward-linked-', async (tempDir) => {
      const state = await pendingJournal(tempDir, {
        phase: 'config-replaced',
        configState: 'new',
        catalogState: 'old',
        keepTemps: true,
      });
      fsSync.renameSync(state.catalogPath, state.journal.catalog.quarantinePath);
      fsSync.linkSync(state.journal.catalog.tempPath, state.catalogPath);

      const result = await recoverModelRoutingTransaction({ configPath: state.configPath });
      assert.equal(result.outcome, 'committed');
      assert.equal(fsSync.existsSync(state.journal.catalog.quarantinePath), true);
    });
  });

  await t.test('回滚 link 已成功但 phase 未更新时确认回滚并保留 displaced', async () => {
    await withTempDir('router-model-tx-recover-rollback-linked-', async (tempDir) => {
      const state = await pendingJournal(tempDir, {
        phase: 'rolling-back',
        configState: 'old',
        catalogState: 'old',
        keepTemps: false,
      });
      await fs.writeFile(state.journal.config.displacedPath, state.newConfigBytes);

      const result = await recoverModelRoutingTransaction({ configPath: state.configPath });
      assert.equal(result.outcome, 'rolled_back');
      assert.equal(fsSync.existsSync(state.journal.config.displacedPath), true);
    });
  });
});

test('隔离 inode 被旧句柄改写时 recover 保留证据并返回 in_doubt', async () => {
  await withTempDir('router-model-tx-recover-held-handle-', async (tempDir) => {
    const state = await pendingJournal(tempDir, {
      phase: 'config-replaced',
      configState: 'new',
      catalogState: 'old',
      keepTemps: true,
    });
    await fs.writeFile(state.journal.config.quarantinePath, '{"external":"held-handle"}\n');

    await assert.rejects(
      recoverModelRoutingTransaction({ configPath: state.configPath }),
      (error) => error?.code === 'transaction_in_doubt' && error.txid === 'recover-1',
    );
    assert.equal(fsSync.existsSync(state.journal.config.quarantinePath), true);
    assert.equal(
      await fs.readFile(state.journal.config.quarantinePath, 'utf8'),
      '{"external":"held-handle"}\n',
    );
  });
});

test('recover 清理 quarantine 前重新校验另一侧发布期间的旧句柄写入', async () => {
  await withTempDir('router-model-tx-recover-late-handle-', async (tempDir) => {
    const state = await pendingJournal(tempDir, {
      phase: 'config-replaced',
      configState: 'new',
      catalogState: 'old',
      keepTemps: true,
    });
    await fs.writeFile(state.journal.config.quarantinePath, state.oldConfig.bytes);
    let changed = false;
    const fileSystem = {
      ...fsSync,
      linkSync(source, destination) {
        const result = fsSync.linkSync(source, destination);
        if (!changed && destination === state.catalogPath && source.includes('.tmp-')) {
          changed = true;
          fsSync.writeFileSync(
            state.journal.config.quarantinePath,
            '{"external":"late-held-handle"}\n',
          );
        }
        return result;
      },
    };

    await assert.rejects(
      recoverModelRoutingTransaction({ configPath: state.configPath, fileSystem }),
      (error) => error?.code === 'transaction_in_doubt' && error.txid === 'recover-1',
    );
    assert.equal(fsSync.existsSync(state.journal.config.quarantinePath), true);
    assert.equal(
      await fs.readFile(state.journal.config.quarantinePath, 'utf8'),
      '{"external":"late-held-handle"}\n',
    );
  });
});

test('高熵 quarantine 名发生碰撞时 fail-closed 且不删除碰撞文件', async () => {
  await withTempDir('router-model-tx-quarantine-collision-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const journalPath = transactionJournalPath(configPath);
    let collisionPath;
    const fileSystem = {
      ...fsSync,
      renameSync(source, destination) {
        const result = fsSync.renameSync(source, destination);
        if (destination === journalPath && collisionPath === undefined) {
          const journal = JSON.parse(fsSync.readFileSync(journalPath, 'utf8'));
          collisionPath = journal.config.quarantinePath;
          fsSync.writeFileSync(collisionPath, oldConfig.bytes);
        }
        return result;
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID('collision'),
    });

    await assert.rejects(
      transaction.commit({
        configRevision: oldConfig.revision,
        catalogRevision: oldCatalog.revision,
        config: { targets: [{ name: 'ours' }] },
        catalog: { models: [{ slug: 'ours' }] },
      }),
      (error) => error?.code === 'transaction_in_doubt',
    );
    assert.deepEqual(await fs.readFile(collisionPath), oldConfig.bytes);
    assert.equal(fsSync.existsSync(journalPath), true);
  });
});

test('target 在原子移入 quarantine 的调用边界被同 hash 新 inode 替换时 fail-closed', async () => {
  await withTempDir('router-model-tx-quarantine-identity-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    let replaced = false;
    const fileSystem = {
      ...fsSync,
      renameSync(source, destination) {
        if (!replaced && source === configPath && destination.includes('.quarantine-')) {
          replaced = true;
          fsSync.unlinkSync(configPath);
          fsSync.writeFileSync(configPath, oldConfig.bytes);
        }
        return fsSync.renameSync(source, destination);
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID('identity'),
    });

    await assert.rejects(
      transaction.commit({
        configRevision: oldConfig.revision,
        catalogRevision: oldCatalog.revision,
        config: { targets: [{ name: 'ours' }] },
        catalog: { models: [{ slug: 'ours' }] },
      }),
      (error) => error?.code === 'transaction_in_doubt',
    );
    assert.deepEqual(await fs.readFile(configPath), oldConfig.bytes);
  });
});

test('成功提交后真实旧 fd 的保存可从保留 quarantine 找回，后续事务不删除已变化证据', async () => {
  await withTempDir('router-model-tx-real-held-fd-commit-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    const heldDescriptor = fsSync.openSync(configPath, 'r+');
    const firstTransaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      randomUUID: sequentialUUID('held-commit'),
    });

    try {
      await firstTransaction.commit({
        configRevision: oldConfig.revision,
        catalogRevision: oldCatalog.revision,
        config: { targets: [{ name: 'managed-new' }] },
        catalog: { models: [{ slug: 'managed-new' }] },
      });

      const editorBytes = Buffer.from('{"targets":[{"name":"editor-save"}]}\n');
      fsSync.ftruncateSync(heldDescriptor, 0);
      fsSync.writeSync(heldDescriptor, editorBytes, 0, editorBytes.length, 0);
      fsSync.fsyncSync(heldDescriptor);
      fsSync.closeSync(heldDescriptor);

      const quarantineName = (await fs.readdir(path.dirname(configPath)))
        .find((name) => name.startsWith(
          'config.json.model-routing.quarantine-held-commit-1-',
        ));
      assert.ok(quarantineName, '当前成功事务必须保留旧 inode 的 quarantine 路径');
      const quarantinePath = path.join(path.dirname(configPath), quarantineName);
      assert.deepEqual(await fs.readFile(quarantinePath), editorBytes);

      const currentConfig = readRevisionedJson(configPath);
      const currentCatalog = readRevisionedJson(catalogPath);
      const nextTransaction = createModelRoutingTransaction({
        configPath,
        catalogPath,
        randomUUID: sequentialUUID('after-held-commit'),
      });
      await nextTransaction.commit({
        configRevision: currentConfig.revision,
        catalogRevision: currentCatalog.revision,
        config: { targets: [{ name: 'managed-newer' }] },
        catalog: { models: [{ slug: 'managed-newer' }] },
      });

      assert.deepEqual(await fs.readFile(quarantinePath), editorBytes);
    } finally {
      try { fsSync.closeSync(heldDescriptor); } catch { /* 测试失败时关闭真实旧句柄 */ }
    }
  });
});

test('安全回滚后真实旧 fd 的保存可从保留 displaced 找回，后续事务不删除已变化证据', async () => {
  await withTempDir('router-model-tx-real-held-fd-rollback-', async (tempDir) => {
    const { configPath, catalogPath } = await fixture(tempDir);
    const oldConfig = readRevisionedJson(configPath);
    const oldCatalog = readRevisionedJson(catalogPath);
    let heldDescriptor;
    let catalogFailed = false;
    const fileSystem = {
      ...fsSync,
      renameSync(source, destination) {
        if (
          !catalogFailed
          && source === catalogPath
          && destination.includes('.quarantine-')
        ) {
          catalogFailed = true;
          heldDescriptor = fsSync.openSync(configPath, 'r+');
          throw new Error('injected catalog capture failure');
        }
        return fsSync.renameSync(source, destination);
      },
    };
    const transaction = createModelRoutingTransaction({
      configPath,
      catalogPath,
      fileSystem,
      randomUUID: sequentialUUID('held-rollback'),
    });

    try {
      await assert.rejects(
        transaction.commit({
          configRevision: oldConfig.revision,
          catalogRevision: oldCatalog.revision,
          config: { targets: [{ name: 'displaced-new' }] },
          catalog: { models: [{ slug: 'never-published' }] },
        }),
        (error) => error?.code === 'transaction_rolled_back',
      );
      assert.equal(typeof heldDescriptor, 'number');

      const editorBytes = Buffer.from('{"targets":[{"name":"late-editor-save"}]}\n');
      fsSync.ftruncateSync(heldDescriptor, 0);
      fsSync.writeSync(heldDescriptor, editorBytes, 0, editorBytes.length, 0);
      fsSync.fsyncSync(heldDescriptor);
      fsSync.closeSync(heldDescriptor);

      const displacedName = (await fs.readdir(path.dirname(configPath)))
        .find((name) => name.startsWith(
          'config.json.model-routing.displaced-held-rollback-1-',
        ));
      assert.ok(displacedName, '当前回滚事务必须保留新 inode 的 displaced 路径');
      const displacedPath = path.join(path.dirname(configPath), displacedName);
      assert.deepEqual(await fs.readFile(displacedPath), editorBytes);

      const currentConfig = readRevisionedJson(configPath);
      const currentCatalog = readRevisionedJson(catalogPath);
      const nextTransaction = createModelRoutingTransaction({
        configPath,
        catalogPath,
        randomUUID: sequentialUUID('after-held-rollback'),
      });
      await nextTransaction.commit({
        configRevision: currentConfig.revision,
        catalogRevision: currentCatalog.revision,
        config: { targets: [{ name: 'after-rollback' }] },
        catalog: { models: [{ slug: 'after-rollback' }] },
      });

      assert.deepEqual(await fs.readFile(displacedPath), editorBytes);
    } finally {
      if (typeof heldDescriptor === 'number') {
        try { fsSync.closeSync(heldDescriptor); } catch { /* 测试失败时关闭真实旧句柄 */ }
      }
    }
  });
});
