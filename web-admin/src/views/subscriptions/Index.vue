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

          <!-- 周额度（本地真实统计：上游未提供公开剩余额度接口，官方 2026 起按周计） -->
          <div class="mt-3">
            <div class="flex items-center justify-between text-xs text-secondary mb-1.5">
              <span>本周已用（本地统计 · 7 天滚动窗口）</span>
              <span class="font-mono">{{ acc.quota?.used || 0 }} 次请求<template v-if="acc.quota?.resetsAt > 0"> · {{ formatQuotaReset(acc.quota.resetsAt) }} 重置</template></span>
            </div>
            <div class="text-[11px] text-secondary mt-1 leading-relaxed">
              <template v-if="acc.status === 'cooldown'">
                <span class="font-semibold text-danger">额度受限：于 {{ formatQuotaReset(acc.cooldownUntil) }} 恢复</span>
                <template v-if="acc.metadata?.lastCooldownReason">（{{ acc.metadata.lastCooldownReason }}）</template>
              </template>
              <template v-else>正常使用中</template>
              <div class="mt-0.5">{{ quotaNote(acc) }}</div>
            </div>
          </div>

          <div class="mt-3 flex items-center justify-end gap-2 flex-wrap">
            <el-button size="small" plain :loading="fetchingModelsId === acc.id" @click="handleFetchModels(acc, platform)">
              <el-icon class="mr-1"><Lightning /></el-icon>
              拉取上游可用模型
            </el-button>
            <el-button size="small" type="danger" plain @click="handleDelete(acc)">
              删除
            </el-button>
          </div>

          <!-- 拉取到的可用模型 -->
          <div v-if="fetchedModels[acc.id]" class="mt-3 border-t border-muted pt-3">
            <div class="text-xs text-secondary mb-2">
              可用模型（Codex 额度池，与网页对话额度池相互独立）({{ fetchedModels[acc.id].length }})
            </div>
            <div class="flex flex-wrap gap-2 items-center">
              <span
                v-for="m in fetchedModels[acc.id]"
                :key="m.name"
                class="inline-flex items-center gap-1"
              >
                <el-tag
                  size="small"
                  effect="plain"
                  :type="m.capabilities?.includes('thinking') ? 'warning' : 'info'"
                >
                  {{ m.name }}
                </el-tag>
                <el-button
                  size="small"
                  text
                  type="primary"
                  class="model-test-btn"
                  :loading="testingModels.has(`${acc.id}/${m.name}`)"
                  @click="handleTestModel(acc, m.name)"
                >
                  测试
                </el-button>
                <span
                  v-if="modelTestResults[`${acc.id}/${m.name}`]"
                  :class="modelTestResults[`${acc.id}/${m.name}`].ok ? 'text-success' : 'text-danger'"
                  class="text-xs"
                >
                  {{ modelTestResults[`${acc.id}/${m.name}`].note || modelTestResults[`${acc.id}/${m.name}`].error }}
                </span>
              </span>
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
import { listAccounts, deleteAccount, fetchAccountModels } from '../../api/accounts.js';
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

// 额度数据来源说明：上游（ChatGPT/Claude/Google 订阅）均未提供公开额度接口，
// 展示的是路由真实统计的本地请求次数，非占位假数据
function quotaNote(acc) {
  if (acc.provider === 'openai') {
    return `本地真实计数：路由经此账号走 Codex 额度池转发请求的次数（周额度窗口）；上游未提供公开额度接口，无法显示剩余百分比`;
  }
  return `本地统计：此订阅无路由转发路径（走 auth.json 登录态），暂无使用计数；上游未提供公开额度接口`;
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
/* 空状态：虚线框引导，替代裸文字 */
.empty-hint {
  padding: 1.5rem;
  border: 1px dashed var(--border-default);
  border-radius: 10px;
  text-align: center;
  font-size: 0.8rem;
  color: var(--text-secondary);
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
