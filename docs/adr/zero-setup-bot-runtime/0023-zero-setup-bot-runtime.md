# ADR-0023：开箱即用的 Bot 运行环境与平台能力清单

- **状态**：Accepted
- **日期**：2026-11-06
- **功能**：zero-setup-bot-runtime

## 上下文

在实现本功能之前，创建一个 Bot 需要调用 `POST /api/bots` 并提交完整的 `profile`（八个能力开关）
与可选 `toolScope`，Web Search 需要用户自备 CCR 或 API Key，MCP 需要用户写配置文件。控制台有
八个能力复选框与「能力设置」对话框。用户必须理解 Tool / Capability / MCP / Registry 才能使用产品。

同时，已有的治理设施是可用的且不应被推翻：pi-durable 的 agent loop 与持久化、Tier 1 / Tier 2
与 `tool_search`、Tool Pin、Tool Governance（source / trust / authz / replay / schemaHash /
state）、`review()` 执行复核、MCP 延迟发现、Memory、Telegram / Console 适配、Inbox 的接收与投递分离、
Tool Ledger。ADR-0006 规定模型提供商只接受单个显式 API key；ADR-0014 规定工具由人注册；
ADR-0020 / 0021 记录远程 PTC sandbox 与控制面 / 执行面分离尚未通过验收。

## 决策驱动因素

- 用户不需要知道 Tool、MCP、Capability、Registry、Pin 的存在；这不是模板系统也不是工作流构建器。
- 初始化必须幂等、可重试、可跨重启恢复；不允许 Bot 显示 Ready 而基础运行环境实际不可用；
  多次请求不能重复创建同一个 Bot 的工作区与持久化资源。
- 未配置的基础服务必须明确标记 `unavailable`，不能伪造 Ready。
- Computer 能力必须有经过验证的 OS 级隔离与资源限制；没有经过验证的沙箱时不能把宿主 bash
  当作安全的默认执行环境。
- 严禁把 API Key 注入模型上下文、把长期凭据写入普通 Bot 配置、写进日志，或允许模型自行读取 /
  授予权限。
- 平台基础能力默认提供；外部集成在用户授权后自动加入；模型不能自行注册 Tool 或授予权限；
  Tool Search 只搜索当前实际可用的工具；实际执行前仍必须检查权限。
- 本阶段未实现 OAuth Integration，不能伪造连接成功，只实现状态抽象与授权请求接口。
- 保留 Tool Governance / Tier 1 / Tier 2 / Tool Search / Lazy Loading / Tool Pin / MCP / Trust /
  Authorization / Replay / Schema Hash / Tool Ledger；不能把它们混成一个开关，也不能因为 Bot
  创建成功就开放所有高风险工具。
- 必须考虑平台级资源配额、并发限制与供应商调用成本。

## 备选方案

| 方案 | 优点 | 不采纳的原因 |
| --- | --- | --- |
| Bot Template / Capability Pack，用户选择预设 | 实现快、UI 直观 | 明确禁止；用户仍要理解并配置能力，且与模板系统无异 |
| 新建一套独立的Agent runtime 与工具系统 | 可完全按规格设计 | 推翻现有架构；丢失治理、恢复、重放、Ledger 等已验证设施 |
| Bot 创建成功后默认打开全部工具 | 零配置成本最低 | 直接违反「不能因创建成功就开放高风险工具」，宿主 bash 无隔离 |
| 把能力状态写进 Bot 行、由模型参数控制 | 无新表 | 凭据与授权会进入模型可影响的契约；无法区分宿主事实与用户选择 |
| 用 Mock 的健康检查与 Mock 的 Integration 连接冒充生产实现 | 演示流程完整 | 明确禁止；会伪造 Ready 与「已连接」 |
| 把所有概念合并为一个 `enabled` 开关 | 简单 | 把 Governance / Tier / Pin / MCP / Trust / Replay 混成一个开关，明确禁止 |

## 决策

1. **Platform Manifest 是宿主事实，不是用户配置。** `buildPlatformManifest()` 从 `readConfig()`
   得到的部署事实生成冻结清单（core / memory / web / workspace / computer / task / integration），
   每项带 `available | unavailable`、`host-verified | configured-only | not-configured` 与运维可读
   原因，并生成稳定 sha256 指纹。`PLATFORM_WEB_SEARCH_API_KEY` 是宿主自有凭据，永不进入模型
   上下文、Bot 行、工具声明、日志或 prompt；与 `CCR_PROFILE` 同时配置会启动失败（两者提供同名
   工具）。`PLATFORM_SANDBOX_VERIFIED=1` 必须同时配置远程执行面，否则启动失败。
2. **Capability Resolver 是唯一的「注册 → 可执行」决策点，但不执行工具。** 它把 Manifest、
   Integration 连接状态与宿主内部覆盖合并成 `CatalogProfile` + `ToolScope` + 精确工具名的拒绝
   原因。声明过滤仍由 `catalogFor()` 完成，执行复核仍由 `registry.review()` 完成；新增拒绝码
   `TOOL_CAPABILITY_UNAVAILABLE` 只让直接调用得到「哪项能力不可用、为什么」的明确答复。
   `integration_*` 归入 `core` 组，无需第九个开关。
3. **BotProvisioner 是持久化的单写者状态机。** `provisioning → ready | degraded | failed`，
   claim / finish 走 Inbox 的 `BEGIN IMMEDIATE`。流程为：claim → resolve → configureBot（宿主决定
   cwd / 会话 / catalog / 精确原因）→ 持久化真实 conversationId → 真实健康检查（工作区可写、
   持久会话可读、核心工具 available）→ finish。可选能力缺失是 `degraded`，必需能力
   （core / workspace）缺失或健康检查失败是 `failed`；只有 ready / degraded 允许对话。
   中断的 `provisioning` 行按未知结果重新 claim，不假定已完成；同一 bot 的并发调用共享一次尝试。
   Ready 行在重启时不可信：每次启动强制一次 configure 以重建内存中的会话 catalog，并对同一
   工作区 / 会话重新体检。指纹变化触发重新初始化。失败不吞掉、不伪造成功，原因经脱敏后持久化。
4. **首次进入自动创建第一个 Bot。** `BotManager.start()` 用 `ensureBot` 注册 `default`，复用根
   会话；新 Bot 只需一个名称（可选系统提示词）。新 Bot 先写 `pending:<botId>` 占位行，再由
   provisioner 创建真实会话并持久化其 id——先持久化再确认，崩溃不会留下两个工作区或两个会话。
   工作区路径由 userId + botId 派生，浏览器无法指定路径、会话、模型、工具或凭据。
5. **外部集成只登记授权请求。** `IntegrationRegistry` 覆盖五个服务，状态为
   `disconnected | authorization_pending | connected`；`request()` 由宿主生成幂等请求 id，返回
   `connected: false` 与 `implementation: not_implemented`；持久化层直接拒绝写入 `connected`。
   `integration_status` / `integration_request` 是 core 组的受治理工具，模型可查询状态或请求授权，
   但不能自行连接或授予权限。
6. **Computer 默认关闭。** 未验收 OS 隔离时 `shell` 与 `ptc` 均为 false；QuickJS 只约束脚本，
   其嵌套 bash / file 调用仍会到达宿主执行环境。宿主 bash 不作为零配置默认值。
   远程部署的工作区健康检查读取 `openAgent()` 启动时真实完成的 RPC `health.check` 结果；
   无法验证的执行面（如 SSH broker）保持失败并允许重试，而不是报 Ready。
7. **保留旧能力面的宿主内部兼容开关。** `ALLOW_LEGACY_CATALOG=1`（或 `ServiceOptions`
   的 `allowLegacyCatalog`）才开放 `POST /api/bots` 的 `profile` / `toolScope` 与 `PATCH`，
   默认关闭。`dashboard/acceptance/run.sh` 为该旧版验收显式设置该值；正常部署不受影响。
8. **控制台只呈现诚实状态。** 移除八个能力复选框与「能力设置」；展示配置清单、初始化状态、
   降级 / 失败原因、重试按钮与集成授权请求。「你好，我已经准备好了。」是平台状态行，明确标注
   不是模型生成的回复，也不写入持久会话。

## 后果

> 2026-11-06 修订：本节记录的是本功能首次决策时的状态。下文「无已验收的 OS 沙箱，Computer
> 默认不可用」等表述已被同日的共享 CVM Execution Host 决策取代，见本 ADR 末尾的分阶段历史。

- 用户首次打开控制台即有一个已初始化的 Bot，可直接交代任务；创建第二个 Bot 只需名称。
- 未部署的服务在 UI 与 `/api/platform` 中显示 `unavailable`，Bot 为 `degraded` 而不是假 Ready；
  基础运行环境不可用时为 `failed` 且禁止对话，可显式重试。
- 凭据、路径、身份与 catalog 全部由宿主提供；Tool Search 只看到解析后实际可用的工具；
  直接调用不可用工具得到精确拒绝原因；执行复核不变。
- 每次启动都会对已 Ready 的 Bot 做一次真实复检并重建内存 catalog，代价是 `attempt` 递增与
  一次幂等的 `configureBot`，换来「不信任持久 Ready 行」的正确性。
- 新增 `bot_provisioning` / `integrations` 表与 `bots.userId`；`userId` 在 catalog 迁移成功之后
  才添加，保证旧库转换失败时原表可逐字节恢复。
- 接受的未完成项（不是 Mock 冒充的生产实现）：无 OAuth 集成市场与真实连接；无供应商实时连通
  探测（Web 仅为 `configured-only`）；无已验收的 OS 沙箱，Computer 默认不可用；无进程内多用户
  账号与认证（单部署单租户，跨用户隔离仍需独立 `DATA_DIR`）；Memory 仍是根会话 / 全局而非
  每 Bot 独立；容器 dashboard overlay 的原始 bash 仍可看到兄弟工作区目录；SSH broker 部署
  缺少执行面工作区探针，零配置初始化会明确失败并保持可重试；PTC 的 CCR 路径仍依赖外部 CLI。
- 平台级成本约束沿用现有边界：Console 最大 Bot 数、请求体 / 文本长度上限、Web 工具并发上限、
  提醒配额、Tool Ledger 与 Loop Guard；本阶段未新增无界队列。

## 分阶段决策与缺陷历史

### 2026-11-06：Phase 1 MVP

- 相关 spec：`docs/spec-20261106-zero-setup-bot-runtime.md`（历史文件名，完成后删除；
  含编码前 8 点检查：已有能力 / 缺失能力 / 修改模块 / 新增模块 / 数据库迁移 / 初始化生命周期 /
  安全边界 / 验收方案）。
- 决策与取舍：如上八条。保留了 ADR-0003 / 0013 / 0014 / 0019 / 0021 的既有治理与执行分离，
  未新建模型循环，未把治理概念合并成开关。
- 相关缺陷：尚未发现。已通过 `npm run check`、`npm test`（含 `test/zero-setup.test.ts` 与
  `test/zero-setup-wiring.test.ts` 的单元与端到端验收）；本地控制台与真实模型供应商、远程 RPC
  sandbox 的部署验收由运维在单机部署上执行，本 ADR 不把未执行的部署验证记为已通过。

### 2026-11-06：共享 CVM Execution Host（Phase 1 架构决策修订）

- **决策**：Aster Dashboard 明确为单用户 MVP，停止实施「每 Bot Docker 容器」「Bot Container
  Provisioning」「每 Bot 独立 UID」「多租户资源隔离」。Lighthouse（10.1.4.9）继续运行 Agent
  Runtime、Session、Memory、Task 与 Tool Registry；CVM（172.16.0.7）提供一台共享 Computer /
  Execution Host。所有 Bot 经现有 mTLS RPC 共用同一套软件环境（Bash、Git、Python、Node.js、
  Claude Code、Herdr 等 CLI）；CC、Herdr 不抽象为独立 Agent Tool，统一通过 Bash 使用。每个 Bot
  保有独立对话、记忆与任务状态及各自默认工作目录，但**不要求 OS 级隔离**。
- **对上文决策的修订**：决策驱动因素第 4 条「Computer 必须有经过验证的 OS 级隔离与资源限制」、
  决策 1 的 `PLATFORM_SANDBOX_VERIFIED=1`、决策 6「未验收 OS 隔离时 shell 与 ptc 均为 false」
  在本阶段被本节取代。Computer 能力改由「已配置 rpc 传输」这一宿主事实提供；启动时的 RPC
  `health.check`（`directBash` / `fileTools` / `sharedMode: "rw"` / `ptc: false`）与各 Bot 工作区
  探针保持 fail-closed，`PLATFORM_SANDBOX_VERIFIED` 从配置中移除。`defaults.ptc` 仍恒为 false：
  Phase 1 只迁移 Bash / Read / Write / Edit，codemode 与其它工具族留待后续阶段。
- **执行面约束**：Execution Service 以专用非 root Linux 用户运行，不允许 root、sudo、Docker
  Socket 或 Lighthouse 凭据；保留执行超时、并发控制、进程组终止、输出限制、审计与「RPC 断线
  不自动重放」；宿主运行时环境（`PATH` / `LANG` / `HOME` / `TMPDIR` / `PTC_INSIDE_SANDBOX`）
  由执行面固定，wire 上的 `env` 只能携带任务变量，试图覆盖宿主变量按 `invalid_request` 拒绝且
  不执行；`inheritEnv` 被忽略，执行服务的进程环境不进入命令；保留原有 RPC Gateway 与 mTLS
  设计，不重新开发传输协议。
- **交付边界**：本次只提交代码、测试与可审查的部署步骤
  （`docs/runbook-shared-execution-host.md`），**未自动修改 CVM 生产服务、系统权限或防火墙**。
  `dashboard/docker-compose.dashboard.yml` 中的 `execution-host` 只是单机验收用的同机替代，
  生产仍走 `docker-compose.rpc.yml`。删除 `dashboard/sandbox.Dockerfile`、
  `src/execution/sandbox-main.ts`、`src/execution/container-executor.ts` 与
  `test/container-workspace.test.ts`；新增 `src/execution/shared-host.ts`。
- **取舍与代价**：不再提供 OS 级隔离或多租户边界；共享主机上一个 Bot 的 bash 能看到兄弟工作区
  目录，这是被接受的架构取舍，不得在文档中描述为待修复缺陷。收益是复用既有 mTLS RPC、沿用
  控制面／执行面分离，并让所有 Bot 共享一套软件环境。
- **相关缺陷**：尚未发现。`test/shared-host.test.ts`（含真实 Unix socket 上 Bash / Read / Write /
  Edit、工作区隔离与超时的 Linux 回环）、`test/shared-host-workspace.test.ts`、
  `test/zero-setup.test.ts` 通过；CVM 部署验收由运维按 runbook 执行，本 ADR 不把未执行的部署
  验证记为已通过。

### 2026-11-07：Bot 删除语义与长期记忆归属

- **决策 9（删除 Bot）**：`DELETE /api/bots/:id` 写入即时生效的墓碑——状态 `deleted`、从列表隐藏、
  `botId` 永久不复用、运行中或有待处理输入时 409 拒绝——会话与记忆的物理回收放在**下一个进程
  边界**：进程启动时、`openAgent()` 打开 harness 与任何会话**之前**执行 purge。同一份实现另以
  离线运维命令暴露，用于不愿等待重启的回收。purge 收在单一接缝之后：上游一旦提供
  `deleteConversation`，整体替换实现，业务层不动。到达这个进程边界有三条路：自然重启或下一次
  部署（默认，启动 purge 一次清空全部积压墓碑，删 N 个 Bot 只付一次重启）、离线运维命令，以及
  **可选的「请求即重启」**（body 带 `purge: "now"`，默认关）：一个进程承载所有 Bot，所以它中断的
  是其它 Bot 在途的工作，故在其它 Bot 运行中或有待处理输入时以 409 拒绝并列出受影响的 Bot，且必须
  先写出响应再退出。删除的即时性因此不依赖运维动作：默认即时的是用户视角的移除，物理回收的时点是
  可选的、显式的。
- **事实依据**：pi-durable 1.3.0–1.5.0 的 `Storage` 接口没有删除方法，仅有 `removeInboxItem` /
  `removeCompactionStatus` / `removeNestedSlots`；`Conversation.reset()` 只写入 `pi.reset`
  条目（"starts a new context"），不删除任何内容。受影响的行分布在 `entries` / `documents` /
  `document_revisions` / `tasks` / `submissions`；`record_ids` 与 `mintId()` 的水位不得回滚，
  `mintId()` 承诺返回值 "greater than every ID minted or stored before, also across reopen"。
  `durable_schema` 记录迁移版本，1.4.0 把 SQLite 升到 schema 2 且迁移后的库无法被 1.3.0 打开，
  因此宿主自删行与底座内部 schema 逐版本耦合——这是把它收在接缝后并向上游要 API 的理由，而不是
  可长期维持的方案。
- **备选方案**：
  - 请求内同步删除（冻结 harness 后删行）：删除一步完成；不采纳，因为服务是常驻进程，harness 与
    所有 Bot 会话在进程退出前一直打开（`BotManager` 没有空闲回收），不存在安全的进程内窗口，
    且 `VACUUM` 要求独占且不能在事务内。
  - 只提供离线运维命令：完全不碰启动路径；不采纳，因为删除要等一次人工命令，与「直接删」的用户
    语义不符。这一条要的「不必等运维」已由决策 9 的可选「请求即重启」吸收，而它仍不是默认行为。
  - 更换底座：可能自带删除原语；不采纳，因为删除难在语义（append-only 恢复日志对用户数据擦除），
    不是 API 缺失，且 `src/memory` 几乎整体建立在底座的 documents / compaction 契约上，而
    `src/execution` 与底座无关，换底座的代价正好落在最难重建的一层，见 ADR-0013。

- **决策 10（长期记忆归属）**：长期记忆改为**按 Bot 可选、新建 Bot 默认关闭**；working memory 与
  compaction 保持常开，它们的作用域是会话（`scope: "conversation"`），随会话一起删除，不构成
  独立的长期存储。
- **对上文决策的修订**：后果一节记录的未完成项「Memory 仍是根会话 / 全局而非每 Bot 独立」由本节
  转为待实施的方向，不再作为接受的现状。现状是：记忆集成绑定 root 会话（`integration.ts` 的每一处
  都以 `root.id` 取值，归档只扫描 root 的 entries），而 root 会话属于 `default` Bot；daily 归档写在
  全局 Markdown（`DATA_DIR/memory/daily/*.md`），`MemorySegment` 没有 owner 字段。因此普通 Bot
  今天没有长期记忆，删除它不产生 daily 负债，只有显式开启长期记忆的 Bot 才有这层负债。
  备选（未采纳）：**A** 维持仅 root 并禁止删除 `default`——零改动、删除语义最干净，但非默认 Bot
  永远没有长期记忆；**C** 在 B 之上保证按 Bot 可擦除——需要解决 provenance（归档游标与批次
  `ArchiveDoc` 是 `scope: "conversation"`，归属信息正好存在被删的那一侧），做法是把 daily 改为按
  Bot 分目录，或给 segment 增加 owner 字段（需要迁移）。B 落地时若记忆仍按会话绑定，C 只在真的为
  非默认 Bot 开启记忆时才必须做。
- **取舍与代价**：删除生效分两步（墓碑即时、回收在下次进程边界），换来不冻结常驻 harness；宿主动
  底座内部 SQLite 是有意的技术债，须按底座版本复核并收在接缝之后。长期记忆默认关闭会让新建 Bot
  不自带记忆——这正是本决策要的边界，代价是长期 Bot 需要显式开启。
- **决策 11（保留 Bot 的删除语义：重置）**：`default` 是保留 Bot，`DELETE /api/bots/:id` 对它不
  表示「删除」而表示「重置」：保留 `bots` 行与 root 会话行，物理清空该会话的历史内容（`entries` /
  `documents` / `document_revisions` / `tasks` / `submissions`），响应与控制台措辞都明确标注
  重置而不是删除，也不从列表隐藏、不复用其它 Bot 的墓碑语义。理由：`Harness.root()` 的契约是
  「保留会话，不存在时创建」，删掉 root 的行只会换来一个新的 root（新 id），那是重置而非删除；
  而真删 `bots` 行会让 root 变成没有归属的会话——`#target` 只把 `botId === "default"` 映射到哨兵
  `"root"`，于是没有任何请求再落到 root 上，`usesMemory`（`conversation.id === root.id`）永不成立，
  整个部署的长期记忆随之失效。那不是「删一个 Bot」，是关掉一项平台能力。重置沿用同一份 purge
  实现与同一个进程边界（启动时、`openAgent()` 之前），并受同样的 409 条件约束（运行中或有待处理
  输入时拒绝）。
  与决策 10 的相互作用：今天只有 root 写 daily 归档，所以「重置该 Bot 的记忆」与「清空 daily 存储」
  当前恰好等价；这是记忆仅绑 root 的巧合，记忆按 Bot 可选之后不再成立，因此实现必须按归属模型
  清理，而不是按目录清空。
- **删除范围与护栏（本轮确认）**：范围按**作用域**过滤、不按 kind——删该会话的 `entries` /
  `documents` / `document_revisions` / `tasks` / `submissions`，以及 `scope: { kind: "conversation",
  conversationId }` 的文档（含 Tool Ledger 的 `personal.tools.loads`）；**保留** `record_ids`、
  `durable_schema`、`scope: { kind: "session" }` 的文档（含 `personal.tools.catalog`）与其它会话的
  每一行。工作记录随会话一并删除（甲），不留悬空 `conversationId`：删除后「这个 Bot 做过什么」不可
  答，只留「删过什么」——由墓碑行的 `removalKind` / `removalAt` / `removalForced` / `removalReason` /
  `removalReport` 承载，计数不含正文。未知结局按 `docs/contracts-and-lifecycle.md` 的「不标记为成功，
  也不假定没有执行」处理：非终态 task 或未结算 submission **硬拒绝**（`force` 不放行）；终态但结局
  未知者默认拒绝、显式 `force` 可越过并在留痕中记录；实现时若无法可靠区分，保守做法是要求 `force`。
  删除只经控制台 API，**不暴露为模型工具**，模型参数不能指定范围或凭据；墓碑生效期内响应不得声称
  物理擦除已完成（不伪造成功）。
- **开放项**：保留 Bot 的可改性——今天 Bot 创建后无法改名（`inbox.ts` 没有 `setBotName`，只有
  conversation / status / tools / catalog 四个 setter），而它的工作区仍是 `/workspaces` 本身上一层
  （`src/main.ts` 记录的历史路径，改动需要显式数据迁移决策）；与删除语义无关，单独待定。
  原 ① ② 已随本轮确认并解决：`inbox` / `deliveries` / `failures` 中属于该 Bot 的行随会话清理
  （`inbox.text` 是用户正文，留着则「删除」名不副实，且 `pendingForBot` 会永久非零；`deliveries` /
  `failures` 的引用行一并清理以免悬空），`VACUUM` 在同一启动窗口内、purge 之后、`openAgent()` 之前
  执行，仅在本次确有删除时执行，失败不阻塞启动但要报告。
- **上游与后续**：`earendil-works/pi` issue #11026 即请求该原语（open），本项目的用例与事实已于
  2026-11-07 以明确标注 AI 生成的评论补入该 issue；接缝的验收标准是上游提供 `deleteConversation`
  时能整体替换。本决策的实现契约见临时规格 `docs/spec-20261107-zero-setup-bot-runtime-deletion.md`
  （按约定在完成后删除，长期结论已由本节承载）。
- **相关缺陷**：已知代价（不是缺陷）：行级回收需要一次进程重启，可选的自重启把它收敛成单次请求，
  默认仍不等。→ 本节所述实现已于 2026-11-08 落地，结果、与规格表格的差异及实现暴露的缺陷见下一节；
  测试固定在已安装底座的 schema（1.3.0）上，升级底座时按 ADR-0013 先对未完成调用做兼容。

### 2026-11-08：删除与重置的实现结果（决策 9 / 11 落地）

- **交付**：`DELETE /api/bots/:id`（普通 Bot 墓碑／保留 Bot 重置）、启动窗口的行级回收、与启动共用
  同一实现的离线入口 `npm run bots:purge`、`DATA_DIR/service.lock` 单写者判定、可选自重启
  `purge: "now"`、以及墓碑行上的五列留痕。接缝按决策 9 收成单点：`src/conversation-purge.ts` 是唯一
  执行这些删除语句的模块，`src/bot-removal.ts` 是唯一的一遍回收，`src/bot-purge.ts` 是离线入口，
  `src/service-lock.ts` 是单写者判定。现行契约与限制写在
  [契约与生命周期](../../contracts-and-lifecycle.md) 的「Bot 删除与重置」；临时规格
  `docs/spec-20261107-zero-setup-bot-runtime-deletion.md` 第 10 节逐项标注了覆盖证据与未覆盖项
  （按文档约定，该 spec 在功能开发完成后删除，长期结论与缺陷由本节与契约文档承载；上表与本节引用的
  文件名保留为历史标识）。
- **验证**（本地，2026-11-08）：`npm run check`、`npm run build` 退出 0；`npm test` 406 项、390 通过、
  **0 失败**、16 项 POSIX／root 专属跳过。新增 `test/conversation-purge.test.ts`（9 项）与
  `test/bot-deletion.test.ts`（9 项）：前者用真实底座行重开存储断言作用域与 id 水位，用构造行锁住
  版本闸门、两个拒绝分支与行数上限；后者经真实 HTTP 路由与真实服务组合覆盖墓碑／重置、四类 409、
  退役 id、`purge: "now"`、重复请求幂等与离线入口（以**子进程**运行真实命令）。**部署验收未执行**，
  本节不把它记为已通过。
- **对决策 9 / 11 的细化（实现时确定，与规格 §3.1 表格的差异）**：
  1. 非终态工作与"终态但结局未知"是两个错误码：`work_in_flight`（带 `tasks`／`submissions` 计数，
     `force` 不放行——"先去取消再重试"是可行动的下一步，合成一个码会让这条动作失去名字）与
     `unknown_outcome`（带 `records` 计数，`force` 放行）。判定谓词按 1.3.0 的真实记录固定：
     `tasks.status <> 'terminal'` 与 `submissions.status IN ('queued','placed')` 为在途；
     `terminal` 且 `outcome.status <> 'completed'`、以及 `unanswered` 为结局未知。
  2. 补入 `fork_survivor`：删掉被其它会话继承的历史会让继承者读不出来，因此默认拒绝、`force` 时
     连同继承者一并删除。当前部署不产生分叉，但这一条在接缝处必须是显式拒绝。
  3. `agent.sqlite` 的行与 `inbox.sqlite` 中该 Bot 的请求行**都在回收 pass 里删除**，不在请求时删除：
     墓碑即时生效，而 `inbox.text` 是用户正文，属于被擦除的内容，物理上留到下一个进程边界。
     响应文案因此必须承认"用户视角已移除、回收另有其时点"。
  4. 每会话的 purge 报告不再携带 vacuum 字段；`VACUUM` 由 pass 拥有（确有删除时执行一次，位于删除
     之后、`openAgent()` 之前），因为 `VACUUM` 需独占且不能在事务内。
  5. 版本闸门是**精确的列集合**匹配：缺列与多列都拒绝。多一列意味着底座比本实现新（或库被迁移过），
     而下面的谓词照样会运行——那正是闸门要挡的情况。库不匹配时删除被拒绝，服务照常启动。
  6. 事件流路由在打开流之前做一次可寻址检查：流会先写出 200 头，否则墓碑 Bot 只能得到"200 + 错误帧"
     而不是规格 §3.2 要求的 `410 bot_deleted`。
- **相关缺陷**（本轮实现暴露、未修，全部记入契约文档的「已知限制」）：
  1. 失败的删除没有控制台读出口：`views()` 过滤 `status = 'deleted'`，运维只能从部署日志
     `Bot removal failed: <botId> (<CODE>)` 与 `inbox.sqlite.removalError` 查因，`/api/platform`
     只给 `pendingPurge` 数量。
  2. 锁的同 pid 接管规则（为测试内嵌两次 start 而设）使**同一进程内**调用 `purgeBots()` 时不会拒绝
     正在运行的服务。发布的离线入口是独立进程，因此生产路径安全，但进程内调用不是受支持的用法；
     没有选择在该处加判定，是因为"锁的 pid 等于自己"无法区分"本进程的服务持有"与"崩溃后被复用的
     pid"，加判定会把罕见的 pid 复用变成一个没有 `--force` 出口的死锁。
  3. 控制台与 `BotManager` 的日志走 `console.error`（进程 stderr），不经过宿主可注入的 `log`，
     嵌入宿主无法从自己的 sink 拿到删除日志行（本次测试因此改为断言"宿主确实下线"而不是日志文本）。
  4. 崩溃窗口（`agent.sqlite` 已删、`inbox.sqlite` 未删）只由"pass 可重跑且收敛"覆盖，没有做进程级
     中断测试；`VACUUM` 的体积变化与 `integrity_check` 也没有断言。
- **仍未验证**：容器重启策略拉起自重启、Docker 卷上的 `VACUUM` 行为、真实模型供应商下的端到端删除，
  以及临时规格第 10 节标为 `[~]`／`[ ]` 的条目（进程级中断、`deliveries`／`failures` 历史行、工具目录
  与 pin 的逐项对比、日志逐字断言）。
