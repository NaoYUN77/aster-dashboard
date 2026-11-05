# 一次性提醒

提醒是宿主自己保存、到点直接发送到 Owner 私有 Telegram 会话的一条文本消息。它不经过模型、PTC 脚本或 agent session，也不承诺 Telegram 恰好收到一次。取舍见 [ADR-0022](adr/reminders/0022-reminders-in-process-scheduler.md)。

## 范围与模块边界

只支持单次提醒：内容 + 明确触发时刻 + 时区。不做周期提醒、邮件、Web UI 或主动 Agent。

| 模块 | 职责 |
| --- | --- |
| `src/reminders.ts` | SQLite 状态存储、条件状态迁移、进程内调度器、三个模型工具 |
| `src/config.ts` | `REMINDERS_*` 配置与边界校验；默认启用 |
| `src/agent.ts` | 通过 Tool Registry 注册 `reminder_create` / `reminder_list` / `reminder_cancel`，并在指令中说明时间格式 |
| `src/main.ts` | 打开 `reminders.sqlite`、启动前 `recover()`、启动/停止调度器 |
| `src/tools.ts` | `reminder_list` 归为只读工具；创建与取消仍是写操作 |
| `src/reminders-cli.ts` | 停服后核查 `uncertain` / `failed` 行并确认送达或重试一次 |

## 调用链

```text
Telegram 消息 -> Inbox -> agent loop -> reminder_create
                                         -> ReminderStore.create() -> reminders.sqlite (pending)

ReminderScheduler 循环（与长轮询并行）
  -> claimDue()            pending -> queued（同一条 SQL 条件更新，只领取一次）
  -> beginSend()           queued  -> sending（只有成功者调用 Telegram）
  -> TelegramClient.send() 固定发送到 config.ownerId 的私有会话
  -> markSent() / markFailure()  -> sent / failed / uncertain
```

调度器的计时器只决定何时查看数据库；SQLite 是唯一事实来源。进程重启不会补发 `uncertain` 行。

## 数据与状态

数据库文件是 `<DATA_DIR>/reminders.sqlite`，与 Inbox 的 `inbox.sqlite` 分开，不修改 Inbox 的请求/分段契约。

```sql
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chatId TEXT NOT NULL,          -- 创建时由宿主配置提供，不是模型参数
  ownerId TEXT NOT NULL,
  content TEXT NOT NULL,
  dueAt TEXT NOT NULL,           -- ISO 8601 UTC，调度比较的唯一时间
  timezone TEXT NOT NULL,        -- 原始 IANA 时区，仅用于展示与审计
  createdAt TEXT NOT NULL,       -- 用于每小时创建速率限制
  status TEXT NOT NULL,          -- pending | queued | sending | sent | failed | uncertain | cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  messageId TEXT, sentAt TEXT, failureCode TEXT,
  idempotencyKey TEXT UNIQUE     -- hash(conversationId + callId)
);
```

状态机：

```text
pending --claimDue--> queued --beginSend--> sending --成功--> sent
   |                    |                       |--Telegram 4xx--> failed
   |                    |                       |--超时/断线/关停/崩溃--> uncertain
   |                    |--cancel--> cancelled
   |--cancel--> cancelled
```

迁移都是 `BEGIN IMMEDIATE` 事务里的条件更新：`claimDue` 同时把到期的 `pending` 改为 `queued` 并返回全部 `queued`；`beginSend` 只在 `queued` 上成功一次；`markSent` / `markFailure` 只在 `sending` 上生效。重复扫描不会重复入队，重复发送被条件更新挡住。

## 失败与恢复

| 情形 | 记录 | 是否自动重发 |
| --- | --- | --- |
| Telegram 返回 4xx | `failed` + `TELEGRAM_<code>` | 否 |
| 超时、断线、发送中被取消 | `uncertain` + `TIMEOUT` / `EXECUTION_ERROR` | 否 |
| 进程在发送前崩溃（`queued`） | 启动时回到 `pending` | 是，下次扫描发送 |
| 进程在发送中崩溃（`sending`） | 启动时记 `uncertain` + `PROCESS_INTERRUPTED` | 否 |
| 进程在发送后崩溃（已写 `sent`） | 保持 `sent` | 否 |
| 取消与领取竞争 | 取消先成功则 `cancelled`；发送已开始则返回 `REMINDER_NOT_CANCELLABLE` | — |

“结果未知”一律记为 `uncertain`，不当作未执行。核对 Telegram 后由 Owner 人工收敛：

```sh
npm run reminders -- list
npm run reminders -- sent 12    # 已确认收到，只改状态
npm run reminders -- retry 12   # 确认需要重发：回到 pending（可能重复一次）
```

CLI 不调用 `recover()`，避免与运行中的进程抢状态；`retry` 后运行中的进程约一分钟内会再次扫描，停服时则在下次启动时扫描。

## 安全与资源边界

- 只能由已认证 Owner 的私有会话触发；目标 chat 来自宿主配置 `TELEGRAM_OWNER_ID`，模型参数中没有 chat id，无法指定其他会话。
- 提醒内容是数据，不进入 agent 指令或工具描述；发送文本固定为 `提醒：<content>`。
- 内容最多 2000 字符 / 8000 字节，时区最多 64 字符；触发时刻必须显式带偏移或 `Z`，无偏移的本地时间按“歧义”拒绝，过去时间与超出上限的远期时间也拒绝。
- 每个会话最多 `REMINDERS_MAX_PENDING` 条活跃提醒，每小时最多创建 `REMINDERS_MAX_PER_HOUR` 条。
- 调度器每次扫描最多处理 20 条，所有异常都在调度器内捕获并只记录错误码；Telegram 或存储故障不会终止长轮询和 agent 会话。
- 日志只包含提醒 id、状态和错误码，不记录内容与凭据。默认 Langfuse Trace 不采集内容；开发环境开启 `LANGFUSE_CAPTURE_CONTENT=1` 时，提醒工具的参数和结果会像其他工具一样出现在 Trace 中，因此该开关只用于个人开发环境。

## 配置

| 变量 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `REMINDERS_ENABLED` | `1` | `0` / `1` | `0` 时不创建数据库、不注册工具、不启动调度器 |
| `REMINDERS_MAX_PENDING` | `100` | 1..1000 | 每个会话的活跃提醒上限 |
| `REMINDERS_MAX_PER_HOUR` | `20` | 1..1000 | 每个会话每小时创建上限 |
| `REMINDERS_MAX_HORIZON_DAYS` | `366` | 1..3650 | 提醒可设置的最远天数 |

非法值使启动失败，不会静默回退。

## 真实部署验收

1. 构建并上线包含本功能的镜像，确认容器内 `dist/src/reminders.js` 存在、`REMINDERS_ENABLED` 未设为 `0`，且 `DATA_DIR` 指向持久化卷。
2. 在 Telegram 私聊发送“1 分钟后提醒我喝水”。确认模型调用 `reminder_create`，回复中的 id 来自工具结果；`npm run reminders -- list` 能看到 `pending` 行，时间与 `dueAt`（UTC）一致。
3. 等待到点，确认同一私聊收到 `提醒：喝水`；`list` 中该行为 `sent`，带 Telegram `messageId` 和 `sentAt`。
4. 创建一条 3 分钟后的提醒，重启容器（`docker compose ... restart`）。确认重启后仍是 `pending`，到点正常发送；重启不产生第二次发送。
5. 创建一条 5 分钟后的提醒并立即取消。确认到点没有消息，状态为 `cancelled`。
6. 模拟发送失败（例如临时把 `TELEGRAM_API_ROOT` 指向不可达地址）后恢复。确认失败行不会被自动重发；检查 Telegram 后按上面的 CLI 收敛 `uncertain`。
7. 确认普通对话、Inbox 投递、Durable Replay 与 codemode 均不受影响：提醒发送期间继续发消息，回复正常；重启后未完成的普通请求仍按原契约恢复。
