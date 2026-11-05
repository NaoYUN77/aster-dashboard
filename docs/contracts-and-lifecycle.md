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

权限由宿主固定为 `owner`（默认，可执行 read 和 write）或 `restricted`（仅 read）。生产 `openAgent()` 通过 `toolAuthority` 注入，作用于整个实例的所有会话、任务及恢复；模型参数、MCP 描述和 annotations 均不能提升权限。现有 Telegram 入口已认证为所有者，使用默认 owner。当前只预留受限实例入口，尚未实现请求间动态切换、多级身份系统或破坏性操作二次确认。authz 配置在启动时应用，包括未完成任务的后续执行；它不改变工具声明字节、加载编号、epoch、trust 或 replay。

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

工具静态凭证由部署环境提供：Bot token、模型 API key 与 MCP 配置中的 `${ENV}` 引用都从应用进程环境解析，真实值只存在于部署的 env 文件中。应用不将秘密写入工具参数或 durable 状态。凭证的存放与权限（例如 env 文件 600 权限）由部署负责，应用只做存在性与形状校验。

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

### 代码调用工具（PTC／codemode）

`CODEMODE_ENABLED=1` 时安装底座的 `codemode` 工具。模型写一段 JavaScript，由 QuickJS WASM sandbox 执行；只有脚本结果进入模型上下文，嵌套工具结果不进入 transcript。设计取舍见 [ADR-0019](adr/codemode-ptc/0019-codemode-ptc.md)，配置与运行说明见 [代码调用工具](codemode.md)。

- `codemode` 的 `callers` 为 `["model"]`，脚本不能再次调用 codemode；`replay` 为 `safe`。
- 脚本工具面由 `callers` 白名单决定：本地为 `read`／`write`／`edit`／`bash`，远程执行阶段 1 只有 `bash`。模型仍能看到全部工具；每次嵌套调用仍经过 `createToolRegistry()` 的名称、state、authz、参数校验和恢复策略复核。
- 模型可见结果上限为 32 KiB／1000 行、保留尾部。脚本首行的 `max_output_tokens`／`timeout_ms` 只能进一步收紧，仍受宿主上限和请求等待约束。
- 嵌套调用在宿主侧串行执行（ADR-0009）；codemode 调用结束（完成、失败或超时）或被取消时，正在运行的嵌套调用被取消，尚未启动的排队调用不再启动。
- 默认脚本期限 240 秒、QuickJS 内存上限 128 MiB；配置范围见 `src/config.ts`。应用关闭时 Harness 先取消工具上下文，再关闭 sandbox。
- 远程模式下没有远程文件 API；codemode 的自动完整输出落盘不可用，大输出应由脚本用 `bash` 写到执行主机文件，再由后续 `bash` 读取。
- QuickJS 只限制脚本运行时能力，不是 OS 沙箱；`bash` 与模型直接调用具有相同宿主权限。脚本源码和命令参数会进入 durable 会话记录，不得写入凭据。

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

应用不复制底座内部状态机。界面上的“处理中”可从底座状态得出，而不是维护另一份可能失真的权威状态。

### 正常路径

1. 接收 Telegram update，校验身份、私聊类型和输入限制。
2. 将合法请求与消费位置在本地事务中保存，再进行下一次会确认消费位置的轮询。
3. 按顺序向底座提交请求，持续使用同一个 requestId。
4. 底座处理模型和工具循环，产生本次请求的终态。
5. 将最终回复或明确失败提示保存到投递记录。
6. 按 Telegram 限制拆分消息并发送，记录每段确认结果。
7. 全部段落确认后标记投递完成。

### 恢复窗口

| 中断位置 | 恢复方式 |
| --- | --- |
| 本地保存请求之前 | Telegram 尚未被确认消费，可重新获取 |
| 已保存、尚未提交底座 | 从本地记录提交 |
| 已提交、应用尚未保存底座关联 | 用同一 requestId 找回已有提交，依赖底座去重契约 |
| agent 已完成、回复尚未保存 | 从底座已有结果构建回复，不重新执行任务 |
| 回复已保存、尚未发送 | 从投递记录发送 |
| 已发送、确认尚未保存 | 标记结果未知；不能保证自动重发不会重复 |
| 部分分段已确认 | 保留每段状态，不重新发送已确认段落 |

Telegram sendMessage 没有可供本应用使用的幂等键，因此系统不承诺端到端恰好一次。对于结果未知的发送，当前实现保留记录并提供诊断，不自动重发整条回复。取舍见 [ADR-0007](adr/0007-delivery-not-exactly-once.md)。

### 超时与关闭

停止等待不等于终止 agent。用户取消或执行超时，需要调用底座的取消接口并确认终态；已经提交的外部副作用仍可能发生。

进程正常退出与用户取消不同：退出时关闭底座并保留可恢复状态，不把所有未完成请求改成业务失败。重启后从已保存的请求、底座状态和投递记录继续。

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

## 应用状态与投递实现

- 本地请求使用 `telegram:<botId>:<updateId>`，数据目录绑定 bot ID 与 owner ID。单用户 Telegram 私聊映射到一个底座 root 会话；未来多会话需另行保存路由关系。
- `inbox` 保存请求，`checkpoint` 保存消费位置，两者在同一 SQLite 事务中写入。重复 ID 的不同内容直接报错，不推进 offset。本地历史只清理已完成的 `sent` 请求，保留最新 100 条；`pending`、`ready`、`failed`、`uncertain` 请求永不自动清理，关联投递与诊断记录随请求级联删除。长期执行去重仍依赖底座。
- `inbox.receivedAt`／`repliedAt` 与 `deliveries.createdAt`／`updatedAt` 记录 ISO 8601 UTC 时间，用于区分"已接收但未处理"和"已处理但投递失败"。升级前写入的行保持 `null`（未知），不以迁移时刻回填；迁移只追加可空列，可重复执行。
- 应用请求状态为 `pending → ready → sent`；agent 执行属于底座，本地 pending 不复制 queued/placed。普通 agent 失败生成待投递的失败提示，错误码另存。若底座 Session 已永久失败（`SessionFailed`），应用不写失败提示、请求保持 `pending`，由 `serveTelegram` 向上抛出 `AGENT_SESSION_FAILED`；进程以退出码 1 结束，交给进程管理器重启。本地 SQLite 写入失败同样按致命错误处理。
- 模型以 `stopReason: "length"` 结束时，可见文本不完整。应用保留已生成的部分文本，以 `AGENT_TRUNCATED` 记录并通过投递提示明确说明截断，不把该文本当作完整成功，也不自动续写或重试。完整会话记录仍由底座保存。
- `deliveries` 按 `(requestId, part)` 保存文本，分段状态为 `pending → sending → sent`；失败分为 `failed` 与 `uncertain`。确认时记录 Telegram message ID。每段最多 4000 个 UTF-16 code units，不切开代理对，使用纯文本发送。
- Telegram 明确 4xx 拒绝记录为 failed；网络失败和其他无法排除送达的情况记录为 uncertain。重启将遗留 sending 转为 uncertain。阻塞请求不自动重发，但允许处理后续独立请求。
- 投递管理 CLI 支持列出、重试该段、人工确认该段已送达。操作前停止应用，核对实际 Telegram 消息；重试仅发送已有结果，不重新运行 agent。CLI 打开数据库后先执行恢复，因此进程发送中被强杀时遗留的 `sending` 段以 `uncertain` 出现在列表中，`sending` 本身不会直接暴露给操作者。先前版本没有逐段记录的 uncertain 请求保留原记录，需人工核对。
- 轮询遇到网络故障或服务端错误采用有界退避，明确配置/认证错误退出交给进程管理器处理。每次最多接收 10 条，先处理本地待办再继续轮询；当前不保证长期离线或持续积压情况下的可靠收件。
- 操作失败只记录安全错误码，不向日志输出 SDK 请求对象或凭据。工具的详细执行记录仍归底座管理。启动失败时，`ConfigurationError` 与 `StateError`（数据目录已绑定其他 bot／owner 等）打印应用自己写的 message；其余异常只打印错误码，避免 SDK 错误对象带出凭据或消息内容。

具体启动、投递管理及部署命令见 README.md。

## 当前运行尺度

当前为一个应用进程、一个用户会话、一个执行中的用户请求，SQLite 保存运行状态；现有负载不需要额外消息队列服务或逐工具独立框架。扩展会话、并发或后台任务时，按具体需求更新状态归属、资源限制及相关契约。

验收重点是边界行为：非法参数不执行、相同请求不重复提交、完成结果可重取、中断工具按策略恢复、部分投递不整条重发，以及超时确实触发取消而非仅停止等待。
