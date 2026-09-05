// ---------- Cursor 网关上游同步（external/cursor2api 跟随上游更新） ----------
// 网关源码是上游开源项目 NGLSG/cursor2api 的副本，随路由仓库分发。上游持续演进，
// 本模块负责：检查上游最新 commit → 对比本地快照 → 一键拉取更新。
// 安全网：更新前备份旧源码，调用方重启网关健康检查失败时 rollbackToBackup 还原
// （实锤：上游某版本 sidecar 依赖 bun，Windows 无 bun.exe 直接起不来）。
// 更新策略：git clone --depth 1（走配置代理）替换除运行时产物（node_modules/
// .env/日志/数据库）外的全部文件；账号数据在网关自身数据库中不受影响。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { rawHttpsRequest } from './transport.mjs';

const UPSTREAM_REPO = 'NGLSG/cursor2api';
// 运行时产物：更新时保留（不覆盖、不删除）
const PRESERVE_FILES = new Set(['node_modules', '.env', 'cursor2api.db', 'data', 'cursor2api.err.log', 'cursor2api.out.log']);
// 回滚备份目录（固定名，覆盖式）
const ROLLBACK_DIRNAME = '.cursor2api-rollback';
// 快照元数据文件：更新成功后写入，记录同步来源
const UPSTREAM_META = 'UPSTREAM.json';

function runGit(cwd, args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args[0]} 失败：${String(stderr || error.message).slice(0, 300)}`));
          return;
        }
        resolve(String(stdout || ''));
      },
    );
  });
}

async function githubJson(apiPath, proxy, fetcher) {
  const outcome = await fetcher({
    protocol: 'https',
    host: 'api.github.com',
    path: apiPath,
    method: 'GET',
    viaProxy: Boolean(proxy),
    proxy,
    headers: {
      'user-agent': 'codex-router-cursor-gateway-sync',
      accept: 'application/vnd.github+json',
    },
    timeouts: { connectMs: 10_000, responseHeaderMs: 20_000, requestMs: 25_000 },
    maxResponseBytes: 4 * 1024 * 1024,
  });
  if (outcome.status < 200 || outcome.status >= 300) {
    throw new Error(`GitHub API 返回 ${outcome.status}（检查网络/全局代理可达性）`);
  }
  return JSON.parse(outcome.bodyText || '{}');
}

function readLocalMeta(gatewayDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(gatewayDir, UPSTREAM_META), 'utf8'));
  } catch {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(gatewayDir, 'package.json'), 'utf8'));
      return { version: String(pkg.version || ''), commit: '', syncedAt: '' };
    } catch {
      return { version: '', commit: '', syncedAt: '' };
    }
  }
}

function readLocalVersion(gatewayDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(gatewayDir, 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

function copyExcept(srcDir, destDir, skipNames) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    fs.cpSync(path.join(srcDir, entry.name), path.join(destDir, entry.name), { recursive: true });
  }
}

function removeExcept(dir, keepNames) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (keepNames.has(entry.name)) continue;
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

export function createGatewayUpstreamSync({ gatewayDir, proxy, log = () => {} }) {
  /** 检查上游最新 commit 与本地快照的差异。 */
  async function checkUpstream() {
    const head = await githubJson(`/repos/${UPSTREAM_REPO}/commits/HEAD`, proxy, rawHttpsRequest);
    const local = readLocalMeta(gatewayDir);
    const latestSha = String(head.sha || '').slice(0, 10);
    const latestDate = head.commit?.committer?.date || '';
    const latestMessage = String(head.commit?.message || '').split('\n')[0].slice(0, 120);
    // 本地快照存的是 git rev-parse --short（7 位起），上游取 10 位——按前缀对比，
    // 避免「本地 d3adc7e vs 上游 d3adc7e59c」被误判为有更新
    const localCommit = String(local.commit || '').trim();
    const upToDate = Boolean(latestSha) && Boolean(localCommit) && (
      localCommit === latestSha
      || latestSha.startsWith(localCommit)
      || localCommit.startsWith(latestSha)
    );
    return {
      repo: UPSTREAM_REPO,
      local: {
        version: readLocalVersion(gatewayDir),
        commit: String(local.commit || ''),
        syncedAt: local.syncedAt || '',
      },
      latest: { sha: latestSha, date: latestDate, message: latestMessage },
      upToDate,
      htmlUrl: `https://github.com/${UPSTREAM_REPO}/commits/main`,
    };
  }

  /**
   * 从上游拉取最新源码替换本地副本（保留运行时产物）。
   * 替换前旧源码备份到 ../.cursor2api-rollback，供健康检查失败后回滚。
   */
  async function updateFromUpstream() {
    if (!fs.existsSync(gatewayDir)) {
      throw new Error(`网关目录不存在：${gatewayDir}`);
    }
    const tmpRoot = path.join(path.dirname(gatewayDir), `.cursor2api-update-${Date.now()}`);
    const tmpDir = path.join(tmpRoot, 'repo');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      // GitHub 直连在国内网络常被 reset：配置了代理（v2rayN 等 HTTP CONNECT）时让 git 走同款代理
      const cloneArgs = ['clone', '--depth', '1', `https://github.com/${UPSTREAM_REPO}.git`, 'repo'];
      if (proxy?.host && proxy?.port) {
        cloneArgs.unshift('-c', `http.proxy=http://${proxy.host}:${proxy.port}`);
      }
      await runGit(tmpRoot, cloneArgs);
      // 校验拉到的确是网关源码（防上游结构变化/拦截页）
      if (!fs.existsSync(path.join(tmpDir, 'server.mjs')) || !fs.existsSync(path.join(tmpDir, 'package.json'))) {
        throw new Error('拉取内容校验失败（缺少 server.mjs/package.json），已取消更新');
      }
      const headSha = (await runGit(tmpDir, ['rev-parse', '--short', 'HEAD'])).trim();

      // 旧源码备份（供健康检查失败回滚）
      const rollbackDir = path.join(path.dirname(gatewayDir), ROLLBACK_DIRNAME);
      fs.rmSync(rollbackDir, { recursive: true, force: true });
      copyExcept(gatewayDir, rollbackDir, PRESERVE_FILES);

      // 替换：清旧（保留运行时产物）→ 拷新 → 写元数据
      removeExcept(gatewayDir, PRESERVE_FILES);
      for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
        if (entry.name === '.git' || PRESERVE_FILES.has(entry.name)) continue;
        fs.cpSync(path.join(tmpDir, entry.name), path.join(gatewayDir, entry.name), { recursive: true });
      }
      const meta = {
        repo: UPSTREAM_REPO,
        commit: headSha,
        version: readLocalVersion(gatewayDir),
        syncedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(gatewayDir, UPSTREAM_META), JSON.stringify(meta, null, 2) + '\n');
      log({ event: 'cursor_gateway.updated', commit: headSha });
      return {
        ok: true,
        commit: headSha,
        version: meta.version,
        message: `网关已更新到上游 ${headSha}（v${meta.version}）；正在重启网关并做健康检查，失败会自动回滚旧版`,
      };
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清理失败不影响主流程 */ }
    }
  }

  /** 健康检查失败后还原更新前的旧版源码（PRESERVE 运行时产物不动）。 */
  function rollbackToBackup() {
    const rollbackDir = path.join(path.dirname(gatewayDir), ROLLBACK_DIRNAME);
    if (!fs.existsSync(rollbackDir)) return false;
    removeExcept(gatewayDir, PRESERVE_FILES);
    copyExcept(rollbackDir, gatewayDir, new Set());
    fs.rmSync(rollbackDir, { recursive: true, force: true });
    const meta = {
      repo: UPSTREAM_REPO,
      commit: readLocalMeta(gatewayDir).commit || '',
      version: readLocalVersion(gatewayDir),
      syncedAt: new Date().toISOString(),
      rolledBack: true,
    };
    try {
      fs.writeFileSync(path.join(gatewayDir, UPSTREAM_META), JSON.stringify(meta, null, 2) + '\n');
    } catch { /* 元数据写失败不影响回滚本身 */ }
    log({ event: 'cursor_gateway.rolled_back' });
    return true;
  }

  return { checkUpstream, updateFromUpstream, rollbackToBackup };
}
