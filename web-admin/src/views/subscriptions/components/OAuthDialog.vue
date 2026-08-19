<template>
  <el-dialog
    :model-value="modelValue"
    @update:model-value="handleClose"
    :title="dialogTitle"
    width="540px"
    class="custom-dialog-pro"
    :close-on-click-modal="false"
  >
    <!-- 顶部 2 模式切换 Tab -->
    <div class="flex justify-center mb-6">
      <el-radio-group v-model="activeMode" size="default" class="segmented-control">
        <el-radio-button label="oauth">{{ isClaude ? '授权链接 + Code' : 'OAuth 一键授权' }}</el-radio-button>
        <el-radio-button label="token">手动 Token</el-radio-button>
      </el-radio-group>
    </div>

    <!-- 模式 1: OAuth 授权向导 -->
    <div v-if="activeMode === 'oauth'" class="space-y-5">
      <!-- 推荐方式卡片 -->
      <div class="flex flex-col items-center py-2 text-center">
        <div class="w-14 h-14 rounded-full bg-accent/10 text-info-text flex items-center justify-center text-2xl mb-3 border border-accent/20">
          {{ isClaude ? '🔗' : '🌐' }}
        </div>
        <div class="font-bold text-primary text-base mb-1">{{ isClaude ? '半自动授权（官方要求）' : '推荐方式（全自动）' }}</div>
        <div class="text-xs text-secondary max-w-sm leading-relaxed">
          {{ isClaude
            ? 'Anthropic 不允许本地回调地址：点击开始生成授权链接，在浏览器完成授权后复制页面展示的一次性 Code 粘贴到下方。'
            : '点击开始后将自动打开默认浏览器完成 Google / ChatGPT 登录，授权结果自动回传绑定，无需手动操作。' }}
        </div>
      </div>

      <!-- 开始 OAuth 授权大按钮 -->
      <el-button
        type="primary"
        size="large"
        class="w-full h-11 text-sm font-semibold tracking-wide shadow-lg shadow-accent/20"
        :loading="authorizing"
        @click="handleStartOAuth"
      >
        <el-icon v-if="!authorizing" class="mr-1.5"><Lightning /></el-icon>
        {{ authorizing ? '正在等待授权...' : (isClaude ? '生成授权链接' : '开始 OAuth 授权') }}
      </el-button>

      <!-- 授权链接（手动打开兜底 / Claude 主路径） -->
      <div v-if="authUrlDisplay" class="text-left space-y-1.5 pt-1">
        <div class="text-xs text-secondary font-medium">授权链接{{ isClaude ? '（在浏览器打开并完成授权）' : '（浏览器没有自动打开时手动点击）' }}:</div>
        <div class="flex gap-2">
          <el-input
            v-model="authUrlDisplay"
            readonly
            size="default"
            class="font-mono text-xs"
          />
          <el-button size="default" @click="copyAuthUrl">
            <el-icon class="mr-1"><CopyDocument /></el-icon>
            复制
          </el-button>
          <el-button size="default" type="primary" plain @click="openAuthUrlInNewTab">
            打开
          </el-button>
        </div>
      </div>

      <!-- loopback 模式：等待回传状态提示 -->
      <div v-if="!isClaude && authorizing" class="text-center text-xs text-secondary">
        正在监听本地回调（端口 {{ loopbackPort || '…' }}），完成浏览器授权后本弹窗将自动关闭。
      </div>

      <!-- Claude 模式：粘贴一次性 Code -->
      <div v-if="isClaude && authUrlDisplay" class="border-t border-default pt-4 text-left space-y-2">
        <div class="text-2xs text-secondary">
          授权完成后浏览器会展示一串一次性 Authorization Code，粘贴到此处提交：
        </div>
        <div class="flex gap-2">
          <el-input
            v-model="manualCodeOrUrl"
            size="default"
            placeholder="粘贴 Code 或完整回调链接..."
            class="text-xs"
            @keyup.enter="submitManualCode"
          />
          <el-button type="primary" size="default" :loading="exchanging" @click="submitManualCode">
            <el-icon class="mr-1"><Link /></el-icon>
            提交绑定
          </el-button>
        </div>
      </div>

      <!-- loopback 模式兜底：粘贴回调链接/Code -->
      <div v-if="!isClaude && authUrlDisplay" class="border-t border-default pt-4 text-left space-y-2">
        <div class="text-2xs text-secondary">
          {{ isProvider('openai')
            ? '若浏览器显示「无法访问 localhost:1455」属正常（回调端口被占用时会降级手动）：请复制浏览器地址栏的完整回调链接粘贴到下方提交。'
            : '浏览器授权后长时间无响应？可粘贴回调地址栏的完整链接或 Code 手动完成：' }}
        </div>
        <div class="flex gap-2">
          <el-input
            v-model="manualCodeOrUrl"
            size="default"
            placeholder="粘贴回调链接或 Code..."
            class="text-xs"
            @keyup.enter="submitManualCode"
          />
          <el-button type="info" size="default" :loading="exchanging" @click="submitManualCode">
            <el-icon class="mr-1"><Link /></el-icon>
            提交
          </el-button>
        </div>
      </div>
    </div>

    <!-- 模式 2: 手动输入 Token / Key 模式 -->
    <div v-else class="space-y-4 text-left">
      <el-form :model="form" label-position="top">
        <el-form-item label="账号别名 (Alias)">
          <el-input v-model="form.alias" placeholder="例如: 我的主力账号" />
        </el-form-item>
        <el-form-item label="关联邮箱 (可选)">
          <el-input v-model="form.email" placeholder="user@example.com" />
        </el-form-item>
        <el-form-item :label="credentialLabel">
          <el-input
            v-model="form.token"
            type="textarea"
            :rows="3"
            :placeholder="credentialPlaceholder"
          />
        </el-form-item>
        <el-form-item label="网络代理（可选）">
          <ProxyConfigEditor v-model="form.proxy" :allow-global="false" class="w-full" />
          <div class="text-xs text-secondary mt-1">国内网络访问 Google / ChatGPT 通常需要代理；直连能连通就不填</div>
        </el-form-item>
      </el-form>
      <el-button type="primary" class="w-full" @click="submitManualAccount">
        确认绑定
      </el-button>
    </div>

    <template #footer>
      <el-button @click="handleClose(false)">取消</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue';
import { startOAuth, pollOAuthStatus, exchangeOAuthCode, addAccount } from '../../../api/accounts.js';
import { ElMessage } from 'element-plus';
import { useBreakpoint } from '../../../composables/useBreakpoint.js';
import ProxyConfigEditor from '../../../components/ProxyConfigEditor.vue';

const { isMobile } = useBreakpoint();

const props = defineProps({
  modelValue: Boolean,
  provider: { type: String, default: 'google' },
});

const emit = defineEmits(['update:modelValue', 'success']);

const activeMode = ref('oauth');
const authorizing = ref(false);
const exchanging = ref(false);
const authUrlDisplay = ref('');
const sessionState = ref('');
const loopbackPort = ref(null);
const manualCodeOrUrl = ref('');
let pollTimer = null;

const form = ref({
  alias: '',
  email: '',
  token: '',
  proxy: { mode: 'custom', url: 'http://127.0.0.1:10808' },
});

const isClaude = computed(() => props.provider === 'claude');
const isProvider = (name) => props.provider === name;

const dialogTitle = computed(() => {
  const titles = {
    google: '添加 Google 账号 (一键授权)',
    claude: '添加 Claude 账号 (OAuth 授权)',
    openai: '添加 ChatGPT 账号 (一键授权)',
  };
  return titles[props.provider] || '添加新账号';
});

const credentialLabel = computed(() => {
  if (props.provider === 'claude') return 'OAuth Refresh Token';
  if (props.provider === 'openai') return 'OAuth Refresh Token';
  return 'Refresh Token';
});

const credentialPlaceholder = computed(() => '粘贴 OAuth Refresh Token（授权模式下会自动获取，此处用于手动导入）...');

function resetFlowState() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  authorizing.value = false;
  authUrlDisplay.value = '';
  sessionState.value = '';
  loopbackPort.value = null;
  manualCodeOrUrl.value = '';
}

function handleClose(visible) {
  if (!visible) resetFlowState();
  emit('update:modelValue', visible);
}

async function handleStartOAuth() {
  if (authorizing.value) return;
  authorizing.value = true;
  try {
    const res = await startOAuth(props.provider);
    authUrlDisplay.value = res.authUrl || '';
    sessionState.value = res.state || '';
    if (res.redirectUri) {
      const portMatch = String(res.redirectUri).match(/:(\d+)/);
      loopbackPort.value = portMatch ? portMatch[1] : null;
    }
    if (res.mode === 'manual') {
      // Claude：链接 + 手动粘贴 Code，无需轮询
      authorizing.value = false;
      return;
    }
    // loopback 模式：后端已拉起浏览器，轮询状态直到 complete/error
    startPolling();
  } catch (err) {
    authorizing.value = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await pollOAuthStatus(props.provider);
      if (res.complete && res.account) {
        finishSuccess(res.account);
      } else if (res.error) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        authorizing.value = false;
        ElMessage.error(res.error.message || '授权失败，请重试');
      }
    } catch {
      /* 404 会话不存在等场景静默重试 */
    }
  }, 1200);
}

function finishSuccess(account) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  authorizing.value = false;
  const label = account?.email ? `${account.email}` : '账号';
  const plan = account?.planType ? ` · ${account.planType}` : '';
  ElMessage.success(`🎉 授权绑定成功：${label}${plan}`);
  emit('update:modelValue', false);
  resetFlowState();
  emit('success');
}

async function submitManualCode() {
  if (!manualCodeOrUrl.value) {
    ElMessage.warning(isClaude.value ? '请粘贴授权后浏览器展示的 Code' : '请粘贴回调链接或 Authorization Code');
    return;
  }
  exchanging.value = true;
  try {
    const res = await exchangeOAuthCode(props.provider, manualCodeOrUrl.value, sessionState.value || undefined);
    if (res.complete && res.account) {
      finishSuccess(res.account);
    } else {
      ElMessage.error(res.error?.message || '提交失败，请重试');
    }
  } catch {
    /* 错误提示由请求拦截器统一处理 */
  } finally {
    exchanging.value = false;
  }
}

async function submitManualAccount() {
  if (!form.value.token) {
    ElMessage.warning('请输入凭据');
    return;
  }
  try {
    await addAccount({
      provider: props.provider,
      alias: form.value.alias || `${props.provider} 手动导入`,
      email: form.value.email || '',
      credentials: {
        refreshToken: form.value.token,
        accessToken: '',
      },
      proxy: {
        enabled: form.value.proxy.mode === 'custom' && Boolean(form.value.proxy.url?.trim()),
        url: form.value.proxy.url?.trim() || '',
      },
    });
    ElMessage.success('账号已绑定！');
    emit('update:modelValue', false);
    emit('success');
  } catch { /* 错误提示由请求拦截器统一处理 */ }
}

function copyAuthUrl() {
  if (!authUrlDisplay.value) return;
  const fallback = () => {
    // 非安全上下文（http 非 localhost）clipboard API 不可用 → 降级 execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = authUrlDisplay.value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      ElMessage.success('授权链接已复制到剪贴板（降级方式）');
    } catch {
      ElMessage.warning('复制失败，请手动全选复制');
    }
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(authUrlDisplay.value).then(
      () => ElMessage.success('授权链接已复制到剪贴板！'),
      () => fallback(),
    );
  } else {
    fallback();
  }
}

function openAuthUrlInNewTab() {
  if (!authUrlDisplay.value) return;
  window.open(authUrlDisplay.value, '_blank');
}

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
/* 选中态配色由 main.css 的 --el-radio-button-checked-* 变量接管，无需 !important */
:deep(.segmented-control .el-radio-button__inner) {
  background-color: var(--bg-surface-2);
  border-color: var(--border-default);
  color: var(--text-secondary);
}
</style>
