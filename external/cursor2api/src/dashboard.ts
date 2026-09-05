import { escapeHtml, icon, hydrateIcons } from "./ui";

interface Credential { id: string; label: string; hint: string; status: "active" | "disabled"; models: string[]; }
interface ClientKey { id: string; label: string; hint: string; createdAt: string; }
interface Settings { publicBaseUrl: string; baseUrl: string; }

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(body.error?.message || "Request failed (" + response.status + ")");
  return body;
}

export function mountDashboard(root: HTMLElement): void { void boot(root); }

async function boot(root: HTMLElement): Promise<void> {
  try {
    const status = await requestJson<{ configured: boolean; authenticated: boolean }>("/api/auth/status");
    if (!status.authenticated) { mountSignIn(root, status.configured); return; }
    mountConsole(root);
  } catch (error) {
    root.innerHTML = "<main class=\"dashboard-shell\"><div class=\"dashboard-error\">" + escapeHtml(error instanceof Error ? error.message : "后台暂时不可用") + "</div></main>";
  }
}

function mountSignIn(root: HTMLElement, configured: boolean): void {
  const title = configured ? "登录控制台" : "设置管理员密码";
  const description = configured ? "使用管理员密码进入网关控制台。" : "首次使用请设置管理员密码，保护账号池和客户端 API Keys。";
  root.innerHTML = "<div class=\"dashboard-shell dashboard-auth-shell\"><header class=\"dashboard-header\"><a class=\"brand\" href=\"/\"><img class=\"brand-icon\" src=\"/api-for-cursor-icon.png\" width=\"36\" height=\"36\" alt=\"\"/><span class=\"brand-text\">Cursor Gateway</span></a><a class=\"back-link\" href=\"/\">返回首页</a></header><main class=\"dashboard-auth-main\"><section class=\"dashboard-auth-panel\"><p class=\"dashboard-kicker\">GATEWAY CONSOLE</p><h1>" + title + "</h1><p>" + description + "</p><form id=\"auth-form\"><label>管理员密码<input id=\"auth-password\" type=\"password\" minlength=\"8\" autocomplete=\"" + (configured ? "current-password" : "new-password") + "\" required autofocus/></label><div id=\"auth-error\" class=\"dashboard-notice error\" hidden></div><button class=\"btn btn-primary auth-submit\" type=\"submit\">" + title + "</button></form></section></main></div>";
  root.querySelector<HTMLFormElement>("#auth-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = root.querySelector<HTMLInputElement>("#auth-password")?.value || "";
    const errorBox = root.querySelector<HTMLElement>("#auth-error");
    const submit = root.querySelector<HTMLButtonElement>(".auth-submit");
    if (submit) submit.disabled = true;
    void requestJson(configured ? "/api/auth/login" : "/api/auth/setup", { method: "POST", body: JSON.stringify({ password }) })
      .then(() => boot(root))
      .catch((error) => { if (errorBox) { errorBox.hidden = false; errorBox.textContent = error instanceof Error ? error.message : "操作失败"; } })
      .finally(() => { if (submit) submit.disabled = false; });
  });
}

function mountConsole(root: HTMLElement): void {
  root.innerHTML = consoleMarkup();
  let credentials: Credential[] = [];
  let clientKeys: ClientKey[] = [];
  let settings: Settings = { publicBaseUrl: "", baseUrl: window.location.origin + "/v1" };
  const notice = (message: string, error = false): void => { const el = root.querySelector<HTMLElement>("#dashboard-notice"); if (!el) return; el.hidden = !message; el.textContent = message; el.classList.toggle("error", error); };
  const refresh = async (): Promise<void> => {
    try {
      const [accounts, keys, nextSettings] = await Promise.all([requestJson<{ data?: Credential[] }>("/api/credentials"), requestJson<{ data?: ClientKey[] }>("/api/keys"), requestJson<Settings>("/api/settings")]);
      credentials = accounts.data || []; clientKeys = keys.data || []; settings = nextSettings;
      renderConsole(root, credentials, clientKeys, settings, refresh, notice); notice("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载失败";
      if (/401|unauthor/i.test(message)) { void boot(root); return; }
      notice(message, true);
    }
  };
  const accountDialog = root.querySelector<HTMLDialogElement>("#account-dialog")!;
  const keyDialog = root.querySelector<HTMLDialogElement>("#client-key-dialog")!;
  root.querySelector("#add-account")?.addEventListener("click", () => accountDialog.showModal());
  root.querySelector("#import-accounts")?.addEventListener("click", () => accountDialog.showModal());
  root.querySelector("#cancel-account")?.addEventListener("click", () => accountDialog.close());
  root.querySelector("#refresh-all")?.addEventListener("click", () => void refresh());
  root.querySelector("#logout")?.addEventListener("click", () => { void requestJson("/api/auth/logout", { method: "POST" }).finally(() => boot(root)); });
  root.querySelector("#save-public-url")?.addEventListener("click", () => {
    const publicBaseUrl = root.querySelector<HTMLInputElement>("#public-base-url")?.value || "";
    void requestJson<Settings>("/api/settings", { method: "PUT", body: JSON.stringify({ publicBaseUrl }) }).then((value) => { settings = value; renderConsole(root, credentials, clientKeys, settings, refresh, notice); notice("对外地址已保存"); }).catch((error) => notice(error instanceof Error ? error.message : "保存失败", true));
  });
  root.querySelectorAll<HTMLElement>("[data-copy-target]").forEach((button) => button.addEventListener("click", () => { const input = root.querySelector<HTMLInputElement>("#" + button.dataset.copyTarget); if (input?.value) void navigator.clipboard?.writeText(input.value); }));
  root.querySelector<HTMLFormElement>("#account-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const raw = root.querySelector<HTMLTextAreaElement>("#account-value")?.value || "";
    const label = (root.querySelector<HTMLInputElement>("#account-label")?.value || "Imported").trim() || "Imported";
    const entries = raw.split(/[\r\n]+/).map((line, index) => { const separator = line.indexOf(","); return separator >= 0 ? { label: line.slice(0, separator).trim() || label + " " + (index + 1), cursorApiKey: line.slice(separator + 1).trim() } : { label: raw.includes("\n") ? label + " " + (index + 1) : label, cursorApiKey: line.trim() }; }).filter((item) => item.cursorApiKey);
    if (!entries.length) { notice("请输入至少一把 Cursor API Key", true); return; }
    void Promise.all(entries.map((entry) => requestJson("/api/credentials", { method: "POST", body: JSON.stringify(entry) }))).then(() => { accountDialog.close(); notice("账号已导入"); return refresh(); }).catch((error) => notice(error instanceof Error ? error.message : "导入失败", true));
  });
  root.querySelector("#create-client-key")?.addEventListener("click", () => { root.querySelector<HTMLElement>("#client-key-fields")!.hidden = false; root.querySelector<HTMLElement>("#client-key-result")!.hidden = true; keyDialog.showModal(); });
  root.querySelector("#cancel-client-key")?.addEventListener("click", () => keyDialog.close());
  root.querySelector("#close-client-key")?.addEventListener("click", () => keyDialog.close());
  root.querySelector<HTMLFormElement>("#client-key-form")?.addEventListener("submit", (event) => {
    event.preventDefault(); const label = root.querySelector<HTMLInputElement>("#client-key-label")?.value || "Default";
    void requestJson<{ token: string }>("/api/keys", { method: "POST", body: JSON.stringify({ label }) }).then((created) => { root.querySelector<HTMLElement>("#client-key-fields")!.hidden = true; root.querySelector<HTMLElement>("#client-key-result")!.hidden = false; root.querySelector<HTMLInputElement>("#new-client-key")!.value = created.token; return refresh(); }).catch((error) => notice(error instanceof Error ? error.message : "创建失败", true));
  });
  hydrateIcons(root); void refresh();
}

function consoleMarkup(): string {
  const copy = icon("Copy", { width: 16, height: 16 });
  return "<div class=\"dashboard-shell\"><header class=\"dashboard-header\"><a class=\"brand\" href=\"/\"><img class=\"brand-icon\" src=\"/api-for-cursor-icon.png\" width=\"36\" height=\"36\" alt=\"\"/><span class=\"brand-text\">Cursor Gateway</span></a><div class=\"dashboard-header-right\"><span class=\"dashboard-product\">Control Console</span><button class=\"icon-button\" id=\"logout\" title=\"退出登录\" aria-label=\"退出登录\">" + icon("LogOut", { width: 16, height: 16 }) + "</button></div></header><main class=\"dashboard-main\"><div class=\"dashboard-toolbar\"><div><p class=\"dashboard-kicker\">OPERATIONS</p><h1>网关控制台</h1><p class=\"dashboard-subtitle\">管理 Cursor 账号池、客户端密钥和对外接入地址。</p></div><div class=\"toolbar-actions\"><button class=\"icon-button\" id=\"refresh-all\" title=\"刷新数据\" aria-label=\"刷新数据\">" + icon("RefreshCw", { width: 17, height: 17 }) + "</button><button class=\"btn btn-primary\" id=\"add-account\" type=\"button\">" + icon("Plus", { width: 16, height: 16 }) + " 添加账号</button></div></div><section class=\"dashboard-summary\"><div class=\"summary-item\"><span>账号</span><strong id=\"account-count\">0</strong></div><div class=\"summary-item\"><span>可用</span><strong id=\"healthy-count\">0</strong></div><div class=\"summary-item\"><span>共同模型</span><strong id=\"model-count\">0</strong></div><div class=\"summary-item\"><span>客户端 Key</span><strong id=\"client-key-count\">0</strong></div></section><section class=\"dashboard-section connection-section\"><div class=\"section-bar\"><div><h2>客户端接入</h2><p class=\"section-note\">客户端使用后台创建的独立 <code>sk-...</code> Key，不会接触 Cursor 凭据。</p></div></div><div class=\"connection-grid endpoint-grid\"><label>API Base URL<span class=\"gateway-input\"><input id=\"api-base-url\" readonly/><button class=\"icon-button\" type=\"button\" data-copy-target=\"api-base-url\" title=\"复制 API 地址\" aria-label=\"复制 API 地址\">" + copy + "</button></span></label><label>对外地址<span class=\"endpoint-editor\"><input id=\"public-base-url\" placeholder=\"https://api.example.com\"/><button class=\"btn btn-secondary\" id=\"save-public-url\" type=\"button\">保存</button></span></label></div></section><div id=\"dashboard-notice\" class=\"dashboard-notice\" hidden></div><section class=\"dashboard-section credentials-section\"><div class=\"section-bar\"><div><h2>Cursor 账号</h2><p class=\"section-note\">凭据加密存储；账单错误会自动停用对应模型并切换账号。</p></div><button class=\"btn btn-secondary\" id=\"import-accounts\" type=\"button\">批量导入</button></div><div class=\"credential-table-head\"><span>账号</span><span>模型</span><span>状态</span><span></span></div><div id=\"account-list\"></div></section><section class=\"dashboard-section client-keys-section\"><div class=\"section-bar\"><div><h2>客户端 API Keys</h2><p class=\"section-note\">Key 仅在创建时显示一次，撤销后立即失效。</p></div><button class=\"btn btn-primary\" id=\"create-client-key\" type=\"button\">" + icon("KeyRound", { width: 16, height: 16 }) + " 创建 Key</button></div><div class=\"client-key-head\"><span>名称</span><span>密钥标识</span><span>创建时间</span><span></span></div><div id=\"client-key-list\"></div></section></main><dialog id=\"account-dialog\"><form id=\"account-form\"><h2>添加 Cursor 账号</h2><p class=\"section-note account-key-guide\">从 <a href=\"https://cursor.com/dashboard\" target=\"_blank\" rel=\"noreferrer\">cursor.com/dashboard</a> 左侧打开 API KEY，点击新建后复制页面显示的 <code>crsr_...</code> 密钥。</p><label>名称<input id=\"account-label\" placeholder=\"例如：工作账号\"/></label><label>Cursor API Key<textarea id=\"account-value\" rows=\"7\" placeholder=\"支持多行；批量格式为 名称,Key\"></textarea></label><div class=\"dialog-actions\"><button class=\"btn btn-secondary\" id=\"cancel-account\" type=\"button\">取消</button><button class=\"btn btn-primary\" type=\"submit\">保存并校验</button></div></form></dialog><dialog id=\"client-key-dialog\"><form id=\"client-key-form\"><div id=\"client-key-fields\"><h2>创建客户端 API Key</h2><label>名称<input id=\"client-key-label\" placeholder=\"例如：OpenCode 本机\" required/></label><div class=\"dialog-actions\"><button class=\"btn btn-secondary\" id=\"cancel-client-key\" type=\"button\">取消</button><button class=\"btn btn-primary\" type=\"submit\">创建 Key</button></div></div><div id=\"client-key-result\" hidden><h2>保存此 API Key</h2><p class=\"section-note\">关闭窗口后不能再次查看完整 Key。</p><span class=\"gateway-input\"><input id=\"new-client-key\" readonly/><button class=\"icon-button\" type=\"button\" data-copy-target=\"new-client-key\" title=\"复制 API Key\" aria-label=\"复制 API Key\">" + copy + "</button></span><div class=\"dialog-actions\"><button class=\"btn btn-primary\" id=\"close-client-key\" type=\"button\">完成</button></div></div></form></dialog></div>";
}

function renderConsole(root: HTMLElement, credentials: Credential[], clientKeys: ClientKey[], settings: Settings, refresh: () => Promise<void>, notice: (message: string, error?: boolean) => void): void {
  const active = credentials.filter((item) => item.status === "active");
  const common = active.length ? active.slice(1).reduce((shared, item) => new Set([...shared].filter((model) => item.models.includes(model))), new Set(active[0].models)) : new Set<string>();
  root.querySelector("#account-count")!.textContent = String(credentials.length); root.querySelector("#healthy-count")!.textContent = String(active.length); root.querySelector("#model-count")!.textContent = String(common.size); root.querySelector("#client-key-count")!.textContent = String(clientKeys.length);
  root.querySelector<HTMLInputElement>("#api-base-url")!.value = settings.baseUrl;
  const publicUrl = root.querySelector<HTMLInputElement>("#public-base-url"); if (publicUrl && document.activeElement !== publicUrl) publicUrl.value = settings.publicBaseUrl || window.location.origin;
  const accounts = root.querySelector<HTMLElement>("#account-list")!;
  accounts.innerHTML = credentials.length ? credentials.map((item) => "<div class=\"credential-row\"><div class=\"credential-identity\"><strong>" + escapeHtml(item.label) + "</strong><code>••••" + escapeHtml(item.hint) + "</code></div><div class=\"credential-models\">" + escapeHtml(item.models.length ? item.models.join(", ") : "暂无模型") + "</div><div><span class=\"credential-status " + (item.status === "active" ? "ok\">可用" : "disabled\">已禁用") + "</span></div><div class=\"credential-actions\"><button class=\"icon-button\" data-disable-account=\"" + escapeHtml(item.id) + "\" title=\"禁用账号\" aria-label=\"禁用账号\">" + icon("Trash2", { width: 16, height: 16 }) + "</button></div></div>").join("") : "<div class=\"empty-state\"><strong>还没有 Cursor 账号</strong><span>添加第一把账号 Key，开始建立账号池。</span></div>";
  accounts.querySelectorAll<HTMLElement>("[data-disable-account]").forEach((button) => button.addEventListener("click", () => { void requestJson("/api/credentials/" + encodeURIComponent(button.dataset.disableAccount || ""), { method: "DELETE" }).then(refresh).catch((error) => notice(error instanceof Error ? error.message : "禁用失败", true)); }));
  const keys = root.querySelector<HTMLElement>("#client-key-list")!;
  keys.innerHTML = clientKeys.length ? clientKeys.map((item) => "<div class=\"client-key-row\"><strong>" + escapeHtml(item.label) + "</strong><code>sk-••••" + escapeHtml(item.hint) + "</code><time>" + escapeHtml(new Date(item.createdAt).toLocaleString()) + "</time><button class=\"icon-button\" data-revoke-key=\"" + escapeHtml(item.id) + "\" title=\"撤销 API Key\" aria-label=\"撤销 API Key\">" + icon("Trash2", { width: 16, height: 16 }) + "</button></div>").join("") : "<div class=\"empty-state\"><strong>还没有客户端 API Key</strong><span>创建 Key 后即可接入 OpenAI、Anthropic 或 Responses 客户端。</span></div>";
  keys.querySelectorAll<HTMLElement>("[data-revoke-key]").forEach((button) => button.addEventListener("click", () => { void requestJson("/api/keys/" + encodeURIComponent(button.dataset.revokeKey || ""), { method: "DELETE" }).then(refresh).catch((error) => notice(error instanceof Error ? error.message : "撤销失败", true)); }));
  hydrateIcons(root);
}
