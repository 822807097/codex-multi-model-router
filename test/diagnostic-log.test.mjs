import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDiagnosticLog } from '../lib/diagnostic-log.mjs';

async function withTempDir(prefix, run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('诊断日志只写入白名单字段并生成逐行 JSON', async () => {
  await withTempDir('router-diagnostic-log-', async (tempDir) => {
    const logPath = path.join(tempDir, 'router.log');
    const fixedNow = Date.parse('2026-08-11T12:00:00.000Z');
    const logger = createDiagnosticLog({ filePath: logPath, now: () => fixedNow });

    logger.write({
      event: 'request.received',
      request_id: 'req_1\r\nforged',
      model: `model-${'x'.repeat(400)}`,
      method: 'POST',
      path: '/v1/responses?token=SHOULD_NOT_APPEAR',
      body_bytes: 321,
      input_items: 4,
      has_previous_response_id: true,
      role_counts: { user: 2, assistant: 1, nested: { secret: true } },
      authorization: 'Bearer SECRET_AUTHORIZATION',
      prompt: 'SECRET_PROMPT',
      error: { message: 'SECRET_ERROR_BODY' },
    });
    await logger.flush();

    const text = await fs.readFile(logPath, 'utf8');
    const lines = text.trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.ts, '2026-08-11T12:00:00.000Z');
    assert.equal(entry.event, 'request.received');
    assert.equal(entry.request_id, 'req_1 forged');
    assert.equal(entry.path, '/v1/responses');
    assert.equal(entry.body_bytes, 321);
    assert.deepEqual(entry.role_counts, { user: 2, assistant: 1 });
    assert.ok(entry.model.length <= 256);
    assert.equal(Object.hasOwn(entry, 'authorization'), false);
    assert.equal(Object.hasOwn(entry, 'prompt'), false);
    assert.equal(Object.hasOwn(entry, 'error'), false);
    assert.doesNotMatch(text, /SECRET_AUTHORIZATION|SECRET_PROMPT|SECRET_ERROR_BODY|SHOULD_NOT_APPEAR/);
  });
});

test('诊断日志按 UTC 日期轮转并只删除超过 72 小时的同基名归档', async () => {
  await withTempDir('router-diagnostic-retention-', async (tempDir) => {
    const logPath = path.join(tempDir, 'router.log');
    const oldArchive = path.join(tempDir, 'router.2026-08-07.log');
    const boundaryArchive = path.join(tempDir, 'router.2026-08-08.log');
    const recentArchive = path.join(tempDir, 'router.2026-08-10.log');
    const unrelated = path.join(tempDir, 'unrelated.2026-08-01.log');
    await Promise.all([
      fs.writeFile(logPath, 'old active\n'),
      fs.writeFile(oldArchive, 'expired\n'),
      fs.writeFile(boundaryArchive, 'boundary\n'),
      fs.writeFile(recentArchive, 'recent\n'),
      fs.writeFile(unrelated, 'unrelated\n'),
    ]);
    await fs.utimes(logPath, new Date('2026-08-09T18:00:00.000Z'), new Date('2026-08-09T18:00:00.000Z'));
    await fs.utimes(oldArchive, new Date('2026-08-08T11:59:59.000Z'), new Date('2026-08-08T11:59:59.000Z'));
    await fs.utimes(boundaryArchive, new Date('2026-08-08T12:00:00.000Z'), new Date('2026-08-08T12:00:00.000Z'));
    await fs.utimes(recentArchive, new Date('2026-08-10T12:00:00.000Z'), new Date('2026-08-10T12:00:00.000Z'));
    await fs.utimes(unrelated, new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-01T00:00:00.000Z'));

    const fixedNow = Date.parse('2026-08-11T12:00:00.000Z');
    const logger = createDiagnosticLog({
      filePath: logPath,
      now: () => fixedNow,
      cleanupIntervalMs: 0,
    });
    logger.write({ event: 'request.received', request_id: 'req_rotation' });
    await logger.flush();

    const files = (await fs.readdir(tempDir)).sort();
    assert.deepEqual(files, [
      'router.2026-08-08.log',
      'router.2026-08-09.log',
      'router.2026-08-10.log',
      'router.log',
      'unrelated.2026-08-01.log',
    ]);
    assert.equal(await fs.readFile(path.join(tempDir, 'router.2026-08-09.log'), 'utf8'), 'old active\n');
    assert.match(await fs.readFile(logPath, 'utf8'), /"request_id":"req_rotation"/);
  });
});

test('活动日志超过大小上限时使用同日递增序号归档', async () => {
  await withTempDir('router-diagnostic-size-', async (tempDir) => {
    const logPath = path.join(tempDir, 'router.log');
    await fs.writeFile(logPath, '0123456789ABCDEF');
    await fs.writeFile(path.join(tempDir, 'router.2026-08-11.log'), 'existing');
    const sameDay = new Date('2026-08-11T08:00:00.000Z');
    await fs.utimes(logPath, sameDay, sameDay);

    const logger = createDiagnosticLog({
      filePath: logPath,
      maxBytes: 8,
      now: () => sameDay.getTime(),
      cleanupIntervalMs: 0,
    });
    logger.write({ event: 'request.received', request_id: 'req_size' });
    await logger.flush();

    const files = (await fs.readdir(tempDir)).sort();
    assert.deepEqual(files, [
      'router.2026-08-11.1.log',
      'router.2026-08-11.log',
      'router.log',
    ]);
    assert.equal(await fs.readFile(path.join(tempDir, 'router.2026-08-11.1.log'), 'utf8'), '0123456789ABCDEF');
    assert.match(await fs.readFile(logPath, 'utf8'), /"request_id":"req_size"/);
  });
});

test('追加内容会跨过大小上限时先轮转现有活动文件', async () => {
  await withTempDir('router-diagnostic-boundary-', async (tempDir) => {
    const logPath = path.join(tempDir, 'router.log');
    const sameDay = new Date('2026-08-11T08:00:00.000Z');
    await fs.writeFile(logPath, '{"old":true}\n');
    await fs.utimes(logPath, sameDay, sameDay);

    const logger = createDiagnosticLog({
      filePath: logPath,
      maxBytes: 64,
      now: () => sameDay.getTime(),
      cleanupIntervalMs: 0,
    });
    logger.write({ event: 'request.received', request_id: 'req_crosses_boundary' });
    await logger.flush();

    assert.equal(
      await fs.readFile(path.join(tempDir, 'router.2026-08-11.log'), 'utf8'),
      '{"old":true}\n',
    );
    const activeText = await fs.readFile(logPath, 'utf8');
    assert.match(activeText, /"request_id":"req_crosses_boundary"/);
    assert.doesNotMatch(activeText, /"old":true/);
  });
});

test('首次写入时把同日旧版文本日志归档以保持活动文件为纯 JSONL', async () => {
  await withTempDir('router-diagnostic-legacy-', async (tempDir) => {
    const logPath = path.join(tempDir, 'router.log');
    const sameDay = new Date('2026-08-11T08:00:00.000Z');
    await fs.writeFile(logPath, '[2026-08-11T07:59:00.000Z] REQ legacy text\n');
    await fs.utimes(logPath, sameDay, sameDay);

    const logger = createDiagnosticLog({
      filePath: logPath,
      now: () => sameDay.getTime(),
      cleanupIntervalMs: 0,
    });
    logger.write({ event: 'request.received', request_id: 'req_json_only' });
    await logger.flush();

    assert.match(
      await fs.readFile(path.join(tempDir, 'router.2026-08-11.log'), 'utf8'),
      /REQ legacy text/,
    );
    const activeText = await fs.readFile(logPath, 'utf8');
    assert.equal(activeText.trim().split(/\r?\n/).length, 1);
    assert.equal(JSON.parse(activeText).request_id, 'req_json_only');
  });
});
