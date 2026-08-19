<template>
  <!--
    响应式骨架（P1-2）：
    - ≥1280px：240px 完整侧栏
    - 768–1280px：自动折叠为 64px 图标栏
    - <768px：侧栏抽屉化（el-drawer）+ 顶栏汉堡按钮
  -->
  <div class="app-shell bg-canvas">
    <!-- 桌面/平板：常驻侧栏（含折叠态） -->
    <Sidebar v-if="!isMobile" :collapsed="isCompact" />

    <!-- 移动端：抽屉侧栏 -->
    <el-drawer
      v-else
      :model-value="drawerOpen"
      direction="ltr"
      :size="240"
      :with-header="false"
      :append-to-body="true"
      @update:model-value="drawerOpen = $event"
      @close="drawerOpen = false"
    >
      <Sidebar :collapsed="false" @navigate="drawerOpen = false" />
    </el-drawer>

    <el-container direction="vertical" class="flex-1 min-w-0 h-full">
      <Topbar :is-mobile="isMobile" @open-drawer="drawerOpen = true" />
      <el-main class="main-area bg-canvas">
        <!-- 超宽屏限宽容器：内容居中，避免信息被拉散 -->
        <div class="content-wrap">
          <router-view v-slot="{ Component }">
            <transition name="page-fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </div>
      </el-main>
    </el-container>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import Sidebar from './Sidebar.vue';
import Topbar from './Topbar.vue';
import { useBreakpoint } from '../composables/useBreakpoint.js';

const { isMobile, isCompact } = useBreakpoint();
const drawerOpen = ref(false);
</script>

<style scoped>
/* 100dvh：移动端浏览器地址栏收展时不产生底部白边；flex 布局让主区独立滚动 */
.app-shell {
  display: flex;
  width: 100vw;
  height: 100dvh;
  overflow: hidden;
}
.main-area {
  flex: 1;
  overflow-y: auto;
  padding: 2rem;
}
.content-wrap {
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
}
@media (max-width: 767.98px) {
  .main-area {
    padding: 1rem;
  }
}
/* 页面切换：轻量淡入上移，避免生硬跳变 */
.page-fade-enter-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.page-fade-leave-active {
  transition: opacity 0.12s ease;
}
.page-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.page-fade-leave-to {
  opacity: 0;
}
</style>
