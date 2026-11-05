# GitHub 首期只读接入规格

- **状态**：离线宿主实现已提交（策略、批准基线、逐次对账与恢复闸口）；真实托管链路、PAT/代理/OpenBao、容量与部署仍未联调或验收。第 10 节清单仍为待执行记录，本文件不是验收通过记录。
- **开始日期**：2026-11-01
- **功能**：github-access
- **长期决策**：[ADR-0018：GitHub 官方托管 HTTP MCP 与 OpenBao 只读 PAT](adr/github-access/0018-github-access.md)

## 1. 用户目标与本轮交付边界

Aster 通过 GitHub 官方托管 MCP 读取仓库、issue、PR 和 CI，帮助所有者理解代码、讨论与构建结果。复用 pi-durable 的 agent loop、工具执行和持久化，以及 pi-mcp 1.3.0 的 Streamable HTTP transport，不另建模型循环。

Jay 已最终确认：

1. 使用 `https://api.githubcopilot.com/mcp/`，凭据为细粒度 PAT，应用侧仅持有 `__vault_GITHUB_MCP_TOKEN__`。
2. 首期只读 repo / issue / PR / CI；不触发、重跑、取消或批准 Actions，不创建或修改 issue、评论或 PR，不 merge、不写仓库、release、权限或 secrets。
3. 允许读取未列出的公开仓库；不要求绝对仓库允许清单。私有资源仍受 PAT 资源授权约束。
4. 只接普通 `github.com`，不接 Enterprise、专用域名或 SSO 流程。
5. remote gh 不同期，也不作为 MCP 失败时的自动后备。
6. HTTP + PAT 是对 ADR-0001 的 GitHub 局部例外；其他 MCP 的默认路线不变。

本轮只创建本规格和功能 ADR。禁止修改 `src/`、`test/`、`mcp.json`、密钥和部署文件；不 commit、push 或创建 PR（该约束仅适用于规格形成轮，后续实施见 `docs/github-access.md`）。下文所有实施步骤与验收项仍须逐项执行；本文不构成验收通过。

## 2. 范围与资源授权

| 范围 | 首期提供的读取 | 排除项 |
| --- | --- | --- |
| repo | 仓库检索与基本信息、目录/文件读取、代码检索 | 克隆或同步工作区、文件/分支写入、fork、仓库管理 |
| issue | 列表、检索、详情、评论及关联信息读取 | 创建、更新、关闭、评论、标签或关系修改 |
| PR | 列表、检索、详情、diff、文件、提交、评论、review、status/check runs 读取 | 创建、修改、review 提交、评论、merge、分支更新 |
| CI | workflow、run、job、check 状态与单个 job 的有界必要日志 | dispatch、rerun、cancel、approve、执行配置修改、artifact 下载及无界日志抓取 |

PAT 的 selected repositories 不是公开仓访问白名单。跨仓搜索和读取其他公开仓属于已授权产品范围，不应被“未列入 PAT 仓库清单”一律拒绝。PAT 无权访问的私有仓不得通过换凭据、放大权限或其他工具绕行。

PAT 的资源所有者、首批私有仓清单、有效期、审批状态与轮换责任人在实施时填写到仓库外的运维记录；本规格不臆造 owner/repo。细粒度 PAT 的单一资源所有者限制仍适用；多个私有资源所有者不通过静默合并权限处理，超出单 token 能力的需求另行决策。仅使用公开仓的情形不要求额外私有仓授权。

只读承诺覆盖此 GitHub 接入的操作与 PAT 所授能力，不宣称 MCP 配置构成整个 Aster 的沙箱。现有 `bash/read/write/edit` 等工具按其原契约管理；本功能不得向它们提供另一份可写 GitHub 凭据或自动回退命令。

## 3. Transport、凭据与 HTTP 契约

采用名为 `github` 的 HTTP MCP server，固定 HTTPS endpoint 为 `https://api.githubcopilot.com/mcp/`。身份、endpoint、header、代理、CA、策略和批准基线均由宿主提供，不允许模型参数指定或覆盖。不开 insiders，不配置 OAuth provider，不创建 `mcp-oauth/github.json`，不引入 `auth.type: "pat"`。

后续部署的静态 header 契约如下；这是规格，不是本轮写入配置的指令：

| Header | 宿主值/来源 | 约束 |
| --- | --- | --- |
| `Authorization` | `Bearer __vault_GITHUB_MCP_TOKEN__` | 真实值只在认证 MITM 替换后出站 |
| `X-MCP-Readonly` | `true` | 服务端只读筛选；不可代替宿主允许清单 |
| `X-MCP-Tools` | 第 5 节精确原始工具名，以逗号连接 | 必须与经审阅的宿主清单一致 |

不同时发送 `X-MCP-Toolsets`：官方文档规定显式 tools 与 toolsets 相加，不应把全 toolset 暴露误当精确筛选。不得依赖空 toolsets 表示禁用默认集合。首期采用官方“仅指定工具”的配置方式，实际 `tools/list` 的集合与声明必须验收；发现额外工具不得直接注册使用。

静态 header 路径在当前配置中允许省略 `auth`。`docs/mcp.md` 所说的 `auth.type` 只支持 OAuth，指的是显式 `auth` 对象的类型，不表示 HTTP 必须启用 OAuth。401 按 PAT 认证失败处理，不触发 OAuth、refresh 或浏览器授权。

初始化、`tools/list`、`tools/call` 及 transport 所需 HTTP 请求均走 Node 已配置的认证代理并信任 MITM 公共 CA。禁止禁用 TLS 验证，禁止把 GitHub 加入 `NO_PROXY`。首期不跟随 MCP endpoint 的 HTTP 重定向；须验证或补齐 transport 边界，以免凭据离开核准目标。工具返回的下载链接也不自动抓取。

## 4. 四层只读边界

四层分别验收；模型提示词、远端 annotations、工具名称中的 read/get、`pin` 或 `authz: "read"` 均不能独自证明只读。

| 层 | 强制职责 | 失败时行为 |
| --- | --- | --- |
| 1. PAT 身份能力 | 只授予所需 repository read 权限，限制私有资源；不授 Actions Write 或其他写权限 | 权限缺失返回明确失败，不自动增权、换 token 或回退 gh |
| 2. 官方服务端筛选 | 每次请求携带 `X-MCP-Readonly: true` 与精选 `X-MCP-Tools`，缩小远端暴露面 | 缺少必需工具、筛选异常或集合不符时不启用 GitHub |
| 3. 宿主精确工具允许清单 | 注册/发现、搜索、pin 与实际执行均只接受经批准的 GitHub 工具身份；owner、嵌套及恢复路径也不能绕过 | 未批准工具不进入模型候选；绕过搜索直接调用也不得发送 `tools/call` |
| 4. 宿主操作与参数限制 | 对 method/action、枚举、字段、分页、日志模式等逐项允许；模型参数经底座校验后再次复核业务条件 | 未知或非法操作、越限及无法可靠区分读写的工具均拒绝执行 |

最小 PAT 权限的初始核对项为 Metadata、Contents、Issues、Pull requests、Actions、Checks 的 Read；以精选工具实际调用的 API 为依据逐项核对，删除不需要项。不得照搬官方 README 中 classic PAT/OAuth 的 `repo` scope 为细粒度 PAT 申请广泛权限。某工具需要额外权限时，先停用该工具并评估，不能为验通而增加写权限。

当前 `mcp.json.tools` 仅支持 `pin/authz`，未列出的已发现工具仍会注册；默认 owner 可执行 read/write。因此第三、四层是待实现的强制策略，不得以现有配置宣称已满足。只读策略只约束 GitHub 来源，不通过将整个实例改成 restricted 来误伤其他工具。`authz: "read"` 仅在工具及操作审阅通过后用于宿主定级。

## 5. 工具允许清单、pin 与 tool_search

### 5.1 初始精确清单

以下是首期允许核准的原始工具身份及操作上限。名称依据 2026-11-01 读取的官方公开文档；真实托管端声明仍须逐项比对，不把文档当作 `tools/list` 快照。宿主保存原始身份与最终注册名的映射，不接受同名替代、别名自动扩权或通配符。

| 原始工具名 | 允许的操作 | 参数限制与覆盖目标 |
| --- | --- | --- |
| `search_repositories` | 仓库检索与返回的仓库信息 | 查询与分页有界，允许其他公开仓 |
| `get_file_contents` | 指定仓库目录/文件读取 | owner/repo/path/ref/sha 按已批准 schema；超限明确返回 |
| `search_code` | 代码检索 | 有界结果；不自动下载搜索链接 |
| `list_issues`、`search_issues` | issue 列表与检索 | 使用受限分页/游标 |
| `issue_read` | `get`、`get_comments`、`get_sub_issues`、`get_parent`、`get_labels` | 其余 method 拒绝 |
| `list_pull_requests`、`search_pull_requests` | PR 列表与检索 | 使用受限分页/游标 |
| `pull_request_read` | `get`、`get_diff`、`get_status`、`get_files`、`get_commits`、`get_review_comments`、`get_reviews`、`get_comments`、`get_check_runs` | status 与 check runs 都必须验通；其余 method 拒绝 |
| `actions_list` | `list_workflows`、`list_workflow_runs`、`list_workflow_jobs` | 不开放 artifact 列表；校验 method 与 resource_id 的对应关系 |
| `actions_get` | `get_workflow`、`get_workflow_run`、`get_workflow_job` | 不开放 usage、日志 URL、artifact 下载等其他 method |
| `get_job_logs` | 指定单个 job 的日志尾部 | 必须有 job_id，`return_content: true`、`failed_only: false`，不传 run_id，显式 `tail_lines` 为 1～200 |

清单共 12 个原始工具。`actions_run_trigger` 以及所有 issue/评论/PR 写工具均不在清单中；即使远端误报 read、PAT 误配为可写或调用者是 owner，也必须在宿主拒绝。混合工具将来新增 read 方法同样须重新核准，新增写方法不得借旧工具名进入。

如果实际 schema 无法被 pi-mcp/TypeBox 安全适配，或只读 header 导致必需工具缺失，首期验收失败。不能静默换名、删去 CI/check/log 覆盖后声称接入完整。需要替代工具时，先更新规格/批准基线并审阅，再实施。

### 5.2 宿主策略与声明

实施需新增明确的 GitHub 策略输入与运行时校验，不能复用 `tools` 表的“列出即允许”假设。策略必须包含 server/endpoint、精确工具身份与注册名、允许操作及参数约束、批准版本；缺失、未知字段或非法值拒绝启用该 GitHub 条目。批准基线属于宿主持久化契约，与临时目录分离，模型不能写入或确认。

对外声明应准确表达首期允许操作，不能保留会诱导模型选择禁用 method 的声明。原始远端声明与宿主收窄后的有效声明分别留存并比较。底座参数 schema 校验继续执行；执行边界再复核实际参数，恢复路径也不能依赖首次校验已做过。

### 5.3 pin 与按需加载

首期 GitHub 工具全部 deferred，不配置 pin。`tool_search` 仅检索经批准且当前可用的 GitHub 工具；搜索加载沿用底座 `control.addTools`，新声明在下一次模型调用生效，加载集合随会话保存。

搜索不到工具并不证明未配置或认证失败：工具可能已加载、被停用、不可用或未通过策略。诊断须能区分这些情况。未来如需 pin，只改变常驻可见性并服从原预算/上下文契约；pin 失败不得回落为策略绕过。已加载或恢复出来的旧声明也须经过当前策略，不能绕过第三、四层。

## 6. OpenBao 精确 host 映射与凭据生命周期

后续部署只增加下列映射，本轮不改 allowlist、bootstrap 或真实配置：

| 项目 | 值 |
| --- | --- |
| 占位符 | `__vault_GITHUB_MCP_TOKEN__` |
| OpenBao KV v2 逻辑路径 | `secret/aster/GITHUB_MCP_TOKEN`，字段 `value` |
| OpenBao HTTP 读取路径 | `/v1/secret/data/aster/GITHUB_MCP_TOKEN` |
| 凭据替换允许 host | 仅 `api.githubcopilot.com`，精确匹配 |
| 应用请求位置 | `Authorization` header |

本路线不需要把 `api.github.com`、`github.com`、`*.githubusercontent.com` 或后缀通配符加入该 PAT 映射。GitHub 托管 MCP 自行访问 GitHub API，Aster 不替它补直连链路。重定向、新域名或下载链路如有实际需求，必须另行审阅，不能自动拓宽映射。

真实 PAT 仅由操作者写入 OpenBao，MITM 经已有 mTLS 与只读策略读取，并交给 GitHub 官方托管服务。应用配置、环境、模型参数、durable 状态、错误、日志和验收截图均不得含真实值。代理访问 token、OpenBao token 和 PAT 是不同凭据，不混用，不打印含代理 userinfo 的 URL。

现有代理只替换 headers 与 URL path，不替换 query/body；该映射是“占位名 + host”的凭据释放规则，不是完整出口白名单、MCP 操作白名单或仓库授权。无占位符请求不受这条替换规则限制；同 host 上的其他路径也不能靠此映射获得操作约束。第三、四层与最小 PAT 仍须成立。

现有凭据缓存为 300 秒。正常轮换需核验旧缓存到期或受控清缓存之后，新 PAT 确已生效；不能把 OpenBao 更新当作即时切换。紧急失效以 GitHub 撤销旧 PAT 为准，并先停用 GitHub 能力；轮换、恢复连接或更新缓存都不能自动重跑结果未知的调用。PAT 到期/审批未完成也不自动换成 OAuth、GitHub App 或 classic PAT。

## 7. 声明漂移、停用与恢复

### 7.1 批准基线

留存经人审阅的独立批准基线：server/endpoint、12 个工具的原始身份与注册名、原始完整声明（含输入/输出 schema、描述、annotations 等返回字段）、有效声明、允许操作/参数策略及批准版本。规范化对象键后比较，保留数组顺序；不能只比较工具名或现有 `schemaHash`。

启动注册目录是观察快照，不能充当会被启动同步覆盖的批准记录。初次没有基线时禁用 GitHub，先输出不含秘密的候选差异供人核准，不能将首次观察自动设为批准。独立基线读取与漂移比较必须早于旧目录覆盖、GitHub 工具发布、恢复调度和 pin 结算。

### 7.2 检测时点与默认拒绝

首期采用以下 GitHub 专用闸口，不增加后台无限轮询或通用自动重连：

1. 启动/重新建连时，完整发现精选集合并比较批准基线。
2. 每次 GitHub 业务 `tools/call` 前，先做一次有界 `tools/list` 对账。对账与执行受同一宿主策略门控制；对账失败不使用旧快照继续发送业务调用。
3. 收到可用的 list-changed 通知、声明相关协议错误或已知服务变更信号时，立即将 GitHub 置为待核准；通知只辅助检测，不代替逐次对账。
4. 必需工具缺失、额外工具出现、身份/声明/策略发生任何未批准变化、schema 被过滤或发现被截断，均停用整个 GitHub 能力并记录安全原因。普通连接恢复不得自动清除漂移停用。

停用必须同时排除搜索/晋升并阻断已加载、直接、嵌套、恢复中的后续业务调用。不得把远端 list/健康恢复当作所有者批准。已经发送的调用不能改写为“未发送”，应按实际结果、取消或未知终态记录。

每次对账有延迟与 API 开销；首期接受此成本以缩短长期连接内的检测窗口。仍存在“对账完成至 tools/call 处理”之间的变化窗口，也无法由声明检测不改变 schema/描述的远端语义变化。HTTP 托管端无本地 release pin，不能承诺完全阻止漂移或本地回滚恢复旧远端实现。

### 7.3 恢复与重新核准

所有 MCP 调用继续 `replay: "unsafe"`。已持久化执行意图的中断调用不自动重放；只读定级不改变这一契约。尚未执行的旧调用与任务后续调用仍可能不兼容，必须经过当前策略及批准基线闸口。

发现漂移后，先冻结 GitHub 调用，保留旧声明、加载账本、批准基线与未完成工作证据；核对差异及旧参数兼容性。存在未完成工作时，先收敛任务或明确记录无法继续的原因，不能直接覆盖基线再恢复旧任务。托管服务无法保留旧实现时，不能伪造兼容。

人审批准后，以受控方式更新基线；在确认无未完成工作时，经原有上下文边界发布新声明。既有 deferred 加载集合也必须纳入刷新，不能只结算 pin。历史执行记录及加载序号保留，不把新批准写成旧会话早已使用的声明。重新启用需对账与只读检查通过。

## 8. 资源、取消、结果与失败语义

### 8.1 首期资源边界

以下数字为首期实施限额，不是已经测得的性能数据：

- GitHub 业务调用并发上限 1；对账与该业务调用顺序执行，不建立无界等待队列。入口超限显式拒绝或交回既有有界调度。
- 连接超时 10 秒；一次 GitHub 工具执行总时限 60 秒，包含调用前对账；对账自身最多 10 秒，必须取消实际 HTTP I/O。
- `tools/list` 最多 100 工具、10 页；任一达到截断条件或分页不完整都验收失败，不自动取“前 100 个”。
- schema 沿用深度 12、累计属性 256、序列化 16 KiB、无 `$ref` 及 TypeBox 可编译要求；无法安全收窄时拒绝工具。
- 业务列表/搜索单次最多 30 项、只取一页，不自动跟随分页。页号为正整数；游标长度上限 4096 UTF-8 字节，搜索串上限 4096 UTF-8 字节；超限拒绝。返回后续页信息供下一次显式读取，不暗中遍历全仓。
- 单 job 日志仅取 1～200 行尾部，不批量拉所有 failed jobs，不下载 ZIP、artifact 或日志 URL。远端不支持这种有界模式时停用日志工具，不以全量下载后截断替代上游约束。
- 非 SSE HTTP 响应体沿用 1 MiB 上限；SSE 必须在现有事件限额外落实单次工具结果的累计 1 MiB 输入预算，超限取消并明确报错。不能把文本展示截断当作传输/内存上限。
- 文本进入上下文沿用 32 KiB / 1000 行上限，并明确标注截断；首期 GitHub 读取只接受经批准的文本/结构化数据，不自动展开图片、嵌入资源或链接。结构化结果与持久化前转换也须服从累计预算。

文件、diff 或日志超过边界时明确区分“已取得部分结果”和“读取失败”，引导缩小路径、分页或日志范围；不静默丢弃后假称完整。外部正文、评论、日志、文件和工具描述均为不可信数据，不能指挥宿主修改凭据、批准基线或权限。

### 8.2 失败分类与重试责任

| 情况 | 必须保留的语义与恢复方式 |
| --- | --- |
| 宿主策略/参数拒绝 | 明确未发送业务 `tools/call`；保留调用关联和拒绝原因。对账请求可能已经发送，二者须区分 |
| 远端 `isError: true` | 工具业务失败，保留原失败标记；不得转换为空结果或成功 |
| HTTP 401 | 静态 PAT 无效、过期或撤销；现有路径为 `MCP_HTTP_401`，由操作者核对，不进入 OAuth |
| 本地代理 407 / 403 | 分别核对代理认证、源地址/占位 host/OpenBao 替换；不能归为 GitHub 仓库权限失败 |
| 上游 403 | 区分权限/审批、限流或服务策略；证据不足时保留未知原因，不根据一个状态码断言 |
| 404 | 可能不存在，也可能因权限隐藏；不声称已证实私有仓不存在 |
| 429 / 次级限流 | 尊重可取得的 Retry-After/reset 信息，报告等待建议；不循环重试或换身份绕限 |
| 网络、TLS、协议、超时或关闭 | 与业务失败分开；取消传至 HTTP/SDK，保留已发送/未发送及结果是否已知，不能把停止等待说成远端已停止 |
| 声明漂移/不完整发现 | GitHub 停用待审，不自动接受新声明或用旧快照继续调用 |

HTTP 错误也可能被封装在 MCP 工具业务结果中，不能仅按 transport HTTP 状态识别 GitHub API 失败。只解析有界、明确的错误字段；不输出原始 header、异常请求对象或完整错误正文。

当前适配器异常的 `MCP_*` 分类不保证原样到达最终模型 diagnostic，底座可能转换为通用 `tool_error`。实施时须建立可验证的安全分类与恢复提示，不在规格中假定现状已具备统一 GitHub 错误码。成功、空集合、部分结果、业务失败、基础设施失败和结果未知必须可区分。

宿主不自动重试业务 `tools/call`；底座不自动重放。操作者或模型经明确失败信息发起的新读取属于新的调用，仍经过全部闸口。声明对账失败也不在后台重试直至放行。SDK 自身 SSE 连接维护与业务调用重试分别验证，不能承诺超出 SDK 的远端终止能力。

记录 conversationId/taskId/callId、工具注册名、批准版本、操作类别、阶段与安全原因码；GitHub request ID、限流时间仅在实际可取得时附记，不伪造。诊断日志不含 PAT、代理 token、Authorization、完整查询、正文或 CI 日志；工具结果仍按底座契约进入受保护的会话记录。投递失败只重投已保存回复，不再次读取 GitHub。

## 9. 实施接点与顺序（后续阶段）

| 接点 | 现状与后续工作 |
| --- | --- |
| `src/mcp-config.ts` | 已支持 HTTP static headers 且 auth 可缺省；新增策略输入的严格 schema，区分允许清单与现有 pin/authz |
| `src/mcp.ts` | 复用 `openMcpConnection/openMcpHost/buildMcpTool`；在发现发布及发送前接入基线、精确身份、操作检查、逐次对账、重定向与输入预算 |
| `src/tools.ts` 及原生 tool_search 包装 | 复用 Register 与统一执行复核，保证搜索、直接、嵌套和 owner 路径一致；不修改底座包文件绕过契约 |
| `src/agent.ts`、`src/tool-ledger.ts` | 在 catalog 同步覆盖与恢复调度前比较独立基线；定义旧加载声明与新批准版本的上下文切换 |
| `src/tool-pins.ts` | 保留预算/未完成工作恢复规则；旧 pin 不能授权已停用 GitHub，首期无 GitHub pin |
| `src/check-config.ts`、`src/mcp-check.ts` | 复用现有检查入口；离线检查与连接/声明/只读业务验收分开，不以列名成功代替业务成功 |
| `deploy/openbao-mitm/addon/allowlist.json` 与运维文档 | 后续独立变更精确 host 映射、秘密录入/轮换说明；真实 PAT 和 mcp.json 不进仓库 |
| `docs/mcp.md`、`docs/contracts-and-lifecycle.md`、部署说明与功能 ADR | 实施后更新长期契约与验收证据，说明 GitHub 专用策略不改变其他 MCP/OAuth 行为 |

实施顺序：先完成离线策略/漂移/恢复闸口及其边界测试，再在隔离环境配置占位链路并核准真实声明，逐项验证 repo/issue/PR/CI，最后完成资源、失败与回归验收。上线是独立操作，不由规格完成推导为已授权部署。

## 10. 验收清单（全部待执行）

- [ ] endpoint、普通 github.com、HTTP + 静态细粒度 PAT 与无 OAuth provider 的配置通过校验；不依赖 remote gh、真实 PAT 环境注入或本地 GitHub server。
- [ ] 代理前仅有占位符，MITM 后仅向精确 `api.githubcopilot.com` 释放 PAT；初始化/list/call 均通过。使用脱敏 stub 验证形态，真实服务不抓取或落盘 Authorization。
- [ ] 错误 host、相似后缀 host、未知占位符、OpenBao 不可用、代理认证缺失、错误 CA、重定向均按预期失败；无公网直连或 TLS 校验关闭。
- [ ] PAT 资源所有者、私有仓、期限/审批与 Read 权限有运维记录；选中私有仓读取通过，未授权私有仓拒绝，未列出的公开仓读取通过。不执行真实写操作作为权限探针。
- [ ] 真实发现的 12 个工具及全部指定 method/日志模式通过声明比对和 pi-mcp/TypeBox 适配；包含 workflow/run/job、PR status/check runs、必要日志，不静默缩减覆盖。
- [ ] 四层只读分别用 fixture 验证：缺失/宽松服务端筛选、误配可写 PAT 场景下，宿主仍拒绝未知工具、写 method、新 method、非法参数与全部 Actions 执行工具；业务请求发送计数为零。
- [ ] tool_search、直接调用、嵌套、owner、已加载、旧 pin 与恢复调用共享允许/拒绝结果；首期无 pin；搜索后下一轮加载，已加载工具不会被误诊为未认证。
- [ ] 无批准基线时默认停用；启动比较早于 catalog 覆盖和恢复。新增/缺失工具、描述变化、schema/输出声明变化、schema 同 hash 的其他声明变化都停用。
- [ ] 连接保持期间每次调用先对账；对账超时/截断/失败、list-changed、已知变更均阻断后续业务请求。健康恢复与重启不自动核准漂移。
- [ ] 未完成工作面对不兼容声明被阻断，unsafe 调用不重放；人审后在空闲上下文边界刷新 pin 与 deferred 旧声明，历史记录保留。
- [ ] 成功、空结果、部分结果、远端 isError、401、代理 403/407、上游 403/404/429、协议失败、关闭与超时有可区分的安全提示；证据不足保留不确定性。
- [ ] 调用前对账与实际 HTTP 的取消均验收；业务不自动重试；进程中断保留可恢复状态，投递重试不重新执行业务读取。
- [ ] 分页、查询/游标长度、单 job 日志、传输累计字节、展示截断、并发和时限均在边界用例中生效，无自动下载链接或无界缓冲。
- [ ] 正常轮换覆盖 300 秒缓存窗口，紧急撤销后旧 PAT 不能继续读取；应用、模型、日志、状态与验收材料无真实凭据。
- [ ] 在目标 4 核/4 GB 主机与现有应用容器限额下记录连接发现、空闲、读取及有界日志时的应用 cgroup 峰值、CPU 和整机余量；包含 MITM/OpenBao 同机负载，不编造容量数字。
- [ ] 后续实现阶段完成类型检查、构建与相应 MCP/策略/账本/pin 回归；其他 MCP 及 Notion 带外 OAuth 不受影响。`mcp:check` 只列名不能作为本清单通过证据。

## 11. 依据与当前证据边界

本地依据：[MCP 文档](mcp.md)、[契约与生命周期](contracts-and-lifecycle.md)、[ADR-0001](adr/0001-mcp-access-stdio-first-oauth-out-of-band.md)、[ADR-0008](adr/0008-unsafe-tool-replay.md)、[ADR-0014](adr/0014-humans-register-tools.md)、[OpenBao/MITM 说明](../deploy/openbao-mitm/README.md)。命名依据 [临时 spec 约定](README.md#按功能的临时规格) 与 [ADR 约定](adr/README.md)。当前工作区无其他 spec，参考并行工作区既有 `spec-20261101-telegram-stt.md` 的状态/范围/接点/验收结构；不将其决策纳入本功能。

讨论输入为本地计划 `C:\Users\l\.claude\plans\aster-github-c-users-l-claude-plans-jay-lexical-umbrella.md`；其中 transport、公开仓和 Enterprise 等开放项已由本轮最终确认取代，不保留为待重新选择问题。

2026-11-01 读取的官方公开来源：

- [Remote GitHub MCP Server](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)：托管 URL、header 与托管实现更新方式。
- [Server Configuration Guide](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)：仅指定工具、tools/toolsets 组合、只读筛选与 token 类型过滤限制。
- [GitHub MCP Server README](https://github.com/github/github-mcp-server/blob/main/README.md)：PAT Authorization 示例、工具名称、方法与参数说明。

这些是可变的上游文档，不是已固定的服务版本。本轮未连接带认证的 GitHub MCP、未执行 GitHub 工具、未读取真实 mcp.json/密钥、未测容量、未运行代码测试，也未变更部署。允许清单、漂移闸口、输入预算与稳定错误分类均为待实现/验证要求。
