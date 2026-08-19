<template>
  <!--
    侧栏：collapsed=true 时折叠为 64px 图标栏（<1280px 自动），
    菜单项用 el-tooltip 兜底文字提示；品牌区只保留 ⚡ 图标。
  -->
  <el-aside
    :width="collapsed ? '64px' : '240px'"
    class="sidebar-root bg-surface border-r border-default flex flex-col justify-between"
  >
    <div class="min-w-0">
      <!-- 品牌 Header -->
      <div
        class="h-16 flex items-center border-b border-default gap-3"
        :class="collapsed ? 'justify-center px-2' : 'px-6'"
      >
        <div class="w-8 h-8 shrink-0 rounded-lg bg-accent flex items-center justify-center text-white font-bold shadow-md shadow-accent/25">
          ⚡
        </div>
        <div v-if="!collapsed" class="min-w-0">
          <div class="font-bold text-primary tracking-wide text-sm truncate">Codex Router</div>
          <div class="text-2xs text-secondary">v2.5.0 Pro · 多模型调度</div>
        </div>
      </div>

      <!-- 导航菜单 -->
      <el-menu
        :default-active="$route.path"
        router
        class="border-none bg-transparent mt-3 custom-menu"
        :class="collapsed ? 'px-1.5' : 'px-2'"
        @select="emitNavigate"
      >
        <template v-for="group in menuGroups" :key="group.title">
          <div
            v-if="!collapsed"
            class="px-4 py-2 text-2xs font-semibold text-secondary uppercase tracking-wider"
            :class="{ 'mt-3': !group.first }"
          >
            {{ group.title }}
          </div>
          <div v-else class="menu-group-spacer" :class="{ 'menu-group-spacer-first': group.first }"></div>

          <el-tooltip
            v-for="item in group.items"
            :key="item.index"
            :content="item.label"
            placement="right"
            :disabled="!collapsed"
          >
            <el-menu-item :index="item.index" class="menu-item-custom" :class="{ 'collapsed-item': collapsed }">
              <el-icon><component :is="item.icon" /></el-icon>
              <span v-if="!collapsed">{{ item.label }}</span>
            </el-menu-item>
          </el-tooltip>
        </template>
      </el-menu>
    </div>

    <!-- 底部服务状态指示 -->
    <div class="border-t border-default bg-canvas/50" :class="collapsed ? 'p-2' : 'p-4'">
      <el-tooltip content="路由服务正在运行 (15730)" placement="top" :disabled="!collapsed">
        <div
          class="flex items-center gap-2 text-xs text-secondary"
          :class="collapsed ? 'justify-center' : ''"
        >
          <span class="w-2 h-2 shrink-0 rounded-full bg-success-text animate-pulse"></span>
          <span v-if="!collapsed">路由服务正在运行 (15730)</span>
        </div>
      </el-tooltip>
    </div>
  </el-aside>
</template>

<script setup>
import { DataAnalysis, FolderOpened, Key, Setting, Lock } from '@element-plus/icons-vue';

defineProps({
  collapsed: { type: Boolean, default: false },
});

const emit = defineEmits(['navigate']);

const menuGroups = [
  {
    title: '数据与统计',
    first: true,
    items: [{ index: '/dashboard', label: '使用统计', icon: DataAnalysis }],
  },
  {
    title: '模型与分组管理',
    items: [{ index: '/models', label: '分组自定义模型', icon: FolderOpened }],
  },
  {
    title: '平台会员订阅授权',
    items: [
      { index: '/subscriptions', label: '平台订阅管理', icon: Key },
      { index: '/keys', label: 'API 密钥管理', icon: Lock },
    ],
  },
  {
    title: '系统管理',
    items: [{ index: '/settings', label: '系统与路由配置', icon: Setting }],
  },
];

function emitNavigate() {
  emit('navigate');
}
</script>

<style scoped>
.sidebar-root {
  transition: width 0.2s ease;
  overflow-x: hidden;
}
/* 菜单项配色引用 Token；特异性已高于 EP 默认规则，无需 !important */
.custom-menu :deep(.el-menu-item) {
  border-radius: 8px;
  margin-bottom: 4px;
  height: 44px;
  color: var(--text-secondary);
}
.custom-menu :deep(.el-menu-item:hover) {
  background-color: rgb(var(--text-primary-rgb) / 0.05);
  color: var(--text-primary);
}
.custom-menu :deep(.el-menu-item.is-active) {
  /* 淡化底色 + 左侧指示条，替代整块刺眼亮蓝 */
  background-color: rgb(var(--accent-primary-rgb) / 0.14);
  color: var(--info-text);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--accent-hover);
}
/* 折叠态：图标居中，隐藏 el-menu-item 的内边距文字位 */
.collapsed-item {
  justify-content: center;
  padding: 0 !important;
}
.menu-group-spacer {
  height: 20px;
}
.menu-group-spacer-first {
  height: 8px;
}
</style>
