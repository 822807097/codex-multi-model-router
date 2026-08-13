// ---------- envKey 热更新源 ----------
// Windows 下进程环境变量是启动时的快照；setx 写入注册表后，运行中的进程看不到新值。
// 本模块提供惰性读取（getKey）+ 按需刷新（refreshNow）：正常请求零额外开销；
// 上游返回 401/429（认证失效/额度耗尽）时由路由调用 refreshNow 刷新注册表，
// 值发生变化则用新 key 重试同一目标——更换 API key 无需重启路由。
// 密钥值只驻留进程内存，不写日志、不落盘、不通过任何诊断字段外泄。

import { execFile as nodeExecFile } from 'node:child_process';
import process from 'node:process';

const WIN_USER_HIVE = 'HKCU\\Environment';
const WIN_MACHINE_HIVE = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

// 解析 reg.exe query 输出："    NAME    REG_SZ    value"（支持 REG_SZ / REG_EXPAND_SZ）
export function parseRegQueryOutput(stdout) {
  const lines = String(stdout).split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s+\S+\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/);
    if (match) return match[1];
  }
  return null;
}

export function createEnvKeySource(options = {}) {
  const {
    env = process.env,
    execFile = nodeExecFile,
    platform = process.platform,
    log = () => {},
  } = options;

  const cache = new Map();
  const refreshInFlight = new Set();

  // 查询注册表环境变量：用户级（HKCU）优先，其次机器级（HKLM），与 Windows 合并顺序一致。
  function queryRegistryValue(name) {
    const queryHive = (hive) => new Promise((resolve) => {
      execFile('reg.exe', ['query', hive, '/v', name], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        if (error) { resolve(null); return; }
        resolve(parseRegQueryOutput(stdout));
      });
    });
    // 两个 hive 并行查询，结果按用户级优先合并。
    return Promise.all([queryHive(WIN_USER_HIVE), queryHive(WIN_MACHINE_HIVE)])
      .then(([userValue, machineValue]) => userValue ?? machineValue);
  }

  // 立即刷新指定 key：查询注册表，值变化才更新缓存并返回 true。
  // 并发去重：同一 key 的刷新同时只会执行一次。
  async function refreshNow(name) {
    if (platform !== 'win32' || !name) return false;
    if (refreshInFlight.has(name)) return false;
    refreshInFlight.add(name);
    try {
      const value = await queryRegistryValue(name);
      if (value === null || value === cache.get(name)) return false;
      cache.set(name, value);
      log(name);
      return true;
    } finally {
      refreshInFlight.delete(name);
    }
  }

  // 惰性读取：首次访问用进程环境初始化缓存，之后直接返回缓存（零开销）。
  function getKey(name) {
    if (!name) return undefined;
    if (!cache.has(name)) cache.set(name, env[name]);
    return cache.get(name);
  }

  return { getKey, refreshNow };
}
