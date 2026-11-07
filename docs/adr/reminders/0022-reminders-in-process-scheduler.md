> **状态：已废弃（历史记录）。** `reminder_*` 工具、ReminderStore 与 ReminderScheduler 已移除，既有 SQLite 表和数据保留；当前唯一入口是 dashboard 控制台（dash），见[当前架构](../../../README.md#架构)。下文保留原始决策背景。

# ADR-0022：提醒由宿主持久化并在进程内调度

- **状态**：Accepted
- **日期**：2026-11-05
- **功能**：reminders

## 上下文

个人 agent 之前只能在收到 Telegram 消息时运行。需要一种“到点主动发一条消息”的能力，同时不引入常驻模型循环。已有 Inbox 负责请求接收与回复投递，其 `deliveries` 以用户请求为单位；提醒的生命周期是触发时刻，不是某次请求，直接复用会混淆两套状态。

## 决策驱动因素

- 部署基线是单台 4 核 / 4 GB 服务器，只运行一个应用容器；不能为此新增 Redis、消息队列、cron 服务或独立进程。
- 单 Owner 私有 Telegram 会话是唯一外部投递目标，凭据和会话身份由宿主掌握。
- SQLite 是已有持久化载体；模型、PTC 和 agent session 都不可用也不能成为唤醒来源。
- 外部发送不保证恰好一次，结果未知必须显式记录。

## 备选方案

- **复用 Inbox `deliveries`**：省一张表，但请求 id、分段确认和重试都围绕用户消息设计，提醒没有请求语义；会让 Inbox 契约同时承担两套生命周期，补发也可能重跑 agent。未采纳。
- **系统 cron / 独立调度进程**：需要第二个进程与共享状态协调，部署和恢复都更复杂。未采纳。
- **让模型或 PTC 脚本等待到点**：长连接、进程重启和 token 成本都不可接受，且提醒会依赖 agent 会话存活。未采纳。
- **进程内定时器 + SQLite 条件迁移**：无新增服务，重启可恢复，代价是只在应用运行期间触发。采纳。

## 决策

- 提醒存在独立的 `<DATA_DIR>/reminders.sqlite`，状态机为 `pending → queued → sending → sent / failed / uncertain`，取消独立为 `cancelled`。
- 每次状态迁移都在 `BEGIN IMMEDIATE` 事务中做条件更新；重复扫描只入队一次，`beginSend` 只允许一个执行者发送。
- 调度器与 Telegram 长轮询在同一进程内并行，唯一职责是按 `dueAt` 读取数据库并调用现有 `TelegramClient.send`；计时器只决定何时查看，不是事实来源。
- 启动时 `recover()`：`queued` 回到 `pending`（肯定没发），`sending` 记为 `uncertain`（可能已发），不自动重发。
- 目标 chat 来自宿主配置，模型只能提供内容、带偏移的时刻和 IANA 时区；创建工具的结果以持久化行为准，并对同一 `conversationId + callId` 幂等。
- `uncertain` / `failed` 由 Owner 用 CLI 在核对 Telegram 后标记送达或重试一次。

## 后果

- 应用停机期间到期的提醒不会发送，恢复后立即补发，可能晚于原定时刻；这是可接受的语义，已在文档中写明。
- 发送不承诺恰好一次；`uncertain` 不会被自动重试，需要人工收敛。
- 停服顺序必须先停调度器再关数据库与 agent；进行中的发送会以 `uncertain` 结束。
- 提醒状态与 Inbox、Durable Replay、PTC 相互独立，任一方的失败不影响另一方。

## 分阶段决策与缺陷历史

### 2026-11-05：单次提醒 MVP

- 相关 spec：用户于 2026-11-05 提供的 Reminder MVP 规格（未入库，内容随本次 PR 描述）。
- 决策与取舍：只做单次提醒；不做周期提醒、邮件、Web UI 或主动 Agent。复用 Telegram 客户端、SQLite、工具注册与取消语义，不引入新服务。内容与目标会话由宿主边界校验。
- 相关缺陷：尚未发现。已知限制：提醒只在应用运行期间触发；`uncertain` 需人工核查。
