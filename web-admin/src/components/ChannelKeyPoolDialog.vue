<template>
  <el-dialog
    :model-value="modelValue"
    :title="`🔑 通道密钥池${selectedTarget ? ` — ${selectedTarget}` : ''}`"
    :width="isMobile ? '94%' : '760px'"
    class="custom-dialog-pro"
    :close-on-click-modal="false"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @open="onOpen"
    @closed="resetState"
  >
    <!-- 通道选择（OAuth 官方登录态通道不显示：密钥池只服务 envKey/自定义通道） -->
    <div v-if="!fixedTarget" class="mb-3">
      <el-select
        v-model="selectedTarget"
        placeholder="选择目标通道"
        class="w-full"
        :loading="targetsLoading"
        @change="loadEntries"
      >
        <el-option
          v-for="t in poolTargets"
          :key="t.name"
          :value="t.name"
          :label="`${t.name} (${t.host})`"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="font-mono">{{ t.name }}</span>
            <span class="text-xs text-secondary">{{ t.host }}</span>
          </div>
        </el-option>
      </el-select>
      <div class="text-xs text-secondary mt-1">
        同一个平台开多个账号？把每把密钥都加进来：额度用尽自动切换下一把，不影响使用。
        优先级数字小的先用（0 最优先）；同优先级轮流使用
      </div>
    </div>

    <template v-if="selectedTarget">
      <!-- 生效来源提示 -->
      <el-alert
        :type="entries.length > 0 ? 'success' : 'info'"
        :closable="false"
        class="mb-3"
      >
        <template #title>
          当前生效来源：{{ entries.length > 0 ? `页面密钥池（${entries.length} 把）` : '环境变量兜底（config envKey）' }}
        </template>
        <template #default v-if="entries.length > 0">
          密钥池优先于 config 的 envKey；池全冷却时才回退环境变量
        </template>
      </el-alert>

      <!-- 池最早恢复时间汇总 -->
      <el-alert
        v-if="earliestRetryAt > Date.now()"
        type="warning"
        :closable="false"
        class="mb-3"
      >
        <template #title>
          池内全部 key 冷却中，最早恢复：{{ formatTime(earliestRetryAt) }}
        </template>
      </el-alert>

      <!-- key 列表 -->
      <el-table :data="entries" size="small" class="custom-table" empty-text="该通道暂无池 key，可在下方添加">
        <el-table-column label="账号 / 备注" min-width="120">
          <template #default="{ row }">
            <span class="font-medium text-primary">{{ row.label || '未命名' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="形态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.kind === 'env_ref' ? 'warning' : 'info'" size="small" effect="plain">
              {{ row.kind === 'env_ref' ? '环境变量' : '明文 Key' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Key" min-width="150">
          <template #default="{ row }">
            <span class="font-mono text-xs">
              {{ row.kind === 'env_ref' ? row.refName : row.maskedKey }}
            </span>
            <span v-if="row.kind === 'env_ref' && row.envResolved === false" class="text-xs text-danger ml-1">
              (变量未设置)
            </span>
          </template>
        </el-table-column>
        <el-table-column label="优先级" width="90">
          <template #default="{ row }">
            <el-input-number
              :model-value="row.priority"
              :min="0"
              :max="99"
              size="small"
              controls-position="right"
              class="w-full priority-input"
              @change="(v) => handlePriorityChange(row, v)"
            />
          </template>
        </el-table-column>
        <el-table-column label="最后使用" width="100">
          <template #default="{ row }">
            <span class="text-xs text-secondary">{{ formatLastUsed(row.lastUsedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="冷却状态" width="170">
          <template #default="{ row }">
            <el-tooltip
              v-if="row.cooldown.active"
              :content="row.cooldown.note || '额度冷却中'"
              placement="top"
            >
              <el-tag type="danger" size="small" effect="dark" class="cooldown-tag">
                ❄ {{ formatTime(row.cooldown.retryAt) }} 恢复
              </el-tag>
            </el-tooltip>
            <el-tag v-else type="success" size="small" effect="plain">正常</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" plain :loading="testingId === row.id" @click="handleTest(row)">
              测试
            </el-button>
            <el-button size="small" plain @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="handleRevoke(row)">吊销</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 新增 / 编辑表单 -->
      <div class="mt-4 border-t border-default pt-3">
        <div class="text-sm font-semibold text-primary mb-2">
          {{ editingId ? '编辑密钥条目' : '新增密钥' }}
        </div>
        <el-form :model="form" label-position="top" class="key-form">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-x-4">
            <el-form-item label="形态">
              <el-radio-group v-model="form.kind" @change="onKindChange">
                <el-radio value="plaintext">直接输入 Key</el-radio>
                <el-radio value="env_ref">环境变量引用</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="账号备注">
              <el-input v-model="form.label" placeholder="例如：账号2 / 同事的 key" maxlength="120" />
            </el-form-item>
          </div>
          <el-form-item :label="form.kind === 'env_ref' ? '环境变量名' : 'API Key'">
            <el-input
              v-model="form.key"
              :type="form.kind === 'plaintext' ? 'password' : 'text'"
              :show-password="form.kind === 'plaintext'"
              :placeholder="form.kind === 'env_ref' ? '例如 DEEPSEEK_API_KEY_2（注册表/进程环境）' : 'sk-...'"
              class="font-mono"
            />
            <div v-if="form.kind === 'env_ref'" class="text-xs mt-1">
              <span class="text-secondary">
                保存时后端会校验变量已设置（注册表/进程环境，改后无需重启路由）
              </span>
            </div>
            <div v-else-if="editingId" class="text-xs text-secondary mt-1">
              留空表示不修改原 Key；保存时覆写会清除冷却
            </div>
          </el-form-item>
          <div class="flex items-center gap-4 flex-wrap">
            <el-form-item label="优先级（小者先试）" class="mb-0">
              <el-input-number v-model="form.priority" :min="0" :max="99" controls-position="right" />
            </el-form-item>
            <el-checkbox v-if="!editingId" v-model="form.skipVerify">
              保存时跳过直连验证
            </el-checkbox>
          </div>
        </el-form>
        <div class="flex justify-end gap-2 mt-3">
          <el-button v-if="editingId" @click="cancelEdit">取消编辑</el-button>
          <el-button type="primary" :loading="saving" @click="handleSave">
            {{ editingId ? '保存修改' : '添加密钥' }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  listChannelKeys,
  createChannelKey,
  updateChannelKey,
  revokeChannelKey,
  testChannelKey,
} from '../api/channelKeys.js';
import { getSystemConfig } from '../api/system.js';
import { useBreakpoint } from '../composables/useBreakpoint.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 固定通道名（从模型页/设置页指定打开）；为空时弹窗内自选
  targetName: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'changed']);

const { isMobile } = useBreakpoint();
const fixedTarget = computed(() => props.targetName || '');
const selectedTarget = ref('');
const poolTargets = ref([]);
const targetsLoading = ref(false);
const entries = ref([]);
const loading = ref(false);
const testingId = ref(null);
const saving = ref(false);
const editingId = ref('');
const form = ref({ kind: 'plaintext', label: '', key: '', priority: 0, skipVerify: false });

const earliestRetryAt = computed(() => (
  entries.value.reduce((earliest, entry) => (
    entry.cooldown?.active && (earliest === 0 || entry.cooldown.retryAt < earliest)
      ? entry.cooldown.retryAt
      : earliest
  ), 0)
));

function formatTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatLastUsed(ts) {
  if (!ts) return '从未使用';
  const elapsed = Date.now() - ts;
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return `${Math.floor(elapsed / 86_400_000)} 天前`;
}

async function onOpen() {
  selectedTarget.value = fixedTarget.value;
  if (!fixedTarget.value) await loadTargets();
  if (selectedTarget.value) await loadEntries();
}

async function loadTargets() {
  targetsLoading.value = true;
  try {
    const res = await getSystemConfig({ skipGlobalError: true });
    const list = Array.isArray(res?.config?.targets) ? res.config.targets : [];
    poolTargets.value = list
      .filter((t) => t && typeof t.name === 'string' && t.name && t.useOpenAiAuth !== true)
      .map((t) => ({ name: t.name, host: t.host || '' }));
    if (!selectedTarget.value && poolTargets.value.length > 0) {
      selectedTarget.value = poolTargets.value[0].name;
      await loadEntries();
    }
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    targetsLoading.value = false;
  }
}

async function loadEntries() {
  if (!selectedTarget.value) return;
  loading.value = true;
  try {
    const res = await listChannelKeys(selectedTarget.value, { skipGlobalError: true });
    entries.value = Array.isArray(res?.entries) ? res.entries : [];
  } catch { /* 弹窗内静默 */ } finally {
    loading.value = false;
  }
}

function onKindChange() {
  form.value.key = '';
}

// env_ref 解析状态由后端 create/update 校验兜底（env_ref_missing），前端不做假检查

async function handleSave() {
  const key = form.value.key?.trim();
  if (!key) {
    ElMessage.warning(form.value.kind === 'env_ref' ? '请填写环境变量名' : '请填写 API Key');
    return;
  }
  saving.value = true;
  try {
    if (editingId.value) {
      const patch = { id: editingId.value };
      if (form.value.label !== undefined) patch.label = form.value.label.trim();
      if (form.value.priority !== undefined) patch.priority = form.value.priority;
      patch.kind = form.value.kind;
      if (key) patch.key = key;
      await updateChannelKey(patch);
      ElMessage.success('密钥已更新；冷却状态已重置');
    } else {
      await createChannelKey({
        target: selectedTarget.value,
        kind: form.value.kind,
        label: form.value.label.trim(),
        key,
        priority: form.value.priority || 0,
        skipVerify: form.value.skipVerify === true,
      });
      ElMessage.success('密钥已添加；额度耗尽时自动冷却并切换');
    }
    resetForm();
    await loadEntries();
    emit('changed');
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    saving.value = false;
  }
}

async function handlePriorityChange(row, value) {
  if (value === row.priority) return;
  try {
    await updateChannelKey({ id: row.id, priority: Number(value) || 0 });
    ElMessage.success('优先级已更新');
    await loadEntries();
  } catch { /* 拦截器提示 */ }
}

function openEdit(row) {
  editingId.value = row.id;
  form.value = {
    kind: row.kind,
    label: row.label,
    key: '',
    priority: row.priority,
    skipVerify: false,
  };
}

function cancelEdit() {
  editingId.value = '';
  resetForm();
}

function resetForm() {
  editingId.value = '';
  form.value = { kind: 'plaintext', label: '', key: '', priority: 0, skipVerify: false };
}

async function handleTest(row) {
  testingId.value = row.id;
  try {
    const res = await testChannelKey(row.id);
    if (res.ok) {
      ElMessage.success(`验证通过：${res.latencyMs}ms，上游 ${res.modelCount} 个模型`);
    } else {
      ElMessage.warning(`验证失败：${res.error || '上游未通过'}`);
    }
  } catch { /* 拦截器提示 */ } finally {
    testingId.value = null;
  }
}

async function handleRevoke(row) {
  try {
    await ElMessageBox.confirm(
      `确定吊销「${row.label || row.maskedKey || row.refName}」吗？吊销后该 key 不再参与轮换，可重新添加。`,
      '吊销密钥',
      { confirmButtonText: '吊销', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  try {
    await revokeChannelKey(row.id);
    ElMessage.success('密钥已吊销');
    await loadEntries();
    emit('changed');
  } catch { /* 拦截器提示 */ }
}

function resetState() {
  if (!fixedTarget.value) selectedTarget.value = '';
  entries.value = [];
  resetForm();
}
</script>

<style scoped>
.priority-input :deep(.el-input__inner) {
  text-align: center;
  padding: 0 18px;
}
.cooldown-tag {
  cursor: help;
  max-width: 160px;
}
.key-form .el-form-item {
  margin-bottom: 12px;
}
</style>
