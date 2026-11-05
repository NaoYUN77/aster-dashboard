# ADR-0016：用户画像暂存 working memory，从每日归档提取

- **状态**：Accepted
- **日期**：2026-10-29

## 功能实现

用户画像是一组有界的当前事实，描述这个用户，而不是当前这一次任务。每条有标识、正文、类别、指向每日归档分段的证据，以及宿主写入时间。

事实来自长期记忆：归档任务写下的每日对话日志，路径是 `DATA_DIR/memory/daily/YYYY-MM-DD.md`，续页是 `YYYY-MM-DD-2.md` 到 `-9.md`。观察期内，画像存在 working 文档 `personal.working`。这份文档可按条目回绕；压缩时基线进入周期快照，所以压缩不会把画像从之后的请求里拿掉。

模型用 `working_read` 读画像，用 `working_update` 的 `profile.put` 和 `profile.remove` 改它。画像和任务、偏好一起出现在周期快照（B）和周期内修订（C）里，占用同一份 `snapshotTokens`。从每日分段生成草稿有单独的函数，本轮不调用模型，也不在归档任务里自动写回。

## 功能取舍

选定：working memory 作为存储和注入点，内容从每日日志提取。存储文档是 `personal.working`，注入走它在周期快照里的基线。

拒绝的方案：

- **只把 working memory 当作画像来源。** working 背后的对话原文会在压缩时离开活跃上下文。用来源的话，画像会跟着被压掉。
- **写进 system prompt。** system prompt 是稳定规则，运行时不能按新的每日日志更新。

## 取舍理由

每日日志在压缩之后还在，所以来源放在那里。画像又必须在之后的请求里被模型看见，所以注入点放在会进入周期快照的 working 基线，而不是只留在文件里等检索。

这是观察期的做法。代价如下；出现这些情况就另写一篇 ADR，不在本篇里改决定：

- **快照额度。** `MEMORY_BUDGET_DEFAULTS.snapshotTokens` 是 `6 * 1024`。画像、任务和偏好共用这一份额。超出时计划返回 `budget-exceeded`，不截断基线。若画像经常把这一份额占满，任务或偏好因此进不了快照，就换注入点或缩小画像。
- **陈旧。** 每日日志会继续增长，working 里的画像不会自动跟着变。条目有 `updatedAt`，渲染进快照时和状态自身的写入时间一样被去掉。若模型反复按过时画像行动，就改提取频率或改权威存储。
- **提取模型的费用。** 仓库没有记录单独的画像提取价格。本轮的提取函数不调用模型。若以后要调用，费用仍是未记录项，不能在本篇补数字；费用或调用方式超出已落地的归档提取所能承受的范围时，重新决定。
- **观察期结束。** working 的生命周期跟任务和压缩走。若这不适合作为画像的权威存储，就另选存储，而不是继续往这份文档里加字段。

## 怎么做

1. **Schema。** `src/memory/contracts.ts` 的 `WorkingStateSchema` 增加 `profile`。每条是 `ProfileItemSchema`：`id`、`text`（上限 `MEMORY_LIMITS.text`，400）、`category`（上限 `MEMORY_LIMITS.category`，64，与标识符相同）、`evidence`、`updatedAt`。`evidence` 至少一条、至多 `MEMORY_LIMITS.sources` 条，每条是 `DailySegmentRefSchema`：`date`（`YYYY-MM-DD` 或 `unknown`）、分段 `id`、`page`（1 到 `DAILY_MAX_PAGES`）。条数上限 `MEMORY_LIMITS.profile` 为 32，与偏好相同。模型可见草稿是 `ProfileItemDraftSchema`，不含 `updatedAt`。
2. **迁移。** `personal.working` 的 `defineDoc.version` 升到 `WORKING_DOC_VERSION`（2），`migrateWorkingDocument` 给版本 1 且没有 `profile` 的文档补上 `[]`。JSON 里的 `version` 仍是 `MEMORY_SCHEMA_VERSION`（1），因为这个字面量还用于快照、分段和回执。当前结构版本却缺 `profile`，按 `corrupt-state` 拒绝，不补默认值。周期快照的版本不升：`decodeCycleSnapshot` 和 `snapshotOfProjection` 对缺少 `baseline.profile` 的旧块补 `[]`（`migrateStoredSnapshot`）。未知快照版本仍是 `unsupported-version`。
3. **写入。** `src/memory/working.ts` 的 `project` 接受 `profile.put` 和 `profile.remove`，经 `working_update` 暴露。校验、`expectedRevision` 和拒绝语义与偏好一致：证据不能空；日期必须是真实日历日（`dailyFileName`，非法如 `2026-02-31` 为 `invalid-input`）；同 id 覆盖；删除未知 id 为 `invalid-input`；达到 32 条为 `invalid-input`，不删已有条目；无业务变化不递增 revision，重复放入同一事实不改 `updatedAt`；清理任务不清理画像。画像证据不解析成会话 Entry。提交 `profile.put` 时，在回执重放判断之后调用注入的 `resolveProfileEvidence`：`requireCurrentProfileEvidence` 用 `readSegment` 核对 `date`、分段 `id`、`page` 对应的记录存在且 `supersededBy === null`。缺失、页码不对或已替代都是 `missing-evidence`，本次提交不写状态。已提交操作的重放直接返回原回执，不再解析证据。Working 模块不打开每日文件；生产环境的工具和归档任务传入同一个解析器。没有解析器的 `profile.put` 同样是 `missing-evidence`。
4. **读出与快照。** `working_read` 的文本列出画像的 id、正文、类别和 `date/id p页`。`baselineOf` 去掉状态和条目的 `updatedAt` 后，`renderSnapshot` 与 `revisionWrite` 把画像放进 `<cycle-snapshot>` 和 `<working-revision>`。这两处写入仍按 `snapshotTokens` 拒绝超限，不截断。
5. **提取何时发生。** 不扩展归档模型的输出 schema，也不再发一次模型调用。归档模型已经把用户要求标成 `user-requirement`；再开一轮提取会多一次没有记录价格的调用，并改掉现有提取契约。确定性的 `extractProfileDrafts` 就用这个分类。归档任务在每日分段全部发布之后、读出仍当前的分段（`publishedProfileDrafts`，文件读取在 commit 之外），然后在推进 `archivedThrough` 的同一次 `runtime.commit` 里调用 `applyWorkingUpdateInTx`。任务回调不能返回工作状态回执，所以不另开 `Session.commit`。同一次提交里画像和游标要么都落盘，要么都不落盘；提交前崩溃则重跑只写一次。`profilePutChangesWithinLimit` 只放入放得进 32 条的新事实，已有 id 的替换始终保留，超限的新事实留在每日日志里，不删已存条目，也不挡住游标。操作标识是 `profileOperationId(batch.id)`（`pf.` 加批次 id 的 sha256 前 16 位）。同一标识再次提交返回原回执，不递增 revision。正文超过 400 字的分段不截短。`profile: false` 跳过这一步，每日日志和游标照常。`MEMORY_ENABLED=0` 时不创建归档任务，工具也不带解析器。
