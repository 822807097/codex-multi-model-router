<template>
  <el-dialog
    :model-value="modelValue"
    :title="editing ? `编辑通道 ${editing.name}` : '添加路由通道（自定义厂商）'"
    :width="isMobile ? '94%' : '640px'"
    class="custom-dialog-pro"
    :close-on-click-modal="false"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <el-form :model="form" label-position="top" class="target-form">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        <el-form-item label="通道名称" required>
          <el-input v-model="form.name" :disabled="editing" placeholder="例如：我的 DeepSeek" class="font-mono" />
          <div class="text-xs text-secondary mt-1">给自己起的名字，方便辨认（显示在通道列表里）</div>
        </el-form-item>
        <el-form-item label="匹配哪些模型" required>
          <el-input v-model="form.match" placeholder="例如：^deepseek- 或 ^glm-" class="font-mono" />
          <div class="text-xs text-secondary mt-1">
            决定哪些模型走这个通道。例子：<code>^deepseek-</code> 表示所有以 deepseek- 开头的模型都走这里；
            精确匹配单个模型用 <code>^模型名$</code>（如 <code>^glm-5.1$</code>）
          </div>
        </el-form-item>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-x-4">
        <el-form-item label="服务器地址 (Host)" required>
          <el-input v-model="form.host" placeholder="api.deepseek.com" class="font-mono" />
          <div class="text-xs text-secondary mt-1">模型服务商的接口域名（不含 https://，如 api.deepseek.com）</div>
        </el-form-item>
        <el-form-item label="路径前缀">
          <el-input v-model="form.prefix" placeholder="/v1 或留空" class="font-mono" />
          <div class="text-xs text-secondary mt-1">大多数服务商填 <code>/v1</code>；留空表示直接使用根路径</div>
        </el-form-item>
        <el-form-item label="协议">
          <el-select v-model="form.protocol">
            <el-option label="https" value="https" />
            <el-option label="http" value="http" />
          </el-select>
        </el-form-item>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-x-4">
        <el-form-item label="端口（可选）">
          <el-input-number v-model="form.port" :min="1" :max="65535" class="w-full" controls-position="right" />
        </el-form-item>
        <el-form-item label="接口格式">
          <el-select v-model="form.wireApi">
            <el-option label="chat（OpenAI 通用格式，绝大多数厂商支持）" value="chat" />
            <el-option label="responses（Codex 官方格式）" value="responses" />
          </el-select>
          <div class="text-xs text-secondary mt-1">不确定就选 <b>chat</b>——DeepSeek、GLM、通义等厂商都用这个通用格式</div>
        </el-form-item>
        <el-form-item label="Chat 路径（可选）">
          <el-input v-model="form.chatPath" placeholder="/chat/completions" class="font-mono" />
        </el-form-item>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        <el-form-item label="密钥环境变量（可选）">
          <el-input v-model="form.envKey" placeholder="例如 DEEPSEEK_API_KEY" class="font-mono" />
          <div class="text-xs text-secondary mt-1">
            先在系统里设置好密钥环境变量（Windows：<code>setx 变量名 密钥</code>），这里填<b>变量名</b>；
            不想折腾环境变量，可以在「模型页 → 密钥池」里直接填写 Key，本项留空即可
          </div>
        </el-form-item>
        <el-form-item label="平台类型（可选，一般不用填）">
          <el-input v-model="form.platform" placeholder="deepseek / dashscope / openrouter..." class="font-mono" />
        </el-form-item>
      </div>
      <el-form-item label="代理（可选：每通道独立配置）">
        <ProxyConfigEditor v-model="form.proxy" class="w-full" />
        <div class="text-xs text-secondary mt-1 leading-relaxed">
          不会配代理就选「直连」；选了自定义代理后，协议用下拉框选（也可手动输入），
          服务器/端口/密码逐项填；或把节点分享链接（ss:// / trojan:// / vless:// / socks5:// / http://）直接粘贴，自动识别
        </div>
      </el-form-item>
      <div class="flex flex-col gap-1">
        <el-checkbox v-model="form.vision" :disabled="form.useOpenAiAuth">该模型支持看图（发送图片给它）</el-checkbox>
        <el-checkbox v-model="form.useOpenAiAuth">使用官方账号登录态（ChatGPT 订阅账号专用）</el-checkbox>
      </div>
    </el-form>
    <template #footer>
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <el-button :loading="testing" @click="handleTest">
            <el-icon class="mr-1"><Lightning /></el-icon>测试连接
          </el-button>
          <span v-if="testResult" class="text-xs min-w-0">
            <span v-if="testResult.ok && testResult.authFailed" class="text-warning">
              网络连通 ✓（{{ testResult.latencyMs }}ms），但{{ testResult.error }}
            </span>
            <span v-else-if="testResult.ok" class="text-success">
              连接正常：{{ testResult.latencyMs }}ms，上游 {{ testResult.modelCount }} 个模型{{ testResult.proxy !== '直连' ? ` · ${testResult.proxy}` : '' }}
            </span>
            <span v-else class="text-danger break-all">连接失败：{{ testResult.error }}</span>
          </span>
        </div>
        <div class="flex gap-2 shrink-0">
          <el-button @click="emit('update:modelValue', false)">取消</el-button>
          <el-button type="primary" :loading="saving" @click="handleSave">保存通道</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { commitModelOperations, testTargetConnection } from '../api/models.js';
import { useBreakpoint } from '../composables/useBreakpoint.js';
import ProxyConfigEditor from './ProxyConfigEditor.vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 编辑对象（含 targetRef）；null = 新增
  editing: { type: Object, default: null },
  configRevision: { type: String, default: '' },
  catalogRevision: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'saved']);

const { isMobile } = useBreakpoint();
const saving = ref(false);
const testing = ref(false);
const testResult = ref(null);
const form = ref(emptyForm());

function emptyForm() {
  return {
    name: '',
    match: '',
    host: '',
    prefix: '/v1',
    protocol: 'https',
    port: null,
    wireApi: 'chat',
    chatPath: '',
    envKey: '',
    platform: '',
    proxy: { mode: 'direct', url: '' },
    vision: true,
    useOpenAiAuth: false,
  };
}

watch(() => props.modelValue, (open) => {
  if (!open) return;
  const src = props.editing;
  if (src) {
    form.value = {
      name: src.name || '',
      match: src.match || '',
      host: src.host || '',
      prefix: src.prefix ?? '/v1',
      protocol: src.protocol || 'https',
      port: src.port || null,
      wireApi: src.wireApi || 'chat',
      chatPath: src.chatPath || '',
      envKey: src.envKey || '',
      platform: src.platform || '',
      vision: src.vision !== false,
      useOpenAiAuth: src.useOpenAiAuth === true,
    };
    // proxyUrl 完整回显（含 ss/trojan/vless 节点链接）
    const proxyUrl = typeof src.proxyUrl === 'string' ? src.proxyUrl : '';
    form.value.proxy = {
      mode: proxyUrl ? 'custom' : (src.viaProxy === true ? 'global' : 'direct'),
      url: proxyUrl,
    };
  } else {
    form.value = emptyForm();
  }
});

// 用当前表单配置（未保存）真实测试连通性：走目标级/全局代理，返回延迟与模型数
async function handleTest() {
  const host = form.value.host?.trim();
  if (!host) {
    ElMessage.warning('请先填写 Host 再测试');
    return;
  }
  testing.value = true;
  testResult.value = null;
  try {
    const targetPayload = {
      name: form.value.name?.trim() || 'form-test',
      match: form.value.match?.trim() || '^x$',
      host,
      prefix: form.value.prefix?.trim() || '',
      protocol: form.value.protocol,
      ...(form.value.port ? { port: Number(form.value.port) } : {}),
      wireApi: form.value.wireApi,
      ...(form.value.envKey?.trim() ? { envKey: form.value.envKey.trim() } : {}),
    };
    if (form.value.proxy.mode === 'custom') {
      const proxyUrl = form.value.proxy.url?.trim();
      if (proxyUrl) targetPayload.proxyUrl = proxyUrl;
    } else if (form.value.proxy.mode === 'global') {
      targetPayload.viaProxy = true;
    }
    const res = await testTargetConnection({ target: targetPayload });
    testResult.value = res || { ok: false, error: '无响应' };
  } catch (err) {
    testResult.value = { ok: false, error: err.response?.data?.error?.message || err.message || '测试失败' };
  } finally {
    testing.value = false;
  }
}

async function handleSave() {
  const name = form.value.name?.trim();
  const match = form.value.match?.trim();
  const host = form.value.host?.trim();
  if (!name || !match || !host) {
    ElMessage.warning('通道名称 / 匹配正则 / Host 为必填项');
    return;
  }
  try {
    new RegExp(match);
  } catch {
    ElMessage.warning('匹配正则无法编译，请检查语法');
    return;
  }
  saving.value = true;
  try {
    const targetPayload = {
      name,
      match,
      host,
      prefix: form.value.prefix?.trim() || '',
      protocol: form.value.protocol,
      ...(form.value.port ? { port: Number(form.value.port) } : {}),
      wireApi: form.value.wireApi,
      ...(form.value.chatPath?.trim() ? { chatPath: form.value.chatPath.trim() } : {}),
      ...(form.value.envKey?.trim() ? { envKey: form.value.envKey.trim() } : {}),
      ...(form.value.platform?.trim() ? { platform: form.value.platform.trim() } : {}),
      vision: form.value.vision,
      useOpenAiAuth: form.value.useOpenAiAuth,
    };
    // 代理组装：custom → proxyUrl（节点/本地代理链接）；global → viaProxy=true；direct → 两者清除
    if (form.value.proxy.mode === 'custom') {
      const proxyUrl = form.value.proxy.url?.trim();
      if (!proxyUrl) {
        ElMessage.warning('自定义代理需填写协议/服务器/端口，或粘贴节点链接');
        return;
      }
      targetPayload.proxyUrl = proxyUrl;
      targetPayload.viaProxy = false;
    } else if (form.value.proxy.mode === 'global') {
      targetPayload.viaProxy = true;
      targetPayload.proxyUrl = null;
    } else {
      targetPayload.viaProxy = false;
      targetPayload.proxyUrl = null;
    }
    const operations = props.editing
      ? [{ kind: 'target.update', targetRef: props.editing.targetRef, patch: targetPayload }]
      : [{ kind: 'target.create', target: targetPayload }];
    await commitModelOperations(operations);
    ElMessage.success(props.editing ? '通道已更新；重启路由后生效' : '通道已创建；重启路由后生效');
    emit('saved');
    emit('update:modelValue', false);
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.target-form .el-form-item {
  margin-bottom: 14px;
}
</style>
