<template>
  <el-header class="topbar bg-surface border-b border-default flex items-center justify-between px-4 md:px-8 gap-3">
    <div class="flex items-center gap-2 min-w-0">
      <!-- 移动端汉堡按钮（打开侧栏抽屉） -->
      <el-button
        v-if="isMobile"
        class="hamburger shrink-0"
        text
        aria-label="打开导航菜单"
        title="打开导航菜单"
        @click="emit('open-drawer')"
      >
        <el-icon :size="20"><Expand /></el-icon>
      </el-button>
      <span class="text-base font-semibold text-primary truncate">{{ currentRouteTitle }}</span>
    </div>

    <div class="flex items-center gap-2 md:gap-3 shrink-0 flex-wrap justify-end">
      <!-- 网关离线横幅（重启窗口/进程退出时由请求拦截器置位） -->
      <transition name="offline-fade">
        <div v-if="appStore.gatewayOffline" class="offline-banner" role="alert">
          <el-icon class="animate-pulse"><Loading /></el-icon>
          <span>网关重连中…</span>
        </div>
      </transition>

      <el-button
        plain
        size="small"
        :loading="testingAll"
        aria-label="测试所有模型连接"
        title="测试所有模型连接"
        @click="emitTestAll"
      >
        <el-icon class="mr-1"><Lightning /></el-icon>
        <span class="hidden sm:inline">测试所有模型连接</span><span class="sm:hidden">测速</span>
      </el-button>

      <el-button
        type="primary"
        size="small"
        :loading="appStore.restarting"
        aria-label="优雅重启服务"
        title="优雅重启服务"
        @click="appStore.restartService()"
      >
        <el-icon class="sm:mr-1"><Refresh /></el-icon>
        <span class="hidden sm:inline">{{ appStore.restarting ? `重启中 (${appStore.restartTimeLeft}s)...` : '优雅重启服务' }}</span>
      </el-button>
    </div>
  </el-header>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '../stores/app.js';

defineProps({
  isMobile: { type: Boolean, default: false },
});

const emit = defineEmits(['open-drawer']);

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const testingAll = ref(false);

const currentRouteTitle = computed(() => {
  return route.meta?.title || '管理控制台';
});

function emitTestAll() {
  // 测速事件只在模型页监听；从其他页面点击时先跳转再派发，
  // 避免按钮「点了没反应」——loading 状态由事件往返控制。
  const isModelsPage = route.path.includes('/models');
  if (!isModelsPage) {
    router.push('/models');
  }
  testingAll.value = true;
  window.dispatchEvent(new CustomEvent('test-all-models'));
}

// 模型页开始/结束测速时同步顶栏 loading（模型页卸载时自动复位）
const onTestAllDone = () => { testingAll.value = false; };
onMounted(() => {
  window.addEventListener('test-all-models-done', onTestAllDone);
});
onUnmounted(() => {
  window.removeEventListener('test-all-models-done', onTestAllDone);
});
</script>

<style scoped>
/*
 * 顶栏高度 64px；窄窗口下允许按钮换行增高（min-height 兜底），
 * 避免固定 h-16 把第二行按钮裁掉（用户截图实锤的缺陷）。
 */
.topbar {
  height: auto;
  min-height: 64px;
  padding-top: 8px;
  padding-bottom: 8px;
  flex-wrap: wrap;
  row-gap: 8px;
}
.hamburger {
  color: var(--text-secondary);
}
.offline-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--warning-text);
  background-color: rgb(var(--warning-text-rgb, 210 153 34) / 0.12);
  border: 1px solid rgb(var(--warning-text-rgb, 210 153 34) / 0.4);
}
.offline-fade-enter-active,
.offline-fade-leave-active {
  transition: opacity 0.25s ease;
}
.offline-fade-enter-from,
.offline-fade-leave-to {
  opacity: 0;
}
</style>
