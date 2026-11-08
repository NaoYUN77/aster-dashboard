# Bot 删除与保留 Bot 重置规格

- **状态**：已实现，本地验收已执行（2026-11-08）：`npm run check`、`npm run build`、`npm test`（406 项，390 通过、0 失败、16 项 POSIX／root 专属跳过）全绿；第 10 节逐项标注了覆盖证据与仍未验证的条目。**部署验收（真实容器重启策略、Docker 卷、真实模型供应商）未执行**，本文不把未执行的验证记为已通过。
- **开始日期**：2026-11-07
- **功能**：zero-setup-bot-runtime
- **长期决策**：[ADR-0023：开箱即用的 Bot 运行环境与平台能力清单](adr/zero-setup-bot-runtime/0023-zero-setup-bot-runtime.md)（决策 9 / 10 / 11）

## 1. 用户目标与本轮交付边界

控制台里删除一个 Bot，必须是**真的擦除**：该 Bot 的会话、记忆与执行账本从存储中消失，工作区文件保留。保留 Bot（`default`）不能被删除，只能重置。

本轮交付：

1. `DELETE /api/bots/:id`——对普通 Bot 写即时生效的墓碑（用户视角已删），对保留 Bot 执行重置。
2. 进程启动时、`openAgent()` 打开 harness 与任何会话**之前**执行的 purge，完成行级回收。
3. 同一份 purge 实现的离线运维入口，供不愿等待重启的回收。
4. 删除留痕：谁在何时删了哪个 Bot、删了多少行、是否 force。
5. 可选的自重启（3.4）：不接受"删除后必须等运维重启"作为唯一出路。默认仍不等——即时物理回收是显式选项，不是默认行为。

本轮不做：决策 10（长期记忆改为按 Bot 可选、新建默认关）另立 spec——本规格只保证 purge 的实现**按归属模型清理，而不是按目录清空**，见第 6 节；保留 Bot 的改名与工作区路径迁移（ADR-0023 开放项 ③）；控制台前端交互细节；upstream 原语替换（接缝已留，见第 9 节）。

底座没有删除原语，本规格的实现是宿主侧直接操作 SQLite。这是一次**有意的技术债**，用第 5 节的版本闸门与第 10 节的契约测试兜住，并在接缝后收成单点。

## 2. 已有能力与缺失能力

| 类别 | 现状 |
| --- | --- |
| 已有 | `bots` 表（`botId` 主键、`conversationId NOT NULL UNIQUE`、`status TEXT NOT NULL DEFAULT 'active'`、`userId`）；`BotStatus = "active" \| "disabled"` 与 `setBotStatus`（**当前无任何调用者**）；`bot_provisioning.botId REFERENCES bots(botId) ON DELETE CASCADE`；`addColumn` 形式的增量迁移已有先例（`profile`/`toolScope`/`userId`） |
| 已有 | `BotView` 已暴露 `running`（`#running` Map）与 `pending`（`inbox.pendingForBot`），足以判定 409 前置条件；`#activeBot` 已对非 `active` 抛错 |
| 已有 | 控制台路由骨架：`BOT_PATH` 正则、`WEB_AUTH` 令牌校验、`CONSOLE_MAX_BOTS` 上限、`GET/POST /api/bots` 与 `/api/bots/:id/{retry,messages,cancel,history,events}` |
| 已有 | `inbox` 表含 `requestId`（`console:<botId>:` 前缀，`consoleRequestPrefix`）、`conversationId`、`text`、`receivedAt`；`deliveries`/`failures` 为 Telegram 时代的投递状态，控制台路径不读写 |
| 已有 | 底座存储 `DATA_DIR/agent.sqlite`：`conversations`/`entries`/`tasks`/`submissions`/`documents`/`document_revisions`/`record_ids`/`durable_schema`；`Storage` 接口可读全部所需数据；文档作用域有 `{ kind: "session" }` 与 `{ kind: "conversation", conversationId }` 两种 |
| 缺失 | 底座 1.3.0–1.5.0 无删除原语：`Storage` 无 delete，仅 `removeInboxItem`/`removeCompactionStatus`/`removeNestedSlots`；`Conversation.reset()` 只写 `pi.reset` 条目，不删任何内容 |
| 缺失 | 无 `DELETE` 路由；无 purge 实现；无离线入口；`BotStatus` 无 `deleted`；无留痕列；无"id 已退役"的判定 |

## 3. 接口与状态

### 3.1 `DELETE /api/bots/:id`

| 情况 | 响应 |
| --- | --- |
| 普通 Bot，接受 | `202 { bot, removal: { kind: "delete", state: "pending_purge", requestedAt } }` |
| 保留 Bot（`default`） | `202 { bot, removal: { kind: "reset", state: "pending_purge", requestedAt } }`，并明示这是重置 |
| 同一 Bot 重复调用 | `200`，返回第一次的 `removal`，不重复留置、不改变已记的时间 |
| Bot 不存在或不属于当前 owner | `404` |
| 正在运行（`view.running !== null`） | `409 { error: "bot_is_running" }` |
| 有待处理输入（`view.pending > 0`） | `409 { error: "bot_has_pending_input" }` |
| 会话存在非终态 task 或未结算 submission | `409 { error: "work_in_flight", tasks, submissions }`，`force` 也不放行（见下方偏差记录） |
| 存在终态但结局未知的记录 | `409 { error: "unknown_outcome", records }`；带 `force: true` 时接受，并在 `removal.forced = true` 与留痕中记录 |
| 已被墓碑 | `200`，返回既有 `removal` |
| 有其它会话继承该会话的历史（分叉） | `409 { error: "fork_survivor", conversations }`；`force` 放行并连同继承者一并删除（见下方偏差记录） |

`work_in_flight` 与 `unknown_outcome` 是两类不同的拒绝：前者是**本进程仍然拥有、调用方可以先去取消**的进行中工作（`#running` 之外还有底座里非终态的行），后者是**没有进程再拥有、谁也无法使其确定**的终态记录。把两者合成一个 `unknown_outcome` 会让"先去取消再重试"这条可行动作失去名字，因此实现拆成两个错误码；本节表格已按实现更新（原始规格把前者也写作 `unknown_outcome`）。

`fork_survivor` 同样是实现补入的：删掉一份被其它会话继承的历史，会让继承者的会话历史读不出来，所以默认拒绝、`force` 时连同继承者一并删除。当前部署不产生分叉（分叉只由底座的分叉 API 产生），因此它在生产上不会出现，但接缝处的这一条必须映射成显式拒绝而不是静默留下坏数据；契约测试用一行真实的继承关系锁住它。

`force` 只接受布尔值，位置为 JSON body 的 `force` 字段；不接受路径、会话 id、表名或任何可影响删除范围的参数。响应必须包含"不可逆"的明确表述。

`reason`（可选字符串，有界长度、仅用于留痕的人类可读说明）不是授权依据。

### 3.2 Bot 状态与列表

- 墓碑把 `bots.status` 置为 `deleted`（`BotStatus` 增加该值），并写入 `removalKind`/`removalAt`/`removalForced`/`removalReason`/`removalReport` 五列（`addColumn` 迁移）。
- `GET /api/bots` 不返回 `status = 'deleted'` 的 Bot；`BotView` 增加 `removal` 字段（`null` 或上述记录的只读视图），使控制台能显示"已请求删除、待下次启动回收"。
- `/api/platform` 增加待回收计数（`pendingPurge`），使运维能看到积压。
- 墓碑 Bot 的任何其它操作（消息、取消、重试、历史、事件）返回 `410 { error: "bot_deleted" }`，不复用"Bot is disabled"这类会误导的措辞。
- **`botId` 永久不复用**：`POST /api/bots` 用一个已 `removalKind = 'delete'` 的 id 时返回 `409 { error: "bot_id_retired" }`，不是现有的 "Bot already exists"。保留 Bot 的重置不退役 id。
- 墓碑行长期保留：它同时是"该 id 已退役"的权威记录，并保留 `conversationId` 作为历史关联（会话 id 永不复用，因此不会冲突）。

### 3.3 重置（保留 Bot）

保留 Bot 的"删除"不产生墓碑：`bots` 行保留（`status` 仍为 `active`）、`conversationId` 不变、不出现在退役判定里；只把 root 会话的**内容**清空（第 6 节）。理由是 `Harness.root()` 的契约是"保留会话，不存在时创建"——删掉 root 的行只会换来一个新的 root（新 id），那是重置而非删除；而真删 `bots` 行会让 root 变成没有归属的会话，`usesMemory`（`conversation.id === root.id`）永不成立，整个部署的长期记忆随之失效。

重置同样受 3.1 的 409 条件与 `force` 规则约束，同样记录留痕。

### 3.4 立即回收：可选的自重启

墓碑即时生效，行级回收需要一个进程边界——这是底座无删除原语、harness 常开、`VACUUM` 需独占三者共同逼迫的，不回避。到达边界有三条路：

1. **自然重启或下一次部署**（默认）：不需要额外动作。启动 purge 一次清空**所有**积压墓碑，因此删 3 个 Bot 也只付一次重启。
2. **离线命令**：服务已停止时执行同一份实现（第 9 节）。
3. **请求即重启**（可选，默认关）：body 带 `"purge": "now"` 时，在响应**写出并 flush 之后**走与 `SIGTERM` 相同的优雅关闭路径退出进程，由 `restart: unless-stopped` 拉起，启动 purge 随即执行。

第 3 条必须把代价写在明处：**一个进程承载所有 Bot**，所以它中断的是**其它 Bot 正在执行的工作**。

- 默认关闭；`force` 不隐含开启它，`purge` 与 `force` 是两个独立字段。
- 有其它 Bot 正在运行或存在待处理输入时返回 `409 { error: "busy_bots", bots: [...] }` 并列出受影响的 Bot，让调用方先逐个取消再重试；不静默打断（取消须确认终态，见 [契约与生命周期](contracts-and-lifecycle.md)）。若日后要"连其它 Bot 一起打断"，那是把这条改成显式二次确认，不是放宽默认。
- 先应答、再关闭：响应写出并 flush 后才触发退出，否则 202 会被自己切断；控制台关闭路径（`consoleHandle.close()` 拒绝新请求）不得吃掉这个响应。
- 不改变正确性：在途调用按既有中断语义处理（结果未知的记录照记），这是自重启与普通重启共有的性质，不是删除特有的。
- 它**不缩短**任何安全窗口：purge 仍发生在 `openAgent()` 之前，没有新的执行期删除路径。

## 4. 副作用与授权

- **只有控制台 API 能触发删除**，含 3.4 的自重启路径。删除**不暴露为模型工具**，模型参数不能指定路径、会话、表或凭据；未来也不得新增此类工具。
- 鉴权沿用控制台既有边界（`WEB_AUTH`，当前生产为 `off` 且入站仅回环）；删除不引入新的对外入口。
- **不能删除自己部署之外的东西**：purge 的目标集合由墓碑 + `conversationId` 决定，绝不接受调用方给出的范围。
- **不可逆**：响应与留痕都必须写明；不留回收站、不提供撤销。
- **不伪造成功**：墓碑生效期内，响应**不得声称物理擦除已完成**。用户视角的移除是即时的，物理回收有自己的时点，两者必须分开表述，并让 `pendingPurge` 可查。若在回收前就对外说"已从存储删除"，那是本项目在[安全审计边界](../CLAUDE.md)里明确禁止的伪造成功。
- **删除不改变任何授权/执行路径**：purge 前后，工具目录、pin、记忆绑定、工作区路径的解析都不放宽；删除一个 Bot 不得使其它 Bot 获得该 Bot 的工具或目录。
- 幂等性：重复 DELETE 不重复留置；purge 可重跑且结果收敛。
- 留痕只记计数与元数据，**不记 `inbox.text` 正文**，也不记工具参数。

## 5. 资源与失败恢复边界

- **接缝**：新增 `ConversationPurger`（实现落在 `src/conversation-purge.ts`）。规格原本写的是两个操作 `eraseConversation(conversationId)` 与 `resetConversation(rootConversationId)`；实现收成一个 `purge({ conversationId, mode: "erase" | "reset", force })` 加一个纯读的 `inspect(conversationId)`——两个操作共享同一套闭包计算、同一张删除计划与同一个行预算，拆成两个入口只会让它们有各自漂移的机会，而 `mode` 就是它们唯一真实的差别（`conversations` 行删或不删）。只有它执行 `agent.sqlite` 的删除语句；其它模块不得出现针对这些表的删除。
- **版本闸门（fail-closed）**：purge 前读取 `durable_schema` 的 version，并断言实现依赖的表与列存在（`conversations`/`entries`/`tasks`/`submissions`/`documents`/`document_revisions`/`record_ids`）。版本或结构不匹配时**拒绝 purge**：保留墓碑与 intent、报告明确错误、不猜测表结构、不部分执行。升级底座必须先复核此闸门（1.4.0 把 SQLite 升到 schema 2 且不可回退到 1.3.0，即此类变更的实例）。
- **`record_ids` 永不删除**。`mintId()` 承诺返回值 "greater than every ID minted or stored before, also across reopen"；保留水位表使被删 id 不复用，契约自动保持（这也是不采用"读出来重建新库"方案的原因：重建无法恢复水位，公开 API 没有设置水位的入口）。
- **按作用域过滤，不按 kind**：删除条件必须表达"作用域属于该会话"。实例：`personal.tools.loads`（Tool Ledger）是 `scope: { kind: "conversation", conversationId }`，随会话删；`personal.tools.catalog` 是 `scope: { kind: "session" }`，**必须保留**。
- **不要求原子性**：墓碑已使会话对用户不可达，且 purge 在 harness 打开之前执行，因此"删一半后崩溃"不可观测；重跑幂等收敛。墓碑就是 intent。
- **VACUUM 在同一启动窗口**、purge 之后、`openAgent()` 之前执行；仅在本次确有删除时执行；`agent.sqlite` 与 `inbox.sqlite` 分别处理。`VACUUM` 需要独占且不能在事务内，因此不能留到运行期。`VACUUM` 失败不影响正确性，但要报告，不阻塞启动。
- **单写者前提**：purge 期间不得有第二个进程写这两个库。离线命令必须在服务停止时运行，并**检测到服务仍在运行时拒绝**（以锁文件或库可写性判定），不提供 `--force` 越过。
- 资源边界：一次启动的 purge 处理 `pending` 墓碑数量有上限（首期 64，与 `CONSOLE_MAX_BOTS` 上限同量级），超限先处理前 N 个并在**一遍回收的报告与日志**中明确剩余数量（`deferred`），不静默丢弃；单次 purge 的删除行数上限 200000，超限中止该 Bot 的 purge 并保留 intent 供下次重试。

## 6. 删除范围

### 6.1 `agent.sqlite`

| 对象 | 处理 |
| --- | --- |
| `conversations` | 普通 Bot：删该行。保留 Bot 重置：**保留**该行 |
| `entries` | 删该会话的全部条目 |
| `tasks`、`submissions` | 删该会话的全部记录（甲：工作记录一并删除，不留悬空 `conversationId`） |
| `documents` + `document_revisions` | 删 `scope.kind = 'conversation'` 且 `conversationId` 属于该会话的文档及其修订，包括 `pi.agent`、记忆的 `personal.*`、Tool Ledger `personal.tools.loads`。**`scope.kind = 'session'` 的文档一律保留** |
| `record_ids` | **不动** |
| `durable_schema` | **不动** |
| 其它会话 | 一行不碰（契约测试必须断言） |

### 6.2 `inbox.sqlite`

| 对象 | 处理 |
| --- | --- |
| `inbox` | 删 `requestId` 以 `console:<botId>:` 开头的行。这些行的 `text` 是用户输入正文，留下则"删除"名不副实；同时 `pendingForBot` 会永久非零 |
| `deliveries`、`failures` | 删引用上述 `requestId` 的行（保留会造成对已删请求的悬空引用；控制台路径不读写它们） |
| `bots` | 普通 Bot：置 `status = 'deleted'` 并写留痕列（墓碑保留）。保留 Bot 重置：保留行，只写留痕列 |
| `bot_provisioning` | 依赖既有 `ON DELETE CASCADE`；墓碑不删 `bots` 行，因此该表的行需显式删除 |
| `integrations`、`checkpoint`、`identity` | **不动** |

### 6.3 不删的东西

- **工作区文件**：全部保留（用户明确要求）。共享主机模式下 `default` 的工作区是 `/workspaces` 本身，更不得触碰。
- **daily 记忆**：本次不动。理由：当前记忆集成只绑 root 会话（归档只扫 root 的 entries），因此普通 Bot 在 `DATA_DIR/memory/daily/*.md` 里没有内容；而 root 属于保留 Bot，其清空走 3.3 的重置。**实现必须按归属模型清理，不得按目录清空**——决策 10 落地后"只有 root 写 daily"不再成立，按目录清空会误删其它 Bot 的记忆。

### 6.4 留痕

墓碑行上的 `removalKind`/`removalAt`/`removalForced`/`removalReason`/`removalReport` 即留痕，回收失败时另有 `removalError`（失败码，如 `UNKNOWN_OUTCOME`；成功后清回 `null`）。`removalReport` 为有界 JSON，含 `at`、`mode`、`forced`、`removed`（被删会话 id，含 `force` 时一并删掉的继承者）与 `rows`（表名 → 行数）。`removalReport` 是唯一结束 intent 的字段，**最后写入**：因此"`agent.sqlite` 已删、`inbox.sqlite` 未删"的崩溃窗口重跑即收敛。`vacuumed`／`vacuumError` 属于**一遍回收**的报告，不在每会话的留痕里（`VACUUM` 由 pass 拥有）。这样"删过什么、何时删的、是否 force"长期可答，即使"那个 Bot 做过什么"不可答（甲接受的代价）。

## 7. 初始化生命周期

启动顺序插入点（`src/main.ts`）：

```
readConfig → startTrace → mkdir(dataDir)
→ new Inbox(DATA_DIR/inbox.sqlite)          ← 墓碑与 intent 在这里
→ ★ purge（本次新增：读 intent → 版本闸门 → 删 agent.sqlite 行 → 删 inbox.sqlite 行 → 写留痕 → VACUUM）
→ buildPlatformCapabilities → openAgent(...)  ← 到这一步 harness 才打开、withToolLedger 才包装存储
→ buildProvisioningRuntime → new BotManager → bots.start()
```

- purge 必须在 `openAgent()` **之前**：服务是常驻进程，harness 与所有 Bot 会话在进程退出前一直打开（`BotManager` 没有空闲回收），运行期没有安全的删除窗口。
- purge 必须在 `withToolLedger` 包装之前：它面对原始 storage，不经过 Tool Ledger 的 `commit()` 拦截。
- `ensureBot("default")` **不修改**：重置语义保留 `bots` 行，因此每次启动重建 `default` 的行为不与删除语义冲突（这是选择"重置"而非"真删"的一个直接收益）。
- `#activate` 循环必须跳过 `status = 'deleted'` 的 Bot；`#bots()` 的消费方需要区分"列表用"（过滤墓碑）与"内部对齐用"（保留墓碑以免漏判退役 id）。
- purge 失败不阻塞启动（墓碑仍在，下次重试），但必须报告：不把失败记为成功，也不静默。
- **自重启（3.4）不新增窗口**：它走的是既有关机路径——`startService` 已有单一关机控制器与 `close()`（`src/main.ts:61-90`、`192-202`），控制台拿到的是显式的"请求关机"回调，而不是向自己发信号（测试内嵌 `startService` 时发 `SIGTERM` 会误杀宿主进程）。退出发生在响应写出之后，重启后仍从本节的同一插入点进入。

## 8. 安全边界

- **不可信输入**：`botId` 必须过 `BOT_ID_PATTERN` 才进入任何 SQL 或日志；`force` 只接受布尔；`reason` 有界且不参与判定。
- **SQL 参数化**：所有删除语句使用绑定参数；禁止字符串拼接会话 id、作用域或表名。表名在实现中固定，不来自输入。
- **绕过底座校验路径的补偿**：purge 直接操作 SQLite，不经过底座的写入校验。补偿手段是第 5 节的版本闸门 + 表结构断言 + 第 10 节的契约测试；这是本功能被接受的代价，须在 ADR 中保持记录。
- **日志**：不含 `inbox.text`、工具参数、凭据或任何会话内容；只记 botId、会话 id、表名与行数。
- **越权面**：删除不得被模型参数、工具调用、MCP 工具或投递路径触发；不得因为删除而放宽工具目录、pin 或工作区解析。自重启（3.4）是唯一一条"删除能让服务短暂不可用"的路径，因此必须显式、默认关，且同样不得由模型、MCP 工具或投递路径触发；其触发回调由宿主在 `startService` 内构造，不依赖进程信号。
- **不碰 `record_ids`**、不碰 `session` 作用域文档、不碰其它会话——三者都是"删错即不可逆"的面，必须在实现里以显式断言表达。

## 9. 实施接点与顺序

| 接点 | 本次工作 |
| --- | --- |
| `src/inbox.ts` | `BotStatus` 增加 `deleted`；`addColumn` 迁移五个 `removal*` 列；墓碑查询与 `views()` 的过滤；`retiredBotIds`；按 `console:<botId>:` 前缀删除 `inbox`/`deliveries`/`failures`；`removeProvisioning` |
| `src/conversation-purge.ts`（新增，即规格中的 `src/purger.ts`） | `ConversationPurger` 接口与 SQLite 实现；版本闸门与表结构断言；作用域过滤；行数统计 |
| `src/bot-removal.ts`（新增） | 一遍回收（`runPendingRemovals`）：启动与离线命令共用的同一份实现，含每遍墓碑上限与 `deferred` 计数 |
| `src/main.ts` | 插入点与 `VACUUM`；失败报告；跳过墓碑的启动路径对齐 |
| `src/console.ts` | `DELETE /api/bots/:id` 路由与 409/410/404 语义；`BotView.removal`；`/api/platform` 的 `pendingPurge` |
| `src/bot-manager.ts` | `remove(botId, { force, purge, reason })`；保留 Bot 的重置分支；`#activeBot` 的 `bot_deleted` 语义；`create` 的退役 id 判定；`busyBots` |
| `src/bot-purge.ts`（新增） | 离线 purge 入口（`npm run bots:purge`），复用 `runPendingRemovals`，服务运行中拒绝 |
| `src/service-lock.ts`（新增） | `DATA_DIR/service.lock` 的单写者判定，启动与离线命令共用 |
| `test/conversation-purge.test.ts`、`test/bot-deletion.test.ts`（新增） | 契约测试 + 路由/状态测试，见第 10 节 |
| `docs/contracts-and-lifecycle.md` | 实施后补删除契约与限制；`docs/adr/zero-setup-bot-runtime/0023-*.md` 记录结果与缺陷 |

实施顺序：先定 `ConversationPurger` 接口与版本闸门，再写契约测试（它会先红），然后实现删除、接上路由与状态，最后加离线入口与留痕。

接缝的替换条件：上游 `earendil-works/pi` 提供 `deleteConversation` 后，`ConversationPurger` 换为实现方，调用点（`main.ts`、`bot-manager.ts`、离线入口）不变，第 10 节的契约测试全绿即为替换验收。

## 10. 验收清单（2026-11-08：逐项标注执行结果）

标记：`[x]` 有自动化证据；`[~]` 部分覆盖（括号内写明未覆盖的部分）；`[ ]` 未覆盖。部署验收条目一律保持未勾。

- [x] `durable_schema` 版本或依赖的表/列不匹配时 purge 拒绝执行、保留 intent、报告明确错误；构造一个"多一列/少一列"的库验证 fail-closed。→ `test/conversation-purge.test.ts`：`an unrecognized store is refused before anything is deleted`（缺列与多列各一例，断言拒绝码与"一行未删"）。
- [x] 契约测试 A：造 3 个会话 + 文档（含 `session` 作用域文档与两份 Tool Ledger）→ purge 中间一个 → 用底座 `openAgent()` 重新打开，断言被删会话与其余内容不存在、**另外两个会话完好**、**`session` 作用域文档完好**、`record_ids` 未变、`mintId()` 仍大于一切历史 id。→ 同上文件 `erasing one conversation leaves every other row, the session documents and the id history`；`test/bot-deletion.test.ts` 第一例用真实底座行重开存储再断言 `scanConversations` 不再列出被删会话、其余可读、`mintId()` 大于 `record_ids` 的历史最大值。
- [x] 契约测试 B：`reset` 分支下 `conversations` 行与 `bots` 行保留、root 会话内容为空、`ensureBot` 后 `default` 仍指向同一会话 id。→ `a reset empties the root conversation and keeps its row…`；`test/bot-deletion.test.ts`：`the reserved bot is reset, not deleted…`（重启后 `conversationId` 不变、历史里没有用户消息、`status` 仍为 `active`）。
- [~] 崩溃恢复：在删完 `agent.sqlite`、未删 `inbox.sqlite` 之间中断进程 → 重启后 purge 重跑并收敛；墓碑不重复留置、`removalAt` 不改变。→ 已覆盖"重跑收敛"与"重复请求不改时间"（`a second purge of the same conversation reports it absent instead of failing`、`a removal that cannot be carried out stays pending…`、bot-deletion 第一例的重跑 `removed: []`）；**未覆盖**：在两步之间真的杀掉进程（没有构造进程级中断）。
- [x] 幂等：对同一 Bot 连续两次 DELETE 与两次启动 purge，结果一致、行数统计不重复累加。→ bot-deletion 第一例：重复 DELETE 返回 `200` 与同一个 `requestedAt`、`pendingPurge` 仍为 1；完成后重跑 pass 得 `removed: []`。
- [x] 409 三态：运行中、有 pending 输入、存在非终态 task/未结算 submission 各自返回对应错误且不产生任何删除；前三者 `force` 不生效。→ bot-deletion：`a run in progress, and input nobody is left to answer, are each refused by name`、`work this process still owns is refused as unfinished, and force does not get past it`（`work_in_flight`，`force` 仍 409，且存储一行未删）。
- [x] `force` 只在"未知结局"下被接受：无未知结局时带 `force` 不改变行为；有未知结局时默认 409、带 `force` 接受并在留痕中记 `removalForced = true`。→ bot-deletion：`unexplained work is refused by default, accepted only with force, and reclaimed after a restart`（`removalForced = 1` 落在墓碑行上并被 pass 承接）。
- [x] `botId` 退役：删除后 `POST /api/bots` 用同 id 返回 `409 bot_id_retired`；`GET /api/bots` 不含墓碑；对墓碑的 messages/cancel/retry/history 返回 `410 bot_deleted`。→ bot-deletion 第一例（四条路由逐条断言 410 + `bot_id_retired`）。
- [~] 删除两个 Bot 后，`GET /api/bots`、`/api/platform` 与各 Bot 的工具目录、pin、工作区解析均不受影响；被删 Bot 的工具没有泄漏给其它 Bot。→ 已覆盖"其它会话完好、列表仍含保留 Bot、其它 Bot 的工作区文件逐字节不变"（bot-deletion 第一例）；**未覆盖**：逐项比对其它 Bot 的工具目录与 pin 解析结果（`session` 作用域文档完好已由契约测试 A 覆盖，工具目录／pin 的端到端对比未构造）。
- [~] `inbox`/`deliveries`/`failures` 中该 Bot 的行被删除（以构造行验证），其它 Bot 的行完好；`pendingForBot` 归零。→ 已覆盖：`inbox` 中 `console:<botId>:` 前缀的行在 pass 后为 0、`pending` 归零（bot-deletion 第一例）；**未覆盖**：`deliveries`/`failures` 的引用行（控制台路径不写这两张表，测试没有构造历史行）。
- [~] 工作区文件在删除前后逐字节不变（含共享主机模式下 `default` 的 `/workspaces` 父目录场景）。→ 已覆盖：删除前后同一文件内容逐字节相同（bot-deletion 第一例）；**未覆盖**：共享主机模式下父目录场景的端到端用例。
- [ ] `VACUUM` 在启动窗口执行：文件体积下降、`PRAGMA integrity_check` 通过；`VACUUM` 失败时启动继续并报告。→ 未覆盖：测试只断言 pass 报告与结果收敛，没有测量文件体积或不变量；`VACUUM` 失败路径（`vacuumError` 非空但启动继续）未构造。
- [x] 离线入口在服务运行中拒绝执行；在服务停止时与启动 purge 结果一致。→ bot-deletion：`the offline pass refuses a directory the service owns, and matches the startup pass once it stops`（以**子进程**运行真实入口 `src/bot-purge.ts`，断言退出码 1 与 `SERVICE_RUNNING`，且一行未删；停止后同一份实现给出 `REMOVAL_COMPLETE`）。
- [x] `purge: "now"` 在响应完整写出**之后**才触发退出：客户端收到 202，进程以退出码 0 结束，容器策略将其拉起，启动 purge 清空墓碑；未配置重启策略时不得声称会自行恢复。→ bot-deletion：`purge:now answers completely before the host exits, and the next start reclaims the rows`（202 体完整、`service.done` 自行结束、端口不再应答、退出本身不删行、下一次启动清空）。**容器重启策略本身是部署事实**，由 `docker-compose*.yml` 的 `restart: unless-stopped` 保证，未在本地验证。
- [x] 其它 Bot 有在途工作时 `purge: "now"` 返回 `409 busy_bots` 并列出受影响的 Bot，不打断它们；`force` 不隐含开启 `purge`。→ bot-deletion：`an immediate reclaim is refused while another bot is mid-run, and force alone does not ask for one`。
- [x] 回收前的响应文案与 `BotView.removal` 只声明"用户视角已移除 + 回收时点"，`pendingPurge` 非零；不含"已从存储擦除"这类未成立的表述。→ bot-deletion 第一例（`note` 断言匹配"reclaimed at the next service start"、不匹配 `erased|wiped|from the store`，且此刻存储里的行仍然存在）。
- [x] 超限边界：墓碑数超上限、单次删除行数超上限时按第 5 节处理并明确报告剩余。→ `a removal pass is bounded and says so instead of dropping the rest`（`MAX_REMOVALS_PER_PASS = 64`，余量记 `deferred`）；`a conversation past the row budget is refused whole, not partly deleted`（200000 行上限，整会话拒绝并保留 intent）。
- [x] 类型检查、构建与既有回归全绿；`test/` 新增用例固定运行在已安装底座（1.3.0）的 schema 上，并在底座升级时作为第一道红灯。→ 2026-11-08：`npm run check`、`npm run build`、`npm test` 全部退出 0；契约测试自建 fixture 行、并对**确切列集合**做闸门断言，底座 schema 一变即红。
- [~] 日志与留痕不含 `inbox.text`、工具参数或凭据；`removalReport` 只含表名与行数。→ 已覆盖：`removalReport` 只含 `at`／`mode`／`forced`／`removed`（会话 id）／`rows`（表名→行数）；删除路径只按 id 与作用域过滤，不读取 `text`。**未覆盖**：对日志行做逐字断言（删除日志只记 botId、会话 id、表名与行数，但没有测试把日志抓下来比对）。

## 11. 依据与当前证据边界

本地依据：[ADR-0023](adr/zero-setup-bot-runtime/0023-zero-setup-bot-runtime.md)（决策 9/10/11 及开放项）、[契约与生命周期](contracts-and-lifecycle.md)（"结果未知"的处理原则、投递状态分离）、[ADR-0007](adr/0007-delivery-not-exactly-once.md)、[ADR-0008](adr/0008-unsafe-tool-replay.md)、[Memory 与 Context 设计](memory-and-context-design.md)、[ADR-0013](adr/0013-pi-durable-agent-loop.md)。命名依据 [临时 spec 约定](README.md#按功能的临时规格) 与 [ADR 约定](adr/README.md)。

事实依据来自对**已安装** `@earendil-works/pi-durable@1.3.0` 包内声明的核对（`Storage` 方法集、表名、`mintId()` 的原文承诺、`Conversation.reset()` 只写 `pi.reset`、`Harness.root()` 的"保留会话"契约）与 1.5.0 包的同类核对（`Storage` 方法集未变，仍无删除原语）。1.4.0 将 SQLite 升到 schema 2 且迁移后无法被 1.3.0 打开，依据其 CHANGELOG 原文。

上游：`earendil-works/pi` issue #11026（open）即请求该原语；本项目的用例与上述事实已于 2026-11-07 以明确标注 AI 生成的评论补入该 issue（comment 6708356686）。

部署依据：`docker-compose.yml`（以及 `dashboard/`、`docker-compose.execution.yml`、`docker-compose.rpc.yml` 叠加层）的每个服务都是 `restart: unless-stopped`、`init: true`、`stop_grace_period: 45s`、`mem_limit: 1g`，因此 3.4 的自重启能自行恢复，且优雅关闭有 45 秒预算；`src/main.ts:61-90`、`192-202` 的单一关机控制器与 `close()` 是它复用的路径。

**2026-11-08 更新——"终态但结局未知"的判定已按 1.3.0 的实际记录固定并用测试锁住**：`tasks.status <> 'terminal'` 与 `submissions.status IN ('queued','placed')` 视为**在途**（`work_in_flight`，硬拒绝）；`tasks.status = 'terminal'` 且 `json_extract(record,'$.state.outcome.status') <> 'completed'`、以及 `submissions.status = 'unanswered'` 视为**结局未知**（`unknown_outcome`，默认拒绝、`force` 放行）。判定只读行内状态，不读正文；测试构造的行与底座的真实行同形，因此两个分支无需竞速真实运行即可覆盖。保守方向不变：凡不能归入 `completed` 的一律要 `force`。

**本轮未验证的事**：部署验收未执行（真实容器重启策略拉起、Docker 卷上的 `VACUUM` 行为、真实模型供应商下的端到端删除）；第 10 节以 `[~]`／`[ ]` 标出的条目仍未覆盖（进程级中断、`VACUUM` 的体积与 `integrity_check` 断言、工具目录与 pin 的逐项对比、`deliveries`／`failures` 的历史行、日志逐字断言）。
