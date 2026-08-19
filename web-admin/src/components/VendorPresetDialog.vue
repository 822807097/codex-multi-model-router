<template>
  <el-dialog
    :model-value="modelValue"
    title="🏭 一键接入模型厂商"
    :width="isMobile ? '94%' : '820px'"
    class="custom-dialog-pro"
    :close-on-click-modal="false"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @open="onOpen"
    @closed="resetState"
  >
    <div v-if="!selectedPreset" class="space-y-5">
      <div v-for="group in groupedPresets" :key="group.category">
        <div class="text-xs font-semibold text-secondary uppercase tracking-wide mb-2">
          {{ group.label }}（{{ group.items.length }}）
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div
            v-for="preset in group.items"
            :key="preset.id"
            class="vendor-card cursor-pointer"
            @click="selectedPreset = preset"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="font-semibold text-primary text-sm">{{ preset.name }}</span>
              <el-tag
                v-if="preset.existingTarget"
                type="success"
                size="small"
                effect="plain"
              >
                已接入 {{ preset.existingTarget }}
              </el-tag>
            </div>
            <div class="text-xs text-secondary font-mono mt-1 break-all">
              {{ preset.host }}{{ preset.prefix || '' }}
            </div>
            <div class="text-xs mt-1">
              <span class="text-secondary">{{ preset.planLabel }}</span>
              <span class="text-secondary mx-1">·</span>
              <span class="text-secondary">{{ preset.modelCount }} 个默认模型</span>
            </div>
          </div>
        </div>
      </div>
      <div class="text-xs text-secondary leading-relaxed">
        选一个厂商，把你在该平台开通的密钥填进去，点「一键接入」即可：路由会自动配好服务器地址、
        模型清单并保存密钥。接入后所有配置都能在「设置」里修改。Claude / Gemini 的订阅账号请到
        「订阅账号」页用「一键授权」登录（这里只放 API 密钥型厂商）。
      </div>
    </div>

    <!-- 选中厂商：详情 + 填 key -->
    <template v-else>
      <el-page-header :content="selectedPreset.name" class="mb-3" @back="selectedPreset = null">
        <template #title>
          <span class="text-xs text-secondary">返回厂商列表</span>
        </template>
      </el-page-header>

      <el-descriptions :column="isMobile ? 1 : 2" size="small" border class="mb-3">
        <el-descriptions-item label="接入地址">
          <span class="font-mono text-xs">{{ selectedPreset.protocol }}://{{ selectedPreset.host }}{{ selectedPreset.prefix || '' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="套餐 / 额度">
          {{ selectedPreset.planLabel }}
        </el-descriptions-item>
        <el-descriptions-item label="额度重置周期">
          <el-tag size="small" :type="quotaWindowTagType(selectedPreset.quotaWindow)" effect="plain">
            {{ quotaWindowLabel(selectedPreset.quotaWindow) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="接口格式">
          <el-tag size="small" effect="plain">{{ selectedPreset.wireApi === 'chat' ? 'chat（OpenAI 通用格式）' : 'responses' }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="默认匹配正则">
          <span class="font-mono text-xs">{{ selectedPreset.defaultMatch }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="默认模型" :span="isMobile ? 1 : 2">
          <span v-for="m in selectedPreset.models.slice(0, 6)" :key="m.slug" class="inline-block mr-2 mb-1">
            <el-tag size="small" type="info" effect="plain" class="font-mono">{{ m.slug }}</el-tag>
          </span>
          <span v-if="selectedPreset.models.length > 6" class="text-xs text-secondary">
            +{{ selectedPreset.models.length - 6 }} 个
          </span>
        </el-descriptions-item>
      </el-descriptions>

      <el-alert
        :type="selectedPreset.existingTarget ? 'success' : 'info'"
        :closable="false"
        class="mb-3"
      >
        <template #title>
          {{ selectedPreset.existingTarget
            ? `命中既有通道 ${selectedPreset.existingTarget}（host/prefix 相同）——只追加密钥，不重建通道`
            : '将新建路由通道并写入默认模型清单' }}
        </template>
      </el-alert>

      <!-- key 列表：多把、双形态、可增删 -->
      <div class="text-sm font-semibold text-primary mb-2">订阅 Key（可多把，额度耗尽自动轮换）</div>
      <div v-for="(item, index) in keyRows" :key="index" class="key-row">
        <el-radio-group v-model="item.kind" size="small">
          <el-radio-button value="plaintext">Key</el-radio-button>
          <el-radio-button value="env_ref">环境变量</el-radio-button>
        </el-radio-group>
        <el-input
          v-model="item.key"
          :type="item.kind === 'plaintext' ? 'password' : 'text'"
          :show-password="item.kind === 'plaintext'"
          :placeholder="item.kind === 'plaintext' ? 'sk-...（订阅套餐 API Key）' : '环境变量名（如 DEEPSEEK_KEY_2）'"
          class="flex-1 font-mono"
        />
        <el-input v-model="item.label" placeholder="备注" class="w-28" maxlength="40" />
        <el-input-number v-model="item.priority" :min="0" :max="99" size="small" controls-position="right" class="w-24" />
        <el-button size="small" type="danger" plain :disabled="keyRows.length <= 1" @click="keyRows.splice(index, 1)">
          删除
        </el-button>
      </div>
      <el-button size="small" plain class="mt-2" @click="addKeyRow">
        <el-icon class="mr-1"><Plus /></el-icon>
        再加一把
      </el-button>

      <div class="flex items-center justify-between gap-2 mt-4 flex-wrap">
        <div class="flex flex-col gap-1">
          <el-checkbox v-model="addCatalog" class="text-xs">同时写入预设默认模型清单到 catalog</el-checkbox>
          <el-checkbox v-model="fetchModels" class="text-xs">
            接入后直连拉取真实模型清单（拉取失败自动回退预设清单）
          </el-checkbox>
        </div>
        <div class="flex gap-2">
          <el-button @click="selectedPreset = null">返回</el-button>
          <el-button type="primary" :loading="activating" @click="handleActivate">
            一键接入
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { getVendorPresets, activateVendorPreset } from '../api/channelKeys.js';
import { useBreakpoint } from '../composables/useBreakpoint.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'activated']);

const { isMobile } = useBreakpoint();
const presets = ref([]);
const selectedPreset = ref(null);
const keyRows = ref([]);
const addCatalog = ref(true);
const fetchModels = ref(false);
const activating = ref(false);

const groupedPresets = computed(() => {
  const categories = ['cn_official', 'official', 'aggregator'];
  const labels = { cn_official: '国内官方', official: '国外官方', aggregator: '聚合网关' };
  return categories.map((category) => ({
    category,
    label: labels[category] || category,
    items: presets.value.filter((p) => p.category === category),
  })).filter((group) => group.items.length > 0);
});

// 额度重置周期标签（对齐需求 4 的额度可视化：5 小时窗口 / 周额度 / 按量）
function quotaWindowLabel(window) {
  return { '5h': '5 小时窗口', weekly: '周额度', usage: '按量计费' }[window] || '无固定周期';
}
function quotaWindowTagType(window) {
  return window === '5h' || window === 'weekly' ? 'warning' : 'info';
}

function addKeyRow() {
  keyRows.value.push({ kind: 'plaintext', key: '', label: '', priority: 0 });
}

async function onOpen() {
  selectedPreset.value = null;
  keyRows.value = [{ kind: 'plaintext', key: '', label: '', priority: 0 }];
  try {
    const res = await getVendorPresets({ skipGlobalError: true });
    presets.value = Array.isArray(res?.presets) ? res.presets : [];
  } catch { /* 错误提示由请求拦截器统一处理 */ }
}

async function handleActivate() {
  const keys = keyRows.value
    .map((row) => ({
      kind: row.kind,
      key: row.key?.trim() || '',
      label: row.label?.trim() || '',
      priority: Number(row.priority) || 0,
    }))
    .filter((row) => row.key);
  if (keys.length === 0) {
    ElMessage.warning('至少填一把 key（明文或环境变量名）');
    return;
  }
  activating.value = true;
  try {
    const res = await activateVendorPreset({
      vendorId: selectedPreset.value.id,
      keys,
      addCatalog: addCatalog.value,
      fetchModels: fetchModels.value,
    });
    const summary = [
      res.changes?.join('；'),
      res.fetchedModels !== undefined
        ? `拉取 ${res.fetchedModels} 个真实模型${res.fetchWarning ? `（${res.fetchWarning}，已回退预设）` : ''}`
        : (res.addedModels > 0 ? `写入 ${res.addedModels} 个默认模型` : '模型已存在，未重复写入'),
      `密钥池 ${res.keyCount} 把`,
    ].filter(Boolean).join('；');
    ElMessage.success(`接入完成：${summary}；重启路由后生效`);
    emit('activated', res.target);
    emit('update:modelValue', false);
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    activating.value = false;
  }
}

function resetState() {
  selectedPreset.value = null;
  keyRows.value = [{ kind: 'plaintext', key: '', label: '', priority: 0 }];
  addCatalog.value = true;
  fetchModels.value = false;
}
</script>

<style scoped>
.vendor-card {
  border: 1px solid var(--border-muted);
  border-radius: 10px;
  padding: 0.65rem 0.85rem;
  transition: border-color 0.15s, background-color 0.15s;
}
.vendor-card:hover {
  border-color: var(--el-color-primary);
  background: var(--surface-2, rgba(127, 127, 127, 0.06));
}
.key-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
</style>
