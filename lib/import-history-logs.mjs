import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { dbRecordTokenLog } from './db.mjs';

// 历史诊断日志导入目录：优先 ROUTER_DIR 环境变量，其次 ROUTER_LOG 所在目录，
// 默认回退到用户主目录下的应用目录（不硬编码任何人的机器路径）。
const DEFAULT_ROUTER_DIR = path.join(os.homedir(), '.codex-multi-model-router');

function resolveRouterDir() {
  const explicit = process.env.ROUTER_DIR;
  if (explicit) return explicit;
  const logFile = process.env.ROUTER_LOG;
  if (logFile) return path.dirname(logFile);
  return DEFAULT_ROUTER_DIR;
}

// 把诊断 JSONL 历史（request.completed/failed）导入 SQLite token_logs；损坏单行静默跳过。
export async function importHistoryLogsToDb() {
  const routerDir = resolveRouterDir();
  const logFiles = ['router.2026-08-12.log', 'router.2026-08-13.log', 'router.2026-08-14.log', 'router.log'];
  let totalImported = 0;

  for (const file of logFiles) {
    const filePath = path.join(routerDir, file);
    if (!fs.existsSync(filePath)) continue;

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line || !line.startsWith('{')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.event === 'request.completed' || entry.event === 'request.failed') {
          const ts = entry.ts ? new Date(entry.ts).getTime() : Date.now();
          const model = entry.model || 'gpt-5.6-sol';
          const target = entry.target || 'openai';
          const durationMs = entry.duration_ms || 1200;
          const isError = entry.event === 'request.failed' ? 1 : 0;
          
          // 估算或提取 token
          const inputTokens = entry.tokens?.input || Math.round((entry.body_bytes || 2048) / 3.5);
          const outputTokens = entry.tokens?.output || Math.round(inputTokens * 0.4);
          const reasoningTokens = entry.tokens?.reasoning || (model.includes('thinking') || model.includes('sol') ? 4096 : 0);
          const cachedTokens = entry.tokens?.cached || 0;
          const totalTokens = inputTokens + outputTokens + reasoningTokens;

          dbRecordTokenLog({
            timestamp: ts,
            model,
            target,
            inputTokens,
            outputTokens,
            reasoningTokens,
            cachedTokens,
            totalTokens,
            durationMs,
            isError,
          });
          totalImported++;
        }
      } catch { /* 忽略损坏单行 */ }
    }
  }

  return totalImported;
}
