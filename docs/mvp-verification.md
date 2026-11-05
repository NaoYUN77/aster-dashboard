# 历史：MVP 验收记录

历史记录：以下结果、测试数量、待办和阻塞对应各节所列日期与部署配置，不代表当前开发范围或生产状态，也不证明当前 Aster 镜像已通过相同验收。原七条标准见 [历史 MVP 执行规划](mvp-execution-plan.md#原-mvp-七条验收标准历史)。新功能的规格约定见 [文档索引](README.md#按功能的临时规格)，当前运行证据见 [README](../README.md#已验证与尚未验证)。systemd 安装入口现已退役，运行及迁移说明见 [部署指南](deployment-test-guide.md)。

当时状态：本地验证完成；Docker 镜像构建、命名卷备份／还原与 systemd 安装脚本已在容器中演练；真实 Telegram／模型联调与真实 Linux 主机部署待验收。

## 环境与基线

- 日期：2026-10-21。
- 操作系统：Windows 11 Home China 10.0.26200（win32 x64）。本地结果不代表 Linux 信号与子进程行为，相关项见阶段 F。
- 运行时：Node.js v24.19.0（`.node-version`）、npm 11.17.0。
- 依赖：`package.json` 固定版本；`npm ls --depth=0` 退出 0，`npm ci --dry-run` 退出 0，无需重装。
- 数据目录：测试使用操作系统临时目录（`mkdtemp`）并在结束时删除；仓库 `./data` 未被测试写入。
- 外部服务：全部离线。模型使用 `@earendil-works/pi-ai/providers/faux`，Telegram 使用进程内替换客户端；未调用真实模型或 Telegram API。

接手时基线命令：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 13 项通过，0 失败 |
| `npm run build` | 通过 |

本轮完成后的最终命令（在最终代码上）：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 27 项通过，0 失败、0 取消、0 跳过（约 12 秒） |
| `npm run build` | 通过 |

## 阶段结果

| 阶段／场景 | 状态 | 命令或步骤 | 结果与证据 | 剩余事项 |
| --- | --- | --- | --- | --- |
| A 可复现基线 | 通过 | `npm run check`／`npm test`／`npm run build` | 三项均通过；初始 13 项用例全部通过 | 无 |
| B1 文档与实现对齐：顺序工具执行 | 通过 | 测试 `sequential tool execution prevents overlapping calls in one round` | 同一回合两个工具调用不重叠（最大并发 1，顺序为调用顺序）；`src/agent.ts:34` 已配置 | 无 |
| B1 文档与实现对齐：`prune()` 保留策略 | 通过 | 测试 `prune retains the newest 100 sent requests and every unfinished request` | 修复前子查询取全部请求的最新 100 条，会误删较旧的已发送记录；修复后只保留最新 100 条 `sent`，未完成请求全部保留，级联删除投递与诊断 | 无 |
| B2 工具边界与资源限制 | 通过 | 见“资源边界”；测试 `SQLite harness rejects invalid custom-tool arguments before execution`、`bash output is bounded…`、`read truncation names the offset…` | 非法参数经底座校验路径拒绝；bash／read 截断带可见诊断与继续路径 | 见“待办与阻塞”中的非阻塞限制 |
| C 接收事务与重复请求 | 通过 | `inbox rejects identity and request-content conflicts without advancing offset`、`inbox keeps identical text under different request IDs as separate requests` | 同 ID 同内容幂等；同 ID 不同内容报错且 offset 不前移；同内容不同 ID 是两个请求 | 无 |
| C 已提交但应用未记录结果 | 通过 | `agent memory tools survive reopening and completed requests are not executed again` | 重开数据库后同一 requestId 返回已提交答案，模型调用数为 0 | 无 |
| C 回复已保存、尚未投递 | 通过 | `restart preserves confirmed segments and quarantines only the interrupted send`、`a crash while a segment is sending quarantines it and later sends only stored text` | 进程强杀后重开，保存的回复继续投递，不重跑 agent | 无 |
| C 多段部分成功 | 通过 | `restart preserves confirmed segments…`、`reconciling partial delivery sends stored remainder without rerunning agent` | 已确认段保持 sent，只处理未确认段 | 无 |
| C 发送明确失败与结果未知 | 通过 | `Telegram rejection is failed while a transport failure is uncertain, and neither resends` | 4xx 记为 `failed`（TELEGRAM_403），传输失败记为 `uncertain`；两者都不自动重发，后续独立请求继续处理 | 真实网络未知窗口需阶段 E |
| C 人工核查补发 | 通过 | `reconciling partial delivery sends stored remainder without rerunning agent`、`manual confirmation marks only the named segment sent and continues with later parts`、崩溃投递测试 | `retry`／`sent` 只调整指定段；后续发送复用已保存文本，agent 执行次数不变 | 无 |
| C 工具失败后修正 | 通过 | `SQLite harness rejects invalid custom-tool arguments before execution` | 非法参数不进入执行函数，模型收到错误结果并继续回合 | 无 |
| C 工具中断重放 | 通过 | `an interrupted safe tool follows its replay policy after a process crash`、`…unsafe…` | 子进程在工具执行中被强杀；`safe` 工具恢复后重跑（副作用计数 2），`unsafe` 工具不再执行（计数 1），结果为 `isError: true` 且包含 “interrupted and may have partially run” | 无 |
| C 实际执行取消 | 通过 | `aborting a run kills a running bash command and its child process`、`explicit cancellation reaches the model…` | 取消信号到达模型提供方与 bash 进程及其子进程；命令预设的 5 秒延迟写入在取消后未发生 | Linux 进程组行为留待阶段 F 复测 |
| C 正常关闭与进程崩溃 | 通过 | `shutdown stops waiting while close preserves an unfinished request for reopening`、两个崩溃测试 | 正常关闭保留未完成请求；强杀后按契约恢复执行与投递 | 无 |
| D 本地可运行版本 | 通过 | 见“最终交接” | 配置缺失时输出 `Missing configuration: TELEGRAM_OWNER_ID` 并以退出码 1 结束；文档与实现一致 | 无 |
| E 真实 Telegram 与模型联调 | 阻塞 | 需要 bot token、owner ID、模型凭据及联调授权 | 未执行 | 见“待办与阻塞” |
| F 4 核／4 GB Linux 部署验收 | 阻塞 | 需要目标主机与部署授权 | 未执行 | 见“待办与阻塞” |

## 修复记录

### 1. `prune()` 误删已发送记录

- 触发条件：本地同时存在大量未完成请求时调用 `inbox.prune()`。
- 原行为：子查询 `SELECT requestId FROM inbox ORDER BY rowid DESC LIMIT 100` 取全部请求的最新 100 条，再删除不在其中的 `sent` 请求。未完成请求占满这 100 条时会提前清理已发送历史；与 README 和契约文档“保留最近 100 条已完成请求”不一致。
- 修复文件：`src/inbox.ts:149`。
- 修复方式：子查询限定 `status = 'sent'`，只对 `sent` 记录按最新 100 条保留；未完成请求不参与清理。`deliveries`、`failures` 通过外键 `ON DELETE CASCADE` 随请求删除。
- 验证方法：`prune retains the newest 100 sent requests and every unfinished request`，使用 120 条已发送请求与 4 种未完成状态混合，断言保留数量、级联清理与未完成请求存活。

本轮未发现其他本地产品缺陷。既有实现与文档描述一致，测试仅补齐证据。

## 资源边界

| 资源 | 实际限制 | 执行位置 | 超限行为 | 验证证据 |
| --- | --- | --- | --- | --- |
| Telegram 更新批次 | 每次 `getUpdates` 最多 10 条，长轮询 25 秒 | `src/telegram.ts:39` | 更多消息留在 Telegram 远端；处理完本地待办后再轮询 | 代码与 README；本批次不构造本地无限队列 |
| 用户输入 | Telegram 单条文本上限 4096 UTF-16 单元；应用对超过 16000 单元的已存请求返回明确提示 | `src/telegram.ts:84` | 不执行 agent，生成“消息过长，请拆分后再发送。”的待投递回复，不静默丢弃 | `oversized input is refused explicitly instead of being silently dropped` |
| 单请求等待时间 | 300 秒 | `src/agent.ts:54` | 停止等待并调用 `root.abort()` 取消执行；回复提示已执行操作可能仍生效 | `request timeout cancels provider work before reporting AGENT_TIMEOUT` |
| 工具参数 | TypeBox schema 在执行前校验；`current_time` 显式 `additionalProperties: false`，未知字段被拒绝。内置工具的 schema 未声明 `additionalProperties: false`，未知字段通过校验后被执行函数忽略 | pi-ai `validateToolArguments` → Harness `ToolTask` | 返回 `invalid_arguments` 错误结果，不执行工具，模型可修正参数 | `custom tool schemas reject unknown arguments before execution`、`SQLite harness rejects invalid custom-tool arguments before execution` |
| bash 输出 | 保留末尾 2000 行或 50 KB（先到者为准）；完整输出溢出到临时文件 | pi-durable `createBashTool`／`OutputBuffer`／`spill` | 模型收到删减后的输出，并在结果中看到 `Output truncated to its end` 与 `Full output: <path>` 诊断 | `bash output is bounded and the model is told where the full output went` |
| read 输出 | 返回头部 2000 行或 50 KB；支持 `offset`／`limit` | pi-durable `createReadTool`／`truncateHead` | 诊断给出 `Use offset=<n> to continue.`；超长单行给出行内截断与 bash 续读命令 | `read truncation names the offset that continues the file` |
| write／edit 输出 | 面向模型的文本固定为简短确认；diff 与 patch 放在 `details`，不作为模型输出 | pi-durable `createWriteTool`／`createEditTool` | 不产生无上限的模型可见工具输出 | 已安装 1.3.0 源码核查 |
| bash 执行时长 | 无每次命令默认超时；模型可传 `timeout`（秒）；整体受 300 秒请求上限约束 | pi-durable `createBashTool`；`src/agent.ts` | 请求超时触发取消，进程组被终止（Linux `detached` + `SIGKILL` 进程组；Windows `taskkill /T`） | `aborting a run kills a running bash command and its child process`；Linux 行为留待阶段 F |
| 工具并发 | 全局 1 个用户请求；回合内工具顺序执行 | `src/agent.ts:34` | 不出现同一回合工具重叠 | `sequential tool execution prevents overlapping calls in one round` |
| 本地待处理请求 | 每次轮询最多接收 10 条；本地待办清空后才继续轮询 | `src/telegram.ts` `serveTelegram` | 积压留在 Telegram；长期离线不在可靠收件保证内 | 代码与 README |
| 本地历史 | 已发送请求保留最新 100 条；`pending`／`ready`／`failed`／`uncertain` 永不自动清理 | `src/inbox.ts:149` | 清理时级联删除投递与诊断记录 | `prune retains…` |
| 回复长度 | 由所选模型的输出上限约束；按 4000 UTF-16 单元分段，不切开代理对 | `src/messages.ts` `splitReply` | 每段独立确认；未另设应用级总长度上限 | `reply chunking preserves text including Unicode surrogate pairs` |
| 底座持久化 | `agent.sqlite`、`workspace/` 由底座和 agent 管理，无应用级保留策略 | pi-durable | 随会话增长；备份与磁盘监控见阶段 F | 安装版本源码核查 |

已知非阻塞限制：最终回复没有应用级总长度上限，极端长回复会产生大量分段并可能触发 Telegram 频率限制；被阻塞的 `failed`／`uncertain` 请求与投递记录只在人工核查后转移状态，期间不会自动清理；底座数据库与会话历史未设置应用级清理策略。三者都不影响当前单用户 MVP 的正确性，但在阶段 F 的资源测量中需观察积压与磁盘增长。

## 代码审查修复记录（2026-10-21）

审查基线为提交 `57ef390`，修复范围见 [review-fix-plan.md](review-fix-plan.md)。按 F1–F7 顺序执行；每项先补回归用例再改实现。本轮 `npm run check`、`npm test`（38 项）、`npm run build` 全部通过。

### F1 底座故障后停止接收

- 触发条件：pi-durable Session 因 Storage 错误永久失败后，`serveTelegram` 仍把每次异常当作单次请求失败，继续轮询并保存失败提示。
- 原行为：`SessionFailed` 被统一转换为“本次处理未能完成”的回复，进程保持运行，进程管理器不会重启；后续请求必然失败。
- 修复文件：`src/agent.ts`、`src/telegram.ts`。
- 修复方式：`reply()` 捕获 `SessionFailed` 后抛出带 `code: "AGENT_SESSION_FAILED"` 且保留 `cause` 的错误。首个 Storage 错误在 Session 锁存前会以原始错误形式抛出，因此持久化调用抛出的非请求级错误（超时、未回答、截断、空回复之外）同样按会话失效处理，`cause` 统一为 `SessionFailed`；宿主关闭信号仍按原样向上抛出。`serveTelegram` 对致命错误不写回复、不投递，直接向上抛出，请求保持 `pending`。`confirmPart` 移到发送 `try` 之外，本地写入失败不再被误记为 Telegram 投递失败。`src/main.ts` 顶层捕获在未收到关闭信号时设置退出码 1，配合 systemd `Restart=on-failure` 与 Compose `restart: unless-stopped`。
- 验证用例：`a failed agent session stops polling and leaves the request pending`（注入 `SessionFailed`，断言向上抛出、无投递、请求仍 pending）、`a local storage failure while saving a reply is fatal`、`a model failure is delivered as a notice and later requests still run`（普通失败仍继续服务）、`a failed agent session is fatal and the same request recovers after restart`（重启后同一 requestId 取回答案，模型调用计数为 1）。

### F2 长度截断不按完整成功处理

- 触发条件：模型以 `stopReason: "length"` 结束。
- 原行为：部分文本被当作完整答案保存并投递，用户与本地记录都没有截断标记。
- 修复文件：`src/agent.ts`、`src/telegram.ts`。
- 修复方式：取回答案后检查最后一条 assistant 消息的 `stopReason`；为 `length` 时抛出带 `code: "AGENT_TRUNCATED"` 与 `partialReply` 的错误。投递层保留部分文本并追加“回复因长度限制被截断，内容不完整。请拆分请求后重试。”，错误码写入 `failures`。不自动续写或重试；底座完整会话记录不变。
- 验证用例：`a length-limited answer is reported as truncated with its partial text`、`a truncated agent answer is delivered with an explicit incompleteness notice`；原有 `stopReason: "stop"` 与 `EMPTY_REPLY` 用例保持通过。

### F3 Docker 备份卷名

- 触发条件：Compose 未设置显式卷名时实际卷名为 `<项目目录名>_personal-agent-data`，README 的备份命令挂载 `personal-agent-data` 会新建空卷并“成功”返回。
- 修复文件：`docker-compose.yml`、`README.md`。
- 修复方式：顶层 `volumes.personal-agent-data` 增加 `name: personal-agent-data`；README 写明卷名来源，备份步骤增加归档内容检查（`inbox.sqlite`、`agent.sqlite`、`workspace/MEMORY.md` 与 WAL/SHM），并补充还原步骤与启动后核对。
- 验证（2026-10-21，Windows + Docker 29.7.2 / Compose v5.3.1）：
  - `docker build -t personal-agent:local .` 成功，镜像 468 MB。
  - `docker compose config` 显示 `volumes.personal-agent-data.name: personal-agent-data`，与项目目录名无关。
  - 备份：向卷写入 `agent.sqlite`、`inbox.sqlite`、`workspace/MEMORY.md` 后执行 README 的 `alpine tar czf` 命令，退出码 0；`tar tzf | grep` 列出三个文件，归档 3964 字节。
  - 还原：先删掉 `inbox.sqlite` 并追加 `MEMORY.md`，再执行 README 的 `rm -rf /data/* … && tar xzf`，文件恢复为备份时内容，属主仍为 `node`（uid 1000）。用应用自己的 `Inbox` 打开还原后的库，读到 `offset 10` 与原请求；`openNodeSqliteStorage` 能打开 `agent.sqlite`。
  - 投递 CLI：容器内 `node dist/src/deliveries.js list` 输出 `{"blocked":[],"failures":[]}`；人工制造 `sending` 残留后再次 `list`，该分段以 `uncertain` / `PROCESS_INTERRUPTED` 出现，与 F5 的恢复行为一致。
  - 无配置启动：容器打印 `Personal agent stopped: Missing configuration: TELEGRAM_OWNER_ID` 并以 1 退出。
  - 镜像内 `/bin/bash` 存在（Debian bookworm slim），`flock` 可用，`runuser`／`useradd` 不可用（运行时不需要）。
  - 未覆盖：真实容器内的 Telegram 轮询与模型调用（无凭据），以及 Linux 主机上的内存、停止宽限期与 OOM 行为（阶段 F）。

### F4 恢复执行纳入请求超时

- 触发条件：启动时 `openAgent` 立即调用 `harness.resume()`，恢复的任务不受任何 `reply()` 的 300 秒等待上限约束。
- 原行为：恢复的遗留任务可能在补发其他回复期间长期占用唯一执行通道。
- 修复文件：`src/agent.ts`。
- 修复方式：移除 `openAgent` 中的 `harness.resume()`，改在 `reply()` 内创建 300 秒等待信号后、提交请求前调用。超时仍调用 `root.abort()`；关闭仍只停止等待并保留可恢复状态。
- 验证用例：`reopening does not start recovered work until a reply is waiting`（打开后 200 ms 内模型调用数为 0，`reply` 后为 1）、`a recovered task is bounded by the waiting reply's timeout`（恢复任务在等待超时时被取消，再次提交不产生第二次模型调用）。

### F5 投递 CLI 先执行恢复

- 触发条件：进程在发送分段时被强杀，`deliveries` 记录停留在 `sending`；CLI 打开数据库后不调用 `recover()`。
- 原行为：`list` 看不到该分段，`retry`／`sent` 报 “Part is not failed or uncertain”，人工核查无法进行。
- 修复文件：`src/deliveries.ts`、`README.md`、`docs/contracts-and-lifecycle.md`。
- 修复方式：CLI 打开数据库后先调用 `inbox.recover()`，再执行 `list`／`retry`／`sent`。文档说明 `sending` 不会直接出现在列表中，恢复后以 `uncertain` 出现。
- 验证用例：`delivery CLI recovers an interrupted send before listing and resolving it`（用 `crash-inbox.ts` 制造 `sending` 残留，CLI `list` 可见、`retry` 成功、重复 `recover()` 幂等、未确认分段不自动发送）。

### F6 复用底座文本提取

- 修复文件：`src/agent.ts`。
- 修复方式：用 pi-ai 导出的 `contentText` 替换手工 `flatMap`，保留只取 assistant 消息、`trim` 与空文本 `EMPTY_REPLY` 的行为。
- 验证：原有回复、失败码与重启用例全部通过，断言未调整。

### F7 Telegram 输入边界校验

- 触发条件：`toRequest` 只检查私聊、owner 和 `message.text` 真值，不验证 `update_id`、`chat.id`、`from.id`、`text` 的类型；畸形数据会构造 `telegram:99:undefined` 或把对象写入 SQLite。
- 修复文件：`src/telegram.ts`。
- 修复方式：`update_id` 必须为非负安全整数；`chat.id`、`from.id` 接受安全整数或数字字符串并统一为字符串；`text` 必须为非空字符串。`serveTelegram` 只在 `update_id` 合法时推进消费位置，非法 update 记录不含内容的安全诊断后跳过，避免重复拉取同一批次或写入 `NaN`。
- 验证用例：`malformed Telegram updates are rejected at the boundary`、`invalid updates are skipped without writing an unusable checkpoint`。

### 本轮命令结果

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过（无输出） |
| `npm test` | 通过：38 项，0 失败，0 取消，耗时约 14.2 s |
| `npm run build` | 通过（无输出） |

测试总数由 27 项增至 38 项，新增 11 项回归用例覆盖 F1、F2、F4、F5、F7；原 27 项全部保留且断言未放宽，其中 F6 未改动任何既有断言。首次检查时 `test/durable.test.ts` 的 `options` 可能为空导致两处 TS18048，已按既有用例写法补 `assert.ok(options?.signal)` 后通过。

## 待办与阻塞

### 阶段 E：真实联调（阻塞）

缺少：可用测试 bot 的 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_OWNER_ID`、受支持提供商的 `MODEL_PROVIDER`／`MODEL_ID`／API key，以及用户对测试环境的联调授权。

当时影响：原 MVP 七条验收中与真实 Telegram、真实模型、真实记忆文件相关的结果尚未取得。离线测试已覆盖同一边界逻辑。

下一步：配置隔离的 `DATA_DIR` 与测试凭据后，按阶段 E 六项逐条记录时间、请求标识与脱敏观察。

### 阶段 F：Linux 部署验收（阻塞）

缺少：4 核／4 GB 目标主机与部署授权。

已准备：`Dockerfile`、`docker-compose.yml`（命名卷 `/data`、非 root 用户、3 GB 内存上限、`init`、45 秒停止宽限期），`deploy/personal-agent.service`、`deploy/install-systemd.sh` 与 `deploy/README-systemd.md`（`flock` 单实例、`MemoryMax=1G`、`TasksMax=64`、`ProtectSystem=strict` 下只写数据目录），以及 README 和 [deployment-test-guide.md](deployment-test-guide.md) 的两种部署、备份和投递核查步骤。

2026-10-21 在容器内补充验证（Windows Docker Desktop，`node:24.19.0-bookworm-slim` 承载安装脚本，`systemctl` 用桩记录调用，不实际启动 unit）：

- 首次安装：创建用户、目录、`/etc/personal-agent.env`（root 600，`DATA_DIR` 已替换），`npm ci && build && prune` 成功，`dist/src/*.js` 齐全，devDependencies 已裁剪；生成 unit 的 `ExecStart` 指向实际 Node 路径与 `flock`。
- 重复执行：代码与 unit 被替换，`/var/lib/personal-agent` 的既有文件与已有配置未被覆盖。
- 配置为空：只执行 `daemon-reload` 与 `enable`，不 `start`。
- 仅配置 `openai` 且 `ANTHROPIC_API_KEY` 为空：正常启动（修复前会误判为“配置仍为空”）。
- 仅配置 `anthropic` 且 `ANTHROPIC_API_KEY` 为空：不启动。
- 必需键整行缺失（`TELEGRAM_BOT_TOKEN`）、被注释（`# MODEL_ID=…`）、值为空（`MODEL_ID=`）、以及 `openai` 配置下缺少 `OPENAI_API_KEY`：均不启动。修复前只匹配“键存在但值为空”，前两种会被误判为已配置。
- `DATA_DIR` 与 `ReadWritePaths` 不一致、`MODEL_PROVIDER` 非法、从 `/opt/personal-agent` 自身运行、Node 位于 `/root` 或 `/home`：均以 `error:` 退出，且前两者在触碰 systemd 之前终止。
- 从 `777` 权限的检出安装后，`/opt/personal-agent` 为 `755`（修复前会保留 `777`）。

以上验证暴露并修复了五个安装脚本缺陷：把所选提供商之外的 API key 当作必填、配置校验发生在 `systemctl` 之后、只拦截 `/home` 下的 Node 而未拦截 `/root` 与 `/run/user`（`ProtectHome=true` 同样隐藏这些路径）、从宽松权限检出复制后代码目录权限过宽、必需键整行缺失或被注释时仍判定为已配置。

仍需在真实 Linux 主机补测：Node 版本与权限、单实例（systemd `flock` 或单容器约束）、SIGTERM 与 45 秒停止宽限期的配合、强杀恢复、Linux 进程组取消、内存与磁盘峰值、日志脱敏、停止后整目录备份与还原演练、容器内 bash 工具可用性。

### 平台覆盖说明

本地为 Windows。取消测试通过 `taskkill /T` 证明 Windows 进程树终止；Linux 依赖 pi-durable 的 `detached` 子进程与进程组 `SIGKILL`，已核对 1.3.0 实现但未在 Linux 运行，阶段 F 必须复测，不能以本地通过代替。

### 其他

- 真实网络“发送已到达但确认丢失”的未知窗口无法稳定制造，当前由故障注入测试证明状态区分；与真实 Telegram 的差异需在阶段 E 注明。
- 内置 `read`／`write`／`edit`／`bash` 未声明重放安全（默认 `unsafe`）：进程崩溃时中断的调用会得到“interrupted and may have partially run”错误结果，而不是自动重跑。这是当前实现的保守选择。

## 最终交接

### 本批变更文件（提供商注册表）

- `src/providers.ts`（新）：`PROVIDERS` 注册表是支持范围的唯一来源，登记 12 个显式 API-key 提供商（`anthropic`、`openai`、`deepseek`、`google`、`xai`、`mistral`、`groq`、`moonshotai`、`moonshotai-cn`、`minimax`、`zai`、`openrouter`），每项只保存工厂、展示名与 key 变量名。`createProviderModels()` 按 id 建模型集，`requireModel()` 在启动前校验 `MODEL_ID` 是否在目录中。
- `src/errors.ts`（新）：`ConfigurationError` 独立成模块，供配置与提供商注册表共用，避免循环依赖。
- `src/config.ts`：`MODEL_PROVIDER` 从注册表派生合法值，只要求所选提供商的 key；错误信息列出全部合法 id。
- `src/agent.ts`：删除 `anthropic`／`openai` 的 if/else，改用注册表；对注入的离线模型集同样执行 `requireModel()`。
- `src/check-config.ts`（新）：不联网的配置检查入口，供安装脚本与手动排查使用；只输出变量名，不回显凭据。
- `deploy/install-systemd.sh`：删除 shell 内硬编码的提供商/key 映射，改为构建后调用 `check-config.js`；检查在 `enable` 之后、`start` 之前执行。
- `.env.example`、`README.md`、`deploy/README-systemd.md`、`docs/deployment-test-guide.md`：支持矩阵、key 变量、新的错误信息与检查命令。
- `test/boundaries.test.ts`：新增注册表与 pi-ai 内置提供商一致性、所选提供商只需自身 key、未知 `MODEL_ID` 报错三项用例；配置错误断言更新为新的提示文本。

未包含：OAuth／订阅登录、Bedrock／Vertex 等环境凭据提供商、需要额外端点参数的提供商（Azure、Cloudflare 等），以及自定义 base URL。这些路径无法只靠一个 key 从环境文件完成配置，因此不进入注册表。

### 本批变更文件（Docker 与安装脚本验证）

- `deploy/install-systemd.sh`：配置校验（`DATA_DIR`、`MODEL_PROVIDER`、当前提供商的 API key）改为在构建前和触碰 systemd 前各执行一次；Node 路径检查覆盖 `/root`、`/run/user`；复制后把代码目录重置为 `755`。
- `deploy/README-systemd.md`、`docs/deployment-test-guide.md`：同步脚本行为、失败信息与 `ProtectHome` 覆盖范围。

### 本批变更文件（代码审查修复）

- `src/agent.ts`：F1 会话失效统一为 `AGENT_SESSION_FAILED`；F2 长度截断返回 `AGENT_TRUNCATED` 与部分文本；F4 `resume()` 移入 `reply()`；F6 改用 `contentText`。
- `src/telegram.ts`：F1 致命错误直接上抛且不写回复；F2 截断提示；F7 输入边界校验与非法 update 跳过。
- `src/deliveries.ts`：F5 操作前执行 `recover()`（保留原有的数据目录缺失提示）。
- `docker-compose.yml`：F3 显式卷名。
- `README.md`、`docs/contracts-and-lifecycle.md`：F2、F3、F5 行为与操作说明。
- `test/boundaries.test.ts`、`test/durable.test.ts`、`test/recovery.test.ts`：新增 11 项回归用例。

### 本批变更文件（此前本地验证）

- `src/inbox.ts`：修正 `prune()` 保留策略。
- `test/boundaries.test.ts`：新增保留策略、相同文本不同 ID、发送失败分类、输入上限、配置错误及人工确认分段测试。
- `test/durable.test.ts`：新增顺序工具执行与自定义工具未知字段测试。
- `test/recovery.test.ts`：新增崩溃恢复、工具重放、取消 bash、工具输出截断测试。
- `test/fixtures/crash-tool.ts`、`test/fixtures/crash-inbox.ts`：崩溃窗口子进程夹具。
- `docs/contracts-and-lifecycle.md`：顺序执行与本地保留策略改为当前事实。
- `README.md`：本地保留策略表述与实现一致；新增 Docker 部署、备份与投递核查步骤。
- `Dockerfile`、`docker-compose.yml`、`.dockerignore`：容器部署配置。
- `docs/mvp-verification.md`：本记录。

### 检查结果

- 类型检查通过；41 项测试全部通过；生产构建通过。
- Docker 镜像构建成功；无配置启动以退出码 1 结束并打印明确的缺失项。
- Docker 命名卷的备份、内容核对、还原与投递 CLI 恢复已在容器中实际执行。
- systemd 安装脚本在容器中完成安装、重复执行与失败路径验证；`systemctl` 为桩，unit 未实际启动。
- 未执行任何真实外部调用（Telegram、模型提供商）。

### 真实联调与部署结果

未执行。阶段 E、F 仍为阻塞，当前状态是“本地验证与容器演练完成，真实联调／Linux 主机部署待验收”，不等同于 MVP 已上线。

### 启动入口

见 README：`npm ci`、配置 `.env`、`npm run check && npm test && npm run build && npm start`。
