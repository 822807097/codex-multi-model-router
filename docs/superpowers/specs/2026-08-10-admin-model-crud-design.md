# 本地管理面板自定义模型 CRUD 设计

## 状态

已批准。用户选择推荐方案：以易理解、易操作为第一目标，把模型目录条目与路由通道包装成一个“自定义模型”管理体验。

## 背景

当前管理页只能编辑 `config.json` 中已经存在的 `targets[]`，不能新增或删除通道，也不能管理决定 Codex 模型菜单内容的 `models.json`。用户要新增一个可用模型，实际上必须同时维护两份文件：

- `models.json`：决定模型是否出现在 Codex 模型菜单、显示名称、输入模态和上下文参数。
- `config.json`：决定模型请求命中哪个供应商、使用哪种协议、是否走代理以及凭据环境变量名。

只管理其中一份会产生“菜单能看到但请求无法路由”或“通道存在但菜单无法选择”的半配置状态。因此 CRUD 必须把两份配置作为一个业务对象联合管理。

## 目标

1. 在 `/admin` 中提供自定义模型列表和明显的“新增自定义模型”入口。
2. 支持模型及其关联通道的新增、编辑和删除。
3. 默认流程只暴露普通用户能理解的字段，高级路由字段折叠显示。
4. 联合预检 `models.json` 与 `config.json`，在保存前展示错误、警告和删除影响。
5. 用两份 SHA-256 revision 防止页面覆盖外部修改。
6. 通过可恢复的双文件事务避免永久半更新。
7. 浏览器不读取、提交或移动任何 API Key、Token、OAuth 数据或静态敏感请求头。
8. 保存后只提示人工重启路由和 Codex 桌面端，不在管理页控制进程。

## 非目标

- 不在页面中创建或修改系统环境变量，只填写 `envKey` 名称并显示是否就绪。
- 不提供 API Key 输入框。
- 不自动调用供应商 API 验证 Key。
- 不把本地管理页扩展成公网或多用户后台。
- 不自动重写任意用户正则；只有向导生成的精确模型正则可以安全自动更新。
- 不引入 npm 包、数据库或前端框架。

## 方案比较

### 方案 A：模型与通道联合向导 + 可恢复联合事务（采用）

用户管理一个“自定义模型”，后端用实体操作同时维护模型目录和路由通道。优点是最符合用户心智、能做联合引用检查、敏感字段不会因数组重排而错位；代价是需要事务日志和更完整的测试。

### 方案 B：分别提供 models.json 与 config.json 两套 CRUD

实现更快，但用户必须理解两个文件并手工保持一致，顺序保存失败会产生半配置，不满足本目标的易用性和原子保存要求。

### 方案 C：把 models.json 改成由 config.json 自动生成

长期只有一个数据源，但会改变现有公开配置格式、破坏未知目录字段和手工维护习惯，迁移风险过高，不适合作为这次增量功能。

## 用户体验

### 模型管理区

在现有“模型通道”之后增加“自定义模型”区：

- 标题右侧是主按钮“新增自定义模型”。
- 每张卡片显示：显示名称、slug、协议、供应商主机、直连/代理、视觉类型、凭据是否就绪、关联通道数。
- 卡片提供“编辑”和“删除”。
- 多通道模型在卡片中列出所有命中通道，编辑时可选择具体通道。
- 未命中任何通道的目录条目标红并提示“模型已显示但无法路由”。

### 新增向导

向导分两步，但在一个对话框中完成：

1. **模型菜单信息**
   - 必填：显示名称、slug。
   - 常用：说明、上下文窗口、自动压缩阈值、是否允许图片。
   - 默认：`visibility=list`、`supported_in_api=true`、文本输入、工具调用开启。
2. **API 通道**
   - 默认选择“创建专属通道”；也可以选择“复用已有通道”。
   - 必填：通道名称、供应商主机、协议格式、凭据环境变量名。
   - 常用：路径前缀、直连/代理、原生视觉/视觉中继。
   - 高级：platform、HTTP/HTTPS、端口、Chat 路径、固定上游模型、状态域、认证类型、认证头名称、额外透传头名称。

专属通道的 `match` 默认由 slug 生成转义后的精确正则，例如 slug `glm-4.7` 生成 `^glm-4\.7$`。页面不提供 `headers` 或密钥输入。

点“应用到草稿”后才进入联合 dirty 状态；关闭或取消向导不会污染页面草稿。

### 编辑

- 使用与新增相同的表单，保留目录条目和 target 中未展示的未知字段。
- 修改 slug 视为“新 slug 替换旧 slug”，显示醒目警告。
- 如果关联通道是向导生成的精确正则，slug 改名时可一并更新；共享或宽正则只做匹配预检，不进行字符串替换。
- 精确数组引用 `modelContext.slugs`、`supportsResponses.slugs` 在改名时一并更新。
- 通用 `modelCapabilities[].match` 不自动重写；改名后不再匹配时给出警告。

### 删除

删除必须经过二次确认，并明确列出：

- 将删除的模型目录条目。
- 将清理的精确 slug 引用。
- 是否存在可安全删除的专属通道。
- 哪些共享或宽正则通道会保留。

默认只删除模型目录条目。仅当某个 target 的正则只匹配该 slug、删除后不影响其他目录模型时，页面才默认勾选“同时删除专属通道”。共享 target 不会静默删除。删除操作先进入草稿，保存前可以撤销。

如果用户单独删除 target，导致任一保留模型没有任何可用通道，联合预检必须拒绝；用户可以在同一草稿中重新绑定通道或同时删除相应模型后再保存。

### Dirty 与保存反馈

- 模型 CRUD 草稿与现有高级配置草稿互斥：一侧有未保存修改时，另一侧的编辑入口给出清晰提示，避免两份 config 副本相互覆盖。
- 页面显示“models.json + config.json 共 2 处未保存”。
- “联合预检”成功后才允许联合保存。
- revision 冲突时不覆盖磁盘，提示重新载入并重新应用修改。
- 保存成功后清空两个 dirty 基线，显示“需要人工重启路由并重启 Codex 桌面端”。

## 数据模型和 API

### GET `/_admin/api/model-routing`

返回：

- `configRevision`、`catalogRevision`：基于两个文件原始字节的 SHA-256。
- `models`：目录条目的隔离副本，保留未知字段和数组顺序。
- `targets`：已脱敏、仅包含可管理非敏感字段的通道视图。
- `targetRef`：只在当前 config revision 下有效的不透明引用，避免浏览器使用可变数组下标作为身份。
- `bindings`：每个 slug 当前命中的 targetRef 列表。
- `references`：精确数组引用及正则能力规则的影响信息。
- `envSet`：只表示环境变量是否设置，不返回变量值。

管理 API 的 catalogPath 只能来自启动预检后的入口注入，浏览器不能提交或选择任意文件路径。

### POST `/_admin/api/model-routing/validate`

请求包含双 revision 和实体操作数组。后端在当前原始文件的内存副本上应用操作，返回：

- `errors`：阻止保存的问题。
- `warnings`：不阻止保存但需要用户理解的问题。
- `impact`：新增、修改、删除的模型、通道和精确引用清单。
- `confirmation`：删除影响的一次性确认令牌，仅绑定当前双 revision 与操作摘要。

### PUT `/_admin/api/model-routing`

请求包含双 revision、同一操作数组和需要时的 impact confirmation。后端重新读取两份文件并核对 revision，在未脱敏的原始 config 上应用受限操作，浏览器不回传完整敏感 config。

操作类型限定为：

- `model.create`
- `model.update`
- `model.delete`
- `target.create`
- `target.update`
- `target.delete`
- `reference.replaceSlug`
- `reference.removeSlug`

每个 patch 只接受白名单字段；未知字段通过基于原对象修改的方式保留。创建 target 禁止 `headers`、`auth`、API Key 值或其他凭据正文；更新 target 不能修改或删除既有敏感头。

## 校验规则

### 模型目录

- 根必须是普通对象，`models` 必须是数组。
- 每项必须是普通对象。
- slug 必须是非空、无控制字符且长度受限的唯一字符串。
- display_name 必须是非空字符串。
- input_modalities 只能包含受支持的字符串并至少包含 `text`。
- context、compact、priority、百分比等已知数值执行有限数和范围校验。
- 未知根字段、未知模型字段、`_comment`、数组顺序原样保留。

### 路由配置

- 最终 config 继续使用 `inspectRouterConfig()` 完整预检。
- 每个保留的目录 slug 至少命中一个最终 target。
- 新建专属 target 的精确正则不能误命中其他 slug。
- 删除 target 后不能让保留模型失去全部通道。
- input_modalities 含 image 且 target `vision=false` 时必须有合法视觉中继配置；`vision=true` 表示原图透传。
- envKey 只校验变量名并返回是否设置，不读取或返回值。

## 敏感字段边界

- 页面不接收或展示 API Key、Token、Cookie、OAuth 登录态、静态 Authorization 或自定义认证头的值。
- targetRef 在双 revision 变化后失效。
- 所有 target 更新和删除都在服务端当前原始 config 上按 targetRef 执行，敏感字段不会经过浏览器，也不会因数组 splice 导致占位 pointer 串位。
- 新增或修改只允许填写 `envKey`、`authType`、`authHeader` 名称；不允许提交 `headers` 或 `auth` 对象。
- 现有高级配置 API 的占位机制保持不变，模型 CRUD 使用独立实体操作接口。

## 可恢复双文件事务

`config.json` 与 `models.json` 可能位于不同目录或卷，文件系统无法提供真正的跨文件瞬时 rename。实现采用可恢复事务，保证管理 API 不把半更新报告为成功，并在下次启动或管理请求时完成恢复：

1. 获取进程内模型配置单写锁。
2. 如果存在未决 journal，先根据 hash 和 phase 恢复。
3. 有界、严格 UTF-8 读取两份文件，拒绝两个解析路径指向同一文件。
4. 核对双 revision，在内存应用操作并完成联合预检。
5. 在两个目标文件各自目录写 UUID 临时文件，刷新文件内容到磁盘。
6. 在 config 同目录写 journal，记录 txid、旧/新 hash、临时文件、备份文件和提交阶段，并刷新到磁盘。
7. 提交前再次读取并核对双 revision；任一变化就删除本事务临时文件并返回 409。
8. 创建两份带 txid 的恢复备份并验证 hash。
9. 依次替换两个文件，每完成一步就更新 journal phase。
10. 验证两个新文件 hash 后标记 committed，返回双新 revision、txid 和 `restartRequired=true`。
11. 第二次替换失败时使用已验证备份恢复第一次；恢复成功返回 `transaction_rolled_back`，恢复失败返回 `transaction_in_doubt` 和 txid。
12. 启动入口在读取配置前检查 journal：两边都是新 hash 则完成提交清理；两边都是旧 hash 则中止清理；单边新则优先使用有效临时文件完成提交，否则从有效备份回滚。

恢复日志只记录路径、hash、阶段和 txid，不记录配置正文或凭据。备份保留最近一次成功事务的一组，旧事务备份有界清理。

## 运行时一致性

当前 `/models` 每次请求都重读目录，而 targets 是启动时快照。联合保存后如果立即热读新目录，会暂时出现“菜单已有新模型但运行路由仍是旧通道”。因此改为：

- 启动时读取并保存活动 catalog 快照。
- `/models` 在本次进程生命周期使用活动快照。
- 管理保存只更新磁盘，不热替换活动 catalog 或 targets。
- 重启路由后两份配置同时成为活动 generation；Codex 桌面端重载后刷新模型菜单。

## 模块边界

- `lib/json-file-store.mjs`：有界严格读取、revision、唯一临时文件、fsync、hash 验证和单文件备份原语。
- `lib/model-routing-plan.mjs`：实体操作、targetRef、模型目录校验、绑定分析、引用影响和联合预检；纯函数为主。
- `lib/model-routing-transaction.mjs`：双文件锁、journal、提交、故障回滚和启动恢复。
- `lib/admin-api.mjs`：HTTP 路由、请求大小限制、一次性确认和错误映射。
- `web/model-routing-state.mjs`：浏览器联合草稿、add/update/delete/undo、dirty 和序列化。
- `web/app.js`：列表、向导、确认对话框、反馈和现有配置编辑互斥。

## 测试与验收

### 自动测试

- 模型目录根结构、slug 唯一性、已知字段范围和未知字段保留。
- add/update/delete/undo 不修改输入；add→delete 恢复 clean。
- 专属/共享/宽正则/多 target 的绑定与删除矩阵。
- slug 改名、精确引用更新、能力正则警告。
- targetRef revision 失效和数组重排下敏感字段不泄漏、不串位。
- 双侧外部 revision 冲突。
- 两个文件的 write、fsync、backup、rename、hash 验证故障注入。
- journal 每个 phase 的启动恢复。
- 成功事务后磁盘双 revision 一致，失败事务不报告成功。
- 保存后旧进程 `/models` 仍使用旧活动快照，重启加载新快照。
- 管理 API 不返回或接受敏感值。

### 真实浏览器

- 初始模型列表与当前目录、通道绑定一致。
- 新增专属模型：表单易理解、默认值合理、应用后 dirty、联合预检和保存成功。
- 新增复用通道模型。
- 编辑显示名、slug 和通道非敏感字段。
- 删除专属模型可连同专属通道；共享通道默认保留。
- 取消向导不 dirty；删除草稿可撤销。
- revision 冲突显示可行动提示。
- 保存成功明确提示人工重启路由和 Codex 桌面端。
- 控制台 0 error / warning；375px 无横向溢出；键盘焦点和可访问名称有效。

### 最终门禁

- 全量 `node --test "test/*.test.mjs"` 通过。
- 所有 `.mjs` 通过 `node --check`。
- `config.json` 和 `models.template.json` JSON 有效。
- README 图片和内部链接有效。
- `git diff --check` 通过。
- 不访问或修改运行版本，不部署、不调用真实供应商、不提交、不推送。
