<template>
  <div class="space-y-6">
    <!-- 顶部操作栏与鉴权模式提示 -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <h2 class="text-xl font-bold text-primary">API 密钥管理</h2>
        <p class="text-xs text-secondary mt-1">
          为 Codex、Trae、Qoder、OpenCode 等客户端签发独立访问凭证。
          <span v-if="keys.length === 0" class="text-warning font-semibold">
            当前无活跃密钥，路由处于开放直连模式。
          </span>
          <span v-else class="text-success font-semibold">
            已开启密钥鉴权保护（共 {{ keys.length }} 个密钥）。
          </span>
        </p>
      </div>
      <div class="flex items-center gap-3">
        <el-button type="primary" @click="showCreateDialog = true">
          <el-icon class="mr-1.5"><Plus /></el-icon>创建 API Key
        </el-button>
      </div>
    </div>

    <!-- 对外调用地址与协议（常驻展示，任意工具/智能体接入用） -->
    <div class="border border-border/60 rounded-xl bg-surface shadow-sm p-4 mb-3">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <span class="text-xs font-semibold text-primary">对外调用地址（OpenAI 兼容协议）</span>
        <el-button size="small" text type="primary" @click="copyKey(routerBaseUrl)">
          <el-icon class="mr-0.5"><CopyDocument /></el-icon>复制 Base URL
        </el-button>
      </div>
      <code class="block font-mono text-sm text-primary select-all break-all mt-1">{{ routerBaseUrl }}</code>
      <div class="text-[11px] text-secondary mt-1.5 leading-relaxed">
        协议：<b>HTTP</b> · OpenAI 兼容 · 端点：
        <code>POST /v1/chat/completions</code>（对话）· <code>POST /v1/responses</code>（Codex）·
        <code>GET /v1/models</code>（模型列表）· <code>POST /v1/images/generations</code>（生图）·
        鉴权：<code>Authorization: Bearer sk-router-...</code>（未创建密钥时开放直连）
      </div>
      <!-- 一分钟接入示例（curl / Python / Node.js，AT 式快速集成） -->
      <div class="mt-3">
        <el-collapse>
          <el-collapse-item name="snippets">
            <template #title>
              <span class="text-xs font-semibold text-primary">📱 一分钟接入示例（curl / Python / Node.js，点开复制即用）</span>
            </template>
            <el-tabs v-model="snippetTab">
              <el-tab-pane label="curl" name="curl">
                <div class="snippet-box">
                  <code class="block font-mono text-xs whitespace-pre-wrap break-all select-all">{{ curlSnippet }}</code>
                  <div class="text-right mt-1">
                    <el-button size="small" text type="primary" @click="copySnippet(curlSnippet)">
                      <el-icon class="mr-0.5"><CopyDocument /></el-icon>复制
                    </el-button>
                  </div>
                </div>
              </el-tab-pane>
              <el-tab-pane label="Python (OpenAI SDK)" name="python">
                <div class="snippet-box">
                  <code class="block font-mono text-xs whitespace-pre-wrap break-all select-all">{{ pythonSnippet }}</code>
                  <div class="text-right mt-1">
                    <el-button size="small" text type="primary" @click="copySnippet(pythonSnippet)">
                      <el-icon class="mr-0.5"><CopyDocument /></el-icon>复制
                    </el-button>
                  </div>
                </div>
              </el-tab-pane>
              <el-tab-pane label="Node.js (OpenAI SDK)" name="node">
                <div class="snippet-box">
                  <code class="block font-mono text-xs whitespace-pre-wrap break-all select-all">{{ nodeSnippet }}</code>
                  <div class="text-right mt-1">
                    <el-button size="small" text type="primary" @click="copySnippet(nodeSnippet)">
                      <el-icon class="mr-0.5"><CopyDocument /></el-icon>复制
                    </el-button>
                  </div>
                </div>
              </el-tab-pane>
            </el-tabs>
            <div class="text-[11px] text-secondary mt-1.5">
              把示例里的 <code>sk-router-你的密钥</code> 换成上面任意一把真实密钥；<code>model</code> 换成「分组自定义模型」页里的任意模型名。
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </div>

    <!-- 异步内容区 -->
    <AsyncContainer :loading="loading" :error="!!loadError" :error-detail="loadError" @retry="loadKeys">
      <div v-if="keys.length === 0" class="border border-border/60 rounded-xl p-8 bg-surface text-center">
        <div class="inline-flex p-3 rounded-full bg-info-subtle text-info mb-3">
          <el-icon :size="24"><Key /></el-icon>
        </div>
        <h3 class="text-base font-semibold text-primary">暂无 API 密钥</h3>
        <p class="text-xs text-secondary max-w-md mx-auto mt-1 mb-5">
          创建密钥后，可将本路由代理接入 Trae、Qoder、OpenCode 或为 Codex 开启安全鉴权。
        </p>
        <el-button type="primary" size="small" @click="showCreateDialog = true">立即创建首个密钥</el-button>
      </div>

      <div v-else class="space-y-4">
        <!-- 密钥卡片表格 -->
        <div class="border border-border/60 rounded-xl overflow-hidden bg-surface shadow-sm">
          <el-table :data="keys" style="width: 100%">
            <el-table-column prop="name" label="密钥名称 / 标识" min-width="160">
              <template #default="{ row }">
                <div class="font-medium text-primary">{{ row.name }}</div>
                <div v-if="row.description" class="text-xs text-secondary truncate max-w-xs">{{ row.description }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="client" label="客户端类型" width="130">
              <template #default="{ row }">
                <el-tag size="small" :type="getClientTagType(row.client)">
                  {{ getClientLabel(row.client) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="密钥脱敏" width="180">
              <template #default="{ row }">
                <code class="text-xs font-mono bg-canvas px-2 py-0.5 rounded border border-border/60">
                  {{ row.keyPrefix }}...{{ row.keySuffix || '****' }}
                </code>
              </template>
            </el-table-column>
            <el-table-column label="最后使用时间" width="160">
              <template #default="{ row }">
                <span class="text-xs text-secondary">{{ formatTime(row.lastUsedAt) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="创建时间" width="160">
              <template #default="{ row }">
                <span class="text-xs text-secondary">{{ formatTime(row.createdAt) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <div class="flex items-center gap-2">
                  <el-button size="small" text type="primary" @click="showUsageGuide(row)">接入指引</el-button>
                  <el-button size="small" text type="danger" @click="handleRevoke(row)">删除</el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </AsyncContainer>

    <!-- 创建密钥弹窗 -->
    <el-dialog v-model="showCreateDialog" title="创建 API 密钥" width="520px" class="custom-dialog">
      <!-- 对外 API 接入信息：与创建 key 同屏展示，任意工具/智能体直接复制配置 -->
      <div class="mb-4 border border-border/60 rounded-lg p-3 bg-canvas space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-primary">对外 API 接入信息（任意工具 / 智能体）</span>
          <el-button size="small" text type="primary" @click="copyKey(routerBaseUrl)">
            <el-icon class="mr-0.5"><CopyDocument /></el-icon>复制 Base URL
          </el-button>
        </div>
        <div class="text-[11px] text-secondary">Base URL（OpenAI 兼容，支持两个端点）：</div>
        <code class="block font-mono text-xs text-primary select-all break-all">{{ routerBaseUrl }}</code>
        <div class="text-[11px] text-secondary leading-relaxed">
          · <code class="font-mono">POST /v1/chat/completions</code> — OpenAI 标准格式，Dify / n8n / Cline / 各类 Agent 框架均可接入<br>
          · <code class="font-mono">GET /v1/models</code> — 可用模型列表<br>
          · <code class="font-mono">POST /v1/responses</code> — Codex 客户端专用<br>
          鉴权：<code class="font-mono">Authorization: Bearer &lt;创建的 Key&gt;</code>，创建后即可填入任意客户端
        </div>
      </div>
      <el-form label-position="top">
        <el-form-item label="密钥名称 / 备注" required>
          <el-input v-model="createForm.name" placeholder="例如：My Codex / Trae IDE" />
        </el-form-item>
        <el-form-item label="用途标签（可选）">
          <el-select v-model="createForm.client" class="w-full">
            <el-option label="Codex 官方客户端" value="codex" />
            <el-option label="Trae IDE" value="trae" />
            <el-option label="Qoder" value="qoder" />
            <el-option label="OpenCode CLI" value="opencode" />
            <el-option label="通用 OpenAI 兼容客户端" value="generic" />
          </el-select>
          <div class="text-xs text-secondary mt-1">
            Key 对所有客户端通用，可同时接入任意工具/智能体；标签仅用于管理页识别
          </div>
        </el-form-item>
        <el-form-item label="补充描述 (可选)">
          <el-input v-model="createForm.description" type="textarea" :rows="2" placeholder="填写用途备忘..." />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="showCreateDialog = false">取消</el-button>
          <el-button type="primary" :loading="creating" @click="handleCreate">确认创建</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 密钥单次展示弹窗 (高安全级别) -->
    <el-dialog v-model="showKeyModal" title="🎉 API 密钥创建成功" width="560px" :close-on-click-modal="false" class="custom-dialog">
      <div class="space-y-4">
        <el-alert
          type="warning"
          title="请立即妥善保存该密钥，关闭后将无法再次查看明文！"
          :closable="false"
          show-icon
        />
        <div>
          <div class="text-xs text-secondary mb-1">完整 API Key:</div>
          <div class="flex items-center gap-2">
            <el-input :model-value="newlyCreatedKey" readonly class="font-mono text-sm" />
            <el-button type="primary" @click="copyKey(newlyCreatedKey)">复制</el-button>
          </div>
        </div>

        <!-- 对外 API 接入信息：创建成功即展示，任意工具/智能体可直接填入 -->
        <div>
          <div class="text-xs text-secondary mb-1">Base URL（OpenAI 兼容，任意工具 / 智能体）:</div>
          <div class="flex items-center gap-2">
            <el-input :model-value="routerBaseUrl" readonly class="font-mono text-sm" />
            <el-button @click="copyKey(routerBaseUrl)">复制</el-button>
          </div>
          <div class="text-[11px] text-secondary mt-1">
            POST /v1/chat/completions（标准格式）· GET /v1/models · POST /v1/responses（Codex）
          </div>
        </div>

        <!-- 针对 Codex 提供一键同步 -->
        <div v-if="newlyCreatedClient === 'codex'" class="border border-border/60 rounded-lg p-3 bg-canvas">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-xs font-semibold text-primary">Codex 一键配置</div>
              <div class="text-[11px] text-secondary">自动修改 config.toml 并注入系统环境变量 ROUTER_API_KEY</div>
            </div>
            <el-button size="small" type="success" :loading="syncing" @click="handleSyncCodex(newlyCreatedKey)">
              一键同步到 Codex
            </el-button>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="flex justify-end">
          <el-button type="primary" @click="showKeyModal = false">我已妥善保存</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 客户端接入指引弹窗 -->
    <el-dialog v-model="showGuideModal" title="客户端接入配置指引" width="580px" class="custom-dialog">
      <div class="space-y-4 text-xs">
        <div>
          <div class="font-semibold text-primary mb-1">1. Base URL</div>
          <code class="block bg-canvas p-2 rounded border border-border/60 font-mono select-all">
            {{ routerBaseUrl }}
          </code>
        </div>
        <div>
          <div class="font-semibold text-primary mb-1">2. 鉴权 Header 格式</div>
          <code class="block bg-canvas p-2 rounded border border-border/60 font-mono select-all">
            Authorization: Bearer sk-router-******
          </code>
        </div>
        <div>
          <div class="font-semibold text-primary mb-1">3. Trae / Qoder / OpenCode 配置参考</div>
          <pre class="bg-canvas p-3 rounded border border-border/60 font-mono overflow-x-auto text-[11px] text-primary">
# 环境变量配置 (Trae / 通用客户端)
export OPENAI_BASE_URL="{{ routerBaseUrl }}"
export OPENAI_API_KEY="sk-router-******"

# Codex config.toml 配置
[model_providers.router]
name = "LocalRouter"
base_url = "{{ routerBaseUrl }}"
wire_api = "responses"
env_key = "ROUTER_API_KEY"
          </pre>
        </div>
      </div>
      <template #footer>
        <div class="flex justify-end">
          <el-button type="primary" @click="showGuideModal = false">我知道了</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { listKeys, createKey, revokeKey, syncCodex } from '../../api/keys.js';
import { getRouterStatus } from '../../api/system.js';
import { ElMessage, ElMessageBox } from 'element-plus';
import AsyncContainer from '../../components/AsyncContainer.vue';

const loading = ref(true);
const loadError = ref('');
const keys = ref([]);
// 路由调用地址：从 /status 取实际监听端口动态拼接，端口被 ROUTER_PORT 修改时自动跟随
const routerBaseUrl = ref('http://127.0.0.1:15730/v1');

const showCreateDialog = ref(false);
const creating = ref(false);
const createForm = reactive({
  name: '',
  client: 'generic',
  description: '',
});

const showKeyModal = ref(false);
const newlyCreatedKey = ref('');
const newlyCreatedClient = ref('');
const syncing = ref(false);

const showGuideModal = ref(false);
const activeGuideRow = ref(null);

async function loadKeys() {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await listKeys({ skipGlobalError: true });
    if (res?.ok) {
      keys.value = res.keys || [];
    } else {
      loadError.value = res?.error?.message || '获取密钥列表失败';
    }
  } catch (err) {
    loadError.value = err.response?.data?.error?.message || err.message || '网络连接异常';
  } finally {
    loading.value = false;
  }
}

async function handleCreate() {
  if (!createForm.name.trim()) {
    ElMessage.warning('请输入密钥名称');
    return;
  }
  creating.value = true;
  try {
    const res = await createKey({
      name: createForm.name.trim(),
      client: createForm.client,
      description: createForm.description.trim(),
    });
    if (res?.ok && res.key) {
      showCreateDialog.value = false;
      newlyCreatedKey.value = res.key.key;
      newlyCreatedClient.value = res.key.client || 'generic';
      showKeyModal.value = true;
      createForm.name = '';
      createForm.description = '';
      createForm.client = 'generic';
      await loadKeys();
    } else {
      ElMessage.error(res?.error?.message || '创建密钥失败');
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.error?.message || err.message || '创建密钥失败');
  } finally {
    creating.value = false;
  }
}

async function handleSyncCodex(apiKey) {
  syncing.value = true;
  try {
    const res = await syncCodex(apiKey);
    if (res?.ok) {
      ElMessage.success('Codex 配置与系统环境变量已成功同步！重启 Codex 即可生效。');
    } else {
      ElMessage.error(res?.error?.message || '同步失败');
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.error?.message || err.message || '同步失败');
  } finally {
    syncing.value = false;
  }
}

async function handleRevoke(row) {
  try {
    await ElMessageBox.confirm(
      `确定要删除密钥 "${row.name}" 吗？删除后该 Key 立即失效并从列表移除，不可恢复。`,
      '安全警告',
      { confirmButtonText: '确定删除', cancelButtonText: '取消', type: 'warning' }
    );
    const res = await revokeKey(row.id);
    if (res?.ok) {
      ElMessage.success('密钥已删除，使用该 Key 的客户端将立即无法访问');
      await loadKeys();
    } else {
      ElMessage.error(res?.error?.message || '删除失败');
    }
  } catch (e) {
    // user cancelled
  }
}

function showUsageGuide(row) {
  activeGuideRow.value = row;
  showGuideModal.value = true;
}

const curlSnippet = `curl http://127.0.0.1:15730/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-router-你的密钥" \\
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"你好"}]}'`;

const pythonSnippet = `from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:15730/v1",
    api_key="sk-router-你的密钥",
)

resp = client.chat.completions.create(
    model="gpt-5.5",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)`;

const nodeSnippet = `import OpenAI from "openai";

const client = new OpenAI({
    baseURL: "http://127.0.0.1:15730/v1",
    apiKey: "sk-router-你的密钥",
});

const resp = await client.chat.completions.create({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "你好" }],
});
console.log(resp.choices[0].message.content);`;

async function copySnippet(text) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('示例已复制到剪贴板');
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      ElMessage.success('示例已复制到剪贴板');
    } catch { ElMessage.warning('复制失败，请手动选择复制'); }
  }
}
const snippetTab = ref('curl');

function copyKey(text) {
  if (!text) return;
  const fallback = () => {
    // 非安全上下文（http 非 localhost）clipboard API 不可用 → 降级 execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      ElMessage.success('已复制到剪贴板（降级方式）');
    } catch {
      ElMessage.warning('复制失败，请手动全选复制');
    }
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => ElMessage.success('已复制到剪贴板'),
      () => fallback(),
    );
  } else {
    fallback();
  }
}

function getClientLabel(client) {
  const map = {
    codex: 'Codex',
    trae: 'Trae',
    qoder: 'Qoder',
    opencode: 'OpenCode',
    generic: '通用客户端',
  };
  return map[client] || client || '通用';
}

function getClientTagType(client) {
  const map = {
    codex: 'primary',
    trae: 'success',
    qoder: 'warning',
    opencode: 'info',
  };
  return map[client] || 'info';
}

function formatTime(ts) {
  if (!ts) return '从未调用';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

async function loadRouterStatus() {
  try {
    const res = await getRouterStatus({ skipGlobalError: true });
    const port = Number(res?.port);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      routerBaseUrl.value = `http://127.0.0.1:${port}/v1`;
    }
  } catch { /* 取不到端口时保留默认 15730 */ }
}

onMounted(() => {
  loadKeys();
  loadRouterStatus();
});
</script>
