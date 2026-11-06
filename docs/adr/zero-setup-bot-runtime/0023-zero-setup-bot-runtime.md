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
