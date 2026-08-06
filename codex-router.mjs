#!/usr/bin/env node
// ============================================================================
// codex-router.mjs — Codex 本地多模型路由代理（零依赖，Node >= 18）
// ----------------------------------------------------------------------------
// 解决什么问题：
//   Codex 桌面端同一时间只能配置一个 model_provider，且「官方 GPT + 第三方模型」
//   无法在选择器里共存。本路由作为唯一 provider 的 base_url 接管全部请求，
//   按请求体里的 model 字段分流到不同上游，实现：
//     · 官方 GPT 系列  → chatgpt.com（复用桌面端 auth.json 的 ChatGPT 登录态，
//                        可选经 v2rayN 等本地代理的 CONNECT 隧道出海）
//     · DeepSeek 系列  → api.deepseek.com（环境变量 key，直连）
//     · Qwen 系列      → 阿里云 Token Plan 端点（环境变量 key，直连）
//   并附带「视觉中继」：给不支持图片的文本模型发图时，先调一个视觉模型把图片
//
// 配套 config.toml 关键写法（详见 README.md）：
//   model_provider = "router"
//   model_catalog_json = "<你的 models.json>"
//   [model_providers.router]
//   base_url = "http://127.0.0.1:15730/v1"
//   wire_api = "responses"
//   requires_openai_auth = true   # ← 门控钥匙：让桌面端按官方身份放行自定义模型
//   supports_websockets = false
//
// 环境变量：
//   CODEX_HOME          Codex 数据目录（默认 ~/.codex），auth.json/models.json 在此
//   CODEX_AUTH_PATH     覆盖 auth.json 路径
//   CODEX_CATALOG_PATH  覆盖 models.json 路径（/v1/models 端点读取它）
//   ROUTER_PORT         监听端口（默认 15730）
//   V2RAY_PORT          本地代理混合端口（默认 10808，仅 viaProxy 的腿使用）
//   各腿 key 见下方 TARGETS 的 envKey 字段
// ============================================================================
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';

// ---------- 加载配置 ----------
// config.json 与 codex-router.mjs 同目录，包含所有可修改参数
// 环境变量优先级高于 config.json（PORT/PROXY 等）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const PORT = Number(process.env.ROUTER_PORT || cfg.port || 15730);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const AUTH_PATH = process.env.CODEX_AUTH_PATH || cfg.paths?.auth || path.join(CODEX_HOME, 'auth.json');
const CATALOG_PATH = process.env.CODEX_CATALOG_PATH || cfg.paths?.catalog || path.join(CODEX_HOME, 'models.json');
const V2RAY_PROXY = {
  host: process.env.V2RAY_HOST || cfg.proxy?.host || '127.0.0.1',
  port: Number(process.env.V2RAY_PORT || cfg.proxy?.port || 10808)
};
const CLIENT_ID = cfg.oauth?.client_id || 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_SKEW_SECONDS = cfg.oauth?.refresh_skew_seconds || 30;

// 路由规则：按请求体 model 字段匹配，命中第一条即用之
// match: 正则字符串 | host: 上游域名 | prefix: 路径前缀
// viaProxy: true=经本地代理 CONNECT 隧道 | vision: false=文本模型走视觉中继
// envKey: API key 所在环境变量名（官方腿不用，走 auth.json）
// 容错：单条 match 正则非法时跳过该腿并告警，不让整个路由启动即崩
const TARGETS = (cfg.targets || []).flatMap((t) => {
  try { return [{ ...t, match: new RegExp(t.match) }]; }
  catch (e) { console.error(`[config] 忽略非法 match 正则: ${t.match} (${e.message})`); return []; }
});

// ---------- 视觉中继配置 ----------
// 文本模型 (vision:false) 收到 input_image 时，调用这里配置的视觉模型生成描述
// 配置项见 config.json 的 visionRelay 字段
const VISION_RELAY = cfg.visionRelay || { host: 'token-plan.cn-beijing.maas.aliyuncs.com', prefix: '/compatible-mode/v1', model: 'qwen3.8-max', envKey: 'BAILIAN_API_KEY' };

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
// 诊断日志（可选）：ROUTER_LOG 指向文件时记录请求形状，用于排查闪跳/上下文问题
const LOG_FILE = process.env.ROUTER_LOG || null;
const flog = (m) => { if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${m}\n`); } catch { /* noop */ } } };

// ---------- 模型上下文窗口配置 ----------
// config.json 的 modelContext 字段：路由启动时把上下文窗口/压缩阈值写回 models.json，
// 让桌面端据此做滑动窗口/压缩，避免第三方模型每轮全量重发历史（卡思考根因）
function applyModelContext() {
  const mc = cfg.modelContext;
  if (!mc || mc.enabled === false) return;
  try {
    const cat = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    let changed = false;
    const slugs = mc.slugs || [];
    for (const m of cat.models || []) {
      if (slugs.length && !slugs.includes(m.slug)) continue;
      if (mc.contextWindow && m.context_window !== mc.contextWindow) { m.context_window = mc.contextWindow; m.max_context_window = mc.contextWindow; changed = true; }
      if (mc.autoCompactTokenLimit !== undefined && m.auto_compact_token_limit !== mc.autoCompactTokenLimit) { m.auto_compact_token_limit = mc.autoCompactTokenLimit; changed = true; }
    }
    if (changed) {
      const tmp = CATALOG_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cat, null, 2));
      fs.renameSync(tmp, CATALOG_PATH);
      log('modelContext: 已写回 models.json');
    }
  } catch (e) { log('modelContext: 应用失败', e.message); }
}
applyModelContext();

// ---------- TLS 连接：直连 或 经本地代理 HTTP CONNECT 隧道 ----------
function tlsSocketDirect(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect(443, host, { servername: host }, () => resolve(s));
    s.on('error', reject);
  });
}
// 先连代理端口，发 CONNECT host:443，收到 200 后在该 socket 上叠 TLS
function tlsSocketViaProxy(host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(V2RAY_PROXY.port, V2RAY_PROXY.host, () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        socket.removeListener('data', onData);
        const statusLine = buf.split('\r\n')[0];
        if (!/ 200 /.test(statusLine + ' ')) {
          reject(new Error(`CONNECT ${host} failed: ${statusLine}`));
          socket.destroy();
          return;
        }
        const t = tls.connect({ socket, servername: host }, () => {
          socket.setTimeout(0); // CONNECT 已建立，清除空闲超时，避免长流/长思考被掐断
          resolve(t);
        });
        t.on('error', reject);
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.setTimeout(15000, () => { reject(new Error(`CONNECT ${host} timeout`)); socket.destroy(); });
  });
}
const connectTls = (host, viaProxy) => (viaProxy ? tlsSocketViaProxy(host) : tlsSocketDirect(host));

// ---------- 一次性 HTTPS 请求（裸写 HTTP/1.1，返回 status+bodyText） ----------
// 为什么不用 fetch/http.request：隧道场景下 Node http.request 的 options.createConnection
// 实测不生效（会另起一条直连 host:80 的连接），只能自己在 TLS socket 上裸写字节。
function rawHttpsRequest(host, reqPath, viaProxy, headers, bodyStr) {
  return connectTls(host, viaProxy).then((socket) => new Promise((resolve, reject) => {
    const lines = [`POST ${reqPath} HTTP/1.1`, `Host: ${host}`, 'Connection: close', 'content-type: application/json', `content-length: ${Buffer.byteLength(bodyStr)}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n' + bodyStr);
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => (buf = Buffer.concat([buf, d])));
    socket.on('end', () => {
      const idx = buf.indexOf('\r\n\r\n');
      const head = idx === -1 ? '' : buf.subarray(0, idx).toString('latin1');
      let bodyBuf = idx === -1 ? buf : buf.subarray(idx + 4);
      const m = head.match(/^HTTP\/[\d.]+ (\d{3})/);
      if (/transfer-encoding:\s*chunked/i.test(head)) bodyBuf = dechunkBuffer(bodyBuf);
      resolve({ status: m ? Number(m[1]) : 0, bodyText: bodyBuf.toString('utf8') });
    });
    socket.on('error', reject);
    socket.setTimeout(60000, () => { reject(new Error(`rawHttpsRequest ${host} timeout`)); socket.destroy(); });
  }));
}
// 整包解码 chunked 传输编码（按字节操作，保证多字节 UTF-8 不被截断）
function dechunkBuffer(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const lineEnd = buf.indexOf('\r\n', i);
    if (lineEnd === -1) break;
    const size = parseInt(buf.subarray(i, lineEnd).toString('latin1').split(';')[0], 16);
    if (!size) break;
    out.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
    i = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(out);
}
// 流式增量 dechunk：上游 chunked 响应透传给客户端时必须先解包，
// 否则 Node ServerResponse 会再套一层 chunked 封装，客户端解析直接坏掉（SSE 尤甚）。
class DechunkTransform extends Transform {
  constructor() { super(); this._buf = Buffer.alloc(0); this._size = -1; }
  _transform(chunk, enc, cb) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (true) {
      if (this._size === -1) {
        const le = this._buf.indexOf('\r\n');
        if (le === -1) return cb();
        this._size = parseInt(this._buf.subarray(0, le).toString('latin1').split(';')[0], 16) || 0;
        this._buf = this._buf.subarray(le + 2);
        if (this._size === 0) { this._buf = Buffer.alloc(0); return cb(); }
      } else {
        if (this._buf.length < this._size + 2) return cb();
        this.push(this._buf.subarray(0, this._size));
        this._buf = this._buf.subarray(this._size + 2);
        this._size = -1;
      }
    }
  }
  _flush(cb) { if (this._size > 0 && this._buf.length) this.push(this._buf.subarray(0, this._size)); cb(); }
}
function httpsJson(host, reqPath, viaProxy, headers, bodyObj) {
  return rawHttpsRequest(host, reqPath, viaProxy, headers, JSON.stringify(bodyObj)).then(({ status, bodyText }) => {
    try { return { status, json: JSON.parse(bodyText) }; } catch { return { status, json: null, raw: bodyText }; }
  });
}

// ---------- 视觉中继实现 ----------
// 图片描述缓存：同一张图（同 url/dataURL）只调一次视觉模型，后续轮次直接复用，
// 避免长会话每轮重复描述历史截图导致“一直思考”
const captionCache = new Map();
const CAPTION_CACHE_MAX = 200;
async function captionImage(imageUrl) {
  if (captionCache.has(imageUrl)) return captionCache.get(imageUrl);
  const key = process.env[VISION_RELAY.envKey];
  if (!key) throw new Error(`VISION_RELAY 环境变量 ${VISION_RELAY.envKey} 未设置`);
  const body = JSON.stringify({
    model: VISION_RELAY.model,
    messages: [{ role: 'user', content: [
      { type: 'text', text: VISION_RELAY.prompt || 'Describe this image concisely (2-4 sentences) for a coding assistant that cannot see it.' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ] }],
    max_tokens: VISION_RELAY.maxTokens || 300,
  });
  const r = await rawHttpsRequest(VISION_RELAY.host, `${VISION_RELAY.prefix}/chat/completions`, false, { authorization: `Bearer ${key}` }, body);
  const j = JSON.parse(r.bodyText);
  if (r.status !== 200 || !j.choices?.[0]?.message?.content) throw new Error(`vision relay HTTP ${r.status}`);
  const desc = j.choices[0].message.content;
  if (captionCache.size >= CAPTION_CACHE_MAX) captionCache.clear(); // 简单淘汰：满了清空
  captionCache.set(imageUrl, desc);
  return desc;
}
// 遍历 Responses API 的 input，对中继目标模型不可见的非文本 part 做替换：
//   1. user 消息的 content（用户直接贴图）
//   2. function_call_output 的 output（浏览器/电脑操作插件回传的截图）
// 注意：assistant 角色的历史消息不修改，避免把描述注入错误的上下文位置
async function relayNonTextParts(body) {
  if (!body || !Array.isArray(body.input)) return 0;
  let stripped = 0;
  const relayParts = async (parts) => {
    if (!Array.isArray(parts)) return parts;
    // 并行中继多图，降低多图会话延迟；只转换 input_image，其余原样保留
    return Promise.all(parts.map(async (p) => {
      if (!(p && p.type === 'input_image')) return p;
      stripped++;
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      try {
        const desc = await captionImage(url);
        log(`vision relay: captioned image (${desc.length} chars)`);
        return { type: 'input_text', text: `[image description: ${desc}]` };
      } catch (e) {
        log('vision relay failed:', e.message);
        return { type: 'input_text', text: '[image omitted: vision relay failed]' }; // 降级：不阻断请求
      }
    }));
  };
  for (const msg of body.input) {
    if (!msg) continue;
    // 用户消息里的贴图
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      msg.content = await relayParts(msg.content);
    }
    // 工具/插件回传的截图（browser、computer-use 等插件的屏幕截图走这里）
    if (Array.isArray(msg.output)) {
      msg.output = await relayParts(msg.output);
    }
  }
  return stripped;
}

// ---------- ChatGPT 登录态：读 auth.json，临期自动 refresh 并原子写回 ----------
function jwtExp(token) {
  try {
    let p = token.split('.')[1];
    p += '='.repeat((4 - (p.length % 4)) % 4);
    return JSON.parse(Buffer.from(p, 'base64url').toString()).exp || null;
  } catch { return null; }
}
function readAuth() { return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); }
// single-flight：并发请求同时临期时只真正 refresh 一次，避免 refresh_token 轮换竞态写坏 auth.json
let refreshInFlight = null;
async function getOpenAiAuth() {
  const data = readAuth();
  const tokens = data.tokens || {};
  if (!tokens.access_token) throw new Error('auth.json 缺少 access_token，请先在 Codex 桌面端登录 ChatGPT');
  const exp = jwtExp(tokens.access_token);
  if (exp && Date.now() / 1000 < exp - REFRESH_SKEW_SECONDS) {
    return { token: tokens.access_token, accountId: tokens.account_id };
  }
  if (!tokens.refresh_token) throw new Error('access_token 已过期且无 refresh_token，请在桌面端重新登录');
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}
async function doRefresh() {
  const data = readAuth(); // 重新读，拿最新 refresh_token
  const tokens = data.tokens || {};
  log('openai: access_token 临期，执行 refresh');
  const r = await httpsJson('auth.openai.com', '/oauth/token', true, {}, {
    client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
  });
  if (r.status !== 200 || !r.json?.access_token) throw new Error(`token refresh 失败 HTTP ${r.status}`);
  tokens.access_token = r.json.access_token;
  if (r.json.refresh_token) tokens.refresh_token = r.json.refresh_token;
  if (r.json.id_token) tokens.id_token = r.json.id_token;
  data.tokens = tokens;
  data.last_refresh = new Date().toISOString();
  // 原子写：先写 tmp 再 rename，避免桌面端并发读到半写文件
  const tmp = AUTH_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, AUTH_PATH);
  log('openai: refresh 成功并已写回 auth.json');
  return { token: tokens.access_token, accountId: tokens.account_id };
}

// ---------- 在已建立的 TLS socket 上裸写 HTTP/1.1 请求并流式回传响应 ----------
function rawHttpRequest(socket, host, reqPath, method, headers, bodyBuf, clientRes, tag) {
  const headLines = [`${method} ${reqPath} HTTP/1.1`, `Host: ${host}`, 'Connection: close'];
  for (const [k, v] of Object.entries(headers)) headLines.push(`${k}: ${v}`);
  socket.write(headLines.join('\r\n') + '\r\n\r\n');
  if (bodyBuf.length) socket.write(bodyBuf);
  let headBuf = Buffer.alloc(0);
  let piped = false;
  const onData = (d) => {
    if (piped) return;
    headBuf = Buffer.concat([headBuf, d]);
    const idx = headBuf.indexOf('\r\n\r\n'); // 响应头结束标记
    if (idx === -1) {
      if (headBuf.length > 64 * 1024) socket.destroy(); // 防异常上游撑爆内存
      return;
    }
    piped = true;
    socket.removeListener('data', onData);
    const headText = headBuf.subarray(0, idx).toString('latin1');
    const rest = headBuf.subarray(idx + 4); // 头后已到的首包 body，别丢
    const lines = headText.split('\r\n');
    const statusMatch = lines[0].match(/^HTTP\/[\d.]+ (\d{3})/);
    const status = statusMatch ? Number(statusMatch[1]) : 502;
    // 透传响应头：剔除 hop-by-hop 与长度类头（body 可能被 dechunk 改变长度）
    const outHeaders = {};
    for (const line of lines.slice(1)) {
      const ci = line.indexOf(':');
      if (ci === -1) continue;
      const k = line.slice(0, ci).trim().toLowerCase();
      const v = line.slice(ci + 1).trim();
      if (k === 'connection' || k === 'keep-alive') continue;
      if (outHeaders[k] !== undefined) outHeaders[k] = [].concat(outHeaders[k], v);
      else outHeaders[k] = v;
    }
    log(`${tag} -> ${status}`);
    const chunked = /chunked/i.test(String(outHeaders['transfer-encoding'] || ''));
    if (chunked) { delete outHeaders['transfer-encoding']; delete outHeaders['content-length']; }
    try { clientRes.writeHead(status, outHeaders); } catch { /* 客户端已断开 */ }
    if (chunked) {
      const t = new DechunkTransform();
      if (rest.length) t.write(rest);
      socket.pipe(t);
      t.pipe(clientRes);
      t.on('error', () => clientRes.destroy());
    } else {
      if (rest.length) clientRes.write(rest);
      socket.pipe(clientRes);
    }
  };
  socket.on('data', onData);
  socket.on('end', () => {
    if (!piped) { try { clientRes.writeHead(502, { 'content-type': 'application/json' }); clientRes.end(JSON.stringify({ error: 'upstream closed before response head' })); } catch { /* noop */ } }
    else clientRes.end();
  });
  socket.on('error', (e) => {
    log(`socket error [${tag}]`, e.message);
    if (!piped) { try { clientRes.writeHead(502, { 'content-type': 'application/json' }); clientRes.end(JSON.stringify({ error: `router upstream error: ${e.message}` })); } catch { /* noop */ } }
    else clientRes.destroy();
  });
}

// ---------- 主服务 ----------
const server = http.createServer(async (clientReq, clientRes) => {
  const url = clientReq.url || '/';
  // 健康检查
  if (clientReq.method === 'GET' && (url === '/healthz' || url === '/v1/healthz')) {
    clientRes.writeHead(200, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ ok: true, targets: TARGETS.map((t) => t.name) }));
    return;
  }
  // OpenAI 兼容 /models：供管理工具连通性校验 / 桌面端目录刷新
  if (clientReq.method === 'GET' && (url === '/models' || url === '/v1/models')) {
    try {
      const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
      const data = catalog.models.map((m) => ({ id: m.slug, object: 'model', created: 0, owned_by: 'local-router' }));
      clientRes.writeHead(200, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ object: 'list', data }));
    } catch (e) {
      clientRes.writeHead(500, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: String(e.message) }));
    }
    return;
  }
  if (clientReq.method !== 'POST') {
    clientRes.writeHead(404, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  // 收齐请求体 → 按 model 选腿 → 必要时视觉中继 → 换认证头 → 裸写转发
  const chunks = [];
  clientReq.on('data', (c) => chunks.push(c));
  clientReq.on('end', async () => {
    const bodyBuf0 = Buffer.concat(chunks);
    let bodyObj = null;
    let model = '';
    try { bodyObj = JSON.parse(bodyBuf0.toString()); model = bodyObj.model || ''; } catch { /* 非 JSON 按默认腿走 */ }
    // 诊断：记录请求形状（历史条数/各角色计数/是否带 previous_response_id），排查闪跳
    if (bodyObj && Array.isArray(bodyObj.input)) {
      const cnt = {};
      for (const it of bodyObj.input) { const k = it?.role || it?.type || '?'; cnt[k] = (cnt[k] || 0) + 1; }
      flog(`${model} | input=${bodyObj.input.length} | prev=${bodyObj.previous_response_id ? 'yes' : 'no'} | ${Object.entries(cnt).map(([k, v]) => `${k}:${v}`).join(' ')}`);
    }
    const target = TARGETS.find((t) => t.match.test(model)) || TARGETS[0];
    let bodyBuf = bodyBuf0;
    if (bodyObj && target.vision === false) {
      const stripped = await relayNonTextParts(bodyObj);
      if (stripped > 0) {
        bodyBuf = Buffer.from(JSON.stringify(bodyObj));
        log(`${model}: relayed/stripped ${stripped} non-text part(s) for text-only model`);
      }
    }
    const upstreamPath = target.prefix + url.replace(/^\/v1/, '');
    try {
      // 透传客户端头，但剔除 hop-by-hop / 认证 / 长度 / 压缩（压缩必须关，否则透传解压坏）
      const headers = {};
      for (const [k, v] of Object.entries(clientReq.headers)) {
        if (['host', 'connection', 'authorization', 'content-length', 'accept-encoding'].includes(k.toLowerCase())) continue;
        headers[k] = v;
      }
      headers['content-length'] = bodyBuf.length;
      headers['accept-encoding'] = 'identity';
      if (target.name === 'openai') {
        // 官方腿：用桌面端登录态（自动 refresh），客户端带来的 Bearer 被覆盖
        const auth = await getOpenAiAuth();
        headers.authorization = `Bearer ${auth.token}`;
        if (auth.accountId) headers['ChatGPT-Account-ID'] = auth.accountId;
      } else {
        const key = process.env[target.envKey];
        if (!key) throw new Error(`环境变量 ${target.envKey} 未设置`);
        headers.authorization = `Bearer ${key}`;
      }
      const socket = await connectTls(target.host, target.viaProxy);
      clientRes.on('close', () => socket.destroy()); // 客户端断开即掐上游
      rawHttpRequest(socket, target.host, upstreamPath, clientReq.method, headers, bodyBuf, clientRes, `${model || '?'} -> ${target.name}`);
    } catch (e) {
      log(`route error [${target.name}]`, e.message);
      if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: `router error: ${e.message}` }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`codex-router listening on 127.0.0.1:${PORT}`);
  log(`  config: ${CONFIG_PATH}`);
  log(`  proxy: ${V2RAY_PROXY.host}:${V2RAY_PROXY.port}`);
  log(`  targets: ${TARGETS.map((t) => t.name).join(', ')}`);
  log(`  vision relay: ${VISION_RELAY.model} @ ${VISION_RELAY.host}`);
});
