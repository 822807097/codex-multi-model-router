<template>
  <!--
    统一异步状态容器：loading > error > empty > 默认插槽。
    数据区域统一接入，替代各视图手写 v-if="loading" 与裸 v-else。
  -->
  <div v-if="loading" class="async-block" :style="{ minHeight: blockMinHeight }">
    <el-skeleton :rows="skeletonRows" animated class="w-full" />
  </div>

  <div v-else-if="error" class="async-block async-error" :style="{ minHeight: blockMinHeight }">
    <el-icon :size="28" class="text-warning-text mb-2"><WarningFilled /></el-icon>
    <div class="text-sm text-regular">{{ errorText || '数据加载失败' }}</div>
    <div v-if="errorDetail" class="text-xs text-secondary mt-1 max-w-md break-all">{{ errorDetail }}</div>
    <el-button size="small" type="primary" plain class="mt-4" @click="$emit('retry')">
      <el-icon class="mr-1"><RefreshRight /></el-icon>
      重试
    </el-button>
  </div>

  <div v-else-if="empty" class="async-block" :style="{ minHeight: blockMinHeight }">
    <el-empty :description="emptyText || '暂无数据'" :image-size="72" />
    <slot name="empty-action" />
  </div>

  <slot v-else />
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  loading: { type: Boolean, default: false },
  error: { type: Boolean, default: false },
  empty: { type: Boolean, default: false },
  errorText: { type: String, default: '' },
  errorDetail: { type: String, default: '' },
  emptyText: { type: String, default: '' },
  minHeight: { type: [Number, String], default: 200 },
  skeletonRows: { type: Number, default: 4 },
});

defineEmits(['retry']);

const blockMinHeight = computed(() => (typeof props.minHeight === 'number' ? `${props.minHeight}px` : props.minHeight));
</script>

<style scoped>
.async-block {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  box-sizing: border-box;
}
.async-error {
  border: 1px dashed var(--border-default);
  border-radius: 12px;
}
</style>
