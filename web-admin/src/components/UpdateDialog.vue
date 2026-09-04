<template>
  <!--
    版本更新弹窗（全局复用）：检查更新结果展示 + 一键更新。
    用法：<UpdateDialog v-model="show" :info="updateInfo" :done="updateDone"
            :applying="updateApplying" @apply="emit('apply')" @close="emit('close')" />
  -->
  <el-dialog
    :model-value="modelValue"
    title="软件更新"
    width="520px"
    class="custom-dialog-pro"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template v-if="done">
      <el-result icon="success" title="更新完成" sub-title="服务正在优雅重启，约 3 秒后刷新页面即可使用新版本">
        <template #extra>
          <el-button type="primary" @click="emit('reload')">刷新页面</el-button>
        </template>
      </el-result>
    </template>
    <template v-else>
      <div class="space-y-3">
        <div class="flex items-center justify-between text-sm">
          <span class="text-secondary">当前版本</span>
          <span class="font-mono">v{{ info?.current || '…' }}</span>
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-secondary">最新版本</span>
          <span class="font-mono font-semibold">{{ info?.latest || '—' }}</span>
        </div>
        <el-alert
          v-if="info && !info.hasUpdate"
          type="success"
          :closable="false"
          title="已是最新版本"
        />
        <div v-if="info?.notes" class="text-xs text-secondary whitespace-pre-wrap border-t border-muted pt-2 max-h-56 overflow-auto">{{ info.notes }}</div>
      </div>
    </template>
    <template #footer>
      <el-button @click="emit('skip')">暂不更新</el-button>
      <el-button
        v-if="info?.hasUpdate && !done"
        type="primary"
        :loading="applying"
        @click="emit('apply')"
      >一键更新</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
defineProps({
  modelValue: { type: Boolean, default: false },
  // checkForUpdate 的返回体：{ current, latest, hasUpdate, notes, htmlUrl }
  info: { type: Object, default: null },
  applying: { type: Boolean, default: false },
  done: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'apply', 'skip', 'reload']);
</script>
