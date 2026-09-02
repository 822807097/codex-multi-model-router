import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';

/**
 * OAuth 公共基础设施：PKCE、state、会话存储与双栈 loopback 回调服务器。
 * 协议细节对齐 sub2api（backend/internal/pkg/{oauth,antigravity,openai}）与
 * Antigravity Manager（src-tauri/src/modules/oauth_server.rs）：
 * - PKCE S256（RFC 7636）
 * - loopback 同时监听 IPv6 ::1 与 IPv4 127.0.0.1 同端口，浏览器将 localhost
 *   解析为 ::1 时回调不再被拒（Antigravity Manager #931/850/778 同款修复）
 * - 成功页 2 秒自动 window.close；手动粘贴 code 走同一 resolve 通道
 */

export function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function generateCodeVerifier(byteLength = 32) {
  return base64UrlEncode(crypto.randomBytes(byteLength));
}

export function generateHexCodeVerifier(byteLength = 64) {
  // OpenAI/Codex 规范：64 随机字节的 hex 串（sub2api pkg/openai/oauth.go:157）
  return crypto.randomBytes(byteLength).toString('hex');
}

export function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function generateState() {
  return base64UrlEncode(crypto.randomBytes(32));
}

/**
 * 从用户粘贴的内容提取授权 code：支持纯 code 与完整回调 URL 两种输入。
 */
export function extractCodeFromInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return url.searchParams.get('code') || '';
    } catch {
      const match = raw.match(/[?&]code=([^&\s]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    }
  }
  return raw;
}

function successHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Authorization Successful</title>
<style>
body { font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fff; color: #1f2937; }
.success-icon { color: #10b981; font-size: 2.5rem; font-weight: 700; margin-bottom: 1rem; }
p { color: #4b5563; font-size: 1.1rem; }
</style>
</head>
<body>
<div class="success-icon">✅ Authorization Successful!</div>
<p>You can close this window and return to the application.</p>
<script>setTimeout(function () { window.close(); }, 2000);</script>
</body>
</html>`;
}

function failureHtml(reason) {
  const safe = String(reason || 'No authorization code received').replace(/[<>&]/g, '');
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authorization Failed</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 50px;">
<h1 style="color: #ef4444;">❌ Authorization Failed</h1>
<p>${safe}</p>
<p>Please return to the app and try again.</p>
</body>
</html>`;
}

/**
 * 启动双栈 loopback OAuth 回调服务器。
 *
 * @param {object} options
 * @param {string} options.path 回调路径，如 '/oauth-callback'
 * @param {string} options.state 期望的 state（CSRF 校验）
 * @param {number} options.timeoutMs 空闲超时自动关闭（默认 10 分钟）
 * @returns {Promise<{port:number, redirectUri:string, waitForCode:()=>Promise<{code:string,state:string}>, submitCode:(code:string,state?:string)=>boolean, close:()=>void}>}
 */
function createCallbackHandler({ expectedState, onResult }) {
  return function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (url.pathname !== '/oauth-callback' && url.pathname !== '/callback' && url.pathname !== '/auth/callback') {
      res.writeHead(404);
      res.end();
      return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state') || '';

    if (code && (!expectedState || state === expectedState)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(successHtml());
      onResult(null, { code, state });
      return;
    }

    const reason = error
      ? `Provider returned error: ${error}`
      : (code ? 'OAuth state mismatch (CSRF protection)' : 'No authorization code received');
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(failureHtml(reason));
    onResult(Object.assign(new Error(reason), { code: 'oauth_callback_failed', providerError: error || '' }));
  };
}

export function startLoopbackServer(options = {}) {
  const callbackPath = options.path || '/oauth-callback';
  const expectedState = options.state || '';
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  // port=0 随机；指定端口（如 OpenAI 官方 redirect 要求的 1455）时占用即 reject，
  // 由调用方降级为「手动粘贴 code」模式。
  const fixedPort = Number.isFinite(Number(options.port)) && Number(options.port) > 0
    ? Number(options.port)
    : 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    let finished = false;
    let outerRejected = false;
    let resultResolve = null;
    let resultReject = null;
    const servers = [];

    const pendingResult = new Promise((resolveFn, rejectFn) => {
      resultResolve = resolveFn;
      resultReject = rejectFn;
    });

    function settleOk(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resultResolve(value);
    }

    function settleErr(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resultReject(err);
    }

    const timeoutTimer = setTimeout(() => {
      settleErr(Object.assign(new Error('OAuth 回调等待超时，授权会话已关闭'), { code: 'oauth_callback_timeout' }));
      closeServers();
    }, timeoutMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();

    const handler = createCallbackHandler({
      expectedState,
      onResult: (err, value) => {
        if (err) settleErr(err);
        else settleOk(value);
      },
    });

    function finish(port, ipv4Bound) {
      if (finished) return;
      finished = true;
      const redirectUri = ipv4Bound
        ? `http://localhost:${port}${callbackPath}`
        : `http://[::1]:${port}${callbackPath}`;
      resolve({
        port,
        redirectUri,
        waitForCode: () => pendingResult,
        submitCode(code, state) {
          if (settled) return false;
          if (expectedState && state && state !== expectedState) return false;
          settleOk({ code, state: state || expectedState });
          return true;
        },
        close: closeServers,
      });
    }

    function closeServers() {
      for (const s of servers) {
        try { s.close(); } catch { /* 已关闭 */ }
      }
    }

    // 双栈绑定：两个独立 server 实例监听同一端口（对齐 Antigravity Manager
    // oauth_server.rs，避免单实例多地址监听的错误归属歧义）。
    // unref：回调服务器绝不能阻止进程退出（否则路由优雅停机会被挂起的授权会话阻塞）。
    const ipv4Server = http.createServer(handler);
    const ipv6Server = http.createServer(handler);
    ipv4Server.unref();
    ipv6Server.unref();
    servers.push(ipv4Server, ipv6Server);

    const listenError = (err) => {
      if (finished || settled) return;
      if (!fixedPort) {
        // 随机端口模式：IPv6 不可用仅降级（部分环境禁用 IPv6）；
        // IPv4 随机端口不会冲突。
        return;
      }
      finished = true;
      clearTimeout(timeoutTimer);
      settled = true;
      closeServers();
      const bindErr = Object.assign(
        new Error(`loopback 端口 ${fixedPort} 绑定失败: ${err?.code || err?.message || 'unknown'}`),
        { code: 'oauth_loopback_bind_failed' },
      );
      resultReject(bindErr);
      pendingResult.catch(() => {});
      if (!outerRejected) {
        outerRejected = true;
        reject(bindErr);
      }
    };
    ipv4Server.once('error', listenError);
    ipv4Server.listen(fixedPort, '127.0.0.1', () => {
      const port = ipv4Server.address().port;
      // IPv6 结果（成功或不可用）都即时收敛，resolve 返回时双栈状态确定，
      // 不再依赖 300ms 定时兜底（并发环境下会与客户端连接竞态）。
      const onIpv6Settled = () => finish(port, true);
      ipv6Server.once('error', (err) => {
        if (fixedPort) {
          listenError(err);
          return;
        }
        onIpv6Settled();
      });
      ipv6Server.listen(port, '::1', onIpv6Settled);
      setTimeout(() => finish(port, true), 300);
    });
  });
}

/**
 * 用系统默认浏览器打开授权页（后端拉起，规避前端 window.open 弹窗拦截）。
 *
 * Windows 实现说明：不能用 `cmd /c start <url>` —— cmd 会把 URL 里的 `&`
 * 当作命令分隔符，授权 URL 在第一个 & 处被截断（线上事故：Google 报
 * "Required parameter is missing: response_type"，OpenAI 报
 * missing_required_parameter）；`%XX` 转义序列还可能被 cmd 环境变量展开腐蚀。
 * ShellExecute 直接接收 argv，不存在 shell 解析问题。
 */
export function openDefaultBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}
