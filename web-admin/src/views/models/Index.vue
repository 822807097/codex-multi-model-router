<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <div class="text-xl font-bold text-primary tracking-wide">自定义模型与路由</div>
        <div class="text-xs text-secondary mt-1">模型列表 1:1 映射 Codex 桌面端下拉菜单，支持自由分组（可自建/改名/移动）、编辑、删除与真实连通性测速</div>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <el-select
          v-model="codexDefaultModel"
          size="small"
          class="w-52"
          filterable
          :loading="codexModelLoading"
          placeholder="Codex 默认模型"
        >
          <el-option
            v-for="m in codexModelOptions"
            :key="m.slug"
            :value="m.slug"
            :label="`${m.displayName || m.slug} (${m.slug})`"
          />
        </el-select>
        <el-button
          size="small"
          type="primary"
          plain
          :loading="codexModelSaving"
          :disabled="!codexDefaultModel"
          @click="handleSetCodexDefault"
        >
          设为 Codex 启动默认
        </el-button>
        <el-button size="small" plain @click="openFetchModal">
          <el-icon class="mr-1"><Download /></el-icon>
          自动拉取模型
        </el-button>
        <el-button size="small" plain @click="showKeyPool = true">
          <el-icon class="mr-1"><Key /></el-icon>
          密钥池
        </el-button>
        <el-button size="small" plain @click="showVendorPreset = true">
          <el-icon class="mr-1"><Shop /></el-icon>
          一键接入厂商
        </el-button>
        <el-button size="small" plain :loading="prefixPlatformSaving" @click="handlePrefixPlatform('add')">
          <el-icon class="mr-1"><CollectionTag /></el-icon>
          显示名加平台前缀
        </el-button>
        <el-button size="small" plain :loading="prefixPlatformSaving" @click="handlePrefixPlatform('remove')">
          移除前缀
        </el-button>
        <el-button size="small" plain @click="showGroupManage = true">
          <el-icon class="mr-1"><Files /></el-icon>
          分组管理
        </el-button>
        <el-button size="small" plain @click="openRequestLog">
          <el-icon class="mr-1"><Document /></el-icon>
          请求日志
        </el-button>
        <el-button type="primary" size="small" @click="openAddModal">
          <el-icon class="mr-1"><Plus /></el-icon>
          添加自定义模型
        </el-button>
      </div>
    </div>

    <!-- 按分组展示卡片流（统一异步状态：骨架 / 错误重试 / 内容） -->
    <AsyncContainer
      :loading="loading"
      :error="!!loadError"
      :error-detail="loadError"
      error-text="模型列表加载失败"
      :min-height="280"
      @retry="loadModels"
    >
    <div class="space-y-4">
    <div v-for="group in modelGroups" :key="group.name">
      <el-card shadow="never" class="group-card">
        <template #header>
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="group.dotClass"></span>
              <span class="font-semibold text-primary text-sm">{{ group.name }}</span>
              <el-tag size="small" type="info" effect="plain" class="rounded-full text-3xs shrink-0">
                {{ group.models.length }} 个模型
              </el-tag>
            </div>
          </div>
        </template>

        <div class="divide-y divide-default">
          <div
            v-for="m in group.models"
            :key="m.slug"
            class="py-3.5 flex items-center justify-between flex-wrap gap-3 hover:bg-surface-2 px-3 rounded-lg transition-colors"
          >
            <!-- 左侧：模型核心信息 -->
            <div class="space-y-1.5 min-w-0">
              <div class="flex items-center gap-2.5 flex-wrap">
                <span class="font-bold text-primary font-mono text-sm">{{ m.displayName || m.slug }}</span>
                <span class="text-xs text-secondary font-mono">{{ m.slug }}</span>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                <el-tag size="small" effect="plain" type="info" class="text-xs">
                  上下文: {{ m.context }}
                </el-tag>
                <el-tag size="small" effect="plain" type="info" class="text-xs">
                  默认思考: {{ effortLabel(m.default_level) }}
                </el-tag>
              </div>
            </div>

            <!-- 右侧：测速 Badge 与操作 -->
            <div class="flex items-center gap-2 flex-wrap">
              <!-- 密钥状态 -->
              <el-tag v-if="m.envSet === false" type="warning" size="small" effect="plain">⚠ 密钥未配置</el-tag>
              <!-- 测速 Badge -->
              <div v-if="latencies[m.slug]" class="flex items-center">
                <el-tag
                  v-if="latencies[m.slug].ok"
                  type="success"
                  effect="dark"
                  size="small"
                  class="font-mono font-semibold"
                >
                  {{ latencies[m.slug].latencyMs }}ms
                </el-tag>
                <el-tooltip
                  v-else
                  :content="latencies[m.slug].error || '连接失败'"
                  placement="top"
                  :show-after="100"
                >
                  <el-tag
                    type="danger"
                    effect="dark"
                    size="small"
                    class="font-mono latency-fail-tag"
                  >
                    连接失败
                  </el-tag>
                </el-tooltip>
              </div>
              <el-tag v-else type="info" size="small" class="text-secondary">待测速</el-tag>

              <!-- 测试连接按钮（真实探测：走完整路由管线打一条 ping） -->
              <el-button
                size="small"
                type="primary"
                plain
                :loading="testingSlug === m.slug"
                @click="testLatency(m)"
              >
                <el-icon class="mr-1"><Lightning /></el-icon>
                测试连接
              </el-button>
              <!-- 编辑/删除：目录里的每个模型都可自由编辑与删除 -->
              <el-button size="small" plain @click="openEdit(m)">
                <el-icon class="mr-1"><Edit /></el-icon>
                编辑
              </el-button>
              <el-button size="small" type="danger" plain @click="handleDeleteModel(m)">
                删除
              </el-button>
            </div>
          </div>
        </div>
      </el-card>
    </div>
    </div>
    </AsyncContainer>

    <!-- 添加模型弹窗：按厂商填写（地址+密钥一次），模型批量添加，接口配置自动生成 -->
    <el-dialog v-model="showAddModal" title="添加模型" :width="isMobile ? '94%' : '600px'" class="custom-dialog-pro">
      <el-form :model="form" label-position="top">
        <el-form-item label="厂商名称" required>
          <el-input v-model="form.vendor" placeholder="例如: deepseek、zhipu、moonshot，或任意自定义名字" @input="syncVendorGroup" />
          <div class="text-xs text-secondary mt-1">同一厂商的多个模型只需填一次地址和密钥；厂商名会用作分组名和显示名前缀（如 deepseek/deepseek-v4-flash）</div>
        </el-form-item>
        <el-form-item label="API 地址" required>
          <el-input v-model="form.apiBase" placeholder="例如: https://api.deepseek.com/v1 或 https://open.bigmodel.cn/api/paas/v4" class="font-mono" />
          <div class="text-xs text-secondary mt-1">从厂商文档原样复制完整的接口地址（含路径）；该厂商全部模型共用</div>
        </el-form-item>
        <el-form-item label="API 密钥（每行一个，自动无感轮换）">
          <el-input
            v-model="form.keysText"
            type="textarea"
            :rows="3"
            class="font-mono"
            placeholder="每行一个，两种写法可混填：
sk-xxxxxxxx（直接粘贴 Key，自动进密钥池）
DEEPSEEK_API_KEY（环境变量名，路由运行时读取）"
          />
          <div class="text-xs text-secondary mt-1">该厂商全部模型共用这些 Key；开多个账号就有多把，某一把没额度自动无感切换下一把</div>
        </el-form-item>
        <el-form-item label="模型列表（每行一个）" required>
          <el-input
            v-model="form.modelsText"
            type="textarea"
            :rows="4"
            class="font-mono"
            placeholder="每行一个模型标识，例如：
deepseek-v4-flash
deepseek-v4-pro
需要映射厂商真实模型名时用 = 号：
my-glm=glm-5.3-flash"
          />
          <div class="text-xs text-secondary mt-1">每行一个；写法 slug=厂商真实模型码 表示该模型对外用 slug、对厂商用真实码（自动映射）</div>
        </el-form-item>
        <el-form-item label="所属分组 (Group)">
          <el-select v-model="form.group" placeholder="默认按厂商名称分组，也可自建" filterable allow-create default-first-option>
            <el-option v-for="name in groupNames" :key="name" :label="name" :value="name" />
          </el-select>
          <div class="text-xs text-secondary mt-1">留空/回车保持默认 = 按厂商名称分组；分组只影响本页展示</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddModal = false">取消</el-button>
        <el-button type="primary" @click="handleAddModel">保存全部模型</el-button>
      </template>
    </el-dialog>

    <!-- 请求日志：真实请求与模型回复原文（环形缓冲，最近 300 条） -->
    <el-dialog v-model="showRequestLog" title="请求日志（真实请求与回复）" :width="isMobile ? '96%' : '1100px'" class="custom-dialog-pro" top="4vh">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs text-secondary">最近 {{ requestLogRows.length }} 条（环形缓冲自动淘汰）；点「查看」展开完整请求体与模型回复原文</span>
        <el-button size="small" :loading="requestLogLoading" @click="loadRequestLog">刷新</el-button>
      </div>
      <el-table :data="requestLogRows" size="small" class="custom-table" max-height="320" @row-click="openRequestDetail">
        <el-table-column label="时间" width="100">
          <template #default="{ row }">{{ new Date(row.startedAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</template>
        </el-table-column>
        <el-table-column prop="model" label="模型" min-width="150" show-overflow-tooltip />
        <el-table-column prop="target" label="接口" min-width="120" show-overflow-tooltip />
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'ok'" type="success" size="small" effect="plain">{{ row.upstreamStatus || 'OK' }}</el-tag>
            <el-tag v-else-if="row.status === 'running'" type="info" size="small" effect="plain">进行中</el-tag>
            <el-tag v-else type="danger" size="small" effect="plain">{{ row.upstreamStatus || row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="90">
          <template #default="{ row }">{{ row.elapsedMs != null ? `${(row.elapsedMs / 1000).toFixed(1)}s` : '—' }}</template>
        </el-table-column>
        <el-table-column prop="error" label="错误" min-width="180" show-overflow-tooltip />
      </el-table>
      <div v-if="requestDetail" class="mt-3">
        <div class="text-xs font-bold text-primary mb-1">
          请求详情 · {{ requestDetail.model }} · {{ new Date(requestDetail.startedAt).toLocaleString('zh-CN', { hour12: false }) }}
        </div>
        <div class="text-xs text-secondary mb-1">发往上游的请求体（真实原文）：</div>
        <pre class="font-mono text-xs bg-secondary/10 rounded p-2 overflow-auto" style="max-height: 260px">{{ requestDetail.requestBody || '（空）' }}</pre>
        <div class="text-xs text-secondary mb-1 mt-2">模型回复原文（上游响应，前 64KB）：</div>
        <pre class="font-mono text-xs bg-secondary/10 rounded p-2 overflow-auto" style="max-height: 260px">{{ requestDetail.responseText || '（空——流式进行中或该管道未捕获正文）' }}</pre>
      </div>
    </el-dialog>

    <!-- 测试结果：真实请求往返（延迟 + 模型回复原文） -->
    <el-dialog v-model="showTestReply" title="测试结果（真实请求与模型回复）" :width="isMobile ? '94%' : '760px'" class="custom-dialog-pro" top="6vh">
      <div v-for="(row, idx) in testReplyRows" :key="idx" class="mb-3 pb-3" style="border-bottom: 1px solid var(--el-border-color-lighter)">
        <div class="flex items-center gap-2 mb-1">
          <span class="font-bold text-primary text-sm">{{ row.name }}</span>
          <el-tag :type="row.ok ? 'success' : 'danger'" size="small" effect="plain">
            {{ row.ok ? `正常 · ${row.latencyMs}ms` : '失败' }}
          </el-tag>
        </div>
        <div v-if="row.error" class="text-xs mb-1" style="color: var(--el-color-danger)">错误：{{ row.error }}</div>
        <div class="text-xs text-secondary mb-1">模型回复：</div>
        <pre class="font-mono text-xs bg-secondary/10 rounded p-2 overflow-auto whitespace-pre-wrap" style="max-height: 160px">{{ row.reply || '（无文本回复——工具调用型响应或该次探测被上游截断，可在「请求日志」里看完整响应）' }}</pre>
      </div>
      <div class="text-xs text-secondary">探测请求固定为「请用一句中文简短介绍你自己。」（max_output_tokens=256）；完整请求体可在「请求日志」里查看。</div>
    </el-dialog>

    <!-- 分组管理：全部有模型的分组都可重命名（整组迁移）或删除（移入其他已接入模型） -->
    <el-dialog v-model="showGroupManage" title="分组管理" :width="isMobile ? '96%' : '560px'" class="custom-dialog-pro">
      <div class="text-xs text-secondary mb-3">
        列出当前全部有模型的分组（含官方基础模型等内置分组）。重命名 = 整组迁移到新名字；
        删除 = 整组移入「其他已接入模型」。模型本身不受影响，分组只是本页展示方式。
      </div>
      <div v-for="g in manageableGroups" :key="g.name" class="flex items-center gap-2 mb-2">
        <el-input v-model="g.editName" size="small" class="font-mono" maxlength="64" />
        <span class="text-xs text-secondary whitespace-nowrap">{{ g.count }} 个模型</span>
        <el-button size="small" type="primary" plain :disabled="!g.editName.trim() || g.editName.trim() === g.name" @click="renameGroup(g)">重命名</el-button>
        <el-button size="small" type="danger" plain @click="deleteGroup(g)">删除</el-button>
      </div>
      <el-empty v-if="manageableGroups.length === 0" description="还没有任何模型——先添加模型" :image-size="60" />
    </el-dialog>

    <!-- 自动拉取模型弹窗：选接口来源 → 拉取上游模型列表 → 勾选批量写入 -->
    <el-dialog
      v-model="showFetchModal"
      title="自动拉取模型"
      :width="isMobile ? '92%' : '560px'"
      class="custom-dialog-pro"
      @closed="resetFetchState"
    >
      <el-form label-position="top">
        <el-form-item label="接口来源">
          <el-select
            v-model="fetchTarget"
            class="w-full"
            placeholder="选择要从哪个接口拉取"
            :disabled="fetchingModels"
          >
            <el-option
              v-for="t in fetchTargets"
              :key="t.name"
              :value="t.name"
              :label="`${t.name} (${t.host})`"
              :disabled="!t.fetchable"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="font-mono">{{ t.name }}</span>
                <span class="text-xs text-secondary">
                  {{ t.host }}<template v-if="!t.fetchable"> · 不支持自动拉取</template>
                </span>
              </div>
            </el-option>
          </el-select>
          <div class="text-xs text-secondary mt-1">
            从所选接口的上游（GET /models）获取全部可用模型；官方登录态接口没有公开列表，请手动添加
          </div>
        </el-form-item>
      </el-form>

      <div class="flex items-center gap-3 flex-wrap">
        <el-button
          type="primary"
          plain
          :loading="fetchingModels"
          :disabled="!fetchTarget || fetchingModels"
          @click="handleFetchTargetModels"
        >
          <el-icon class="mr-1"><Download /></el-icon>
          {{ fetchingModels ? '正在拉取…' : '拉取模型列表' }}
        </el-button>
        <span v-if="fetchTargets.length === 0 && !fetchError" class="text-xs text-secondary">接口清单加载中…</span>
      </div>

      <!-- 拉取失败 / 网络异常：明确提示 + 保留手动添加备选 -->
      <el-alert v-if="fetchError" type="error" show-icon :closable="false" class="mt-3">
        <template #title>{{ fetchError }}</template>
        <template #default>可检查接口的密钥与网络后重试，或改用「手动添加」逐个输入。</template>
      </el-alert>

      <template v-if="fetchResult">
        <el-alert
          v-if="fetchResult.length === 0"
          title="该平台当前无可用模型"
          type="info"
          show-icon
          :closable="false"
          class="mt-3"
        >
          <template #default>上游返回了空的模型列表，可换其他接口重试或手动添加。</template>
        </el-alert>
        <div v-else class="mt-4">
          <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
            <el-checkbox
              v-model="fetchCheckAll"
              :indeterminate="fetchIndeterminate"
              :disabled="selectableFetchModels.length === 0"
            >
              全选（已选 {{ selectedFetchModels.length }} / 可添加 {{ selectableFetchModels.length }}）
            </el-checkbox>
            <span class="text-xs text-secondary">共拉取 {{ fetchResult.length }} 个模型</span>
          </div>
          <el-checkbox-group v-model="selectedFetchModels" class="fetch-model-list">
            <div v-for="m in fetchResult" :key="m.name" class="fetch-model-row">
              <el-checkbox :value="m.name" :disabled="m.exists" class="min-w-0">
                <span class="font-mono text-sm break-all">{{ m.name }}</span>
              </el-checkbox>
              <el-tag v-if="m.exists" size="small" type="info" effect="plain" class="shrink-0">已存在</el-tag>
              <el-tag v-else-if="!m.routeTarget" size="small" type="warning" effect="plain" class="shrink-0">
                待配置接口
              </el-tag>
              <el-tag v-else size="small" type="success" effect="plain" class="shrink-0">→ {{ m.routeTarget }}</el-tag>
            </div>
          </el-checkbox-group>
        </div>
      </template>

      <template #footer>
        <el-button @click="showFetchModal = false">取消</el-button>
        <el-button plain @click="switchToManual">手动添加</el-button>
        <el-button
          type="primary"
          :disabled="selectedFetchModels.length === 0"
          :loading="importingModels"
          @click="handleImportModels"
        >
          添加选中模型{{ selectedFetchModels.length > 0 ? ` (${selectedFetchModels.length})` : '' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 编辑模型弹窗：写入 catalog 的模型条目字段 -->
    <el-dialog
      v-model="showEditModal"
      title="编辑模型"
      :width="isMobile ? '92%' : '520px'"
      class="custom-dialog-pro"
      @closed="editingSlug = ''"
    >
      <el-form :model="editForm" label-position="top">
        <el-form-item label="模型标识 (Slug)">
          <el-input v-model="editForm.slug" placeholder="模型唯一标识" />
          <div class="text-xs text-secondary mt-1">修改 Slug 相当于重命名；分组归属会跟着保留</div>
        </el-form-item>
        <el-form-item label="显示名称 (Display Name)">
          <el-input v-model="editForm.display_name" placeholder="Codex 下拉菜单中显示的名称" />
        </el-form-item>
        <el-form-item label="所属分组 (Group)">
          <el-select v-model="editForm.group" placeholder="选择分组，或输入新名字自建" filterable allow-create default-first-option clearable>
            <el-option v-for="name in groupNames" :key="name" :label="name" :value="name" />
          </el-select>
          <div class="text-xs text-secondary mt-1">改分组只影响本页展示；清空则回到按预置规则自动分组</div>
        </el-form-item>
        <el-form-item label="默认思考级别 (Reasoning Effort)">
          <el-select v-model="editForm.default_reasoning_level" placeholder="选择默认思考级别" class="w-full">
            <el-option
              v-for="level in editEffortOptions"
              :key="level"
              :label="`${effortLabel(level)} (${level})`"
              :value="level"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="上下文窗口 (Tokens)">
          <el-select
            v-model="editForm.context_window"
            filterable
            allow-create
            default-first-option
            placeholder="选择常用档位，或直接输入数字"
            class="w-full"
          >
            <el-option
              v-for="opt in CONTEXT_WINDOW_PRESETS"
              :key="String(opt.value)"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
          <div class="text-xs text-secondary mt-1">下拉选 128k / 272k / 1M 等常用档位；也可直接输入数字或 1M、272k 这类简写，保存时自动换算</div>
        </el-form-item>
        <el-form-item label="输入模态">
          <el-checkbox :model-value="true" disabled>文本 (text)</el-checkbox>
          <el-checkbox v-model="editForm.supportsImage">图片 (image / 视觉)</el-checkbox>
        </el-form-item>
        <el-form-item label="Codex 插件能力（自定义模型可声明使用全部插件）">
          <div class="w-full space-y-1">
            <el-checkbox-group v-model="editForm.plugins.tools" class="plugin-tools">
              <el-checkbox v-for="t in CODEX_TOOL_OPTIONS" :key="t.value" :value="t.value">
                {{ t.label }}
              </el-checkbox>
            </el-checkbox-group>
            <div class="flex items-center gap-2 mt-1">
              <el-input
                v-model="editForm.plugins.customTools"
                size="small"
                placeholder="自定义工具名（逗号分隔，如 mcp__server__tool、新插件）"
                class="font-mono"
              />
            </div>
            <el-checkbox v-model="editForm.plugins.skills" class="mt-1">
              注入 Skills 使用指令 (include_skills_usage_instructions)——启用 Codex 技能插件
            </el-checkbox>
            <div class="text-xs text-secondary">
              写入 catalog 的 experimental_supported_tools / web_search_tool_type / apply_patch_tool_type；
              上游需支持 function calling，路由会自动做工具格式转换
            </div>
          </div>
        </el-form-item>
        <el-form-item label="描述 (Description)">
          <el-input
            v-model="editForm.description"
            type="textarea"
            :rows="2"
            maxlength="300"
            show-word-limit
            placeholder="一句话说明模型定位（可选）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditModal = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="handleSaveEdit">保存修改</el-button>
      </template>
    </el-dialog>

    <!-- 密钥池：同一接口多把 key / 优先级 / 冷却与恢复时间展示 -->
    <ChannelKeyPoolDialog v-model="showKeyPool" @changed="loadModels" />
    <!-- 厂商预设接入：选厂商 → 填 key → 自动配好接口与密钥轮换 -->
    <VendorPresetDialog v-model="showVendorPreset" @activated="onVendorActivated" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import {
  testModelLatency,
  getModels,
  commitModelOperations,
  createModels,
  fetchTargetModels,
  updateModel,
  deleteModel,
  listRequestLog,
  getRequestLogDetail,
} from '../../api/models.js';
import { getSystemConfig } from '../../api/system.js';
import { getCodexDefaultModel, setCodexDefaultModel, createChannelKey } from '../../api/channelKeys.js';
import { prefixModelPlatform } from '../../api/models.js';
import { ElMessage, ElMessageBox } from 'element-plus';
import AsyncContainer from '../../components/AsyncContainer.vue';
import ChannelKeyPoolDialog from '../../components/ChannelKeyPoolDialog.vue';
import VendorPresetDialog from '../../components/VendorPresetDialog.vue';
import { useBreakpoint } from '../../composables/useBreakpoint.js';

const { isMobile } = useBreakpoint();
const loading = ref(true);
const loadError = ref('');

// ---- 密钥池 / 厂商预设 / Codex 默认模型 ----
const showKeyPool = ref(false);
const showVendorPreset = ref(false);
const codexModelLoading = ref(false);
const codexModelSaving = ref(false);
const codexModelOptions = ref([]);
const codexDefaultModel = ref('');

const showAddModal = ref(false);
const testingSlug = ref(null);
const latencies = ref({});
const form = ref({ vendor: '', apiBase: '', keysText: '', modelsText: '', group: '' });
const showGroupManage = ref(false);

function syncVendorGroup() {
  // 分组默认跟随厂商名称（用户选过分组就不覆盖）
  if (!form.value.groupTouched) form.value.group = form.value.vendor?.trim() || '';
}

// 解析模型列表文本：每行一个 slug，支持 slug=上游码 声明真实模型码映射
function parseModelLines(text) {
  const models = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq > 0) {
      const slug = line.slice(0, eq).trim();
      const upstream = line.slice(eq + 1).trim();
      if (slug) models.push({ slug, upstream });
    } else {
      models.push({ slug: line, upstream: '' });
    }
  }
  return models;
}

function openAddModal() {
  form.value = { vendor: '', apiBase: '', keysText: '', modelsText: '', group: '', groupTouched: false };
  showAddModal.value = true;
}

// ---- 请求/响应查看器（sub2api 式：真实请求与回复原文） ----
const showRequestLog = ref(false);
const requestLogLoading = ref(false);
const requestLogRows = ref([]);
const requestDetail = ref(null);

async function loadRequestLog() {
  requestLogLoading.value = true;
  try {
    const res = await listRequestLog(50, { skipGlobalError: true });
    requestLogRows.value = Array.isArray(res?.requests) ? res.requests : [];
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    requestLogLoading.value = false;
  }
}

async function openRequestLog() {
  showRequestLog.value = true;
  requestDetail.value = null;
  await loadRequestLog();
}

async function openRequestDetail(row) {
  try {
    const res = await getRequestLogDetail(row.id, { skipGlobalError: true });
    requestDetail.value = res?.entry || null;
  } catch { /* 拦截器提示 */ }
}

// 把用户填的完整 API 地址拆成路由内部需要的 host/protocol/port/路径前缀
function parseApiBase(apiBase) {
  const trimmed = String(apiBase || '').trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  return {
    protocol: url.protocol.replace(':', ''),
    host: url.hostname,
    port: url.port ? Number(url.port) : null,
    prefix: path || '/v1',
  };
}

function parseKeyLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ line, kind: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(line) ? 'env_ref' : 'plaintext' }));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- 自动拉取模型状态 ----
const showFetchModal = ref(false);
const fetchTargets = ref([]);
const fetchTargetsLoaded = ref(false);
const fetchTarget = ref('');
const fetchingModels = ref(false);
const importingModels = ref(false);
const fetchError = ref('');
// null = 尚未拉取；[] = 拉取成功但平台无可用模型
const fetchResult = ref(null);
const selectedFetchModels = ref([]);
// 后端 catalog 实况 slug 集合（loadModels 时刷新），用于标记“已存在”
const catalogSlugs = ref(new Set());

const selectableFetchModels = computed(() => (
  Array.isArray(fetchResult.value) ? fetchResult.value.filter((m) => !m.exists) : []
));

const fetchCheckAll = computed({
  get: () => (
    selectableFetchModels.value.length > 0
    && selectedFetchModels.value.length === selectableFetchModels.value.length
  ),
  set: (val) => {
    selectedFetchModels.value = val ? selectableFetchModels.value.map((m) => m.name) : [];
  },
});

const fetchIndeterminate = computed(() => (
  selectedFetchModels.value.length > 0
  && selectedFetchModels.value.length < selectableFetchModels.value.length
));

// ---- 编辑弹窗状态 ----
const showEditModal = ref(false);
const editSaving = ref(false);
const editingSlug = ref('');

// 上下文窗口快捷档位：下拉直选；allow-create 也支持手输数字或 1M/272k 简写
const CONTEXT_WINDOW_PRESETS = [
  { label: '128k（128,000）', value: 131072 },
  { label: '200k（200,000）', value: 200000 },
  { label: '256k（256,000）', value: 262144 },
  { label: '272k（272,000）', value: 278528 },
  { label: '400k（400,000）', value: 400000 },
  { label: '1M（1,000,000）', value: 1000000 },
  { label: '2M（2,000,000）', value: 2000000 },
];

// 把下拉值（数字）或手输文本（1000000 / 1M / 272k / 272000）换算成 token 数字
function parseContextTokens(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const text = String(value ?? '').trim().toUpperCase().replace(/[,\s_]/g, '');
  if (!text) return null;
  const match = /^([0-9.]+)([KMB])?$/.exec(text);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const unit = { K: 1000, M: 1_000_000, B: 1_000_000_000 }[match[2]] || 1;
  const tokens = Math.round(base * unit);
  return tokens > 0 ? tokens : null;
}
const editForm = ref({
  slug: '',
  display_name: '',
  description: '',
  group: '',
  default_reasoning_level: '',
  context_window: null,
  supportsImage: false,
  supportedLevels: [],
  plugins: { tools: [], customTools: '', skills: false },
  supportedTools: [],
});

const editEffortOptions = computed(() => (
  editForm.value.supportedLevels.length > 0
    ? editForm.value.supportedLevels
    : ['low', 'medium', 'high']
));

// Codex 全部标准插件/工具能力（experimental_supported_tools 可声明集合；新插件可走自定义输入）
const CODEX_TOOL_OPTIONS = [
  { value: 'apply_patch', label: '文件编辑 (apply_patch)' },
  { value: 'shell', label: '终端命令 (shell)' },
  { value: 'goal', label: '目标追踪 (goal)' },
  { value: 'computer_use', label: '电脑控制 (computer_use)' },
  { value: 'web_search', label: '联网搜索 (web_search)' },
  { value: 'tool_search', label: '工具搜索 (tool_search)' },
  { value: 'mcp_read', label: 'MCP 读取 (mcp_read)' },
  { value: 'mcp_write', label: 'MCP 写入 (mcp_write)' },
  { value: 'code_analysis', label: '代码分析 (code_analysis)' },
  { value: 'vision', label: '视觉 (vision)' },
  { value: 'image_generation', label: '生图 (image_generation)' },
];

const EFFORT_LABELS = {
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  ultra: '超高',
};

function effortLabel(level) {
  if (!level) return '默认';
  return EFFORT_LABELS[level] || level;
}

// 预置分组只提供「slug → 默认分组名/圆点色」的展示基调；卡片列表 100% 由后端
// catalog 实况驱动（见 loadModels / modelGroups computed）：不在 catalog 的模型不显示，
// 删除后即从页面消失。分组对用户完全开放——编辑/添加时可输入新分组名自建分组，
// 自定义归属存 localStorage（分组只是本页展示方式，不写入桌面端目录）。
const DEFAULT_GROUPS = [
  {
    name: '官方基础模型 (OpenAI Frontier)',
    dotClass: 'bg-chart-3',
    slugs: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2', 'codex-auto-review'],
  },
  {
    name: '国内直连 / 重度代码主力',
    dotClass: 'bg-chart-1',
    slugs: ['deepseek-v4-flash', 'deepseek-v4-pro', 'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus'],
  },
  {
    name: '长文本与开源前沿 (OpenCode & MAAS)',
    dotClass: 'bg-chart-5',
    slugs: ['grok-4.5', 'glm-5.1', 'glm-5.2', 'kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'mimo-v2.5', 'mimo-v2.5-pro', 'hy3', 'minimax-m3'],
  },
];
const OTHER_GROUP_NAME = '其他已接入模型';
const OTHER_GROUP_DOT = 'bg-chart-6';
// 自定义分组循环取色的调色板（与预置组区分）
const CUSTOM_GROUP_DOTS = ['bg-chart-2', 'bg-chart-4', 'bg-chart-5', 'bg-chart-3', 'bg-chart-1'];

const GROUP_MAP_STORAGE_KEY = 'router-model-group-map';
function loadGroupMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUP_MAP_STORAGE_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
const customGroupMap = ref(loadGroupMap());
function persistGroupMap() {
  try { localStorage.setItem(GROUP_MAP_STORAGE_KEY, JSON.stringify(customGroupMap.value)); } catch { /* 存储不可用时静默降级为会话内生效 */ }
}
function setCustomGroup(slug, groupName) {
  if (groupName && groupName.trim()) customGroupMap.value[slug] = groupName.trim();
  else delete customGroupMap.value[slug];
  persistGroupMap();
}

// ---- 分组管理：全部有模型的分组都可重命名（整组迁移）或删除（移入其他已接入模型） ----
// 自定义归属存在 customGroupMap（localStorage），优先级高于内置预置表——因此内置分组
// （官方基础模型/国内直连等）同样可以整组改名或删除：改名=逐模型写入新组映射，
// 删除=逐模型移入「其他已接入模型」，模型本身不受影响。
const manageableGroups = computed(() => modelGroups.value.map((g) => ({
  name: g.name,
  count: g.models.length,
  editName: g.name,
})));

function renameGroup(group) {
  const nextName = group.editName.trim();
  if (!nextName || nextName === group.name) return;
  for (const m of allModels.value) {
    if (groupOf(m.slug) === group.name) setCustomGroup(m.slug, nextName);
  }
  persistGroupMap();
  group.name = nextName;
  group.editName = nextName;
  ElMessage.success(`分组已重命名为「${nextName}」`);
}

function deleteGroup(group) {
  ElMessageBox.confirm(
    `删除分组「${group.name}」？其中 ${group.count} 个模型将移入「${OTHER_GROUP_NAME}」（模型本身不受影响）。`,
    '删除分组',
    { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
  ).then(() => {
    for (const m of allModels.value) {
      if (groupOf(m.slug) === group.name) setCustomGroup(m.slug, OTHER_GROUP_NAME);
    }
    ElMessage.success(`分组已删除，${group.count} 个模型移入「${OTHER_GROUP_NAME}」`);
  }).catch(() => { /* 用户取消 */ });
}
const defaultGroupBySlug = new Map(DEFAULT_GROUPS.flatMap((g) => g.slugs.map((slug) => [slug, g.name])));
const defaultDotByName = new Map(DEFAULT_GROUPS.map((g) => [g.name, g.dotClass]));
function groupOf(slug) {
  return customGroupMap.value[slug] || defaultGroupBySlug.get(slug) || OTHER_GROUP_NAME;
}
function dotClassOf(groupName) {
  if (defaultDotByName.has(groupName)) return defaultDotByName.get(groupName);
  if (groupName === OTHER_GROUP_NAME) return OTHER_GROUP_DOT;
  const customNames = [...new Set(Object.values(customGroupMap.value))];
  const idx = customNames.indexOf(groupName);
  return CUSTOM_GROUP_DOTS[(idx >= 0 ? idx : 0) % CUSTOM_GROUP_DOTS.length];
}

// catalog 实况卡片数据（loadModels 填充）；分组视图由 computed 派生
const allModels = ref([]);
const modelGroups = computed(() => {
  const byName = new Map();
  for (const m of allModels.value) {
    const name = groupOf(m.slug);
    if (!byName.has(name)) byName.set(name, { name, dotClass: dotClassOf(name), models: [] });
    byName.get(name).models.push(m);
  }
  // 预置组按声明顺序，自定义组按名称排最后出现，其余归「其他」
  const customNames = [...new Set(Object.values(customGroupMap.value))]
    .filter((name) => !defaultDotByName.has(name) && name !== OTHER_GROUP_NAME).sort();
  const order = [...DEFAULT_GROUPS.map((g) => g.name), ...customNames, OTHER_GROUP_NAME];
  const rank = new Map(order.map((name, index) => [name, index]));
  return [...byName.values()].sort((a, b) => (rank.get(a.name) ?? 98) - (rank.get(b.name) ?? 98));
});
// 分组下拉的候选：现有全部分组名
const groupNames = computed(() => modelGroups.value.map((g) => g.name));

function formatContextWindow(tokens) {
  if (!tokens || tokens <= 0) return '128k';
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

// 用后端 catalog 实况刷新卡片：页面展示什么 = 目录里真实存在什么（1:1），
// 删除的模型立即消失；分组归属由 groupOf（自定义 map → 预置基调 → 其他）决定。
async function loadModels() {
  loading.value = true;
  loadError.value = '';
  try {
    // 错误态由 AsyncContainer 呈现，跳过全局 toast
    const res = await getModels({ skipGlobalError: true });
    if (!res?.ok || !Array.isArray(res.models)) return;
    catalogSlugs.value = new Set(
      res.models.map((entry) => entry?.slug).filter((slug) => typeof slug === 'string' && slug),
    );
    allModels.value = res.models
      .filter((entry) => typeof entry?.slug === 'string' && entry.slug)
      .map((entry) => ({
        slug: entry.slug,
        displayName: entry.displayName || entry.slug,
        description: entry.description || '',
        supportedLevels: Array.isArray(entry.supportedReasoningLevels) ? entry.supportedReasoningLevels : [],
        inputModalities: Array.isArray(entry.inputModalities) ? entry.inputModalities : ['text'],
        contextWindow: Number(entry.contextWindow) > 0 ? Number(entry.contextWindow) : null,
        // 工具能力实况回填（编辑面板复用，避免重存时把已声明的插件能力清空）
        supportedTools: Array.isArray(entry.supportedTools) ? entry.supportedTools : [],
        webSearchToolType: typeof entry.webSearchToolType === 'string' ? entry.webSearchToolType : '',
        supportsSearchTool: entry.supportsSearchTool === true,
        includeSkills: entry.includeSkills === true,
        target: entry.target?.name || '',
        envSet: entry.target ? entry.target.envSet !== false : undefined,
        context: formatContextWindow(Number(entry.contextWindow) > 0 ? Number(entry.contextWindow) : null),
        default_level: entry.reasoningEffort || '',
        live: true,
      }));
    // 清理已删除模型的自定义分组残留，避免 localStorage 无限增长
    let mapChanged = false;
    for (const slug of Object.keys(customGroupMap.value)) {
      if (!catalogSlugs.value.has(slug)) {
        delete customGroupMap.value[slug];
        mapChanged = true;
      }
    }
    if (mapChanged) persistGroupMap();
  } catch (err) {
    loadError.value = err.response?.data?.error?.message || err.message || '请求失败';
  } finally {
    loading.value = false;
  }
}

// 测试结果弹窗：展示真实请求与模型回复（sub2api 式）
const showTestReply = ref(false);
const testReplyRows = ref([]);

function openTestReply(res, displayName) {
  testReplyRows.value = [{
    name: displayName || res.model,
    ok: res.ok,
    latencyMs: res.latencyMs,
    reply: res.reply || '',
    requestBody: res.requestBody || '',
    error: res.error || '',
  }];
  showTestReply.value = true;
}

async function testLatency(m) {
  testingSlug.value = m.slug;
  try {
    const res = await testModelLatency(m.slug, m.target);
    latencies.value[m.slug] = res;
    if (res.ok) {
      ElMessage.success(`${m.displayName} 测试完成: ${res.latencyMs}ms`);
    } else {
      ElMessage.warning(`${m.displayName} 测试失败: ${res.error}`);
    }
    openTestReply(res, m.displayName);
  } catch (err) {
    latencies.value[m.slug] = { ok: false, error: err.response?.data?.error?.message || err.message };
  } finally {
    testingSlug.value = null;
  }
}

// 真实探测会打到上游，全量测速限制并发避免挤占路由请求预算
async function handleTestAll() {
  ElMessage.info('开始逐个真实对话测试（每个模型会收到一条真实请求）...');
  const allModels = modelGroups.value.flatMap((g) => g.models);
  const CONCURRENCY = 4;
  try {
    for (let i = 0; i < allModels.length; i += CONCURRENCY) {
      await Promise.allSettled(allModels.slice(i, i + CONCURRENCY).map((m) => testLatency(m)));
    }
    // 批量完成后汇总展示全部回复（单模型测试的弹窗已在 testLatency 打开过）
    testReplyRows.value = allModels
      .map((m) => ({ name: m.displayName || m.slug, res: latencies.value[m.slug] }))
      .filter((item) => item.res)
      .map((item) => ({
        name: item.name,
        ok: item.res.ok,
        latencyMs: item.res.latencyMs,
        reply: item.res.reply || '',
        requestBody: item.res.requestBody || '',
        error: item.res.error || '',
      }));
    showTestReply.value = true;
    ElMessage.success('全部模型测试完成！');
  } finally {
    // 通知顶栏复位「测试所有模型连接」按钮 loading
    window.dispatchEvent(new CustomEvent('test-all-models-done'));
  }
}

// ---- 编辑 / 删除 ----
function openEdit(m) {
  editingSlug.value = m.slug;
  const levels = Array.isArray(m.supportedLevels) ? m.supportedLevels : [];
  // default_level 可能是 catalog 英文 effort（live 模型）或预置中文（兜底显示）；
  // 不在可选项里的值不回显，由用户显式选择。
  const rawLevel = typeof m.default_level === 'string' ? m.default_level : '';
  const options = levels.length > 0 ? levels : ['low', 'medium', 'high'];
  const supportedTools = Array.isArray(m.supportedTools) ? m.supportedTools : [];
  // 上游 web_search_tool_type 合法值为 text / text_and_image；只要声明了搜索工具类型或开关即为启用
  const webSearch = m.supportsSearchTool === true || Boolean(m.webSearchToolType);
  // 已声明的工具集合与预设选项取交集，其余落入自定义输入框（可编辑）
  const presetValues = new Set(CODEX_TOOL_OPTIONS.map((t) => t.value));
  const custom = supportedTools.filter((t) => !presetValues.has(t));
  const tools = [...new Set([...supportedTools, ...(webSearch ? ['web_search'] : [])])]
    .filter((t) => presetValues.has(t));
  editForm.value = {
    slug: m.slug,
    display_name: m.displayName || m.slug,
    description: m.description || '',
    // 回显当前生效分组（自定义优先，其次预置基调）；清空保存=回到自动分组
    group: groupOf(m.slug),
    default_reasoning_level: options.includes(rawLevel) ? rawLevel : '',
    context_window: m.contextWindow || null,
    supportsImage: Array.isArray(m.inputModalities) ? m.inputModalities.includes('image') : false,
    supportedLevels: levels,
    supportedTools,
    plugins: {
      tools,
      customTools: custom.join(', '),
      skills: m.includeSkills === true,
    },
  };
  showEditModal.value = true;
}

async function handleSaveEdit() {
  const slug = editForm.value.slug?.trim();
  if (!slug || /\s/.test(slug)) {
    ElMessage.warning('Slug 不能为空且不能包含空格');
    return;
  }
  const patch = {
    display_name: editForm.value.display_name?.trim() || slug,
    description: editForm.value.description || '',
    input_modalities: editForm.value.supportsImage ? ['text', 'image'] : ['text'],
  };
  // Codex 全部插件能力：experimental_supported_tools 声明完整工具集（预设多选 + 自定义）
  const tools = new Set(Array.isArray(editForm.value.supportedTools) ? editForm.value.supportedTools : []);
  for (const tool of editForm.value.plugins.tools) tools.add(tool);
  const customTools = String(editForm.value.plugins.customTools || '')
    .split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  for (const tool of customTools) tools.add(tool);
  const hasWebSearch = tools.has('web_search');
  patch.experimental_supported_tools = [...tools];
  // 只声明 web_search 时下发搜索能力字段；不开启时不发（后端补默认），
  // 避免显式 null 覆盖后端默认导致目录字段不一致。
  if (hasWebSearch) {
    patch.supports_search_tool = true;
    // 桌面端 catalog 的 web_search_tool_type 只接受 text / text_and_image
    // （写 web_search 会导致整个配置解析失败、桌面端打不开）
    patch.web_search_tool_type = 'text_and_image';
  }
  // 桌面端 catalog 只接受 freeform（apply_patch_legacy 会导致整个配置解析失败打不开应用）
  patch.apply_patch_tool_type = 'freeform';
  patch.include_skills_usage_instructions = editForm.value.plugins.skills === true;
  if (slug !== editingSlug.value) patch.slug = slug;
  if (editForm.value.default_reasoning_level) {
    patch.default_reasoning_level = editForm.value.default_reasoning_level;
  }
  if (Number(editForm.value.context_window) > 0) {
    patch.context_window = parseContextTokens(editForm.value.context_window);
  }
  editSaving.value = true;
  try {
    await updateModel(editingSlug.value, patch);
    // 分组归属本地生效（slug 重命名时跟着搬过去；清空=回到预置自动分组）
    setCustomGroup(slug, editForm.value.group);
    ElMessage.success('模型已更新；重启路由与 Codex 后完全生效');
    showEditModal.value = false;
    await loadModels();
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    editSaving.value = false;
  }
}

// 官方模型删除的额外警示：历史会话引用它们，删掉可能让旧对话打不开
const OFFICIAL_SLUGS = new Set(DEFAULT_GROUPS[0].slugs);
async function handleDeleteModel(m) {
  const officialNote = OFFICIAL_SLUGS.has(m.slug)
    ? '\n注意：这是官方基础模型，历史会话可能正在引用它，删除后旧对话在 Codex 里可能异常；确定仍要删除可继续。'
    : '';
  try {
    await ElMessageBox.confirm(
      `确定删除模型「${m.displayName || m.slug}」(${m.slug}) 吗？将从 models.json 中移除，该操作不可恢复。${officialNote}`,
      '删除模型',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  try {
    await deleteModel(m.slug);
    delete latencies.value[m.slug];
    delete customGroupMap.value[m.slug];
    persistGroupMap();
    ElMessage.success('模型已删除；重启路由与 Codex 后完全生效');
    await loadModels();
  } catch { /* 错误提示由请求拦截器统一处理 */ }
}

async function handleAddModel() {
  const vendor = form.value.vendor?.trim();
  if (!vendor) {
    ElMessage.warning('请填写厂商名称');
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(vendor)) {
    ElMessage.warning('厂商名称只用字母/数字/点/短横线（用作接口配置名与显示名前缀）');
    return;
  }
  const endpoint = parseApiBase(form.value.apiBase);
  if (!endpoint || !endpoint.host) {
    ElMessage.warning('请填写正确的 API 地址（例如 https://api.deepseek.com/v1）');
    return;
  }
  const models = parseModelLines(form.value.modelsText);
  if (models.length === 0) {
    ElMessage.warning('请至少填写一个模型（每行一个）');
    return;
  }
  const slugs = models.map((m) => m.slug);
  if (new Set(slugs).size !== slugs.length) {
    ElMessage.warning('模型列表里有重复的模型标识');
    return;
  }
  const group = form.value.group?.trim() || vendor;
  // 接口配置内部生成：一个厂商一个通道，match 精确覆盖该厂商标识集合，用户无需感知
  const modelMap = {};
  for (const m of models) {
    if (m.upstream && m.upstream !== m.slug) modelMap[m.slug] = m.upstream;
  }
  const altNames = slugs.map((s) => escapeRegex(s)).join('|');
  const target = {
    name: vendor,
    match: `^(?:${altNames})$`,
    host: endpoint.host,
    prefix: endpoint.prefix,
    protocol: endpoint.protocol,
    wireApi: 'chat',
  };
  if (endpoint.port) target.port = endpoint.port;
  if (Object.keys(modelMap).length > 0) target.modelMap = modelMap;
  const operations = [
    // 模型先入目录，接口配置再绑定——assertDedicatedTarget 要求精确 match 命中已存在的模型
    ...models.map((m) => ({
      kind: 'model.create',
      model: { slug: m.slug, display_name: `${vendor}/${m.slug}` },
    })),
    { kind: 'target.create', target },
  ];
  try {
    await commitModelOperations(operations);
    // 明文/环境变量密钥逐把进密钥池（priority=行序，先填的先用），全厂商共用
    const keys = parseKeyLines(form.value.keysText);
    let keyOk = 0;
    for (let i = 0; i < keys.length; i += 1) {
      try {
        await createChannelKey({
          target: vendor,
          kind: keys[i].kind,
          label: `初始密钥 ${i + 1}`,
          key: keys[i].line,
          priority: i,
          skipVerify: true,
        });
        keyOk += 1;
      } catch { /* 单把失败不阻断整体，用户可在密钥池里补 */ }
    }
    for (const slug of slugs) setCustomGroup(slug, group);
    const parts = [`${slugs.length} 个模型已添加`];
    if (keyOk > 0) parts.push(`${keyOk} 把密钥已入池轮换`);
    ElMessage.success(`${parts.join('，')}；重启路由与 Codex 后完全生效`);
    showAddModal.value = false;
    await loadModels();
  } catch { /* 错误提示由请求拦截器统一处理 */ }
}

// ---- 自动拉取模型 ----
async function openFetchModal() {
  showFetchModal.value = true;
  if (fetchTargetsLoaded.value) return;
  try {
    // 通道清单来自系统配置（敏感字段已被后端脱敏为占位，这里只取名称/host/match/envKey 名）
    const res = await getSystemConfig({ skipGlobalError: true });
    const list = Array.isArray(res?.config?.targets) ? res.config.targets : [];
    fetchTargets.value = list
      .filter((t) => t && typeof t.name === 'string' && t.name)
      .map((t) => ({
        name: t.name,
        host: t.host || '',
        match: typeof t.match === 'string' ? t.match : '',
        // 官方登录态（OAuth 订阅）无公开列表接口；其余通道（envKey 或密钥池）由后端解析凭据
        fetchable: t.useOpenAiAuth !== true,
      }));
    fetchTargetsLoaded.value = true;
    const first = fetchTargets.value.find((t) => t.fetchable);
    if (first) fetchTarget.value = first.name;
  } catch (err) {
    fetchError.value = `接口清单加载失败：${err.response?.data?.error?.message || err.message || '请求失败'}`;
  }
}

// 按 config.targets 顺序做正则匹配，预览模型将路由到的通道（与后端 binding 规则一致：首个命中者优先）
function routeTargetFor(slug) {
  for (const t of fetchTargets.value) {
    if (!t.match) continue;
    try {
      if (new RegExp(t.match).test(slug)) return t.name;
    } catch { /* 忽略不可编译的正则 */ }
  }
  return '';
}

async function handleFetchTargetModels() {
  if (!fetchTarget.value || fetchingModels.value) return;
  fetchingModels.value = true;
  fetchError.value = '';
  fetchResult.value = null;
  selectedFetchModels.value = [];
  try {
    const res = await fetchTargetModels(fetchTarget.value, { skipGlobalError: true });
    const list = Array.isArray(res?.models) ? res.models : [];
    fetchResult.value = list.map((m) => ({
      name: m.name,
      exists: catalogSlugs.value.has(m.name),
      routeTarget: routeTargetFor(m.name),
    }));
  } catch (err) {
    fetchError.value = err.response
      ? (err.response.data?.error?.message || '拉取失败，请稍后重试')
      : '网络异常：无法连接路由网关，请确认服务已启动后重试';
  } finally {
    fetchingModels.value = false;
  }
}

async function handleImportModels() {
  if (selectedFetchModels.value.length === 0 || importingModels.value) return;
  importingModels.value = true;
  try {
    const res = await createModels(selectedFetchModels.value);
    const warnings = Array.isArray(res?.warnings) ? res.warnings : [];
    ElMessage.success(`已添加 ${selectedFetchModels.value.length} 个模型；重启路由与 Codex 后完全生效`);
    if (warnings.length > 0) {
      ElMessage.warning(warnings[0]?.message ? `注意：${warnings[0].message}` : '部分模型可能还未配置接口');
    }
    showFetchModal.value = false;
    await loadModels();
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    importingModels.value = false;
  }
}

function switchToManual() {
  showFetchModal.value = false;
  showAddModal.value = true;
}

// ---- Codex 默认启动模型 ----
async function loadCodexDefaultModel() {
  codexModelLoading.value = true;
  try {
    const res = await getCodexDefaultModel({ skipGlobalError: true });
    codexModelOptions.value = Array.isArray(res?.models) ? res.models : [];
    codexDefaultModel.value = typeof res?.current === 'string' ? res.current : '';
  } catch { /* 请求拦截器统一提示 */ } finally {
    codexModelLoading.value = false;
  }
}

async function handleSetCodexDefault() {
  if (!codexDefaultModel.value) return;
  codexModelSaving.value = true;
  try {
    const res = await setCodexDefaultModel(codexDefaultModel.value);
    ElMessage.success(
      res?.changed === false
        ? '当前已是该默认模型'
        : '已写入 Codex config.toml（已自动备份）；重启 Codex 后新会话生效',
    );
  } catch { /* 拦截器提示 */ } finally {
    codexModelSaving.value = false;
  }
}

// 厂商预设接入成功后刷新模型列表（新通道/新模型进 catalog）
function onVendorActivated() {
  loadModels();
}

// 模型显示名加/去平台前缀（Codex 下拉区分平台，如 opencode/deepseek-v4-pro）
const prefixPlatformSaving = ref(false);
async function handlePrefixPlatform(mode) {
  prefixPlatformSaving.value = true;
  try {
    const res = await prefixModelPlatform(mode);
    ElMessage.success(
      res?.changed > 0
        ? `已${mode === 'add' ? '加' : '去'}前缀 ${res.changed} 个模型；重启 Codex 后下拉菜单生效`
        : '无需变更（已加/已去前缀或无可匹配目标）',
    );
    await loadModels();
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    prefixPlatformSaving.value = false;
  }
}

function resetFetchState() {
  fetchingModels.value = false;
  importingModels.value = false;
  fetchError.value = '';
  fetchResult.value = null;
  selectedFetchModels.value = [];
}

onMounted(() => {
  window.addEventListener('test-all-models', handleTestAll);
  loadModels();
  loadCodexDefaultModel();
  // 「系统与路由配置」页的主按钮带 ?add=1 跳转过来：自动打开添加模型弹窗
  const route = useRoute();
  if (route.query?.add === '1') {
    openAddModal();
  }
});

onUnmounted(() => {
  window.removeEventListener('test-all-models', handleTestAll);
});
</script>

<style scoped>
/* 卡片配色由 main.css 的 EP 变量统一接管（--el-card-* → tokens.css） */
.latency-fail-tag {
  cursor: help;
  max-width: 220px;
}
/* 拉取结果列表：限高滚动，行内 checkbox + 路由去向标签 */
.fetch-model-list {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--border-muted);
  border-radius: 10px;
  padding: 0.25rem 0.75rem;
}
.fetch-model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.45rem 0;
  border-bottom: 1px solid var(--border-muted);
}
.fetch-model-row:last-child {
  border-bottom: none;
}
.fetch-model-row :deep(.el-checkbox) {
  margin-right: 0;
  min-width: 0;
}
</style>
