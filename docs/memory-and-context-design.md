# Memory 与 Context 实施方案

> 当前记忆入口：working 状态与每日事件归档。`workspace/MEMORY.md` 已于 2026-10-28 退役，应用不再创建或指示模型读写它；存量文件保留，见 [ADR-0004](adr/0004-retire-workspace-memory-md.md)。下文的迁移验收仍保留对旧文件的历史说明。

状态：方案已确认。MEM-01 已完成契约冻结与底座时序验证（结论见第 12 节），MEM-02 已实现 Working 状态与版本化更新（结论见第 13 节），MEM-03 已实现纯 Context 规划与快照渲染（结论见第 14 节），MEM-04 已实现每日 Markdown 的发布与检索（结论见第 15 节），MEM-05 已实现可恢复的增量归档（结论见第 16 节），MEM-06 已实现原生压缩接入与周期快照切换（结论见第 17 节），MEM-07 已完成组合接入并注册到运行中的 agent（结论见第 18 节）；MEM-08 已执行验收与 DeepSeek 真实模型、目标服务器补测（结论与未解决项见第 19 节及 [验收记录](memory-verification.md)；其他提供商质量与真实窗口标定仍待验证）。编制日期：2026-10-25。本文完整替换此前的记忆设计计划，是本轮架构、数据归属和模块 Interface 的权威来源；实施拆分与完成条件见 [实施 issues](memory-implementation-issues.md)。

本文保留记忆架构与各阶段实施结论。第 12～19 节中的测试数量、待办与验证结论按原阶段及后续补测解读，不构成其他功能的开发限制。新功能采用 [按功能的临时 spec](README.md#按功能的临时规格)，实际运行与生产证据见 [README](../README.md)，请求、工具和投递契约见 [contracts-and-lifecycle.md](contracts-and-lifecycle.md)。底座以已安装的 pi durable / pi-ai 1.3.0 为准。

## 1. 交付目标与范围

保留一个持续的 root Conversation，用三块上下文支持跨轮、跨日任务，同时控制输入规模和前缀变化：

| 块 | 内容 | 变化时机 |
| --- | --- | --- |
| A：稳定规则 | system prompt、核心工具声明、固定记忆使用协议 | 应用配置或工具集合变化 |
| B：周期快照 | 连续性摘要、压缩边界对应的 working 基线、适用偏好与必要配置快照 | 初次建立上下文；新的压缩或重置上下文正式生效 |
| C：追加流水 | 保留的近期原文、新输入、assistant、工具结果、working 修订与检索结果 | 新内容进入底座时追加 |

一个周期是两次有效压缩之间的区间。周期内保持 B 的原文，C 的已有部分保持不变：

```text
请求 n     A | B7 | T1 ... Tn
请求 n+1   A | B7 | T1 ... Tn | Tn+1
压缩生效   A | B8 | 保留的近期流水 ...
```

每次主 agent 模型调用都携带 system prompt，包含工具后续调用、重试、恢复及压缩后调用。system prompt 继续由应用的 `instructions` 提供，不引入职责说明文件。摘要模型使用专用系统提示。

本轮增加 working JSON、周期快照、每日 Markdown 归档和有界检索。移除独立的应用 history 记忆层；底座原始 Entries 继续保留为恢复记录和证据，通过来源定位读取。上下文压缩不删除持久化历史。

MEM-01～08 的原实施包未包含向量检索、自动用户画像、定时推送、多用户记忆、插件平台、磁盘历史清理或独立于模型窗口的严格 64K 输入上限。这些任务排除项不限制后续功能开发；具体扩展按 [临时 spec 约定](README.md#按功能的临时规格) 设计。agent loop 继续复用 pi-durable，遵循 [ADR-0013](adr/0013-pi-durable-agent-loop.md)。观察期的用户画像见 [ADR-0016](adr/0016-user-profile-working-memory.md)：存在 working 状态里，从每日归档提取，不另起模型循环。

## 2. 当前实现与需要新增的能力

当前应用通过 `root.configure({ instructions })` 设置系统提示，将原文提交给 root Conversation；底座派生消息、执行工具并自动压缩。长期目标、约束和明确偏好通过 working 工具管理，历史事实经每日归档与检索访问。

宿主记忆投影、归档任务与原生检索工具已由 MEM-07 接入运行入口（第 18 节）。数据契约（schema、文档定义、范围与日期规则、错误分类）已由 MEM-01 冻结在 `src/memory/contracts.ts`；每日记忆的文件协议已由 MEM-04 实现（`src/memory/daily.ts`）。

按 issue 划分的状态：MEM-01 冻结了数据契约；MEM-02 实现了 Working Module 与两个原生工具（`src/memory/working.ts`、`working-tools.ts`）；MEM-03 实现了纯 Context 规划与快照渲染（`src/memory/context.ts`）；MEM-04 实现了每日 Markdown 的发布、按引用读取与有界检索（`src/memory/daily.ts`）。MEM-05 实现了独立可恢复的增量归档 Task（`archive.ts`、`archive-task.ts`）。MEM-06 实现了 compaction Adapter、周期切换确认与轮数评估（`src/memory/compaction.ts`）。MEM-07 实现了组合入口（`src/memory/integration.ts`）与原生检索工具（`src/memory/memory-tools.ts`），并已在 `src/agent.ts` 注册：记忆能力已接入运行中的 agent；MEM-08 的后续验收与 DeepSeek 补测结论见第 19 节和 [验收记录](memory-verification.md)。

底座现有接入能力：

- generation 准备阶段渲染 sections、计划 `pi.system` 补丁，再固定请求 cutoff。
- `context()` 按 head marker、Entries 和 edits 派生有效消息，维护工具调用与结果关联。
- `CompactionTask.beforeCompact` 接收选定的旧范围、messages 和 `firstKept`，可拒绝压缩或提供摘要文本。
- `GenerationTask.beforeRequest` 可替换单次请求 messages，但替换不自动持久化。hook 的声明类型 `HookApi` 只保证读取和 memo；MEM-01 实测运行时传入的对象是该 Task 的完整 `TaskRuntime`，额外带有 `commit()`、`signal`、`snapshotAsOf`、`entry()` 等（第 12 节）。应用只使用声明类型中的成员和 `Harness.commit()` 完成持久化，不依赖未声明的成员。memo 在该 Task 尚未终结时保留且首次写入获胜；任务终结后不可读，因此不能充当长期操作回执。
- 普通 hook 异常会被报告后继续执行。`beforeRequest` 抛错不能保证阻止模型调用；`beforeCompact` 抛错可能回落到默认摘要。不能用抛错实现必需快照或硬预算的强制保证。
- 原生工具可通过 `api.commit()` 更新应用 Document；原生 write submission 在合法边界进入模型上下文。

原生 hook 不等于完整的 context builder。发布顺序、checkpoint、模型调用记账和恢复接入已由 MEM-01 用公开 API 验证，结论见第 12 节；仍未验证的部分在那里逐条标注。不能通过修改依赖包、私有导入或绕开 admission 补齐。

## 3. 数据归属

| 数据 | 权威来源 | 生命周期与用途 |
| --- | --- | --- |
| 助手职责、记忆使用协议 | 应用代码提供的 `instructions` | 稳定规则，每次主模型调用可见 |
| 当前业务状态 | `personal.working` Conversation Document，JSON | 随任务变化，支持按 Entry 读取历史版本 |
| 周期快照 B | 初始应用 Entry 或已发布的 `pi.compaction` Entry | 不可变投影，带 schema 版本、来源边界和 working revision |
| 原文、工具执行和恢复状态 | 底座原生 Entries、Tasks、Documents | 原样复用；应用不维护执行状态副本 |
| 每日事件记忆 | `DATA_DIR/memory/daily/YYYY-MM-DD.md` | 可增量写入、可检索，保存有价值事件及来源 |
| 归档覆盖位置与待发布结果 | 应用归档 Document／底座归档 Task checkpoint | 只表示应用拥有的归档进度 |

working、B 和每日记忆中可以出现同一事实，但各自回答不同问题：working 表示当前业务状态，B 表示某个上下文边界的投影，每日记忆表示过去发生的事件。历史中的旧值和摘要不能覆盖后续明确修订。

没有独立可写的 `working.json` 副本。若提供文件查看功能，它是带 revision 的只读导出。JSON 数据采用版本化 schema；`defineDoc.version` 管数据结构迁移，业务 `revision` 只在实际变化时递增。

## 4. 模块与解耦约束

这里的 Module 指拥有一个小 Interface 的实现集合；Adapter 负责接入具体底座或文件系统。Interface 包含类型、错误、顺序、副作用和预算约定。下表限定依赖方向，不要求一行对应一个 class。

| Module | 小 Interface 的职责 | 实现可以知道 | 调用方不应承担 |
| --- | --- | --- | --- |
| Working | 读取当前／指定边界状态；应用有来源的变更 | 业务 schema、revision、任务和偏好生命周期 | 文档迁移、冲突检查、操作去重 |
| Context | 根据已读取的事实制定加载、预算和压缩决策；稳定渲染 B | 应用快照、revision、预算、来源引用 | 文件扫描、模型调用、底座调度 |
| Daily Memory | 按稳定分段 ID 发布；有界 search/read | Markdown 格式、目录约束、原子替换、分页 | 拼文件、查重、遍历所有日记 |
| Archive | 推进有界来源范围的提取、发布、确认 | 归档协议、来源分页、提取器和 Daily Memory Interface | 重试窗口、跨日分组、连续覆盖检查 |
| Durable Adapter | 映射 native tools、hooks、Documents、Tasks 和来源读取 | pi durable / pi-ai 原生类型与公开接口 | SDK 内部阶段、消息排序和提交细节 |
| 应用组合入口 | 配置依赖并注册 Adapter | 已构造的 modules、配置和生命周期 | 记忆正文处理、摘要算法、文件协议 |

依赖方向：应用组合入口接入 Durable Adapter；Adapter 调用 Working、Context 和 Archive；Archive 调用 Daily Memory。Context 接收已固定的输入，不读取 Daily Memory，也不在组装时调用模型。查询工具通过 Daily Memory 读取，结果按原生工具路径进入 C。

实现尺度：

- 先使用普通函数和少量有状态 module，不为每个存储操作建立一层转发 class。
- 仅在真实变化点注入依赖：模型提取器、时钟、文件根目录以及底座接入。单一文件后端不预建通用存储插件协议。
- 应用只定义自己拥有的 `WorkingState`、`CycleSnapshot`、`MemorySegment`、`ArchiveBatch`、`ContextPlan` 等契约。原生 Message、Entry、Task 和 ID 使用 SDK 类型，不能复制等价定义。
- 纯业务与规划函数不依赖 Harness、Telegram、全局环境变量或文件系统；使用 SDK 的类型引用不等于依赖其运行时。
- `src/agent.ts` 只保留组合和原有请求生命周期；`src/telegram.ts`、inbox、投递实现无需理解三块上下文。
- modules 通过返回结果或显式调用合作，不互相监听和改写对方内部状态。持久化通知先有可恢复事实，再有处理动作。

建议代码归属：`src/memory/working.ts`、`context.ts`、`daily.ts`、`archive.ts`；SDK 接入放在 `src/memory/durable-*.ts`，模型提示与转换放在对应摘要／提取 Adapter。MEM-01 已建立 `src/memory/contracts.ts` 作为共享契约的唯一位置，并行 issue 在此基础上添加各自 module，不另建近似类型；这些路径不是要求增加空文件或包装层。

## 5. Working：当前任务与常驻偏好

working 保存当前目标、范围、约束、已确认进度、阻塞、下一步、简短近期说明和关键来源。成功状态须引用已提交的工具证据；工具是否执行、generation 是否运行、Telegram 是否送达仍由其原生记录决定。

跨任务偏好与当前任务分别建字段。偏好必须有明确用户来源、适用范围及必要的有效期；任务完成只清理任务状态，不清理有效偏好。自动事件归档不自动建立永久偏好。默认值、事实和授权保持原有语义，旧授权不能因检索被重新授予。

用户画像在观察期也放在同一份 `personal.working` 里（[ADR-0016](adr/0016-user-profile-working-memory.md)）。`profile` 的每条有 `id`、`text`、`category`、指向每日归档分段的 `evidence`（`date`、分段 `id`、`page`）和 `updatedAt`。条数上限是 `MEMORY_LIMITS.profile`（与偏好相同，32），类别长度上限是 `MEMORY_LIMITS.category`（与标识符相同，64）。来源是 `DATA_DIR/memory/daily/` 的每日日志。画像随 working 基线进入周期快照，和任务、偏好共用 `snapshotTokens`（`MEMORY_BUDGET_DEFAULTS` 为 `6 * 1024`）。条目的 `updatedAt` 与状态自身的 `updatedAt` 一样不进入渲染。存量文档由 `WorkingDoc` 的结构版本 2（`migrateWorkingDocument`）补上空 `profile`；JSON 里的 `version` 仍是 schema 版本 1。周期快照正文里缺 `baseline.profile` 的旧基线在解码时补空数组。从每日分段抽出草稿的函数是 `extractProfileDrafts`（`src/memory/profile.ts`）：只保留正文已经放得进画像条目的当前 `user-requirement`，不另起模型调用。归档任务在批次已发布之后，把放得进条数上限的 `profile.put` 和 `archivedThrough` 写在同一次提交里；同一批次的操作标识稳定，再次提交不再次递增 revision。`profile.put` 提交时由注入的解析器核对证据分段仍在每日日志中且未被替代，缺失或已替代为 `missing-evidence`。Working 模块本身不打开每日文件。`MEMORY_ENABLED=0` 时不创建归档任务，也不会写画像。

拟议工具名为 `working_read`、`working_update`。schema 与执行定义一起维护，更新要求 `expectedRevision`、明确 changes 和证据引用；身份、操作 ID、目录均由宿主提供。Interface 返回成功后的 revision 与有界修订，或明确的校验／冲突／证据错误。

MEM-02 已按本协议实现（`src/memory/working.ts`、`working-tools.ts`），实现结论与实测语义见第 13 节；本节仍是设计意图的表述。

更新协议：

1. 宿主以同一次原生工具调用生成稳定操作标识。
2. 在同一 commit 内先检查操作回执，再检查 revision，更新 Document 并保存应用变更回执。相同操作恢复返回原回执，不能再次递增 revision。
3. 必须有与变更同 commit 的应用 Entry 锚定可 rewind 的状态。该 Entry 可只含应用数据；模型可见修订由原生工具结果承载。
4. 若状态已提交但工具结果未保存，恢复必须重新取得同一回执并让原生调用完成。此窗口验收通过后才能声明安全重放。
5. 内容没有业务变化则不递增 revision；同文本的新调用仍按其操作标识和 revision 处理。

任务开始创建活跃状态；决定或进度变化时更新；完成时先有持久化完成事实和可恢复归档触发，再清理活跃事项。无需等待 Markdown 写入成功，但不能只在内存通知归档后就丢弃最后的完成信息。

## 6. Context builder：输入、输出和每轮行为

应用 Context Module 制定计划和渲染应用资料，最终原生消息组装继续使用底座。它不重建一个自有 messages 历史，也不按任意字符串顺序重排 SDK 消息。

拟议 Interface 的输入是：有效系统配置标识、当前 head/cutoff、已提交周期快照及来源版本、当前预算估算，以及明确缺失的记忆或修订。输出是：无需动作、一个有界待提交投影、压缩意图，或明确的超限／配置错误；同样输入必须产生同样输出。

MEM-03 已按本节实现（`src/memory/context.ts`），判定顺序、输入字段与 B/C 边界的最终表述见第 14 节；本节仍是设计意图的表述。其中“缺失资料投影”尚未实现：模块不接收待补资料的正文，因此已有 B、revision 不变而只缺某份资料时计划为 `none`。该路径需要由承载资料读取的一方（MEM-04 的检索与 MEM-07 的接线）定义输入后再补，MEM-03 不凭空造一种没有来源的投影。

### 首次与新用户请求

先用原 requestId 查已存在的执行；已存在则复用。对新输入，在空闲边界判断是否需要初始化 B 或补充资料，通过原生 write submission 保存固定内容，再提交未经改写的用户原文。派生 requestId 同时绑定载荷摘要；投影已写但输入未提交时复用旧投影，不能重算覆盖。

已有有效 B 时，不在每条用户输入前重建 B，也不每轮全文读取工作台和每日文件。应用配置检查拒绝空白 system prompt。规则和快照计入总预算。

### 每次模型调用及工具后续调用

由底座从 A、B 和 C 的持久化记录组装，固定 cutoff，再交给 pi-ai。working 更新和记忆检索结果直接追加到 C；只有活跃上下文缺少必需版本时才补投影。已固定请求的恢复沿用原投影，不能取最新文件悄悄替换。

普通变化保持 B 不变；对同一字段，后续明确修订覆盖旧基线。若一项撤销或配置变化无法安全地用尾部修订表达，显式提前建立新上下文周期并记录原因，正确性优先于缓存。

`beforeRequest` 可用于验证或观测，但本轮不以它做无记录的大量动态注入，也不从该 hook 等待一个必须在当前 generation 结束后才会发布的压缩。

### 压缩与重置后的初始化

压缩生成的新 B 自带必要 working 基线，长 run 无须等待下一条用户消息才恢复工作状态。显式重置会结束当前周期；下一次调用前须有新的必要快照，不能仅等待用户再发一条消息。已验证的接入顺序见第 12.4 节，不能以提示词代替顺序保证。

## 7. B 的生成：摘要与精确状态分别处理

B 使用版本化的应用格式保存：连续性摘要、结构化基线、来源边界、working revision、所用配置／事实版本。记录来源的 Entry ID 使用原生类型；序列化排序固定，不加入每次渲染都会变化的时间。渲染实现与字节格式见第 14.3 节。

压缩过程：

1. 原生压缩选定 `firstKept`，保持完整工具关联；Adapter 固定被替换的原始范围。
2. 连续性摘要由旧 B 的叙事部分与 C 中较早部分生成，只保留继续任务需要的目标、决定、约束、进度和关键引用。
3. working 基线从切分边界的历史版本读取，并确定性渲染；配置与已载入事实也使用可定位的固定版本，不由摘要模型重新解释。
4. 原生 compaction 发布新的 B，C 保留 `firstKept` 起的原文及后续修订。只有结果正式进入当前活跃上下文，周期才切换。

已验证的发布语义：generation 拥有的阻塞压缩直接 append，结果 `{ entryId }`；conversation 拥有的压缩经 `admitSubmission` 以 `requestId = "compaction:<taskId>"` 入队，结果 `{ submissionId }`，在下一个合法边界才进入上下文。任务终结、入队成功与正式发布是三件不同的事实：经 submission 的路径只有落到 `done` 且 head 变为该 `pi.compaction` 时才切换周期，被 reset 越过而落为 `unanswered`／`stale` 的写入不切换；阻塞压缩没有 submission，须以它返回的 `entryId` 已成为活跃 head 为判据。重启后经 submission 的压缩按 `compaction:<taskId>` 重查，阻塞压缩按任务 `outcome.result.entryId` 与 head 比对，两者都不需重算摘要。详见第 12.3 节。

边界状态必须对应 `firstKept` 之前的可见来源 Entry，不能使用“当前最新 working”。不能用 `firstKept - 1` 或所有被压缩 Entries 的最大 ID 猜测边界：fork、head marker 和资料投影需要 Adapter 按实际可见历史定位。已验证的做法是写入 working 时在同一 commit 追加一个应用锚点 Entry，之后用 `snapshotAsOf(WorkingDoc, …, anchor)` 取该边界值；head marker 的 ID 大于保留原文时仍按锚点读取，不受其影响。锚点不在当前 conversation 的可见祖先内（未覆盖的 fork、锚点早于首条可见 Entry）时 `snapshotAsOf` 抛错，应用映射为 `not-covered` 并显式拒绝，不返回旧值或默认值。

结构化基线与摘要一起进入 `pi.compaction` 的模型可见正文，作为宿主资料而非新的用户命令；不能把 B 全部写入动态 system section。已有 compaction 提示包装与应用格式的解析由一个 Adapter 处理，并有版本及旧摘要兼容路径：正文缺少应用块视为原生／升级前摘要，按叙事处理；应用块存在但版本未知或内容不合法则显式失败，不静默降级。

自定义摘要通过 `beforeCompact` 返回，范围、发布、队列和恢复继续由底座拥有。hook 内产生的模型调用必须显式解决来源固定、结果复用、超时取消、usage 记账和预算；不能声称返回一个 summary 字符串就自动具备这些行为。已验证：hook 提供的摘要不会产生原生 usage 记账（`UsageDoc.models` 中不会出现该次调用），因此 Adapter 必须在同一次 hook 调用内自行把每次尝试（含失败和重试）累加到应用自己的归属键；取消方面，hook 收到的 `context.abortSignal` 与任务 `signal` 都能真正中断进行中的模型请求。

## 8. LTM：每日事件、提取范围和落盘

### 记录什么

每日 Markdown 保存值得回看的目标、重要决定及理由、已验证结果、问题与有效解决方法、明确用户要求和跨日未完成事项。每段保留稳定 ID、来源范围、日期／时区、关键引用和修订关系。观察事实、未确认推断、失败与结果未知必须区分。

不复制整份 B，也不归档 system prompt、tool schema、所有工具大输出或技术游标。凭据和不必要的敏感正文不进入记忆。已有摘要、检索结果和记忆投影作为派生资料被跳过，避免循环归档。

提取读取新增原始 Entries，必要时用旧 B 提供背景。工具长结果采用有界证据片段和原始引用，并明确未读取范围；不能直接复用底座为摘要截取的 2,000 字符片段宣称精确信息完整。

### 触发时间

- 新的 compaction 正式生效：推进已移出活跃上下文但尚未归档的来源范围。任务完成但 summary 尚在队列、或写入为 stale 时，不当作周期已经切换。
- 业务任务明确完成：归档该完成边界以前尚未覆盖的事件。每次 assistant 回复或工具 loop 完成不自动等于业务任务完成。
- 启动、跨日后的下一次请求：补齐已结束日期的遗漏范围。首版不要求无请求时午夜定时执行。

按来源事件的已知时间和显式配置的时区分组；默认 UTC，不能读取机器本地时区作为隐式规则。未知时间显式标记，不将归档生成时间伪造为发生时间。日期文件与续页命名已由 MEM-01 冻结：目录 `memory/daily`，首页 `YYYY-MM-DD.md`，续页 `YYYY-MM-DD-2.md` … `-9.md`，未知日期为 `unknown.md`；日期按事件时间在配置时区下计算，非法日历日期直接拒绝（见 `src/memory/contracts.ts` 的 `dailyFileName`／`eventDate`）。

### 独立游标和可恢复发布

活跃上下文起点从原生 head 派生；`archivedThrough` 只表示已经完成归档处理的连续来源前缀。即便某段没有值得写入的内容，也在有持久化空结果后推进，避免反复提取。来源范围统一为 `(after, through]`：下界开、上界闭，带 conversation 标识，`after: null` 表示从可见历史开头起；`after === through` 为空。不按文本去重。

例如，LTM 已覆盖至 150，本次压缩移出至 170，则只新增处理 151–170；即使新 B 用到了 121–170，也不重复归档 121–150。任务完成先归档至 200 时，稍后压缩到 170 不回退游标。

归档使用一个原生可恢复 Task，或由其拥有的有界子任务：

1. 固定连续来源范围、格式版本、稳定 batch ID 和分段 ID。
2. 分页读取并提取，校验后持久化待发布的实际正文及内容摘要；模型可能因中断重复调用，但已保存正文不再生成。
3. Daily Memory 单写者按分段 ID 发布，临时文件写完并同步后原子替换日期文件。同 ID 同正文返回原回执；同 ID 不同正文或文件异常修改报冲突。（发布协议已由 MEM-04 实现，见第 15.2、15.3 节。）
4. 所有日期分段发布成功后，才确认批次并推进连续归档游标。失败的日期分段补写，已成功分段不追加第二次。

文件替换和 SQLite commit 不构成同一个事务；必须分别覆盖生成后未发布、发布后未确认、跨多个日期部分成功等恢复窗口。采用有界重试，耗尽后保留可恢复失败事实供诊断和重试。原始 Entries 保留，因此归档失败不会重新执行业务任务，也不必阻止下一次普通聊天。

所有触发合并为有界的持久化目标范围；单 conversation 单归档写者，不为每个事件积累内存 Promise。完成通知之外，启动和请求边界需要从持久化事实核对，补回漏通知。

## 9. 检索、纠正与既有记忆兼容

拟议 `memory_search` 返回日期／主题／关键词的有界命中及稳定引用，`memory_read` 按引用读取有界片段和分页游标。两者由原生工具暴露，结果进入 C，不每轮重新注入全部 LTM。零命中与读失败分开；可按日期浏览，必要时回读来源 Entry。

首版直接分页扫描 Markdown，给出明确的扫描范围、返回上限和继续游标。后续全文索引是可重建派生物，不能成为另一个可编辑事实库。分页扫描、游标与上限已在 MEM-04 实现，语义见第 15.4 节；原生工具包装已由 MEM-07 接入，见第 18.4 节。

存量 `MEMORY.md` 仅作为旧数据保留，不是现行记忆入口，不自动导入日记或转换为结构化偏好。纠正或撤销通过现行状态与记忆协议处理；未来快照与检索不能把已撤销的旧值当作当前约定。

本轮“忘记”默认表示停止作为有效记忆使用，并在需要时保留最小撤销标记以防旧记录复活；清除所有原始历史、备份或提供商缓存属于另行定义的数据删除操作。此差别要通过实际工具结果说明，不宣称删除了所有历史副本。

## 10. 压缩策略、预算和缓存

每个 generation 准备请求时检查输入 token；缓存 token 仍占上下文窗口。底座自动阈值为 `C - R - B`（后台）与 `C - R`（阻塞），`keepRecentTokens` 控制近似保留原文。Context Module 直接复用底座的 `estimateContextTokens`，缓存 token 因此天然计入输入；阈值也从同一个窗口派生，不在第二处配置（见第 14.4 节）。

初始实验值：后台目标 48 Ki token，近期原文约 16 Ki token，B 合计目标不超过 6 Ki token，其中叙事摘要目标不超过 3 Ki；A 约 8 Ki 内。单次记忆检索返回约 4 Ki，一次用户请求新增检索约 8 Ki。这里 Ki = 1024，均为待测量的预算；最终参数由配置 schema 定义，不在多个模块复制常量。

适配时按真实模型窗口计算提前量并校验可用范围，保留回答预算；较小窗口须调整目标。48 Ki 是后台触发目标，不是硬上限。内置摘要没有独立的 3 Ki 硬限制，自定义摘要 Adapter 才能按约定限制其输出并拒绝不完整结果。

每完成约 20 个独立用户请求可额外评估压缩；只有存在足够可压缩内容时才执行，短问答无需凑轮次压缩。工具调用和 generation 重试不算新的用户轮次，已完成请求恢复不重复计数。token 触发优先，长 run 不等待轮数阈值。

结构化状态超预算时先清理已完成事项、选择相关范围；不能静默漏掉当前任务约束。单次不可再切分的大输入或工具关联须明确失败／给文件引用，不能通过反复压缩同一内容解决。更严格的工作窗口门禁须单独验证底座调度支持，再作为后续任务。

A、B、C 是逻辑分块，不假定所有提供商的线缆消息顺序相同。A+B 和已存在的 C 前缀均可能缓存命中；B 改变后通常仅更早前缀可复用。MCP 延迟加载会改变工具集合，记录为前缀变化；不为稳定缓存阻止必要工具，也不在未完成调用期间删实现。TTL、缓存粒度和收费须在目标提供商实测。

## 11. 失败、升级与可观测性

- 必需 system prompt 或必要状态不可读：明确失败，不能默认为空后继续。正常缺省状态与损坏分别处理。
- working 业务冲突：工具返回可修正结果；基础存储失败按 Session 契约处理。
- 必需记忆加载／预算失败：有独立请求错误语义，不能全部误标为底座 Session 永久损坏。
- 压缩失败：保留旧 B/C，遵循底座后台或阻塞失败语义；不切换周期。
- 归档失败：保存待重试批次，记录归档滞后；执行和投递不重跑。
- 检索失败：明确错误；无命中返回空结果和范围，不混淆两者。

B 格式、working schema、归档批次和已持久化工具参数均是跨版本契约。接入新版本时仍能读取原生旧摘要、继续未完成请求；不在已有 requestId 下改写输入。首次升级冻结当前来源尾部作为归档起点，旧的可见快照按需转成新 B；历史全量回填另行显式触发，避免部署即扫描全部历史。

观测只记录标识、版本、数量、时长和安全错误码：A/B/C 输入量、工具声明量、缓存读写、摘要大小、head/cutoff、working revision、归档覆盖与滞后、检索范围和分页、失败与重试。模型 usage 继续使用原生计量路径；自定义提取调用的归属和记账已由 MEM-01 定案：hook 内发起的调用不产生原生记账，Adapter 必须在同一 hook 调用内把每次尝试（含失败）写入应用归属键，原生生成的调用继续按原生键记账，两者不重叠（见第 12.5 节）。日志不输出记忆正文和凭据。

业务错误与应用错误的映射在 MEM-01 冻结为一张表（`MEMORY_ERROR_MAPPING`）：`invalid-input`、`revision-conflict`、`missing-evidence`、`not-covered`、`budget-exceeded`、`corrupt-state`、`unsupported-version`、`stale` 为不可重试；`cancelled`、`io-failure`、`model-failure` 可重试。这些错误都不表示 durable Session 损坏，因此不得映射为 `AGENT_SESSION_FAILED`；真正的存储失败仍走底座 Session 失败路径。

## 12. MEM-01 验证结论与冻结契约

本节是已实测的底座行为与冻结的应用契约，替代此前“待验证”的表述。所有结论都来自 `test/memory-contract.test.ts` 在真实 `Harness` + Node 内置 SQLite + faux provider 上的执行，未使用生产数据或外部凭据；测试使用临时目录。

### 12.1 冻结位置

| 内容 | 权威来源 |
| --- | --- |
| 应用 schema、文档定义、范围与日历规则、错误分类与映射 | `src/memory/contracts.ts`（schema 版本 1） |
| 底座时序验收 01-A～01-F 与接入顺序 | `test/memory-contract.test.ts` |
| 架构、归属和模块 Interface | 本文第 3～11 节 |

`contracts.ts` 导出的类型全部由 TypeBox schema 推导，运行时用同一 schema 校验（`assertSchema`）；SDK 的 `Message`、`EntryRecord`、`EntryId`、`ConversationId`、`UsageDoc` 直接引用，不复制等价定义。模块 Interface 的输入、输出、错误、副作用与顺序写在文件头的模块注释里，一处可查。

已冻结的具体约定：

- 范围统一为 `(after, through]`（`isEmptyRange`、`rangeCovers`）。
- 业务 `revision` 从 1 起，仅在业务变化时递增；`defineDoc.version` 管结构迁移，两者不混用。
- 快照编码：叙事在前，随后是 `<cycle-snapshot>` 包裹的规范 JSON；键排序固定，不含渲染时间。
- 日期文件：`memory/daily/YYYY-MM-DD.md` 与 `-2`…`-9` 续页，未知时间为 `unknown.md`。
- 错误：11 个业务码与 `MEMORY_ERROR_MAPPING` 的不可重试／可重试划分；均不映射为 `AGENT_SESSION_FAILED`。

### 12.2 已验证的原生行为（01-A、01-B、01-D、01-F）

- **01-A**：首次请求、工具后续请求和压缩后请求都携带 `instructions` section 与工具声明；摘要请求使用独立的纯文本系统提示，没有 section。压缩后主请求继续带 A。
- **01-B**：同一 `Harness.commit()` 内写 Document 并追加锚点 Entry，之后 `snapshotAsOf(WorkingDoc, conversationId, anchor)` 精确返回当时的 revision；后续更新不影响旧边界读取。head marker 的 ID 晚于保留原文时，按锚点（而非 marker ID）读取边界状态即可。锚点早于首条可见 Entry 或 fork 未覆盖锚点时，`snapshotAsOf` 抛出 “not visible”，`workingAtBoundary` 统一映射为 `not-covered`——显式拒绝，不返回默认值或最新值。
- **01-D**：无 `model`／`head`／`edits` 的展示写入在运行中立即 append，且贡献 0 条模型消息；带 `model` 的写入在 busy 时进入 `pi.inbox` 排队，在下一个边界落地。全部走公开 admission，未深导入内部路径。
- **01-F**：schema 拒绝额外字段、`undefined` 与越界值；日期必须是真实日历日期；快照解码对“无应用块”返回 `undefined`（旧摘要），对未知版本与损坏内容显式抛错。

家族文档（`WorkingReceiptDoc`）的实测约束：`defineDocFamily` 必须提供 `initial(seed)`，且 `tx.doc(token, conversationId, key, seed)` 必须传 seed；同一 key 的再次读取返回已存值，因此操作回执按 `operationId` 天然幂等，重放不触碰 Document。

### 12.3 发布、stale 与补扫（01-C）

三种事实必须分开观察：

| 事实 | 可观察证据 | 是否切换周期 |
| --- | --- | --- |
| 压缩任务终结 | `getTask()` 的 `state.status === "terminal"` | 否 |
| 摘要写入入队 | `submissionByRequest(conversationId, "compaction:<taskId>")` 的 `status === "queued"` | 否 |
| 正式发布（经 submission） | 该 submission `status === "done"` 且 `context().head` 为该 `pi.compaction` | 是 |
| 正式发布（阻塞压缩） | 任务 `outcome.result` 为 `{ entryId }`，且该 Entry 已成为 `context().head` | 是 |
| 被越过 | submission `status === "unanswered"`、`reason === "stale"` | 否 |

阻塞（generation 拥有）的压缩直接 append，终态结果是 `{ result: { entryId } }`（01-A 中已验证 `entryId` 就是新的 `pi.compaction` head），**没有 submission 可查**；conversation 拥有的压缩入队，结果是 `{ result: { submissionId } }`（01-C）。两者都不应被当作“已发布”的同义词，也都不能用同一种观察方式确认：只查 submission 会漏掉阻塞压缩，只查任务终态会漏掉排队失败。

重启补扫：经 submission 的压缩按 `compaction:<taskId>` 重新查询即可找回已发布事实，测试在关闭并重新 `Harness.open` 后仍读到 `done` 与相同的 head。因此归档触发与周期切换都应以「新 Entry 已成为活跃 head」为最终判据，而不是任务终态或内存通知；阻塞压缩没有 submission，只能按 `outcome.result.entryId` 与 head 比对。

### 12.4 接入顺序（首次 B、重置后 B、长 run 压缩）

实测顺序，MEM-06／MEM-07 必须遵循：

1. **首次 B**：在空闲边界用 write submission 写入 B，`status` 立即 `done`，位于随后提交的用户输入之前；第一条模型请求因此是 `A | B | 用户输入`。应用复用同一 requestId 表示同一次投影，不重新计算覆盖已有投影（去重语义由底座 submission 提供，应用侧见 MEM-07 的 07-A）。
2. **重置后 B**：运行中调用 `reset` 后，紧接着写入的 B 为 `queued`；reset 落地后 B 才 append，新周期以 `pi.reset` 为 head，旧 B 不再出现在上下文中。因此接入顺序是先提交 reset、再写新 B；在 reset 之前提交的写入不保证属于新周期。写入是否被越过由原生判定：head 早于当前活跃范围时落为 `unanswered`/`stale`（见 12.3），应用据此决定是否重写 B。
3. **长 run 压缩**：阈值策略触发压缩后，新 head 为 `pi.compaction`，`head` 等于 `firstKept`，保留的 C 从 `firstKept` 起；压缩后的实际请求携带新摘要，原始 Entries 未被删除。

在 busy 状态直接向 conversation 追加模型消息不可行，也不应尝试：展示型写入可以立即落地，影响上下文的写入必须排队或等待边界。

### 12.5 自定义摘要的 usage 归属与取消（01-E）

- hook 内用 `models.completeSimple()` 发起的调用**不产生**原生 usage 记账：`UsageDoc.models` 中不会出现该次调用的键。Adapter 必须在同一次 hook 调用内，把每次尝试（成功与失败）累加到应用自己的归属键（例如 `app/summary`），否则用量缺失；底座自身的生成与原生摘要继续按原生键记账，两者不重叠，因此不会重复计量。
- 重试由 Adapter 自己负责；失败尝试同样消耗 token，必须计入。
- 取消：hook 的 `context.abortSignal` 与任务 `signal` 都能中断进行中的 `completeSimple` 调用，返回 `stopReason: "aborted"`；任务随后提交 `aborted` 终态。Adapter 不应吞掉取消后继续返回摘要。
- memo 可用于同一次任务内“只算一次”的中间结果，但首次写入获胜，且任务终结后不可读；不能当作跨任务回执。

### 12.6 仍未验证或受限的部分

- 自定义 `defineTask` 的 `abort` 阶段是必需的；MEM-01 只验证内置 `CompactionTask`，MEM-05 已补充归档 Task 的实际 I/O 取消与恢复验证（第 16 节）。
- hook 运行时对象虽然是完整 `TaskRuntime`，但声明类型 `HookApi` 只承诺读取与 memo。应用只用 `Harness.commit()` 持久化，不依赖未声明的 `commit()`，以免升级时静默失效。
- 真实模型窗口下的预算、缓存命中与摘要质量不在本轮范围（MEM-06、MEM-08）。
- 每日文件替换由 MEM-04 的失败注入覆盖（04-B）；MEM-05 已补充生成后未发布、发布后未确认、跨多个日期部分成功及游标提交前的归档 Task 恢复验证（第 16 节）。

## 13. MEM-02 实现结论与 Working 语义

本节记录 Working Module 的实测行为，是第 5 节更新协议的具体落实。证据为 `test/memory-working.test.ts`（02-A～02-G）在真实 `Harness` + SQLite + faux 上执行；02-B 使用 `test/fixtures/crash-working.ts` 在真实进程中被 `SIGKILL`。

### 13.1 冻结位置

| 内容 | 权威来源 |
| --- | --- |
| Working Interface（读当前／读边界／读回执／读完成事实／应用更新）、错误与副作用 | `src/memory/working.ts` 文件头 |
| 原生工具 `working_read`／`working_update` 的参数、模型可见结果与错误映射 | `src/memory/working-tools.ts` |
| 模型可见变更 schema（`*DraftSchema`）、完成事实 entry、锚点与回执字段 | `src/memory/contracts.ts` |
| 验收 02-A～02-G | `test/memory-working.test.ts` |

### 13.2 身份与幂等

- 模型参数只有 `expectedRevision`、`evidence`、`changes`；`conversationId`、`operationId`、时钟由宿主提供。证据在 `WorkingUpdateArgsSchema` 里是纯 `EntryId`，宿主在调用会话内解析为 `SourceRef`，因此模型无法把事实指向其他会话。
- `operationId = "tool:<taskId>"`：一次原生工具调用就是一个持久化工具任务，任务 ID 在重试与重启间不变，同时落在 identifier 字符集内。
- 回执按 `operationId` 存为家族文档成员；`Tx` 没有 `snapshot()`，首跑用哨兵 seed（`at: -1`）经 `tx.doc` 读取，命中已存值即重放。
- **事务内的值不能带出 commit**：`tx.doc` 返回的是受追踪 draft，commit 结束后即失效（读它会抛 “settled overlay”）。因此回执在返回前 `detach()`（JSON 复制）。同理，draft 不是普通对象，`structuredClone` 会抛 `DataCloneError`。

### 13.3 一次 commit 写什么

`applyWorkingUpdate` 的全部拒绝都发生在写入之前；接受时同一 commit 内写：状态 Document（仅在有业务变化时）、锚点 Entry、任务完成 Entry（仅当本次把 `active` 清为 `none`）、回执文档。`previousRevision` 在改写 Document 之前读取——Document draft 就是被写的那个对象。

- 无业务变化：返回 `changed: false`，不写 Document、不递增 revision，但仍写锚点与回执（该调用确实发生过）。
- 清理任务：写 `WorkingCompleted` entry（goal、scope、sources、operationId），回执与锚点的 `completedEntryId` 指向它；归档可按该 entry 重取完成事实，无需读实时状态。有效偏好不受影响。
- 上限：偏好数量、约束数量等由 schema 与模块共同拒绝；超过上限是显式 `invalid-input`，绝不截断已有内容。已过期偏好不落库。

### 13.4 崩溃窗口（02-B）

工具包装为 `replay: "safe"`。在“Document 已提交、工具结果未提交”处 kill 进程后重启：

- 工具任务被重跑一次（测试确认重跑真的发生），`operationId` 不变，命中回执后原样返回；
- revision 不再次递增，锚点 Entry 只有一个，工具结果报告的是原 revision；
- 只有该测试通过后，`working_update` 才声明 `replay: "safe"`。

### 13.5 错误与模型可见输出

- 业务错误（`invalid-input`、`revision-conflict`、`missing-evidence`、`corrupt-state`）返回 `isError: true` 的结果，模型可据后续有效调用修正；**非 `MemoryError`（存储或 Session 失败）直接抛出**，不伪装成参数问题。
- 参数级拒绝（未知字段、空 changes、超界）由底座 schema 校验在 `execute` 之前拦下，同样是可修正的错误结果。
- 工具结果只含 revision、任务、偏好与画像的文本视图和有界 `structuredOutput`，不含 `conversationId`、锚点或来源 ID；这些只出现在应用内部契约里。画像文本列出 id、正文、类别和每日分段引用。

## 14. MEM-03 实现结论与 Context 规划语义

本节把第 6、7、10 节写成可执行的 Interface。证据为 `test/memory-context.test.ts`（03-A～03-F），该文件不启动 Harness、不打开数据库、不调用模型。

### 14.1 冻结位置

| 内容 | 权威来源 |
| --- | --- |
| Context Interface（`planRequest`／`boundaryWrite`／`revisionWrite`／`reuseWrite`／`buildSnapshot`／`renderSnapshot`／`snapshotFromHead`／`snapshotOfProjection`／`measureRequest`／`blockUsage`／`validateWorking`）、`PlanInput`、错误与纯函数约束 | `src/memory/context.ts` 文件头 |
| `ContextPlan`、`CycleSnapshot`（含 `WorkingBaseline`、`CycleBoundary`、`SnapshotFacts`）、`MemoryBudget`、`MEMORY_LIMITS`、`renderBaseline`、修订块标记 | `src/memory/contracts.ts` |
| 验收 03-A～03-F | `test/memory-context.test.ts` |

### 14.2 输入、输出与优先级

输入全是调用方已读出的值：预算、已渲染的 A 文本、已提交的 B（或没有）、当前 working、C 是否已含当前 revision、请求的实测大小、窗口与保留量、自周期开始以来的独立用户轮数、可压缩内容量、B 的输入摘要。模块不读文档、不持客户端、不做 I/O；需要副作用时由 Durable Adapter 执行。

判定顺序固定，同一输入字节一致：

1. A 为空或只有空白 → `invalid-input`；A 超过 `MEMORY_LIMITS.instructions` → `budget-exceeded`。两者都拒绝执行，不截断、不用空 prompt 继续。
2. working 或已提交的 B 不符合 schema → `corrupt-state`。正常缺省状态与损坏状态分开：没有 B 是正常的，B 不合 schema 是错误。这一步必须先于分项预算测量，因为后者要渲染 B 才能计量。
3. 任一分项超出自己的额度（A 对 `instructionsTokens`，B 对 `snapshotTokens`）→ `budget-exceeded`，`detail.block` 指明是哪一块。分项额度是各自的上限，不是总额的切分，因此一块不能借用另一块的余量。
4. 超过阻塞阈值（`contextWindow - reserveTokens`）且 `compactableTokens <= 0` → `budget-exceeded`；有可压缩内容 → `compact`／`budget`。
5. 没有 B → `project` 一个 `boundary` 写入（首次建立周期）。
6. B 存在但 `facts` 与当前不符（A 或记忆版本变了）→ 有可压缩内容时 `compact`／`facts`，否则 `budget-exceeded`。周期内不重写前缀，变更只能由下一次压缩采纳。
7. B 存在、facts 一致，但 C 未含当前 revision，且 `working.revision !== snapshot.baseline.revision` → `project` 一个 `revision` 写入。
8. 用户轮数达到 `evaluateAfterUserTurns` **且** `compactableTokens > 0` → `compact`／`rounds`。
9. 其余 → `none`。

第 5、7 步的写入在返回前还要过第 3 步的同一份额：`planRequest` 测量即将写入的模型可见内容对 `snapshotTokens` 的占用，超出时返回 `budget-exceeded` 而不是 `project`（见 14.4）。

数据条件一律作为 `action.kind === "error"` 的计划返回，调用方记录一个决定而不必 catch。`planRequest` 内部的渲染与计量若抛出 `MemoryError`（例如 B 合法但渲染文本超过上限），同样转换成错误计划；`renderSnapshot` 等直接调用的函数保留抛错语义。

### 14.3 B 与 C 的边界

两种写入都必须模型可见。投影的目的是让模型读到状态；如果写成 `model: []` 的展示条目，首次 B 和周期内修订都不会进入请求，等于承诺了文档却不兑现。

- **boundary 写入（建立 B）**：`boundaryWrite` 返回 `kind: "personal.cycle"` 的条目，携带一个 user 消息，内容是原生摘要的包装形状（`...compacted into the following summary:\n\n<summary>\n…\n</summary>`）。条目 `data` 里另存 `snapshot`（`snapshotOfProjection` 取回）、`baseline`、`facts` 与 `digest`。用原生摘要的形状而不是新形状，是因为模型已按这种方式读 B；条目 kind 仍是应用自己的，因此应用侧仍可区分投影与真正的压缩。首个周期的 `boundary.anchor` 为 `null`（投影先于它会指名的锚点），`sources` 为 `null`（没有替换任何范围），叙事是固定的“会话起点”说明而非模型写的摘要。
- **revision 写入（补入 C）**：`revisionWrite` 返回 `kind: "personal.context.projection"` 的条目，携带一个 user 消息，内容是 `<working-revision>` 包裹的精确 baseline（`renderBaseline` 的规范 JSON）。模型即使从不调用 `working_read` 也能读到当前值，这正是 03-B／03-C 要证明的行为。它不含叙事，也不含快照体，因此不会被误认作 B。
- 两种写入都带稳定 `digest`（`sha256(canonicalJson({baseline, facts}))` 前 16 位），`reuseWrite` 对同一 digest 的已提交写入原样复用：写入可能已落库但输入尚未提交，重算会用新内容覆盖旧写入。
- 周期内绝不重渲染 B。`snapshotTextFor` 在快照已是活跃周期时返回 `undefined`，从调用侧就排除了重复投影 B 的可能。
- 新 B 只由压缩产生，且必须用切分边界处的状态：`buildSnapshot` 接受的是调用方按锚点读出的 `baseline`，不是最新状态。
- 渲染确定性：叙事在前，随后是键排序的规范 JSON；不含时钟、不含 `updatedAt`。`WorkingBaseline` 就是去掉状态 `updatedAt` 和画像条目 `updatedAt` 的 `WorkingState`——写入时间属于状态自身历史，渲染出的快照不带每次写入的时间。基线含 `profile`（id、正文、类别、每日分段证据）。渲染后的整体文本受 `MEMORY_LIMITS.snapshotText` 约束，并且仍受 `snapshotTokens` 约束：叙事与基线共用这一个上限，超限抛 `budget-exceeded`，不截断（截断的基线等于断言错误的状态）。`renderSnapshot` 对直接调用者保持抛错语义；规划层捕获并转换成错误计划，数据条件不会以异常形式穿出 `planRequest`。

### 14.4 预算

`measureRequest` 直接使用底座的 `estimateContextTokens`：取最新可用 assistant usage（`input + output + cacheRead + cacheWrite`，或 `totalTokens`），再加上其后消息的估算。缓存 token 占据上下文窗口，因此计入输入；这不是自建的估算口径。阈值由同一个窗口派生：阻塞 `contextWindow - reserveTokens`，后台再减去 `backgroundTargetTokens`，不在多处配置常量。

分项预算另由 `blockUsage` 判定：A 对 `budget.instructionsTokens`，B 对 `budget.snapshotTokens`，各自是独立上限，超出即拒绝并指明是哪一块。这是各块的容量上限，与下面第 10 节的实验目标值同源；`narrativeTokens`、`searchResultTokens`、`requestSearchTokens` 属于尚未落地的部分（叙事由 MEM-06 的摘要调用约束，检索由 MEM-05／MEM-07 约束），当前模块不消费它们，因此也不假装已经判定。

即将生成的写入同样要过这一关：只检查输入里已有的 B 不够，投影本身是新增内容，比所属块还大就等于用预算去装预算要限制的东西。`planRequest` 在返回 `project` 前测量该写入的模型可见消息（`estimateContextTokens(draft.model)`，固定信封文本一并计入）对 `budget.snapshotTokens` 的占用；首次 B 与修订写入都记在快照份额上，因为修订携带的就是 B 所载的那份状态，只是晚一步送达。超出时返回 `budget-exceeded` 错误计划，`detail` 指明 `block: "snapshot"`、写入种类与实际 token 数。

轮数只是评估条件，不是压缩命令：没有足够可压缩内容时计划保持 `none`，短对话不会每轮都要求压缩。

### 14.5 与 MEM-02／MEM-06 的接缝

写入侧：`boundaryWrite` 建立首个周期（`boundary.anchor` 为 `null`，投影先于它会指名的锚点），`revisionWrite` 补入周期内的状态更新。两者都通过 `root.submit({type: "write", entry})` 发布，顺序按第 12.4 节。压缩侧由 MEM-06 在 `beforeCompact` 中用 `readWorkingAt` 读出的边界状态调用 `buildSnapshot`／`renderSnapshot`。

**周期切换有两条确认路径，不能只看 submission**：

- **经 submission 发布**（conversation 拥有的后台压缩）：任务终结时以 `requestId = "compaction:<taskId>"` 入队，结果是 `{ submissionId }`。只有该 submission 落到 `done` 且 head 变为它对应的 `pi.compaction` 时才切换周期；被 reset 越过而落为 `unanswered`／`stale` 的写入不切换。
- **直接发布**（generation 拥有的阻塞压缩）：任务终结时直接 `appendEntry`，结果只有 `{ entryId }`，**没有 submission 可查**。此时以任务 `outcome.status === "completed"` 且 `outcome.result.entryId` 对应的 Entry 已成为 head 作为切换条件；只等 submission 会永远等不到，长 run 的周期切换和归档触发都会漏掉。01-A 已实测该路径的返回形状为 `{ entryId }`。

两条路径都以「新 Entry 真的成为活跃 head」为最终判据；任务终态本身不足以证明已发布，内存通知更不足。

## 15. MEM-04 实现结论与每日记忆语义

本节把第 8、9 节写成可执行的 Interface。证据为 `test/memory-daily.test.ts`（04-A～04-F），该文件在真实临时目录上运行，不启动 Harness、不打开数据库、不调用模型。

### 15.1 冻结位置

| 内容 | 权威来源 |
| --- | --- |
| Daily Interface（`openDaily`／`publishSegments`／`readSegment`／`searchDaily`／`digestOfSegment`／`identityOfSegment`）、`DAILY_LIMITS`、`SearchCursor`、`CoveredFile`、文件协议与错误语义 | `src/memory/daily.ts` 文件头 |
| `MemorySegment`、`ArchiveBatch`、`dailyFileName`、`DAILY_DIRECTORY`、`DAILY_MAX_PAGES`、`UNKNOWN_DATE`、`MemoryError` | `src/memory/contracts.ts` |
| 验收 04-A～04-F | `test/memory-daily.test.ts` |

模块只接受已校验的 `MemorySegment` 与宿主给的绝对根目录，读写 `root/memory/daily` 下的文件，不持有模型、Harness 或数据库客户端。分页上限、游标与回执属于 Interface，不写入被持久化的数据。

### 15.2 文件协议

每个事件日期一个 Markdown 文件，命名为 `dailyFileName(date, page)`。文件头一行标题，随后每段一个块：

```text
<!-- memory-segment:begin
{"digest":"…","segment":{…}}
-->
<分段正文，原样>
<!-- memory-segment:end -->
```

- 元数据行是键排序的规范 JSON，且**不含 `text`**：正文只有一个存放位置。元数据若重复携带正文，读者无法判断两处不一致时哪个是事实，因此按 `corrupt-state` 拒绝，而不是择一采信。
- `digest` 覆盖分段自身的规范 JSON（含正文）。正文被编辑后与元数据不符即为 `corrupt-state`，不会被当成一个新值静默读出。
- 文件通过「同目录临时文件写入 → `sync` → `rename` 覆盖」替换，读者看到完整旧版或完整新版。目录 `sync` 在 Windows 上被拒绝（`EPERM` 等），只容忍这些明确的拒绝码，其余 I/O 失败照常报 `io-failure`。
- **读取是严格的**：日期文件只能包含本模块写出的内容——一行标题、空行、格式完整的块。块外的任何内容、标题与文件名不符、空文件都报 `corrupt-state`，绝不跳过。跳过会让损坏标记后的记录对检索不可见，而下一次发布会把该文件整体重写，等于静默删除记忆。
- 换行在边界统一为 LF：发布时先把正文规范化再计算摘要，读取时同样规范化。因此 `\r\n` 正文存成 LF，回执摘要可复现；否则写入的摘要与读回的正文永远对不上。
- `root` 与文件之间的每一层目录（包括 `root/memory`）都 `lstat` 检查，符号链接一律拒绝（`corrupt-state`）；`filePath` 拒绝任何解析后离开根目录的名字。只检查最后一层会让 `root/memory` 指向外部目录时仍然写入成功。
- 读取在**读的过程中**受限：用文件句柄最多读到上限多一个字节即停，超限报 `budget-exceeded`。先整份读入再检查大小只会限制答案，不会限制内存。
- 分段正文不得包含块标记行，否则会伪造块边界（`invalid-input`）。

### 15.3 幂等、冲突与替代

发布以 `(文件, 分段 ID)` 为键：

- 同 ID 同**发布身份** → `duplicate` 回执，不追加，文件字节不变。重试与重启后的重复调用因此不会写第二份。
- 同 ID 不同发布身份，或同一次调用内两个分段共用 ID 而内容不同 → `revision-conflict`，整次调用不写任何文件。
- 发布身份（`identityOfSegment`）是 `supersededBy: null` 时的分段摘要，与文件里存的 `digest` 分开：`supersededBy` 会被后续替代改写，若把它算进发布身份，一条已被替代的记录就无法幂等重放原始发布，恢复会变成冲突。存储摘要仍包含它，因为文件必须能发现编辑。
- 先校验全部输入与被触及文件的边界，再落盘：任何拒绝都发生在第一个字节写入之前。

替代关系写在旧记录上（`supersededBy`），不靠删除。目标记录由 `supersedes` 指名，在 `scanFilesMax` 范围内查找；找不到报 `not-covered`，已被另一条记录替代则报 `revision-conflict`，不会形成链或悬空引用。同一次调用里两条记录替代同一个旧记录同样报 `revision-conflict`：否则两条都会作为当前事实返回，而旧记录只指向其中一条。

写入分两阶段：**先把所有文件的替代标记写完，再写任何含新记录的文件**。跨文件时只保证「先撤销、后新增」；同一文件同时含标记与新记录时会被写两次，正是为了保住这个顺序。失败时有三种结果，第三种是本模块**不做端到端事务**的直接代价：旧事实仍在且新事实未出现（标记阶段未写）；旧事实已撤销且新事实已出现（两阶段都完成）；或**旧事实已撤销、新事实尚未落盘**（标记已写、追加阶段失败）。第三种不会让两条事实同时读作当前，但会让用户暂时失去该事实——重试同一批次即可补齐，因为分段 ID 与发布身份在重试间稳定。因此回执确认之前，调用方不能把「已撤销」当作「已被新事实替代」。这条顺序由 04-E 的注入失败用例固定：替换文件不可写时，被撤销的那条已标记，未撤销的那条保持当前，且没有任何新记录落盘。

进程内每个根一个单写者链（`withLock`）。部署是单应用进程，因此这就是全部串行化保证；同一根上的第二个进程不受支持，需要锁文件才能成立——这是当前明确不支持的能力，不是未发现的缺陷。

### 15.4 检索、游标与边界

`searchDaily` 按日期顺序扫描范围内的文件，返回命中、扫描量、未读范围与继续游标：

- `available` 是范围内的文件数，`scanned.files`／`scanned.segments` 是本次实际读到的量，`unread` 列出因上限未读的文件。**零命中与没有历史是两件事**：前者 `available > 0`，后者 `available === 0`。
- `scanned.from`／`through` 是本次真正读到的文件名而非日期，一个都没读到时为 `null`。文件一读完就记入范围，命中或分段上限提前结束时也是；不能等到整个文件循环走完才赋值。
- 上限：单文件 500 段／1 MiB，单次扫描 20 个文件（可放宽至 200）／5,000 段，单次返回 20 条（可放宽至 100）。超限给游标与未读清单，不截断、不静默丢。
- 默认只返回当前事实（`supersededBy === null`）；`includeHistory` 才包含旧记录，并以 `historyExcluded` 报出被跳过的条数。历史视图里旧记录仍带着 `supersededBy`，因此旧状态可见而不会被误读为当前约定。
- 游标由 `file`、`index`、`fileDigest`、`covered` 组成。`fileDigest` 钉住被恢复文件的内容；`covered` 记录**已被完整扫描的文件在读取前一刻观察到的 size 与 mtime**。续页时重新观察这些文件并逐个比对，不符即 `stale`。
  - 关键在「读取前一刻」：如果在构造游标时才去测量，那么读取之后、构造之前的追加会被吸收进游标自己的指纹里，续页时自然一致，追加就永久漏掉。游标必须携带扫描实际消费的那个版本，而不是它签发那一刻的状态。
  - 只列出真正读过的文件；没读到的文件不存在被跳过的风险。
- 范围可能在两页之间**变大**：补写一个更早的日期会排在游标文件之前，它从未被读过，因此不在 `covered` 里，也没有任何 `stale` 比对能发现它。续页因此不是从游标文件开始，而是从「游标之前第一个 `covered` 没有记录的文件」开始；`covered` 里的文件已在上一步逐个校验未变，扫描时直接跳过，所以既不会漏掉补写，也不会重复返回调用方已有的命中。同理，游标推进时跳过 `covered` 中的文件，不把已返回的文件再指向一次。
  - 这条规则只对**排在前面的**新增文件成立。游标之后新出现的文件本来就落在剩余范围内，正常扫描会读到。
  - 回退只允许用于 `index === 0 && fileDigest === null` 的文件边界游标。若游标已经保留文件内位置（`index > 0`）或内容摘要（`fileDigest !== null`，包括 index 为零的情况），发现更早补写时立即报 `stale`，调用方丢弃该分页链并重新检索。单位置游标无法同时保留补写页的位置和原文件的位置／摘要；提前拒绝避免再次分页时重复返回旧记录或丢失变化检测。未出现更早补写时，原有位置与摘要校验照常生效。
- 命中数到上限时，游标停在放不下的那一条之前，续页会先返回它。
- 列出的文件在读取前消失时记为 `unread`（不是「读过且为空」），且**不进入 `covered`**：它已经不存在，记进去只会让下一次续页永远 `stale`。游标前进到下一个文件。已记录在 `covered` 的文件之后被删除同样不报 `stale`——里面已无记录可漏，续页照常进行；只有文件**变大了**（或内容被改）才意味着有记录落在游标后面。

`readSegment` 按稳定引用读取，文件不存在与文件内无此记录分别报 `missing-file`／`missing-segment`，是返回值而不是异常。已替代的记录仍能按引用读出原值并带 `supersededBy`：稳定引用不会悄悄变成新值。

### 15.5 错误与边界

| 情况 | 结果 |
| --- | --- |
| 相对根目录、非法日期／页码、正文含块标记 | `invalid-input` |
| 同 ID 不同内容、重复替代、链式替代 | `revision-conflict` |
| 替代目标不在已覆盖文件内 | `not-covered` |
| 段数或字节数超文件上限、单次发布超段数上限、读到超大文件 | `budget-exceeded`（换续页或分页，不截断） |
| 块外内容、标题不符、元数据缺失／非法、摘要不符、位置与文件名不符、任一层目录或文件为符号链接 | `corrupt-state` |
| 游标失效 | `stale` |
| 其余读写失败 | `io-failure`（可重试） |

全部错误码都在 MEM-01 的 `MEMORY_ERROR_MAPPING` 内，均不映射为 `AGENT_SESSION_FAILED`。日志只记标识、文件名与错误码，不输出正文。

### 15.6 与 MEM-05／MEM-07 的接缝

- MEM-05 的 Archive Task 负责固定来源范围、提取、持久化待发布正文，然后逐段调用 `publishSegments`；只有全部回执确认后才推进连续游标。回执里 `published` 与 `duplicate` 都算已确认，`digest` 可用于核对「同一次生成没有产出第二份正文」。
- 分段 ID 由归档批次决定（`<batchId>#<index>`），在重试间保持稳定；本模块只按 ID 与发布身份判重，不生成 ID。归档重试可以安全重放：已被替代的记录仍返回原回执。
- 检索工具（`memory_search`／`memory_read`）由 MEM-07 用原生工具契约包装本模块；游标、上限和 `unread` 原样交给模型，不在这里改写语义。
- 本模块未接入运行中的 agent；已由 MEM-05 与归档任务联调，覆盖生成后未发布、发布后未确认及跨日部分成功（第 16 节）。
- 两个窗口只有代码路径、没有自动化证据，因此不作为已验证结论：单次扫描内「文件在读取前消失」与「文件在读取后、游标签发前被追加」。两者都要求在一次调用内部、两个 I/O 步骤之间改变文件，而本模块没有在该窗口注入失败的接口。跨调用的追加已被 `covered` 覆盖并有测试；跨调用的**补写更早日期**由 `resumeAt` 回退扫描起点覆盖，同样有测试。

## 16. MEM-05 实现结论与归档协议

### 16.1 Interface 与归属

`src/memory/archive.ts` 提供原生 Entry 到有界提取来源的转换、`ArchiveExtractionSchema`、`validateExtraction` 与提取提示；`src/memory/archive-task.ts` 提供 `createArchiveTask`、`initializeArchive`、`requestArchive`、`reconcileArchive`、`retryArchive`、`readArchive` 和 `ArchiveStateSchema`。`ArchiveBatch`／`MemorySegment` 继续以 `contracts.ts` 为权威来源，schema 版本仍为 1。

宿主在 registry 中注册 `createArchiveTask({store, model, timeoutMs?})` 返回的 Task。它是 conversation-owned、`background: true` 的独立任务，不进入主 agent 工具队列、不加入普通 idle 等待。`boundary` 是可选的宿主观测接口，提供 extracted／saved／published／confirmed／before-cursor 同步点，测试借此关闭或强制终止进程。生产接线由 MEM-07 完成。

`initializeArchive` 必须先调用：首次升级由宿主传入当前尾部作为起点；新会话可传 `null`。起点、时区、目标和批次通过 conversation 级 latest Document 保存；不自动回填旧历史。当前拒绝 fork。初始化后不能改变时区。模型与目录由宿主配置，不是模型参数。

### 16.2 目标、来源与时间

`requestArchive` 只接受宿主已确认发布的压缩截止点或业务完成边界；入队／stale 压缩不能调用它。事务内取目标最大值，同时创建唯一活跃归档 Task，不为每次通知建立 Promise 队列。`reconcileArchive` 每次最多扫 64 条原生 Entries，返回 `more`；宿主在启动／请求边界重复调用至本次扫描结束。扫描进度持久化，跨日时会重新检查未覆盖的当日事件。补扫依据最近已发布的原生 head（覆盖阻塞压缩路径）、WorkingCompleted 和已结束日期的原始事件；不要求午夜无请求时运行。

来源范围仍为 `(after, through]`，每批最多 64 条、提取输入最多 64 KiB。当前处理原生 user、成功或工具调用中的 assistant、tool-result 和 WorkingCompleted；摘要、reset、system、working／cycle 投影及 memory_search／memory_read／working_read／working_update 的结果均跳过。未知自定义 kind 不自动解释，MEM-07 引入外部事件格式时须增加对应边界适配。工具失败保留显式失败标记；完整文本超限就拒绝并保留缺口，不冒充已归档。

日期由被引用 Entry 的事件 timestamp 与初始化时区决定；完成事实使用其 `at`。缺失时间进 `unknown.md`，非法时间报错，模型不能指定日期、时区、ID、目录或归档游标。宿主收到的提取结果必须引用本批已读来源。自动 user-requirement 只是历史事件，不更新 Working 偏好或 MEMORY.md。

### 16.3 持久化、发布和失败

Task 先提交固定范围和稳定 batch ID，再调用模型；校验通过的正文与调用 usage 在同一 commit 保存。空结果也先保存。每次只发布一个分段，身份为 `<batchId>#<index>`；逐段保存内容摘要确认，全部确认后在事务内校验连续前缀并推进 `archivedThrough`。已保存正文不会因重试重新生成，文件已写但确认未提交时使用 Daily 的 duplicate 回执恢复。单文件容量不足时持久化下一页位置，最多 9 页；其他失败不自动换位置。

提取和每段发布均最多自动尝试 3 次，计数先于外部 I/O 提交；重试等待通过原生 Task checkpoint／sleep 恢复。失败诊断只保存安全错误码和固定消息。耗尽、非重试错误或显式取消保留正文和覆盖缺口，由 `retryArchive` 显式重置尝试额度；普通触发不会无限重启失败任务。未知 Task fault 同样保留批次并需显式重试。主请求和已保存回复不重跑。

模型调用默认 60 秒，允许宿主配置 1～300000 ms，取消／超时 signal 传至实际 provider。关闭 Harness 保留 checkpoint；显式 abort 进入原生 abort 阶段并保存 cancelled。Daily 的有限单段发布会等待原子替换完成后再处理取消，不使用仅停止等待的 Promise race，也不在取消后启动下一段 I/O。

每个返回并提交的模型响应（含失败／非法结果）的 usage 计入原生 `UsageDoc.models["app/archive"]`，不重复计入 provider 的生成桶。响应尚未提交时进程被杀或调用被取消，远端已发生用量可能未知；恢复可能重调模型，不能承诺该窗口的精确计费。正文一旦提交便不再重调。应用不复制 SDK Usage／Entry／Task 类型。

### 16.4 验证与限制

离线验证使用真实 Harness、临时 SQLite、faux provider 和每日文件。关键四个窗口同时有正常关闭重开和真实子进程 SIGKILL 证据。具体命令、通过编号见 MEM-05 交接记录。当前单进程、线性会话；未在真实模型上验证提取质量、脱敏效果、目标 Linux 资源消耗。模块不承诺自动完成语义级纠正，`supersedes` 必须来自可定位的明确旧引用。实际应用接线、外部事件时间持久化和升级入口属于 MEM-07。

## 17. MEM-06 实现结论与压缩接入语义

本节记录 compaction Adapter 的实测行为，是第 6、7、10 节在压缩侧的具体落实。证据为 `test/memory-compaction.test.ts`（06-A～06-G）在真实 `Harness` + SQLite + faux provider 上执行；摘要模型是独立的 faux provider，因此适配器调用不消耗主 agent 的脚本回复。

### 17.1 冻结位置

| 内容 | 权威来源 |
| --- | --- |
| compaction Adapter Interface（工厂、确认、计数、评估、指纹）、错误与副作用 | `src/memory/compaction.ts` 文件头 |
| 摘要结果／失败事实的持久化格式（`personal.compaction.summary` 家族文档）、轮数回执与计数器（`personal.compaction.turn`／`turn-counter`） | `src/memory/compaction.ts` |
| 验收 06-A～06-G | `test/memory-compaction.test.ts` |

### 17.2 Adapter Interface

`createCompactionExtension(options)` 返回可直接 `registry.install` 的 extension，只注册 `hook(CompactionTask, { beforeCompact })`。options 注入宿主 `commit`（`Pick<Session, "commit">`）、摘要模型 ref、budget（默认 `MEMORY_BUDGET_DEFAULTS`，按 schema 校验）、facts（值或函数）、`maxAttempts`（默认 2，范围 1..5，工厂期校验）与可选 `onResult` 观测回调（只带标识与错误码，不带正文）。持久化只走注入的宿主 commit：`HookApi` 没有 commit（第 12.6 节），声明类型之外的运行时成员一概不用，与 MEM-05 用 options 注入 model/store 的范式一致。

hook 内顺序固定：派生稳定 key → 查已保存结果 → 读边界状态 → 摘要调用（每次尝试后立即记账）→ 组装并渲染 B → 先持久化结果再返回 `{ summary }`。普通失败一律在持久化失败事实后返回 `{ decline: true }`，**绝不抛错**：原生 hook runner 对普通异常是「报告后继续」，抛错会回落到默认摘要，等于发布一份未校验的 B；只有取消是例外（见 17.4）。

稳定 key 由被替换范围（`firstKept`、最后一个被替换 Entry）、边界 anchor、上一周期 `cycleId` 与 `sources.through`、facts、模型与叙事／快照预算派生（sha256）。命中且校验通过（渲染文本能解码回该范围的快照）才复用，不再调用模型；链在已发布周期之后的压缩因上一周期不同而 key 不同，不会复用一份 `sources.after` 会倒退的快照。

### 17.3 边界 anchor 规则

基线只从被替换范围内的最后一个 `personal.working.anchor` 经 `readWorkingAt` 读取。无 anchor 时用 `snapshotAsOf(WorkingDoc, …, 最后一个被替换 Entry)` 探查，且只有一种结局可继续：

| 探查结局 | 处理 |
| --- | --- |
| 返回 `undefined` | 认定边界处尚无 working 写入，用初始状态；`boundary.anchor` 记为该探查 Entry |
| 返回一个值 | 状态存在但范围内无 anchor 能钉住它 → decline 并记录 `not-covered` 失败，不猜边界 revision |
| 抛错 | 边界不被覆盖 → decline 并记录 `not-covered` 失败 |

这条规则的实测后果（06-D 开发探针中观察到）：一次阻塞压缩消耗掉 anchor 后，紧接着的后台压缩若其范围仍无新 anchor，会按规则 decline。这不是故障而是规则本身：周期内 C 中的 working 更新会持续写入新 anchor（原生工具每次调用同 commit 追加），长 run 因此不断获得可钉住的边界；06-C 正是靠请求内工具回路中的 working 更新在同一次请求内完成多次压缩。旧 B 的处理按第 7 节：被替换范围首条若是 `pi.compaction`（或应用的 `personal.cycle` 投影），从其 model 文本提取 `<summary>` 体并 `snapshotFromHead` 解码——解出快照则旧叙事取其 `narrative`、`sources.after` 承接其 `sources.through`；解不出（`undefined`）按旧原生摘要兼容，整段正文作为旧叙事（06-E 实测：原生摘要先行、后装 Adapter 的第二次压缩把原生叙事折入来源，且新快照 `sources.after` 为 `null`）；未知版本／损坏则显式失败 decline，不静默降级为叙事。

摘要来源由 Adapter 自己序列化（不深导入 SDK 私有路径）：旧叙事单列，消息取可见文本、工具调用与工具结果，system 消息省略，head marker 自身的消息不重复；工具结果截断在 2,000 字符并明确标注截断字符数与「完整结果仍在已存 Entry 中」，不宣称完整。

### 17.4 usage 与取消

每次摘要尝试（成功、失败、重试都算）在判定结果之前，就通过宿主 commit 把该次 usage 累加到 `UsageDoc` 的 `app/summary` 键（01-E 的累加写法）；hook 内调用不产生原生记账（06-A 实测 `summary/summary-1` 键缺失、`app/summary` 大于 0），两套键不重叠故不重复计量。只有 provider 的 `error` 值得重试（至 `maxAttempts`）；`length`、空文本、含 toolCall、叙事经 `estimateTextTokens` 超过 `budget.narrativeTokens` 一律视为不完整，立即 decline 不发布。`stopReason: "aborted"` 时用 `ctx.abortSignal.throwIfAborted()` 传播任务取消，不吞掉取消后返回摘要。精确状态组装后 `renderSnapshot` 抛 `budget-exceeded`（渲染文本超 `MEMORY_LIMITS.snapshotText`）时 decline 并记录，绝不截断或把精确状态概括进叙事（06-E 实测：32 条满格偏好加满格任务状态时 decline，存储状态逐项不变）。

### 17.5 两条确认路径

`confirmCompactionCycle(deps, conversationId, taskId, context, { archivedThrough })` 只读持久化事实，`createHarnessConfirmDeps(harness)` 是其 Harness 绑定。判据严格按第 14.5 节：任务未终结 → `pending`；任务 `failed`／`aborted` → `not-published` 并带原因；submission 路径须 submission 为 `done` 且 view head 是该 submission 的 Entry（`queued`／`placed` → `pending`，`unanswered`（含 reset 越过的 `stale`）→ `not-published`）；阻塞路径须 `outcome.result.entryId === view.head.id`，不等为 `head-mismatch`。任务完成但无 entry、无 submission（无可压缩内容）为 `not-published`／`nothing-compacted`。切换时返回解码后的快照（原生摘要 head 为 `snapshot: undefined, native: true`）与 `archiveRange`：`after` 取新快照 `sources.after` 与入参 `archivedThrough` 中更靠后者，绝不回退；范围已空则为 `null`。06-D 实测：后台压缩在 submission `queued` 时 confirm 为 `pending`，`done`＋head 后为 `switched`，关闭重开 Harness 后按同一判据仍得到 `switched` 与相同 entryId。

### 17.6 预算参数取值

原生策略只由唯一 budget 与窗口派生（`nativeCompactionPolicy`／`compactionThresholds`）：`settings.compaction = { enabled: true, reserveTokens: R, keepRecentTokens: budget.recentVerbatimTokens, backgroundTokens: budget.backgroundTargetTokens }`，阻塞阈值 `C - R`、后台阈值 `C - R - backgroundTargetTokens`。用 `MEMORY_BUDGET_DEFAULTS` 与真实窗口 200,000、R = 16,000 时：keepRecent 16 Ki、backgroundTarget 48 Ki、阻塞 184,000、后台 134,848（06-F 实测断言）。传入 `contextWindow` 时校验窗口关系（后台目标须低于阻塞阈值、保留原文须装得下），非法抛 `MemoryError`（`invalid-input`／`budget-exceeded`），不静默钳制。摘要调用的 `maxTokens` 由 `budget.narrativeTokens`（默认 3 Ki）派生并受模型上限约束；`cacheRetention: "none"`。

轮数评估（06-F）：`recordCompletedUserRequest` 以 `requestId` 为回执键与计数器同 commit 推进，同 id 重放不重复计数，第 `evaluateAfterUserTurns`（默认 20）的倍数时 `shouldEvaluate` 为真；`evaluateCompaction` 先 token 后轮数——`inputTokens` 达阻塞／后台阈值即返回 token 决策（一次大工具回合可触发，不等轮数），否则轮数达标且 `compactableTokens > 0` 返回 `rounds`，其余 `none`。实测 20 个短请求只在第 20 个评估、低 token 时决策为 `none`／`rounds` 而从不强压。

前缀指纹（06-G）：`requestPrefixFingerprint` 对 instructions 文本、快照文本、工具名集合（按提供顺序）分别取 sha256 并合成总 digest，`comparePrefix` 报告变化的逻辑块；工具集合变化（新 schema 加载）明确归类为 `tools` 前缀变化。实测同周期内两次适配请求的 A／工具指纹不变、C 仅追加（后一请求的会话消息以前一请求为字节前缀）。

### 17.7 未验证项

- **真实模型摘要质量**：待验证。06-A～06-G 全部使用 faux provider 的脚本叙事，只证明机制（选段、记账、发布、确认、边界）与拒绝不完整结果，不证明真实模型叙事对目标、约束与未完成状态的保留质量（MEM-08）。
- **云端缓存命中**：待验证。逻辑块相同（指纹相同）只说明本地字节相同，不等于提供商缓存命中；TTL、缓存粒度与计费须在目标提供商实测（第 10 节）。测试与代码中不以任何形式宣称已命中。
- 真实窗口下的阈值标定与资源占用：待 MEM-08。本节的窗口数字是派生关系的验证，不是部署标定。

## 18. MEM-07 实现结论与接入语义

> 证据：`test/memory-integration.test.ts`，共 15 个用例（07-A～07-G 与组合接缝），全部跑在真实 `Harness` + Node SQLite + faux provider 上：其一经 `openAgent` 完整应用入口，其二经组合入口的 raw 装配（与 `agent.ts` 相同的注册方式）。验证命令与结果见实施 issues 的 MEM-07 交接记录。本节结论覆盖：组合入口 Interface、配置与错误映射、首次升级、检索预算与关闭语义。

### 18.1 冻结位置

| 内容 | 权威来源 |
| --- | --- |
| 组合入口 Interface（构造、扩展注册、生命周期方法、日志事件形状） | `src/memory/integration.ts` 文件头 |
| `memory_search`／`memory_read` 的参数、结果、预算与错误语义 | `src/memory/memory-tools.ts` 文件头 |
| 配置 schema 与有效范围（`MEMORY_*` 环境变量） | `src/config.ts` 的 `readMemoryConfig` |
| agent 的组合方式（只经组合入口接入，不改动既有请求契约） | `src/agent.ts` |
| 验收 | `test/memory-integration.test.ts`（07-A～07-G） |

### 18.2 组合与生命周期顺序

- 扩展注册顺序固定为 working 工具、检索工具、压缩 Adapter、归档 Task（`extensions()`）。检索与 working 工具在 MCP 适配之前注册，四个记忆工具名因此先于 MCP 工具名被保留；`settings.compaction` 由 `nativeCompactionPolicy(budget, reserve, 模型窗口)` 派生，不再使用 MEM-07 之前的固定值。窗口与预算关系非法时启动期以 `ConfigurationError` 失败，而不是运行到请求期才发现。
- `initialize()` 先写首次升级迁移记录（文档家族 `personal.memory.upgrade`，键 `v1`），再以当前链尾为 archive origin 初始化归档，随后执行一次补扫；已经存在的迁移记录与归档状态使整个初始化成为无副作用重放。升级的完整语义见 18.6。
- 每个请求按持久化事实分类：原回执已完成 → `replay`（不做任何投影、模型或归档工作）；原回执未终结 → `recover`（交回底座续跑原输入，组合层同样不介入）；新请求 → 补扫、投影复用检查、规划、投影或压缩、提交输入。投影复用按 `memory:projection:<requestId>` 的持久化写入决定：未被消费的投影原样复用（规划器版本变化也不重算），已消费的回执说明请求已经处理过。投影的实际写入顺序由第 12 节验证的底座规则保证，组合层不另设回执。
- `afterRequest()` 只在请求完成回执落库后调用：记轮数、评估（窗口与评估间隔都来自配置）、需要时 `root.compact()` 触发原生压缩、再执行补扫。重置经组合入口 `resetConversation()`：先重置底座，再在新链上重新投影边界 B。
- 错误映射：组合层把 `MemoryError` 翻译为带 `MEMORY_*` 应用码与冻结 cause 的错误，`agent.ts` 对 `MEMORY_*` 码原样透传（不包成 `AGENT_SESSION_FAILED`）；底座状态错误继续走既有 Session 失败与恢复退出路径。启动期时区与归档游标冲突（`revision-conflict`）映射为 `ConfigurationError`，其余启动期记忆错误带 `MEMORY_*` 码失败。规划拒绝（`planRequest` 的错误决定）以 `MEMORY_BUDGET_EXCEEDED` 抛出且请求不被 admission。
- `MEMORY_ENABLED=0` 时应用与 MEM-07 之前逐项一致：不注册任何记忆扩展、不改压缩设置、不做投影与归档（07-F 的 disabled 用例逐项断言）。这是整套能力的回滚开关。

### 18.3 facts 的接线取值

本应用传入压缩 Adapter 的 facts 固定为：`instructionsDigest` 取配置 instructions 的 SHA-256 前 32 位十六进制；`memoryDigest` 取 `null`。当前没有参与上下文组装的外部 `MEMORY.md` 文件；working 基线由 revision 管理，每日事件经检索进入 C，因此没有单独的文件记忆摘要。宿主以后若引入由外部资料版本决定的 B 内容，须提供对应的真实摘要。facts 变化时优先走规划压缩（新 B 由原生压缩采用新 facts）；当没有可压缩内容（`compactableTokens == 0`、冻结规划器按设计拒绝）时，组合层执行一次显式周期重启：`root.reset()` 后在新链上投影边界 B，日志记为 `facts-restart`，而不是让后续请求永久失败。07-B/11 用例覆盖两条路径的分界与结果（新 B 的 `instructionsDigest` 为新版摘要、旧周期以 `pi.reset` 结束）。

### 18.4 检索工具语义

- 绑定：宿主在构造时绑定 Daily store 根目录（第 3 节的 `DATA_DIR/memory/daily`）与预算；工具执行时从 `api` 取得当前 Conversation、根目录身份与信号。结果条目携带 segment 的 `date` 与 `id`（来源）与 Charter section；分页游标是不透明字符串 `mc1.` + Daily 游标的 base64url，且同时出现在结果正文中（模型只能使用它看得见的值）。
- 预算：单次结果上限取 `searchResultTokens`；单请求累计上限取 `requestSearchTokens`，按**持久化事实**重算——每个记忆工具的工具结果 Entry 都计入当前请求 user Entry 之后的结果 token 总和，重启后仍准确，不依赖内存计数（07-C 累计用例跨重启验证）。超出累计上限返回 `MEMORY_BUDGET_EXCEEDED` 的错误结果而不是截断到无提示。单个命中超过剩余份额时截断并显式标注 `truncated`；游标取「第一个未完整返回的命中」的重跑游标（有界重跑实现，与 Daily 游标的可重入语义一致）。
- 零命中是成功结果，带 `scannedFrom`、`unread` 与 `available`（扫描边界与预算余量）；损坏的每日文件是 `MEMORY_CORRUPT_STATE` 错误结果，与零命中、文件缺失（目标日期无文件 → 「不存在」成功结果）三种语义互不混淆；未知/非 `MemoryError` 异常继续抛出。工具结果作为普通 native tool result 进入 C，不改变任何持久状态。
- `workingInContext` 只由已记录的投影与快照 baseline 判定，绝不解析工具结果正文（第 14.5 节接缝的组合层实现）：`working_update` 落库后、下一次修订投影写入前，同版 working 可能以修订形式与 B 并存一次——内容相同、有界、无语义影响，记为已知冗余而非缺陷（第 18.7 节）。

### 18.5 归档触发与确认的补扫

补扫在启动与每个请求边界执行，全部来自持久化事实（不持有内存游标）：枚举原生 `pi.compaction` Task（上限 40 条），对终结者调用 `confirmCompactionCycle`，只对 `switched` 且归档范围非空者 `requestArchive`，随后 `reconcileArchive` 循环至多 32 轮把待处理范围推完。补扫是 best-effort：单个任务的 `MemoryError` 只记录安全错误码，不使请求失败（07-D：提取模型持续故障时归档失败状态被持久化、游标不前进，聊天与回复照常完成，原请求重放不产生任何新工作）；非 `MemoryError`（底座状态失败）继续抛出走 Session 路径。归档与聊天解耦的另一面：归档 Task 的完成与失败都不进入请求回执，投递重放只依赖原回执（07-D 与既有 inbox 用例）。

### 18.6 首次升级与关闭

- 升级（07-E）：已有 SQLite、旧原生 compaction（无 Adapter 的原生摘要）、非空 `MEMORY.md` 与未完成的工具调用在首次以 MEM-07 启动时全部保留：原生摘要 Entry 保持 narrative 来源，旧每日事实仍可经检索工具读到，未完成请求按原输入续跑并以原 requestId 完成；`MEMORY.md` 内容逐字不变。origin 冻结在升级时刻的链尾，归档从不回填 origin 之前的历史（升级用例断言归档范围为空、每日目录无新文件；更早的压缩范围同样不会被补扫提供给归档，因为 `archivedThrough` 从 origin 起步）。已有 `memory/daily` 文件被视为归档事实的一部分，不迁移、不改写。
- 关闭（07-F）：`integration.close()` 只停止新的记忆工作（后续 `prepareRequest` 以 `MEMORY_CANCELLED` 拒绝），不取消、不改写任何已持久化的 Task、计数或归档状态；进程关闭后重开，计数、归档游标与待确认切换都从持久化状态继续。底座 Task 的实际 I/O 由 Harness 关闭负责，组合层不另造停止语义。

### 18.7 未验证项

- 真实模型的摘要与事件提取质量、真实窗口下阈值标定、目标提供商云端缓存命中：沿用第 17.7 节结论，待 MEM-08，本节不宣称通过。本地前缀指纹只证明字节身份。
- Telegram 层没有 `/reset` 命令：显式重置能力在组合层（`app.reset()`）与 07-B 用例中验证，未接 Telegram 命令面。
- 检索累计预算在单请求内的扫描上限为 1,000 条工具结果 Entry；超过时按已扫描部分计数（病理量级，正常请求不可达），未单独构造用例。
- working 同版冗余（18.4）与「摘要已持久化未发布」崩溃窗口的复用（17.7）维持既有结论，本节没有新增端到端场景。

## 19. MEM-08 验收结论

验收于 2026-10-28 在本机 Linux（2 核／8 GB，Node v24.22.1）上执行，完整记录（环境、方法、脱敏证据、逐项结果）见 [验收记录](memory-verification.md)。本节只记结论，不改第 1～18 节的任何语义。

- **机制验收通过**：确定性跨日 trace（44 个已完成请求、至少 3 次有效压缩、任务暂停／继续、偏好纠正、工具失败与修正）两次全新运行逐条全等；归档范围三态判定与失败缺口语义、纠正／撤销跨周期与重启的持久性、离线 Adapter 请求体的周期内前缀字节稳定性、全量回归（208 项 205 过／0 失败）与依赖审查均通过。第 17.7、18.7 节所列「摘要已持久化未发布崩溃窗口的复用」已由真实 SIGKILL 场景端到端补验：恢复复用已保存摘要、零额外摘要调用、原文发布。
- **新发现缺陷 D-1**：进程在回复已保存、`afterRequest` 未执行的窗口被杀时，重投递按 replay 跳过计数，该轮 turn 计数永久滞后一轮；回复与状态一致，仅压缩评估触发点后移。是否及如何修复涉及第 18 节冻结的 replay 语义，待决策，未在验收内变更。
- **真实模型与缓存（2026-10-28 已补测，限 DeepSeek）**：以 `deepseek-v4-pro` 经真实集成链路补测，摘要与事件提取对目标、约束、未完成状态与纠正的保留良好，云端缓存真实命中（28 次调用 27 次、约 87%）；同时发现 F-2（未给出的年份被捏造为 2025）与 F-1（`working_update` 被 evidence 校验拒绝、working 结构化状态未落盘），详见验收记录 08-E 节；两项已于当日修复并经真实模型（deepseek-flash）复跑验证：F-1 根因为 entry id 不在模型可见 transcript 中，工具现主动向模型提供可引用的条目 id；F-2 已在摘要与归档提取提示中加入日期保真规则。其余 provider 的真实模型质量、真实窗口阈值标定仍待验证（沿用第 17.7 节口径，不宣称通过）。第 18.7 节的 Telegram `/reset` 命令面缺失与单请求检索扫描上限两条维持原结论。
- **资源数字的适用范围**：验收记录中的延迟、输入量、磁盘与内存峰值均为 faux provider 下的机制开销实测，只证明机制开销与配置上限的派生关系，不代表真实模型延迟。目标环境（腾讯云 4 核／8 GB）已用最终版补测：三负载输入量与本机逐项一致、建成磁盘逐字节一致、峰值 RSS 约 136 MiB（远低于 issue 规格所写 4 GB），全量 208 项 197 过／0 失败／11 跳过（跳过为非 root 门控与显式 opt-in，已对账）；服务器 Node 须 ≥ 引入 `setGlobalProxyFromEnv` 的 24.x 版本（v24.9.0 不足），部署应钉死版本下限。

## 20. 实施入口与发布判定

按 [实施 issues](memory-implementation-issues.md) 的依赖顺序执行。先完成公开 API 可行性和 Interface 契约，再并行实现 Working、Context、Daily Memory；最后接入底座与应用并做故障恢复验收。

验收必须同时证明：实际请求含 A/B/C、周期内前缀稳定、压缩后状态正确、归档不重不漏、检索可追溯、既有请求与投递恢复保持有效。固定序列的离线模型验证机制，真实模型验证摘要质量和缓存行为，两者分别记录。仅修改文档不代表其中任何能力已实现。
