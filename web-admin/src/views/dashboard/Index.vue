<template>
  <div class="space-y-6">
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
import { getDashboardStats } from '../../api/dashboard.js';
import AsyncContainer from '../../components/AsyncContainer.vue';
import { useECharts, cssVar, chartColorByIndex } from '../../composables/useECharts.js';

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
    await nextTick();
    renderStackedChart();
  } catch (err) {
    loadError.value = err.response?.data?.error?.message || err.message || '请求失败';
  } finally {
    loading.value = false;
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
});
</script>

<style scoped>
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
