import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { inspectRouterConfig } from './router-config.mjs';
import { resolveProvider } from './provider-adapters.mjs';
import { upstreamModel } from './chat-request.mjs';
import { readRevisionedJson } from './json-file-store.mjs';
import {
  exposeModelRoutingState,
  inspectModelRoutingPlan,
} from './model-routing-plan.mjs';
import { createModelRoutingTransaction } from './model-routing-transaction.mjs';

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_ADMIN_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PLACEHOLDER_TOKENS = 512;
const MAX_SECRET_DELETE_TOKENS = 64;
const MAX_MODEL_ROUTING_CONFIRMATIONS = 128;
const MODEL_ROUTING_CONFIRMATION_TTL_MS = 60_000;
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
]);

function sensitiveHeadersForTarget(target) {
  const names = new Set(SENSITIVE_HEADERS);
  // 自定义认证头与常见认证头同样必须脱敏，不能因为换了名称就进入浏览器。
  for (const name of [target?.authHeader, target?.auth?.header]) {
    if (typeof name === 'string' && name.trim()) names.add(name.trim().toLowerCase());
  }
  return names;
}

function jsonPointer(segments) {
  return `/${segments.map((segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function configIssue(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertOnlyFields(value, allowed, label) {
  if (!plainObject(value)) throw configIssue('request_invalid', `${label}必须是对象`);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw configIssue('request_invalid', `${label}含未知字段`);
}

function validRevision(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function modelRoutingRequest(payload, allowConfirmation) {
  const allowed = new Set(['configRevision', 'catalogRevision', 'operations']);
  if (allowConfirmation) allowed.add('confirmation');
  assertOnlyFields(payload, allowed, '模型路由请求');
  if (!validRevision(payload.configRevision) || !validRevision(payload.catalogRevision)) {
    throw configIssue('request_invalid', 'configRevision 和 catalogRevision 必须是有效 revision');
  }
  if (!Array.isArray(payload.operations)) {
    throw configIssue('request_invalid', 'operations 必须是数组');
  }
  if (
    Object.hasOwn(payload, 'confirmation')
    && typeof payload.confirmation !== 'string'
  ) {
    throw configIssue('request_invalid', 'confirmation 必须是字符串');
  }
  return payload;
}

function publicPlan(plan) {
  return {
    errors: plan.errors,
    warnings: plan.warnings,
    impact: plan.impact,
    operationDigest: plan.operationDigest,
  };
}

function operationPlanError(plan) {
  return plan.errors.find((issue) => (
    issue.path === '/operations'
    || issue.code === 'operation_invalid'
    || issue.code === 'operation_kind_unknown'
    || issue.code === 'target_ref_invalid'
    || issue.code === 'operation_sensitive_field'
    || issue.code === 'sensitive_field_forbidden'
  ));
}

function operationErrorResponse(res, issue) {
  const messages = {
    operation_kind_unknown: '操作 kind 无效',
    target_ref_invalid: 'targetRef 已失效或不存在',
    target_create_not_dedicated: '新增 target 必须精确绑定唯一模型',
    target_not_dedicated: '只能删除唯一模型拥有的精确专属 target',
    operation_sensitive_field: '操作含禁止的敏感字段',
    sensitive_field_forbidden: '操作含禁止的敏感字段',
  };
  jsonResponse(res, 400, {
    error: {
      code: issue.code,
      message: messages[issue.code] || '操作无效',
    },
  });
}

function destructiveImpact(impact) {
  return impact.models.deleted.length > 0
    || impact.targets.deleted.length > 0
    || impact.references.removed.length > 0
    || impact.references.replaced.length > 0
    || impact.models.updated.some((item) => item.from !== item.to);
}

function safeTxid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)
    ? value
    : null;
}

function setBounded(map, key, value, maxEntries) {
  // 重复 revision 视为最近访问，避免活跃页面的确认值先于旧页面被淘汰。
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) map.delete(map.keys().next().value);
}

function sensitiveValues(root) {
  const found = new Map();
  const walk = (value, segments, parentKey, sensitiveHeaders = SENSITIVE_HEADERS) => {
    if (Array.isArray(value)) {
      // 配置中的 targets 等集合也要继续递归，避免数组内的敏感请求头泄漏到管理页。
      value.forEach((child, index) => walk(
        child,
        [...segments, index],
        parentKey,
        parentKey === 'targets' ? sensitiveHeadersForTarget(child) : sensitiveHeaders,
      ));
      return;
    }
    if (!value || typeof value !== 'object') {
      if (parentKey === 'headers' && sensitiveHeaders.has(String(segments.at(-1)).toLowerCase())) {
        found.set(jsonPointer(segments), value);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (parentKey === 'headers' && sensitiveHeaders.has(key.toLowerCase())) {
        found.set(jsonPointer([...segments, key]), child);
      } else {
        walk(child, [...segments, key], key === 'headers' ? 'headers' : key, sensitiveHeaders);
      }
    }
  };
  walk(root, [], '');
  return found;
}

function setAtPointer(root, pointer, value) {
  const segments = pointerSegments(pointer);
  let cursor = root;
  for (const segment of segments.slice(0, -1)) cursor = cursor[segment];
  cursor[segments.at(-1)] = value;
}

function pointerSegments(pointer) {
  return pointer.slice(1).split('/').map((segment) => (
    segment.replace(/~1/g, '/').replace(/~0/g, '~')
  ));
}

function deleteAtPointer(root, pointer) {
  const segments = pointerSegments(pointer);
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) return false;
    cursor = cursor[segment];
  }
  const last = segments.at(-1);
  if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, last)) return false;
  if (Array.isArray(cursor) && /^(0|[1-9]\d*)$/.test(last)) {
    cursor.splice(Number(last), 1);
  } else {
    delete cursor[last];
  }
  return true;
}

function getAtPointer(root, pointer) {
  const segments = pointerSegments(pointer);
  let cursor = root;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function readLimitedJson(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_CONFIG_BYTES) throw configIssue('config_too_large', '配置文件超过大小上限');
  const bytes = fs.readFileSync(filePath);
  if (bytes.length > MAX_CONFIG_BYTES) throw configIssue('config_too_large', '配置文件超过大小上限');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { bytes, config: JSON.parse(text), revision: sha256(bytes) };
}

async function readJsonBody(req, maxBytes = MAX_ADMIN_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      if (tooLarge) continue;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        // 超限后释放已缓存引用，但继续排空请求流，以便稳定复用 keep-alive 连接。
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
  } catch {
    throw configIssue('admin_body_incomplete', '管理请求体未完整接收');
  }
  if (tooLarge) throw configIssue('admin_body_too_large', '管理请求体超过大小上限');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text || '{}');
  } catch {
    throw configIssue('invalid_json', '管理请求体必须是有效 UTF-8 JSON');
  }
}

function atomicWriteConfig(configPath, config) {
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const tempPath = `${configPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const backupPath = `${configPath}.bak`;
  try {
    fs.writeFileSync(tempPath, text, { mode: 0o600 });
    const descriptor = fs.openSync(tempPath, 'r+');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
    fs.renameSync(tempPath, configPath);
  } catch (error) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* 精确临时文件清理失败不掩盖原错误 */ }
    throw error;
  }
  return sha256(Buffer.from(text));
}

export function createAdminHandler(options) {
  const placeholderTokens = new Map();
  const secretDeleteTokens = new Map();
  const modelRoutingConfirmations = new Map();
  let checkpointConfirmation = null;
  const webAssets = new Map([
    ['/admin', ['index.html', 'text/html; charset=utf-8']],
    ['/admin/', ['index.html', 'text/html; charset=utf-8']],
    ['/admin/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/admin/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/admin/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/admin/config-state.mjs', ['config-state.mjs', 'text/javascript; charset=utf-8']],
    ['/admin/model-routing-state.mjs', ['model-routing-state.mjs', 'text/javascript; charset=utf-8']],
    ['/_admin/model-routing-state.mjs', ['model-routing-state.mjs', 'text/javascript; charset=utf-8']],
  ]);

  function context() {
    return {
      configPath: options.configPath,
      baseDir: path.dirname(options.configPath),
      defaultCodexHome: options.defaultCodexHome,
      env: options.env || {},
    };
  }

  function exposeConfig() {
    const current = readLimitedJson(options.configPath);
    const config = structuredClone(current.config);
    for (const pointer of sensitiveValues(current.config).keys()) {
      const token = crypto.randomUUID();
      // 令牌只记录校验所需元数据，不在内存缓存中重复保留原始敏感值。
      setBounded(placeholderTokens, token, {
        revision: current.revision,
        pointer,
      }, MAX_PLACEHOLDER_TOKENS);
      setAtPointer(config, pointer, { $preserveSecret: token });
    }
    const secretDeleteConfirmation = crypto.randomUUID();
    setBounded(
      secretDeleteTokens,
      current.revision,
      secretDeleteConfirmation,
      MAX_SECRET_DELETE_TOKENS,
    );
    return {
      revision: current.revision,
      config,
      secretDeleteConfirmation,
    };
  }

  function restoreSecrets(payload, current) {
    if (!payload || payload.revision !== current.revision) {
      throw configIssue('revision_conflict', '配置已被其他页面或进程修改，请重新载入');
    }
    if (!payload.config || typeof payload.config !== 'object' || Array.isArray(payload.config)) {
      throw configIssue('config_invalid', 'config 必须是对象');
    }
    const restored = structuredClone(payload.config);
    const deletes = new Set(Array.isArray(payload.secretDeletes) ? payload.secretDeletes : []);
    const currentSecrets = sensitiveValues(current.config);
    // 第一版管理页只允许保留或确认删除已有敏感头，不能借请求体新增明文凭据。
    for (const pointer of sensitiveValues(restored).keys()) {
      if (!currentSecrets.has(pointer)) {
        throw configIssue('secret_field_add_forbidden', `管理页不能新增敏感字段：${pointer}`);
      }
    }
    if (deletes.size > 0 && payload.secretDeleteConfirmation !== secretDeleteTokens.get(current.revision)) {
      throw configIssue('secret_delete_confirmation_invalid', '敏感字段删除确认值无效');
    }
    for (const [pointer, originalValue] of currentSecrets) {
      if (deletes.has(pointer)) {
        if (!deleteAtPointer(restored, pointer)) {
          throw configIssue('secret_delete_invalid', `待删除敏感字段不存在：${pointer}`);
        }
        deletes.delete(pointer);
        continue;
      }
      const placeholder = getAtPointer(restored, pointer);
      const token = placeholder?.$preserveSecret;
      const record = typeof token === 'string' ? placeholderTokens.get(token) : null;
      if (
        !record
        || record.revision !== current.revision
        || record.pointer !== pointer
      ) {
        throw configIssue('secret_placeholder_invalid', `敏感字段占位无效：${pointer}`);
      }
      setAtPointer(restored, pointer, structuredClone(originalValue));
    }
    if (deletes.size > 0) {
      throw configIssue('secret_delete_invalid', `待删除敏感字段无效：${[...deletes][0]}`);
    }
    // 正常保留已还原原值，显式删除也已移除字段；任何剩余占位都不得进入预检或磁盘。
    const scan = (value) => {
      if (!value || typeof value !== 'object') return;
      if (!Array.isArray(value) && Object.hasOwn(value, '$preserveSecret')) {
        throw configIssue('secret_placeholder_invalid', '发现残留的敏感字段占位');
      }
      for (const child of Object.values(value)) scan(child);
    };
    scan(restored);
    return restored;
  }

  function statusBody() {
    return {
      port: options.runtime?.port,
      configPath: options.configPath,
      startedAt: options.startedAt,
      uptimeMs: Math.max(0, Date.now() - options.startedAt),
      warningCount: options.warnings?.length || 0,
      persistence: options.persistence?.status?.() || { mode: 'disabled' },
      targets: (options.targets || []).map((target) => {
        const provider = resolveProvider(target);
        return {
          name: target.name,
          match: target.matchSource || target.match,
          wireApi: provider.wireApi,
          upstreamModel: upstreamModel(target, ''),
          viaProxy: target.viaProxy === true,
          envKey: target.envKey || null,
          envSet: target.useOpenAiAuth === true
            || Boolean(target.envKey && Object.hasOwn(options.env || {}, target.envKey)
              && options.env[target.envKey]),
        };
      }),
    };
  }

  function checkpointBody() {
    const snapshot = options.checkpointStore.exportSnapshot();
    const expirations = snapshot.entries.map((entry) => entry.expiresAt).filter(Number.isFinite);
    checkpointConfirmation = {
      token: crypto.randomUUID(),
      expiresAt: Date.now() + 60_000,
    };
    return {
      count: snapshot.entries.length,
      bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      earliestExpiresAt: expirations.length ? Math.min(...expirations) : null,
      latestExpiresAt: expirations.length ? Math.max(...expirations) : null,
      mode: options.persistence?.status?.().mode || 'disabled',
      confirmation: checkpointConfirmation.token,
    };
  }

  function readModelRoutingFiles() {
    if (typeof options.catalogPath !== 'string' || options.catalogPath === '') {
      throw configIssue('model_routing_unavailable', '模型目录路径未配置');
    }
    try {
      return {
        config: readRevisionedJson(options.configPath, { maxBytes: MAX_CONFIG_BYTES }),
        catalog: readRevisionedJson(options.catalogPath, { maxBytes: MAX_CATALOG_BYTES }),
      };
    } catch {
      // 文件路径和底层异常正文不进入联合管理 API。
      throw configIssue('model_routing_read_failed', '无法读取模型路由文件');
    }
  }

  function assertCurrentRevisions(payload, current) {
    if (
      payload.configRevision !== current.config.revision
      || payload.catalogRevision !== current.catalog.revision
    ) {
      throw configIssue('revision_conflict', '模型路由文件已被其他页面或进程修改，请重新载入');
    }
  }

  function inspectCurrentModelRouting(current, operations) {
    return inspectModelRoutingPlan({
      catalog: current.catalog.value,
      config: current.config.value,
      configRevision: current.config.revision,
      operations,
      context: context(),
    });
  }

  function confirmationFor(current, plan) {
    const now = (options.now || Date.now)();
    const token = (options.randomUUID || crypto.randomUUID)();
    const record = {
      configRevision: current.config.revision,
      catalogRevision: current.catalog.revision,
      operationDigest: plan.operationDigest,
      expiresAt: now + MODEL_ROUTING_CONFIRMATION_TTL_MS,
    };
    setBounded(
      modelRoutingConfirmations,
      token,
      record,
      MAX_MODEL_ROUTING_CONFIRMATIONS,
    );
    return { token, expiresAt: record.expiresAt };
  }

  function consumeConfirmation(payload, plan) {
    const record = modelRoutingConfirmations.get(payload.confirmation);
    const now = (options.now || Date.now)();
    if (
      !record
      || record.expiresAt <= now
      || record.configRevision !== payload.configRevision
      || record.catalogRevision !== payload.catalogRevision
      || record.operationDigest !== plan.operationDigest
    ) {
      if (record?.expiresAt <= now) modelRoutingConfirmations.delete(payload.confirmation);
      throw configIssue('confirmation_invalid', '破坏性操作确认值无效或已过期');
    }
    // 在任何 await 前同步消费，避免两个并发请求同时通过一次性校验。
    modelRoutingConfirmations.delete(payload.confirmation);
  }

  function transactionErrorResponse(res, error) {
    if (error?.code === 'revision_conflict') {
      jsonResponse(res, 409, {
        error: { code: 'revision_conflict', message: '模型路由文件已被外部修改' },
      });
      return;
    }
    if (error?.code === 'transaction_rolled_back') {
      jsonResponse(res, 409, {
        error: { code: 'transaction_rolled_back', message: '事务失败并已安全回滚' },
      });
      return;
    }
    if (error?.code === 'transaction_in_doubt') {
      const txid = safeTxid(error.txid);
      jsonResponse(res, 500, {
        error: {
          code: 'transaction_in_doubt',
          ...(txid ? { txid } : {}),
        },
      });
      return;
    }
    const code = new Set(['transaction_failed', 'invalid_transaction_paths']).has(error?.code)
      ? error.code
      : 'transaction_failed';
    jsonResponse(res, 500, {
      error: { code, message: '模型路由事务未提交' },
    });
  }

  async function handleApi(req, res, url) {
    if (req.method === 'GET' && url === '/_admin/api/status') {
      jsonResponse(res, 200, statusBody());
      return true;
    }
    if (req.method === 'GET' && url === '/_admin/api/config') {
      jsonResponse(res, 200, exposeConfig());
      return true;
    }
    if (req.method === 'GET' && url === '/_admin/api/model-routing') {
      const current = readModelRoutingFiles();
      const plan = inspectCurrentModelRouting(current, []);
      const exposed = exposeModelRoutingState(
        current.catalog.value,
        current.config.value,
        current.config.revision,
        options.env || {},
      );
      jsonResponse(res, 200, {
        configRevision: current.config.revision,
        catalogRevision: current.catalog.revision,
        ...exposed,
        errors: plan.errors,
        warnings: plan.warnings,
      });
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/model-routing/validate') {
      const payload = modelRoutingRequest(await readJsonBody(req), false);
      const current = readModelRoutingFiles();
      assertCurrentRevisions(payload, current);
      const plan = inspectCurrentModelRouting(current, payload.operations);
      const invalidOperation = operationPlanError(plan);
      if (invalidOperation) {
        operationErrorResponse(res, invalidOperation);
        return true;
      }
      const response = publicPlan(plan);
      if (
        plan.errors.length === 0
        && plan.operationDigest
        && destructiveImpact(plan.impact)
      ) {
        response.confirmation = confirmationFor(current, plan);
      }
      jsonResponse(res, 200, response);
      return true;
    }
    if (req.method === 'PUT' && url === '/_admin/api/model-routing') {
      const payload = modelRoutingRequest(await readJsonBody(req), true);
      const current = readModelRoutingFiles();
      assertCurrentRevisions(payload, current);
      // 保存时必须重新从双文件计算，不能信任此前 validate 的结果。
      const plan = inspectCurrentModelRouting(current, payload.operations);
      const invalidOperation = operationPlanError(plan);
      if (invalidOperation) {
        operationErrorResponse(res, invalidOperation);
        return true;
      }
      if (plan.errors.length > 0) {
        jsonResponse(res, 422, publicPlan(plan));
        return true;
      }
      if (destructiveImpact(plan.impact)) consumeConfirmation(payload, plan);
      const transactionFactory = options.transactionFactory || createModelRoutingTransaction;
      try {
        const committed = await transactionFactory({
          configPath: options.configPath,
          catalogPath: options.catalogPath,
        }).commit({
          configRevision: current.config.revision,
          catalogRevision: current.catalog.revision,
          config: plan.config,
          catalog: plan.catalog,
        });
        if (
          !validRevision(committed?.configRevision)
          || !validRevision(committed?.catalogRevision)
          || !safeTxid(committed?.txid)
        ) {
          throw configIssue('transaction_failed', '模型路由事务返回值无效');
        }
        jsonResponse(res, 200, {
          configRevision: committed.configRevision,
          catalogRevision: committed.catalogRevision,
          txid: committed.txid,
          warnings: plan.warnings,
          restartRequired: true,
          clientRestartRequired: true,
        });
      } catch (error) {
        transactionErrorResponse(res, error);
      }
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/config/validate') {
      const payload = await readJsonBody(req);
      const current = readLimitedJson(options.configPath);
      const config = restoreSecrets(payload, current);
      const result = inspectRouterConfig(config, context());
      jsonResponse(res, 200, result);
      return true;
    }
    if (req.method === 'PUT' && url === '/_admin/api/config') {
      const payload = await readJsonBody(req);
      const current = readLimitedJson(options.configPath);
      const config = restoreSecrets(payload, current);
      const inspected = inspectRouterConfig(config, context());
      if (inspected.errors.length) {
        jsonResponse(res, 422, inspected);
        return true;
      }
      const revision = atomicWriteConfig(options.configPath, config);
      jsonResponse(res, 200, {
        revision,
        warnings: inspected.warnings,
        restartRequired: true,
      });
      return true;
    }
    if (req.method === 'GET' && url === '/_admin/api/checkpoints') {
      jsonResponse(res, 200, checkpointBody());
      return true;
    }
    if (req.method === 'DELETE' && url === '/_admin/api/checkpoints') {
      const payload = await readJsonBody(req);
      if (
        !checkpointConfirmation
        || checkpointConfirmation.expiresAt < Date.now()
        || payload.confirmation !== checkpointConfirmation.token
      ) {
        jsonResponse(res, 409, {
          error: { code: 'confirmation_invalid', message: '检查点清空确认值无效或已过期' },
        });
        return true;
      }
      checkpointConfirmation = null;
      if (options.persistence?.status?.().mode === 'readonly') {
        jsonResponse(res, 409, {
          error: { code: 'persistence_readonly', message: '当前实例未持有持久化写锁' },
        });
        return true;
      }
      try {
        const result = options.persistence?.clearRecoverably
          ? await options.persistence.clearRecoverably()
          : {
            removed: options.checkpointStore.clear(),
            backupPath: null,
            recoveryHint: '未启用持久化，仅清空当前内存检查点',
          };
        jsonResponse(res, 200, {
          ok: true,
          removed: result.removed,
          backupPath: result.backupPath,
          recoveryHint: result.recoveryHint,
        });
      } catch (error) {
        const status = error.code === 'persistence_readonly' ? 409 : 500;
        jsonResponse(res, status, {
          error: {
            code: error.code || 'checkpoint_clear_failed',
            message: error.message,
            ...(error.backupPath ? { backupPath: error.backupPath } : {}),
          },
        });
      }
      return true;
    }
    return false;
  }

  return async function adminHandler(req, res) {
    const url = (req.url || '/').split('?')[0];
    try {
      if (url.startsWith('/_admin/api/')) return await handleApi(req, res, url);
      const asset = webAssets.get(url);
      if (!asset || req.method !== 'GET' || !options.webRoot) return false;
      const [fileName, contentType] = asset;
      const bytes = fs.readFileSync(path.join(options.webRoot, fileName));
      res.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-cache',
        'content-length': bytes.length,
      });
      res.end(bytes);
      return true;
    } catch (error) {
      const status = error.code === 'revision_conflict' ? 409
        : error.code === 'confirmation_invalid' ? 409
        : error.code === 'admin_body_too_large' ? 413
          : 400;
      jsonResponse(res, status, {
        error: { code: error.code || 'admin_error', message: error.message },
      });
      return true;
    }
  };
}
