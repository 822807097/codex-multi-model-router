// 会话 Provider 同步器（2026-09-02 实锤：API-key 接入后旧会话仍指向 openai，
// 「继续接续任务」按 threads.model_provider=openai 直连 api.openai.com -> 401。
// 仿 codex++ 方案：把 threads 表的 model_provider 改写到 router；rollout jsonl 的
// session_meta payload 同步改写（不同源不同写，避免桌面端回滚把它覆盖回去）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CODEX_HOME = process.env.CODEX_HOME || 'A:/CodexData';
const STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');
const SESSIONS = path.join(CODEX_HOME, 'sessions');
// 只迁移「官方登录态 provider」会话：openai = 官方直连（API-key 接入后它直连
// api.openai.com 必 401）。custom/deepseek/bailian 是历史自定义通道 provider，
// 保留原义（期望它们各自有 [model_providers.X] 段），不动。
const TARGET_PROVIDERS = new Set(['openai']);
export const SYNCABLE_PROVIDERS = Object.freeze(['openai']);

export function syncSessionProviders({ targetProvider = 'router', enabledProviders = SYNCABLE_PROVIDERS } = {}) {
  const result = { sqliteThreads: 0, sqliteProjects: 0, rolloutFiles: 0, errors: [] };
  const allowed = new Set(enabledProviders);

  // 1) threads 表：旧官方/旧 provider 会话 -> targetProvider
  const db = new DatabaseSync(STATE_DB);
  try {
    const rows = db.prepare(
      'SELECT id, model_provider FROM threads WHERE model_provider != ?',
    ).all(targetProvider);
    const upd = db.prepare('UPDATE threads SET model_provider = ? WHERE id = ?');
    for (const r of rows) {
      if (!allowed.has(r.model_provider)) continue;
      upd.run(targetProvider, r.id);
      result.sqliteThreads += 1;
    }
    // projects 表（若有同名列）
    try {
      const pcols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
      if (pcols.includes('model_provider')) {
        const prows = db.prepare(
          'SELECT id, model_provider FROM projects WHERE model_provider != ?',
        ).all(targetProvider);
        const pupd = db.prepare('UPDATE projects SET model_provider = ? WHERE id = ?');
        for (const r of prows) {
          if (!allowed.has(r.model_provider)) continue;
          pupd.run(targetProvider, r.id);
          result.sqliteProjects += 1;
        }
      }
    } catch { /* projects 无该列则跳过 */ }
  } catch (e) {
    result.errors.push(`state_5.sqlite: ${String(e.message || e).slice(0, 200)}`);
  } finally {
    try { db.close(); } catch { /* 关闭失败可接受 */ }
  }

  // 2) rollout jsonl：session_meta payload.model_provider 同步改写
  const files = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (f.endsWith('.jsonl')) files.push(p);
    }
  };
  try {
    walk(SESSIONS);
  } catch (e) {
    result.errors.push(`sessions 目录: ${String(e.message || e).slice(0, 200)}`);
  }

  // session_meta 行改写（保持其余行/格式不动）
  const patchLine = (line) => {
    if (!line.includes('"type":"session_meta"')) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    const p = obj.payload || {};
    if (!allowed.has(p.model_provider)) return null;
    // 记录原值（诊断可见），改到 targetProvider
    p.previous_model_provider = p.previous_model_provider ?? p.model_provider;
    p.model_provider = targetProvider;
    obj.payload = p;
    return JSON.stringify(obj);
  };
  for (const f of files) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      const lines = text.split('\n');
      let changed = false;
      let patched = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const n = patchLine(lines[i]);
        if (n !== null && n !== lines[i]) { lines[i] = n; patched += 1; changed = true; }
      }
      if (changed) {
        fs.writeFileSync(f, lines.join('\n'));
        result.rolloutFiles += 1;
      }
    } catch { /* 单文件失败跳过（锁定的 rollout 等） */ }
  }
  return result;
}

if (process.argv[1] && process.argv[1].endsWith('codex-session-sync.mjs') && process.argv.length > 2 && process.argv[2] === '--run') {
  const r = syncSessionProviders({ targetProvider: process.argv[3] || 'router' });
  console.log(JSON.stringify(r, null, 2));
}
