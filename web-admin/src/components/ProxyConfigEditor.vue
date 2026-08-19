<template>
  <div class="proxy-config-editor space-y-2">
    <!-- 代理方式下拉：直连 / 全局代理 / 自定义代理 -->
    <el-select v-model="mode" placeholder="选择代理方式" :size="size" class="w-full">
      <el-option label="直连（不走代理）" value="direct" />
      <el-option v-if="allowGlobal" label="全局代理（用系统已配好的全局代理）" value="global" />
      <el-option label="自定义代理（机场节点 / 本地代理软件）" value="custom" />
    </el-select>

    <template v-if="mode === 'custom'">
      <div class="grid grid-cols-2 gap-2">
        <!-- 协议下拉：可选常见协议，也支持直接输入 -->
        <el-select
          v-model="protocol"
          filterable
          allow-create
          default-first-option
          :size="size"
          placeholder="协议（下拉选或手动输入）"
          class="w-full"
        >
          <el-option
            v-for="p in PROTOCOLS"
            :key="p.value"
            :label="p.label"
            :value="p.value"
          />
        </el-select>
        <el-input v-model="host" :size="size" placeholder="服务器地址，如 1.2.3.4" class="font-mono" />
        <el-input v-model.number="port" :size="size" placeholder="端口，如 443 / 8388" class="font-mono" />
        <el-input
          v-model="password"
          :size="size"
          :placeholder="passwordPlaceholder"
          class="font-mono"
        />
        <el-input
          v-if="protocol === 'ss'"
          v-model="method"
          :size="size"
          placeholder="加密方式（默认 aes-256-gcm）"
          class="font-mono"
        />
        <el-input
          v-if="protocol === 'trojan' || protocol === 'vless'"
          v-model="sni"
          :size="size"
          placeholder="SNI 域名（可选，一般同服务器地址）"
          class="font-mono"
        />
      </div>
      <div class="text-xs text-secondary">
        不想一项项填？直接粘贴完整节点链接，自动识别填好上面各项：
      </div>
      <el-input
        v-model="rawUrl"
        type="textarea"
        :rows="2"
        :size="size"
        resize="vertical"
        placeholder="ss://… / trojan://… / vless://… / socks5://… / http://…"
        class="font-mono"
        @input="applyRawUrl"
        @change="applyRawUrl"
      />
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';

/**
 * 可复用「代理配置」编辑器（小白友好版）。
 * 代理方式下拉选择；自定义代理时：协议下拉（filterable+allow-create，
 * 既可下拉选也支持手动输入），服务器/端口/密码分字段填写；
 * 还支持粘贴完整节点链接自动识别拆分。
 * v-model 绑定对象 { mode: 'direct'|'global'|'custom', url: 组装好的代理链接 }，
 * 链接格式与后端 lib/proxy-nodes.mjs 的 parseNodeUrl 兼容。
 */

const PROTOCOLS = [
  { label: 'ss（Shadowsocks 机场节点）', value: 'ss' },
  { label: 'trojan（机场节点）', value: 'trojan' },
  { label: 'vless（机场节点）', value: 'vless' },
  { label: 'socks5（本地代理软件）', value: 'socks5' },
  { label: 'http（本地代理软件）', value: 'http' },
];

const props = defineProps({
  modelValue: { type: Object, default: () => ({ mode: 'direct', url: '' }) },
  // 订阅账号等场景没有「全局代理」概念，可隐藏该选项
  allowGlobal: { type: Boolean, default: true },
  // 控件尺寸（default / small），小卡片内用 small 更协调
  size: { type: String, default: 'default' },
});
const emit = defineEmits(['update:modelValue']);

const mode = ref('direct');
const protocol = ref('ss');
const host = ref('');
const port = ref(null);
const password = ref('');
const method = ref('aes-256-gcm');
const sni = ref('');
const rawUrl = ref('');

const passwordPlaceholder = computed(() => {
  if (protocol.value === 'vless') return 'UUID（36 位）';
  if (protocol.value === 'socks5' || protocol.value === 'http') return '用户名:密码（可选）';
  return '密码';
});

// ---------- 组装 / 解析链接（与后端 parseNodeUrl 规则一致） ----------

function base64UrlDecode(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = text.padEnd(Math.ceil(text.length / 4) * 4, '=');
  try {
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

/** 把当前字段组装成标准节点链接；字段不全时返回空串。 */
function buildUrl() {
  const h = host.value?.trim();
  const p = Number(port.value);
  if (!h || !Number.isInteger(p) || p < 1 || p > 65535) return '';
  const userInfo = (() => {
    if (protocol.value === 'ss') return `${method.value || 'aes-256-gcm'}:${password.value}`;
    if (protocol.value === 'trojan' || protocol.value === 'vless') return encodeURIComponent(password.value);
    if (password.value) return encodeURIComponent(password.value);
    return '';
  })();
  let url;
  if (protocol.value === 'ss' || protocol.value === 'trojan' || protocol.value === 'vless') {
    url = `${protocol.value}://${userInfo}@${h}:${p}`;
  } else {
    url = `${protocol.value}://${h}:${p}`;
  }
  if ((protocol.value === 'trojan' || protocol.value === 'vless') && sni.value?.trim()) {
    url += `?security=tls&sni=${encodeURIComponent(sni.value.trim())}`;
  }
  return url;
}

/** 解析完整链接回填到字段；不认识的格式返回 false。 */
function parseIntoFields(url) {
  const str = String(url || '').trim();
  if (!str) return false;
  let match = str.match(/^(ss|trojan|vless|socks5|http)s?:\/\/([^@/?#]+)@([^/?#:]+)(?::(\d{1,5}))?([^#]*)(?:#.*)?$/i);
  if (!match) {
    match = str.match(/^(socks5|http)s?:\/\/([^/?#:]+)(?::(\d{1,5}))?([^#]*)(?:#.*)?$/i);
    if (!match) return false;
    protocol.value = match[1].toLowerCase();
    host.value = match[2];
    port.value = match[3] ? Number(match[3]) : (protocol.value === 'socks5' ? 10808 : 10809);
    password.value = '';
    method.value = 'aes-256-gcm';
    sni.value = '';
    return true;
  }
  const [, scheme, userInfo, h, p, queryPart] = match;
  protocol.value = scheme.toLowerCase();
  host.value = h;
  port.value = p ? Number(p) : (protocol.value === 'ss' ? 8388 : 443);
  const query = new URLSearchParams(queryPart || '');
  sni.value = query.get('sni') || query.get('peer') || '';
  if (protocol.value === 'ss') {
    // ss 支持明文 method:password 或 base64(method:password) 两种形态
    const plain = userInfo.includes(':') ? userInfo : base64UrlDecode(userInfo);
    const idx = plain.indexOf(':');
    if (idx >= 0) {
      method.value = plain.slice(0, idx).toLowerCase() || 'aes-256-gcm';
      password.value = plain.slice(idx + 1);
    } else {
      method.value = 'aes-256-gcm';
      password.value = plain;
    }
  } else {
    try {
      password.value = decodeURIComponent(userInfo);
    } catch {
      password.value = userInfo;
    }
  }
  return true;
}

/** 完整链接特征：协议前缀（ss:// trojan:// vless:// socks5:// http://） */
const FULL_LINK_RE = /^(ss|trojan|vless|socks5|http)s?:\/\//i;

/**
 * 粘贴/输入链接时自动识别：仅当内容已具备完整链接特征才尝试解析，
 * 成功则填充字段并清空粘贴框；不完整或解析失败保留原文让用户继续编辑。
 * @input 与 @change 共用：粘贴瞬间即识别，无需等失焦。
 */
function applyRawUrl() {
  const val = rawUrl.value;
  if (!val || !FULL_LINK_RE.test(val)) return;
  if (parseIntoFields(val)) {
    rawUrl.value = '';
    emitUpdate();
  }
}

function emitUpdate() {
  // 非自定义模式不携带链接（直连/全局代理由父级按各自语义处理）
  const url = mode.value === 'custom' ? buildUrl() : '';
  const next = { mode: mode.value, url };
  if (JSON.stringify(next) !== JSON.stringify(props.modelValue || {})) {
    emit('update:modelValue', next);
  }
}

// ---------- 内外同步：外部对象变化（如打开弹窗回显）时重新解析 ----------
watch(
  () => props.modelValue,
  (val) => {
    const v = val || {};
    const nextMode = v.mode || 'direct';
    if (nextMode !== mode.value) mode.value = nextMode;
    if (v.url) {
      parseIntoFields(v.url);
    } else if (mode.value === 'custom' && !v.url) {
      // 外部给了 custom 但无链接：清空字段，避免残留上次值
      host.value = '';
      port.value = null;
      password.value = '';
      method.value = 'aes-256-gcm';
      sni.value = '';
      rawUrl.value = '';
    }
  },
  { deep: true, immediate: true },
);

watch([mode, protocol, host, port, password, method, sni], emitUpdate);
</script>
