// ChatGPT / Codex 桌面端进程管理（跨平台）：检测 / 退出 / 重新拉起。
//
// Windows：进程名 ChatGPT.exe，tasklist/taskkill，MSIX AppsFolder 启动。
// macOS：  ChatGPT.app（进程名 ChatGPT），pgrep -x / pkill -x，`open -a ChatGPT`。
// Linux：  无官方桌面端，pgrep/pkill 尽力检测；拉起返回 unsupported 由前端提示手动打开。
import { execFile, spawn } from 'node:child_process';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

const PROCESS_NAMES = WIN ? ['ChatGPT.exe'] : ['ChatGPT', 'Codex', 'chatgpt'];

function run(file, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
        resolve({ ok: !err, stdout: String(stdout || '') });
      });
    } catch (error) {
      resolve({ ok: false, stdout: '' });
    }
  });
}

/** 桌面端是否正在运行（任一已知进程名命中即为真）。 */
export async function isDesktopRunning() {
  if (WIN) {
    const { ok, stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe']);
    return ok && stdout.includes('ChatGPT.exe');
  }
  for (const name of PROCESS_NAMES) {
    const { ok, stdout } = await run('pgrep', ['-x', name], 4000);
    if (ok && stdout.trim()) return true;
  }
  return false;
}

/** 强制退出桌面端；返回是否成功（进程消失）。 */
export async function killDesktop({ attempts = 3, waitMs = 3000 } = {}) {
  if (WIN) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await new Promise((resolve) => {
        const kill = spawn('taskkill', ['/IM', 'ChatGPT.exe', '/F'], { stdio: 'ignore', windowsHide: true });
        kill.on('close', resolve);
        kill.on('error', resolve);
      });
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (!(await isDesktopRunning())) return true;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    return !(await isDesktopRunning());
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const name of PROCESS_NAMES) {
      await run('pkill', ['-x', name], 4000);
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (!(await isDesktopRunning())) return true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return !(await isDesktopRunning());
}

/**
 * 重新拉起桌面端。
 * 返回 { launched, message }：launched=false 时前端应提示用户手动打开
 * （Linux 无统一桌面入口；mac 若本机未装 ChatGPT.app 同样降级提示）。
 */
export function launchDesktop() {
  if (WIN) {
    try {
      spawn('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'], { stdio: 'ignore', windowsHide: true }).unref?.();
      return { launched: true, message: '桌面端已自动重启，约 10 秒后可用' };
    } catch {
      return { launched: false, message: '已退出桌面端，但自动拉起失败——请手动打开 ChatGPT 桌面端' };
    }
  }
  if (MAC) {
    try {
      const child = spawn('open', ['-a', 'ChatGPT'], { stdio: 'ignore' });
      child.on('error', () => {
        try { spawn('open', ['-a', 'Codex'], { stdio: 'ignore' }).unref?.(); } catch { /* 二次失败则提示手动 */ }
      });
      child.unref?.();
      return { launched: true, message: '桌面端已退出并重新拉起（open -a ChatGPT），约 10 秒后可用' };
    } catch {
      return { launched: false, message: '已退出桌面端，但自动拉起失败——请手动打开 ChatGPT 桌面端' };
    }
  }
  return { launched: false, message: '当前系统无统一桌面启动入口，请手动打开 ChatGPT / Codex 桌面端' };
}
