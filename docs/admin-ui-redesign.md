# 管理面板 UI/UX 改造文档（已完成）

> 目的：在上下文可能被压缩/中断的情况下，持久记录改造方案、硬性约束、工作进度与验证清单。任何后续继续工作的代理都应先读本文件，再改 `web/`。

## 范围与硬约束（不可违反）

- 只改 `web/` 下前端文件；允许改 `app.js` 的 DOM 结构 / CSS 类 / 纯展示逻辑。
- 不升级依赖、不加前端框架、不加第三方 CDN、不改管理 API 协议、不改路由后端行为、不改用户 `config.json`、不自动重启服务、不提交远程仓库。
- 保留原生 Web Components + ES Modules（`<router-admin>` 单组件架构）。
- 所有用户提供或 API 返回的内容必须继续通过安全 DOM API（`textContent` / `createTextNode` / `createElement`）渲染，禁止拼不可信 HTML。
- 页面中不得新增 API Key / Token / Authorization 输入框。

## 必须保留的行为（验收红线）

- 配置预检（`config/validate`）与模型更改预检（`model-routing/validate`）。
- 更改影响摘要（`renderModelImpact`）。
- 删除确认（`delete-model-dialog`，含专属通道勾选删除）。
- 草稿撤销（`undoModelRoutingChange`）、保存冲突保护（`revision_conflict` + 放弃草稿重载）、双基线重新同步（`resyncBaselines` + `loadEpoch`）。
- 保存后提示手动重启路由与 Codex（`restart-notice`）。
- API Key/Token/Authorization 隔离（`$preserveSecret` 不脱敏不进页面）。
- 现有错误信息安全映射（`errorMessageForCode`，不显示服务端 `error.message`）。
- 键盘焦点返回（`restoreModelDialogFocus`）与弹窗可访问性。

### 测试锁定（test/admin-integration.test.mjs 静态断言，改代码时必须保住）

- `新增自定义模型` 文案；`model-dialog-form` 独立表单；`route-summary`；`route-editor-details`；
- `fillModelTargetFields(select.value, model ? 'reuse' : 'dedicated')` 原样调用；
- `当前模型已关联已有通道` 文案；styles 中 `dialog.model-dialog` 钩子；
- styles 中 `.dialog-section-heading { flex-direction: column;`（手机端纵向，字面匹配）；
- `保存后需手动重启路由与 Codex`；`modelValidationCache`；`await this.resyncBaselines()`；
- `renderModelImpact`；`resyncRequired`；`discard-model-drafts-reload`；`errorMessageForCode`；`loadEpoch`；`activeResyncPromise`；`另一侧仍有未保存更改`；
- index.html 不含 `http(s)://` 外链；app.js 不出现敏感凭据输入模式。
- 集成测试另要求 `/admin` 的静态资源引用解析后恰为 `/admin/styles.css` 与 `/admin/app.js`（不得引入新静态文件；图标用内联 SVG data URI）。

## 现状问题（用户给出）

- 桌面总高约 16115px；"路由配置"约 9539px、一次展开约 165 个输入项；约 24 张模型卡片无搜索/筛选/紧凑列表；390px 手机约 30150px 高；<900px 顶部导航消失；首页展示性内容过大；新手与专家配置混排。

## 页面结构（目标）

单页 + 锚点导航，5 个区块：

1. **总览（#overview）**：紧凑页头（标题+副标题+刷新）→ 状态卡片（服务状态[运行时长/端口]、模型[总数/不可用数]、配置告警[0 时正常摘要，>0 时警示层级+跳转]、是否需重启）→ 主操作"添加模型"、次操作"管理模型"、弱化"高级设置"。删除原大型 Hero。
2. **模型管理（#custom-models，合并原模型通道+自定义模型）**：通道正常时折叠为一行摘要（"6 条通道，凭据全部就绪"），异常自动展开完整卡片；搜索框 + 状态/通道/能力筛选 + 排序 + 匹配计数；紧凑表格行（桌面）→ 卡片（移动端）；删除收进次级菜单，确认弹窗机制不变。
3. **模型弹窗（#model-dialog）**：三步——①选择/创建服务通道 ②模型信息与能力 ③影响/预检/保存。专家字段（正则匹配、认证头名称、认证方式、状态共享域、上游协议细节、响应字节上限）放入默认折叠的"高级选项"。已有通道优先显示可读摘要，不默认展开底层配置。
4. **高级设置（#configuration，原路由配置）**：手风琴分组——本机服务 / 网络与代理 / 超时 / 上下文与输出预算 / 长任务与检查点 / 图片处理 / 服务通道。每组默认显示当前状态摘要，点"编辑"才展开控件。服务通道默认只显示名称/地址/接口类型/连接方式/凭据是否就绪，编辑单条通道才展开完整字段。数字同时给易读单位（600000ms→"10 分钟"、1073741824 bytes→"1 GB"、1000000 tokens→"100 万 tokens"），不改实际提交值。
5. **检查点（#checkpoints）**：数量为 0 时只是一行内联摘要，不占大区域；有数据时才显示完整面板。

## 视觉方向

简洁可靠现代的专业桌面工具；降低大标题与装饰；清晰密度与留白；一个视图一个主操作；危险操作独立警示层级；状态同时有文字/图标（不仅颜色）；浅色与深色都有足够对比度；动效简短克制并支持 `prefers-reduced-motion`。

## 移动端要求

验证 390 / 768 / 1280。必须：可用导航菜单（不隐藏全部导航）、无横向滚动、主操作易点击、弹窗可完整滚动、表单标签/帮助/错误不截断、不需滚动数万像素找高级功能。

## 工作进度（勾选更新）

- [x] 阅读全部前端源码 + 管理页测试，确认行为约束与测试锁定
- [x] 创建本改造文档 + 登记持续推进 goal
- [x] `web/index.html`：静态资源缓存版本号 `20260810` → `20260813`
- [x] `web/app.js`：新增易读单位格式化（`formatBytes` 扩 GB、`compactNumber`、`formatSecondsShort`、`humanNumber`）——纯展示，不改提交值
- [x] `web/app.js` 外壳 `renderShell()`：紧凑页头替代 Hero；桌面导航 + 汉堡移动菜单（`#mobile-menu`、`toggle-menu`、`aria-expanded`）；总览区改状态卡片骨架；模型管理区加入 `#channel-summary`/`#channel-grid`/`#model-filter-bar`（搜索/状态/通道/能力/排序/计数）；高级设置区改名+说明；检查点区保留刷新
- [x] `web/app.js` `bindEvents()`：新增 `toggle-menu`/`goto-models`/`goto-advanced`/`goto-checkpoints`/`toggle-channels`/`toggle-config-group`/`toggle-target-editor`/`model-clear-filters` 分发；模型行主区点击进入编辑；5 个筛选/排序控件 input/change 监听；`toggleMobileMenu()`/`gotoSection()` 方法；构造函数加 `modelFilters`/`channelsExpanded`/`openConfigGroups`/`openTargetEditor`
- [x] `web/app.js` `renderOverview()`：状态卡片（服务/模型/告警/生效状态），异常卡片警示层级+跳转
- [x] `web/app.js` `renderChannels()`：正常折叠为 `#channel-summary` 摘要行、异常/手动展开完整卡片
- [x] `web/app.js` `renderModelRouting()`：紧凑 `model-row` 列表 + 搜索/状态/通道/能力筛选 + 排序 + 匹配计数 + 空态/无匹配态；删除保留为次级 `danger-outline` 按钮，确认弹窗机制不变
- [x] `web/app.js` 模型弹窗：三步（第一步通道/第二步模型信息/第三步预检保存说明）；协议、上游接口、认证方式、认证头收进默认折叠 `route-advanced-details` 高级选项
- [x] `web/app.js` `renderConfig()` + 各分组：`configGroup()` 手风琴（本机服务/网络与代理/超时/上下文与输出预算/长任务与检查点/图片处理/服务通道），默认摘要 chips + “编辑”展开；`configChannelRow()` 通道默认只显示名称/地址/接口/连接/凭据，单条“编辑通道”展开 `targetEditor`；`numberField` 标签旁加 `field-label-human` 易读单位（`humanNumber`）
- [x] `web/app.js` `renderCheckpoints()`：0 时 `checkpoint-inline` 内联摘要，有数据时保留完整面板
- [x] `web/styles.css`：整体重写为克制工具型设计系统（含浅/深色、`prefers-reduced-motion`、移动端、保留测试锁定选择器）
- [x] 运行 `npm test`：570/570 通过
- [x] 真实浏览器验证 1280/768/390：无控制台错误/警告、无横向溢出、预检/保存/编辑/删除/撤销/冲突提示可用
- [x] 输出修改文件清单 + 验证结果 + 前后差异说明

## 关键实现注意

- 不改 `config-state.mjs` / `model-routing-state.mjs` 的状态机与序列化。
- 配置手风琴展开状态保存在内存（`openConfigGroups`/`openTargetEditor`），重新渲染后保持；预检/保存逻辑读的是 `configState` 而非 DOM 可见性，折叠不影响提交。
- 易读单位仅用于摘要/标签旁注，`input[type=number]` 的值仍是原始毫秒/字节/tokens。
- 模型删除仍走 `openDeleteModelDialog(slug)` → `pendingDeleteSlug` → `deleteModelDraft()`，只是入口按钮从卡片常驻改为次级菜单。
- 保持 `data-action` 命名与 `bindEvents()` 分发的幂等（重复 render 后用事件委托，不重复绑定）。

## 最终验证记录（2026-08-13）

验证使用隔离路由 `http://127.0.0.1:15799/admin/` 和配置副本；没有访问、修改或重启用户正在使用的 15730 实例。

- 自动测试：`npm test`，570 个测试全部通过；`node --check web/app.js` 与 `git diff --check` 通过。
- 1280 × 900：页面高约 3567px（原约 16115px，降低约 78%），桌面导航可用，`scrollWidth === innerWidth`。
- 768 × 900：页面高约 4035px，桌面导航切换为汉堡菜单；菜单 `aria-expanded` 正确变化，选择导航项后自动收起，无横向溢出。
- 390 × 844：页面高约 7765px（原约 30150px，降低约 74%），`scrollWidth === innerWidth === 390`；模型弹窗约 350 × 826，可完整滚动。
- 浅色与深色均做真实浏览器截图核验；深色媒体查询实际生效。最终页面控制台为 0 error / 0 warning。
- 可访问性：标题层级为 H1 → H2 → H3；交互控件均有可访问名称；模型弹窗取消后焦点返回原“编辑”，删除确认取消后焦点返回原“删除”。
- 核心流程：配置预检/保存、模型预检/影响摘要/保存、编辑、删除确认、草稿撤销、revision conflict、放弃草稿重载、双基线重新同步和保存后手动重启提示均已在隔离实例中验证。
- 安全边界：没有 API Key、Token、Authorization 等凭据输入框；动态 API/用户文本继续通过 `textContent`、`value` 或安全节点 API 写入。模型通道普通摘要不再展示正则匹配规则，专家字段仍保留在高级编辑区。

最终截图位于 `output/playwright/`：`final-1280-light.png`、`final-768-light.png`、`final-390-light.png`、`final-390-dialog-light.png`、`final-1280-dark.png`。

## 健康状态语义纠偏（2026-08-13）

- 总览只声明可直接证明的状态：`路由进程 / 在线`；不再用“服务运行中”暗示上游可请求成功。
- 模型与通道正常态统一补充“未探测上游”；配置或环境变量存在只表示配置就绪，不表示真实连通性。
- 生效状态明确区分“当前进程已加载”和“已保存，待重启”，避免把磁盘保存结果误写成运行进程已采用。
- 高级设置的通道凭据采用三态：运行时目标明确存在且 `envSet=true` 为“已配置 · 未探测”，明确为 false 时为“待配置”，运行时缺少对应目标时为“待确认”。
- 不修改管理 API 响应结构，不增加主动模型探测、真实上游请求或 token 消耗。

隔离只读浏览器验证从当前工作区 `web/` 提供静态资源，并使用内存 mock 响应；没有读取活动配置、访问真实供应商或操作 15730 服务。

- 1280 × 900：`scrollWidth=1265 <= innerWidth=1280`，页面高 3405px；桌面导航显示、移动菜单隐藏，新文案出现且旧文案消失。
- 768 × 900：`scrollWidth=753 <= innerWidth=768`，页面高 3792px；汉堡菜单显示，四个导航入口完整，`aria-expanded` 从 false 正确切换为 true。
- 390 × 844：`scrollWidth=375 <= innerWidth=390`，页面高 7475px；主操作高度 40px，菜单入口高度 43px，未发现越界交互控件。
- 三个宽度控制台均为 0 error / 0 warning；运行态缺少对应目标的通道实际显示“凭据状态待确认”并使用文字与未知状态图标共同表达。
