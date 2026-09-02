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
            <el-button v-if="!cursorGw.running" type="primary" size="small" :loading="cursorGwStarting" @click="startCursorGw">启动网关</el-button>
            <el-button v-else size="small" :loading="cursorGwRestarting" @click="restartCursorGw">重启网关</el-button>
            <el-button size="small" :loading="cursorGwLoading" @click="loadCursorGw">刷新状态</el-button>
          </div>
        </div>
      </template>
      <div class="text-xs text-secondary leading-relaxed mb-3">
        把 Cursor Pro 订阅额度转成 OpenAI 兼容接口的内置网关：多账号额度池、额度耗尽自动切换。
        在这里添加/删除 crsr_ key（Cursor 设置 → API KEY），模型自动在 Codex 下拉出现（<code>cursor/…</code>）。
      </div>
      <div v-if="cursorGw.error" class="text-xs text-danger mb-2">{{ cursorGw.error }}</div>

      <!-- 可用模型清单（读路由目录，网关离线也能看） -->
      <div v-if="cursorModels.length" class="mb-3">
        <div class="text-xs text-secondary mb-1">网关可用模型（{{ cursorModels.length }} 个，选中账号后按账号支持情况过滤）：</div>
        <div class="flex flex-wrap gap-1">
          <el-tag v-for="model in cursorModels" :key="model.slug" size="small" effect="plain" class="font-mono">
            {{ model.slug }}
          </el-tag>
        </div>
      </div>
      <div v-else-if="!cursorGwLoading" class="text-xs text-secondary mb-3">
        暂无 cursor-* 模型目录：接入 Cursor 账号后自动生成，或在「模型管理」手动添加。
      </div>

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
          <div class="flex items-center gap-2">
            <el-button size="small" plain :loading="cleanupSaving" @click="handleCleanupUnusedGoogle">
              <el-icon class="mr-1"><Delete /></el-icon>清理未使用的谷歌通道
            </el-button>
            <el-button size="small" type="primary" plain @click="openTargetEditor(null)">
              <el-icon class="mr-1"><Plus /></el-icon>添加通道
            </el-button>
          </div>
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
        <b>一键接入路由</b>：弹窗勾选要加载的模型（可单选/多选/全选）并选默认启动模型，写入桌面端目录后指回本路由（<code>{{ desktopState.routerBaseUrl }}</code>）。两种操作改完都需<b>完全退出并重启 Codex 桌面端</b>（可用下方按钮一键重启）。
      </div>
      <div class="flex items-center gap-3 flex-wrap">
        <el-button type="primary" :loading="desktopSaving" @click="openDesktopRouterDialog">
          <el-icon class="mr-1"><Connection /></el-icon>一键接入路由（选择模型）
        </el-button>
        <el-button type="danger" plain :loading="desktopRestoring" @click="restoreDesktopOfficial">
          恢复官方直连
        </el-button>
        <el-button plain :loading="desktopRestarting" @click="restartDesktopApp">
          重启 ChatGPT 桌面端（应用改动后必做）
        </el-button>
        <el-button plain :loading="desktopSyncing" @click="handleSyncSessionProviders">
          <el-icon class="mr-1"><Refresh /></el-icon>修复历史会话（provider 同步）
        </el-button>
        <span class="text-xs text-secondary">
          选择器已加载 {{ loadedCount }} 个路由模型（官方全量常驻） · 默认 {{ desktopState.defaultModel || '—' }}
        </span>
      </div>
    </el-card>

    <!-- 接入路由：模型选择弹窗（可单选/多选/全选） -->
    <el-dialog v-model="desktopDialogOpen" title="接入路由：选择要加载到 Codex 的模型" width="640px" class="custom-dialog-pro" append-to-body>
      <div class="text-xs text-secondary mb-2">只勾选你用得到的模型——没勾的不会出现在 Codex 选择器里（官方模型始终保留）：</div>
      <div class="flex items-center gap-3 mb-2">
        <el-input
          v-model="desktopSearch"
          size="small"
          clearable
          placeholder="搜索模型名…"
          style="width: 180px"
        />
        <el-button size="small" text type="primary" @click="desktopSelectedModels = []">清空</el-button>
        <span class="text-xs text-secondary">已选 {{ desktopSelectedModels.length }} / {{ desktopState.models.length }}（当前已加载 {{ loadedCount }}）</span>
      </div>
      <el-checkbox-group
        v-model="desktopSelectedModels"
        class="grid grid-cols-2 gap-1 max-h-72 overflow-y-auto border border-muted rounded-lg p-2"
      >
        <el-checkbox v-for="m in filteredDesktopModels" :key="m.slug" :value="m.slug">
          <span class="font-mono text-xs">{{ m.slug }}</span>
          <el-tag v-if="m.official" size="small" type="success" effect="plain" class="ml-1">官方</el-tag>
          <el-tag v-if="m.loaded && !m.official" size="small" type="primary" effect="plain" class="ml-1">已加载</el-tag>
        </el-checkbox>
      </el-checkbox-group>
      <el-form label-position="top" class="mt-3">
        <el-form-item label="默认启动模型">
          <el-select v-model="desktopDefaultModel" filterable style="width: 280px" placeholder="选择默认模型">
            <el-option v-for="s in desktopSelectedModels" :key="s" :value="s" :label="s" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="desktopApiKeyAuth">API-key 接入（官方额度耗尽也能用自定义模型）</el-checkbox>
          <div class="text-xs text-secondary mt-1">
            接入时自动生成一把桌面端专用 API Key 写入配置，桌面端识别为 LocalRouter、不再关联官方额度；
            适合官方账号周/分钟额度常耗尽的场景。不勾选则复用官方登录态（额度耗尽可能被桌面端锁成 Luna）。
          </div>
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
import { ref, reactive, computed, onMounted } from 'vue';
import { getSystemConfig, saveSystemConfig, testVisionRelay, getCursorGatewayStatus, listCursorGatewayAccounts, addCursorGatewayAccount, removeCursorGatewayAccount, restartCursorGateway, startCursorGateway, listCursorGatewayModels, restartCodexDesktopApp, syncCodexSessionProviders, getCodexDesktopState, restoreCodexDesktopOfficial, applyCodexDesktopRouter } from '../../api/system.js';
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
const cleanupSaving = ref(false);
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
  // 拓扑预检：哪些模型仅由该通道路由——连同它们一起删，否则被
  // model_route_missing 硬错误拦下（防「从模型脚下抽走通道」的保护对
  // 连带删除场景不适用，2026-09-02 用户谷歌垃圾通道批量清理实锤）。
  let orphanModels = [];
  try {
    const routing = await getModelRouting({ skipGlobalError: true });
    const targets = Array.isArray(routing?.targets) ? routing.targets : [];
    const ref = row.targetRef || targets.find((t) => t.name === row.name)?.targetRef;
    const otherRefs = ref
      ? new Set(targets.filter((t) => t.targetRef !== ref).map((t) => t.targetRef))
      : null;
    if (ref && otherRefs) {
      orphanModels = (Array.isArray(routing?.bindings) ? routing.bindings : [])
        .filter((b) => Array.isArray(b.targetRefs)
          && b.targetRefs.includes(ref)
          && b.targetRefs.every((r) => !otherRefs.has(r)))
        .map((b) => b.slug);
    }
  } catch { /* 预检失败不阻断，走单删让后端报错兜底 */ }
  const affected = orphanModels.length
    ? `\n\n注意：${orphanModels.length} 个模型仅由该通道路由，将一并删除：${orphanModels.slice(0, 6).join('、')}${orphanModels.length > 6 ? ` 等 ${orphanModels.length} 个` : ''}`
    : '';
  try {
    await ElMessageBox.confirm(
      `确定删除通道「${row.name}」吗？删除后路由不再向该通道转发请求（需重启生效）。${affected}`,
      '删除通道',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  try {
    // 顺序：先删依赖该通道的模型，再删通道本身（后端不再要求「精确专属 match」，
    // 宽松匹配的多模型通道也可直接删除；失路由模型由本操作连带清理）
    const operations = [];
    for (const slug of orphanModels) operations.push({ kind: 'model.delete', slug });
    operations.push({ kind: 'target.delete', targetRef: row.targetRef });
    await commitModelOperations(operations);
    ElMessage.success(orphanModels.length
      ? `通道已删除，连带删除 ${orphanModels.length} 个仅此路由的模型；重启路由后生效`
      : '通道已删除；重启路由后生效');
    await loadConfig();
  } catch { /* 错误提示由请求拦截器统一处理（如通道仍被模型绑定） */ }
}

async function handleCleanupUnusedGoogle() {
  if (cleanupSaving.value) return;
  cleanupSaving.value = true;
  try {
    const routing = await getModelRouting({ skipGlobalError: true });
    const desktop = await getCodexDesktopState({ skipGlobalError: true }).catch(() => ({ models: [] }));
    const loadedSet = new Set(
      (desktop.models || []).filter((m) => m.loaded && !m.official).map((m) => m.slug),
    );
    const targetsList = Array.isArray(routing?.targets) ? routing.targets : [];
    const bindings = Array.isArray(routing?.bindings) ? routing.bindings : [];
    const google = targetsList.filter((t) => t.platform === 'google');
    const modelsOf = (ref) => bindings.filter((b) => (b.targetRefs || []).includes(ref)).map((b) => b.slug);
    // 待删通道：绑定模型里没有一个在「已加载」集（用户当前不用的）
    const removeRefs = new Set();
    for (const t of google) {
      const models = modelsOf(t.targetRef);
      if (models.some((s) => loadedSet.has(s))) continue;
      removeRefs.add(t.targetRef);
    }
    if (removeRefs.size === 0) {
      ElMessage.info('没有发现未使用的谷歌通道（全部当前都在用或已被清理）');
      return;
    }
    // 孤儿模型：其所有匹配通道都是待删通道（其他通道匹配不到）
    const orphanModels = [...new Set(
      bindings
        .filter((b) => (b.targetRefs || []).length > 0
          && b.targetRefs.every((ref) => removeRefs.has(ref)))
        .map((b) => b.slug),
    )];
    const removedTargets = targetsList.filter((t) => removeRefs.has(t.targetRef)).map((t) => t.name);
    try {
      await ElMessageBox.confirm(
        `将删除 ${removedTargets.length} 个未使用的谷歌通道${orphanModels.length ? `，并连带删除 ${orphanModels.length} 个仅由这些通道路由的模型（${orphanModels.slice(0, 8).join('、')}${orphanModels.length > 8 ? ' 等' : ''}）` : ''}。`
        + '\n\n保留标准：通道绑定的模型里有你在用的（已加载）。\n删除后重启路由生效；订阅页「一键接入」可随时重新加入。',
        '清理未使用的谷歌通道',
        { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
      );
    } catch { return; }
    const operations = [];
    for (const ref of removeRefs) operations.push({ kind: 'target.delete', targetRef: ref });
    for (const slug of orphanModels) operations.push({ kind: 'model.delete', slug });
    await commitModelOperations(operations);
    ElMessage.success(`已删除 ${removedTargets.length} 个谷歌通道${orphanModels.length ? ` + ${orphanModels.length} 个模型` : ''}；重启路由后生效`);
    await loadConfig();
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    cleanupSaving.value = false;
  }
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
const cursorGwRestarting = ref(false);
const cursorGwStarting = ref(false);
const cursorModels = ref([]);
const cursorAccounts = ref([]);
const cursorNewKey = ref('');
const cursorNewLabel = ref('');
const cursorAdding = ref(false);

// 网关可用模型清单（读路由目录，网关离线也能看）
async function loadCursorModels() {
  try {
    const res = await listCursorGatewayModels({ skipGlobalError: true });
    cursorModels.value = Array.isArray(res?.models) ? res.models : [];
  } catch {
    cursorModels.value = [];
  }
}

async function startCursorGw() {
  cursorGwStarting.value = true;
  try {
    const res = await startCursorGateway();
    ElMessage.success(res.message || '网关启动中，约 5 秒后就绪');
    setTimeout(() => loadCursorGw(), 6000);
  } catch { /* 拦截器提示 */ } finally {
    cursorGwStarting.value = false;
  }
}

async function restartCursorGw() {
  try {
    await ElMessageBox.confirm(
      '将重启内置 Cursor 网关（停掉 6718/6719 旧进程后重新拉起，账号池与凭据保留）。确定？',
      '重启 Cursor 网关',
      { confirmButtonText: '重启网关', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  cursorGwRestarting.value = true;
  try {
    const res = await restartCursorGateway();
    ElMessage.success(res.message || '网关重启中，约 5 秒后就绪');
    setTimeout(() => loadCursorGw(), 6000);
  } catch { /* 拦截器提示 */ } finally {
    cursorGwRestarting.value = false;
  }
}

async function restartDesktopApp() {
  try {
    await ElMessageBox.confirm(
      '将完全退出并重新拉起 ChatGPT 桌面端（config.toml / models.json 改动必须重启才生效）。现在执行？',
      '重启 ChatGPT 桌面端',
      { confirmButtonText: '重启', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  desktopRestarting.value = true;
  try {
    const res = await restartCodexDesktopApp();
    ElMessage.success(res.message || '桌面端重启中…');
  } catch { /* 拦截器提示 */ } finally {
    desktopRestarting.value = false;
  }
}

async function handleSyncSessionProviders() {
  try {
    await ElMessageBox.confirm(
      '把历史会话的 provider 统一迁到路由（修复「继续接续任务」时报 401：旧会话仍指向官方 openai 通道，API-key/路由接入后会直连 api.openai.com）。'
      + '\n\n历史对话内容不会丢失——只改会话的 provider 标记。执行后建议重启桌面端。现在执行？',
      '修复历史会话（provider 同步）',
      { confirmButtonText: '同步', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  desktopSyncing.value = true;
  try {
    const res = await syncCodexSessionProviders();
    ElMessage.success(res.message || '历史会话已同步');
    await loadConfig();
  } catch { /* 拦截器提示 */ } finally {
    desktopSyncing.value = false;
  }
}

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
  loadCursorModels();
  loadDesktopState();
});

// ---- Codex 桌面端接入（一键官方直连 / 一键接入路由 + 模型动态加载） ----
const desktopLoading = ref(false);
const desktopSaving = ref(false);
const desktopRestoring = ref(false);
const desktopRestarting = ref(false);
const desktopSyncing = ref(false);
const desktopState = reactive({ mode: '', defaultModel: '', models: [], routerBaseUrl: 'http://127.0.0.1:15730/v1' });
const desktopSelectedModels = ref([]);
const desktopDefaultModel = ref('');
const desktopApiKeyAuth = ref(false);
const desktopDialogOpen = ref(false);
const desktopSearch = ref('');
// 已加载 = models.desktop.json 里实际存在的模型（官方全量常驻，不计入）
const loadedCount = computed(
  () => desktopState.models.filter((m) => m.loaded && !m.official).length,
);
// 搜索过滤（slug 子串，不区分大小写）
const filteredDesktopModels = computed(() => {
  const q = desktopSearch.value.trim().toLowerCase();
  if (!q) return desktopState.models;
  return desktopState.models.filter((m) => m.slug.toLowerCase().includes(q));
});

function openDesktopRouterDialog() {
  if (desktopState.models.length === 0) {
    loadDesktopState().then(() => {
      if (desktopState.models.length === 0) {
        ElMessage.error('桌面端状态加载失败，请先点击「刷新状态」后重试');
        return;
      }
      desktopDialogOpen.value = true;
    });
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
    // 默认勾选 = 当前已加载集（官方 + models.desktop.json 里的路由模型），
    // 不再默认全选——勾选即所得，未勾选的一键接入新模型不会涌入选择器。
    const loadedSlugs = desktopState.models.filter((m) => m.loaded).map((m) => m.slug);
    desktopSelectedModels.value = loadedSlugs;
    desktopDefaultModel.value = loadedSlugs.includes(res.defaultModel)
      ? res.defaultModel
      : (loadedSlugs.includes('gpt-5.6-sol') ? 'gpt-5.6-sol' : (loadedSlugs[0] || ''));
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
      `将把 Codex 指回路由（${desktopState.routerBaseUrl}），选择器加载勾选的 ${slugs.length} 个模型 + 官方全量（默认 ${desktopDefaultModel.value}）。现有 config.toml / models.json 会自动备份。确定？`,
      '接入路由',
      { confirmButtonText: '接入路由', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  desktopSaving.value = true;
  try {
    const res = await applyCodexDesktopRouter({
      slugs,
      defaultModel: desktopDefaultModel.value,
      apiKeyAuth: desktopApiKeyAuth.value,
    });
    ElMessage.success(res.message || '已接入路由');
    desktopDialogOpen.value = false;
    await loadDesktopState();
    await autoRestartDesktopPrompt();
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
    ElMessage.success(res.message || '已恢复官方直连');
    await loadDesktopState();
    await autoRestartDesktopPrompt();
  } catch { /* 拦截器提示 */ } finally {
    desktopRestoring.value = false;
  }
}

// 配置写入成功后：询问是否立即重启桌面端生效（不打断用户的自行安排）
async function autoRestartDesktopPrompt() {
  let proceed = true;
  try {
    await ElMessageBox.confirm(
      '配置已写入。ChatGPT 桌面端只在启动时读取配置，需完全重启才生效。是否立即重启？',
      '重启生效',
      { confirmButtonText: '立即重启', cancelButtonText: '稍后自己重启', type: 'info' },
    );
  } catch { proceed = false; }
  if (!proceed) return;
  desktopRestarting.value = true;
  try {
    const res = await restartCodexDesktopApp();
    ElMessage.success(res.message || '桌面端重启中…');
  } catch { /* 拦截器提示 */ } finally {
    desktopRestarting.value = false;
  }
}
</script>

<style scoped>
/* 卡片与表格配色由 main.css 的 EP 变量统一接管（--el-card-* / --el-table-* → tokens.css） */
.setting-card + .setting-card {
  margin-top: 1rem;
}
</style>
