<template>
  <div class="space-y-6">
    <!-- 新手引导 · 三步接入（全部完成后或手动关闭即隐藏） -->
    <el-card v-if="onboardingVisible" shadow="never" class="onboarding-card">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div class="font-semibold text-primary text-sm">🚀 新手引导 · 三步接入</div>
        <el-button size="small" text @click="dismissOnboarding">不再显示</el-button>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div v-for="step in onboardSteps" :key="step.title" class="onboard-step">
          <div class="flex items-center gap-2 mb-1">
            <span :class="step.done ? 'text-success' : 'text-secondary'" class="font-semibold text-sm">
              {{ step.done ? '✓' : '○' }} {{ step.title }}
            </span>
          </div>
          <div class="text-xs text-secondary mb-2 leading-relaxed">{{ step.desc }}</div>
          <el-button v-if="!step.done" size="small" type="primary" plain @click="router.push(step.route)">{{ step.btn }}</el-button>
          <span v-else class="text-xs text-success">已完成</span>
        </div>
      </div>
      <div class="text-xs text-secondary mt-3 leading-relaxed">
        客户端接入：base_url 填 <code class="font-mono">http://127.0.0.1:15730/v1</code>，API Key 用第②步创建的
        <code class="font-mono">{{ onboarding.keyMasked || 'sk-router-…' }}</code>。curl / Python / Node 示例见下方「接入示例」。
      </div>
    </el-card>
    <!-- 头部时间范围切换 -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div class="text-xl font-bold text-primary tracking-wide">
        使用统计 <span class="text-xs font-normal text-secondary ml-2">应用用量</span>
      </div>
      <div class="flex items-center gap-3">
        <el-radio-group v-model="days" size="small" @change="loadStats">
          <el-radio-button :label="7">最近 7 天</el-radio-button>
          <el-radio-button :label="30">最近 30 天</el-radio-button>
        </el-radio-group>
        <el-button size="small" :loading="loading" aria-label="刷新统计数据" title="刷新统计数据" @click="loadStats">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </div>
    </div>

    <!-- 统一异步状态：加载骨架 / 错误重试 / 空数据引导 -->
    <AsyncContainer
      :loading="loading"
      :error="!!loadError"
      :empty="isEmpty"
      :error-detail="loadError"
      error-text="统计数据加载失败"
      empty-text="该时间范围内还没有任何调用记录"
      :min-height="320"
      :skeleton-rows="8"
      @retry="loadStats"
    >
      <!-- 6 卡核心指标矩阵：1 列(<768) / 2 列(768–1280) / 3 列(≥1280) -->
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <el-card v-for="card in statCards" :key="card.label" shadow="never" class="stat-card">
          <div class="flex items-center text-xs text-secondary gap-1 mb-2">
            <span>{{ card.icon }} {{ card.label }}</span>
          </div>
          <div :class="['font-bold text-primary tracking-tight truncate', card.big ? 'text-3xl' : 'text-xl']">
            {{ card.value }}
            <span v-if="card.suffix" :class="['ml-1', card.suffixClass]">{{ card.suffix }}</span>
          </div>
          <div v-if="card.hint" class="text-xs text-secondary mt-1">{{ card.hint }}</div>
        </el-card>
      </div>

      <!-- GitHub 风格活跃热力图 -->
      <el-card shadow="never" class="chart-card">
        <template #header>
          <div class="flex items-center justify-between text-sm font-semibold text-primary flex-wrap gap-2">
            <span>活跃热力图</span>
            <div class="flex items-center gap-1.5 text-xs text-secondary font-normal">
              <span>较少</span>
              <span class="w-2.5 h-2.5 rounded-sm bg-heat-0"></span>
              <span class="w-2.5 h-2.5 rounded-sm bg-heat-1"></span>
              <span class="w-2.5 h-2.5 rounded-sm bg-heat-2"></span>
              <span class="w-2.5 h-2.5 rounded-sm bg-heat-3"></span>
              <span class="w-2.5 h-2.5 rounded-sm bg-heat-4"></span>
              <span>较多</span>
            </div>
          </div>
        </template>
        <div class="overflow-x-auto py-2">
          <div class="flex gap-1.5">
            <div
              v-for="(col, colIdx) in heatmapColumns"
              :key="colIdx"
              class="flex flex-col gap-1.5"
            >
              <el-tooltip
                v-for="cell in col"
                :key="cell.date"
                :content="`${cell.date}: ${cell.rounds} 轮交互 · ${cell.tokensFormatted || cell.tokens} Tokens`"
                placement="top"
              >
                <div
                  class="heatmap-cell"
                  :class="`bg-heat-${cell.level || 0}`"
                ></div>
              </el-tooltip>
            </div>
          </div>
        </div>
      </el-card>

      <!-- 按天多模型堆叠柱状图 -->
      <el-card shadow="never" class="chart-card">
        <template #header>
          <div class="text-sm font-semibold text-primary">按天 Token 趋势 (多模型堆叠)</div>
        </template>
        <div ref="stackedChartRef" class="w-full h-72"></div>
      </el-card>

      <!-- 详细模型消耗表格 -->
      <el-card shadow="never" class="chart-card">
        <template #header>
          <div class="text-sm font-semibold text-primary">各模型详细消耗 Breakdown</div>
        </template>
        <div class="overflow-x-auto">
          <el-table :data="stats.breakdown || []" style="width: 100%" class="custom-table">
            <el-table-column prop="model" label="模型名称" min-width="180">
              <template #default="{ row }">
                <span class="font-mono font-semibold text-primary">{{ row.model }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="rounds" label="调用次数" width="100" />
            <el-table-column prop="inputTokens" label="输入 Tokens" width="120" />
            <el-table-column prop="outputTokens" label="输出 Tokens" width="120" />
            <el-table-column prop="reasoningTokens" label="思考过程 (Thinking)" width="160">
              <template #default="{ row }">
                <span class="text-chart-5 font-mono">{{ row.reasoningTokens || 0 }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="cachedTokens" label="缓存命中" width="120">
              <template #default="{ row }">
                <span class="text-success-text font-mono">{{ row.cachedTokens || 0 }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="totalTokens" label="总消耗" width="140">
              <template #default="{ row }">
                <span class="font-bold text-info-text">{{ row.totalTokensFormatted || row.totalTokens }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-card>
    </AsyncContainer>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { getDashboardStats } from '../../api/dashboard.js';
import { listKeys } from '../../api/keys.js';
import { listAccounts } from '../../api/accounts.js';
import { getModels } from '../../api/models.js';
import AsyncContainer from '../../components/AsyncContainer.vue';
import { useECharts, cssVar, chartColorByIndex } from '../../composables/useECharts.js';

// ---- 新手引导 · 三步接入（cc-switch 式 onboarding）----
const onboarding = ref({ models: 0, hasKey: false, keyMasked: '', accounts: 0 });
const onboardingDismissed = ref(false);
const onboardingVisible = computed(() => !onboardingDismissed.value && (
  onboarding.value.models === 0 || !onboarding.value.hasKey || onboarding.value.accounts === 0));
const onboardSteps = computed(() => {
  const o = onboarding.value;
  return [
    { done: o.models > 0, title: '① 添加模型', desc: '从厂商预设一键接入，或手动添加任意 OpenAI 兼容模型', route: '/models', btn: '去添加' },
    { done: o.hasKey, title: '② 创建 API 密钥', desc: '给你的客户端签发 sk-router- 密钥（Codex / Trae / 任意工具通用）', route: '/keys', btn: '去创建' },
    { done: o.accounts > 0, title: '③ 绑定订阅账号（可选）', desc: 'ChatGPT / 谷歌 AI 会员一键授权，用订阅额度跑订阅模型', route: '/subscriptions', btn: '去绑定' },
  ];
});
function dismissOnboarding() {
  onboardingDismissed.value = true;
  try { localStorage.setItem('onboarding-dismissed', '1'); } catch { /* 无痕模式忽略 */ }
}
async function loadOnboarding() {
  try {
    const [models, keys, accounts] = await Promise.all([
      getModels({ skipGlobalError: true }),
      listKeys({ skipGlobalError: true }),
      listAccounts({ skipGlobalError: true }).catch(() => ({ accounts: [] })),
    ]);
    onboarding.value = {
      models: Array.isArray(models?.data) ? models.data.length : (models?.models?.length || 0),
      hasKey: Boolean(keys?.authEnforced) || (Array.isArray(keys?.keys) && keys.keys.length > 0),
      keyMasked: (Array.isArray(keys?.keys) && keys.keys[0]) ? `${keys.keys[0].prefix || 'sk-router-'}…${keys.keys[0].suffix || ''}` : '',
      accounts: Array.isArray(accounts?.accounts) ? accounts.accounts.length : 0,
    };
  } catch { /* 引导卡片非关键，失败静默 */ }
}

const router = useRouter();
const days = ref(30);
const loading = ref(false);
const loadError = ref('');
const stats = ref({
  metrics: {},
  heatmap: [],
  stackedChart: { days: [], models: [], colors: {} },
  breakdown: [],
});

const stackedChartRef = ref(null);
const { setOption: setChartOption } = useECharts(stackedChartRef);

const heatmapColumns = computed(() => {
  const cells = stats.value.heatmap || [];
  const cols = [];
  for (let i = 0; i < cells.length; i += 7) {
    cols.push(cells.slice(i, i + 7));
  }
  return cols;
});

const isEmpty = computed(() => {
  const m = stats.value.metrics || {};
  return !Number(m.totalRounds) && !Number(m.totalTokens);
});

const statCards = computed(() => {
  const m = stats.value.metrics || {};
  return [
    { icon: '⚡', label: 'tokens 用量', value: m.totalTokensFormatted || '0', big: true },
    { icon: '💬', label: '会话数量（估算）', value: m.totalSessions || 0, big: true },
    { icon: '✉️', label: '调用次数', value: m.totalRounds || 0, big: true },
    { icon: '📅', label: '活跃天数', value: m.activeDays || 0, big: true },
    { icon: '📈', label: '当前连续天数', value: m.consecutiveDays || 0, big: true },
    {
      icon: '🏆',
      label: '最常用模型',
      value: m.topModel?.model || '暂无数据',
      big: false,
      suffix: m.topModel?.percent > 0 ? `${m.topModel.percent}%` : '',
      suffixClass: 'text-success-text text-base',
      hint: '主力模型分流调度',
    },
  ];
});

async function loadStats() {
  loading.value = true;
  loadError.value = '';
  try {
    // 错误态由 AsyncContainer 呈现，跳过全局 toast
    const res = await getDashboardStats(days.value, { skipGlobalError: true });
    stats.value = res;
  } catch (err) {
    loadError.value = err.response?.data?.error?.message || err.message || '请求失败';
  } finally {
    // 必须先翻 loading 让 AsyncContainer 卸下骨架、图表容器挂载，再等一帧渲染。
    // 之前在 loading 翻转前渲染——容器还在骨架里，ref 为 null 直接 return，趋势图永远空白。
    loading.value = false;
    await nextTick();
    renderStackedChart();
  }
}

function renderStackedChart() {
  if (!stackedChartRef.value) return;
  const { days: chartDays, models } = stats.value.stackedChart;
  const series = models.map((m, idx) => ({
    name: m,
    type: 'bar',
    stack: 'total',
    emphasis: { focus: 'series' },
    itemStyle: { color: chartColorByIndex(idx) },
    data: chartDays.map((d) => d.models[m] || 0),
  }));

  const option = {
    backgroundColor: 'transparent',
    color: models.map((_, idx) => chartColorByIndex(idx)),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: {
      bottom: 0,
      type: 'scroll',
      textStyle: { color: cssVar('--text-secondary') },
      inactiveColor: cssVar('--border-strong', '#636e7b'),
    },
    grid: { left: '3%', right: '4%', bottom: '15%', top: '10%', containLabel: true },
    xAxis: {
      type: 'category',
      data: chartDays.map((d) => d.date.slice(5)),
      axisLine: { lineStyle: { color: cssVar('--border-default') } },
      axisLabel: { color: cssVar('--text-secondary') },
    },
    yAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: cssVar('--border-default') } },
      splitLine: { lineStyle: { color: cssVar('--border-muted') } },
      axisLabel: { color: cssVar('--text-secondary') },
    },
    series,
  };

  setChartOption(option, { notMerge: true });
}

onMounted(() => {
  loadStats();
  // 新手引导：读 localStorage 折叠状态 + 三步完成度
  try { onboardingDismissed.value = localStorage.getItem('onboarding-dismissed') === '1'; } catch { /* 无痕模式忽略 */ }
  loadOnboarding();
});
</script>

<style scoped>
.onboarding-card {
  border-color: var(--el-color-primary-light-5);
  background: linear-gradient(135deg, rgba(64,158,255,0.04), transparent 60%);
}
.onboard-step {
  border: 1px solid var(--border-muted);
  border-radius: 10px;
  padding: 0.75rem 0.875rem;
}
/* 卡片底色/边框/表格配色已由 main.css 中的 EP 变量统一接管（引用 tokens.css），此处只保留布局差异 */
.stat-card {
  border-radius: 12px;
  min-height: 110px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
/* flex 居中作用于卡片根节点，body 需撑满宽度否则内容挤在左上角 */
.stat-card :deep(.el-card__body) {
  width: 100%;
}
.chart-card {
  border-radius: 12px;
  padding: 1.5rem;
  margin-top: 1.5rem;
}
.heatmap-cell {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  cursor: pointer;
  transition: transform 0.15s ease, filter 0.15s ease;
}
.heatmap-cell:hover {
  transform: scale(1.3);
  filter: brightness(1.2);
}
</style>
