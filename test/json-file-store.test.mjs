import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  commitRevisionedJson,
  copyAndVerify,
  encodeJson,
  prepareJsonWrite,
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

test('JSON 编码固定为两空格缩进和单个结尾换行并按实际字节计算 revision', () => {
  const bytes = encodeJson({ message: '中文', nested: { enabled: true } });
  const expected = Buffer.from(`${JSON.stringify({
    message: '中文',
    nested: { enabled: true },
  }, null, 2)}\n`);

  assert.deepEqual(bytes, expected);
  assert.equal(bytes.at(-1), 0x0a);
  assert.equal(sha256Bytes(bytes), crypto.createHash('sha256').update(expected).digest('hex'));
  assert.throws(() => encodeJson(undefined), /无法编码为 JSON/);
});

test('有界读取返回原始字节、解析值和精确 revision', async () => {
  await withTempDir('router-json-read-', async (tempDir) => {
    const filePath = path.join(tempDir, 'catalog.json');
    const bytes = Buffer.from('{"models":[{"slug":"模型-a"}]}\n');
    await fs.writeFile(filePath, bytes);

    const result = readRevisionedJson(filePath, { maxBytes: bytes.length });

    assert.deepEqual(result.bytes, bytes);
    assert.deepEqual(result.value, { models: [{ slug: '模型-a' }] });
    assert.equal(result.revision, sha256Bytes(bytes));
  });
});

test('读取通过同一文件描述符完成检查和内容读取', async () => {
  await withTempDir('router-json-fd-read-', async (tempDir) => {
    const filePath = path.join(tempDir, 'config.json');
    await fs.writeFile(filePath, '{"value":1}\n');
    const calls = [];
    const fileSystem = {
      ...fsSync,
      lstatSync(...args) {
        calls.push('lstat');
        return fsSync.lstatSync(...args);
      },
      openSync(...args) {
        calls.push('open');
        return fsSync.openSync(...args);
      },
      fstatSync(...args) {
        calls.push('fstat');
        return fsSync.fstatSync(...args);
      },
      readSync(...args) {
        calls.push('read');
        return fsSync.readSync(...args);
      },
      readFileSync() {
        throw new Error('不得按路径重新读取管理文件');
      },
      closeSync(...args) {
        calls.push('close');
        return fsSync.closeSync(...args);
      },
    };

    const result = readRevisionedJson(filePath, { fileSystem });
    assert.deepEqual(result.value, { value: 1 });
    assert.equal(calls.filter((call) => call === 'open').length, 1);
    assert.ok(calls.filter((call) => call === 'fstat').length >= 1);
    assert.ok(calls.includes('read'));
    assert.equal(calls.filter((call) => call === 'close').length, 1);
  });
});

test('路径身份与已打开文件描述符不一致时拒绝读取并关闭一次', () => {
  let closeCount = 0;
  let readCalled = false;
  const pathStat = {
    size: 2,
    dev: 1,
    ino: 10,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const descriptorStat = { ...pathStat, ino: 11 };
  const fileSystem = {
    constants: fsSync.constants,
    lstatSync: () => pathStat,
    openSync: () => 9,
    fstatSync: () => descriptorStat,
    readSync: () => { readCalled = true; return 0; },
    closeSync: () => { closeCount += 1; },
  };

  assert.throws(
    () => readRevisionedJson('C:/isolated/config.json', { fileSystem }),
    /读取期间已更换/,
  );
  assert.equal(readCalled, false);
  assert.equal(closeCount, 1);
});

test('读取和准备写入拒绝符号链接', async () => {
  await withTempDir('router-json-symlink-', async (tempDir) => {
    const realPath = path.join(tempDir, 'real.json');
    const linkPath = path.join(tempDir, 'link.json');
    await fs.writeFile(realPath, '{"value":1}\n');
    try {
      await fs.symlink(realPath, linkPath, 'file');
      assert.throws(() => readRevisionedJson(linkPath), /符号链接/);
      assert.throws(() => prepareJsonWrite(linkPath, { value: 2 }), /符号链接/);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
      const symbolicStat = {
        size: 12,
        isFile: () => true,
        isSymbolicLink: () => true,
      };
      const fileSystem = {
        ...fsSync,
        lstatSync: () => symbolicStat,
      };
      assert.throws(
        () => readRevisionedJson('C:/isolated/link.json', { fileSystem }),
        /符号链接/,
      );
      assert.throws(
        () => prepareJsonWrite('C:/isolated/link.json', { value: 2 }, { fileSystem }),
        /符号链接/,
      );
    }
  });
});

test('准备写入拒绝非普通目标并在替换前再次拒绝符号链接', async () => {
  await withTempDir('router-json-target-check-', async (tempDir) => {
    assert.throws(() => prepareJsonWrite(tempDir, { value: 1 }), /必须是普通文件/);

    const targetPath = path.join(tempDir, 'config.json');
    const original = Buffer.from('{"old":true}\n');
    await fs.writeFile(targetPath, original);
    let targetChecks = 0;
    const fileSystem = {
      ...fsSync,
      lstatSync(filePath) {
        const stat = fsSync.lstatSync(filePath);
        if (filePath !== targetPath) return stat;
        targetChecks += 1;
        if (targetChecks === 1) return stat;
        return {
          ...stat,
          isFile: () => true,
          isSymbolicLink: () => true,
        };
      },
    };
    const prepared = prepareJsonWrite(targetPath, { next: true }, { fileSystem });

    assert.throws(() => prepared.replace(), /符号链接/);
    assert.equal(fsSync.existsSync(prepared.tempPath), false);
    assert.deepEqual(await fs.readFile(targetPath), original);
  });
});

test('读取拒绝目录、非法 UTF-8 和非法 JSON', async () => {
  await withTempDir('router-json-invalid-', async (tempDir) => {
    assert.throws(() => readRevisionedJson(tempDir), /必须是普通文件/);

    const invalidUtf8 = path.join(tempDir, 'invalid-utf8.json');
    await fs.writeFile(invalidUtf8, Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x7d]));
    assert.throws(() => readRevisionedJson(invalidUtf8), /UTF-8/);

    const invalidJson = path.join(tempDir, 'invalid-json.json');
    await fs.writeFile(invalidJson, '{broken');
    assert.throws(() => readRevisionedJson(invalidJson), /JSON/);
  });
});

test('读取在 stat 和 read 两个阶段都执行大小上限', async () => {
  await withTempDir('router-json-limit-', async (tempDir) => {
    const filePath = path.join(tempDir, 'large.json');
    await fs.writeFile(filePath, '{"value":"too-large"}');
    assert.throws(() => readRevisionedJson(filePath, { maxBytes: 4 }), /超过大小上限/);

    let readCalled = false;
    const changingBytes = Buffer.from('{"value":1}');
    let position = 0;
    const fileStat = {
      size: 2,
      dev: 1,
      ino: 1,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    const changingFileSystem = {
      constants: fsSync.constants,
      lstatSync() { return fileStat; },
      openSync() { return 7; },
      fstatSync() { return fileStat; },
      readSync(_descriptor, buffer, offset, length) {
        readCalled = true;
        const count = Math.min(length, changingBytes.length - position);
        if (count <= 0) return 0;
        changingBytes.copy(buffer, offset, position, position + count);
        position += count;
        return count;
      },
      closeSync() {},
    };
    assert.throws(
      () => readRevisionedJson('C:/isolated/config.json', {
        fileSystem: changingFileSystem,
        maxBytes: 4,
      }),
      /超过大小上限/,
    );
    assert.equal(readCalled, true);
  });
});

test('准备写入使用同目录唯一临时文件、0600 权限和明确元数据', async () => {
  await withTempDir('router-json-prepare-', async (tempDir) => {
    const targetPath = path.join(tempDir, 'models.json');
    await fs.writeFile(targetPath, '{"old":true}\n');
    const opens = [];
    const fileSystem = {
      ...fsSync,
      openSync(filePath, flags, mode) {
        opens.push({ filePath, flags, mode });
        return fsSync.openSync(filePath, flags, mode);
      },
    };

    const first = prepareJsonWrite(targetPath, { value: 1 }, { fileSystem });
    const second = prepareJsonWrite(targetPath, { value: 2 }, { fileSystem });
    try {
      assert.notEqual(first.tempPath, second.tempPath);
      assert.equal(path.dirname(first.tempPath), tempDir);
      assert.match(path.basename(first.tempPath), /^models\.json\.tmp-\d+-[a-f0-9-]+$/);
      assert.equal(opens[0].mode, 0o600);
      assert.ok((opens[0].flags & fsSync.constants.O_CREAT) !== 0);
      assert.ok((opens[0].flags & fsSync.constants.O_EXCL) !== 0);
      assert.ok((opens[0].flags & fsSync.constants.O_WRONLY) !== 0);
      assert.deepEqual(first.bytes, encodeJson({ value: 1 }));
      assert.equal(first.revision, sha256Bytes(first.bytes));
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });
});

test('同步后替换目标且 cleanup 幂等并只处理自身临时文件', async () => {
  await withTempDir('router-json-replace-', async (tempDir) => {
    const targetPath = path.join(tempDir, 'config.json');
    const foreignPath = path.join(tempDir, 'config.json.tmp-foreign');
    await fs.writeFile(targetPath, '{"old":true}\n');
    await fs.writeFile(foreignPath, 'foreign');
    let syncOpenCount = 0;
    let fsyncCount = 0;
    const fileSystem = {
      ...fsSync,
      openSync(filePath, flags, ...rest) {
        if (typeof flags === 'number' && (flags & fsSync.constants.O_RDWR) !== 0) {
          syncOpenCount += 1;
        }
        return fsSync.openSync(filePath, flags, ...rest);
      },
      fsyncSync(...args) {
        fsyncCount += 1;
        return fsSync.fsyncSync(...args);
      },
    };
    const prepared = prepareJsonWrite(targetPath, { next: true }, { fileSystem });

    assert.equal(await fs.readFile(targetPath, 'utf8'), '{"old":true}\n');
    prepared.replace();

    assert.deepEqual(await fs.readFile(targetPath), prepared.bytes);
    assert.equal(await fs.readFile(foreignPath, 'utf8'), 'foreign');
    assert.equal(fsSync.existsSync(prepared.tempPath), false);
    assert.equal(syncOpenCount, 1);
    assert.equal(fsyncCount, 1);
  });
});

test('cleanup 第一次删除自身临时文件、第二次无操作且不伤目标', async () => {
  await withTempDir('router-json-cleanup-', async (tempDir) => {
    const targetPath = path.join(tempDir, 'config.json');
    const original = Buffer.from('{"old":true}\n');
    await fs.writeFile(targetPath, original);
    const prepared = prepareJsonWrite(targetPath, { next: true });

    assert.equal(fsSync.existsSync(prepared.tempPath), true);
    assert.equal(prepared.cleanup(), true);
    assert.equal(fsSync.existsSync(prepared.tempPath), false);
    assert.equal(prepared.cleanup(), false);
    assert.deepEqual(await fs.readFile(targetPath), original);
  });
});

test('sync 的 close 异常只关闭一次并清理临时文件', async () => {
  await withTempDir('router-json-close-failure-', async (tempDir) => {
    const targetPath = path.join(tempDir, 'config.json');
    const original = Buffer.from('{"old":true}\n');
    await fs.writeFile(targetPath, original);
    let closeCount = 0;
    const fileSystem = {
      ...fsSync,
      closeSync(descriptor) {
        closeCount += 1;
        if (closeCount === 2) throw new Error('close failed');
        return fsSync.closeSync(descriptor);
      },
    };
    const prepared = prepareJsonWrite(targetPath, { next: true }, { fileSystem });
    const closesBeforeSync = closeCount;

    assert.throws(() => prepared.sync(), /close failed/);
    assert.equal(closeCount - closesBeforeSync, 1);
    assert.equal(fsSync.existsSync(prepared.tempPath), false);
    assert.deepEqual(await fs.readFile(targetPath), original);
  });
});

test('temp 在 prepare 到 sync 之间被替换为符号链接时拒绝且不删除攻击者目录项', async () => {
  await withTempDir('router-json-temp-symlink-', async (tempDir) => {
    const targetPath = path.join(tempDir, 'config.json');
    const linkedFile = path.join(tempDir, 'attacker.json');
    await fs.writeFile(targetPath, '{"old":true}\n');
    await fs.writeFile(linkedFile, '{"attacker":true}\n');

    const prepared = prepareJsonWrite(targetPath, { next: true });
    await fs.unlink(prepared.tempPath);
    try {
      await fs.symlink(linkedFile, prepared.tempPath, 'file');
      assert.throws(() => prepared.sync(), /符号链接|临时文件已更换/);
      assert.equal((await fs.lstat(prepared.tempPath)).isSymbolicLink(), true);
      assert.equal(await fs.readFile(linkedFile, 'utf8'), '{"attacker":true}\n');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;

      let attacked = false;
      let attackerUnlinkCalled = false;
      const fileSystem = {
        ...fsSync,
        lstatSync(filePath) {
          const stat = fsSync.lstatSync(filePath);
          if (attacked && filePath.includes('.tmp-')) {
            return {
              ...stat,
              isFile: () => true,
              isSymbolicLink: () => true,
            };
          }
          return stat;
        },
        unlinkSync(filePath) {
          if (attacked && filePath.includes('.tmp-')) {
            attackerUnlinkCalled = true;
            return;
          }
          return fsSync.unlinkSync(filePath);
        },
      };
      const fallback = prepareJsonWrite(targetPath, { fallback: true }, { fileSystem });
      attacked = true;
      assert.throws(() => fallback.sync(), /符号链接|临时文件已更换/);
      assert.equal(attackerUnlinkCalled, false);
      await fs.rm(fallback.tempPath, { force: true });
    }
    assert.equal(await fs.readFile(targetPath, 'utf8'), '{"old":true}\n');
  });
});

test('temp 在 prepare 到 replace 之间被替换为其他文件时拒绝且不移动或删除外部文件', async () => {
  await withTempDir('router-json-temp-replaced-', async (tempDir) => {
    const targetPath = path.join(tempDir, 'config.json');
    const original = Buffer.from('{"old":true}\n');
    const attacker = Buffer.from('{"attacker":"external-object"}\n');
    await fs.writeFile(targetPath, original);
    const prepared = prepareJsonWrite(targetPath, { next: true });
    await fs.unlink(prepared.tempPath);
    await fs.writeFile(prepared.tempPath, attacker);

    assert.throws(() => prepared.replace(), /临时文件已更换/);
    assert.deepEqual(await fs.readFile(targetPath), original);
    assert.deepEqual(await fs.readFile(prepared.tempPath), attacker);
    assert.equal(prepared.cleanup(), false);
    assert.deepEqual(await fs.readFile(prepared.tempPath), attacker);
  });
});

test('复制后按实际字节校验 hash', async () => {
  await withTempDir('router-json-copy-', async (tempDir) => {
    const source = path.join(tempDir, 'source.json');
    const destination = path.join(tempDir, 'backup.json');
    const bytes = Buffer.from('{"value":1}\n');
    await fs.writeFile(source, bytes);

    const copied = copyAndVerify(source, destination, sha256Bytes(bytes));
    assert.deepEqual(copied.bytes, bytes);
    assert.equal(copied.revision, sha256Bytes(bytes));
    assert.deepEqual(await fs.readFile(destination), bytes);

    assert.throws(
      () => copyAndVerify(source, path.join(tempDir, 'wrong.json'), '0'.repeat(64)),
      /备份校验失败/,
    );
    assert.deepEqual(await fs.readFile(source), bytes);
  });
});

test('备份 copy、open、fsync、read 或 hash 失败都会清理本次 destination', async (t) => {
  for (const failure of ['copy', 'open', 'fsync', 'read', 'hash']) {
    await t.test(failure, async () => {
      await withTempDir(`router-json-copy-failure-${failure}-`, async (tempDir) => {
        const source = path.join(tempDir, 'source.json');
        const destination = path.join(tempDir, 'backup.json');
        const bytes = Buffer.from('{"value":1}\n');
        await fs.writeFile(source, bytes);
        const descriptorPaths = new Map();
        const fileSystem = {
          ...fsSync,
          copyFileSync(...args) {
            fsSync.copyFileSync(...args);
            if (failure === 'copy') throw new Error('copy failed');
          },
          openSync(filePath, ...args) {
            if (failure === 'open' && filePath === destination) throw new Error('open failed');
            const descriptor = fsSync.openSync(filePath, ...args);
            descriptorPaths.set(descriptor, filePath);
            return descriptor;
          },
          fsyncSync(descriptor) {
            if (failure === 'fsync') throw new Error('fsync failed');
            return fsSync.fsyncSync(descriptor);
          },
          readSync(descriptor, ...args) {
            if (failure === 'read' && descriptorPaths.get(descriptor) === destination) {
              throw new Error('read failed');
            }
            return fsSync.readSync(descriptor, ...args);
          },
          closeSync(descriptor) {
            descriptorPaths.delete(descriptor);
            return fsSync.closeSync(descriptor);
          },
        };
        const expectedHash = failure === 'hash' ? '0'.repeat(64) : sha256Bytes(bytes);

        assert.throws(
          () => copyAndVerify(source, destination, expectedHash, { fileSystem }),
          failure === 'hash' ? /备份校验失败/ : new RegExp(`${failure} failed`),
        );
        assert.equal(fsSync.existsSync(destination), false);
        assert.deepEqual(await fs.readFile(source), bytes);
      });
    });
  }
});

test('write、open、fsync 或 rename 失败只清理本次临时文件且保留原文件', async (t) => {
  for (const failure of ['write', 'open', 'fsync', 'rename']) {
    await t.test(failure, async () => {
      await withTempDir(`router-json-failure-${failure}-`, async (tempDir) => {
        const targetPath = path.join(tempDir, 'models.json');
        const original = Buffer.from('{"original":true}\n');
        await fs.writeFile(targetPath, original);
        let openCount = 0;
        const fileSystem = {
          ...fsSync,
          writeSync(...args) {
            const count = fsSync.writeSync(...args);
            if (failure === 'write') throw new Error('write failed');
            return count;
          },
          openSync(...args) {
            openCount += 1;
            if (failure === 'open' && openCount === 2) throw new Error('open failed');
            return fsSync.openSync(...args);
          },
          fsyncSync(descriptor) {
            if (failure === 'fsync') throw new Error('fsync failed');
            return fsSync.fsyncSync(descriptor);
          },
          renameSync(...args) {
            if (failure === 'rename') throw new Error('rename failed');
            return fsSync.renameSync(...args);
          },
        };

        if (failure === 'write') {
          assert.throws(
            () => prepareJsonWrite(targetPath, { replacement: true }, { fileSystem }),
            /write failed/,
          );
        } else {
          const prepared = prepareJsonWrite(targetPath, { replacement: true }, { fileSystem });
          assert.throws(
            () => failure === 'rename' ? prepared.replace() : prepared.sync(),
            new RegExp(`${failure} failed`),
          );
        }

        assert.deepEqual(await fs.readFile(targetPath), original);
        const leftovers = (await fs.readdir(tempDir)).filter((name) => name.includes('.tmp-'));
        assert.deepEqual(leftovers, []);
      });
    });
  }
});

test('条件提交按 expected revision 保存并留下可验证的原始字节备份', async () => {
  await withTempDir('router-json-commit-', async (tempDir) => {
    const targetPath = path.join(tempDir, 'config.json');
    const original = Buffer.from('{"old":true,"spacing":"kept"}\n');
    await fs.writeFile(targetPath, original);
    const expectedRevision = sha256Bytes(original);
    let fsyncCount = 0;
    const fileSystem = {
      ...fsSync,
      fsyncSync(...args) {
        fsyncCount += 1;
        return fsSync.fsyncSync(...args);
      },
    };

    const committed = commitRevisionedJson(
      targetPath,
      { next: true },
      expectedRevision,
      { fileSystem },
    );

    assert.equal(committed.previousRevision, expectedRevision);
    assert.equal(committed.revision, sha256Bytes(encodeJson({ next: true })));
    assert.equal(committed.backupPath, `${targetPath}.bak`);
    assert.deepEqual(await fs.readFile(targetPath), encodeJson({ next: true }));
    assert.deepEqual(await fs.readFile(committed.backupPath), original);
    assert.equal(readRevisionedJson(committed.backupPath).revision, expectedRevision);
    assert.ok(fsyncCount >= 2, '新文件和备份都必须 fsync');

    const firstCommittedBytes = encodeJson({ next: true });
    const second = commitRevisionedJson(
      targetPath,
      { final: true },
      committed.revision,
      { fileSystem },
    );
    assert.deepEqual(await fs.readFile(targetPath), encodeJson({ final: true }));
    assert.deepEqual(await fs.readFile(second.backupPath), firstCommittedBytes);
  });
});

test('条件提交在 revision 已变化时返回稳定冲突并完全不写文件', async () => {
  await withTempDir('router-json-commit-conflict-', async (tempDir) => {
    const targetPath = path.join(tempDir, 'config.json');
    const current = Buffer.from('{"current":true}\n');
    await fs.writeFile(targetPath, current);

    assert.throws(
      () => commitRevisionedJson(targetPath, { next: true }, '0'.repeat(64)),
      (error) => error?.code === 'revision_conflict',
    );
    assert.deepEqual(await fs.readFile(targetPath), current);
    assert.equal(fsSync.existsSync(`${targetPath}.bak`), false);
    assert.deepEqual(
      (await fs.readdir(tempDir)).filter((name) => name.includes('.tmp-')),
      [],
    );
  });
});

test('条件提交在备份后检测外部替换、符号链接和同 inode revision 变化', async (t) => {
  for (const change of ['replacement', 'replacement-same-revision', 'symlink', 'revision']) {
    await t.test(change, async () => {
      await withTempDir(`router-json-commit-race-${change}-`, async (tempDir) => {
        const targetPath = path.join(tempDir, 'config.json');
        const original = Buffer.from('{"original":true}\n');
        const concurrent = Buffer.from(`{"concurrent":"${change}"}\n`);
        await fs.writeFile(targetPath, original);
        let changed = false;
        const fileSystem = {
          ...fsSync,
          copyFileSync(source, destination, flags) {
            fsSync.copyFileSync(source, destination, flags);
            if (source !== targetPath || changed) return;
            changed = true;
            if (change === 'replacement' || change === 'replacement-same-revision') {
              fsSync.renameSync(targetPath, path.join(tempDir, 'displaced.json'));
              fsSync.writeFileSync(
                targetPath,
                change === 'replacement-same-revision' ? original : concurrent,
              );
            } else if (change === 'revision') {
              fsSync.writeFileSync(targetPath, concurrent);
            }
          },
          lstatSync(filePath) {
            const stat = fsSync.lstatSync(filePath);
            if (change === 'symlink' && changed && filePath === targetPath) {
              return {
                ...stat,
                isFile: () => true,
                isSymbolicLink: () => true,
              };
            }
            return stat;
          },
        };

        assert.throws(
          () => commitRevisionedJson(
            targetPath,
            { next: true },
            sha256Bytes(original),
            { fileSystem },
          ),
          change === 'symlink'
            ? /符号链接/
            : (error) => error?.code === 'revision_conflict',
        );
        assert.deepEqual(
          await fs.readFile(targetPath),
          ['symlink', 'replacement-same-revision'].includes(change) ? original : concurrent,
        );
        if (change === 'replacement-same-revision') {
          assert.deepEqual(await fs.readFile(`${targetPath}.bak`), original);
        } else {
          assert.equal(fsSync.existsSync(`${targetPath}.bak`), false);
        }
        assert.deepEqual(
          (await fs.readdir(tempDir)).filter((name) => name.includes('.tmp-')),
          [],
        );
      });
    });
  }
});

test('条件提交的备份或目标 rename 失败时保留当前文件并清理自有临时文件', async (t) => {
  for (const failure of ['backup', 'rename']) {
    await t.test(failure, async () => {
      await withTempDir(`router-json-commit-failure-${failure}-`, async (tempDir) => {
        const targetPath = path.join(tempDir, 'config.json');
        const original = Buffer.from('{"original":true}\n');
        await fs.writeFile(targetPath, original);
        const fileSystem = {
          ...fsSync,
          copyFileSync(...args) {
            fsSync.copyFileSync(...args);
            if (failure === 'backup') throw new Error('backup failed');
          },
          renameSync(source, destination) {
            if (failure === 'rename' && destination === targetPath) {
              throw new Error('rename failed');
            }
            return fsSync.renameSync(source, destination);
          },
        };

        assert.throws(
          () => commitRevisionedJson(
            targetPath,
            { next: true },
            sha256Bytes(original),
            { fileSystem },
          ),
          new RegExp(`${failure} failed`),
        );
        assert.deepEqual(await fs.readFile(targetPath), original);
        assert.deepEqual(
          (await fs.readdir(tempDir)).filter((name) => name.includes('.tmp-')),
          [],
        );
        if (failure === 'rename') {
          assert.deepEqual(await fs.readFile(`${targetPath}.bak`), original);
        } else {
          assert.equal(fsSync.existsSync(`${targetPath}.bak`), false);
        }
      });
    });
  }
});
