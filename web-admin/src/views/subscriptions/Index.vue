<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <div class="text-xl font-bold text-primary tracking-wide">平台会员订阅授权管理</div>
        <div class="text-xs text-secondary mt-1">接入 Claude Pro / Google Gemini / ChatGPT 会员订阅，支持多账号智能轮换与独立代理</div>
      </div>
    </div>

    <!-- 分平台面板（统一异步状态：骨架 / 错误重试 / 内容） -->
    <AsyncContainer
      :loading="loading"
      :error="!!loadError"
      :error-detail="loadError"
      error-text="订阅账号列表加载失败"
      :min-height="260"
      @retry="loadAllAccounts"
    >
    <div class="space-y-4">
    <el-card
      v-for="platform in platforms"
      :key="platform.provider"
      shadow="never"
      class="platform-card"
    >
      <template #header>
        <div class="flex items-center justify-between flex-wrap gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div
              class="platform-badge"
              :class="platform.iconClass"
            >{{ platform.icon }}</div>
            <div class="min-w-0">
              <div class="font-semibold text-primary text-sm">{{ platform.title }}</div>
              <div class="text-xs text-secondary mt-0.5 leading-relaxed">{{ platform.subtitle }}</div>
            </div>
          </div>
          <el-button type="primary" size="small" class="shrink-0" @click="openDialog(platform.provider)">
            <el-icon class="mr-1"><Plus /></el-icon>
            {{ platform.actionLabel }}
          </el-button>
        </div>
      </template>

      <div v-if="getAccounts(platform.provider).length > 0" class="space-y-3">
        <!-- ChatGPT 平台：显示 Codex 当前登录身份（一键切换的对照） -->
        <div v-if="platform.provider === 'openai'" class="text-xs text-secondary">
          Codex 桌面端当前登录：
          <span :class="codexIdentity.loggedIn ? 'text-success font-medium' : 'text-danger'">
            {{ codexIdentity.loggedIn ? (codexIdentity.email || '已登录（未识别邮箱）') : '未登录' }}
          </span>
          <span v-if="codexIdentity.lastRefresh"> · 登录态刷新于 {{ formatQuotaReset(Date.parse(codexIdentity.lastRefresh) || 0) }}</span>
        </div>
        <div v-for="acc in getAccounts(platform.provider)" :key="acc.id" class="account-item">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div class="min-w-0">
              <span class="font-semibold text-primary text-sm break-all">{{ acc.alias }}</span>
              <span v-if="acc.email" class="text-xs text-secondary ml-2 break-all">({{ acc.email }})</span>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <el-tag v-if="acc.metadata?.planType" type="warning" size="small" effect="plain">
                {{ acc.metadata.planType }}
              </el-tag>
              <el-tag :type="statusMeta(acc).type" size="small" effect="plain">{{ statusMeta(acc).label }}</el-tag>
              <el-tag type="info" size="small" effect="plain" class="max-w-full">
                <span class="truncate">{{ acc.proxy?.enabled ? `代理: ${acc.proxy.url || '未填写'}` : '直连' }}</span>
              </el-tag>
            </div>
          </div>

          <!-- 额度：ChatGPT=上游真实 5h/周窗口；谷歌=本地周计数+限流说明 -->
          <div class="mt-3">
            <div class="flex items-center justify-between text-xs text-secondary mb-1.5">
              <span>额度</span>
              <el-button size="small" text type="primary" :loading="quotaLoading[acc.id]" @click="loadQuota(acc)">刷新</el-button>
            </div>

            <!-- ChatGPT：按窗口实际时长展示（primary/secondary 语义随账号状态变化） -->
            <template v-if="acc.provider === 'openai' && quotaData[acc.id]?.ok">
              <div class="text-[11px] text-secondary mb-1">
                套餐 <span class="font-medium text-primary">{{ (quotaData[acc.id].planType || 'pro').toUpperCase() }}</span>
                <template v-if="quotaData[acc.id].activeLimit"> · 当前生效限制 <span class="font-medium">{{ quotaData[acc.id].activeLimit }}</span></template>
                <template v-if="quotaData[acc.id].creditsBalance && quotaData[acc.id].creditsBalance !== '0'"> · 余额 {{ quotaData[acc.id].creditsBalance }}</template>
              </div>
              <template v-for="(row, rowIndex) in [quotaData[acc.id].fiveHour, quotaData[acc.id].weekly]" :key="rowIndex">
                <div v-if="row && Number(row.windowMinutes) > 0" class="quota-row">
                  <span class="quota-label">{{ quotaRowLabel(row) }}</span>
                  <el-progress
                    :percentage="row.usedPercent ?? 0"
                    :stroke-width="8"
                    :show-text="false"
                    :color="quotaBarColor(row.usedPercent)"
                    class="flex-1"
                  />
                  <span class="quota-value font-mono">
                    {{ row.usedPercent != null ? row.usedPercent.toFixed(1) + '%' : '—' }}
                    <template v-if="row.resetsAt"> · {{ formatQuotaReset(row.resetsAt) }} 重置</template>
                  </span>
                </div>
              </template>
              <div class="text-[11px] text-secondary mt-1">
                Codex 官方实时数据（与 Codex CLI 内置额度条同源）；行名按窗口实际时长自动标注
              </div>
            </template>
            <div v-else-if="acc.provider === 'openai'" class="text-[11px] text-secondary">
              {{ quotaData[acc.id]?.error || '点「刷新」拉取该账号的真实额度（需要该账号先产生一次请求）' }}
            </div>

            <!-- 谷歌 / 其他：本地周计数 -->
            <template v-if="acc.provider !== 'openai'">
              <div class="text-xs text-secondary">
                本周已用 <span class="font-mono">{{ acc.quota?.used || 0 }}</span> 次请求
                <template v-if="acc.quota?.resetsAt > 0"> · {{ formatQuotaReset(acc.quota.resetsAt) }} 重置</template>
              </div>
              <div class="text-[11px] text-secondary mt-1 leading-relaxed">
                谷歌订阅无公开配额接口（按分钟/按模型限额）；触发限流时路由自动换账号，约 1 分钟自动恢复
              </div>
            </template>

            <div class="text-[11px] text-secondary mt-1 leading-relaxed">
              <template v-if="acc.status === 'cooldown'">
                <span class="font-semibold text-danger">额度受限：于 {{ formatQuotaReset(acc.cooldownUntil) }} 恢复</span>
                <template v-if="acc.metadata?.lastCooldownReason">（{{ acc.metadata.lastCooldownReason }}）</template>
              </template>
              <template v-else>正常使用中</template>
            </div>
          </div>

          <!-- 额度消耗顺序：数字越小越先消耗该账号的订阅额度（空 = 自动按套餐档位） -->
          <div class="mt-3 flex items-center gap-2 flex-wrap">
            <span class="text-xs text-secondary">额度消耗顺序</span>
            <el-input-number
              :model-value="accountPriorityValue(acc)"
              :min="1"
              :max="99"
              size="small"
              controls-position="right"
              class="!w-24"
              :placeholder="'自动'"
              @change="(value) => handleSetPriority(acc, value)"
            />
            <span class="text-[11px] text-secondary">数字越小越先消耗这个号的额度；留空 = 自动（Pro 优先）</span>
          </div>

          <div class="mt-3 flex items-center justify-end gap-2 flex-wrap">
            <el-tag v-if="platform.provider === 'openai' && isCodexCurrent(acc)" type="success" size="small" effect="dark" class="shrink-0">
              Codex 当前登录
            </el-tag>
            <el-button
              v-else-if="platform.provider === 'openai'"
              size="small"
              type="warning"
              plain
              :loading="switchingId === acc.id"
              @click="handleSwitchCodex(acc)"
            >
              切换 Codex 到此账号
            </el-button>
            <el-button
              v-if="platform.provider === 'google'"
              size="small"
              type="primary"
              plain
              :loading="googleSetupLoading"
              @click="handleGoogleSetup"
            >
              一键接入路由通道
            </el-button>
            <el-button size="small" plain :loading="fetchingModelsId === acc.id" @click="handleFetchModels(acc, platform)">
              <el-icon class="mr-1"><Lightning /></el-icon>
              拉取上游可用模型
            </el-button>
            <el-button size="small" type="danger" plain @click="handleDelete(acc)">
              删除
            </el-button>
          </div>

          <!-- 拉取到的可用模型：显示名 + 可复制模型 ID + 逐模型真实测试 -->
          <div v-if="fetchedModels[acc.id]" class="mt-3 border-t border-muted pt-3">
            <div class="text-xs text-secondary mb-2">
              可用模型（{{ fetchedModels[acc.id].length }}）——「复制」拿模型 ID，填到任意 OpenAI 兼容客户端（Base URL 用路由地址）即可使用
            </div>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-1.5">
              <div
                v-for="m in fetchedModels[acc.id]"
                :key="m.name"
                class="account-model-row"
              >
                <span class="font-medium text-primary text-xs truncate min-w-0" :title="m.displayName || m.name">
                  {{ m.displayName || m.name }}
                </span>
                <el-tooltip :content="`模型 ID：${m.name}（点击复制）`" placement="top" :show-after="200">
                  <code class="account-model-id" @click="copyModelId(m.name)">{{ m.name }}</code>
                </el-tooltip>
                <el-tooltip content="复制模型 ID" placement="top" :show-after="200">
                  <el-button size="small" text class="!px-1 shrink-0" @click="copyModelId(m.name)">
                    <el-icon><DocumentCopy /></el-icon>
                  </el-button>
                </el-tooltip>
                <el-button
                  size="small"
                  text
                  type="primary"
                  class="model-test-btn shrink-0"
                  :loading="testingModels.has(`${acc.id}/${m.name}`)"
                  @click="handleTestModel(acc, m.name)"
                >
                  测试
                </el-button>
                <span
                  v-if="modelTestResults[`${acc.id}/${m.name}`]"
                  :class="modelTestResults[`${acc.id}/${m.name}`].ok ? 'text-success' : 'text-danger'"
                  class="text-xs min-w-0 truncate"
                  :title="modelTestResults[`${acc.id}/${m.name}`].note || modelTestResults[`${acc.id}/${m.name}`].error"
                >
                  {{ modelTestResults[`${acc.id}/${m.name}`].ok ? '✓' : '✗' }} {{ modelTestResults[`${acc.id}/${m.name}`].ok ? (modelTestResults[`${acc.id}/${m.name}`].latencyMs + 'ms') : (modelTestResults[`${acc.id}/${m.name}`].error || '').slice(0, 40) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty-hint">{{ platform.emptyHint }}</div>
    </el-card>
    </div>
    </AsyncContainer>

    <!-- 全自动 OAuth 登录弹窗组件 -->
    <OAuthDialog
      v-model="showOAuthModal"
      :provider="currentProvider"
      @success="loadAllAccounts"
    />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { listAccounts, deleteAccount, fetchAccountModels, testAccountModel, setupGoogleChannel, setAccountPriority, switchCodexAccount, getCodexAuthIdentity, getAccountQuota } from '../../api/accounts.js';
import { ElMessage, ElMessageBox } from 'element-plus';
import OAuthDialog from './components/OAuthDialog.vue';
import AsyncContainer from '../../components/AsyncContainer.vue';

const loading = ref(true);
const loadError = ref('');

const showOAuthModal = ref(false);
const currentProvider = ref('google');
const accounts = ref([]);
const fetchingModelsId = ref(null);
const fetchedModels = reactive({});
const fetchedModelSource = reactive({});

// 平台标识统一为字母徽标 + 品牌 Token 色（tokens.css --brand-*），替代旧版 emoji + 硬编码高饱和色
const platforms = [
  {
    provider: 'claude',
    icon: 'C',
    iconClass: 'bg-brand-claude/15 text-brand-claude',
    title: 'Claude (Anthropic) 订阅管理',
    subtitle: 'Claude Code 官方 OAuth 协议一键授权，自动发现组织与账号邮箱，Token 自动续期',
    actionLabel: '授权 Claude 账号',
    emptyHint: '暂未绑定 Claude 账号，点击右上角一键授权',
  },
  {
    provider: 'google',
    icon: 'G',
    iconClass: 'bg-brand-google/15 text-brand-google',
    title: 'Google (Gemini) 订阅管理',
    subtitle: 'Google 账号一键登录，自动识别订阅套餐（Pro/Ultra）与项目，登录状态自动续期',
    actionLabel: '登录 Google 账号 (一键授权)',
    emptyHint: '暂未绑定 Google 账号，点击右上角一键 OAuth 登录',
  },
  {
    provider: 'openai',
    icon: 'O',
    iconClass: 'bg-brand-openai/15 text-brand-openai',
    title: 'ChatGPT (OpenAI) 订阅授权',
    subtitle: '使用订阅账号的 Codex 额度池（/backend-api/codex/responses，与网页对话额度池相互独立），多账号自动轮换',
    actionLabel: '登录 ChatGPT 账号 (一键授权)',
    emptyHint: '暂未绑定 ChatGPT 账号，点击右上角一键授权',
  },
];

function openDialog(provider) {
  currentProvider.value = provider;
  showOAuthModal.value = true;
}

function getAccounts(provider) {
  return accounts.value.filter((a) => a.provider === provider);
}

function statusMeta(acc) {
  if (acc.status === 'cooldown') return { type: 'warning', label: 'Cooldown 429' };
  if (acc.status === 'expired') return { type: 'danger', label: 'Expired' };
  return { type: 'success', label: 'Active' };
}

// ---- 账号真实额度（ChatGPT=上游 rate_limits；谷歌=本地计数） ----
const quotaData = reactive({});
const quotaLoading = reactive({});
async function loadQuota(acc) {
  if (quotaLoading[acc.id]) return;
  quotaLoading[acc.id] = true;
  try {
    const res = await getAccountQuota(acc.id);
    quotaData[acc.id] = res || { ok: false, error: '无响应' };
  } catch (err) {
    quotaData[acc.id] = { ok: false, error: err.response?.data?.error?.message || err.message || '拉取失败' };
  } finally {
    quotaLoading[acc.id] = false;
  }
}
function quotaRowLabel(row) {
  if (!row) return '额度';
  const minutes = Number(row.windowMinutes) || 0;
  if (minutes >= 1000) return '周额度';
  if (minutes > 0) return `${minutes} 分钟窗口`;
  return '额度';
}
function quotaBarColor(percent) {
  if (percent == null) return '#909399';
  if (percent >= 90) return '#f56c6c';
  if (percent >= 70) return '#e6a23c';
  return '#67c23a';
}
function loadAllQuotasFor(provider) {
  for (const acc of accounts.value.filter((a) => a.provider === provider)) {
    loadQuota(acc);
  }
}

function formatQuotaReset(ts) {
  if (!ts) return '';
  return new Date(Number(ts)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

// 用账号凭据真实测试指定模型（sub2api 式：选模型 → 真实请求上游生成最小响应）
// 结果显示按「账号+模型」独立存 map，避免多账号并发测试互相覆盖。
const modelTestResults = reactive({});
// 每个「账号+模型」独立的进行中标记：支持并发测试各自转圈，不互相打断
const testingModels = reactive(new Set());

async function handleTestModel(acc, model) {
  const key = `${acc.id}/${model}`;
  testingModels.add(key);
  delete modelTestResults[key];
  try {
    const res = await testAccountModel(acc.provider, acc.id, model);
    modelTestResults[key] = res || { ok: false, error: '无响应', note: '' };
  } catch (err) {
    modelTestResults[key] = {
      ok: false,
      error: err.response?.data?.error?.message || err.message || '测试失败',
      note: '',
    };
  } finally {
    testingModels.delete(key);
  }
}

// 复制模型 ID（http 环境下 clipboard API 可能不可用，execCommand 兜底）
async function copyModelId(name) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(name);
    copied = true;
  } catch { /* 走 execCommand 兜底 */ }
  if (!copied) {
    try {
      const input = document.createElement('textarea');
      input.value = name;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      copied = document.execCommand('copy');
      document.body.removeChild(input);
    } catch { /* 复制失败提示 */ }
  }
  if (copied) ElMessage.success(`已复制模型 ID：${name}`);
  else ElMessage.warning(`复制失败，模型 ID：${name}`);
}

// 额度消耗顺序：显示账号显式优先级（未设置显示空 = 自动按套餐）
function accountPriorityValue(acc) {
  const raw = acc.metadata?.priority;
  const num = Number(raw);
  return (raw !== undefined && raw !== null && raw !== '' && Number.isFinite(num)) ? num : undefined;
}
const savingPriorityId = ref('');
async function handleSetPriority(acc, value) {
  const priority = (value === undefined || value === null) ? null : Number(value);
  savingPriorityId.value = acc.id;
  try {
    const res = await setAccountPriority(acc.id, priority);
    if (acc.metadata) acc.metadata.priority = priority === null ? undefined : priority;
    ElMessage.success(res.message || '已更新额度消耗顺序');
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    savingPriorityId.value = '';
  }
}

// ---- Codex 登录账号一键切换（ChatGPT 平台）----
const codexIdentity = ref({ loggedIn: false, email: '', chatgptAccountId: '' });
async function loadCodexIdentity() {
  try { codexIdentity.value = await getCodexAuthIdentity(); } catch { /* 静默：身份展示非关键 */ }
}
function isCodexCurrent(acc) {
  const bound = acc.metadata?.chatgptAccountId;
  return Boolean(codexIdentity.value.chatgptAccountId && bound && codexIdentity.value.chatgptAccountId === bound);
}
const switchingId = ref('');
async function handleSwitchCodex(acc) {
  try {
    await ElMessageBox.confirm(
      `将把 Codex 桌面端切换为 ${acc.email || acc.alias} 的登录态：自动退出当前登录并重启桌面端（原登录自动备份，切回只需再点一次）。继续？`,
      '切换 Codex 登录账号',
      { confirmButtonText: '切换并重启', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  switchingId.value = acc.id;
  try {
    const res = await switchCodexAccount(acc.id);
    ElMessage.success(res.message || '已切换并重启桌面端');
    await loadCodexIdentity();
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    switchingId.value = '';
  }
}

async function handleFetchModels(acc) {
  fetchingModelsId.value = acc.id;
  try {
    const res = await fetchAccountModels(acc.provider, acc.id);
    fetchedModels[acc.id] = res.models || [];
    fetchedModelSource[acc.id] = res.source || 'upstream';
    ElMessage.success(`已拉取 ${fetchedModels[acc.id].length} 个可用模型（${res.source === 'builtin' ? '内置清单' : '上游实时'}）`);
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    fetchingModelsId.value = null;
  }
}

// 谷歌订阅一键接入：拉取订阅模型 → 建 platform:'google' 专属通道 + 模型入桌面目录
const googleSetupLoading = ref(false);
async function handleGoogleSetup() {
  googleSetupLoading.value = true;
  try {
    const res = await setupGoogleChannel();
    ElMessage.success(res.message || `已接入谷歌订阅通道（新增 ${res.addedModels} 个模型）`);
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    googleSetupLoading.value = false;
  }
}

async function handleDelete(acc) {
  try {
    await ElMessageBox.confirm(`确定删除账号「${acc.alias}」吗？该操作不可恢复。`, '删除账号', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch { return; }
  try {
    await deleteAccount(acc.id);
    delete fetchedModels[acc.id];
    ElMessage.success('账号已删除');
    await loadAllAccounts();
  } catch { /* 错误提示由请求拦截器统一处理 */ }
}

async function loadAllAccounts() {
  loading.value = true;
  loadError.value = '';
  try {
    // 错误态由 AsyncContainer 呈现，跳过全局 toast
    const res = await listAccounts({ skipGlobalError: true });
    accounts.value = res.accounts || [];
  } catch (err) {
    loadError.value = err.response?.data?.error?.message || err.message || '请求失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadAllAccounts();
  loadCodexIdentity();
  // ChatGPT 账号自动拉取一次真实额度（谷歌等点击刷新即可）
  setTimeout(() => loadAllQuotasFor('openai'), 800);
});
</script>

<style scoped>
/* 卡片配色由 main.css 的 EP 变量统一接管；账号条目底色引用 Token */
.platform-card :deep(.el-card__header) {
  padding: 1rem 1.25rem;
}
.platform-card :deep(.el-card__body) {
  padding: 1.25rem;
}
/* 平台字母徽标：统一尺寸/圆角/字重，颜色来自 brand Token 类 */
.platform-badge {
  width: 2.25rem;
  height: 2.25rem;
  flex-shrink: 0;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.account-item {
  padding: 1rem 1.25rem;
  background-color: rgb(var(--bg-surface-2-rgb) / 0.55);
  border: 1px solid var(--border-muted);
  border-radius: 10px;
  transition: border-color 0.2s ease;
}
.account-item:hover {
  border-color: var(--border-strong);
}
/* 额度双进度条行 */
.quota-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.375rem;
}
.quota-label {
  font-size: 0.72rem;
  color: var(--text-secondary);
  width: 4.25rem;
  flex-shrink: 0;
}
.quota-value {
  font-size: 0.72rem;
  color: var(--text-primary);
  white-space: nowrap;
}
/* 空状态：虚线框引导，替代裸文字 */
.empty-hint {
  padding: 1.5rem;
  border: 1px dashed var(--border-default);
  border-radius: 10px;
  text-align: center;
  font-size: 0.8rem;
  color: var(--text-secondary);
}
/* 可用模型清单行：显示名 + 可复制模型 ID + 测试（Antigravity Tools 式） */
.account-model-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  min-width: 0;
  transition: border-color 0.15s, background-color 0.15s;
}
.account-model-row:hover {
  border-color: var(--el-color-primary);
  background: var(--surface-2, rgba(127, 127, 127, 0.05));
}
.account-model-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.68rem;
  color: var(--text-secondary);
  cursor: copy;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1 1 auto;
}
.account-model-id:hover {
  color: var(--el-color-primary);
}

@media (max-width: 767.98px) {
  .platform-card :deep(.el-card__header),
  .platform-card :deep(.el-card__body) {
    padding: 0.875rem 1rem;
  }
  .account-item {
    padding: 0.875rem 1rem;
  }
}
</style>
