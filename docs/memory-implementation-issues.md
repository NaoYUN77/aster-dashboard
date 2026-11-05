# Memory 与 Context：实施 issues 和验收

状态：MEM-01～MEM-06 的 module 已实现并通过各自本地验收；MEM-07 已完成组合接入并通过本地验收，记忆能力已注册到运行中的 agent；MEM-08 验收已执行（08-A／C／D／E／F／G／H 通过，08-B 窗口 6 缺陷 D-1 待决策；08-E 已用 DeepSeek 真实模型补测，遗留发现 F-1／F-2；08-F 已在目标服务器补测完成），记录见 `docs/memory-verification.md`。编制日期：2026-10-25。架构与 Interface 语义以 [实施方案](memory-and-context-design.md) 为唯一来源；本文负责拆分任务、依赖、交接产物和完成条件。

阅读边界：本文是 MEM-01～08 的历史任务拆分与交接记录。下文的领取顺序、冻结节点和范围排除项只适用于该批实施，不作为新功能开发指令；后续任务以当前代码和记忆设计为起点，按 [临时 spec 约定](README.md#按功能的临时规格) 定义功能范围。

## 原实施接手方式

1. 先读根目录 `CLAUDE.md`、实施方案，以及领取 issue 指向的代码；涉及 SDK 时核对已安装的发布版。
2. MEM-01 完成后冻结应用契约和文件归属，再开始并行。后续需要变更公共 Interface 时，先更新契约及调用方说明；不由两个 agent 各建一份近似类型。
3. 每个 issue 交付一个可独立评审的改动，包含本项代码、针对真实失败行为的测试，以及契约发生变化时的对应文档。共享组合入口由 MEM-07 统一接入。
4. 测试遵循 `package.json` 的检查入口和既有 `test/*.test.ts` 发现方式。离线模型使用现有 faux provider；持久化路径使用临时目录和真实 SQLite，不能用生产数据或外部凭据代替测试夹具。
5. 交接记录列出已完成验收编号、执行命令与结果、未通过或未执行项、兼容性变化及后续依赖。测试文件存在不等于验收通过。

创建远端 issue 时可直接使用各节的标题、范围、依赖与验收；MEM 编号是本文任务标识，不能冒充 GitHub issue 编号。

远端 issues（2026-10-25 创建，标签 `enhancement`）：

| ID | GitHub issue |
| --- | --- |
| MEM-01 | [#8](https://github.com/NaoYUN77/personal-agent-base-durable/issues/8) |
| MEM-02 | [#9](https://github.com/NaoYUN77/personal-agent-base-durable/issues/9) |
| MEM-03 | [#10](https://github.com/NaoYUN77/personal-agent-base-durable/issues/10) |
| MEM-04 | [#11](https://github.com/NaoYUN77/personal-agent-base-durable/issues/11) |
| MEM-05 | [#12](https://github.com/NaoYUN77/personal-agent-base-durable/issues/12) |
| MEM-06 | [#13](https://github.com/NaoYUN77/personal-agent-base-durable/issues/13) |
| MEM-07 | [#14](https://github.com/NaoYUN77/personal-agent-base-durable/issues/14) |
| MEM-08 | [#15](https://github.com/NaoYUN77/personal-agent-base-durable/issues/15) |

原实施顺序要求先领取 MEM-01，依赖未满足时不提前实现下游 module 的接入部分；本表与各 issue 的「依赖」一节一致，改动时两处同步。MEM-01 已于 2026-10-25 完成（交接记录见本节末），MEM-02、MEM-03、MEM-04 同批完成（交接记录分别见其小节末）。MEM-05 已于 2026-10-26 认领并完成本地验收（交接记录见对应小节）；MEM-06 已于 2026-10-27 认领并完成本地验收（交接记录见其小节末）。

## 依赖与并行安排

| ID | 标题 | 依赖 | 主要修改归属 |
| --- | --- | --- | --- |
| MEM-01 | 验证原生接入并冻结最小契约 | 无 | SDK 契约验证测试、应用 schemas、本文与实施方案 |
| MEM-02 | Working 状态与版本化更新 | MEM-01 | Working Module、working Document／tools Adapter、对应测试 |
| MEM-03 | 纯 Context 规划与快照渲染 | MEM-01 | Context Module、稳定渲染与预算测试 |
| MEM-04 | 每日 Markdown 的发布与检索 | MEM-01 | Daily Memory Module、文件协议及对应测试 |
| MEM-05 | 可恢复的增量归档任务 | MEM-01、MEM-04 | Archive Module、归档 Task／提取 Adapter、对应测试 |
| MEM-06 | 原生压缩接入与周期快照切换 | MEM-02、MEM-03 | compaction Adapter、轮数评估与对应测试 |
| MEM-07 | 接入请求生命周期及记忆工具 | MEM-02～MEM-06 | `src/agent.ts`、配置、注册入口、原生检索工具、运行说明 |
| MEM-08 | 故障恢复、质量与资源验收 | MEM-07 | 综合验证、验收记录及目标环境结果 |

MEM-02、03、04 可并行；04 完成后可启动 05，02 与 03 完成后可启动 06，05 与 06 可并行。每项应使用最小 harness 或独立 Interface 完成测试，不等 MEM-07 接线后才证明自身正确。

MEM-01 验证失败的接入点必须有具体替代方案和对应验收后才能解锁依赖项；不能把未证实能力写成“后续补一个 hook”。不涉及该接入点的独立 module 可继续推进。

## MEM-01：验证原生接入并冻结最小契约

**目标**：用已安装公开 API 证明关键时序，给其他 agent 一个可信、足够小的 Interface。此项包含必要的离线测试代码，不实现完整记忆功能。

**阅读入口**：实施方案第 2、4、6、7、10、11 节及第 12 节；`test/durable.test.ts`、`test/recovery.test.ts`、`test/memory-contract.test.ts`；SDK 的 `harness/types.d.ts`、`compaction.js`、`context.js`、`generation.js`、Documents／Tasks 的公开类型。

**工作与交付**：

- 冻结 WorkingState、工作更新与回执、CycleSnapshot、MemorySegment、ArchiveBatch、ContextPlan 的最小版本化 schema；只定义本项目的数据，复用 SDK Message／Entry／ID。schema 是类型与校验的共同来源。
- 固定范围的开闭语义、来源标识、业务 revision、快照格式、错误类别、预算归属、文件命名与跨日规则。ID、身份、目录和幂等操作标识由宿主提供。
- 证明 working 更新的 commit 与 Entry checkpoint 对齐，能读取切分点之前的状态；定义 fork／旧 head 情况的来源定位方法。
- 验证 `beforeCompact`、memo 和原生提交组合；确定自定义摘要／提取的调用归属、取消、持久化结果及原生 usage 记账方法。
- 验证压缩任务终态、summary write 入队、正式发布、stale 的区别；确定可重放的发布观察与补扫方式。
- 冻结首次 B、重置后 B 和长 run 压缩的接入顺序，以及业务错误到应用错误的映射。文档与验证结论写回现有两份文档，避免另建重复计划。

**验收**：

- [x] 01-A：真实 Harness + SQLite + faux 模型中，首次请求、工具后续请求及压缩后的实际请求均有有效 system prompt。
- [x] 01-B：先在同 commit 写 working 与锚点，再做后续更新，验证 `snapshotAsOf` 得到切分边界的旧版本；覆盖 head marker ID 晚于保留原文的情况。未覆盖 fork 必须显式限制并拒绝，而非返回错误状态。
- [x] 01-C：后台摘要入队不切换应用周期；仅正式发布触发，stale 不触发。重启补扫不会漏掉已经发布的摘要。
- [x] 01-D：展示 hook 能力的最小实现，既不深导入 SDK 内部路径，也不向 busy conversation 直接追加模型消息。若需要 API 升级或底座变更，依赖项保持阻塞并记录具体缺口。
- [x] 01-E：自定义摘要／提取的模型调用有可核对的 usage 归属和失败／重试用量，不因只返回字符串漏计或重复计量；取消信号到达实际模型 I/O。
- [x] 01-F：新旧输入格式、旧 compaction、初始化和升级起点有明确兼容策略。每个 module 的输入、输出、错误、副作用及顺序约束可从一个 Interface 定义查到。

**交接记录（2026-10-25）**

交付物：

- `src/memory/contracts.ts`：schema 版本 1 的唯一来源——`WorkingState`／更新参数／回执／锚点、`CycleSnapshot` 及编解码、`MemorySegment`、`ArchiveBatch`、`ContextPlan`、`MemoryBudget`、`SourceRange` 与日期命名、`MEMORY_ERROR_CODES`／`MEMORY_ERROR_MAPPING`／`MemoryError`、`workingAtBoundary`。文件头按 module 写明输入、输出、错误、副作用与顺序。
- `test/memory-contract.test.ts`：01-A～01-F 加接入顺序测试，全部使用真实 `Harness` + `openNodeSqliteStorage` + faux provider，临时目录，不接触生产数据或外部凭据。
- `docs/memory-and-context-design.md`：第 12 节记录实测结论，第 2、4、6、7、8、11 节按结论修正。

执行命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过，无输出 |
| `npx tsx --test test/memory-contract.test.ts` | 8/8 通过 |
| `npm test` | 95/95 通过（既有 durable、recovery、delivery、tool 测试无回归） |

各验收的实测结论：

- **01-A**：首次、工具后续、压缩后主请求都含 `instructions` section 与工具声明；摘要请求使用独立纯文本系统提示；阻塞压缩的终态结果为 `{ entryId }`，指向新的 `pi.compaction` head。
- **01-B**：同 commit 的 Document + 锚点 Entry 给出精确边界历史；marker ID 晚于保留原文仍按锚点读取；未覆盖 fork 与首条 Entry 之前的边界均抛 `not-covered`；家族文档重放返回原回执且不改 revision。
- **01-C**：入队（`queued`）与发布（`done` + head 变为 `pi.compaction`）分离；reset 越过后为 `unanswered`/`stale` 且周期不变；重开 Harness 后按 `compaction:<taskId>` 仍读到 `done`。
- **01-D**：展示写入运行中立即落地且 0 条模型消息；模型写入排队到边界。
- **01-E**：hook 内调用不产生原生 usage（`summary/summary-1` 缺失），应用归属键累计失败＋成功两次尝试；`ctx.abortSignal` 使调用返回 `aborted`，任务提交 `aborted` 终态。
- **01-F**：schema 拒绝额外字段、`undefined`、越界与非法日历日期；范围 `(after, through]` 语义；快照编解码对旧摘要返回 `undefined`、对损坏／未知版本抛错；错误映射不含 `AGENT_SESSION_FAILED`。

未通过或未执行项（均不属于本 issue 验收，已写入实施方案 12.6）：自定义归档 Task 的 `abort` 阶段与恢复（MEM-05）；hook 运行时对象上未声明的 `commit()` 未作为契约使用；真实模型窗口预算与缓存命中（MEM-06、MEM-08）；归档任务的文件级恢复窗口（MEM-05，每日文件替换本身已由 MEM-04 的 04-B 覆盖）。

对下游的解锁条件：MEM-02～MEM-05 可立即开始，共享 `src/memory/contracts.ts`，不得另建近似类型；MEM-06 在 MEM-02、MEM-03 完成后开始，接入顺序按实施方案 12.4 执行（先 reset 再写 B）。发布观察点有两条路径：经 submission 的压缩看 `done`，阻塞压缩看 `entryId` 是否成为活跃 head（详见 12.3、14.5）。

## MEM-02：Working 状态与版本化更新

**目标**：提供可恢复的当前任务状态和明确偏好，不承担执行恢复或消息投递状态。

**依赖**：MEM-01。**阅读入口**：实施方案第 3、5 节及第 12、13 节；`src/memory/contracts.ts`、`src/memory/working.ts`（已实现）；现有工具注册和参数验证测试。

**工作与交付**：

- 实现 task 与 preferences 分区的 Working Module，支持读取当前状态、指定边界状态及带 expectedRevision 的有来源变更。
- Durable Adapter 定义 rewindable Document 和原生 `working_read`／`working_update`；更新与应用操作回执、Entry 锚点按 MEM-01 的协议提交。
- 返回有界修订，让原生工具结果进入 C；模型参数不能设置宿主身份、执行状态或归档游标。
- 对来源、任务完成证据、偏好作用范围和有效期做执行边界检查。明确完成事件可供归档恢复处理，任务清理不清空有效偏好。

**验收**：

- [x] 02-A：非法参数、未知字段、无效来源和 revision 冲突不执行变更；显式错误可由后续有效工具调用修正。
- [x] 02-B：同一调用在“Document 已提交、工具结果未提交”处中断，恢复后状态只变一次，返回原回执，revision 不额外增加。通过后才声明安全重放。
- [x] 02-C：两个基于同一 revision 的更新不会静默覆盖；无业务变化不递增 revision。
- [x] 02-D：跨多次更新与重启，当前读取和边界读取均正确；B 使用旧版本时，C 中的修订能导出当前状态。
- [x] 02-E：任务完成后活跃事项可清理，持久化完成事实可重取，跨任务偏好仍在；一次性要求不自动成为永久偏好。
- [x] 02-F：超过状态上限时返回明确处理结果，不静默丢弃当前约束。module 测试无需 Telegram 或真实模型。

**交接记录（2026-10-25）**

交付物：

- `src/memory/working.ts`：Working Module Interface——`readWorking`、`readWorkingAt`、`readWorkingReceipt`、`readCompleted`、`applyWorkingUpdate`（输入 `Committer`，Session 与工具执行 API 都满足）、`activeTask`。文件头写明输入、错误（`invalid-input`／`revision-conflict`／`missing-evidence`／`not-covered`／`corrupt-state`）与副作用。
- `src/memory/working-tools.ts`：原生 `working_read`／`working_update`，`replay: "safe"`，有界文本视图与 `structuredOutput`；业务错误返回可修正结果，非 `MemoryError` 抛出；导出 `workingExtension` 供 MEM-07 组合。
- `src/memory/contracts.ts`（增量）：`WORKING_COMPLETED_KIND`／`WorkingCompletedSchema`／`WorkingCompletedEntry`；锚点与回执的 `completedEntryId`；模型可见 `ProgressItemDraftSchema`、`ActiveTaskDraftSchema`、`PreferenceDraftSchema`，使模型只传 `EntryId`，不传 `conversationId`。
- `test/memory-working.test.ts`：02-A～02-F，另加 02-G（存储值 schema 不符显式报错）。
- `test/fixtures/crash-working.ts`：真实子进程，在“已提交、未写工具结果”处阻塞，由父进程 `SIGKILL`。
- `docs/memory-and-context-design.md`：新增第 13 节（冻结位置、身份与幂等、一次 commit 写什么、崩溃窗口、错误与模型可见输出）；MEM-03 加入第 14 节后，原第 13 节之后的实施入口节顺延为第 15 节。

执行命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过，无输出 |
| `npx tsx --test test/memory-working.test.ts` | 7/7 通过（含真实进程崩溃恢复） |
| `npm test` | 102/102 通过（MEM-01 基线 95 项未回归） |

逐项结论：

- 02-A：未知字段、空 `changes`、无证据的 `task.set`、未提交或属于其他会话的证据、旧 revision 全部被拒绝；参数级拒绝由底座在 `execute` 前拦下，业务级拒绝返回 `isError`。所有拒绝不写锚点、不改状态，随后一次有效调用成功并进入 revision 2。
- 02-B：工具为 `replay: "safe"`；kill 后重启，同一工具任务重跑一次（测试记录重跑次数），命中回执后原样返回。revision 未再递增，锚点只有一条，工具结果报告原 revision。
- 02-C：基于同一 revision 的第二个更新得到 `revision-conflict`，状态保持第一个更新的结果；同内容再次提交得到 `changed: false`、revision 与 `updatedAt` 均不变。
- 02-D：多次更新后按锚点读取边界状态，每个锚点读到的 revision 与锚点记录一致；最新锚点读到的状态等于当前状态；关闭并重开 Harness 后当前与边界读取都一致；首个更新之前的边界为 `not-covered`。
- 02-E：`task.clear` 写 `WorkingCompleted` entry，回执与锚点带 `completedEntryId`，重启后仍可 `readCompleted` 取回；有效偏好保留；一次性约束只留在任务里，不成为偏好；重复清理是 no-op，不产生第二个完成事实。
- 02-F：偏好达到上限时新增被拒；约束超过 schema 上限时整次更新被拒；拒绝后已存状态逐字段不变；移除一条偏好后可再添加；已过期偏好不落库。
- 02-G（补充）：回执版本不符时 `readWorkingReceipt` 报 `corrupt-state`，不按旧结构解释。

未覆盖／受限：

- 真实模型的工具选择与参数质量不在 module 范围（MEM-07／MEM-08）。
- 偏好作用范围目前只做存储与展示，尚无检索期的作用域过滤（MEM-06 之后接入）。
- 归档从 `completedEntryId` 取完成事实的消费方尚未实现（MEM-05）。
- 未接入运行中的 agent：`workingExtension` 已导出但未在 `src/agent.ts` 注册（MEM-07 负责组合）。

对下游的解锁条件：MEM-02 已完成，MEM-06 可与 MEM-03 并行开始；读取 Working 一律经 `src/memory/working.ts`，不直接读 `WorkingDoc`。模型可见 schema 的 `*Draft` 系列只用于工具参数，内部契约继续使用带 `SourceRef` 的类型。

## MEM-03：纯 Context 规划与快照渲染

**目标**：给定已固定输入，输出确定的加载／压缩计划与有界快照，保持 B 和既有 C 稳定。

**依赖**：MEM-01。**阅读入口**：实施方案第 1、4、6、7、10 节及第 12、14 节；`src/memory/contracts.ts`、`src/memory/context.ts`（已实现）。

**工作与交付**：

- 实现纯函数规划：初始化 B、无需动作、缺失资料投影、压缩意图、明确错误。
- 稳定渲染版本化 B，将叙事摘要与精确状态分开；保存来源边界及 revision，不混入每次调用变化的时间。
- 实现总输入和分项预算判定，区分后台阈值与硬限制；参数从唯一 schema 取得。
- 定义按来源／版本去重，及读取同一已提交投影时保持原文的行为；返回待提交材料，由 Durable Adapter 执行副作用。

**验收**：

- [x] 03-A：相同输入得到字节一致的渲染与计划；重复构建不会产生重复记忆投影。
- [x] 03-B：working revision 更新时，输出需要进入 C 的修订，不重渲染现有 B；下次周期才输出新 B。
- [x] 03-C：带旧快照、近期修订和新偏好撤销的样本，不把旧值重新当作当前约定。
- [x] 03-D：空白 system prompt、必要状态损坏、超预算且无可安全压缩内容时返回明确错误；所有输入块及缓存 token 均计入预算。
- [x] 03-E：测试无需启动 Harness、打开文件或调用模型；module 无这些运行时依赖。
- [x] 03-F：不创建 SDK 消息类型副本、不裁断工具关联、不生成新 agent loop。短对话达到轮数但无足够可压缩内容时不反复要求压缩。

**交接记录（2026-10-25，2026-10-25 复核后修订）**

初版把投影写成 `model: []` 的展示条目，与第 12.4 节“首次请求已含 B”冲突，也使 03-B／03-C 只证明了“能生成当前状态的数据”，没证明“能进入模型上下文”。复核后改为两种都带模型消息的写入，并补上分项预算与 facts 变化的判定。修订内容见本记录末尾。

交付物：

- `src/memory/context.ts`：Context Module Interface——`planRequest`、`boundaryWrite`（建立 B，携带原生摘要形状的模型消息）、`revisionWrite`（周期内补入 C，携带 `<working-revision>` 包裹的精确 baseline）、`reuseWrite`、`digestOf`、`sameFacts`、`blockUsage`、`buildSnapshot`、`renderSnapshot`、`snapshotFromHead`、`snapshotOfProjection`、`snapshotTextFor`、`measureRequest`、`validateWorking`、`isStale`、`initialBoundary`。文件头写明输入、输出、错误与“无 I/O／无 Harness／无模型”的约束。
- `src/memory/contracts.ts`（增量）：`WorkingBaselineSchema`／`baselineOf`／`renderBaseline`（去掉 `updatedAt` 的边界投影与确定性渲染）、`CycleBoundary` 类型与可为 `null` 的 initial 锚点、`sources` 可为 `null`、`SnapshotFacts` 类型导出、`Preference` 类型、`MEMORY_LIMITS.instructions`／`snapshotText`、`REVISION_BLOCK_OPEN`／`REVISION_BLOCK_CLOSE`、`ContextPlan` 的 `compact.reason` 增加 `facts`、`MemoryErrorCodeSchema` 改为 `Type.Unsafe`（`Type.Union` 推断为 `never`）、`MemoryError.toJSON()`。
- `test/memory-context.test.ts`：03-A～03-F 共 10 个用例，纯值测试；唯一一次文件读取用于断言模块的 import 列表，不启动 Harness、不打开数据库、不调用模型。
- `docs/memory-and-context-design.md`：新增第 14 节（冻结位置、输入输出与优先级、B/C 边界、预算、与 MEM-02／MEM-06 的接缝），原第 14 节改为第 15 节；第 2、6、7、10 节同步状态与实现结论。

执行命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过，无输出 |
| `npx tsx --test test/memory-context.test.ts` | 10/10 通过 |
| `npm test` | 112/112 通过（MEM-02 基线 102 项未回归） |

逐项结论：

- 03-A：同输入的计划 `JSON.stringify` 完全一致；同一快照的重复渲染与键顺序重排后的渲染字节相同，且能解码回原值；只改 `updatedAt` 的两次渲染与 digest 相同。boundary 写入本身也逐字节一致，`snapshotOfProjection` 取回的就是它渲染的那份快照。同一 revision＋同一 facts 的重复写入 digest 相同，`reuseWrite` 原样返回已提交写入；C 已含该 revision 后计划为 `none`。
- 03-B：`workingInContext: false` 且 revision 落后时计划产出一个 `revision` 写入；该写入的 `model` 恰有 1 条 user 消息，含 `<working-revision>` 标记与 `renderBaseline` 的精确内容，因此不调用 `working_read` 也能读到当前值；写入不含旧叙事，也不被 `snapshotOfProjection` 当成 B；已提交 B 的渲染字节不变；换周期后 `snapshotTextFor` 返回新文本，活跃周期返回 `undefined`。
- 03-C：旧快照含 `lang` 偏好、当前 revision 撤销它时，`isStale` 为真，写入的 `baseline.preferences` 只有 `tone`，模型消息里也只有 `tone`、没有 `lang`；旧 B 不被改写；新周期的 B 不再含 `lang`；C 已含修订后不再逐轮投影。
- 03-D：空串与纯空白 A 返回 `invalid-input`，超长 A 返回 `budget-exceeded`；`revision: 0`、缺字段的 working 与结构不完整的 B 均返回 `corrupt-state`（且 schema 校验先于分项测量，损坏的 B 不会在计量时抛异常）；任一分项超过自己的额度返回 `budget-exceeded` 且 `detail.block` 指明块名，把该块额度放宽后同一输入即通过；超过阻塞阈值且 `compactableTokens === 0` 返回 `budget-exceeded`，有可压缩内容时改为 `compact`／`budget`；恰好等于阈值仍可放行。`measureRequest` 对 `input+output+cacheRead+cacheWrite` 求和，去掉缓存后差额恰为缓存量，尾随消息计入；用该实测值驱动计划时请求超限。
- 03-D（渲染上限）：结构合法但渲染文本超过 `MEMORY_LIMITS.snapshotText` 的 B 由 `renderSnapshot` 直接调用时抛 `budget-exceeded`，经 `planRequest` 时返回同码的错误计划，不截断、不以异常穿出。
- 03-D（写入额度）：在合法的 256 token 快照份额下，已提交 B 通过分项检查，但该计划将要生成的写入（首次 B 与修订写入）各为 392／276 token，均超出份额，`planRequest` 返回 `budget-exceeded` 且 `detail` 为 `{block: "snapshot", kind, tokens, limit}`；换成默认份额后同样输入返回 `project`，说明拒绝因素是份额而非其他条件。
- 03-D（facts 变化）：`facts` 一致走常规路径；`memoryDigest` 变化、revision 不变时返回 `compact`／`facts`，无可压缩内容时返回 `budget-exceeded`，周期内不重写前缀。
- 03-E：断言 `context.ts` 的 import 列表恰为 `./contracts.js`、`@earendil-works/chord`、`@earendil-works/pi-ai`、`@earendil-works/pi-ai/utils/estimate`、`@earendil-works/pi-durable`、`node:crypto`；pi-durable 与 chord 都只以 `import type` 出现；不含 `node:fs`／`node:child_process`／`node:sqlite`／`Harness`／`openNodeSqliteStorage`／`createModels`。`planRequest` 同步返回，两次调用互不共享对象，输入不被修改。
- 03-F：轮数超过阈值但 `compactableTokens === 0` 时连续三轮都是 `none`；有可压缩内容时返回 `compact`／`rounds`；少一轮不触发。`measureRequest` 不修改 transcript，工具调用与其结果的关联保持，工具参数计入大小。
- 变异检查：初版 7 个变异（去掉 `compactableTokens` 守卫、忽略 `workingInContext`、digest 不含 facts、阈值不含 `reserveTokens`、`snapshotTextFor` 不去重、baseline 保留 `updatedAt`、允许空白 A）全部被捕获。修订后新增 7 个（revision 写入改为空 model、boundary 写入改为空 model、去掉分项额度检查、忽略 facts 变化、把分项测量移到 schema 校验之前、去掉写入生成后的额度检查、去掉 `planRequest` 的异常转换），也全部被捕获；其中“boundary 写入改为空 model”在补上断言前未被捕获，说明该缺口原先确实没有证据。

未覆盖／受限：

- 真实模型窗口下的预算标定与缓存命中不在本 issue 范围（MEM-06、MEM-08）。
- `planRequest` 只做决策，不写任何东西；两种写入的持久化、submission 排队与周期切换由 MEM-06 的 Durable Adapter 完成。
- `measureRequest` 的数值依赖底座 usage 上报；faux provider 不产生真实缓存计量，本项只验证口径而非真实计费。
- 缺失资料投影未实现：模块不接收待补资料正文，因此“已有 B、revision 不变、只缺某份资料”时计划为 `none`。该输入需要由 MEM-04（检索）与 MEM-07（接线）定义，见实施方案第 6 节。
- 写入额度按快照份额检查，是“单次写入不超过该块容量”的上界；它与请求总预算的相互作用（写入后请求整体是否仍装得下）由 MEM-06 在真实请求上标定。
- `budget.narrativeTokens`、`searchResultTokens`、`requestSearchTokens` 当前不被本模块消费，对应的超额判定分别属于 MEM-06 的摘要调用与 MEM-05／MEM-07 的检索预算，本项没有假装已判定。
- 尚未在组合入口注册（MEM-07）。

对下游的解锁条件：MEM-06 可开始。压缩侧只通过 `buildSnapshot`／`renderSnapshot` 产出 B，边界状态一律由 `readWorkingAt` 按锚点读取后传入，不传最新状态。周期切换有两条确认路径，缺一不可：经 submission 发布的压缩看 `requestId = "compaction:<taskId>"` 落到 `done`；generation 拥有的阻塞压缩直接 append，只返回 `{ entryId }`、没有 submission，须以该 Entry 成为活跃 head 为判据（详见实施方案 14.5）。MEM-07 接线时 `workingInContext` 由活跃上下文的实际内容决定，不能默认 `true`；两种写入都用 `root.submit({type: "write", entry})` 提交，不得改回 `model: []`。

## MEM-04：每日 Markdown 的发布与检索

**目标**：提供一个可独立测试的文件存储 Interface，隐藏文件查重、原子替换和分页细节。

**依赖**：MEM-01。**阅读入口**：实施方案第 8、9 节及第 12 节；`src/memory/contracts.ts` 中的日期与分段规则。

**工作与交付**：

- 实现发布固定分段、按稳定引用读取、按日期／关键词／主题检索；接受目录、时钟和已校验数据，内部不调用模型或 Harness。
- 使用约定的日期文件、分段 ID、内容摘要和来源格式；单写者、临时文件、同步与原子替换保证可恢复。
- 为单段、单文件、一次扫描／返回设置明确上限；超限按已冻结的分页或续页规则处理，不静默截断。
- 读写失败、无命中、未扫描范围、游标失效和外部文件冲突分别报告；检索结果可定位到精确分段和原文来源。

**验收**：

- [x] 04-A：同 ID 同内容重复发布不重复追加；同 ID 不同内容报冲突。并发发布串行化且不丢分段。
- [x] 04-B：在临时文件写入、原子替换前后注入失败，读者看到完整旧版或完整新版；重启能核对原回执。
- [x] 04-C：路径越界、符号链接逃逸、无权限、损坏文件、未知引用分别有明确结果；数据目录由宿主控制。
- [x] 04-D：跨多个日期分页检索，零命中不等于历史不存在；返回扫描范围、继续游标和未读范围。文件在翻页间变化时不静默漏项。
- [x] 04-E：已撤销／被替代的记忆不会作为当前事实返回；历史视图明确标识旧状态。
- [x] 04-F：长文本和大量日期文件不会一次性读入全部历史；测试记录实际扫描／返回上限，且完全不依赖 agent 运行时。

### 交接记录（2026-10-25，含首轮评审修正）

**交付**：`src/memory/daily.ts`（Daily Memory Module）、`test/memory-daily.test.ts`（7 个用例覆盖 04-A～04-F）。模块只依赖 `./contracts.js` 与 Node 标准库，不引入 agent 运行时、数据库或模型。

**Interface**：`openDaily(root)`、`publishSegments(store, segments)`、`readSegment(store, ref)`、`searchDaily(store, query)`、`digestOfSegment(segment)`、`identityOfSegment(segment)`；`DAILY_LIMITS`、`SearchCursor`、`CoveredFile`、`DailySearch`、`SegmentLookup`、`PublishReceipt` 从同一文件导出。文件格式、顺序规则与错误语义写在文件头。

**评审提出的 12 个缺陷及本地修复记录如下，等待复验**。自动化证据按场景分别记录；缺陷 3、8 各有一个同调用内窗口尚无自动化覆盖，不能声称全部修正都有「回退即失败」的证据。

| # | 缺陷 | 修正 |
| --- | --- | --- |
| 1 | 块外内容被跳过，损坏标记后的记录对检索不可见，下次发布整体重写会删掉它 | `parseFile` 严格解析：块外内容、标题不符、空文件均报 `corrupt-state`，发布同样被拒 |
| 2 | 按文件刷新会提前写入同文件的其他替代记录，跨文件时不保证先撤销 | 分两阶段：先写完所有文件的替代标记，再写任何含新记录的文件 |
| 3 | 游标在签发时重新测量文件，读取后的追加被吸收进游标自身，续页静默漏项 | 游标携带**读取前一刻**观察到的 `covered`（size + mtime），续页逐个比对 |
| 4 | 只检查 `root/memory/daily` 与目标文件，`root/memory` 为 junction 时写穿根目录 | 检查 `root` 到文件之间的每一层；列目录前也检查 |
| 5 | 同一调用内两条记录可替代同一旧记录，两条都成为当前事实 | 落盘前检测批内重复替代，报 `revision-conflict` |
| 6 | 发布身份包含可变的 `supersededBy`，被替代后原始调用无法幂等重放 | 新增 `identityOfSegment`（`supersededBy: null` 的摘要）用于判重；存储摘要仍含它 |
| 7 | CRLF 正文按原文计算摘要，读回时规范化后必然不符 | 发布前统一换行再算摘要，读取时同样规范化 |
| 8 | 消失的文件被计入游标指纹，下一页必然 `stale` | 消失文件记为 `unread` 且不进入 `covered`；已在 `covered` 里的文件被删除也不报 `stale`（无记录可漏） |
| 9 | 命中／分段上限提前 `break` 时跳过 `scannedThrough` 赋值 | 文件读完即记录范围，早退时也已赋值 |
| 10 | 先整份 `readFile` 再检查大小，超限文件仍可占满内存 | 用文件句柄最多读到上限 +1 字节；测试同时断言模块不使用 `readFile` |
| 11 | 两页之间补写更早日期的文件：它排在游标之前、从未被读过，因此不在 `covered` 里，`stale` 比对发现不了它；续页从游标文件开始，直接跨过它并返回 `next: null` | `resumeAt` 把扫描起点回退到「游标之前第一个 `covered` 未记录的文件」；`covered` 中的文件已逐个校验未变，扫描时跳过，不重复返回 |
| 12 | 补写扫描再次分页时，原游标在文件中间的位置与摘要被丢弃，后续重复返回旧记录且文件变化未报 `stale` | 更早补写出现时，若原游标有 `index > 0` 或非空 `fileDigest`，立即报 `stale`，由调用方重新检索；只允许无位置／摘要负担的文件边界游标回退 |

**验收结论**：

- 04-A：同 ID 同发布身份返回 `duplicate` 且文件字节不变；同 ID 不同身份与同调用内 ID 冲突均报 `revision-conflict` 且不写任何文件。12 个并发 `publishSegments` 全部落盘，无丢失、无重复。记录被替代后重放其原始发布仍返回 `duplicate` 与原身份（缺陷 6）。
- 04-B：临时路径被目录占用 → `io-failure`，旧文件完整、无临时文件残留；目标只读导致 `rename` 失败 → `io-failure`，旧文件完整、临时文件已清理。两种失败后重试都返回 `published` 且摘要与内容一致；重新 `openDaily` 后按引用读回同一摘要，再次发布为 `duplicate`。
- 04-C：相对根目录与越界／非法日期 → `invalid-input`；`missing-file` 与 `missing-segment` 区分；符号链接（数据目录、文件、`root/memory` 层）在读、写、列目录、检索时均 → `corrupt-state`，且经 junction 未写出任何文件；目录占用文件名 → `io-failure`；非法 JSON、缺字段、摘要不符、正文被改、元数据重复携带正文、位置与文件名不符、块外内容、标题不符 → `corrupt-state`；损坏标记后读取、检索、发布三者都被拒且文件保持原样；CRLF 正文发布后可读回且摘要可复现；正文含块标记 → `invalid-input`。
- 04-D：空库 `available === 0`，无命中但有历史时 `available > 0`；按命中与按文件两种分页都能无重复、无遗漏地走完 5 个日期文件；`maxFiles` 分页返回 `unread`，且 `scanned.from`／`through` 只覆盖真正读到的两个文件；单文件 `limit: 1` 时 `through` 仍是该文件（缺陷 9）；已消费文件在下一页之前被追加后游标报 `stale`，且重扫能取回该记录（缺陷 3）；范围外文件游标报 `stale`；文件在列出前已消失时游标报 `stale`，不带游标仍能读到其余文件；已在 `covered` 中的文件随后被删除时续页照常返回剩余记录（缺陷 8）；**先扫 20 日、游标指向 22 日，再补写 21 日文件，续页返回 21 日与 22 日且 `next: null`（缺陷 11）**；多页之后补写（20、21 已返回、游标指向 23）时补写日期被返回且已返回文件不重复；补写日期本身填满一页时游标停在该文件内，`unread` 仍列出后续文件；补写日期排在两个已消费文件之前时，游标跳过中间已消费文件而不重复返回（缺陷 11）；**游标停在 22 日文件中间时补写含 X、Y 的 21 日文件，续页在返回补写页之前报 `stale`（缺陷 12）**；命中上限、文件上限及足够大的上限均拒绝该旧游标；拒绝不修改原游标，移除补写后仍能按原 index 续读 B，修改原文件后原摘要仍报 `stale`；index 为零但带摘要的游标同样拒绝更早补写，重新检索能读到全部记录（缺陷 12）；`limit`／`maxFiles` 越界报 `invalid-input`（不夹取）。
- 04-E：替代记录发布后旧记录不再作为当前事实返回，`historyExcluded` 计数；`includeHistory` 时旧记录带 `supersededBy`；按引用仍读出原值；重复替代、同调用内重复替代（缺陷 5）与悬空目标分别报 `revision-conflict`／`revision-conflict`／`not-covered`。跨文件两阶段写入：替换文件不可写时，成功阶段已标记的旧记录不再当前，失败阶段的那条保持当前且其替代记录未落盘——任何时刻都不会同时出现两个当前答案（缺陷 2）；重试后只剩两条新事实。同文件同时含标记与新记录时写两次，结果仍只有新记录当前。
- 04-F：`MEMORY_LIMITS.note` 长的正文可发布，多一个字符被 schema 拒绝；单文件 500 段上限触发 `budget-exceeded`，续页 `-2.md` 可用，页码 10 被命名规则拒绝；8 MiB 文件读、检索均报 `budget-exceeded`，恰好等于 1 MiB 的文件可读（缺陷 10）；27 个日期文件时单次只读 `DAILY_LIMITS.scanFiles` 个并列出 `unread`，`scanned.files + unread.length === available`；`unknown.md` 排在最后且 `scanned.through` 为 `unknown.md`；模块 import 列表精确等于 `["./contracts.js", "node:crypto", "node:fs/promises", "node:path"]`，且不使用 `readFile`。

**执行命令与结果**：`npm run check`（`tsc --noEmit`）通过；`npx tsx --test test/memory-daily.test.ts` 7/7 通过；`npm test` 119/119 通过（本项新增 7）；`git diff --check` 无问题。评审脚本 `mem04-cursor-acceptance-v3.mjs` 的文件边界补写场景通过；其余三个场景在首次补写续页时即报 `stale`，符合本轮选用的重新检索方案。原脚本要求继续分页，因此这三个场景的原始 `pass` 字段仍为 false；已另行断言它们均以预期的 `MemoryError`／`stale` 原因退出，不能将其描述为原脚本四项全部通过。

**变异验证**（逐个回退修正后重跑本模块测试）：10 项修正中 9 项有回退即失败的证据（1、2、4、5、6、7、8、9、10）。缺陷 8 有两条守卫：已删除的 `covered` 文件不报 `stale`（回退后被捕获），以及扫描中消失的文件不进入 `covered`（回退后未被捕获，原因见下）。缺陷 3 的同调用内窗口同样未被捕获。缺陷 11 的两条守卫（`resumeAt` 回退起点、跳过已消费文件）回退后均被捕获。缺陷 12 采用提前报 `stale` 的方案：关闭该守卫后，04-D 在文件中间游标场景以 `no-error`／`stale` 差异失败；仅保留 `index > 0` 检查后，index 为零但带摘要的场景同样失败。恢复完整守卫后通过。

**未通过或未执行项**：

- 与归档任务（MEM-05）的联调未做，文件级恢复窗口（生成后未发布、发布后未确认、跨多个日期部分成功）属于 MEM-05 验收。
- 两个窗口只有代码路径、没有自动化证据，因此不计入通过结论：**缺陷 3 的同调用内窗口**（文件在读取之后、游标签发之前被追加）与**缺陷 8 的扫描中窗口**（文件在 `listFiles` 之后、`observe`/读取之前消失，即「不进入 `covered`」那条守卫）。两者都要求在一次调用内部、两个 I/O 步骤之间改变文件，而模块没有在该窗口注入失败的接口，回退后测试仍通过。跨调用的追加与跨调用的删除（缺陷 3、8 的主要场景）都有测试，回退即失败。
- 缺陷 11 的修复只覆盖**排在游标之前**的补写。游标之后新增的文件本来就落在剩余范围内，正常扫描会读到，不需要额外处理；但如果调用方在续页之间把 `from`／`through` 改窄到排除掉该文件，它不会被报告为 `unread`——范围是调用方给的，本模块不推断两次调用的范围关系。
- 跨进程单写者不支持（只保证单进程内串行，需要锁文件才能扩展），当前部署为单进程。
- 检索上限的实际耗时未在目标机器（4 核／4 GB）上标定，留待 MEM-08。

**兼容性变化**：新增模块，未修改 MEM-01 冻结的 schema 与错误码；`MemorySegment`、`dailyFileName`、`DAILY_DIRECTORY`、`UNKNOWN_DATE` 原样复用。`SearchCursor` 是模块内 Interface，不写入磁盘，可随实现调整（本轮已把 `listing` 换成 `covered`）。文件格式新增一条读取约束：块外内容不再被容忍——本模块此前未发布过，不存在需要兼容的旧文件。

**对下游的解锁条件**：MEM-05 可开始。归档批次的分段 ID 必须在重试间稳定（`<batchId>#<index>`），本模块按 ID + 发布身份判重；只有全部回执为 `published`／`duplicate` 才能推进连续游标；替代关系要显式写进分段（`supersedes`），本模块不做语义推断，且一次只能有一条记录替代同一条旧记录。检索工具由 MEM-07 包装，游标与 `unread` 原样交给模型。实施方案新增第 15 节记录本项结论，原第 15 节顺延为第 16 节。

## MEM-05：可恢复的增量归档任务

**目标**：把尚未覆盖的原始事件整理到每日记忆，压缩和任务执行不依赖归档成功。

**依赖**：MEM-01、MEM-04。**阅读入口**：实施方案第 8、9、11 节及第 12 节；`src/memory/contracts.ts` 中的 `ArchiveBatch`、范围与错误映射。

**工作与交付**：

- Archive Module 实现固定范围、提取、持久化候选正文、发布、确认的协议；Durable Adapter 用原生 Task 和 checkpoint 承载恢复。
- 提取器接受有界来源与取消信号，返回校验后的分段；区分自动事件归档和明确的永久偏好。来源读取复用原生 Entries，不建立通用 history 库。
- 合并 compaction 生效、业务完成、启动／跨日补齐的归档目标。通知只触发工作，持久化事实和补扫才决定覆盖是否完整。
- 连续游标仅在全部分段确认或持久化空结果后推进。多个日期部分成功保留逐段确认，不因失败重新提取已发布正文。
- 实现有界重试与失败诊断，执行归档时不占用主 agent 的工具队列无限等待。

**验收**：

- [x] 05-A：覆盖至 150 后压缩至 170，只处理新增 151–170；任务结束先覆盖至 200 后，旧压缩事件不会回退或重复归档。
- [x] 05-B：已有 B、检索结果、记忆投影不被当作新事件再次归档；无价值内容形成空处理回执，重启不反复提取。
- [x] 05-C：在提取完成后、正文保存后、一个日期写入后、全部写入但游标未提交时分别中断，恢复无已确认正文重复和来源缺口。
- [x] 05-D：模型失败、无效提取输出、文件写失败、取消分别留有可恢复结果；业务执行和已保存回复不因此重跑。
- [x] 05-E：时区边界、跨午夜任务和未知发生时间有确定归档规则；使用事件时间而非后台生成时间。跨日无消息不承诺午夜运行，下一次启动／请求能补齐。
- [x] 05-F：压力触发合并为有界目标，单 conversation 单归档写者；重启可从持久化目标补回漏通知。usage 和超时遵循 MEM-01 的已验证路径。

### 交接记录（2026-10-26）

已认领远端 #12。交付 `src/memory/archive.ts`、`src/memory/archive-task.ts`、`test/memory-archive.test.ts` 和 `test/fixtures/crash-archive.ts`。Interface、ArchiveState／ArchiveBatch schema 归属、来源范围、游标与取消语义见实施方案第 16 节；未改 MEM-01 冻结的 ArchiveBatch schema。

| 验收 | 实测证据 |
| --- | --- |
| 05-A | 200 条来源先覆盖 150，再只提取 151～170，再覆盖至 200；旧 170 目标返回无任务且不新增模型调用 |
| 05-B | cycle／working 投影、原生 summary／system 和 memory_search 结果不进入提取；原始事件的空结果重启后也不重复调用 |
| 05-C | extracted／saved／published／confirmed／before-cursor 五个同步点关闭重开；另在 extracted／saved／published／before-cursor 四点真实 SIGKILL。两日期分段均完整、ID 唯一、保存后的正文逐字复用且模型调用为零 |
| 05-D | 模型 error、非法来源引用、非法 JSON 三次后终止；文件错误保留正文，显式重试不再提取；abort／timeout 到达实际 provider；业务 requestId 与已保存 answer 在归档失败后仍复用 |
| 05-E | UTC 与 Asia/Shanghai 午夜边界得到不同正确日期；跨日批次分为两日期；缺失时间为 unknown，非法时间拒绝；重启补扫过去日期、完成事实和已发布 compaction |
| 05-F | 30 个并发触发得到同一后台 Task；每批最多 64 条；持久化分页补扫恢复漏通知；普通 idle 不等后台归档；超大来源拒绝且不推进；usage 归 app/archive，失败与重试均累计；超时最多 3 次 |

执行：`npm run check` 通过；`npx tsx --test test/memory-archive.test.ts` 18/18 通过；`npm test` 137/137 通过；`npm run build` 通过；`git diff --check` 通过。全部测试使用临时文件／SQLite 和 faux provider，无生产凭据。

兼容性与未覆盖项：新增 version 1 Document／Task，不改既有工具调用参数；初始化必须显式指定升级起点，当前拒绝 fork。模型响应未提交时进程被杀／取消的远端用量未知，不承诺精确计费；保存后不重复调用。真实模型提取质量、脱敏效果、目标 Linux 资源验收留待 MEM-08。MEM-07 仍需注册 Task、在启动／请求边界调用补扫、在有效压缩发布后提交目标，并适配外部事件时间；本项未修改运行入口。MEM-06 可独立继续，MEM-07 还须等待 MEM-06 完成。

## MEM-06：原生压缩接入与周期快照切换

**目标**：用底座压缩发布 B，保留合法 C，并解决长 run 中的状态连续性。

**依赖**：MEM-02、MEM-03。**阅读入口**：实施方案第 6、7、10 节及第 12.3、12.4、12.5、13、14 节；`src/memory/contracts.ts` 的 `CycleSnapshot` 编解码与 `workingAtBoundary`，`src/memory/working.ts` 的边界读取，`src/memory/context.ts` 的 `buildSnapshot`／`renderSnapshot`／`snapshotTextFor`。

**工作与交付**：

- 接入 `beforeCompact` 生成新 B：模型总结旧叙事与选中的流水，精确状态由边界版本确定性渲染。
- 固定来源、模型结果和应用格式；恢复复用已保存结果，正确记录摘要调用的失败与成功用量。
- 按真实模型窗口配置后台阈值；补充约 20 个完成用户请求后的评估。token 判定覆盖长 run，轮数不按工具或重试计数。
- 只在新 head 正式生效时确认周期切换、产生可恢复归档触发；不以 Task completed 直接推断发布成功。

**验收**：

- [x] 06-A：压缩前 A/B/C 与压缩后 A/新 B/保留 C 都能从持久化记录重建；system prompt 和工具关联完整，原始 Entries 未删除。
- [x] 06-B：切分边界前后分别更新 working，B 精确取边界版本，保留 C 携带之后修订；不因 head marker 的较大 ID 读取未来状态。
- [x] 06-C：一个长用户请求经历至少两次压缩，后续模型调用持续取得正确任务状态，无需下一条用户输入或模型主动补读。
- [x] 06-D：后台摘要入队、stale、失败、阻塞失败、重置交错与重启均遵循原生语义，不发布半成品 B，不同步等待无法前进的边界。
- [x] 06-E：叙事摘要超限／被截断时不作为完整 B 发布；精确状态超限不被静默概括。旧原生摘要有兼容读取路径。
- [x] 06-F：20 个短请求只评估不强压；一次大工具回合可先触发 token 压缩；同 requestId 恢复和 generation 重试不重复计数。
- [x] 06-G：实际适配请求比较表明周期内 A/B 稳定、C 仅追加；新 schema 加载明确记录为前缀变化，不能凭逻辑块相同宣称云端缓存已命中。

**交接记录（2026-10-27）**

基线：本项最初基于 PR #16 的分支开发；PR #16／#17／#19 全部合并后，已变基到 main（`eefe3aa`）并按下方命令重新验证，实施方案结论章节顺延为第 17 节。

交付物：

- `src/memory/compaction.ts`：compaction Adapter 与其 Interface——`createCompactionExtension(options)`（注入宿主 commit／摘要模型／budget／facts／maxAttempts／onResult，只注册 `hook(CompactionTask, { beforeCompact })`）、`nativeCompactionPolicy`／`compactionThresholds`、`confirmCompactionCycle`＋`createHarnessConfirmDeps`、`recordCompletedUserRequest`／`readCompactionTurnCount`、`evaluateCompaction`、`requestPrefixFingerprint`／`comparePrefix`、`publishedSnapshot`／`summaryBodyOfEntry`、`deriveCompactionKey`、`readCompactionSummary`。文件头写明输入、输出、错误、副作用与顺序；实现结论见实施方案第 17 节。
- `test/memory-compaction.test.ts`：06-A～06-G 共 14 个用例，全部用真实 `Harness` + Node SQLite + faux provider（主模型与摘要模型各一），临时目录。
- `docs/memory-and-context-design.md`：新增第 17 节（MEM-06 实现结论与压缩接入语义），原第 17 节顺延为第 18 节；文首状态与第 2 节同步 MEM-06 状态。

执行命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm ci` | 通过（基线分支无 `node_modules`，本次新装） |
| `npm run check` | 通过，无输出 |
| `npm run build` | 通过，无输出 |
| `npx tsx --test test/memory-compaction.test.ts` | 14/14 通过 |
| `npm test`（本机默认环境） | 178/182 通过、3 跳过；唯一失败为 `test/agent-vault.test.ts` 的「stdio MCP inherits proxy and CA settings…」，原因是本机环境变量 `SSL_CERT_FILE` 等 CA 变量污染（与本次改动无关，PR #16 review 已确认） |
| `env -u SSL_CERT_FILE -u SSL_CERT_DIR -u NODE_EXTRA_CA_CERTS -u CURL_CA_BUNDLE -u REQUESTS_CA_BUNDLE -u GIT_SSL_CAINFO -u AWS_CA_BUNDLE npm test` | 179/182 通过、3 跳过、0 失败（变基后基线 168 项无回归） |

逐项结论：

- 06-A：三轮对话内发生两次压缩并正确链接（第二周期 `sources.after` 等于第一周期 `sources.through`）；第一周期切分早于 working 更新，其 B 为初始 revision 1，第二周期 B 为边界 revision 2；压缩后请求带 `instructions` section、工具声明与 `<cycle-snapshot>`；被替换的原始 Entries（含锚点）仍可经 conversation entries 查到，未删除；`app/summary` 有记账且原生键 `summary/summary-1` 缺失；阻塞路径以 `outcome.result.entryId === head` confirm 为 `switched`，且返回前已持久化的结果与 head 正文逐字一致。
- 06-B：边界前更新 rev 2、保留 C 内更新 rev 3，新 B 的 `baseline.revision` 为 2、`boundary.anchor` 为 rev 2 的锚点；rev 3 锚点保留在活跃 C 中且仍是当前状态；head marker 的 id 大于保留条目（含 rev 3 锚点），边界读未被其拉向未来。
- 06-C：单个用户请求内由工具回路（大工具结果＋同 commit 的 working 检查点）真实触发至少两次阻塞压缩——不是用同一 requestId 的 generation 续跑冒充；后续模型调用的 transcript 含新 B，最终 B 的 baseline 来自请求内的检查点（revision ≥ 3），全程无下一条用户输入。
- 06-D：后台压缩在 submission `queued` 时 confirm 为 `pending`，`done`＋head 后为 `switched`；摘要模型连续 error 用尽 2 次尝试后 decline、无新 head、旧 B/C 不变、失败尝试的 usage 已记入 `app/summary`、失败事实（`model-failure`、attempts 2）已持久化到结果家族；reset 越过的手动压缩 submission 为 `unanswered`/`stale`，confirm 为 `not-published`，head 仍为 `pi.reset`；关闭重开 Harness（含恢复相同的 compaction settings）后，submission 路径仍 confirm 为 `switched` 且 entryId 相同；阻塞路径在 06-A 中以 entryId＋head 复查。
- 06-E：摘要 `stopReason: "length"`、叙事超 `narrativeTokens`（11,500 字符 ≈ 3,286 token > 3,072）、摘要返回 toolCall，三者都 decline 不发布且失败已持久化；精确状态超限（满格任务＋32 条满格偏好使 `renderSnapshot` 抛 `budget-exceeded`）decline 且存储状态逐项不变、未被概括；旧原生摘要（未装 Adapter 先行压缩）经 `publishedSnapshot` 读得 `undefined`，装上 Adapter 后的下一次压缩把原生叙事折入摘要来源，新快照 `sources.after` 为 `null`。
- 06-F：20 个不同 requestId 依次计数且只在第 20 个 `shouldEvaluate` 为真，同 id 重放（含第 20、7 个）不重复计数；`evaluateCompaction` 在低 token＋20 轮＋无可压缩内容时为 `none`、有可压缩内容时为 `rounds`、单回合大 token 时为 `token`（blocking／background 两档）；计数 API 只由「完成的用户请求」调用，generation 重试不调用它、恢复重放同一 requestId 由回执去重——测试名与注释已写明该机制。`nativeCompactionPolicy` 在 200,000 窗口下派生 keepRecent 16 Ki／background 48 Ki／阻塞 184,000／后台 134,848，非法窗口关系显式抛 `MemoryError`。
- 06-G：指纹按块隔离，工具名集合新增一个即报告 `changedBlocks: ["tools"]`；同周期内两次适配请求（经 `nativeCompactionPolicy` 派生的 settings）的 instructions／工具指纹不变，后一请求的会话消息以前一请求为字节前缀（C 仅追加）。逻辑块相同不等于缓存命中，命中仍标待验证。

未覆盖／受限：

- 已保存结果的复用：key 派生的稳定性与「链接周期不复用」由单元用例（06-D 的 key 用例）与「返回前先持久化」的记录断言覆盖；没有单独构造「任务在持久化后、发布前崩溃并重跑 hook」的端到端场景，该崩溃窗口的复用行为未实测。
- 边界 anchor 规则的实测后果：被替换范围有状态但无 anchor 时 decline 为 `not-covered`（含探针观察：阻塞压缩消耗 anchor 后紧接着的后台压缩会因此 decline），这是规则本身而非故障，已写入实施方案 17.3；MEM-07 接线时应保证周期内 working 更新持续产生 anchor。
- 真实模型摘要质量、目标提供商云端缓存命中、真实窗口阈值标定与资源测量：待验证（MEM-08），本项不宣称通过。
- 本机 CA 环境变量污染 `test/agent-vault.test.ts` 既有用例（见上表），未改动该测试。
- 尚未接入运行中的 agent：extension 已导出但未在 `src/agent.ts` 注册（MEM-07 负责组合）。

对下游的解锁条件：MEM-06 已完成。MEM-07 接线时：压缩 settings 用 `nativeCompactionPolicy(budget, reserveTokens, contextWindow)` 派生；周期切换与归档触发只认 `confirmCompactionCycle` 的 `switched`（两条路径），不认任务终态；轮数计数只在用户请求完成时调用 `recordCompletedUserRequest`；摘要结果与失败事实查 `personal.compaction.summary` 家族（经 `readCompactionSummary`），不要直接读文档。

## MEM-07：接入请求生命周期及记忆工具

**目标**：把已验证 modules 接入应用，保持原请求、工具和投递生命周期。

**依赖**：MEM-02～MEM-06。**阅读入口**：实施方案第 4、6、9、11 节及第 12 节；`src/agent.ts`、`src/tools.ts`、`src/config.ts`、现有请求／恢复测试和 README。

**工作与交付**：

- 在组合入口构造 modules、注册 native tools 和 hooks；主应用只依赖统一接入入口，业务算法留在各 module。
- 接入原 requestId 检查、初始 B／必要投影、模型输入提交、重置后初始化、归档补扫及关闭生命周期。
- 暴露 `memory_search`／`memory_read`，绑定宿主根目录和来源身份；设置结果与一次请求累计检索预算，工具结果进入 C。
- 补充必要配置、错误映射及可观测性。普通记忆业务错误不伪装成 Session 永久失败；真正的底座状态失败继续退出恢复。
- 保留既有 `MEMORY.md` 语义；首次升级设置归档起点并保存迁移记录，原未完成请求继续原输入，旧摘要和长期事实可读取。更新 README 与现有 MVP 的范围说明时清楚标识新能力的实际状态。

**验收**：

- [x] 07-A：同 requestId 恢复不新增投影／模型调用／归档触发；投影已写、输入未提交时找回原文。相同文本不同 requestId 仍是独立请求。
- [x] 07-B：新用户请求、工具后续、重启恢复和显式重置后的首次模型调用都包含有效系统提示与必要 working；禁止靠无记录 hook 注入达标。
- [x] 07-C：检索结果有来源、分页、未扫描范围和错误语义，累计预算生效；既有快照已包含同版内容时不重复加载整份工作台或日记。
- [x] 07-D：归档失败时正常聊天仍可完成并保存回复；投递失败只重投原回复，不重做记忆更新或业务执行。
- [x] 07-E：从已有 SQLite、旧 compaction、非空 MEMORY.md 和未完成工具调用升级，数据保留且恢复语义不变；首次启动不触发无限历史回填。
- [x] 07-F：配置参数有 schema 和有效范围；缺失／损坏／超限与正常空状态分别处理。关闭会停止实际 I/O 并保留任务恢复状态。
- [x] 07-G：`src/agent.ts` 不出现摘要提示、Markdown 拼接、归档游标算法或私有 SDK 导入；Telegram、inbox、投递 modules 不导入 memory 内部实现。

**交接记录（2026-10-27）**

基线：基于 main（`25fb280`，MEM-01～MEM-06 全部合并后）在分支 `feat/memory-integration` 开发；基线全量测试为 182 项 179 过、3 跳过、0 失败（干净环境）。

交付物：

- `src/memory/integration.ts`：组合入口与其 Interface——`createMemoryIntegration(options)` 构造 `MemoryIntegration`：`extensions()`（working 工具、检索工具、压缩 Adapter、归档 Task 的固定注册顺序）、`initialize()`（迁移记录＋归档起点＋补扫）、`prepareRequest()`（按持久化回执分类 replay／recover／新请求，投影复用与规划执行）、`afterRequest()`（计数、评估、补扫）、`resetConversation()`、`close()`、`memoryAppError()`／`isMemoryError()`。文件头写明输入、输出、错误、副作用与顺序；实现结论见实施方案第 18 节。
- `src/memory/memory-tools.ts`：原生检索工具 `memory_search`／`memory_read` 与 `memoryToolsExtension`：宿主绑定 Daily store 根目录与预算；结果带来源（date＋id）、分页游标（`mc1.` 前缀，正文可见）、未扫描范围与预算余量；零命中、目标不存在、损坏文件、预算超限四种语义分开；单请求累计预算按持久化工具结果重算。
- `src/config.ts`：新增 `readMemoryConfig(env)` 与 `MemoryConfig`：`MEMORY_ENABLED`（默认开）、预算六项覆盖、评估间隔、reserve、时区（经 `eventDate` 校验）、归档超时；每项有范围校验。`readConfig` 的返回结构未变，记忆配置由 `agent.ts` 结构化读取，避免破坏既有测试对返回字面量的标注。
- `src/agent.ts`：只经组合入口接线——instructions 提取为常量并原样传入、记忆扩展在 MCP 之前注册、压缩设置由 `nativeCompactionPolicy` 派生（仅启用时）、`reply()` 在 resume 后 prepare、完成回执后 afterRequest、`MEMORY_*` 错误透传、新增 `reset()`、关闭先关组合入口。`MEMORY_ENABLED=0` 时与接入前逐项一致。每日 store 根按实施方案第 3 节取数据根目录（`DATA_DIR/memory/daily`）。
- `test/memory-integration.test.ts`：07-A～07-G 与组合接缝共 15 个用例，全部用真实 `Harness` + Node SQLite + faux provider，分别经完整 `openAgent` 与 raw 组合装配两种方式，临时目录。
- `docs/memory-and-context-design.md`：新增第 18 节（MEM-07 实现结论与接入语义），原第 18 节顺延为第 19 节；文首状态与第 2 节同步 MEM-07 状态。当时的项目说明与 `.env.example` 同步了新能力与配置说明；当前文档入口见 [文档索引](README.md)。

执行命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过，无输出 |
| `npm run build` | 通过，无输出 |
| `npx tsx --test test/memory-integration.test.ts` | 15/15 通过 |
| `env -u SSL_CERT_FILE -u SSL_CERT_DIR -u NODE_EXTRA_CA_CERTS -u CURL_CA_BUNDLE -u REQUESTS_CA_BUNDLE -u GIT_SSL_CAINFO -u AWS_CA_BUNDLE npm test` | 197 项：194 通过、3 跳过、0 失败（基线 182 项无回归，新增 15 项全过；本机默认环境的既有 CA 污染失败见下） |

逐项结论：

- 07-A：同 requestId 重放在进程内与跨重启两种情况下 Entries、模型调用次数、归档状态逐项不变；投影已写、输入未提交的窗口用 fake-timers 冻结在提交边界后重开应用，原请求按原 requestId 完成且只写一份投影（投影复用按 `memory:projection:<requestId>` 的持久化幂等键判定）；相同文本不同 requestId 各自独立计数与回执。
- 07-B：新请求、工具后续（含 `working_update` 后）、关闭重开后的恢复请求、显式重置后的首个请求，transcript 均含 instructions section 与 `<cycle-snapshot>`；周期内 working 修订只以修订投影进入，不重发整份 B；`prepareRequest` 的 replay／recover 分类保证恢复不重做投影。facts 变化（instructions 改版）优先走压缩采用新 facts，无可压缩内容时显式重启周期（`facts-restart`），新 B 的摘要取新版摘要、旧周期以 `pi.reset` 结束（07-B/11 用例）。
- 07-C：搜索结果带 date＋id 来源、游标（同游标续页不重不漏）、`scannedFrom`／`unread`／`available`；目标日期无文件是「不存在」成功结果、损坏文件是 `MEMORY_CORRUPT_STATE` 错误结果、零命中是带扫描信息的成功结果，三者互不混淆；单结果截断带显式标注；累计预算跨重启按持久化工具结果重算并在超限时返回 `MEMORY_BUDGET_EXCEEDED`（07-C 三个用例）。快照已含同版 working 时不写修订投影（07-B 断言）；日记从不自动整份载入，只经检索按需进入 C。
- 07-D：提取模型持续故障时归档失败状态持久化、游标不前进，两条聊天请求照常完成并保存回复，原请求重放不产生新投影、模型调用或归档工作（07-D 用例）；投递失败只重投原回复的语义由既有 inbox／boundaries 用例继续覆盖，本项未改动投递路径。
- 07-E：手工构造的旧库（旧原生 compaction 摘要、非空 MEMORY.md、旧每日事实、未完成的 write 工具调用）在首次 MEM-07 启动后：原生摘要保持 narrative 可读、MEMORY.md 逐字不变、旧事实可检索、未完成请求按原输入以原 requestId 完成；origin 冻结在升级链尾，归档范围为空、每日目录无新文件（07-E 用例）。
- 07-F：配置默认值、逐项覆盖、五类非法值（非布尔、零、负数、超上限、非法时区）与错误消息内容均断言；计划级拒绝以 `MEMORY_BUDGET_EXCEEDED` 抛出、cause 保留冻结业务码、请求不被 admission（07-F/11 用例；应用 instructions 约 243 token 低于配置下限 256，故在 raw 装配层以更长 rules 文本触发同一规划分支）；损坏每日文件的处理见 07-C；关闭后 `prepareRequest` 以 `MEMORY_CANCELLED` 拒绝，重开后轮数、归档游标、快照 baseline 全部从持久化状态恢复（07-F 用例）；`MEMORY_ENABLED=0` 时无记忆工具注册、无投影、无归档状态（07-F disabled 用例）。
- 07-G：静态检查用例断言 `agent.ts` 源码不含摘要系统提示字面量、`memory/daily` 路径拼接、`archivedThrough` 游标算法与 `@earendil-works/pi-durable/dist` 私有导入，且只经 `createMemoryIntegration` 接入；telegram／inbox／telegram-delivery 三个 module 不含 `memory/` 导入（07-G 用例，随全量测试常跑）。

接缝用例（无编号，属组合验证）：2 个完成请求触发评估 → 原生压缩经 Adapter 发布新 B 并成为 head（摘要用量记入 `app/summary`）→ 下一请求边界确认切换并把覆盖范围交给归档、游标前进；全程只用请求边界的持久化补扫，无测试侧捷径。

未覆盖／受限：

- 真实模型摘要与事件提取质量、真实窗口阈值标定、目标提供商云端缓存命中：待验证（MEM-08），本项不宣称通过。
- Telegram 层没有 `/reset` 命令：显式重置只在组合层（`app.reset()`）提供并验证，未接 Telegram 命令面。
- 检索累计预算的单请求扫描上限为 1,000 条工具结果 Entry，超过按已扫描部分计数（病理量级），未单独构造用例。
- working 同版冗余：`working_update` 后、下一次修订投影写入前，同版内容可能以修订形式与 B 并存一次；内容相同、有界。组合层按第 14.5 节接缝只认已记录投影判定 `workingInContext`，不解析工具结果正文。
- 摘要「已持久化未发布」崩溃窗口的复用沿用 MEM-06 交接结论（key 单元覆盖，无端到端场景），本项没有新增。
- 本机默认环境的 `test/agent-vault.test.ts` CA 污染失败为既有问题（PR #16 review 已确认），本次未改动该测试；干净环境下全量 0 失败。

对下游的解锁条件：MEM-07 已完成。MEM-08 做真实模型端到端验收时直接使用运行中的 agent：检索工具名为 `memory_search`／`memory_read`，预算与评估间隔经 `MEMORY_*` 环境变量调整（见 `.env.example`），关闭整套能力用 `MEMORY_ENABLED=0`；周期切换与归档状态只认持久化事实（`personal.cycle` 投影、`personal.archive` 文档与原生 Task），不要用日志推断。

## MEM-08：故障恢复、质量与资源验收

**目标**：证明整套方案在持续线性对话和故障窗口中有效，区分机制验证与真实模型效果。

**依赖**：MEM-07。**交付**：`docs/memory-verification.md`，记录环境、场景编号、执行结果、脱敏证据和未覆盖项；无需复制架构定义。只有实现开始后才创建该验收记录。

**验收**：

- [x] 08-A：使用确定的跨日 trace，至少 40 个完成用户请求、3 次有效压缩，包含任务暂停／继续、偏好纠正、工具失败与修正。每次模型请求的 A/B/C、head/cutoff、working revision 可核对。
- [ ] 08-B：依次注入请求投影、working commit、compaction 发布、Markdown 替换、归档确认和回复保存窗口的进程中断，恢复后的状态、文件和调用计数符合各 issue 的验收。采用同步点，不用任意 sleep 猜测崩溃时刻。**状态：窗口 1～5 通过；窗口 6 发现缺陷 D-1（回复已保存未计数时被杀，该轮计数永久滞后一轮），待修复决策后复验，见验收记录。**
- [x] 08-C：对于每个来源范围，能判定待处理、已归档或已确认无值得保留内容；不跨过失败缺口。文件分段可回到原始证据，摘要中的未知不会变成成功。
- [x] 08-D：纠正／撤销跨多个压缩周期和重启后仍有效；每日旧记忆不会把已撤销偏好重新激活。
- [x] 08-E：离线比较真实 provider Adapter 的请求体，确认未变化前缀；真实模型样本另测目标、约束、未完成状态的保留和关键词回忆质量。云端缓存验证使用独立授权测试环境，未知 usage 标未知。**状态：已于 2026-10-28 用 DeepSeek（deepseek-v4-pro，凭据经 surrogate 注入）经真实集成链路补测通过——保留质量良好、云端缓存 28 次调用 27 次命中；遗留发现 F-1（working_update 被 evidence 校验拒绝、根因未定）与 F-2（年份捏造），详见验收记录 08-E 节。其他 provider 的真实模型质量未测。**
- [x] 08-F：测量典型、工具密集、跨日恢复下的输入量、摘要大小、归档滞后、扫描量、延迟、内存及磁盘增长。对 4 核／4 GB Linux 环境给出实际峰值和明确配置上限，不能仅以 Windows 离线测试宣称部署通过。**状态：双环境实测完成——本机（2 核／8 GB）与目标服务器（腾讯云 4 核／8 GB，issue 规格写作 4 核／4 GB，实际提供 4 核／8 GB；峰值 RSS ≈136 MiB 远低于 4 GB，差异已在验收记录注明），输入量逐项一致、建成磁盘逐字节一致，数字见验收记录 08-F 节。**
- [x] 08-G：全量类型检查、测试和构建通过，既有请求去重、取消、工具重放与逐段投递测试无回归；真实服务／目标主机未验收时明确保留状态。
- [x] 08-H：依赖审查确认 Context 无 I/O、Daily Memory 无 Harness、Working 不管理底座执行状态，SDK 接入集中在 Adapter；不为解耦额外建立事件总线、数据库服务或通用插件框架。

### 交接记录（2026-10-28）

本地验收已执行完毕，完整记录见 `docs/memory-verification.md`；本 issue 按发布门槛保持未完成（08-B 缺陷待决策、08-E 待环境）。

- 通过：08-A（44 请求跨日 trace，两次全新运行逐条全等；验收初期 A=0 断言失败经定位为记录器计量口径问题——pi-ai SystemMessage 的提示词在 `sections` 中、`content` 为空，改按渲染后的有效系统提示计 A 后通过，首次调用系统提示完整，非产品缺陷）、08-C、08-D、08-G（干净环境全量 208 项 205 过／0 失败／3 跳过，基线 197 项无回归；check／build 通过）、08-H。
- 未通过：08-B 窗口 6 缺陷 D-1——回复已保存、`afterRequest` 未运行时进程被杀，重投递按 replay 跳过计数，该轮 turn 计数永久滞后一轮；回复与状态本身一致。用例以断言钉住当前行为；修复涉及 MEM-07 冻结的 07-A replay 语义，留待决策，不在验收内改。
- 补测完成：08-F 目标环境（腾讯云 4 核／7680 MB，最终版同步后实测）——三负载输入量与本机逐项一致（典型 98,735 tokens、工具密集 17,280 tokens），延迟更低（典型均值 7.4 ms、工具密集 15.7 ms），峰值 RSS 142,721,024 B，跨日恢复建成磁盘与本机逐字节一致（4,408,192 B）；服务器全量 208 项 197 过／0 失败／11 跳过，验收测试 11/11。服务器初装 Node v24.9.0 缺 `setGlobalProxyFromEnv` 致 agent-vault 测试导入期失败，升级 v24.22.1 后消失，部署应钉死 Node 版本下限（见验收记录 08-G）。
- 已补测：08-E 真实模型与云端缓存——Timothy 提供 DeepSeek 凭据后，于 2026-10-28 经真实集成链路（deepseek-v4-pro、10 轮植入式对话、7 次压缩发布）补测通过：目标／约束／进度／代号／纠正保留良好，缓存 28 次调用 27 次命中（cacheRead 约 87%）；脚本 `scripts/mem08-e-live.mts`。遗留发现：F-1 `working_update` 被 evidence 校验反复拒绝、working 结构化状态未落盘（根因未定，需立项排查）；F-2 摘要／归档把未给出的年份捏造为 2025（应为 2026），且同文件内不一致，建议后续给摘要／提取加日期约束。其余 provider 的真实模型质量仍未测。
- 已修复（2026-10-28，验收后经 Timothy 指示）：F-1 根因为 entry id 不出现在模型可见 transcript 中、模型只能猜 id——`working_read` 现列出最近用户条目 id 供引用、错误结果附 id 列表供重试（02-H 钉住）；F-2 已给摘要与归档提取提示加日期保真规则（06-H／05-H 钉住）。用 deepseek-flash 同脚本复跑 13 项判定全过，working 落盘至 revision 8、三处均无捏造年份；全量 211 项 208 过／0 失败。
- 跳过清单对账：本机 3 项跳过为 2 项 Docker Compose 不可用 + 1 项 env 显式 opt-in；目标服务器 11 项与「以非 root 用户运行（10 项 root 门控跳过）+ Compose 可用（2 项照常运行）+ 1 项 opt-in」的组合逐项吻合（过／败／跳过三数均可对平），补测时以服务器端 Compose 与运行 uid 复核即可。
- 新增文件：`test/memory-verification.test.ts`、`test/memory-verification-crash.test.ts`、`test/fixtures/crash-compaction-publish.ts`、`scripts/memory-resource-measure.mjs`、`docs/memory-verification.md`；未修改任何产品代码。

## 发布与交接门槛

本地交付要求 MEM-01～07 的本地条件和 MEM-08 的离线故障场景全部通过。真实摘要质量、目标提供商缓存与 Linux 资源测量分别标记“通过／失败／待验证”；缺少环境不伪造通过。

每个 agent 的交接必须提供：修改的 Interface 与文件、已通过的验收编号、测试结果、恢复或升级限制、下一项可开始的依赖。业务行为仍有未验证的关键顺序时，issue 保持未完成，不以“代码已提交”代替验收。
