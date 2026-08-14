import {
  addConfigValue,
  createConfigState,
  isConfigDirty,
  removeConfigValue,
  serializeConfigState,
  updateConfigValue,
} from './config-state.mjs';
import {
  addModelDraft,
  createModelRoutingState,
  isModelRoutingDirty,
  isPersistedModelRoutingTarget,
  removeModelDraft,
  serializeModelRoutingOperations,
  undoModelRoutingChange,
  updateModelDraft,
} from './model-routing-state.mjs';

(() => {
  'use strict';

  // 管理 API 始终位于站点根路径；这样 /admin 与 /admin/ 都能使用同一份静态资源。
  const apiUrl = (path) => new URL(`../_admin/api/${path}`, `${location.origin}/admin/`);

  const formatDuration = (milliseconds) => {
    const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days} 天 ${hours} 小时`;
    if (hours) return `${hours} 小时 ${minutes} 分`;
    if (minutes) return `${minutes} 分钟`;
    return `${seconds} 秒`;
  };

  const formatBytes = (value) => {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  };

  const REQUEST_LIMIT_WARNING_THRESHOLDS = Object.freeze({
    maxRequestBytes: 256 * 1024 * 1024,
    maxBufferedRequestBytes: 512 * 1024 * 1024,
  });

  const configResourceRisks = (config) => {
    const risks = [];
    const maxRequestBytes = Number(config?.maxRequestBytes);
    const maxBufferedRequestBytes = Number(config?.maxBufferedRequestBytes);
    if (Number.isFinite(maxRequestBytes)
      && maxRequestBytes > REQUEST_LIMIT_WARNING_THRESHOLDS.maxRequestBytes) {
      risks.push(`单请求 ${formatBytes(maxRequestBytes)}`);
    }
    if (Number.isFinite(maxBufferedRequestBytes)
      && maxBufferedRequestBytes > REQUEST_LIMIT_WARNING_THRESHOLDS.maxBufferedRequestBytes) {
      risks.push(`总缓冲 ${formatBytes(maxBufferedRequestBytes)}`);
    }
    return risks;
  };

  // 纯展示层的易读单位换算；实际提交值不受影响。
  const compactNumber = (value) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value));

  const formatSecondsShort = (milliseconds) => {
    const totalSeconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
    if (totalSeconds % 86400 === 0) return `${totalSeconds / 86400} 天`;
    if (totalSeconds % 3600 === 0) return `${totalSeconds / 3600} 小时`;
    if (totalSeconds % 60 === 0) return `${totalSeconds / 60} 分钟`;
    if (totalSeconds >= 60) return `${(totalSeconds / 60).toFixed(1)} 分钟`;
    return `${totalSeconds} 秒`;
  };

  const humanNumber = (value, key) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    if (/ms$/i.test(key) && number >= 1000) return `≈ ${formatSecondsShort(number)}`;
    if (/bytes$/i.test(key) && number >= 1024) return `≈ ${formatBytes(number)}`;
    if (/(tokens|window)/i.test(key) && number >= 10000) return `≈ ${compactNumber(number)} tokens`;
    return '';
  };

  const formatDateTime = (value) => value
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : '—';

  const persistenceLabel = (mode) => ({
    disabled: '未启用',
    writable: '可读写',
    readonly: '只读',
  })[mode] || mode || '未知';

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const hasOwnPath = (root, path) => {
    let cursor = root;
    for (const segment of path) {
      if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) return false;
      cursor = cursor[segment];
    }
    return true;
  };

  const errorMessageForCode = (code, status) => ({
    revision_conflict: '文件已被其他页面或进程修改。请重新载入后再操作。',
    confirmation_invalid: '确认已失效。请重新预检并确认影响。',
    request_invalid: '请求内容无效，请检查填写内容。',
    target_not_dedicated: '该通道不是唯一的精确专属通道，无法删除。',
    transaction_rolled_back: '保存未完成，系统已安全回滚。',
    transaction_in_doubt: '保存状态暂时无法确认。请重新载入查看当前状态。',
    transaction_failed: '保存没有完成。请稍后重新载入确认当前状态。',
  })[code] || (status >= 500
    ? '服务暂时无法完成操作。请稍后重新载入。'
    : `请求没有完成（HTTP ${status}）。`);

  async function request(path, options = {}) {
    const response = await fetch(apiUrl(path), {
      cache: 'no-store',
      ...options,
      headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      const error = new Error('服务返回了无法识别的内容。请重新载入后重试。');
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const code = typeof body?.error?.code === 'string' ? body.error.code : 'request_failed';
      const error = new Error(errorMessageForCode(code, response.status));
      error.code = code;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  class RouterAdmin extends HTMLElement {
    constructor() {
      super();
      this.status = null;
      this.configState = null;
      this.checkpoints = null;
      this.validation = null;
      this.modelRoutingState = null;
      this.modelValidationCache = null;
      this.modelRoutingError = null;
      this.modelDialogReturnFocus = null;
      this.pendingDeleteSlug = null;
      this.dirty = false;
      this.busy = new Set();
      this.initialized = false;
      this.resyncRequired = false;
      this.loadEpoch = 0;
      this.activeReloadPromise = null;
      this.activeResyncPromise = null;
      this.modelFilters = { query: '', status: 'all', channel: 'all', capability: 'all', sort: 'name-asc' };
      this.channelsExpanded = false;
      this.openConfigGroups = new Set();
      this.openTargetEditor = null;
    }

    connectedCallback() {
      if (this.initialized) return;
      this.initialized = true;
      this.renderShell();
      this.bindEvents();
      this.reload();
    }

    renderShell() {
      this.innerHTML = `
        <header class="topbar">
          <a class="brand" href="#overview" aria-label="Codex 路由管理首页">
            <span class="brand-mark" aria-hidden="true">CR</span>
            <span class="brand-text"><strong>Codex Router</strong><small>本地管理台</small></span>
          </a>
          <nav class="desktop-nav" aria-label="页面导航">
            <a href="#overview">总览</a>
            <a href="#custom-models">模型管理</a>
            <a href="#configuration">高级设置</a>
            <a href="#checkpoints">检查点</a>
          </nav>
          <div class="topbar-actions">
            <button class="button ghost compact" type="button" data-action="reload">刷新状态</button>
            <button class="button ghost compact menu-button" type="button" data-action="toggle-menu" aria-expanded="false" aria-controls="mobile-menu" aria-label="打开导航菜单">
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div id="mobile-menu" class="mobile-menu" hidden>
            <a href="#overview">总览</a>
            <a href="#custom-models">模型管理</a>
            <a href="#configuration">高级设置</a>
            <a href="#checkpoints">检查点</a>
          </div>
        </header>
        <main>
          <div class="page-head">
            <div>
              <h1 id="page-title">路由管理</h1>
              <p class="page-subtitle">本机多模型路由的运行状态与配置。凭据只留在路由进程中，不会出现在页面。</p>
            </div>
            <span class="live-pill"><i></i>本机进程</span>
          </div>

          <div id="restart-notice" class="notice restart" role="status" hidden>
            <strong>配置已保存</strong>
            <span>新配置需要人工重启路由后生效。本页面不会自动重启进程。</span>
          </div>
          <div id="global-message" class="notice" role="alert" hidden></div>
          <div id="resync-notice" class="notice" role="alert" hidden>
            <strong>需要重新载入</strong>
            <span>正在取得两份最新基线。为避免覆盖新配置，编辑与保存已冻结。</span>
            <button class="button secondary compact" type="button" data-action="resync-reload">重新载入</button>
          </div>
          <div id="conflict-actions" class="notice" role="alert" hidden></div>

          <section id="overview" class="section" aria-labelledby="overview-title">
            <div class="section-heading"><h2 id="overview-title">运行总览</h2></div>
            <div id="overview-grid" class="status-grid" aria-live="polite"><div class="skeleton card"></div><div class="skeleton card"></div><div class="skeleton card"></div><div class="skeleton card"></div></div>
            <div class="overview-actions">
              <button class="button primary" type="button" data-action="model-add" disabled>添加模型</button>
              <button class="button secondary" type="button" data-action="goto-models">管理模型</button>
              <button class="button ghost" type="button" data-action="goto-advanced">高级设置</button>
            </div>
          </section>

          <section id="custom-models" class="section" aria-labelledby="custom-models-title">
            <div class="section-heading"><h2 id="custom-models-title">模型管理</h2><span id="model-dirty-badge" class="dirty-badge" hidden>有未保存更改</span></div>
            <p class="section-desc">这里管理模型目录与通道关联；不会显示或收集凭据内容。保存后需手动重启路由与 Codex，页面不会自动重启。</p>
            <div id="channel-summary" class="channel-summary" aria-live="polite"></div>
            <div id="channel-grid" class="channel-grid" aria-live="polite" hidden></div>
            <div id="model-filter-bar" class="filter-bar">
              <label class="filter-search"><span class="sr-only">搜索模型</span><input id="model-search" type="search" placeholder="搜索名称或标识…" autocomplete="off"></label>
              <label class="filter-item"><span>状态</span><select id="model-filter-status"><option value="all">全部状态</option><option value="ready">可用</option><option value="attention">待配置</option></select></label>
              <label class="filter-item"><span>通道</span><select id="model-filter-channel"><option value="all">全部通道</option></select></label>
              <label class="filter-item"><span>能力</span><select id="model-filter-capability"><option value="all">全部能力</option><option value="text">文本</option><option value="image">图片</option></select></label>
              <label class="filter-item"><span>排序</span><select id="model-sort"><option value="name-asc">名称 A→Z</option><option value="name-desc">名称 Z→A</option><option value="status-first">待配置优先</option><option value="context-desc">上下文从大到小</option></select></label>
              <span id="model-count" class="filter-count" aria-live="polite"></span>
            </div>
            <div class="model-toolbar">
              <button class="button primary" type="button" data-action="model-add" disabled>新增自定义模型</button>
              <button class="button secondary" type="button" data-action="model-undo" disabled>撤销最近更改</button>
            </div>
            <div id="model-routing-panel" class="model-routing-panel" aria-live="polite"><div class="skeleton form"></div></div>
            <div id="model-validation-results" class="validation-results" aria-live="polite"></div>
            <div class="sticky-actions model-actions">
              <span id="model-save-hint">正在载入自定义模型…</span>
              <div>
                <button class="button secondary" type="button" data-action="model-validate" disabled>预检更改</button>
                <button class="button primary" type="button" data-action="model-save" disabled>保存自定义模型</button>
              </div>
            </div>
          </section>

          <section id="configuration" class="section" aria-labelledby="configuration-title">
            <div class="section-heading"><h2 id="configuration-title">高级设置</h2><span id="dirty-badge" class="dirty-badge" hidden>有未保存更改</span></div>
            <p class="section-desc">面向进阶用户的底层配置。每个分组默认只显示当前状态，点击“编辑”后才会展开具体控件。API Key、Token、Authorization 等敏感字段不会显示或提供编辑入口，保存时由路由安全保留原值；未知扩展字段和注释也会原样保留。</p>
            <form id="config-form" novalidate aria-describedby="config-help">
              <p id="config-help" class="sr-only">修改后先预检，确认无错误再保存。保存不会自动重启路由。</p>
              <div id="config-fields"><div class="skeleton form"></div></div>
              <div id="validation-results" class="validation-results" aria-live="polite"></div>
              <div class="sticky-actions">
                <span id="save-hint">载入配置后即可编辑</span>
                <div>
                  <button class="button secondary" type="button" data-action="validate" disabled>预检配置</button>
                  <button class="button primary" type="submit" disabled>保存配置</button>
                </div>
              </div>
            </form>
          </section>

          <section id="checkpoints" class="section" aria-labelledby="checkpoints-title">
            <div class="section-heading"><h2 id="checkpoints-title">长任务检查点</h2><button class="button ghost compact" type="button" data-action="refresh-checkpoints">刷新</button></div>
            <div id="checkpoint-panel" class="checkpoint-panel" aria-live="polite"><div class="skeleton form"></div></div>
          </section>
        </main>
        <footer><span>Codex Multi-Model Router</span><span>所有操作仅作用于本机配置</span></footer>

        <dialog id="clear-dialog" aria-labelledby="clear-title">
          <form method="dialog">
            <div class="dialog-icon" aria-hidden="true">!</div>
            <h2 id="clear-title">确认清空全部检查点？</h2>
            <p>进行中的长任务可能失去裁剪前的目标摘要。此操作无法在管理页撤销。</p>
            <div class="dialog-actions">
              <button class="button secondary" value="cancel">取消</button>
              <button class="button danger" value="confirm">确认清空</button>
            </div>
          </form>
        </dialog>

        <dialog id="model-dialog" aria-labelledby="model-dialog-title"></dialog>
        <dialog id="delete-model-dialog" aria-labelledby="delete-model-title"></dialog>`;
    }

    bindEvents() {
      this.addEventListener('click', (event) => {
        const menuLink = event.target.closest('#mobile-menu a');
        if (menuLink) this.toggleMobileMenu(false);
        const rowEdit = event.target.closest('.model-row-main');
        if (rowEdit?.dataset.slug) {
          this.openModelDialog(rowEdit.dataset.slug);
          return;
        }
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'reload') this.reload();
        if (action === 'resync-reload') this.resyncBaselines();
        if (action === 'discard-model-drafts-reload') this.discardDraftsAndReload('model');
        if (action === 'discard-config-drafts-reload') this.discardDraftsAndReload('config');
        if (action === 'validate') this.validateConfig();
        if (action === 'toggle-menu') this.toggleMobileMenu();
        if (action === 'goto-models') this.gotoSection('#custom-models');
        if (action === 'goto-advanced') this.gotoSection('#configuration');
        if (action === 'goto-checkpoints') this.gotoSection('#checkpoints');
        if (action === 'refresh-checkpoints') this.loadCheckpoints();
        if (action === 'clear-checkpoints') this.openClearDialog();
        if (action === 'toggle-channels') {
          this.channelsExpanded = !this.channelsExpanded;
          this.renderChannels();
        }
        if (action === 'toggle-config-group') {
          const group = event.target.closest('[data-group]')?.dataset.group;
          if (group) {
            if (this.openConfigGroups.has(group)) this.openConfigGroups.delete(group);
            else this.openConfigGroups.add(group);
            this.renderConfig();
          }
        }
        if (action === 'toggle-target-editor') {
          const editor = event.target.closest('[data-target-index]');
          if (editor) {
            this.openTargetEditor = this.openTargetEditor === editor.dataset.targetIndex ? null : editor.dataset.targetIndex;
            this.renderConfig();
          }
        }
        if (action === 'model-add') this.openModelDialog();
        if (action === 'model-edit') this.openModelDialog(event.target.closest('[data-slug]')?.dataset.slug);
        if (action === 'model-delete') this.openDeleteModelDialog(event.target.closest('[data-slug]')?.dataset.slug);
        if (action === 'model-clear-filters') {
          this.modelFilters = { query: '', status: 'all', channel: 'all', capability: 'all', sort: 'name-asc' };
          this.syncModelFilterControls();
          this.renderModelRouting();
        }
        if (action === 'model-undo') this.undoModelChange();
        if (action === 'model-validate') this.validateModelRouting();
        if (action === 'model-save') this.saveModelRouting();
        if (action === 'model-dialog-cancel') this.closeModelDialog();
        if (action === 'delete-model-cancel') this.closeDeleteModelDialog();
        if (action === 'delete-model-confirm') this.deleteModelDraft();
      });
      this.querySelector('#model-search').addEventListener('input', (event) => {
        this.modelFilters.query = event.target.value;
        this.renderModelRouting();
      });
      this.querySelector('#model-filter-status').addEventListener('change', (event) => {
        this.modelFilters.status = event.target.value;
        this.renderModelRouting();
      });
      this.querySelector('#model-filter-channel').addEventListener('change', (event) => {
        this.modelFilters.channel = event.target.value;
        this.renderModelRouting();
      });
      this.querySelector('#model-filter-capability').addEventListener('change', (event) => {
        this.modelFilters.capability = event.target.value;
        this.renderModelRouting();
      });
      this.querySelector('#model-sort').addEventListener('change', (event) => {
        this.modelFilters.sort = event.target.value;
        this.renderModelRouting();
      });
      this.querySelector('#config-form').addEventListener('submit', (event) => {
        event.preventDefault();
        this.saveConfig();
      });
      this.querySelector('#config-fields').addEventListener('input', (event) => this.updateConfig(event));
      this.querySelector('#config-fields').addEventListener('change', (event) => this.updateConfig(event));
      this.querySelector('#clear-dialog').addEventListener('close', (event) => {
        if (event.target.returnValue === 'confirm') this.clearCheckpoints();
      });
      this.querySelector('#model-dialog').addEventListener('close', () => this.restoreModelDialogFocus());
      this.querySelector('#delete-model-dialog').addEventListener('close', () => this.restoreModelDialogFocus());
      this.querySelector('#model-dialog').addEventListener('submit', (event) => {
        event.preventDefault();
        this.saveModelDialog();
      });
      this.querySelector('#model-dialog').addEventListener('change', (event) => {
        if (event.target.matches('[data-model-target]')) this.fillModelTargetFields(event.target.value);
        if (event.target.matches('#model-routing-mode')) this.fillModelTargetFields(
          this.querySelector('#model-target-ref').value,
        );
      });
      window.addEventListener('beforeunload', (event) => {
        if (!this.dirty) return;
        event.preventDefault();
        event.returnValue = '';
      });
    }

    toggleMobileMenu(force) {
      const menu = this.querySelector('#mobile-menu');
      const button = this.querySelector('[data-action="toggle-menu"]');
      if (!menu || !button) return;
      const open = force === undefined ? menu.hidden : Boolean(force);
      menu.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
    }

    gotoSection(selector) {
      this.toggleMobileMenu(false);
      const target = this.querySelector(selector);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    isCurrentLoad(epoch) {
      return epoch === this.loadEpoch;
    }

    async reload() {
      if (this.resyncRequired) return this.resyncBaselines();
      if (this.dirty) {
        this.showMessage('当前有未保存更改。请先保存，或重新打开页面以放弃这些更改。');
        return false;
      }
      if (this.activeReloadPromise) return this.activeReloadPromise;
      const epoch = ++this.loadEpoch;
      const run = this.reloadAtEpoch(epoch);
      this.activeReloadPromise = run;
      try {
        return await run;
      } finally {
        if (this.isCurrentLoad(epoch) && this.activeReloadPromise === run) this.activeReloadPromise = null;
      }
    }

    async reloadAtEpoch(epoch) {
      if (!this.isCurrentLoad(epoch)) return false;
      this.clearMessage();
      const results = await Promise.allSettled([
        this.loadStatus(epoch),
        this.loadConfig(epoch),
        this.loadModelRouting(epoch),
        this.loadCheckpoints(epoch),
      ]);
      if (!this.isCurrentLoad(epoch)) return false;
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) this.showMessage(failed.reason.message);
      return !failed;
    }

    freezeForResync() {
      this.resyncRequired = true;
      this.configState = null;
      this.modelRoutingState = null;
      this.validation = null;
      this.modelValidationCache = null;
      this.dirty = false;
      this.modelRoutingError = '正在重新载入两份最新基线…';
      this.renderConfigUnavailable('正在重新载入最新高级配置…');
      this.renderModelRouting();
      this.setDirty();
      this.querySelector('#resync-notice').hidden = false;
    }

    async resyncBaselines() {
      if (this.activeResyncPromise) return this.activeResyncPromise;
      const epoch = ++this.loadEpoch;
      // 新的 resync 使任何尚未完成的普通加载失效，不能再占用 reload 去重槽位。
      this.activeReloadPromise = null;
      const run = this.resyncAtEpoch(epoch);
      this.activeResyncPromise = run;
      try {
        return await run;
      } finally {
        if (this.isCurrentLoad(epoch) && this.activeResyncPromise === run) this.activeResyncPromise = null;
      }
    }

    async resyncAtEpoch(epoch) {
      if (!this.isCurrentLoad(epoch)) return false;
      this.freezeForResync();
      const results = await Promise.allSettled([this.fetchConfigPayload(), this.fetchModelRoutingPayload()]);
      if (!this.isCurrentLoad(epoch)) return false;
      if (results.every((result) => result.status === 'fulfilled')) {
        try {
          this.commitConfigPayload(results[0].value, epoch);
          this.commitModelRoutingPayload(results[1].value, epoch);
        } catch {
          return this.keepResyncFrozen();
        }
        if (!this.isCurrentLoad(epoch)) return false;
        this.resyncRequired = false;
        this.modelRoutingError = null;
        this.querySelector('#resync-notice').hidden = true;
        this.clearConflictActions();
        this.setDirty();
        this.renderConfig();
        this.renderModelRouting();
        return true;
      }
      return this.keepResyncFrozen();
    }

    keepResyncFrozen() {
      // 任一读取或解析失败时，不保留可能已经更新的单侧状态，防止旧基线被再次保存。
      this.configState = null;
      this.modelRoutingState = null;
      this.validation = null;
      this.modelValidationCache = null;
      this.modelRoutingError = '重新载入未完成；编辑与保存继续冻结。';
      this.renderConfigUnavailable('重新载入未完成；请使用“重新载入”再次尝试。');
      this.renderModelRouting();
      this.setDirty();
      this.showMessage('重新载入未完成；为避免覆盖新配置，页面仍处于冻结状态。');
      return false;
    }

    async discardDraftsAndReload(scope) {
      const configDirty = this.configState && isConfigDirty(this.configState);
      const modelDirty = this.modelRoutingState && isModelRoutingDirty(this.modelRoutingState);
      if (scope === 'model' && configDirty) {
        this.showMessage('高级配置另一侧仍有未保存更改；请先处理高级配置，模型草稿未被放弃。');
        return false;
      }
      if (scope === 'config' && modelDirty) {
        this.showMessage('自定义模型另一侧仍有未保存更改；请先处理模型草稿，高级配置未被放弃。');
        return false;
      }
      if (scope === 'model') {
        this.modelRoutingState = null;
        this.modelValidationCache = null;
      } else {
        this.configState = null;
        this.validation = null;
      }
      this.clearConflictActions();
      this.showMessage(scope === 'model'
        ? '已放弃当前模型草稿，正在重新载入。'
        : '已放弃当前高级配置草稿，正在重新载入。');
      return this.resyncBaselines();
    }

    async loadStatus(epoch = this.loadEpoch) {
      const payload = await request('status');
      if (!this.isCurrentLoad(epoch)) return false;
      this.status = payload;
      this.renderOverview();
      this.renderChannels();
      return true;
    }

    async fetchConfigPayload() {
      return request('config');
    }

    commitConfigPayload(payload, epoch) {
      if (!this.isCurrentLoad(epoch)) return false;
      this.configState = createConfigState(payload);
      this.validation = null;
      this.setDirty();
      this.renderConfig();
      return true;
    }

    async loadConfig(epoch = this.loadEpoch) {
      const payload = await this.fetchConfigPayload();
      return this.commitConfigPayload(payload, epoch);
    }

    renderConfigUnavailable(message) {
      const root = this.querySelector('#config-fields');
      root.replaceChildren(el('p', 'empty-state', message));
      this.updateConfigControls();
    }

    async fetchModelRoutingPayload() {
      return request('model-routing');
    }

    commitModelRoutingPayload(payload, epoch) {
      if (!this.isCurrentLoad(epoch)) return false;
      this.modelRoutingState = createModelRoutingState(payload);
      this.modelRoutingError = null;
      this.modelValidationCache = null;
      this.setDirty();
      this.renderModelRouting();
      return true;
    }

    async loadModelRouting(epoch = this.loadEpoch) {
      try {
        const payload = await this.fetchModelRoutingPayload();
        return this.commitModelRoutingPayload(payload, epoch);
      } catch (error) {
        if (!this.isCurrentLoad(epoch)) return false;
        this.modelRoutingState = null;
        this.modelValidationCache = null;
        this.modelRoutingError = '自定义模型暂时无法载入，请刷新后重试。';
        this.renderModelRouting();
        const safeError = new Error(this.modelRoutingError);
        safeError.status = error.status;
        throw safeError;
      }
    }

    async loadCheckpoints(epoch = this.loadEpoch) {
      const payload = await request('checkpoints');
      if (!this.isCurrentLoad(epoch)) return false;
      this.checkpoints = payload;
      this.renderCheckpoints();
      return true;
    }

    renderOverview() {
      const data = this.status;
      const grid = this.querySelector('#overview-grid');
      if (!data) return;
      const targets = data.targets || [];
      const readyCount = targets.filter((target) => target.envSet).length;
      const warningCount = data.warningCount ?? 0;
      const resourceRisks = configResourceRisks(this.configState?.config);
      const hasConfigWarning = warningCount > 0 || resourceRisks.length > 0;
      const models = this.modelRoutingState?.models || [];
      const modelCount = models.length;
      const attentionModels = models.filter((model) => {
        const refs = this.modelBindings(model.slug);
        const bound = refs.map((ref) => this.modelRoutingState.targets.find((item) => item.targetRef === ref)).filter(Boolean);
        return !(refs.length > 0 && bound.length === refs.length && bound.every((target) => target.envSet));
      }).length;
      const restartRequired = !this.querySelector('#restart-notice')?.hidden;

      const card = ({ label, value, note, tone, actionLabel, action, icon }) => {
        const node = el('article', `status-card${tone ? ` ${tone}` : ''}`);
        const top = el('div', 'status-card-top');
        top.append(el('span', 'status-card-icon', icon), el('span', 'status-card-label', label));
        node.append(top, el('strong', 'status-card-value', value), el('p', 'status-card-note', note));
        if (actionLabel && action) {
          const link = el('button', 'status-card-link', actionLabel);
          link.type = 'button';
          link.dataset.action = action;
          node.append(link);
        }
        return node;
      };

      grid.replaceChildren(
        card({
          label: '路由进程',
          value: '在线',
          note: `本机进程已运行 ${formatDuration(data.uptimeMs)} · 端口 ${data.port ?? '—'}`,
          tone: 'ok',
          icon: '●',
        }),
        card({
          label: '模型',
          value: modelCount ? `${modelCount} 个` : `${targets.length} 条通道`,
          note: modelCount
            ? (attentionModels
                ? `${attentionModels} 个配置或凭据待确认；未探测上游`
                : '配置与凭据存在；未探测上游')
            : '模型目录载入后可查看配置；未探测上游',
          tone: attentionModels ? 'warn' : 'ok',
          icon: attentionModels ? '!' : '●',
          actionLabel: '管理模型',
          action: 'goto-models',
        }),
        card({
          label: '配置告警',
          value: warningCount ? `${warningCount} 条` : (resourceRisks.length ? '高资源风险' : '无'),
          note: resourceRisks.length
            ? `⚠ 高资源配置：${resourceRisks.join('、')}${warningCount ? `；启动预检共 ${warningCount} 条提醒` : ''}`
            : (warningCount ? '建议在高级设置中预检并查看详情' : '启动预检未发现问题'),
          tone: hasConfigWarning ? 'warn' : 'ok',
          icon: hasConfigWarning ? '⚠' : '●',
          actionLabel: hasConfigWarning ? '前往高级设置' : '',
          action: hasConfigWarning ? 'goto-advanced' : '',
        }),
        card({
          label: '生效状态',
          value: restartRequired ? '已保存，待重启' : '当前进程已加载',
          note: restartRequired
            ? '需手动重启路由；重启前仍使用旧配置'
            : `凭据配置 ${readyCount}/${targets.length} 条存在；未探测上游`,
          tone: restartRequired ? 'warn' : 'ok',
          icon: restartRequired ? '!' : '●',
          actionLabel: '',
          action: '',
        }),
      );
    }

    renderChannels() {
      const summary = this.querySelector('#channel-summary');
      const grid = this.querySelector('#channel-grid');
      const targets = this.status?.targets || [];
      if (!targets.length) {
        if (summary) {
          summary.replaceChildren(el('p', 'empty-state', '当前没有可用的模型通道。'));
          summary.hidden = false;
        }
        grid.hidden = true;
        grid.replaceChildren();
        return;
      }
      const attention = targets.filter((target) => !target.envSet);
      const expanded = this.channelsExpanded || attention.length > 0;
      if (summary) {
        const pill = el(
          'span',
          `status-dot ${attention.length ? 'warning' : 'ready'}`,
          attention.length ? `${attention.length} 条凭据待配置` : '凭据已配置 · 未探测上游',
        );
        const text = el('span', 'channel-summary-text', `${targets.length} 条服务通道 · ${targets.filter((t) => t.viaProxy).length} 条走代理`);
        const toggle = el('button', 'button ghost compact', expanded ? '收起通道详情' : '查看通道详情');
        toggle.type = 'button';
        toggle.dataset.action = 'toggle-channels';
        toggle.setAttribute('aria-expanded', String(expanded));
        summary.replaceChildren(pill, text, toggle);
        summary.hidden = false;
      }
      if (!expanded) {
        grid.hidden = true;
        grid.replaceChildren();
        return;
      }
      grid.hidden = false;
      grid.replaceChildren(...targets.map((target) => {
        const card = el('article', 'channel-card');
        const head = el('div', 'channel-head');
        const symbol = el('span', 'channel-symbol', String(target.name || '?').slice(0, 2).toUpperCase());
        const title = el('div');
        title.append(el('h3', '', target.name || '未命名通道'), el('p', '', target.match || '未设置匹配规则'));
        head.append(symbol, title, el(
          'span',
          `status-dot ${target.envSet ? 'ready' : 'warning'}`,
          target.envSet ? '凭据已配置 · 未探测' : '凭据待配置',
        ));
        const details = el('dl', 'channel-details');
        [
          ['接口类型', target.wireApi === 'chat' ? 'Chat Completions' : (target.wireApi || 'Responses')],
          ['上游模型', target.upstreamModel || '跟随请求'],
          ['网络', target.viaProxy ? 'HTTP 代理' : '直接连接'],
        ].forEach(([term, value]) => {
          details.append(el('dt', '', term), el('dd', '', value));
        });
        card.append(head, details);
        return card;
      }));
    }

    renderConfig() {
      const root = this.querySelector('#config-fields');
      const config = this.configState?.config;
      if (!config) return;
      root.replaceChildren();

      // 基础设置 → 本机服务
      {
        const group = this.configGroup('basics', '本机服务', '路由监听与请求资源上限', () => {
          const resourceRisks = configResourceRisks(config);
          const parts = [];
          if (Object.hasOwn(config, 'port')) parts.push(`端口 ${config.port}`);
          if (Object.hasOwn(config, 'maxConcurrentRequests')) parts.push(`并发 ${config.maxConcurrentRequests}`);
          if (Object.hasOwn(config, 'maxRequestBytes')) parts.push(`单请求 ${formatBytes(config.maxRequestBytes)}`);
          if (Object.hasOwn(config, 'maxBufferedRequestBytes')) parts.push(`缓冲 ${formatBytes(config.maxBufferedRequestBytes)}`);
          if (Object.hasOwn(config, 'heartbeatMs')) parts.push(`心跳 ${formatSecondsShort(config.heartbeatMs)}`);
          if (resourceRisks.length) parts.push(`⚠ 高内存风险：${resourceRisks.join('、')}`);
          return parts;
        });
        const appendRootNumber = (label, key, min, max) => {
          if (Object.hasOwn(config, key)) group.body.append(this.numberField(label, [key], config[key], min, max));
        };
        appendRootNumber('监听端口', 'port', 1, 65535);
        appendRootNumber('SSE 心跳（毫秒）', 'heartbeatMs', 1);
        appendRootNumber('单请求上限（字节）', 'maxRequestBytes', 1);
        appendRootNumber('最大并发请求', 'maxConcurrentRequests', 1);
        appendRootNumber('缓冲总上限（字节）', 'maxBufferedRequestBytes', 1);
        if (group.body.childElementCount) root.append(group.node);
      }

      // 网络与代理
      if (config.proxy && typeof config.proxy === 'object' && !Array.isArray(config.proxy)) {
        const group = this.configGroup('proxy', '网络与代理', '仅供开启“走代理”的通道使用', () => {
          const host = config.proxy.host ?? '';
          const port = config.proxy.port ?? '';
          return [host ? `公共代理 ${host}${port ? `:${port}` : ''}` : '未配置公共代理'];
        });
        if (Object.hasOwn(config.proxy, 'host')) group.body.append(this.textField('代理地址', ['proxy', 'host'], config.proxy.host, '127.0.0.1'));
        if (Object.hasOwn(config.proxy, 'port')) group.body.append(this.numberField('代理端口', ['proxy', 'port'], config.proxy.port, 1, 65535));
        if (group.body.childElementCount) root.append(group.node);
      }

      // 超时
      if (config.timeouts && typeof config.timeouts === 'object' && !Array.isArray(config.timeouts)) {
        const group = this.configGroup('timeouts', '超时', '长任务建议保留充足等待时间', () => [
          `连接 ${formatSecondsShort(config.timeouts.connectMs)}`,
          `响应头 ${formatSecondsShort(config.timeouts.responseHeaderMs)}`,
          `流空闲 ${formatSecondsShort(config.timeouts.streamIdleMs)}`,
          `总超时 ${formatSecondsShort(config.timeouts.requestMs)}`,
        ]);
        [
          ['连接超时', 'connectMs'],
          ['响应头超时', 'responseHeaderMs'],
          ['流空闲超时', 'streamIdleMs'],
          ['请求总超时', 'requestMs'],
        ].forEach(([label, key]) => {
          if (Object.hasOwn(config.timeouts, key)) group.body.append(this.numberField(label, ['timeouts', key], config.timeouts[key], 1));
        });
        if (group.body.childElementCount) root.append(group.node);
      }

      this.renderModelContextGroups(root, config);
      this.renderGoalCheckpointGroup(root, config);
      this.renderVisionRelayGroup(root, config);

      // 服务通道：默认摘要列表，单条展开编辑
      {
        const targets = config.targets || [];
        const group = this.configGroup('channels', '服务通道', '凭据是否就绪与上游连接；敏感请求头不会出现在表单中', () => [
          `${targets.length} 条通道`,
          ...targets.slice(0, 3).map((target) => target.name || target.match || '未命名'),
          targets.length > 3 ? '…' : '',
        ].filter(Boolean));
        const list = el('div', 'config-channel-list');
        targets.forEach((target, index) => list.append(this.configChannelRow(target, index)));
        group.body.append(list);
        root.append(group.node);
      }

      this.querySelector('#save-hint').textContent = '建议先预检，再保存到 config.json';
      this.updateConfigControls();
    }

    // 手风琴分组：头部（标题+摘要+编辑按钮）+ 默认折叠的控件体。
    configGroup(id, title, description, summaryFn) {
      const open = this.openConfigGroups.has(id);
      const node = el('section', `config-group${open ? ' open' : ''}`);
      node.dataset.group = id;
      const head = el('div', 'config-group-head');
      const titleWrap = el('div', 'config-group-title');
      titleWrap.append(el('h3', '', title), el('p', '', description));
      const summary = el('div', 'config-group-summary');
      (summaryFn() || []).forEach((part) => summary.append(el('span', 'summary-chip', part)));
      const toggle = el('button', 'button ghost compact', open ? '收起' : '编辑');
      toggle.type = 'button';
      toggle.dataset.action = 'toggle-config-group';
      toggle.setAttribute('aria-expanded', String(open));
      head.append(titleWrap, summary, toggle);
      const body = el('div', 'field-grid config-group-body');
      body.hidden = !open;
      node.append(head, body);
      return { node, body };
    }

    // 服务通道默认只显示名称/地址/接口/连接/凭据，单条“编辑通道”才展开完整字段。
    configChannelRow(target, index) {
      const key = String(index);
      const open = this.openTargetEditor === key;
      const row = el('div', `config-channel-row${open ? ' open' : ''}`);
      row.dataset.targetIndex = key;
      const summary = el('div', 'config-channel-summary');
      const name = el('div', 'config-channel-name');
      name.append(el('strong', '', target.name || `通道 ${index + 1}`), el('span', 'config-channel-match', target.match || '未设置匹配'));
      const protocol = target.protocol || 'https';
      const host = target.host || '未配置主机';
      const prefix = target.prefix || '';
      const address = el('span', 'config-channel-meta', `${protocol}://${host}${prefix}`);
      const wire = el('span', 'config-channel-meta', target.wireApi === 'chat' ? 'Chat Completions' : 'Responses');
      const network = el('span', 'config-channel-meta', target.viaProxy ? '走代理' : '直连');
      const runtimeReady = this.channelEnvReady(target);
      let credentialTone = 'unknown';
      let credentialText = '凭据状态待确认';
      if (target.envKey) {
        if (runtimeReady === true) {
          credentialTone = 'ready';
          credentialText = '凭据已配置 · 未探测';
        } else if (runtimeReady === false) {
          credentialTone = 'warning';
          credentialText = '凭据待配置';
        }
      } else if (target.useOpenAiAuth) {
        if (runtimeReady === true) {
          credentialTone = 'ready';
          credentialText = '官方登录态已配置 · 未探测';
        } else if (runtimeReady === false) {
          credentialTone = 'warning';
          credentialText = '官方登录态待配置';
        } else {
          credentialText = '官方登录态待确认';
        }
      } else {
        credentialTone = 'unknown';
        credentialText = '未声明凭据 · 未探测';
      }
      const cred = el('span', `status-dot ${credentialTone}`, credentialText);
      const toggle = el('button', 'button ghost compact', open ? '收起' : '编辑通道');
      toggle.type = 'button';
      toggle.dataset.action = 'toggle-target-editor';
      toggle.setAttribute('aria-expanded', String(open));
      summary.append(name, address, wire, network, cred, toggle);
      row.append(summary);
      if (open) {
        const editor = el('div', 'config-channel-editor');
        editor.append(this.targetEditor(target, index));
        row.append(editor);
      }
      return row;
    }

    channelEnvReady(target) {
      const statusTarget = (this.status?.targets || []).find((item) => item.name && item.name === target.name);
      return statusTarget ? Boolean(statusTarget.envSet) : null;
    }

    renderModelContextGroups(root, config) {
      // 复杂配置使用显式字段白名单，既保留未知扩展，也不会把它们误当成可编辑项。
      const context = config.modelContext;
      if (context && typeof context === 'object' && !Array.isArray(context)) {
        const group = this.configGroup('context', '上下文与输出预算', '模型目录上下文窗口、自动压缩与能力预算', () => {
          const parts = [];
          if (Object.hasOwn(context, 'enabled')) parts.push(context.enabled ? '目录写回启用' : '目录写回关闭');
          if (Object.hasOwn(context, 'contextWindow')) parts.push(`窗口 ${compactNumber(context.contextWindow)} tokens`);
          if (Object.hasOwn(context, 'autoCompactTokenLimit')) parts.push(`压缩阈值 ${compactNumber(context.autoCompactTokenLimit)}`);
          if (Array.isArray(config.modelCapabilities)) parts.push(`${config.modelCapabilities.length} 条能力规则`);
          return parts;
        });
        if (Object.hasOwn(context, 'enabled')) group.body.append(this.booleanField('启用目录写回', ['modelContext', 'enabled'], context.enabled));
        if (Object.hasOwn(context, 'contextWindow')) group.body.append(this.numberField('上下文窗口（tokens）', ['modelContext', 'contextWindow'], context.contextWindow, 1));
        if (Object.hasOwn(context, 'autoCompactTokenLimit')) group.body.append(this.numberField('自动压缩阈值（tokens）', ['modelContext', 'autoCompactTokenLimit'], context.autoCompactTokenLimit, 0));
        if (Object.hasOwn(context, 'slugs') && Array.isArray(context.slugs)) {
          group.body.append(this.stringArrayField('应用模型', ['modelContext', 'slugs'], context.slugs, '每行填写一个模型 slug'));
        }
        if (Array.isArray(config.modelCapabilities)) {
          const sub = el('div', 'subsection-title');
          sub.append(el('strong', '', '模型能力预算'), el('span', '', '每条规则按顺序匹配模型，设置上下文与输出预算'));
          group.body.append(sub);
          const list = el('div', 'target-list capability-list');
          config.modelCapabilities.forEach((capability, index) => {
            if (!capability || typeof capability !== 'object' || Array.isArray(capability)) return;
            const card = el('section', 'target-editor capability-editor');
            card.setAttribute('aria-labelledby', `capability-${index}-title`);
            const head = el('div', 'target-editor-head');
            const titleWrap = el('div');
            titleWrap.append(el('span', 'target-number', String(index + 1).padStart(2, '0')));
            const title = el('h3', '', capability.match || `能力规则 ${index + 1}`);
            title.id = `capability-${index}-title`;
            titleWrap.append(title);
            head.append(titleWrap, el('span', 'protocol-badge', 'TOKEN BUDGET'));
            const fields = el('div', 'field-grid capability-fields');
            const addText = (label, key) => {
              if (Object.hasOwn(capability, key)) fields.append(this.textField(label, ['modelCapabilities', index, key], capability[key]));
            };
            const addNumber = (label, key, min, max, step) => {
              if (Object.hasOwn(capability, key)) fields.append(this.numberField(label, ['modelCapabilities', index, key], capability[key], min, max, step));
            };
            addText('模型匹配规则', 'match');
            addNumber('上下文窗口', 'contextWindow', 1);
            addNumber('最大输出 tokens', 'maxOutputTokens', 1);
            addNumber('安全比例', 'safetyRatio', 0.01, 1, '0.01');
            addNumber('协议预留 tokens', 'protocolReserveTokens', 0);
            addNumber('单图预算 tokens', 'imageTokens', 1);
            card.append(head, fields);
            list.append(card);
          });
          group.body.append(list);
        }
        if (group.body.childElementCount) root.append(group.node);
      }
    }

    renderGoalCheckpointGroup(root, config) {
      const checkpoint = config.goalCheckpoint;
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return;
      const group = this.configGroup('goalCheckpoint', '长任务与检查点', '历史裁剪时的目标摘要预算与冷重启恢复', () => {
        const parts = [];
        if (Object.hasOwn(checkpoint, 'enabled')) parts.push(checkpoint.enabled ? '检查点启用' : '检查点关闭');
        if (Object.hasOwn(checkpoint, 'maxEntries')) parts.push(`${checkpoint.maxEntries} 条任务`);
        if (Object.hasOwn(checkpoint, 'ttlMs')) parts.push(`有效期 ${formatSecondsShort(checkpoint.ttlMs)}`);
        if (checkpoint.persistence && Object.hasOwn(checkpoint.persistence, 'enabled')) parts.push(checkpoint.persistence.enabled ? '持久化启用' : '持久化关闭');
        return parts;
      });
      const fields = group.body;
      const addBoolean = (label, key) => {
        if (Object.hasOwn(checkpoint, key)) fields.append(this.booleanField(label, ['goalCheckpoint', key], checkpoint[key]));
      };
      const addNumber = (label, key, min, max, step) => {
        if (Object.hasOwn(checkpoint, key)) fields.append(this.numberField(label, ['goalCheckpoint', key], checkpoint[key], min, max, step));
      };
      addBoolean('启用目标检查点', 'enabled');
      addNumber('最大任务条目', 'maxEntries', 1);
      addNumber('每任务响应索引', 'maxResponseIdsPerTask', 1);
      addNumber('响应索引总上限', 'maxResponseIndexes', 1);
      addNumber('有效期（毫秒）', 'ttlMs', 1);
      addNumber('摘要源 token 预算', 'sourceTokenBudget', 128);
      addNumber('源窗口比例', 'sourceWindowRatio', 0.01, 1, '0.01');
      addNumber('摘要最大输出 tokens', 'maxOutputTokens', 256);
      addNumber('摘要请求超时（毫秒）', 'requestMs', 1000);

      const persistence = checkpoint.persistence;
      if (persistence && typeof persistence === 'object' && !Array.isArray(persistence)) {
        // 持久化路径与锁参数可编辑，但快照内容始终由后端管理，浏览器无法读取。
        const divider = el('div', 'subsection-title');
        divider.append(el('strong', '', '冷重启持久化'), el('span', '', '文件路径仅在本机使用，不包含完整对话或凭据'));
        fields.append(divider);
        if (Object.hasOwn(persistence, 'enabled')) fields.append(this.booleanField('启用持久化', ['goalCheckpoint', 'persistence', 'enabled'], persistence.enabled));
        if (Object.hasOwn(persistence, 'path')) fields.append(this.textField('快照文件路径', ['goalCheckpoint', 'persistence', 'path'], persistence.path, '填写绝对路径', { nullable: true, wide: true }));
        if (Object.hasOwn(persistence, 'stateGeneration')) fields.append(this.textField('状态代次', ['goalCheckpoint', 'persistence', 'stateGeneration'], persistence.stateGeneration, 'default'));
        for (const [label, key, min] of [
          ['写入防抖（毫秒）', 'debounceMs', 10],
          ['快照大小上限（字节）', 'maxBytes', 1024],
          ['写锁心跳（毫秒）', 'lockHeartbeatMs', 100],
          ['陈旧锁判定（毫秒）', 'lockStaleMs', 300],
        ]) {
          if (Object.hasOwn(persistence, key)) fields.append(this.numberField(label, ['goalCheckpoint', 'persistence', key], persistence[key], min));
        }
      }
      if (fields.childElementCount) root.append(group.node);
    }

    renderVisionRelayGroup(root, config) {
      const relay = config.visionRelay;
      if (!relay || typeof relay !== 'object' || Array.isArray(relay)) return;
      const group = this.configGroup('visionRelay', '图片处理', '为不支持图片的文本模型提供本机可控的视觉描述通道', () => {
        const parts = [];
        if (relay.model) parts.push(`视觉模型 ${relay.model}`);
        if (Object.hasOwn(relay, 'viaProxy')) parts.push(relay.viaProxy ? '走公共代理' : '直接连接');
        if (Object.hasOwn(relay, 'concurrency')) parts.push(`并发 ${relay.concurrency}`);
        if (Object.hasOwn(relay, 'cacheMaxBytes')) parts.push(`缓存 ${formatBytes(relay.cacheMaxBytes)}`);
        return parts;
      });
      const fields = group.body;
      const addText = (label, key, options = {}) => {
        if (Object.hasOwn(relay, key)) fields.append(this.textField(label, ['visionRelay', key], relay[key], '', options));
      };
      const addNumber = (label, key, min, max) => {
        if (Object.hasOwn(relay, key)) fields.append(this.numberField(label, ['visionRelay', key], relay[key], min, max));
      };
      addText('上游主机', 'host');
      addText('API 路径前缀', 'prefix');
      addText('视觉模型', 'model');
      addText('凭据环境变量名', 'envKey', { help: '这里只填写变量名；密钥内容不会进入页面。' });
      if (Object.hasOwn(relay, 'viaProxy')) fields.append(this.booleanField('使用公共代理', ['visionRelay', 'viaProxy'], relay.viaProxy));
      addNumber('并发上限', 'concurrency', 1, 8);
      addNumber('单请求图片上限', 'maxImagesPerRequest', 1);
      addNumber('缓存条目上限', 'cacheMaxEntries', 1);
      addNumber('缓存大小上限（字节）', 'cacheMaxBytes', 1);
      addNumber('描述最大输出 tokens', 'maxTokens', 1);
      if (Object.hasOwn(relay, 'prompt')) fields.append(this.textAreaField('视觉描述提示词', ['visionRelay', 'prompt'], relay.prompt));
      if (relay.timeouts && typeof relay.timeouts === 'object' && !Array.isArray(relay.timeouts)) {
        for (const [label, key] of [
          ['连接超时（毫秒）', 'connectMs'],
          ['响应头超时（毫秒）', 'responseHeaderMs'],
          ['流空闲超时（毫秒）', 'streamIdleMs'],
          ['请求总超时（毫秒）', 'requestMs'],
        ]) {
          if (Object.hasOwn(relay.timeouts, key)) fields.append(this.numberField(label, ['visionRelay', 'timeouts', key], relay.timeouts[key], 1));
        }
      }
      if (fields.childElementCount) root.append(group.node);
    }

    fieldset(title, description, className = '') {
      const node = el('fieldset', `config-group ${className}`.trim());
      const legend = el('legend');
      legend.append(el('span', '', title), el('small', '', description));
      const body = el('div', 'field-grid');
      node.append(legend, body);
      return { node, body };
    }

    textField(label, path, value, placeholder = '', options = {}) {
      const wrapper = el('label', options.wide ? 'field wide' : 'field');
      wrapper.append(el('span', 'field-label', label));
      const input = el('input');
      input.type = 'text';
      input.value = value ?? '';
      input.placeholder = placeholder;
      input.dataset.path = JSON.stringify(path);
      input.dataset.kind = options.nullable ? 'nullable-string' : 'string';
      input.autocomplete = 'off';
      if (options.help) wrapper.append(input, el('small', 'field-help', options.help));
      else wrapper.append(input);
      return wrapper;
    }

    numberField(label, path, value, min, max, step = '1') {
      const wrapper = el('label', 'field');
      const labelRow = el('span', 'field-label');
      labelRow.append(document.createTextNode(label));
      const key = String(path[path.length - 1] ?? '');
      const human = humanNumber(value, key);
      if (human) labelRow.append(el('span', 'field-label-human', human));
      wrapper.append(labelRow);
      const input = el('input');
      input.type = 'number';
      input.inputMode = 'numeric';
      input.value = value ?? '';
      input.min = String(min);
      if (max !== undefined) input.max = String(max);
      input.step = step;
      input.dataset.path = JSON.stringify(path);
      input.dataset.kind = 'number';
      wrapper.append(input);
      return wrapper;
    }

    booleanField(label, path, value) {
      return this.selectField(label, path, String(value === true), [['false', '关闭'], ['true', '启用']]);
    }

    textAreaField(label, path, value) {
      const wrapper = el('label', 'field wide');
      wrapper.append(el('span', 'field-label', label));
      const input = el('textarea');
      input.value = value ?? '';
      input.rows = 4;
      input.dataset.path = JSON.stringify(path);
      input.dataset.kind = 'string';
      input.autocomplete = 'off';
      wrapper.append(input);
      return wrapper;
    }

    stringArrayField(label, path, values, help) {
      const wrapper = el('label', 'field wide');
      wrapper.append(el('span', 'field-label', label));
      const input = el('textarea');
      input.value = values.join('\n');
      input.rows = Math.min(7, Math.max(3, values.length));
      input.dataset.path = JSON.stringify(path);
      input.dataset.kind = 'string-array';
      input.autocomplete = 'off';
      wrapper.append(input, el('small', 'field-help', help));
      return wrapper;
    }

    creatableField(control) {
      // 仅给后端白名单中的已知可选字段打标；普通控件仍禁止创建任何缺失路径。
      const input = control.querySelector('[data-path]');
      if (input) input.dataset.createIfMissing = 'true';
      return control;
    }

    selectField(label, path, value, choices) {
      const wrapper = el('label', 'field');
      wrapper.append(el('span', 'field-label', label));
      const select = el('select');
      select.dataset.path = JSON.stringify(path);
      select.dataset.kind = 'select';
      choices.forEach(([optionValue, optionLabel]) => {
        const option = el('option', '', optionLabel);
        option.value = optionValue;
        option.selected = String(value) === optionValue;
        select.append(option);
      });
      wrapper.append(select);
      return wrapper;
    }

    targetEditor(target, index) {
      const card = el('section', 'target-editor');
      card.setAttribute('aria-labelledby', `target-${index}-title`);
      const head = el('div', 'target-editor-head');
      const name = el('div');
      name.append(el('span', 'target-number', String(index + 1).padStart(2, '0')));
      const title = el('h3', '', target.name || `通道 ${index + 1}`);
      title.id = `target-${index}-title`;
      name.append(title);
      head.append(name, el('span', 'protocol-badge', target.wireApi || target.apiFormat || 'responses'));
      const fields = el('div', 'field-grid target-fields');
      const appendExisting = (key, control) => {
        // 状态模块只更新真实存在的路径，避免表单无意间发明供应商扩展字段。
        if (Object.hasOwn(target, key)) fields.append(control);
      };
      const appendOptional = (key, existingControl, missingControl = existingControl) => {
        fields.append(Object.hasOwn(target, key) ? existingControl : this.creatableField(missingControl));
      };
      appendExisting('name', this.textField('通道名称', ['targets', index, 'name'], target.name, '例如 deepseek'));
      appendExisting('match', this.textField('模型匹配规则', ['targets', index, 'match'], target.match, '^model-name$', { wide: true }));
      appendExisting('platform', this.textField('平台类型', ['targets', index, 'platform'], target.platform, 'generic', { nullable: true }));
      appendExisting('host', this.textField('上游主机', ['targets', index, 'host'], target.host, 'api.example.com'));
      appendOptional(
        'protocol',
        this.selectField('传输协议', ['targets', index, 'protocol'], target.protocol, [['https', 'HTTPS'], ['http', 'HTTP（仅限可信本机上游）']]),
        this.selectField('传输协议（可选）', ['targets', index, 'protocol'], '__absent__', [['__absent__', '未显式设置（默认 HTTPS）'], ['https', '显式使用 HTTPS'], ['http', 'HTTP（仅限可信本机上游）']]),
      );
      appendOptional(
        'port',
        this.numberField('上游端口', ['targets', index, 'port'], target.port, 1, 65535),
        this.numberField('上游端口（可选）', ['targets', index, 'port'], '', 1, 65535),
      );
      appendExisting('prefix', this.textField('API 路径前缀', ['targets', index, 'prefix'], target.prefix, '/v1', { nullable: true }));
      appendOptional(
        'chatPath',
        this.textField('Chat 请求路径', ['targets', index, 'chatPath'], target.chatPath, '/chat/completions'),
        this.textField('Chat 请求路径（可选）', ['targets', index, 'chatPath'], '', '默认 /chat/completions'),
      );
      appendExisting('upstreamModel', this.textField('固定上游模型（可选）', ['targets', index, 'upstreamModel'], target.upstreamModel, '留空则跟随请求', { nullable: true }));
      appendExisting('model', this.textField('固定上游模型（可选）', ['targets', index, 'model'], target.model, '留空则跟随请求', { nullable: true }));
      appendExisting('envKey', this.textField('凭据环境变量名', ['targets', index, 'envKey'], target.envKey, '例如 PROVIDER_API_KEY', { nullable: true, help: '这里只填写变量名；密钥内容不会进入页面。' }));
      const formatKey = ['wireApi', 'apiFormat', 'wire_api'].find((key) => Object.hasOwn(target, key));
      if (formatKey) fields.append(this.selectField('上游协议', ['targets', index, formatKey], target[formatKey], [['responses', 'Responses'], ['chat', 'Chat Completions']]));
      appendExisting('viaProxy', this.selectField('网络方式', ['targets', index, 'viaProxy'], String(target.viaProxy === true), [['false', '直接连接'], ['true', '走公共代理']]));
      appendExisting('vision', this.selectField('视觉能力', ['targets', index, 'vision'], String(target.vision !== false), [['true', '原生支持图片'], ['false', '使用视觉中继']]));
      appendOptional(
        'useOpenAiAuth',
        this.booleanField('使用 Codex 官方登录态', ['targets', index, 'useOpenAiAuth'], target.useOpenAiAuth),
        this.selectField('官方登录态（可选）', ['targets', index, 'useOpenAiAuth'], '__absent__', [['__absent__', '未显式设置（默认关闭）'], ['true', '启用'], ['false', '显式关闭']]),
      );
      appendOptional(
        'stateDomain',
        this.textField('状态共享域', ['targets', index, 'stateDomain'], target.stateDomain, '同协议通道可显式共享', { nullable: true }),
        this.textField('状态共享域（可选）', ['targets', index, 'stateDomain'], '', '同协议通道可显式共享'),
      );
      appendOptional(
        'maxResponseBytes',
        this.numberField('上游响应大小上限（字节）', ['targets', index, 'maxResponseBytes'], target.maxResponseBytes, 1),
        this.numberField('响应大小上限（可选）', ['targets', index, 'maxResponseBytes'], '', 1),
      );
      if (target.useOpenAiAuth !== true) {
        // 官方登录态不能同时配置替代认证；仅在第三方通道提供这些已知可选项。
        appendOptional(
          'authType',
          this.textField('认证类型', ['targets', index, 'authType'], target.authType, 'bearer'),
          this.textField('认证类型（可选）', ['targets', index, 'authType'], '', '默认 bearer；也可填写 x-api-key 或 header'),
        );
        appendOptional(
          'authHeader',
          this.textField('认证请求头名称', ['targets', index, 'authHeader'], target.authHeader, 'authorization'),
          this.textField('认证请求头名称（可选）', ['targets', index, 'authHeader'], '', '仅填写名称，不填写凭据内容'),
        );
      }
      const forwarded = Array.isArray(target.forwardHeaders) ? target.forwardHeaders : [];
      appendOptional(
        'forwardHeaders',
        this.stringArrayField('额外透传请求头名称', ['targets', index, 'forwardHeaders'], forwarded, '每行填写一个非敏感请求头名称；受保护的头会被路由拒绝。'),
        this.stringArrayField('额外透传请求头名称（可选）', ['targets', index, 'forwardHeaders'], [], '每行填写一个非敏感请求头名称；不填写则不创建该字段。'),
      );
      appendExisting('includeUsage', this.booleanField('请求用量统计', ['targets', index, 'includeUsage'], target.includeUsage));
      appendExisting('reasoningMode', this.textField('推理参数模式', ['targets', index, 'reasoningMode'], target.reasoningMode, '由平台自动推断', { nullable: true }));
      appendExisting('maxTokensField', this.textField('输出上限字段名', ['targets', index, 'maxTokensField'], target.maxTokensField, 'max_tokens', { nullable: true }));
      card.append(head, fields);
      return card;
    }

    updateConfig(event) {
      const control = event.target.closest('[data-path]');
      if (!control || !this.configState?.config) return;
      if (this.resyncRequired) {
        this.showMessage('页面正在重新载入最新基线，暂不能编辑高级配置。');
        this.renderConfigUnavailable('正在重新载入最新高级配置…');
        return;
      }
      if (this.modelRoutingState && isModelRoutingDirty(this.modelRoutingState)) {
        this.showMessage('自定义模型有未保存更改。请先保存或撤销，再编辑高级配置，避免相互覆盖。');
        this.renderConfig();
        return;
      }
      const path = JSON.parse(control.dataset.path);
      const rawValue = control.value;
      const exists = hasOwnPath(this.configState.config, path);
      const existedOriginally = hasOwnPath(this.configState.originalConfig, path);
      const isCreatable = control.dataset.createIfMissing === 'true';
      const resetRequested = rawValue === '__absent__' || rawValue.trim() === '';
      if (isCreatable && !existedOriginally && resetRequested) {
        // 页面本次新增的可选字段恢复默认时应真正删除，避免把哨兵或无效空值写进配置。
        if (exists) {
          this.configState = removeConfigValue(this.configState, path);
          this.validation = null;
          this.renderValidation();
          this.setDirty();
        }
        return;
      }
      let value = rawValue;
      if (control.dataset.kind === 'number') value = value === '' ? null : Number(value);
      if (control.dataset.kind === 'nullable-string') value = value === '' ? null : value;
      if (control.dataset.kind === 'string-array') {
        // 多行输入只改变原本就是数组的字段，顺序按照用户填写顺序保留。
        value = value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
      }
      if (control.dataset.kind === 'select' && ['true', 'false'].includes(value)) value = value === 'true';
      try {
        if (!exists && !isCreatable) throw new RangeError('配置路径不存在');
        this.configState = exists
          ? updateConfigValue(this.configState, path, value)
          : addConfigValue(this.configState, path, value);
        this.validation = null;
        this.renderValidation();
        this.setDirty();
      } catch (error) {
        this.showMessage(error.message);
      }
    }

    payload() {
      return serializeConfigState(this.configState);
    }

    async validateConfig() {
      if (!this.configState || this.busy.has('config')) return;
      if (this.resyncRequired) {
        this.showMessage('页面正在重新载入最新基线，暂不能预检高级配置。');
        return;
      }
      if (this.modelRoutingState && isModelRoutingDirty(this.modelRoutingState)) {
        this.showMessage('请先处理自定义模型的未保存更改，再预检高级配置。');
        return;
      }
      this.setBusy('config', true);
      this.clearMessage();
      try {
        this.validation = await request('config/validate', {
          method: 'POST',
          body: JSON.stringify(this.payload()),
        });
        this.renderValidation();
      } catch (error) {
        this.showMessage(error.message);
        if (error.code === 'revision_conflict') this.showConflictAction('config');
      } finally {
        this.setBusy('config', false);
      }
    }

    async saveConfig() {
      if (!this.configState || this.busy.has('config')) return;
      if (this.resyncRequired) {
        this.showMessage('页面正在重新载入最新基线，暂不能保存高级配置。');
        return;
      }
      if (!isConfigDirty(this.configState)) return;
      if (this.modelRoutingState && isModelRoutingDirty(this.modelRoutingState)) {
        this.showMessage('请先处理自定义模型的未保存更改，再保存高级配置。');
        return;
      }
      this.setBusy('config', true);
      this.clearMessage();
      try {
        this.validation = await request('config/validate', {
          method: 'POST',
          body: JSON.stringify(this.payload()),
        });
        this.renderValidation();
        if (this.validation.errors?.length) return;
        const saved = await request('config', {
          method: 'PUT',
          body: JSON.stringify(this.payload()),
        });
        const resynced = await this.resyncBaselines();
        if (!resynced) return;
        this.validation = { errors: [], warnings: saved.warnings || [] };
        this.renderValidation();
        this.querySelector('#restart-notice').hidden = !saved.restartRequired;
        this.renderOverview();
        this.querySelector('#restart-notice').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (error) {
        if (error.code === 'revision_conflict') {
          this.showMessage('配置已在其他页面或进程中变化。请刷新后重新修改，避免覆盖新内容。');
          this.showConflictAction('config');
        } else {
          this.showMessage(error.message);
        }
      } finally {
        this.setBusy('config', false);
      }
    }

    renderValidation() {
      const root = this.querySelector('#validation-results');
      root.replaceChildren();
      if (!this.validation) return;
      const errors = this.validation.errors || [];
      const warnings = this.validation.warnings || [];
      const summary = el('div', `validation-summary ${errors.length ? 'has-errors' : 'is-valid'}`);
      summary.append(
        el('strong', '', errors.length ? `预检发现 ${errors.length} 个错误` : '配置预检通过'),
        el('span', '', warnings.length ? `另有 ${warnings.length} 条提醒` : '没有发现提醒'),
      );
      root.append(summary);
      if (errors.length || warnings.length) {
        const list = el('ul', 'issue-list');
        [...errors, ...warnings].forEach((issue) => {
          const item = el('li', issue.severity === 'warning' ? 'warning' : 'error');
          const text = el('span');
          text.append(el('strong', '', issue.path || '配置'), document.createTextNode(` — ${issue.message || issue.code}`));
          item.append(el('i', '', issue.severity === 'warning' ? '!' : '×'), text);
          list.append(item);
        });
        root.append(list);
      }
    }

    modelBindings(slug) {
      return this.modelRoutingState?.bindings?.find((binding) => binding.slug === slug)?.targetRefs || [];
    }

    modelTargetStatus(slug, targetRef) {
      const target = this.modelRoutingState?.targets?.find((item) => item.targetRef === targetRef);
      const bindings = this.modelRoutingState?.bindings || [];
      const owners = bindings.filter((item) => item.targetRefs.includes(targetRef));
      const exact = target?.match === `^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
      if (owners.length === 1 && exact) return '专属精确通道';
      if (owners.length > 1) return '共享通道';
      return '宽泛匹配通道';
    }

    modelActionAllowed(notify = true) {
      if (this.resyncRequired) {
        if (notify) this.showMessage('页面正在等待两份最新基线；请先重新载入。');
        return false;
      }
      if (!this.modelRoutingState) {
        if (notify) this.showMessage(this.modelRoutingError || '自定义模型尚未载入完成，请稍后重试。');
        return false;
      }
      if (this.configState && isConfigDirty(this.configState)) {
        if (notify) this.showMessage('高级配置有未保存更改。请先保存或放弃，再操作自定义模型，避免相互覆盖。');
        return false;
      }
      return true;
    }

    invalidateModelValidation() {
      this.modelValidationCache = null;
      this.renderModelValidation();
    }

    modelOperationSignature() {
      const state = this.modelRoutingState;
      return state ? JSON.stringify({
        configRevision: state.configRevision,
        catalogRevision: state.catalogRevision,
        operations: serializeModelRoutingOperations(state),
      }) : '';
    }

    cacheModelValidation(validation) {
      const state = this.modelRoutingState;
      this.modelValidationCache = {
        configRevision: state.configRevision,
        catalogRevision: state.catalogRevision,
        operationDigest: validation.operationDigest,
        confirmation: validation.confirmation,
        impact: validation.impact,
        errors: validation.errors || [],
        warnings: validation.warnings || [],
        signature: this.modelOperationSignature(),
      };
      return this.modelValidationCache;
    }

    currentModelValidation() {
      const cache = this.modelValidationCache;
      if (!cache || cache.signature !== this.modelOperationSignature()) return null;
      return cache;
    }

    updateModelControls() {
      const state = this.modelRoutingState;
      const blocked = this.resyncRequired || !this.modelActionAllowed(false) || this.busy.has('model-routing');
      const dirty = state ? isModelRoutingDirty(state) : false;
      const validation = this.currentModelValidation();
      this.querySelectorAll('[data-action="model-add"], [data-action="model-edit"], [data-action="model-delete"]').forEach((button) => {
        button.disabled = blocked;
      });
      this.querySelector('[data-action="model-undo"]').disabled = blocked || !dirty;
      this.querySelector('[data-action="model-validate"]').disabled = blocked || !dirty;
      this.querySelector('[data-action="model-save"]').disabled = blocked || !dirty || Boolean(validation?.errors?.length);
      const hint = this.querySelector('#model-save-hint');
      if (!state) hint.textContent = this.modelRoutingError || '正在载入自定义模型…';
      else if (this.configState && isConfigDirty(this.configState)) hint.textContent = '高级配置有未保存更改；请先处理高级配置。';
      else hint.textContent = dirty ? '更改尚未写入模型目录与路由配置' : '当前模型列表与本机文件一致';
    }

    renderModelRouting() {
      this.renderOverview();
      const panel = this.querySelector('#model-routing-panel');
      const state = this.modelRoutingState;
      if (!state) {
        panel.replaceChildren(el('p', 'empty-state', this.modelRoutingError || '正在载入自定义模型…'));
        this.updateModelControls();
        return;
      }
      this.populateModelChannelFilter(state);
      if (!state.models.length) {
        const empty = el('div', 'model-empty');
        empty.append(
          el('strong', '', '还没有自定义模型'),
          el('p', '', '添加一个模型，把第三方或官方上游接到 Codex。'),
        );
        const add = el('button', 'button primary', '添加模型');
        add.type = 'button';
        add.dataset.action = 'model-add';
        empty.append(add);
        panel.replaceChildren(empty);
        this.updateModelControls();
        this.updateModelCount(0, 0);
        return;
      }
      const { visible, total } = this.visibleModels(state);
      if (!visible.length) {
        const none = el('div', 'model-empty');
        none.append(
          el('strong', '', '没有匹配的模型'),
          el('p', '', '尝试调整搜索关键词或筛选条件。'),
        );
        const clear = el('button', 'button secondary', '清除筛选');
        clear.type = 'button';
        clear.dataset.action = 'model-clear-filters';
        none.append(clear);
        panel.replaceChildren(none);
        this.updateModelControls();
        this.updateModelCount(0, total);
        return;
      }
      const list = el('div', 'model-list');
      visible.forEach((model) => list.append(this.renderModelRow(state, model)));
      panel.replaceChildren(list);
      this.updateModelControls();
      this.updateModelCount(visible.length, total);
    }

    populateModelChannelFilter(state) {
      const select = this.querySelector('#model-filter-channel');
      if (!select) return;
      const current = this.modelFilters.channel;
      select.replaceChildren(el('option', '', '全部通道'));
      select.firstChild.value = 'all';
      state.targets.forEach((target) => {
        const option = el('option', '', target.name || target.targetRef || '未命名通道');
        option.value = target.targetRef;
        select.append(option);
      });
      select.value = [...select.options].some((option) => option.value === current) ? current : 'all';
      this.modelFilters.channel = select.value;
    }

    updateModelCount(shown, total) {
      const node = this.querySelector('#model-count');
      if (!node) return;
      if (!total) node.textContent = '';
      else if (shown === total) node.textContent = `共 ${total} 个模型`;
      else node.textContent = `显示 ${shown} / ${total} 个`;
    }

    modelAttentionInfo(state, model) {
      const refs = this.modelBindings(model.slug);
      const bound = refs.map((ref) => state.targets.find((item) => item.targetRef === ref)).filter(Boolean);
      const ready = refs.length > 0 && bound.length === refs.length && bound.every((target) => target.envSet);
      return { refs, bound, ready };
    }

    visibleModels(state) {
      const { query, status, channel, capability, sort } = this.modelFilters;
      const needle = query.trim().toLowerCase();
      const decorated = state.models.map((model) => ({ model, info: this.modelAttentionInfo(state, model) }));
      const filtered = decorated.filter(({ model, info }) => {
        if (needle) {
          const haystack = `${model.slug} ${model.display_name || ''}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        if (status === 'ready' && !info.ready) return false;
        if (status === 'attention' && info.ready) return false;
        if (channel !== 'all' && !info.refs.includes(channel)) return false;
        if (capability !== 'all') {
          const modalities = Array.isArray(model.input_modalities) && model.input_modalities.length ? model.input_modalities : ['text'];
          if (!modalities.includes(capability)) return false;
        }
        return true;
      });
      const nameOf = ({ model }) => (model.display_name || model.slug || '').toLowerCase();
      const contextOf = ({ model }) => Number(model.context_window ?? model.max_context_window ?? 0);
      const sorted = [...filtered].sort((a, b) => {
        if (sort === 'name-desc') return nameOf(b).localeCompare(nameOf(a));
        if (sort === 'status-first') return Number(a.info.ready) - Number(b.info.ready) || nameOf(a).localeCompare(nameOf(b));
        if (sort === 'context-desc') return contextOf(b) - contextOf(a) || nameOf(a).localeCompare(nameOf(b));
        return nameOf(a).localeCompare(nameOf(b));
      });
      return { visible: sorted.map(({ model }) => model), total: state.models.length };
    }

    renderModelRow(state, model) {
      const info = this.modelAttentionInfo(state, model);
      const modalities = Array.isArray(model.input_modalities) && model.input_modalities.length
        ? model.input_modalities.map((item) => (item === 'image' ? '图片' : '文本'))
        : ['文本'];
      const row = el('article', `model-row${info.ready ? '' : ' needs-attention'}`);
      row.dataset.slug = model.slug;

      const main = el('button', 'model-row-main');
      main.type = 'button';
      main.dataset.slug = model.slug;
      main.setAttribute('aria-label', `编辑模型 ${model.display_name || model.slug}`);
      const identity = el('span', 'model-row-identity');
      identity.append(el('strong', '', model.display_name || model.slug), el('span', 'model-row-slug', model.slug));
      const channelNames = info.bound.length
        ? info.bound.map((target) => target.name || '未命名通道').join('、')
        : '未绑定通道';
      const channel = el('span', 'model-row-channel', channelNames);
      channel.title = channelNames;
      const caps = el('span', 'model-row-caps');
      modalities.forEach((name) => caps.append(el('span', 'cap-pill', name)));
      main.append(identity, channel, caps);

      const status = el('span', `status-dot ${info.ready ? 'ready' : 'warning'}`, info.ready ? '可用' : '待配置');

      const actions = el('span', 'model-row-actions');
      const edit = el('button', 'button secondary compact', '编辑');
      edit.type = 'button';
      edit.dataset.action = 'model-edit';
      edit.dataset.slug = model.slug;
      const remove = el('button', 'button danger-outline compact', '删除');
      remove.type = 'button';
      remove.dataset.action = 'model-delete';
      remove.dataset.slug = model.slug;
      remove.setAttribute('aria-label', `删除模型 ${model.display_name || model.slug}`);
      actions.append(edit, remove);

      row.append(main, status, actions);
      return row;
    }

    syncModelFilterControls() {
      const search = this.querySelector('#model-search');
      if (search) search.value = this.modelFilters.query;
      const statusSelect = this.querySelector('#model-filter-status');
      if (statusSelect) statusSelect.value = this.modelFilters.status;
      const capabilitySelect = this.querySelector('#model-filter-capability');
      if (capabilitySelect) capabilitySelect.value = this.modelFilters.capability;
      const sortSelect = this.querySelector('#model-sort');
      if (sortSelect) sortSelect.value = this.modelFilters.sort;
      this.populateModelChannelFilter(this.modelRoutingState);
    }

    openModelDialog(slug = null) {
      if (!this.modelActionAllowed() || this.busy.has('model-routing')) return;
      const model = slug ? this.modelRoutingState.models.find((item) => item.slug === slug) : null;
      if (slug && !model) return;
      this.modelDialogReturnFocus = document.activeElement;
      const dialog = this.querySelector('#model-dialog');
      dialog.classList.add('model-dialog');
      dialog.innerHTML = `
        <form id="model-dialog-form" class="model-dialog-form" novalidate aria-describedby="model-dialog-error">
          <header class="model-dialog-header">
            <p class="kicker">${model ? '编辑模型' : '新增模型'}</p>
            <h2 id="model-dialog-title">${model ? '编辑自定义模型' : '新增自定义模型'}</h2>
            <p class="dialog-copy">分三步完成：先选通道，再填模型信息，最后预检并保存。凭据内容始终不会出现在此页面。</p>
          </header>
          <div class="model-dialog-body">
            <div id="model-dialog-error" class="form-error" role="alert" hidden></div>
            <section class="dialog-section route-section" aria-labelledby="model-route-title">
              <div class="dialog-section-heading"><div><p class="section-step">第一步 · 通道</p><h3 id="model-route-title">选择或创建服务通道</h3></div><p>${model ? '当前模型已关联已有通道；如需修改连接设置，请展开下方设置。' : '新模型默认创建专属通道；复用不会改变既有匹配规则。'}</p></div>
              <div class="route-mode-grid">
                <label class="field"><span class="field-label">通道方式</span><select id="model-routing-mode"><option value="dedicated">新建专属通道</option><option value="reuse">复用已匹配通道</option></select></label>
                <label class="field"><span class="field-label">选择通道</span><select id="model-target-ref" data-model-target></select><small id="model-target-help" class="field-help">编辑已有模型时，可在它已绑定的多个通道间选择。</small></label>
              </div>
              <div id="model-target-summary" class="route-summary" aria-live="polite" hidden>
                <div><span class="field-label">当前关联通道</span><strong id="model-target-summary-name">—</strong></div>
                <dl><div><dt>连接</dt><dd id="model-target-summary-host">—</dd></div><div><dt>接口</dt><dd id="model-target-summary-wire">—</dd></div></dl>
              </div>
              <details id="model-target-editor" class="route-editor-details">
                <summary><span>连接设置</span><small>编辑关联通道会影响所有使用它的模型</small></summary>
                <div id="model-target-fields" class="field-grid dialog-fields target-dialog-fields">
                  <label class="field"><span class="field-label">安全名称</span><input id="route-name" autocomplete="off"></label>
                  <label class="field"><span class="field-label">上游主机</span><input id="route-host" autocomplete="off"></label>
                  <label class="field"><span class="field-label">路径前缀</span><input id="route-prefix" placeholder="/v1" autocomplete="off"></label>
                  <label class="field"><span class="field-label">凭据环境变量名称</span><input id="route-env" autocomplete="off"><small class="field-help">只填写本机变量名称，不填写其内容。</small></label>
                  <label class="field"><span class="field-label">网络方式</span><select id="route-proxy"><option value="false">直接连接</option><option value="true">走公共代理</option></select></label>
                </div>
                <details class="route-advanced-details"><summary>高级选项<small>上游协议、认证方式等专家字段</small></summary><div class="field-grid route-advanced-fields">
                  <label class="field"><span class="field-label">协议</span><select id="route-protocol"><option value="https">HTTPS</option><option value="http">HTTP（仅可信本机）</option></select></label>
                  <label class="field"><span class="field-label">上游接口</span><select id="route-wire"><option value="responses">Responses</option><option value="chat">Chat Completions</option></select></label>
                  <label class="field"><span class="field-label">认证方式</span><input id="route-auth-type" placeholder="bearer" autocomplete="off"></label>
                  <label class="field"><span class="field-label">认证头名称</span><input id="route-auth-header" placeholder="标准认证头名称" autocomplete="off"><small class="field-help">只允许名称，不填写认证内容。</small></label>
                </div></details>
              </details>
            </section>
            <section class="dialog-section" aria-labelledby="model-details-title">
              <div class="dialog-section-heading"><div><p class="section-step">第二步 · 模型</p><h3 id="model-details-title">填写模型信息与能力</h3></div><p>这些信息决定 Codex 如何识别并使用模型。</p></div>
              <div class="field-grid dialog-fields model-details-fields">
                <label class="field"><span class="field-label">模型标识（slug）</span><input id="model-slug" required autocomplete="off" aria-describedby="model-dialog-error"><small class="field-help">用于 Codex 调用，建议使用稳定、易识别的名称。</small></label>
                <label class="field"><span class="field-label">显示名称</span><input id="model-display-name" required autocomplete="off" aria-describedby="model-dialog-error"><small class="field-help">必填，显示给使用者的友好名称。</small></label>
                <label class="field"><span class="field-label">上下文窗口（tokens）</span><input id="model-context" inputmode="numeric" type="number" min="1" aria-describedby="model-dialog-error"><small class="field-help">留空表示沿用目录默认值。</small></label>
                <fieldset class="field modality-field"><legend class="field-label">输入能力</legend><label><input id="model-text" type="checkbox" checked> 文本</label><label><input id="model-image" type="checkbox"> 图片</label><small class="field-help">只勾选模型实际支持的输入。</small></fieldset>
              </div>
            </section>
            <section class="dialog-section dialog-section-review" aria-labelledby="model-review-title">
              <div class="dialog-section-heading"><div><p class="section-step">第三步 · 保存</p><h3 id="model-review-title">预检影响并保存</h3></div><p>加入草稿后，系统会自动预检并展示本次更改影响，确认无误后再保存。保存后需手动重启路由与 Codex。</p></div>
              <p class="review-note">点击下方“${model ? '更新草稿' : '加入草稿'}”完成本步，随后在模型管理区查看预检结果与影响摘要，再统一保存。</p>
            </section>
          </div>
          <div class="dialog-actions model-dialog-actions"><button class="button secondary" type="button" data-action="model-dialog-cancel">取消</button><button class="button primary" type="submit">${model ? '更新草稿' : '加入草稿'}</button></div>
        </form>`;
      dialog.dataset.editSlug = model?.slug || '';
      const refs = model
        ? this.modelBindings(model.slug)
        : this.modelRoutingState.targets
          .map((target) => target.targetRef)
          .filter((targetRef) => isPersistedModelRoutingTarget(this.modelRoutingState, targetRef));
      const select = dialog.querySelector('#model-target-ref');
      refs.forEach((ref) => {
        const target = this.modelRoutingState.targets.find((item) => item.targetRef === ref);
        const option = el('option', '', `${target?.name || '未命名通道'} · ${target?.wireApi === 'chat' ? 'Chat' : 'Responses'} · ${target?.envSet ? '就绪' : '待配置'}`);
        option.value = ref;
        select.append(option);
      });
      dialog.querySelector('#model-slug').value = model?.slug || '';
      dialog.querySelector('#model-display-name').value = model?.display_name || '';
      dialog.querySelector('#model-context').value = model?.context_window ?? '';
      dialog.querySelector('#model-text').checked = !model?.input_modalities || model.input_modalities.includes('text');
      dialog.querySelector('#model-image').checked = Boolean(model?.input_modalities?.includes('image'));
      const mode = dialog.querySelector('#model-routing-mode');
      if (model) {
        mode.value = 'reuse';
        mode.disabled = true;
        select.disabled = !refs.length;
      } else {
        select.disabled = false;
      }
      // 已有模型绑定的是既有通道，初始状态必须先显示摘要，避免打开弹窗就展开共享通道配置。
      this.fillModelTargetFields(select.value, model ? 'reuse' : 'dedicated');
      dialog.showModal();
      dialog.querySelector('#model-slug').focus();
    }

    fillModelTargetFields(targetRef, mode = null) {
      const dialog = this.querySelector('#model-dialog');
      const editing = dialog.dataset.editSlug !== '';
      const routingMode = mode || dialog.querySelector('#model-routing-mode')?.value;
      const fields = dialog.querySelector('#model-target-fields');
      const select = dialog.querySelector('#model-target-ref');
      if (!fields || !select) return;
      const reusing = routingMode === 'reuse';
      const targetEditor = dialog.querySelector('#model-target-editor');
      const targetSummary = dialog.querySelector('#model-target-summary');
      select.closest('.field').hidden = !editing && routingMode === 'dedicated';
      // 复用通道时先显示完整摘要，避免将共享通道配置误认为模型字段；编辑模型仍可按需展开设置。
      if (targetEditor) {
        targetEditor.hidden = !editing && reusing;
        targetEditor.open = !reusing;
      }
      if (targetSummary) targetSummary.hidden = !reusing;
      // 新建专属通道不能悄然继承下拉框中默认 target 的认证语义或路由字段。
      const target = !editing && routingMode === 'dedicated'
        ? {}
        : this.modelRoutingState?.targets?.find((item) => item.targetRef === targetRef) || {};
      const help = dialog.querySelector('#model-target-help');
      if (help && !editing) {
        help.textContent = routingMode === 'reuse'
          ? '复用不会改动匹配规则；预检会确认所选通道已匹配当前 slug。'
          : '专属通道会自动生成只匹配当前 slug 的规则。';
      }
      const requireDedicated = !editing && routingMode === 'dedicated';
      ['#route-name', '#route-host', '#route-env'].forEach((selector) => {
        const input = dialog.querySelector(selector);
        if (input) input.required = requireDedicated;
      });
      const set = (id, value) => { const input = dialog.querySelector(id); if (input) input.value = value ?? ''; };
      set('#route-name', target.name);
      set('#route-host', target.host);
      set('#route-protocol', target.protocol || 'https');
      set('#route-prefix', target.prefix);
      set('#route-env', target.envKey);
      set('#route-wire', target.wireApi || target.apiFormat || 'responses');
      set('#route-auth-type', target.authType);
      set('#route-auth-header', target.authHeader);
      set('#route-proxy', String(target.viaProxy === true));
      if (targetSummary) {
        const setSummary = (selector, value, title = value) => {
          const node = dialog.querySelector(selector);
          if (!node) return;
          node.textContent = value;
          node.title = title || '';
        };
        const protocol = target.protocol || 'https';
        const host = target.host || '未配置上游主机';
        const prefix = target.prefix || '/';
        setSummary('#model-target-summary-name', target.name || '未命名通道');
        setSummary('#model-target-summary-host', `${protocol}://${host}${prefix}`, `${protocol}://${host}${prefix}`);
        setSummary('#model-target-summary-wire', target.wireApi === 'chat' ? 'Chat Completions' : 'Responses');
      }
    }

    readModelDialog() {
      const dialog = this.querySelector('#model-dialog');
      const read = (selector) => dialog.querySelector(selector).value.trim();
      const slug = read('#model-slug');
      const context = read('#model-context');
      const model = {
        slug,
        ...(read('#model-display-name') ? { display_name: read('#model-display-name') } : {}),
        ...(context ? { context_window: Number(context) } : {}),
        input_modalities: ['text', ...(dialog.querySelector('#model-image').checked ? ['image'] : [])],
      };
      if (!dialog.querySelector('#model-text').checked) model.input_modalities = model.input_modalities.filter((item) => item !== 'text');
      const targetRef = dialog.querySelector('#model-target-ref').value;
      const target = {
        ...(read('#route-name') ? { name: read('#route-name') } : {}),
        ...(read('#route-host') ? { host: read('#route-host') } : {}),
        protocol: read('#route-protocol') || 'https',
        ...(read('#route-prefix') ? { prefix: read('#route-prefix') } : {}),
        ...(read('#route-env') ? { envKey: read('#route-env') } : {}),
        wireApi: read('#route-wire') || 'responses',
        ...(read('#route-auth-type') ? { authType: read('#route-auth-type') } : {}),
        ...(read('#route-auth-header') ? { authHeader: read('#route-auth-header') } : {}),
        viaProxy: dialog.querySelector('#route-proxy').value === 'true',
      };
      return { model, target, targetRef, dedicated: dialog.querySelector('#model-routing-mode').value === 'dedicated', editSlug: dialog.dataset.editSlug };
    }

    saveModelDialog() {
      try {
        if (!this.modelActionAllowed()) return;
        const draft = this.readModelDialog();
        if (!draft.model.slug) throw new Error('请填写模型标识。');
        if (!draft.model.display_name) throw new Error('请填写显示名称。');
        if (draft.dedicated && (!draft.target.name || !draft.target.host || !draft.target.envKey)) {
          throw new Error('新建专属通道请填写安全名称、上游主机和凭据环境变量名称。');
        }
        if (draft.editSlug) {
          // 新建专属通道尚未落盘，其临时引用不能作为 target.update 的 targetRef 回传。
          const routing = { patch: draft.target };
          if (isPersistedModelRoutingTarget(this.modelRoutingState, draft.targetRef)) {
            routing.targetRef = draft.targetRef;
          }
          this.modelRoutingState = updateModelDraft(this.modelRoutingState, draft.editSlug, {
            model: draft.model,
            routing,
          });
        } else if (draft.dedicated) {
          this.modelRoutingState = addModelDraft(this.modelRoutingState, {
            model: draft.model,
            routing: { mode: 'dedicated', target: draft.target },
          });
        } else {
          this.modelRoutingState = addModelDraft(this.modelRoutingState, {
            model: draft.model,
            routing: { mode: 'reuse', targetRef: draft.targetRef },
          });
        }
        this.invalidateModelValidation();
        this.querySelector('#model-dialog').close();
        this.renderModelRouting();
        this.setDirty();
        this.validateModelRouting();
      } catch (error) {
        const root = this.querySelector('#model-dialog-error');
        root.textContent = error?.message?.startsWith('新建专属通道请填写')
          ? error.message
          : '模型草稿无法保存。请检查必填项与通道设置。';
        root.hidden = false;
      }
    }

    closeModelDialog() { this.querySelector('#model-dialog').close(); }

    restoreModelDialogFocus() {
      const previous = this.modelDialogReturnFocus;
      this.modelDialogReturnFocus = null;
      if (previous?.isConnected) previous.focus();
    }

    openDeleteModelDialog(slug) {
      if (!this.modelActionAllowed() || this.busy.has('model-routing')) return;
      const model = this.modelRoutingState?.models.find((item) => item.slug === slug);
      if (!model) return;
      this.pendingDeleteSlug = slug;
      this.modelDialogReturnFocus = document.activeElement;
      const refs = this.modelBindings(slug);
      const targets = refs.map((ref) => this.modelRoutingState.targets.find((item) => item.targetRef === ref)).filter(Boolean);
      const dedicated = refs.length === 1 && this.modelTargetStatus(slug, refs[0]) === '专属精确通道';
      const dialog = this.querySelector('#delete-model-dialog');
      dialog.innerHTML = `
        <form method="dialog"><div class="dialog-icon" aria-hidden="true">!</div><h2 id="delete-model-title">删除模型吗？</h2>
        <p id="delete-model-message"></p>
        <p class="dialog-copy">共享通道和宽泛匹配通道会强制保留，避免影响其他模型。</p>
        <div id="delete-model-option"></div>
        <div class="dialog-actions"><button class="button secondary" type="button" data-action="delete-model-cancel">取消</button><button class="button danger" type="button" data-action="delete-model-confirm">删除模型</button></div></form>`;
      dialog.querySelector('#delete-model-title').textContent = `删除“${model.display_name || model.slug}”吗？`;
      dialog.querySelector('#delete-model-message').textContent = `将移除模型目录和所有精确引用。${targets.length ? `关联通道：${targets.map((target) => target.name || '未命名通道').join('、')}。` : '当前没有关联通道。'}`;
      if (dedicated) {
        const label = el('label', 'delete-target-option');
        const checkbox = el('input');
        checkbox.id = 'delete-dedicated-target';
        checkbox.type = 'checkbox';
        label.append(checkbox, document.createTextNode(' 同时删除唯一的精确专属通道'));
        dialog.querySelector('#delete-model-option').append(label);
      }
      dialog.showModal();
      dialog.querySelector('[data-action="delete-model-cancel"]').focus();
    }

    closeDeleteModelDialog() { this.querySelector('#delete-model-dialog').close(); }

    deleteModelDraft() {
      try {
        if (!this.modelActionAllowed()) return;
        const dialog = this.querySelector('#delete-model-dialog');
        const removeTarget = dialog.querySelector('#delete-dedicated-target')?.checked === true;
        const ref = this.modelBindings(this.pendingDeleteSlug)[0];
        this.modelRoutingState = removeModelDraft(this.modelRoutingState, this.pendingDeleteSlug, removeTarget
          ? { deleteDedicatedTarget: true, targetRef: ref }
          : undefined);
        this.invalidateModelValidation();
        dialog.close();
        this.renderModelRouting();
        this.setDirty();
        this.validateModelRouting();
      } catch (error) {
        this.showMessage('无法删除该模型；共享或宽泛匹配通道会被保留。');
      }
    }

    undoModelChange() {
      if (!this.modelActionAllowed() || !isModelRoutingDirty(this.modelRoutingState)) return;
      this.modelRoutingState = undoModelRoutingChange(this.modelRoutingState);
      this.invalidateModelValidation();
      this.renderModelRouting();
      this.setDirty();
      this.validateModelRouting();
    }

    modelRoutingPayload(confirmation) {
      const state = this.modelRoutingState;
      return {
        configRevision: state.configRevision,
        catalogRevision: state.catalogRevision,
        operations: serializeModelRoutingOperations(state),
        ...(confirmation ? { confirmation } : {}),
      };
    }

    async validateModelRouting() {
      if (!this.modelActionAllowed() || this.busy.has('model-routing')) return;
      this.setBusy('model-routing', true);
      try {
        const validation = await request('model-routing/validate', {
          method: 'POST', body: JSON.stringify(this.modelRoutingPayload()),
        });
        this.cacheModelValidation(validation);
        this.renderModelValidation();
        this.renderModelRouting();
      } catch (error) {
        this.invalidateModelValidation();
        this.showModelRoutingError(error);
      } finally {
        this.setBusy('model-routing', false);
      }
    }

    async saveModelRouting() {
      if (!this.modelActionAllowed() || this.busy.has('model-routing')) return;
      this.setBusy('model-routing', true);
      try {
        let validation = this.currentModelValidation();
        if (!validation) {
          const response = await request('model-routing/validate', {
            method: 'POST', body: JSON.stringify(this.modelRoutingPayload()),
          });
          validation = this.cacheModelValidation(response);
          this.renderModelValidation();
          // 新确认必须让用户亲自勾选；不可在同一次点击中消耗确认值。
          if (validation.errors.length || validation.confirmation?.token) return;
        }
        if (validation.errors.length) return;
        const confirmation = validation.confirmation?.token;
        if (confirmation && !this.querySelector('#model-save-confirmation')?.checked) {
          this.showMessage('这次更改会移除或替换现有引用，请勾选确认后再保存。');
          return;
        }
        await request('model-routing', {
          method: 'PUT', body: JSON.stringify(this.modelRoutingPayload(confirmation)),
        });
        const resynced = await this.resyncBaselines();
        if (!resynced) return;
        this.invalidateModelValidation();
        this.querySelector('#restart-notice').hidden = false;
        this.renderOverview();
        this.showMessage('自定义模型已保存。请手动重启路由与 Codex 后再使用新配置。');
      } catch (error) {
        if (error.status === 409 || error.status === 422) this.invalidateModelValidation();
        this.showModelRoutingError(error);
      } finally {
        this.setBusy('model-routing', false);
        this.renderModelRouting();
      }
    }

    showModelRoutingError(error) {
      if (error.status === 409 || error.code === 'revision_conflict') {
        this.showMessage('模型目录或路由配置已变化。请重新载入后再修改。');
        this.showConflictAction('model');
      } else if (error.status === 422) {
        this.showMessage('预检未通过；请查看模型更改中的错误提示。');
      } else if (error.status >= 500) {
        this.showMessage('保存没有完成。请稍后重新载入确认当前状态。');
      } else {
        this.showMessage('自定义模型操作没有完成。请检查表单并重新预检。');
      }
    }

    renderModelValidation() {
      const root = this.querySelector('#model-validation-results');
      root.replaceChildren();
      const validation = this.currentModelValidation();
      if (!validation) return;
      const errors = validation.errors || [];
      const warnings = validation.warnings || [];
      const summary = el('div', `validation-summary ${errors.length ? 'has-errors' : 'is-valid'}`);
      summary.append(el('strong', '', errors.length ? `预检发现 ${errors.length} 个错误` : '模型更改预检通过'), el('span', '', warnings.length ? `另有 ${warnings.length} 条提醒` : '没有发现提醒'));
      root.append(summary);
      this.renderModelImpact(root, validation.impact);
      if (errors.length || warnings.length) {
        const list = el('ul', 'issue-list');
        [...errors, ...warnings].forEach((issue) => {
          const item = el('li', issue.severity === 'warning' ? 'warning' : 'error');
          item.append(el('i', '', issue.severity === 'warning' ? '!' : '×'), el('span', '', `${issue.path || '模型'} — ${issue.message || issue.code}`));
          list.append(item);
        });
        root.append(list);
      }
      if (validation.confirmation?.token) {
        const label = el('label', 'delete-target-option');
        const checkbox = el('input');
        checkbox.type = 'checkbox';
        checkbox.id = 'model-save-confirmation';
        label.append(checkbox, document.createTextNode(' 我已确认本次删除或替换的模型、引用和通道影响'));
        root.append(label);
      }
    }

    renderModelImpact(root, impact) {
      if (!impact || typeof impact !== 'object') return;
      const items = [];
      const models = impact.models || {};
      const targets = impact.targets || {};
      const references = impact.references || {};
      (models.created || []).forEach((slug) => items.push(`新增模型：${slug}`));
      (models.updated || []).forEach((item) => items.push(`修改模型：${item.from}${item.to && item.to !== item.from ? ` → ${item.to}` : ''}`));
      (models.deleted || []).forEach((slug) => items.push(`删除模型：${slug}`));
      (targets.created || []).forEach((name) => items.push(`新增通道：${name || '未命名通道'}`));
      (targets.updated || []).forEach(() => items.push('修改已绑定通道'));
      (targets.deleted || []).forEach(() => items.push('删除专属通道'));
      (references.replaced || []).forEach((item) => items.push(`替换精确引用：${item.from} → ${item.to}`));
      (references.removed || []).forEach((slug) => items.push(`移除精确引用：${slug}`));
      if (!items.length) return;
      const section = el('section', 'model-impact');
      section.append(el('h3', '', '本次更改影响'));
      const list = el('ul');
      items.forEach((item) => list.append(el('li', '', item)));
      section.append(list);
      root.append(section);
    }

    renderCheckpoints() {
      const root = this.querySelector('#checkpoint-panel');
      const data = this.checkpoints;
      if (!data) return;
      // 检查点为空时只保留一行内联摘要，不占据大型独立区域。
      if (!data.count) {
        const inline = el('div', 'checkpoint-inline');
        inline.append(
          el('span', 'status-dot ready', '无检查点'),
          el('p', '', `当前没有保存的任务检查点 · 持久化：${persistenceLabel(data.mode)}。进行中的长任务会在裁剪时自动生成目标摘要。`),
        );
        root.replaceChildren(inline);
        return;
      }
      const summary = el('div', 'checkpoint-summary');
      const count = el('div', 'checkpoint-count');
      count.append(el('strong', '', String(data.count || 0)), el('span', '', '条任务摘要'));
      const details = el('dl', 'checkpoint-details');
      [
        ['占用空间', formatBytes(data.bytes)],
        ['持久化', persistenceLabel(data.mode)],
        ['最早过期', formatDateTime(data.earliestExpiresAt)],
        ['最晚过期', formatDateTime(data.latestExpiresAt)],
      ].forEach(([term, value]) => details.append(el('dt', '', term), el('dd', '', value)));
      const actions = el('div', 'checkpoint-actions');
      const note = el('p', '', data.count ? '清空会移除全部任务目标摘要，操作前需要再次确认。' : '当前没有保存的任务检查点。');
      const button = el('button', 'button danger-outline', '清空全部检查点');
      button.type = 'button';
      button.dataset.action = 'clear-checkpoints';
      button.disabled = !data.count || data.mode === 'readonly' || this.busy.has('checkpoints');
      actions.append(note, button);
      summary.append(count, details, actions);
      root.replaceChildren(summary);
    }

    openClearDialog() {
      if (!this.checkpoints?.count) return;
      this.querySelector('#clear-dialog').showModal();
    }

    async clearCheckpoints() {
      if (!this.checkpoints?.confirmation || this.busy.has('checkpoints')) return;
      this.setBusy('checkpoints', true);
      this.clearMessage();
      try {
        await request('checkpoints', {
          method: 'DELETE',
          body: JSON.stringify({ confirmation: this.checkpoints.confirmation }),
        });
        await this.loadCheckpoints();
      } catch (error) {
        this.showMessage(error.message);
        await this.loadCheckpoints().catch(() => {});
      } finally {
        this.setBusy('checkpoints', false);
        this.renderCheckpoints();
      }
    }

    setDirty() {
      const configDirty = this.configState ? isConfigDirty(this.configState) : false;
      const modelDirty = this.modelRoutingState ? isModelRoutingDirty(this.modelRoutingState) : false;
      this.dirty = configDirty || modelDirty;
      this.querySelector('#dirty-badge').hidden = !configDirty;
      this.querySelector('#model-dirty-badge').hidden = !modelDirty;
      if (this.configState) {
        this.querySelector('#save-hint').textContent = configDirty ? '更改尚未写入配置文件' : '当前表单与配置文件一致';
      }
      this.updateModelControls();
      this.updateConfigControls();
    }

    updateConfigControls() {
      const modelDirty = this.modelRoutingState ? isModelRoutingDirty(this.modelRoutingState) : false;
      const blocked = this.resyncRequired || !this.configState || this.busy.has('config') || modelDirty;
      const validate = this.querySelector('[data-action="validate"]');
      const save = this.querySelector('#config-form button[type="submit"]');
      if (validate) validate.disabled = blocked;
      if (save) save.disabled = blocked || !isConfigDirty(this.configState);
    }

    setBusy(area, busy) {
      if (busy) this.busy.add(area);
      else this.busy.delete(area);
      if (area === 'config') {
        this.updateConfigControls();
        this.querySelectorAll('[data-action="validate"], #config-form button[type="submit"]').forEach((button) => button.setAttribute('aria-busy', String(busy)));
      }
      if (area === 'model-routing') {
        this.updateModelControls();
        this.querySelectorAll('[data-action^="model-"]').forEach((button) => button.setAttribute('aria-busy', String(busy)));
      }
    }

    showMessage(message) {
      const notice = this.querySelector('#global-message');
      notice.textContent = message;
      notice.hidden = false;
    }

    showConflictAction(scope) {
      const root = this.querySelector('#conflict-actions');
      root.replaceChildren();
      const text = el('span', '', scope === 'model'
        ? '模型草稿基线已过期。可放弃当前模型草稿并重新载入最新内容。'
        : '高级配置草稿基线已过期。可放弃当前高级配置草稿并重新载入最新内容。');
      const button = el('button', 'button danger-outline compact', '放弃草稿并重新载入');
      button.type = 'button';
      button.dataset.action = scope === 'model' ? 'discard-model-drafts-reload' : 'discard-config-drafts-reload';
      root.append(text, button);
      root.hidden = false;
    }

    clearConflictActions() {
      const root = this.querySelector('#conflict-actions');
      root.replaceChildren();
      root.hidden = true;
    }

    clearMessage() {
      const notice = this.querySelector('#global-message');
      notice.hidden = true;
      notice.textContent = '';
    }
  }

  if (!customElements.get('router-admin')) customElements.define('router-admin', RouterAdmin);
})();
