# 工具契约与请求生命周期

状态：现行契约与实现边界。仓库级规则见 CLAUDE.md；本文定义具体契约、状态归属、恢复窗口与当前实现限制，不将当前限制作为未来功能排除项。新功能按 [临时 spec 约定](README.md#按功能的临时规格) 推进。真实服务联调和云端验收独立于本地自动化验证。

## 工具契约

工具直接使用 pi durable 的原生定义，不另建插件协议。每个工具定义包含名称、用途、参数 schema、执行函数、结果与中断重放策略。

参数 schema 使用底座支持的 TypeBox，推导静态参数类型并在执行前验证。明确必填项、可选项、单位、范围与未知字段策略。schema 验证后，执行器仍需检查权限、资源是否存在和其他业务条件。

凭据、已认证用户、工作目录和服务客户端属于宿主上下文，不能由模型参数指定。工具负责将外部 API 格式转换为内部概念，并按底座原生结果契约返回。

### 注册元数据

`createToolRegistry()` 仍实现底座原生 `Registry` 接口，安装入口统一检查工具名冲突（包括启动后安装的 extension）。同名 extension 按底座语义整体替换；先验证新注册，失败不发布任何变更。

宿主通过只读 `lookup(name)` 和 `records()` 查询注册记录。未知或已卸载工具返回 `undefined`；记录及其 source 不可修改。字段由宿主或适配器提供，不加入模型参数、工具声明或工具结果：

| 字段 | 语义 |
| --- | --- |
| source | 内置工具记录 `kind: builtin` 与 extension；MCP 适配器记录 `kind: mcp` 与 server。预留 plugin 来源，不提供插件加载器。 |
| tier | 原生 `deferred` 工具为 2，其余为 1；启动结算通过的 MCP pin 去掉 `deferred`，成为常驻工具。 |
| trust | 内置工具为 trusted，MCP 工具为 untrusted；外部描述不成为可信指令。 |
| replay | 原生工具策略，未声明时为 unsafe；不从 authz 推断重放安全性。 |
| authz | read 或 write。内置查询与搜索工具为 read，其余保守标记 write；MCP 默认 write，仅宿主配置可逐个覆盖，不采信外部 annotations。执行时与宿主权限复核。GitHub 条目由宿主策略强制 read，且拒绝 `authz: "write"`。 |
| githubApproval | 仅 GitHub 工具记录：来自独立批准基线的规范化指纹，包含批准版本。启动目录比较、加载账本快照与恢复闸口使用该指纹；缺省表示非 GitHub 工具或旧记录。 |
| schemaHash | 参数 schema 的 SHA-256，小写十六进制。对象键递归排序、数组顺序保留，不含 TypeBox symbol；只记录，不处理版本漂移。 |
| state | available、unavailable 或 disabled。MCP 连接状态按 server 批量更新；内置工具安装后为 available。宿主 `setDisabled(name, boolean)` 只在当前进程禁用工具，优先于健康状态；解除禁用后恢复当前连接状态，不因健康恢复自动启用。 |

加载账本与注册目录使用同一个 `agent.sqlite` 的底座 document 存储，不新增数据库表或文件。`withToolLedger()` 在 `Harness.open` 前迁移存量会话，保存当前注册目录；运行时在底座 `Storage.commit` 边界，把 `pi.agent` 的变更与附属账本一次提交。工具搜索及其 `control.addTools` 仍由底座执行。

- `pi.agent.modelTools` 是已加载选择及顺序的唯一来源。账本只保存会话内序号高水位、当前 epoch，以及各工具最近一次加载的元数据；不复制工具声明。`readToolLedger(storage, conversationId, context)` 按原生存储顺序返回加载记录，`readToolCatalog(storage, context)` 返回上次持久化的注册目录。
- 初始高水位和 epoch 为 0。一次原生提交中追加一个或多个新名称，epoch 增加 1，新增名称按追加顺序取得连续的 `loadSequence`；同批共享 epoch。重复加载、已完成请求重放、相同配置重启、reset 和 compaction 不增加编号。删除后再次加入的名称取得更大的序号；历史高水位不回退。仅移除或重排不增加 epoch。启动结算的常驻 MCP 集合变化则在上下文边界增加一次 epoch，保留已有加载序号与注册快照；自动常驻工具不另造一份 `modelTools` 选择。
- 对象形式按原始 `modelTools.add` 记账，包括当前未注册或被 remove 遮蔽的名字；状态及展示过滤仍由底座负责。显式数组形式按完整选择顺序记账，包含调用方显式选择的常驻工具；未显式选择的常驻工具不分配加载序号。
- 旧会话缺少账本时，按已保存名称顺序去重并补连续序号；非空集合统一使用基线 epoch 1，空集合为 0。无法恢复过去的追加批次，不能把补录值当作真实历史纪元。加载时保存注册快照；迁移时找不到工具则快照为 null，不伪造来源。之后重启或移除注册不重写旧快照。
- 附属账本为 conversation / rewindable / asOf 文档，分叉沿用对应历史点；若分叉点早于迁移，则从该点原生选择重建基线。新建非分叉会话按其初始选择独立编号。注册目录是 session 文档，启动时由代码与 MCP 适配器重建，最终常驻集确定后显式同步；即使配置无变化、不产生上下文写入，启动返回时目录也与最终注册一致，目录同步不增加声明 epoch。运行期注册变化在下次原生存储提交时同步。
- 这些附属文档由存储适配层独占读写，必须经上述只读函数访问，不经 Session 的 `tx.doc`、snapshot 或 watch API。pi durable 1.3.0 无通用事务扩展钩子，Session 不发布适配层追加的文档变更，混用会读到过期缓存。适配层只接受该固定版本 `pi.agent` 的完整 checkpoint，格式不兼容时显式失败。

### 手动 pin 与声明边界

`mcp.json` 顶层 `tools` 是按注册名索引的对象（最多 800 项），每项允许 `pin: boolean` 和 `authz: "read" | "write"`，至少设置其中一项，未知字段拒绝；未设 pin 等同未请求晋升，未设 authz 的 MCP 工具默认 write。GitHub 工具是例外：`pin: true` 与 `authz: "write"` 都会使整个 GitHub 条目配置失败，首期无 GitHub pin。`residentToolBudgetTokens` 默认 8192，范围 1～1048576。参数校验及默认值以 `src/mcp-config.ts` 为准。配置是宿主输入，不读取远端 annotations，不允许模型调用注册或晋升接口。

启动时健康快照先进入 Register，`installMcpTools()` 按 extension 名及工具注册名固定排序，再按注册名依次验证 pin 的存在性、available 状态和剩余预算。预算按 `estimateTextTokens(JSON.stringify(declarations))` 计算，声明通过原生 `toToolDeclaration()` 转换，包含内置、记忆、搜索工具及接受的 pin 的 name／description／parameters 等模型字段；使用 pi-ai 1.3.0 的字符估算，与提供商精确 token 数有差异。基础集合已超预算时拒绝所有新增 pin，不移除内置工具。失败记录 `TOOL_NOT_FOUND`／`TOOL_UNAVAILABLE`／`TOOL_BUDGET_EXCEEDED`；已注册且可用的 MCP 工具仍可按需搜索。

当前实现只在启动结算，不监听配置文件、自动晋升或自动降级。底座开启后尚未恢复调度时，先初始化记忆并补扫已发布压缩，持久化归档目标，避免 pin 切换覆盖尚待确认的上下文头；再检查未完成任务（包括补扫新建的归档任务）、提交，以及记忆投影已落盘但输入尚未接收的请求；投影收据通过原生提交记录分页读取，不复制另一套请求状态。有未完成工作则按账本恢复旧常驻集，延迟新配置到下一次空闲重启，记录 `TOOL_PIN_RECOVERY`；恢复旧集不重新套用新预算或因掉线撤销已发出的声明。没有未完成工作且集合改变时，在一次原生提交中追加 `pi.reset` 上下文头并结算账本 epoch／resident 字段，下一请求发布完整基线，旧记录保留。此边界不启动任务，也不取消未完成请求；初次 pin 从 epoch 0 到 1，无变化重启不增加。`resident` 是常驻决策元数据，缺省等同旧版本的空集合，由存储适配层管理，可通过 `readResidentTools()` 查询。

晋升仅去掉原生 `deferred` 属性，保留工具参数、执行函数、健康拦截、`replay`、trust 和 authz。默认会话选择因此自动包含常驻工具；底座显式 `tools`／`modelTools` 过滤仍有优先权。取消 pin 不删除原生已加载选择，过去由搜索加载的工具不会自动卸载。所有 pin 配置改动均需重启，健康状态仍实时变化且不增加声明 epoch。

### 执行复核与宿主权限

`createToolRegistry(extensions, { authority, log })` 在每个原生工具执行函数外统一复核 Register，顺序为精确名称存在、state 为 available、当前权限足够，然后才进入工具实现。取消信号先检查；参数修复和参数校验仍由底座执行，参数不合法时不会到达复核执行器。内置、MCP、后装工具和 `api.executeTool()` 嵌套调用共用此边界。安全重放进入执行函数时再次使用当前状态和权限；unsafe 工具仍按底座规则报告执行结果未知，不因权限变化重跑。

权限由宿主固定为 `owner`（默认，可执行 read 和 write）或 `restricted`（仅 read）。生产 `openAgent()` 通过 `toolAuthority` 注入，作用于整个实例的所有会话、任务及恢复；模型参数、MCP 描述和 annotations 均不能提升权限。现有 dashboard 控制台入口通过宿主 Web Token 认证，使用默认 owner。当前只预留受限实例入口，尚未实现请求间动态切换、多级身份系统或破坏性操作二次确认。authz 配置在启动时应用，包括未完成任务的后续执行；它不改变工具声明字节、加载编号、epoch、trust 或 replay。

| 拒绝原因 | 结果与恢复提示 |
| --- | --- |
| 名称未注册 | 原生分发按精确名称返回 `Tool <name> is not available`，不执行、不模糊匹配；复核日志记 `TOOL_NOT_FOUND`。 |
| unavailable | `TOOL_UNAVAILABLE`，提示恢复服务并重启连接；未发送调用。 |
| disabled | `TOOL_DISABLED`，提示请所有者启用；未发送调用。 |
| restricted 调用 write | `TOOL_AUTHZ_DENIED`，提示由所有者执行；不进入工具实现。 |

执行器拒绝返回原生 `isError`、文本恢复提示、`details.code` 和 diagnostic。底座 1.3.0 对未向模型提供的名称会直接拒绝而不创建工具任务，应用通过 `GenerationTask.afterResponse` 观察未知名称；嵌套未知名称在转交原生 `executeTool()` 时记录。两者保留底座的错误结果与调用关联，不自建工具任务或绕过参数校验。已注册但被原生会话过滤排除的工具继续由底座拒绝。

`tool_review` 日志使用 JSON 行，默认 stderr，宿主可注入 logger；包含 conversationId、taskId、callId、注册名（最多 128 字符）、authority、可取得的 authz／state、allow／deny 及原因码，成功复核为 `TOOL_ALLOWED`。未知嵌套名称日志的标识指向发起调用的父工具，其他执行日志指向实际工具任务。日志不含参数、凭据或工具结果，也不承诺重启后恰好记录一次；它是未来 Trace 的接入点，不另建持久化审计数据库。

### 结果与失败

面向模型的结果描述实际发生的事情。需要程序继续处理时，保留有明确定义的结构化结果；普通文本工具无需为统一外形增加重复的 JSON 包装。

以下是语义分类，不额外宣称底座具有同名状态字段：

| 情况 | 处理责任 |
| --- | --- |
| 参数不合法 | 不执行，返回校验问题，允许模型修正参数 |
| 已知业务失败 | 返回可理解的业务原因，由模型决定是否调整计划 |
| 基础设施失败 | 由适配层决定是否可重试，保留可诊断原因 |
| 取消或超时 | 传播取消信号；分别确认任务是否停止、外部副作用是否已发生 |
| 结果未知 | 不标记为成功，也不假定没有执行；通过查询或幂等机制核对 |

一次工具失败可以被 agent 修正，不自动等价于整个用户请求失败。

### 重放与并发

重放安全与返回值完全相同是不同要求。时间查询可再次执行但结果会变化；向文件追加内容再次执行可能造成重复。

工具默认保守对待有副作用的操作。只有重复执行不会造成不正确的副作用时才声明可安全重放。底座恢复同一次工具调用，与模型在后续回合发起一个新的工具调用，是两种情况；仅靠恢复设置不能阻止语义重复。

如果下游支持幂等键，由宿主生成并持久化稳定操作标识，在同一次操作的重试中复用；不能让模型随机生成。

对同一文件的写入需要明确的顺序或互斥机制，不能仅凭应用层只运行一个用户请求，就推断同一回合里的工具一定顺序执行。

### 工具凭证

工具静态凭证由部署环境提供：控制台 Web Token、模型 API key 与 MCP 配置中的 `${ENV}` 引用都从应用进程环境解析，真实值只存在于部署的 env 文件中。应用不将秘密写入工具参数或 durable 状态。凭证的存放与权限（例如 env 文件 600 权限）由部署负责，应用只做存在性与形状校验。

凭证错误不改变业务重放语义；刷新或轮换凭证不能成为重放未知写入的理由。MCP 外部 OAuth 继续使用下文的宿主 token 状态，属于本轮接入保留的独立认证流程。

### MCP 工具

MCP 工具由入口配置声明，不由模型注册。`src/mcp-config.ts` 在边界校验文件、解析 `${ENV}` 并返回纯配置；`src/mcp.ts` 负责连接、发现工具和适配到底座原生工具契约。

- 启动时按配置并行连接 server。单个 server 失败只记录安全错误码并跳过，不阻止 bot 启动。`connectTimeoutMs` 默认 10s；超时以 `MCP_TIMEOUT` 记录，并关闭客户端以回收子进程或请求。
- 每个 server 安装一个 extension，名称为 `mcp-server-<server>`；汇总 section 的 extension 名为 `mcp-servers`，两者不会因 server 命名而重名（同名 extension 是替换语义）。
- 工具名为 `mcp__<server>__<tool>`，清洗为 `[A-Za-z0-9_-]`、总长 ≤64；截断和冲突后缀只由 server 名与原始工具名决定，因此重启后能定位同一工具。清洗后同名的整个碰撞组均使用原始身份哈希后缀，新增同组工具不会接管旧工具的注册名或宿主配置。
- 所有工具 `deferred: true`。系统提示渲染启动发现的 server 与工具数量，模型通过 `tool_search` 加载；至少有一个工具时才安装 `tool_search`。该汇总为启动快照，健康翻转不重写提示。工具描述来自外部 server，视为不可信数据，不能作为放宽权限的依据。
- 连接与 host 的 `subscribeAvailability()` 同步报告当前状态，再推送变化，避免发现期间关闭或晚订阅漏掉状态。host 按 server 去重，`openAgent()` 将状态交给注册表的 `setMcpAvailability()`，一次批量更新该 server 的不可变工具记录；重复状态不触发通知。恢复事件自动使工具重新可用。
- `tool_search` 仅在原生候选投影中保留 available 工具，排名、参数校验与加载控制仍由底座完成。健康翻转不卸载工具、不替换原生注册快照、不修改已发出的 tools 声明，也不改变加载序号、epoch 或历史加载快照；当前注册目录在下次原生存储提交时同步。
- 已加载 MCP 工具在实际发送前读取最新状态；unavailable 时返回原生 `isError: true` 结果：`output` 说明调用未发送，`details` 为 `{ code: "TOOL_UNAVAILABLE", server, tool }`（tool 为注册名），`diagnostics` 含同名错误码。不调用 MCP，不暴露底层连接异常。参数仍先经过底座校验，取消信号在检查处生效。已经发送的调用不改写为“未执行”。
- 参数 schema 必须缺省或为 `type: "object"`、深度 ≤12、属性总数 ≤256、不含 `$ref`，并通过 TypeBox 编译；深度检查先于字节检查，因为序列化本身是递归的。序列化 ≤16 KiB；不满足则跳过该工具。执行前的参数校验仍由底座完成。
- `replay: "unsafe"`；`outputLimits` 为 32 KiB、1000 行、保留头部。`execute` 把 `context.abortSignal` 传给 MCP 请求，结果经 `toLlmContent` 转为底座内容类型；底座只约束文本，因此单张图片超过 4 MiB 时替换为文字说明，避免不受限的数据进入持久化会话。`isError` 保留为工具结果失败。异常映射为 `MCP_TIMEOUT`、`MCP_CLOSED`、`MCP_PROTOCOL`、`MCP_AUTH_REQUIRED`、`MCP_HTTP_<status>` 或 `MCP_FAILED`，不携带 header、args、env、stderr 或 server 消息。
- stdio 子进程使用 `inheritEnv: false` 加允许列表（`PATH` 等运行所需变量），再合并配置的 `env`；stderr 只保留有界缓冲，不写日志。日志只有 server 名、工具数量和错误码。
- 列工具自行翻页，每 server 100 个工具、10 页，且整次发现限时 30 秒；不调用会跟随全部分页的 `listTools()`。发生截断时记录日志，不静默丢弃。GitHub 更严格：达到 100 工具、10 页、任一无效应答或分页未结束都视为发现不完整并停用，不取“前 100 个”。
- HTTP 响应体按 1 MiB 上限读取（传输层只约束 SSE 事件，JSON 响应整体读取）。GitHub 对 JSON/SSE 使用同一累计预算，超限取消 reader 并停用。
- GitHub 例外：只注册独立批准基线中的 12 个精确原始身份，名称为 `mcp__github__<raw>`，全部 `authz: "read"`、deferred、不 pin。启动比较先于持久化目录覆盖、模型工具发布、pin 结算与恢复调度；无基线、集合/声明/策略漂移、发现被过滤或截断都停用整个条目并保留候选供人审阅。每次业务 `tools/call` 前在同一并发闸口内先做一次最多 10 秒的 `tools/list` 对账，GitHub 业务并发为 1，忙时直接拒绝而不排队，单次调用总限时 60 秒。策略/参数拒绝明确未发送；发送后失败保留“可能已发送、远端终态未知”，不自动重试。错误码为 `GITHUB_*`（策略、批准、对账、结果预算）或既有 `MCP_*`；结果只接受文本 block，非文本或超限响应以 `GITHUB_RESULT_REJECTED` 失败。完整契约见 [GitHub 只读接入](github-access.md)。

关闭顺序：先关闭底座（取消工具上下文），再解除应用健康订阅并关闭 MCP host。host 先解除连接事件订阅、将状态置为 unavailable，再关闭连接（stdio 先关 stdin，超时后终止进程组），避免重复断线日志或迟到的恢复事件。顺序反过来会让正常停机被记录成工具失败。

恢复：MCP 工具永不自动重放。启动时不可用的 server 不安装工具，遗留调用在恢复中表现为工具不可用；运行时已经发送的调用遇到连接关闭仍以 `MCP_CLOSED` 失败，已知不可用时的新调用按上述契约拦截。当前 SDK 最终关闭后必须重启创建新连接；本应用不为一般 server 增加重连、ping 探活或运行期 `listTools` 对账（GitHub 的逐次对账见上）。改名、改 schema 或删除 server 都是不兼容变更，需要先收敛未完成调用。

OAuth token 归宿主，保存于 `DATA_DIR/mcp-oauth/<server>.json`（`0600`、临时文件后原子替换），不进入模型上下文、工具参数或日志。一次写入失败只影响该次调用，不使后续读写持续失败。bot 只读取和刷新；交互授权由 `npm run mcp:auth` 在独立进程完成，bot 不监听回调端口。`mcp:auth` 与 bot 通过同一函数解析 `DATA_DIR` 和 `MCP_CONFIG`；配置的 `authorizationServerMetadataUrl` 同时用于 CLI 流程与运行时 401 后的重新授权，避免两者落在不同授权服务器。

该文件同时保存动态注册得到的 `client_id`／`client_secret` 与授权码交换用的 `codeVerifier`。重新注册会让已有授权失效，因此授权流程复用已存客户端信息，不得靠删除文件“重置”状态；只有 `invalid_grant` 或需要换账号时才重新走完整授权。refresh token 轮换要求同一授权只被一个进程刷新：CLI 与 bot 不并发运行，并发 401 在进程内共享一次刷新。

`invalid_grant`（例如授权服务器规定的绝对或闲置期限已到）是终态：清除已存 token，把工具调用报为 `MCP_AUTH_REQUIRED`，由操作者重新授权；不重试同一 refresh token，避免被当作令牌重放而撤销整个授权。

边界：MCP server 与应用同 uid，不构成安全边界；模型可通过 bash 读取进程环境与数据目录。真正的隔离需要独立用户、容器或远端 server。

### 共享执行主机

Computer 工具只经既有 mTLS RPC 调用 Phase 1 共享 CVM Execution Host，提供 `bash` 与 `read`／`write`／`edit`。执行端必须设置 `EXECUTION_AGENT_SHARED_HOST=1`，以专用非 root 用户运行；Bot 使用各自默认工作目录，但共享软件与文件，不提供 OS 级隔离。启动探针失败即拒绝，不回退到控制面执行。保留超时、取消、并发与输出限制，RPC 断线不自动重放，结果未知不能当作未执行。见[共享执行主机 Runbook](runbook-shared-execution-host.md)。

PTC／codemode 已退役，源码、测试与文档只作[历史归档](../archive/ptc-codemode/README.md)。RPC 仍识别旧的 `vm.start`／`vm.reply`／`vm.message`／`tool.call` 方法值，但明确返回 `not_implemented`，只维持帧格式兼容。

## 请求生命周期

区分三种标识：

- requestId：接入层生成，标识一次收到的用户请求，用于重复接收和底座重新提交时定位原请求。
- conversationId：标识连续对话，不随每条消息改变。
- 工具调用标识：底座拥有，用于关联一次工具执行及其恢复，不代替用户请求标识。

相同文本的两次独立发送是两个请求；不能按文本内容去重。多个 bot 或渠道共用存储时，请求标识需要包含相应来源命名空间。

### 状态归属

| 所有者 | 状态职责 |
| --- | --- |
| 接入层 | 已持久化请求、消费位置、身份和路由 |
| pi durable | 请求排队、agent 执行、工具调用、完成/失败/中断及恢复 |
| 投递层 | 已保存回复、发送进度、发送确认、投递失败或结果未知 |
| 作业层 | 后台作业的排队、运行与终态；作业自己的工作记录与工作目录 |
| 通知层 | 已落盘的通知与已读状态。现行只在控制台内；出站通道见 [ADR-0024](adr/background-jobs/0024-long-running-jobs.md) 的后续部分 |

应用不复制底座内部状态机。界面上的“处理中”可从底座状态得出，而不是维护另一份可能失真的权威状态。后台作业是这条规则的唯一例外形状：底座只把 live 任务列在图里，终态任务必须按 id 查，所以作业需要一份用于**列举**的索引投影；它不承担权威，冲突时以 `harness.getTask(taskId)` 为准。

### 正常路径

1. dashboard 控制台验证 Web Token、目标 Bot 状态与输入限制。
2. 宿主生成 `console:<botId>:<uuid>` 请求标识，在本地事务中保存请求后才返回 HTTP 202。
3. 各 Bot 的 worker 按接收顺序向底座提交请求，持续使用同一个 requestId。
4. 底座处理模型和工具循环，产生本次请求的终态。
5. 将最终回复或明确失败提示保存到 inbox；控制台回复直接记为终态 `sent`，不创建分段投递记录。派发后台作业的请求以"已派发 `<jobId>`"作为**本次请求**的终态回复；作业本身在此终态之后继续运行，不占用该等待窗口。
6. 控制台通过历史接口读取会话，通过 SSE 展示实时事件；浏览器连接不是执行状态的权威来源。

### 恢复窗口

| 中断位置 | 恢复方式 |
| --- | --- |
| 本地保存请求之前 | 未确认接收；控制台调用方不能把未收到 202 当作执行成功 |
| 已保存、尚未提交底座 | 从本地 pending 记录提交 |
| 已提交、应用尚未保存底座关联 | 用同一 requestId 找回已有提交，依赖底座去重契约 |
| agent 已完成、回复尚未保存 | 从底座已有结果构建回复，不重新执行任务 |
| 回复已保存、浏览器未看到 | 重新读取历史；不重新执行任务 |
| SSE 连接中断 | 流事件不是持久化收据，通过历史与 Bot 状态核对 |
| 作业已派发、索引行尚未落盘 | 以底座任务为准重建索引行；不重复派发同一作业 |
| 作业终态已提交、通知尚未落盘 | 按 `notices.jobId` 幂等键补写通知，不重新执行命令 |
| 作业运行中进程被杀、重启 | 命令不重放；该作业按 `unknown` 收尾并补写通知，未开始的作业继续运行 |
| 索引行的 `taskId` 为空、底座任务存在 | 补上该任务号（崩溃发生在落行与建任务之间），作业按底座记录继续 |
| 索引行的 `taskId` 与底座任务的归属不一致 | 不猜测也不改写已落下的关联；该作业按 `unknown` + `JOB_TASK_MISMATCH` 收尾，不予代管对方的终态 |

### 后台作业与完成通知

后台作业是底座 `{ background: true }` 任务，不设 `abandonOnRestart`：它不被请求取消标记、不进入空闲等待、任务本身跨进程重启继续被调度，但必须在 abort 协议里提交终态。长期取舍与理由见 [ADR-0024](adr/background-jobs/0024-long-running-jobs.md)，本节只写现行契约。

- 每个作业在自己的工作目录里运行，目录由宿主从 bot 身份派生，不接受模型给出的路径。
- 模型侧只有 `job.start` / `job.list` / `job.status` / `job.cancel`，**没有等待**：等待会把请求重新挂住，退回 300 秒等待窗口。
- 作业进入终态时由宿主**直接落一行通知**（命令、退出码、耗时与输出尾）。控制台读它三处：bot 列表与对话头的未读数、作业面板（完整记录与「标为已读」）、时间线末尾的未读通知文本。落通知不经过模型，因此作业完成的提醒不依赖模型可用，也不消耗一次生成。
- **重启不重放已经开始的命令**：进程被杀时命令可能已经产生副作用，因此重启后该作业以 `unknown` + `JOB_INTERRUPTED` 收尾并如实记录，只有尚未交给执行环境的作业继续跑。没有断点续跑语义的命令（`curl -C -`、`rsync --partial`）不因此变得安全。
- **通知不是回复。** 通知由宿主写、不经过模型；`inbox` 的含义保持"操作者请求"。因此 `AGENT_TIMEOUT` 不等于"这次请求什么都没发生"：被派发出的作业可能仍在运行。模型用自己的话说明结果发生在下一次交互，由 `job.list` / `job.status` 提供事实。
- 作业状态索引表不是权威：与 `harness.getTask(taskId)` 不一致时以底座为准，并把差异记为 `unknown`，不猜终态。
- 作业的命令时长有上限（RPC 传输下由线路派生为 `min(EXECUTION_MAX_TIMEOUT_SECONDS, 3540s)`），超限是作业失败而非进程失控；取消确认执行终态，已提交的外部副作用仍可能发生。

接收、执行与展示状态保持分离。浏览器是否收到响应不保证端到端恰好一次；重新发送文本会生成新的 requestId，不能以内容相同去重。旧 Telegram 的逐段投递状态机与管理 CLI 已移除，既有表和数据保留；结果未知不等于未发送的安全原则仍适用，历史取舍见 [ADR-0007](adr/0007-delivery-not-exactly-once.md)。

### 超时与关闭

停止等待不等于终止 agent。用户取消或执行超时，需要调用底座的取消接口并确认终态；已经提交的外部副作用仍可能发生。

进程正常退出与用户取消不同：退出时关闭底座并保留可恢复状态，不把所有未完成请求改成业务失败。重启后从已保存的请求、底座状态和回复继续。

## Bot 删除与重置

契约为两段：**墓碑即时**，**物理回收在下一个进程边界**。删除是真实擦除——会话、记忆与执行账本的行从存储中消失——工作区文件保留。长期取舍与理由见 [ADR-0023](adr/zero-setup-bot-runtime/0023-zero-setup-bot-runtime.md) 决策 9/11 及其实现记录；本节只写现行契约与限制。

### 入口、授权与参数

删除只经控制台 `DELETE /api/bots/:id`。它**不是模型工具**：模型参数、MCP 工具与投递路径都不能触发删除或自重启。范围由墓碑行上的 `conversationId` 决定，绝不接受调用方给出的范围；body 只接受三个字段——`force`（布尔）、`purge`（`"later"`（默认）或 `"now"`）、`reason`（可选字符串，≤500 字符，仅用于留痕，不是授权依据）。不接受路径、会话 id、表名或任何可影响删除范围的参数。凭据与身份由宿主提供，与删除无关。

### 两段语义与措辞

- **墓碑**：`bots.status = 'deleted'`，立即从 `GET /api/bots` 隐藏，其它路由（消息、取消、重试、历史、事件）返回 `410 { error: "bot_deleted" }`；`botId` 永久不复用，`POST /api/bots` 用同一 id 返回 `409 { error: "bot_id_retired" }`（保留 Bot 的重置不退役 id）。墓碑行长期保留，它同时是"该 id 已退役"的权威记录，并保留 `conversationId` 作为历史关联。
- **回收**：进程启动时、`openAgent()` 打开 harness 与任何会话**之前**执行一遍回收；离线入口（`npm run bots:purge`）在服务停止时执行同一份实现。响应与留痕**不得声称物理擦除已完成**；用户视角的移除与物理回收分开表述，积压量由 `/api/platform` 的 `pendingPurge` 给出。墓碑生效期内 `inbox.text`（用户正文）与底座的行**仍在磁盘上**，这一点必须在文案上被承认，而不是被措辞掩盖。
- 保留 Bot（`default`）的"删除"是**重置**：`bots` 行与会话行保留、`conversationId` 不变、id 不退役，只清空该会话的内容（`entries`/`documents`/`document_revisions`/`tasks`/`submissions`）。理由是 `Harness.root()` 的契约是"保留会话，不存在时创建"，真删 root 行只会换来一个新 id。

### 拒绝与 `force`

| 情况 | 结果 |
| --- | --- |
| 运行中（`view.running !== null`） | `409 bot_is_running`，`force` 不放行 |
| 有待处理输入（`view.pending > 0`） | `409 bot_has_pending_input`，`force` 不放行 |
| 底座里仍有非终态 task 或 `queued`/`placed` submission | `409 work_in_flight`（带 `tasks`/`submissions` 计数），`force` 不放行 |
| 终态 task 的 `outcome.status <> 'completed'`，或 `unanswered` submission | `409 unknown_outcome`（带 `records` 计数），`force` 放行并记 `removalForced` |
| 有其它会话继承该会话历史 | `409 fork_survivor`（带 `conversations` 计数），`force` 放行并连同继承者一并删除 |
| 其它 Bot 有在途工作且 `purge: "now"` | `409 busy_bots`（列出受影响的 bot 与原因），`force` 不替代取消 |
| 同一 Bot 重复 DELETE | `200`，返回第一次的 `removal`，`requestedAt` 不变，不重复留置 |

前三类与 `busy_bots` 是**可行动**的拒绝（先取消、先答复、先停别的 Bot），`unknown_outcome` 与 `fork_survivor` 才是 `force` 覆盖的对象：没有进程再拥有那些行，谁也无法使其确定。`force` 与 `purge` 是两个独立字段，互不隐含；`force: true` 的重复 DELETE 可以升级一条**尚未成行**（`removalReport` 仍为 `null`）的 intent——这是操作者把卡住的墓碑推向下一次回收的方式，已完成的回收不会被重新留置。

### 回收范围

只删该会话及其**归属**的行：`conversations`（重置时保留）、`entries`、`tasks`、`submissions`，以及 `scope.kind = 'conversation'` 且属于该会话的 `documents` 与 `document_revisions`（含 `pi.agent`、记忆的 `personal.*` 与 Tool Ledger 的 `personal.tools.loads`）。按**作用域**过滤而不是按 kind：`scope.kind = 'session'` 的文档（含注册目录 `personal.tools.catalog`）一律保留。

不动的面：`record_ids` 与 `durable_schema`（id 水位不回滚，`mintId()` 的"大于所有历史 id"承诺因此继续成立）、其它会话的每一行、工作区文件（全部保留，含共享主机模式下 `default` 的 `/workspaces` 父目录）、`DATA_DIR/memory/daily/*.md`（按归属模型清理，不按目录清空）。

`inbox.sqlite` 侧：删 `requestId` 以 `console:<botId>:` 开头的行（`inbox.text` 是用户正文；留着则"删除"名不副实，且 `pendingForBot` 会永久非零）、其 `deliveries`/`failures` 引用行、该 Bot 的 `bot_provisioning` 行、`background_jobs` 与其 `notices`（作业索引与通知属于被删的 Bot，留着会把已删 Bot 的 id 继续暴露在控制台；删掉的计数进回收报告）。`integrations`/`checkpoint`/`identity` 不动。

### 幂等、资源边界与失败恢复

- 幂等：重复 DELETE 不重复留置；同一会话第二次 purge 报 `absent` 而不是失败；pass 可重跑且结果收敛。
- 一次回收最多处理 `MAX_REMOVALS_PER_PASS = 64` 个墓碑，余量记 `deferred` 并在日志与报告中明确数量，不静默丢弃；单个会话单次删除的行数上限 200000，超限**整会话拒绝**（不部分删除）并保留 intent 供下次重试。
- `VACUUM` 在确有删除时执行一次，位于删除之后、`openAgent()` 之前（需独占且不能在事务内）；失败不阻塞启动但要报告。
- `removalReport` 是唯一结束 intent 的字段，**最后写入**：删行与清理 `inbox` 成功后才写；失败写 `removalError` 并保持 pending，下次 pass 重试。因此"`agent.sqlite` 已删、`inbox.sqlite` 未删"的崩溃窗口由重跑收敛，且墓碑不会被重复留置。回收失败不阻塞启动——一个 Bot 清不掉不该让其它 Bot 起不来。
- 单写者：回收期间不得有第二个写者。离线入口先取 `DATA_DIR/service.lock`，有活持有者时以 `SERVICE_RUNNING` 拒绝，且**没有 `--force`**（两个写者重叠是唯一不能由调用方"自己负责"的失败）。

### 已知限制

- **版本闸门按已安装底座的 schema 精确匹配**：`durable_schema` 版本与每张表的**列集合完全一致**（缺一列或多一列都算不匹配）才允许回收，不匹配即拒绝删除并保留 intent；不匹配不影响服务启动。升级底座必须先复核这道闸门，见 ADR-0013。宿主直接操作 SQLite 不经过底座的写入校验，这是有意的技术债，用这道闸门与契约测试兜住，并收在 `ConversationPurger` 接缝之后。
- **失败删除没有控制台读出口**：失败的墓碑已从 `views()` 隐藏，只有部署日志的 `Bot removal failed: <botId> (<CODE>)` 与 `inbox.sqlite` 的 `removalError` 可查，`/api/platform` 只给 `pendingPurge` 数量。运维需要按 botId 查库才能看到原因。
- **锁的同 pid 接管规则**（为测试内嵌两次启动而设）意味着在**同一进程内**调用 `purgeBots()` 时，服务正在运行不会被拒绝；发布形式是独立进程（`npm run bots:purge`），生产路径安全，但进程内调用不是受保护的用法。
- 控制台与 BotManager 的日志走进程 stderr（`console.error`），不经过宿主可注入的 `log`；嵌入宿主无法从自己的 sink 拿到删除日志行。

## pi durable 1.3.0 已核实行为

- 工具结果的 `output` 给模型读取，`structuredOutput` 给程序化调用方，`details` 给 UI 消费者；三者不能互相替代。业务失败可返回 `isError: true`，执行异常由底座转换成错误工具结果。
- 默认 `replay` 为 `unsafe`。执行意图已保存的工具，仅在持久化策略与当前工具策略都为 `safe` 时重跑。恢复使用当前实现与已保存参数，跳过首次参数修复和验证，因此工具升级必须兼容尚未完成调用的旧参数；不兼容变更需保留旧工具或在升级前收敛未完成任务。
- 工具默认可以并行执行。应用已显式配置 `toolExecution: "sequential"`，同一回合的工具调用不会重叠；测试 `sequential tool execution prevents overlapping calls in one round` 验证该行为。取舍见 [ADR-0009](adr/0009-sequential-tool-execution.md)。内置 write/edit 已有进程内同文件写入队列，但不能保护 bash 写入，也不能把分开的读取和写入变成事务。
- 请求去重键是 `(底座 conversationId, requestId)`。相同键与相同提交类型返回旧请求，即使文本已改变，也不会检查内容冲突；接入层必须保证请求标识稳定且不被复用。
- 输入提交状态为 `queued → placed → done | unanswered`，其中排队请求也可能直接成为 unanswered。`done` 带最终答案引用；`unanswered` 带原因。应用必须显式区分。
- 取消 `wait()` 只取消等待。取消已开始的执行需使用底座执行取消机制；会话级 abort 会影响该会话的普通任务范围，不能假定它只影响一条请求。

`@earendil-works/pi-mcp` 1.3.0 中与本实现相关的行为：

- `McpClient.connect()` 不接受取消信号。连接超时由宿主用 `Promise.race` 截止，随后必须 `close()`，否则可能遗留子进程或请求。
- `McpClient.onClose()` 表示最终关闭，晚订阅者不会收到重播；适配器用 `connectionState` 补当前快照。关闭后的 client 不能再次 `connect()`，SDK 没有公开恢复订阅。`onError()` 也可能来自协议或处理器错误，不作为不可用证据。
- HTTP GET SSE 的断开与重连在 transport 内部处理，不公开状态事件，也不改变 client 的 connected 状态；GET 不支持或重连耗尽不代表 POST 工具调用一定不可用。因此本实现只根据公开连接关闭信号翻转健康状态，不宣称检测静默假死或 SSE 恢复。
- `StdioTransport` 在 `inheritEnv: false` 时传给子进程的环境恰好是 `env` 选项；`close()` 按关闭 stdin、SIGTERM、SIGKILL 的顺序回收进程组。
- `StreamableHttpTransport` 把 401 交给 `adaptOAuthProvider`；无法用已存 token 或 refresh token 恢复时抛 `McpOAuthAuthorizationRequiredError`。
- `toLlmContent()` 把文本、图片、嵌入资源和结构化结果转换为 pi-ai 的 text/image 内容，可直接作为工具 `output`。

## 应用状态与控制台展示

- 本地请求使用 `console:<botId>:<uuid>`，来源命名空间与 Bot 路由由宿主生成；每个 Bot 绑定持久化底座会话。相同文本的独立发送仍是不同请求。
- `acceptConsole()` 在事务中保存 inbox 请求后才确认接收。重复 ID 的不同文本或 conversationId 直接报错；长期执行去重仍依赖底座，不以浏览器事件代替持久化状态。
- `inbox.receivedAt`／`repliedAt` 记录 ISO 8601 UTC 时间。既有未知时间保持 `null`，不能以升级时刻伪造历史时间。
- 各 Bot worker 只处理自己命名空间内的 `pending` 请求，并将同一个 requestId 交给底座。`saveConsoleReply()` 将回复与 `sent` 状态在事务中保存；普通失败保存明确失败提示并另存错误码。这里的 `sent` 表示控制台回复已保存，不表示外部消息已送达或浏览器已阅读。
- 控制台不创建 deliveries 行；历史接口读取 durable 会话，SSE 展示实时事件。刷新或断流只需重取状态与历史，不能因展示失败重新执行业务任务。
- 取消先将仍为 pending 的请求标为 `failed`，再请求底座中止会话；迟到结果不能覆盖已取消记录。取消执行仍须确认终态，外部副作用不保证撤销。
- 模型以 `stopReason: "length"` 结束时，可见文本不完整。应用保留已生成的部分文本，以 `AGENT_TRUNCATED` 记录并明确提示截断，不把该文本当作完整成功，也不自动续写或重试。完整会话记录仍由底座保存。
- Telegram 接入、`reminder_*` 工具、提醒调度器与逐段投递状态机均已移除。既有 SQLite 表、行与历史状态原样保留，不迁移为已送达，不自动补发或重跑旧任务。
- 操作失败只记录安全错误码，不向日志输出 SDK 请求对象或凭据。工具的详细执行记录仍归底座管理；配置错误以外的启动异常只打印错误码，避免带出凭据或消息内容。

具体启动与部署命令见 README.md。

## 当前运行尺度

当前为一个应用进程、单用户、多 Bot，每个 Bot 按顺序处理请求，SQLite 保存运行状态；Computer 工具共用一个执行主机。现有负载不需要额外消息队列服务或逐工具独立框架。扩展并发或后台任务时，按具体需求更新状态归属、资源限制及相关契约。

验收重点是边界行为：非法参数不执行、相同请求不重复提交、完成结果可重取、中断工具按策略恢复、展示断流不重新执行，以及超时确实触发取消而非仅停止等待。
