import {
  addConfigValue,
  createConfigState,
  isConfigDirty,
  removeConfigValue,
  serializeConfigState,
  updateConfigValue,
} from './config-state.mjs';

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
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
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
      throw new Error(`服务返回了无法识别的内容（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      const error = new Error(body?.error?.message || `请求失败（HTTP ${response.status}）`);
      error.code = body?.error?.code;
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
      this.dirty = false;
      this.busy = new Set();
    }

    connectedCallback() {
      this.renderShell();
      this.bindEvents();
      this.reload();
    }

    renderShell() {
      this.innerHTML = `
        <header class="topbar">
          <a class="brand" href="#overview" aria-label="Codex 路由管理首页">
            <span class="brand-mark" aria-hidden="true">CR</span>
            <span><strong>Codex Router</strong><small>本地管理台</small></span>
          </a>
          <nav aria-label="页面导航">
            <a href="#overview">总览</a>
            <a href="#channels">模型通道</a>
            <a href="#configuration">配置</a>
            <a href="#checkpoints">检查点</a>
          </nav>
          <button class="button ghost compact" type="button" data-action="reload">刷新状态</button>
        </header>
        <main>
          <section class="hero" aria-labelledby="page-title">
            <div>
              <p class="eyebrow">LOCAL · ZERO DEPENDENCY</p>
              <h1 id="page-title">让每条模型通道<br><span>清晰可控</span></h1>
              <p class="lede">查看本机路由状态、预检配置，并安全管理长任务检查点。凭据只留在路由进程中，不会出现在页面。</p>
            </div>
            <div class="hero-orbit" aria-hidden="true"><span></span><span></span><span></span></div>
          </section>

          <div id="restart-notice" class="notice restart" role="status" hidden>
            <strong>配置已保存</strong>
            <span>新配置需要人工重启路由后生效。本页面不会自动重启进程。</span>
          </div>
          <div id="global-message" class="notice" role="alert" hidden></div>

          <section id="overview" class="section" aria-labelledby="overview-title">
            <div class="section-heading"><div><p class="kicker">01 / OVERVIEW</p><h2 id="overview-title">运行总览</h2></div><span class="live-pill"><i></i>本机服务</span></div>
            <div id="overview-grid" class="metric-grid" aria-live="polite"><div class="skeleton tall"></div><div class="skeleton tall"></div><div class="skeleton tall"></div><div class="skeleton tall"></div></div>
          </section>

          <section id="channels" class="section" aria-labelledby="channels-title">
            <div class="section-heading"><div><p class="kicker">02 / CHANNELS</p><h2 id="channels-title">模型通道</h2></div><p class="section-note">凭据仅显示是否就绪，不显示变量名或内容。</p></div>
            <div id="channel-grid" class="channel-grid" aria-live="polite"><div class="skeleton channel"></div><div class="skeleton channel"></div></div>
          </section>

          <section id="configuration" class="section" aria-labelledby="configuration-title">
            <div class="section-heading"><div><p class="kicker">03 / CONFIGURATION</p><h2 id="configuration-title">路由配置</h2></div><span id="dirty-badge" class="dirty-badge" hidden>有未保存更改</span></div>
            <div class="privacy-note"><span aria-hidden="true">◈</span><p><strong>敏感信息已隔离</strong><br>API Key、Token、Authorization 等字段不会显示或提供编辑入口；保存时由路由安全保留原值。未知扩展字段和注释也会原样保留。</p></div>
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
            <div class="section-heading"><div><p class="kicker">04 / CHECKPOINTS</p><h2 id="checkpoints-title">长任务检查点</h2></div><button class="button ghost compact" type="button" data-action="refresh-checkpoints">刷新</button></div>
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
        </dialog>`;
    }

    bindEvents() {
      this.addEventListener('click', (event) => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'reload') this.reload();
        if (action === 'validate') this.validateConfig();
        if (action === 'refresh-checkpoints') this.loadCheckpoints();
        if (action === 'clear-checkpoints') this.openClearDialog();
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
      window.addEventListener('beforeunload', (event) => {
        if (!this.dirty) return;
        event.preventDefault();
        event.returnValue = '';
      });
    }

    async reload() {
      if (this.dirty) {
        this.showMessage('当前有未保存更改。请先保存，或重新打开页面以放弃这些更改。');
        return;
      }
      this.clearMessage();
      const results = await Promise.allSettled([
        this.loadStatus(),
        this.loadConfig(),
        this.loadCheckpoints(),
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) this.showMessage(failed.reason.message);
    }

    async loadStatus() {
      this.status = await request('status');
      this.renderOverview();
      this.renderChannels();
    }

    async loadConfig() {
      this.configState = createConfigState(await request('config'));
      this.validation = null;
      this.setDirty();
      this.renderConfig();
    }

    async loadCheckpoints() {
      this.checkpoints = await request('checkpoints');
      this.renderCheckpoints();
    }

    renderOverview() {
      const data = this.status;
      const metrics = [
        ['监听端口', data.port ?? '—', '仅绑定本机地址'],
        ['运行时长', formatDuration(data.uptimeMs), `启动于 ${formatDateTime(data.startedAt)}`],
        ['模型通道', data.targets?.length ?? 0, '按模型名称匹配上游'],
        ['配置告警', data.warningCount ?? 0, data.warningCount ? '建议预检并查看详情' : '当前没有启动告警'],
      ];
      const grid = this.querySelector('#overview-grid');
      grid.replaceChildren(...metrics.map(([label, value, note], index) => {
        const card = el('article', 'metric-card');
        card.style.setProperty('--delay', `${index * 50}ms`);
        const top = el('div', 'metric-top');
        top.append(el('span', '', label), el('span', 'metric-index', String(index + 1).padStart(2, '0')));
        card.append(top, el('strong', 'metric-value', String(value)), el('p', '', note));
        return card;
      }));
    }

    renderChannels() {
      const grid = this.querySelector('#channel-grid');
      const targets = this.status?.targets || [];
      if (!targets.length) {
        grid.replaceChildren(el('p', 'empty-state', '当前没有可用的模型通道。'));
        return;
      }
      grid.replaceChildren(...targets.map((target, index) => {
        const card = el('article', 'channel-card');
        card.style.setProperty('--delay', `${index * 55}ms`);
        const head = el('div', 'channel-head');
        const symbol = el('span', 'channel-symbol', String(target.name || '?').slice(0, 2).toUpperCase());
        const title = el('div');
        title.append(el('h3', '', target.name || '未命名通道'), el('p', '', target.match || '未设置匹配规则'));
        head.append(symbol, title, el('span', `status-dot ${target.envSet ? 'ready' : 'warning'}`, target.envSet ? '凭据就绪' : '凭据待配置'));
        const details = el('dl', 'channel-details');
        [
          ['协议', target.wireApi || '—'],
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

      const basics = this.fieldset('基础设置', '路由监听与请求资源上限');
      const appendRootNumber = (label, key, min, max) => {
        if (Object.hasOwn(config, key)) basics.body.append(this.numberField(label, [key], config[key], min, max));
      };
      appendRootNumber('监听端口', 'port', 1, 65535);
      appendRootNumber('SSE 心跳（毫秒）', 'heartbeatMs', 1);
      appendRootNumber('单请求上限（字节）', 'maxRequestBytes', 1);
      appendRootNumber('最大并发请求', 'maxConcurrentRequests', 1);
      appendRootNumber('缓冲总上限（字节）', 'maxBufferedRequestBytes', 1);
      if (basics.body.childElementCount) root.append(basics.node);

      if (config.proxy && typeof config.proxy === 'object' && !Array.isArray(config.proxy)) {
        const proxy = this.fieldset('公共代理', '仅供开启“走代理”的通道使用');
        if (Object.hasOwn(config.proxy, 'host')) proxy.body.append(this.textField('代理地址', ['proxy', 'host'], config.proxy.host, '127.0.0.1'));
        if (Object.hasOwn(config.proxy, 'port')) proxy.body.append(this.numberField('代理端口', ['proxy', 'port'], config.proxy.port, 1, 65535));
        if (proxy.body.childElementCount) root.append(proxy.node);
      }

      if (config.timeouts && typeof config.timeouts === 'object' && !Array.isArray(config.timeouts)) {
        const timeouts = this.fieldset('超时设置', '单位均为毫秒；长任务建议保留充足等待时间');
        [
          ['连接超时', 'connectMs'],
          ['响应头超时', 'responseHeaderMs'],
          ['流空闲超时', 'streamIdleMs'],
          ['请求总超时', 'requestMs'],
        ].forEach(([label, key]) => {
          if (Object.hasOwn(config.timeouts, key)) timeouts.body.append(this.numberField(label, ['timeouts', key], config.timeouts[key], 1));
        });
        if (timeouts.body.childElementCount) root.append(timeouts.node);
      }

      this.renderModelContextGroups(root, config);
      this.renderGoalCheckpointGroup(root, config);
      this.renderVisionRelayGroup(root, config);

      const channels = this.fieldset('模型通道', '逐通道编辑匹配、上游和网络策略；敏感请求头不会出现在表单中', 'wide');
      const list = el('div', 'target-list');
      (config.targets || []).forEach((target, index) => list.append(this.targetEditor(target, index)));
      channels.body.append(list);
      root.append(channels.node);

      this.querySelector('[data-action="validate"]').disabled = false;
      this.querySelector('#config-form button[type="submit"]').disabled = false;
      this.querySelector('#save-hint').textContent = '建议先预检，再保存到 config.json';
    }

    renderModelContextGroups(root, config) {
      // 复杂配置使用显式字段白名单，既保留未知扩展，也不会把它们误当成可编辑项。
      const context = config.modelContext;
      if (context && typeof context === 'object' && !Array.isArray(context)) {
        const group = this.fieldset('模型上下文', '控制 Codex 模型目录的上下文窗口与自动压缩阈值');
        if (Object.hasOwn(context, 'enabled')) group.body.append(this.booleanField('启用目录写回', ['modelContext', 'enabled'], context.enabled));
        if (Object.hasOwn(context, 'contextWindow')) group.body.append(this.numberField('上下文窗口（tokens）', ['modelContext', 'contextWindow'], context.contextWindow, 1));
        if (Object.hasOwn(context, 'autoCompactTokenLimit')) group.body.append(this.numberField('自动压缩阈值（tokens）', ['modelContext', 'autoCompactTokenLimit'], context.autoCompactTokenLimit, 0));
        if (Object.hasOwn(context, 'slugs') && Array.isArray(context.slugs)) {
          group.body.append(this.stringArrayField('应用模型', ['modelContext', 'slugs'], context.slugs, '每行填写一个模型 slug'));
        }
        if (group.body.childElementCount) root.append(group.node);
      }

      if (!Array.isArray(config.modelCapabilities)) return;
      const group = this.fieldset('模型能力预算', '每条规则按顺序匹配模型，设置上下文与输出预算', 'wide');
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
      root.append(group.node);
    }

    renderGoalCheckpointGroup(root, config) {
      const checkpoint = config.goalCheckpoint;
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return;
      const group = this.fieldset('长任务检查点', '控制历史裁剪时的目标摘要预算与冷重启恢复', 'wide');
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
      const group = this.fieldset('视觉中继', '为不支持图片的文本模型提供本机可控的视觉描述通道', 'wide');
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
      wrapper.append(el('span', 'field-label', label));
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
      } finally {
        this.setBusy('config', false);
      }
    }

    async saveConfig() {
      if (!this.configState || this.busy.has('config')) return;
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
        await this.loadConfig();
        this.validation = { errors: [], warnings: saved.warnings || [] };
        this.renderValidation();
        this.querySelector('#restart-notice').hidden = !saved.restartRequired;
        this.querySelector('#restart-notice').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (error) {
        if (error.code === 'revision_conflict') {
          this.showMessage('配置已在其他页面或进程中变化。请刷新后重新修改，避免覆盖新内容。');
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

    renderCheckpoints() {
      const root = this.querySelector('#checkpoint-panel');
      const data = this.checkpoints;
      if (!data) return;
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
      const dirty = this.configState ? isConfigDirty(this.configState) : false;
      this.dirty = dirty;
      this.querySelector('#dirty-badge').hidden = !dirty;
      if (this.configState) {
        this.querySelector('#save-hint').textContent = dirty ? '更改尚未写入配置文件' : '当前表单与配置文件一致';
      }
    }

    setBusy(area, busy) {
      if (busy) this.busy.add(area);
      else this.busy.delete(area);
      if (area === 'config') {
        this.querySelectorAll('[data-action="validate"], #config-form button[type="submit"]').forEach((button) => {
          button.disabled = busy || !this.configState;
          button.setAttribute('aria-busy', String(busy));
        });
      }
    }

    showMessage(message) {
      const notice = this.querySelector('#global-message');
      notice.textContent = message;
      notice.hidden = false;
    }

    clearMessage() {
      const notice = this.querySelector('#global-message');
      notice.hidden = true;
      notice.textContent = '';
    }
  }

  if (!customElements.get('router-admin')) customElements.define('router-admin', RouterAdmin);
})();
