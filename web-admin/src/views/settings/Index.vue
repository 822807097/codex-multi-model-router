<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <div class="text-xl font-bold text-primary tracking-wide">系统与路由配置中心</div>
        <div class="text-xs text-secondary mt-1">管理多模型视觉中继（借眼看图）、Codex 插件转换、网络代理与目标 Targets</div>
      </div>
    </div>

    <!-- 配置区（统一异步状态：骨架 / 错误重试 / 内容） -->
    <AsyncContainer
      :loading="loading"
      :error="!!loadError"
      :error-detail="loadError"
      error-text="系统配置加载失败"
      :min-height="260"
      @retry="loadConfig"
    >
    <!-- 视觉中继状态 -->
    <el-card shadow="never" class="setting-card">
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-lg">👁️</span>
            <span class="font-bold text-primary text-sm">纯文本模型「借眼看图」视觉中继 (Vision Relay)</span>
            <el-tag type="success" size="small" effect="plain">运行中</el-tag>
          </div>
        </div>
      </template>
      <!-- 视觉中继端点列表：多平台/多模型，额度耗尽自动切换 -->
      <div class="space-y-3">
        <div
          v-for="(ep, idx) in visionEndpoints"
          :key="idx"
          class="border border-default rounded-lg p-3 bg-surface-2/40"
        >
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="font-semibold text-primary font-mono text-sm">{{ ep.model || '(未填模型)' }}</span>
              <span class="text-xs text-secondary font-mono truncate">@ {{ ep.host || '(未填地址)' }}</span>
              <el-tag v-if="ep.proxy?.mode === 'custom'" size="small" type="warning" effect="plain">代理</el-tag>
            </div>
            <div class="flex gap-1 shrink-0">
              <el-button size="small" text type="primary" :loading="visionTestingIdx === idx" @click="handleVisionTest(idx)">
                测试
              </el-button>
              <el-button size="small" text type="danger" :disabled="visionEndpoints.length <= 1" @click="visionEndpoints.splice(idx, 1)">
                删除
              </el-button>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-x-3 gap-y-2 text-xs">
            <el-input v-model="ep.model" size="small" placeholder="视觉模型，如 qwen3.8-max" class="font-mono" />
            <el-input v-model="ep.host" size="small" placeholder="API 地址 host" class="font-mono" />
            <el-input v-model="ep.prefix" size="small" placeholder="路径前缀，如 /compatible-mode/v1" class="font-mono" />
            <el-input v-model="ep.envKey" size="small" placeholder="密钥环境变量名（如 aliyun_video_key）" class="font-mono" />
            <el-select v-model="ep.protocol" size="small">
              <el-option label="https" value="https" />
              <el-option label="http" value="http" />
            </el-select>
          </div>
          <div class="mt-2">
            <ProxyConfigEditor v-model="ep.proxy" size="small" />
          </div>
          <div v-if="visionTestResult && visionTestResult.idx === idx" class="text-xs mt-1">
            <span v-if="visionTestResult.ok" class="text-success">
              连接正常：{{ visionTestResult.latencyMs }}ms · {{ visionTestResult.model }}
            </span>
            <span v-else class="text-danger break-all">测试失败：{{ visionTestResult.error }}</span>
          </div>
        </div>

        <el-button size="small" plain @click="addVisionEndpoint">
          <el-icon class="mr-1"><Plus /></el-icon>添加视觉端点
        </el-button>

        <div class="flex items-center gap-3">
          <el-button type="primary" :loading="visionSaving" @click="handleVisionSave">保存全部端点</el-button>
          <el-button :loading="visionTestingAll" @click="handleVisionTestAll">测试全部端点</el-button>
          <span class="text-xs text-secondary">
            额度耗尽（429/配额错误）自动冷却该端点并切换下一个，不影响任务执行
          </span>
        </div>
        <div class="text-xs text-secondary leading-relaxed">
          「密钥环境变量」怎么填：先在系统里保存密钥（Windows 命令行执行
          <code>setx 变量名 你的密钥</code>，如 <code>setx aliyun_video_key sk-xxx</code>），
          然后在这里填<b>变量名</b>（如 aliyun_video_key）。「测试」按钮会真实发一张图验证这个端点能不能用。
        </div>
      </div>
      <div v-if="configLoaded" class="mt-3 text-xs text-secondary">
        全局代理地址: <span class="font-mono text-regular">{{ proxyAddress }}</span>（viaProxy 通道经 HTTP CONNECT 隧道）
      </div>
    </el-card>

    <!-- Cursor 订阅网关（内置 Web 面板管理：状态/账号池/crsr_ key 增删） -->
    <el-card shadow="never" class="setting-card">
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-lg">🚀</span>
            <span class="font-bold text-primary text-sm">Cursor 订阅网关</span>
            <el-tag
              :type="cursorGw.running ? 'success' : 'danger'"
              size="small"
              effect="plain"
            >
              {{ cursorGw.running ? '运行中（端口 ' + cursorGw.port + '）' : '未运行' }}
            </el-tag>
          </div>
          <div class="flex gap-2">
            <el-button size="small" :loading="cursorGwLoading" @click="loadCursorGw">刷新状态</el-button>
          </div>
        </div>
      </template>
      <div class="text-xs text-secondary leading-relaxed mb-3">
        把 Cursor Pro 订阅额度转成 OpenAI 兼容接口的内置网关：多账号额度池、额度耗尽自动切换。
        在这里添加/删除 crsr_ key（Cursor 设置 → API KEY），模型自动在 Codex 下拉出现（<code>cursor/…</code>）。
      </div>
      <div v-if="cursorGw.error" class="text-xs text-danger mb-2">{{ cursorGw.error }}</div>

      <!-- 账号池表格 -->
      <el-table :data="cursorAccounts" size="small" class="custom-table" empty-text="尚未添加 Cursor 账号">
        <el-table-column label="备注" min-width="120">
          <template #default="{ row }">
            <span class="font-medium">{{ row.label || '未命名' }}</span>
            <span class="text-xs text-secondary">({{ row.hint }})</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'active' ? 'success' : 'danger'" effect="plain">
              {{ row.status === 'active' ? '正常' : (row.disabledReason || '停用') }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="可用模型数" width="120">
          <template #default="{ row }">
            {{ Array.isArray(row.models) ? row.models.length : 0 }}
            <el-tooltip :content="(row.models || []).join(', ')" placement="top" :show-after="100">
              <span class="text-xs text-secondary">(悬停看详情)</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="danger" @click="removeCursorAccount(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 添加账号表单 -->
      <div class="mt-4 flex items-end gap-3 flex-wrap">
        <el-form class="flex items-end gap-2 flex-wrap" :inline="true" label-position="top">
          <el-form-item label="crsr_ Key（或留空用 CURSOR_KEY 环境变量）" class="mb-0">
            <!-- type=password：crsr_ 是敏感凭据，避免明文展示被肩窥 -->
            <el-input
              v-model="cursorNewKey"
              type="password"
              show-password
              placeholder="crsr_…（留空 = 用机器 CURSOR_KEY）"
              class="font-mono"
              style="min-width:280px"
            />
          </el-form-item>
          <el-form-item label="备注" class="mb-0">
            <el-input v-model="cursorNewLabel" placeholder="例如：主力账号" style="width:140px" />
          </el-form-item>
          <el-form-item class="mb-0">
            <el-button type="primary" :loading="cursorAdding" @click="addCursorAccount">
              添加账号
            </el-button>
          </el-form-item>
        </el-form>
      </div>
    </el-card>

    <!-- Codex 插件与 MCP 适配 -->
    <el-card shadow="never" class="setting-card">
      <template #header>
        <div class="flex items-center gap-2">
          <span class="text-lg">🔌</span>
          <span class="font-bold text-primary text-sm">Codex 插件与 MCP (Model Context Protocol) 适配</span>
          <el-tag type="success" size="small" effect="plain">自动转换就绪</el-tag>
        </div>
      </template>
      <div class="text-xs text-secondary leading-relaxed">
        支持自动将 Codex 客户端的各种工具（shell_command、file_editor、tool_search 等）无损转换为各上游大模型（OpenAI / Claude / Gemini / Qwen / DeepSeek）标准工具声明。
      </div>
    </el-card>

    <!-- 路由 Targets 清单（动态管理：添加/编辑/删除自定义厂商通道） -->
    <el-card shadow="never" class="setting-card">
      <template #header>
        <div class="flex items-center justify-between">
          <div class="font-bold text-primary text-sm">已启用的路由目标通道 (Targets)</div>
          <el-button size="small" type="primary" plain @click="openTargetEditor(null)">
            <el-icon class="mr-1"><Plus /></el-icon>添加通道
          </el-button>
        </div>
      </template>
      <div class="overflow-x-auto">
      <el-table :data="targets" style="width: 100%" class="custom-table">
        <el-table-column prop="name" label="目标名称" width="180">
          <template #default="{ row }">
            <span class="font-bold text-primary font-mono">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="platform" label="平台类型" width="140" />
        <el-table-column prop="host" label="上游 Host" min-width="220" />
        <el-table-column label="密钥来源" width="150">
          <template #default="{ row }">
            <el-tag
              v-if="poolKeyCounts[row.name] > 0"
              type="success"
              size="small"
              effect="plain"
            >
              密钥池（{{ poolKeyCounts[row.name] }} 把）
            </el-tag>
            <el-tag
              v-else-if="row.envKey"
              type="info"
              size="small"
              effect="plain"
            >
              环境变量 {{ row.envKey }}
            </el-tag>
            <el-tag v-else type="warning" size="small" effect="plain">未配置</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="proxy" label="代理" width="180">
          <template #default="{ row }">
            <el-tooltip v-if="row.proxyUrl" :content="`走 ${row.proxyUrl}（协议由地址决定）`" placement="top">
              <el-tag type="warning" size="small" class="font-mono">{{ row.proxyUrl }}</el-tag>
            </el-tooltip>
            <el-tag v-else-if="row.proxy" type="warning" size="small">全局代理</el-tag>
            <el-tag v-else type="success" size="small">直连</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              text
              type="primary"
              :loading="testingTarget === row.name"
              @click="handleTestTarget(row)"
            >
              测试
            </el-button>
            <el-button size="small" text type="primary" @click="openTargetEditor(row)">编辑</el-button>
            <el-button size="small" text type="danger" @click="handleDeleteTarget(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
    </el-card>
    </AsyncContainer>

    <!-- Codex 桌面端接入：一键恢复官方直连 / 一键接入路由 + 模型动态加载 -->
    <el-card shadow="never" class="setting-card">
      <template #header>
        <div class="flex items-center justify-between flex-wrap gap-2">
          <div class="flex items-center gap-2">
            <span class="text-lg">🖥️</span>
            <span class="font-bold text-primary text-sm">Codex 桌面端接入</span>
            <el-tag size="small" :type="desktopState.mode === 'router' ? 'warning' : 'success'" effect="plain">
              {{ desktopState.mode === 'router' ? '已接入路由' : '官方直连' }}
            </el-tag>
          </div>
          <el-button size="small" :loading="desktopLoading" @click="loadDesktopState">刷新状态</el-button>
        </div>
      </template>
      <div class="text-xs text-secondary leading-relaxed mb-3">
        <b>恢复官方直连</b>：把 Codex 配置还原为纯官方（config.toml 去掉路由、models.json 只留官方 gpt 模型，改前自动备份），用于验证「直连官方是否正常」；
        <b>一键接入路由</b>：把 Codex 指回本路由（<code>{{ desktopState.routerBaseUrl }}</code>），并将下方勾选的模型写入桌面端目录（不勾选任何额外模型 = 只加载官方模型走路由转发）。两种操作改完都需<b>完全退出并重启 Codex 桌面端</b>。
      </div>
      <div class="flex items-center gap-3 flex-wrap">
        <el-button type="primary" :loading="desktopSaving" @click="openDesktopRouterDialog">
          <el-icon class="mr-1"><Connection /></el-icon>一键接入路由（选择模型）
        </el-button>
        <el-button type="danger" plain :loading="desktopRestoring" @click="restoreDesktopOfficial">
          恢复官方直连
        </el-button>
        <span class="text-xs text-secondary">
          当前加载 {{ desktopLoadedCount }} 个模型 · 默认 {{ desktopState.defaultModel || '—' }}
        </span>
      </div>
    </el-card>

    <!-- 接入路由：模型选择弹窗（可单选/多选/全选） -->
    <el-dialog v-model="desktopDialogOpen" title="接入路由：选择要加载到 Codex 的模型" width="640px" class="custom-dialog-pro" append-to-body>
      <div class="text-xs text-secondary mb-2">勾选要写入 Codex 桌面端目录的模型（单选、多选、全选均可）：</div>
      <div class="flex items-center gap-3 mb-2">
        <el-checkbox v-model="desktopSelectAll" :indeterminate="desktopIndeterminate">全选</el-checkbox>
        <el-button size="small" text type="primary" @click="desktopSelectedModels = []">清空</el-button>
        <span class="text-xs text-secondary">已选 {{ desktopSelectedModels.length }} / {{ desktopState.models.length }}</span>
      </div>
      <el-checkbox-group
        v-model="desktopSelectedModels"
        class="grid grid-cols-2 gap-1 max-h-72 overflow-y-auto border border-muted rounded-lg p-2"
      >
        <el-checkbox v-for="m in desktopState.models" :key="m.slug" :value="m.slug">
          <span class="font-mono text-xs">{{ m.slug }}</span>
          <el-tag v-if="m.official" size="small" type="success" effect="plain" class="ml-1">官方</el-tag>
        </el-checkbox>
      </el-checkbox-group>
      <el-form label-position="top" class="mt-3">
        <el-form-item label="默认启动模型">
          <el-select v-model="desktopDefaultModel" filterable style="width: 280px" placeholder="选择默认模型">
            <el-option v-for="s in desktopSelectedModels" :key="s" :value="s" :label="s" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="desktopDialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="desktopSaving" @click="applyDesktopRouter">应用并接入路由</el-button>
      </template>
    </el-dialog>

    <!-- 通道编辑弹窗（自定义厂商动态管理） -->
    <TargetEditorDialog
      v-model="showTargetEditor"
      :editing="editingTarget"
      :config-revision="configRevision"
      :catalog-revision="catalogRevision"
      @saved="loadConfig"
    />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { getSystemConfig, saveSystemConfig, testVisionRelay, getCursorGatewayStatus, listCursorGatewayAccounts, addCursorGatewayAccount, removeCursorGatewayAccount, getCodexDesktopState, restoreCodexDesktopOfficial, applyCodexDesktopRouter } from '../../api/system.js';
import { listChannelKeys } from '../../api/channelKeys.js';
import { getModelRouting, commitModelOperations, testTargetConnection } from '../../api/models.js';
import { ElMessage, ElMessageBox } from 'element-plus';
import AsyncContainer from '../../components/AsyncContainer.vue';
import TargetEditorDialog from '../../components/TargetEditorDialog.vue';
import ProxyConfigEditor from '../../components/ProxyConfigEditor.vue';

const loading = ref(true);
const loadError = ref('');
// 通道密钥池条目数（target → 池内 key 数），供「密钥来源」列展示
const poolKeyCounts = ref({});

// 预置展示；onMounted 后用 /_admin/api/config 的脱敏真实配置覆盖。
const targets = ref([
  { name: 'openai', platform: 'openai', host: 'chatgpt.com', proxy: true },
  { name: 'deepseek-chat', platform: 'deepseek', host: 'api.deepseek.com', proxy: false },
  { name: 'bailian', platform: 'dashscope', host: 'dashscope.aliyuncs.com', proxy: false },
  { name: 'opencode-go-chat', platform: 'openai', host: 'opencode.ai', proxy: false },
]);
// ---- 通道动态管理（自定义厂商：可编辑 API 地址/协议/匹配，可增删） ----
const showTargetEditor = ref(false);
const editingTarget = ref(null);
const testingTarget = ref('');
const testResult = reactive({ target: '', text: '', ok: false });
const configRevision = ref('');
const catalogRevision = ref('');

function openTargetEditor(row) {
  editingTarget.value = row || null;
  showTargetEditor.value = true;
}

function serializeVisionEndpoint(ep) {
  const result = {
    model: ep.model?.trim() || '',
    host: ep.host?.trim() || '',
    prefix: ep.prefix?.trim() || '/compatible-mode/v1',
    protocol: ep.protocol || 'https',
    envKey: ep.envKey?.trim() || '',
  };
  if (ep.proxy?.mode === 'custom' && ep.proxy.url?.trim()) {
    result.viaProxy = true;
    result.proxyUrl = ep.proxy.url.trim();
  } else if (ep.proxy?.mode === 'global') {
    result.viaProxy = true;
  } else {
    result.viaProxy = false;
  }
  return result;
}

// 用指定端点配置真实测试视觉中继（发 1x1 图片验证全链路）
async function handleVisionTest(idx) {
  const ep = visionEndpoints.value[idx];
  if (!ep?.host?.trim() || !ep?.model?.trim()) {
    ElMessage.warning('请先填写该端点的视觉模型与 API 地址');
    return;
  }
  visionTestingIdx.value = idx;
  visionTestResult.value = null;
  // 免费共享端点（如 NVIDIA Trial）可能几十秒才响应，先给即时反馈，避免「点击像没反应」
  ElMessage.info('正在测试该视觉端点…免费共享端较慢，最长约 2.5 分钟，请稍候');
  try {
    const res = await testVisionRelay({ relay: serializeVisionEndpoint(ep) });
    visionTestResult.value = { ...(res || { ok: false, error: '无响应' }), idx };
  } catch (err) {
    visionTestResult.value = { ok: false, error: err.response?.data?.error?.message || err.message || '测试失败', idx };
  } finally {
    visionTestingIdx.value = null;
  }
}

// 顺序测试全部端点
async function handleVisionTestAll() {
  visionTestingAll.value = true;
  try {
    for (let idx = 0; idx < visionEndpoints.value.length; idx += 1) {
      const ep = visionEndpoints.value[idx];
      if (!ep?.host?.trim() || !ep?.model?.trim()) continue;
      const res = await testVisionRelay({ relay: serializeVisionEndpoint(ep) });
      ElMessage[res?.ok ? 'success' : 'warning'](
        `${ep.model}@${ep.host}: ${res?.ok ? `${res.latencyMs}ms` : (res?.error || '失败')}`,
      );
    }
  } catch { /* 拦截器提示 */ } finally {
    visionTestingAll.value = false;
  }
}

// 保存视觉中继多端点配置（走 config PUT：revision + 脱敏占位回填）
async function handleVisionSave() {
  const endpoints = visionEndpoints.value.map(serializeVisionEndpoint);
  const invalid = endpoints.find((ep) => !ep.host || !ep.model || !ep.envKey);
  if (invalid) {
    ElMessage.warning('每个端点都必须填写：视觉模型、服务器地址、密钥环境变量');
    return;
  }
  visionSaving.value = true;
  try {
    const current = await getSystemConfig({ skipGlobalError: true });
    const config = JSON.parse(JSON.stringify(current.config || {}));
    config.visionRelay = {
      ...visionRelayExtras.value,
      endpoints,
    };
    await saveSystemConfig({ revision: current.revision, config });
    ElMessage.success(`视觉中继已保存 ${endpoints.length} 个端点；重启路由后生效`);
    visionTestResult.value = null;
    await loadConfig();
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    visionSaving.value = false;
  }
}

// 用已保存配置真实测试连通性（走目标级/全局代理）
async function handleTestTarget(row) {
  testingTarget.value = row.name;
  testResult.target = row.name;
  try {
    const res = await testTargetConnection({ targetName: row.name });
    if (res?.ok && res.authFailed) {
      testResult.ok = true;
      testResult.text = `网络连通（${res.latencyMs}ms），但${res.error}`;
      ElMessage.warning(testResult.text);
    } else if (res?.ok) {
      testResult.ok = true;
      testResult.text = `连接正常：${res.latencyMs}ms，上游 ${res.modelCount} 个模型${res.proxy !== '直连' ? ` · ${res.proxy}` : ''}`;
      ElMessage.success(testResult.text);
    } else {
      testResult.ok = false;
      testResult.text = `连接失败：${res?.error || '未知错误'}`;
      ElMessage.warning(testResult.text);
    }
  } catch (err) {
    testResult.ok = false;
    testResult.text = err.response?.data?.error?.message || err.message || '测试失败';
    ElMessage.error(testResult.text);
  } finally {
    testingTarget.value = '';
  }
}

async function handleDeleteTarget(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除通道「${row.name}」吗？删除后路由不再向该通道转发请求（需重启生效）。`,
      '删除通道',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  try {
    await commitModelOperations([{ kind: 'target.delete', targetRef: row.targetRef }]);
    ElMessage.success('通道已删除；重启路由后生效');
    await loadConfig();
  } catch { /* 错误提示由请求拦截器统一处理（如通道仍被模型绑定） */ }
}

const visionEndpoints = ref([]);
const visionRelayExtras = ref({ concurrency: 3, cacheMaxEntries: 64, maxImagesPerRequest: 8 });
const visionTesting = ref(false);
const visionTestingIdx = ref(null);
const visionTestingAll = ref(false);
const visionSaving = ref(false);
const visionTestResult = ref(null);

function emptyVisionEndpoint() {
  return {
    model: '',
    host: '',
    prefix: '/compatible-mode/v1',
    protocol: 'https',
    envKey: '',
    proxy: { mode: 'direct', url: '' },
  };
}
function addVisionEndpoint() {
  visionEndpoints.value.push(emptyVisionEndpoint());
}
const proxyAddress = ref('127.0.0.1:10808');
const configLoaded = ref(false);

// ---- Cursor 订阅网关（内置面板管理）----
const cursorGw = ref({ running: false, port: 6718, error: '' });
const cursorGwLoading = ref(false);
const cursorAccounts = ref([]);
const cursorNewKey = ref('');
const cursorNewLabel = ref('');
const cursorAdding = ref(false);

async function loadCursorGw() {
  cursorGwLoading.value = true;
  try {
    const st = await getCursorGatewayStatus({ skipGlobalError: true });
    cursorGw.value = { ...cursorGw.value, ...st, error: st?.error || '' };
    if (st?.running) {
      const acc = await listCursorGatewayAccounts({ skipGlobalError: true });
      // 网关用 status 字段标记：active 正常，其余（cooldown/disabled 等）视为停用
      cursorAccounts.value = (acc?.data || acc?.accounts || [])
        .filter((a) => a && typeof a === 'object')
        .map((a) => ({ ...a, statusText: a.status === 'active' ? '正常' : (a.disabledReason || '停用') }));
    } else {
      // 网关未运行：清空账号表，避免展示上一次连接时的过期列表误导用户
      cursorAccounts.value = [];
    }
  } catch (err) {
    cursorGw.value.running = false;
    cursorGw.value.error = err.response?.data?.error?.message || err.message || '网关连接失败';
  } finally {
    cursorGwLoading.value = false;
  }
}

async function addCursorAccount() {
  cursorAdding.value = true;
  try {
    const res = await addCursorGatewayAccount({
      cursorApiKey: cursorNewKey.value?.trim(),
      label: cursorNewLabel.value?.trim() || 'main',
    });
    if (res?.ok) {
      ElMessage.success('Cursor 账号已添加（额度池 +1，额度耗尽自动切换）');
      cursorNewKey.value = '';
      cursorNewLabel.value = '';
      await loadCursorGw();
    } else {
      ElMessage.error(res?.error?.message || res?.message || '添加失败');
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.error?.message || err.message || '添加失败');
  } finally {
    cursorAdding.value = false;
  }
}

async function removeCursorAccount(row) {
  try {
    await ElMessageBox.confirm(`确定删除 Cursor 账号「${row.label || row.hint}」吗？该 key 将停止参与额度池。`, '删除账号', {
      confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning',
    });
  } catch { return; }
  try {
    const res = await removeCursorGatewayAccount(row.id);
    ElMessage.success('账号已删除');
    await loadCursorGw();
  } catch { /* 拦截器提示 */ }
}

async function loadConfig() {
  loading.value = true;
  loadError.value = '';
  try {
    // 错误态由 AsyncContainer 呈现，跳过全局 toast
    const res = await getSystemConfig({ skipGlobalError: true });
    const config = res?.config;
    if (!config) return;
    configLoaded.value = true;
    if (Array.isArray(config.targets) && config.targets.length > 0) {
      targets.value = config.targets.map((t) => ({
        name: t.name || '未命名通道',
        platform: t.platform || 'generic',
        host: t.host || '',
        proxy: t.viaProxy === true,
        viaProxy: t.viaProxy === true,
        wireApi: t.wireApi || 'chat',
        envKey: t.envKey || '',
      }));
    }
    // 拉取联合路由状态（targetRef + revision），供通道编辑/删除事务使用
    try {
      const routing = await getModelRouting({ skipGlobalError: true });
      if (routing?.targets && Array.isArray(routing.targets)) {
        configRevision.value = routing.configRevision || '';
        catalogRevision.value = routing.catalogRevision || '';
        const byName = new Map(routing.targets.map((t) => [t.name, t]));
        targets.value = targets.value.map((t) => ({
          ...t,
          targetRef: byName.get(t.name)?.targetRef || '',
          match: byName.get(t.name)?.match || '',
          prefix: byName.get(t.name)?.prefix || '',
          protocol: byName.get(t.name)?.protocol || 'https',
          port: byName.get(t.name)?.port || null,
          proxyUrl: byName.get(t.name)?.proxyUrl || '',
          vision: byName.get(t.name)?.vision !== false,
          useOpenAiAuth: byName.get(t.name)?.useOpenAiAuth === true,
        }));
      }
    } catch { /* 联合状态不可用时仅展示静态列表 */ }
    // 密钥池条目数（全量分组返回，静默失败不影响通道表）
    try {
      const poolRes = await listChannelKeys('', { skipGlobalError: true });
      const counts = {};
      for (const group of (poolRes?.groups || [])) {
        counts[group.target] = group.count;
      }
      poolKeyCounts.value = counts;
    } catch { /* 密钥池不可用时仅显示 envKey 状态 */ }
    if (typeof config.proxy === 'string' && config.proxy) proxyAddress.value = config.proxy;
    if (config.visionRelay && typeof config.visionRelay === 'object') {
      const relay = config.visionRelay;
      visionRelayExtras.value = {
        concurrency: Number(relay.concurrency) || 3,
        cacheMaxEntries: Number(relay.cacheMaxEntries) || 64,
        maxImagesPerRequest: Number(relay.maxImagesPerRequest) || 8,
      };
      const toEndpoint = (ep) => ({
        model: ep.model || '',
        host: ep.host || '',
        prefix: ep.prefix || '/compatible-mode/v1',
        protocol: ep.protocol || 'https',
        envKey: ep.envKey || '',
        proxy: {
          mode: ep.proxyUrl ? 'custom' : (ep.viaProxy === true ? 'global' : 'direct'),
          url: ep.proxyUrl || '',
        },
      });
      if (Array.isArray(relay.endpoints) && relay.endpoints.length > 0) {
        visionEndpoints.value = relay.endpoints.map(toEndpoint);
      } else if (relay.host && relay.model) {
        // 兼容历史单条顶层配置
        visionEndpoints.value = [toEndpoint(relay)];
      } else {
        visionEndpoints.value = [];
      }
      if (visionEndpoints.value.length === 0) addVisionEndpoint();
    } else {
      visionEndpoints.value = [emptyVisionEndpoint()];
    }
  } catch (err) {
    loadError.value = err.response?.data?.error?.message || err.message || '请求失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadConfig();
  loadCursorGw();
  loadDesktopState();
});

// ---- Codex 桌面端接入（一键官方直连 / 一键接入路由 + 模型动态加载） ----
const desktopLoading = ref(false);
const desktopSaving = ref(false);
const desktopRestoring = ref(false);
const desktopState = reactive({ mode: '', defaultModel: '', models: [], routerBaseUrl: 'http://127.0.0.1:15730/v1' });
const desktopSelectedModels = ref([]);
const desktopDefaultModel = ref('');
const desktopDialogOpen = ref(false);
const desktopLoadedCount = computed(() => desktopSelectedModels.value.length);
const desktopSelectAll = computed({
  get: () => desktopState.models.length > 0 && desktopSelectedModels.value.length === desktopState.models.length,
  set: (val) => {
    desktopSelectedModels.value = val ? desktopState.models.map((m) => m.slug) : [];
  },
});
const desktopIndeterminate = computed(() => (
  desktopSelectedModels.value.length > 0
  && desktopSelectedModels.value.length < desktopState.models.length
));

function openDesktopRouterDialog() {
  if (desktopState.models.length === 0) {
    loadDesktopState().then(() => { desktopDialogOpen.value = true; });
    return;
  }
  desktopDialogOpen.value = true;
}

async function loadDesktopState() {
  desktopLoading.value = true;
  try {
    const res = await getCodexDesktopState({ skipGlobalError: true });
    desktopState.mode = res.mode || '';
    desktopState.defaultModel = res.defaultModel || '';
    desktopState.models = res.models || [];
    desktopState.routerBaseUrl = res.routerBaseUrl || desktopState.routerBaseUrl;
    const current = desktopState.models.map((m) => m.slug);
    desktopSelectedModels.value = current;
    desktopDefaultModel.value = current.includes(res.defaultModel)
      ? res.defaultModel
      : (current.includes('gpt-5.6-sol') ? 'gpt-5.6-sol' : (current[0] || ''));
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    desktopLoading.value = false;
  }
}

async function applyDesktopRouter() {
  const slugs = desktopSelectedModels.value;
  if (!slugs.length) {
    ElMessage.warning('请至少勾选一个模型');
    return;
  }
  if (!slugs.includes(desktopDefaultModel.value)) {
    desktopDefaultModel.value = slugs[0];
  }
  try {
    await ElMessageBox.confirm(
      `将把 Codex 指回路由（${desktopState.routerBaseUrl}），加载 ${slugs.length} 个模型（默认 ${desktopDefaultModel.value}）。现有 config.toml / models.json 会自动备份。确定？`,
      '接入路由',
      { confirmButtonText: '接入路由', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  desktopSaving.value = true;
  try {
    const res = await applyCodexDesktopRouter({
      slugs,
      defaultModel: desktopDefaultModel.value,
    });
    ElMessage.success(res.message || '已接入路由，请重启 Codex 桌面端生效');
    desktopDialogOpen.value = false;
    await loadDesktopState();
  } catch { /* 拦截器提示 */ } finally {
    desktopSaving.value = false;
  }
}

async function restoreDesktopOfficial() {
  try {
    await ElMessageBox.confirm(
      '将恢复 Codex 官方直连：config.toml 移除路由、models.json 只保留官方 gpt 模型（自动备份现有文件）。恢复后若官方可用，即证明路由侧配置是问题来源，方便排查。确定？',
      '恢复官方直连',
      { confirmButtonText: '恢复官方直连', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  desktopRestoring.value = true;
  try {
    const res = await restoreCodexDesktopOfficial({ defaultModel: desktopDefaultModel.value || 'gpt-5.6-sol' });
    ElMessage.success(res.message || '已恢复官方直连，请重启 Codex 桌面端生效');
    await loadDesktopState();
  } catch { /* 拦截器提示 */ } finally {
    desktopRestoring.value = false;
  }
}
</script>

<style scoped>
/* 卡片与表格配色由 main.css 的 EP 变量统一接管（--el-card-* / --el-table-* → tokens.css） */
.setting-card + .setting-card {
  margin-top: 1rem;
}
</style>
