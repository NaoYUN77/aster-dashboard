# ADR-0015：旧版画像字段导致 working memory 损坏态（MEMORY_CORRUPT_STATE）

- **状态**：Accepted（仅缺陷记录；不改变现有 working memory schema 决定）
- **日期**：2026-10-31
- **功能**：working-memory
- **格式**：MADR 精简版

## 上下文

2026-10-31，生产会话（conversationId=1）经 Telegram 的请求都收到通用失败回复「本次处理未能完成。已执行的操作可能仍然生效，请先核对结果。」日志为 `Agent request failed`，`errorCode=MEMORY_CORRUPT_STATE`，异常 cause 是「Stored memory value does not match its schema」，涉及的 requestId 为 `telegram:8396905983:976153046`、`...047`、`...048`。同期 MITM 出站代理为 0 流量，日志中没有 DeepSeek HTTP 调用，也没有 `SessionFailed` 或超时。失败发生在模型调用之前，DeepSeek 控制台余额与本次故障无关。

本仓库把当前业务状态存在 `personal.working`，把周期快照的基线写进压缩后的持久化历史。两者读取时都按 TypeBox schema 严格校验，对象的 `additionalProperties` 为 `false`：未知字段是错误，不是可以忽略的噪声。

2026-10-29 起，未合入 `main` 的 PR #44 分支 `cursor/user-profile-working-memory-94a5`（提交 `5183893`）在 working state 与 snapshot baseline 上增加 `profile` 字段，并把 working 文档版本升到 2。该分支的迁移只处理「旧文档缺 `profile` → 补空数组」，不处理「当前代码不认识已有的 `profile`」。`main` 从未包含这个字段。

## 决策驱动因素

1. 持久化的工具参数和状态是跨版本契约；旧值必须显式解释，不能用默认值掩盖缺失或未知字段。
2. 当前 schema 的 `additionalProperties: false` 是有意严格。读取时静默剥离字段会改变已存储值的含义。
3. 本次目标是恢复服务；未评审的 schema 变更、迁移和部署不在范围内。
4. 结果未知的操作不重放；只清理已确认失败的投递记录，不重新执行业务请求。
5. 改写持久化状态前先备份。

## 备选方案

### 方案 A：读取时剥离未知的 `profile` 字段

- 优点：不改存储即可让旧数据重新可读，恢复最快。
- 缺点：读取契约从「严格拒绝未知字段」变成「按已知字段裁剪」，需要新的解析路径和测试；同一份数据在不同版本下会被解释成不同值。该改动曾讨论，后按 Jay 口头要求停止。

### 方案 B：一次性迁移，把旧数据改写成当前形状

- 优点：数据方向明确，迁移完成后不需要长期兼容分支。
- 缺点：需要版本号、迁移记录，以及对未完成调用和回绕历史的兼容处理；写入不可逆。本次没有采纳，也不把「恢复用户画像」当成本文档要解决的问题。

### 方案 C：重置损坏会话的活跃上下文与 working 状态（采纳）

- 优点：不改代码、不部署，能立即恢复服务；持久化历史 entries 仍然保留，可追溯。
- 缺点：该会话的活跃上下文重新开始，working 中的画像内容丢失；只对已确认损坏的会话有效，其他会话若含同类数据仍会失败。

### 方案 D：回滚镜像或部署旧代码

- 未采纳。当前镜像并不写入 `profile`，回滚不能删除已经落盘的字段，还会连带回退无关修复。

## 决策

2026-10-31 的生产处置采用方案 C：备份后重置 conversationId=1 的活跃上下文，把损坏的 working 恢复为初始状态，清除已确认失败的 inbox 记录，然后用同一镜像短重启。没有部署、没有改代码、没有回滚。

本 ADR 只记录缺陷与处置，不把「兼容 `profile`」当作已接受的新需求，也不修改 schema、不增加迁移。将来若要恢复用户画像，需要单独 ADR，明确旧数据方向、未完成调用的兼容方式以及写入幂等性。

## 后果

- conversationId=1 的活跃上下文以 `pi.reset` entry 686 为新 head；686 之前的 entries 仍持久化，可追溯。
- `personal.working` 从旧 v2（含 `profile`）改写为 v1 `initialWorkingState`；画像内容只保留在备份里。
- `inbox.failures` 中三条失败记录（`telegram:8396905983:976153046/047/048`）被清除；没有重跑对应业务请求。
- 同一镜像短重启后 Telegram 恢复；未部署、未改代码、未回滚。
- 若其他会话也写入过含 `profile` 的 working 或周期快照，`main` 仍会以同一错误失败；本文档不承诺自动修复，需要另行决策。
- PR #44 分支另起草了根目录的 ADR-0015（用户画像），未合入 `main`。若该分支重新合入，需要先解决编号与本记录的重叠，不能直接复用 0015。
- 本文档引用的行号以 `main` 提交 `13d5623` 为准。

## 分阶段决策与缺陷历史

### 2026-10-31：MEMORY_CORRUPT_STATE 缺陷记录

- 相关 spec：无独立 spec。缺陷由 Operation 的生产日志定位，处置记录见本节；没有新增 spec 文件。
- 决策与取舍：采用方案 C（重置损坏状态），放弃方案 A/B/D；范围只到恢复服务，不含兼容读取或迁移代码。

- 相关缺陷：

  **表现**：Telegram 返回通用失败句；日志为 `Agent request failed: telegram:8396905983:976153046 (MEMORY_CORRUPT_STATE)`（047、048 同类），cause 为「Stored memory value does not match its schema」。没有 DeepSeek HTTP 调用，没有 `SessionFailed` 或超时，MITM 同期 0 流量，说明请求没有打到模型。重启不改变结果：同一镜像重启后，首个请求仍在同一步失败，直到清理持久化状态。

  **链路**：

  ```text
  serveTelegram (src/telegram.ts:95)
    → 待处理 job 调用 reply (src/telegram.ts:114)
    → agent.reply (src/agent.ts:165)
    → memory.prepareRequest (src/agent.ts:173 → src/memory/integration.ts:255)
    → #prepareRequest (src/memory/integration.ts:266)
    → scanCycle (src/memory/integration.ts:297) / readWorking (:298)
    → publishedSnapshot (src/memory/compaction.ts:505)
    → snapshotFromHead → decodeCycleSnapshot (src/memory/contracts.ts:444)
    → assertSchema(CycleSnapshotBodySchema) (src/memory/contracts.ts:461)
    → MemoryError("corrupt-state")「Stored memory value does not match its schema」(src/memory/contracts.ts:621)
    → appCode MEMORY_CORRUPT_STATE (src/memory/contracts.ts:593)
    → memoryAppError (src/memory/integration.ts:135)
    → failureCode (src/telegram.ts:84)
    → 通用失败句 (src/telegram.ts:127)
  ```

  `scanCycle` 先于 `readWorking`。活跃上下文里有带 `profile` 的周期快照时，通常先失败在 `decodeCycleSnapshot` 的 `CycleSnapshotBodySchema`；没有可解码快照时，`readWorking` 的 `WorkingStateSchema` 同样会拒绝同一批状态。`root.submit`（`src/agent.ts:174`）因为 `prepareRequest` 抛错而没有执行，请求没有进入模型循环，也没有产生新的业务副作用。

  **原因**：旧 `personal.working` 与周期快照仍含已删除字段（working 顶层的 `profile` 和 snapshot 的 `baseline.profile`）。当前 `WorkingStateSchema`（`src/memory/contracts.ts:191`）和 `WorkingBaselineSchema`（`:208`）都没有 `profile`，且 `additionalProperties: false`（`:199`、`:215`）；`CycleSnapshotBodySchema`（`:416`）同样严格。含 `profile` 的形状来自未合入 `main` 的 PR #44 分支（提交 `5183893`），该分支把 working 文档版本升到 2，并只迁移「缺 `profile`」的旧文档，不迁移「多出 `profile`」的当前数据；`main` 没有这段迁移。因此用 `main` 的代码读该分支写下的值，`Value.Check` 必然失败并转为 `corrupt-state`。

  **处理**：Jay 确认重置 conversation；先备份到 `~/Aster/backups/conv1-reset-20261031-225523/`。Operation 对 conversationId=1 执行以下步骤：

  1. `root.reset()`，新 head 为 `pi.reset` entry 686。
  2. 清坏 working：旧 v2 + `profile` 改写为 v1 `initialWorkingState`。
  3. 清除 `inbox.failures` 中的三条记录（`telegram:8396905983:976153046/047/048`）。
  4. 用同一镜像短重启。

  全程未部署、未改代码、未回滚。

  **验证**：操作完成后 Jay 确认 Telegram 已恢复。仓库内没有保留本次生产日志的脱敏副本；本节不把「重启后恢复」写成自动化测试证据。处置与代码路径一致：清理后该会话不再存在含 `profile` 的 working 或周期快照，`assertSchema` 不再拒绝它的状态。
