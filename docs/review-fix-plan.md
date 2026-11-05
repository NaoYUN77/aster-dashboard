# 历史：代码审查修复执行规划

阅读边界：本文仅记录 2026-10-21、基线 `57ef390` 的修复任务。下文的执行原则、范围排除项、未提交文件和验收要求均属于当时，不作为当前任务指令。后续功能范围由各自的 [临时 spec](README.md#按功能的临时规格) 定义，运行与部署见 [README](../README.md)。

编制日期：2026-10-21。执行对象：DeepSeek 编码代理。审查基线：分支 `feat/mvp-local-verification-and-docker`，提交 `57ef390`。当前本地检查：`npm run check`、`npm test`（27 项）、`npm run build` 均通过。

本文只包含审查已核实的问题。每项给出触发条件、修复要求、必须新增的回归测试和完成标准。工程规范仍以 `CLAUDE.md` 为准；当时的验收流程见 [历史 MVP 执行规划](mvp-execution-plan.md)。

## 执行原则

- 当时仅修本文列出的问题，未纳入底座重构、依赖升级、提供商新增或单用户串行模型调整；该任务边界不限制后续开发。
- 每项先写能失败的回归测试，再改实现；测试使用离线模型替身和临时数据目录，不调用真实 Telegram 或模型。
- 修改完成后 `npm run check`、`npm test`、`npm run build` 全部通过，原 27 项用例不得删除或放宽断言。
- 每项修复完成后在 `docs/mvp-verification.md` 追加记录：触发条件、原行为、修改文件、验证用例。
- 工作区已有两处未提交改动（`Dockerfile` 删除 syntax 声明、`src/deliveries.ts` 增加数据目录缺失提示）。保留它们，不要回滚。
- 修改工具 schema、持久化格式或投递状态语义时，先确认旧记录仍可读取；本次不要求数据迁移。

## F1（P1）底座故障后必须停止接收，而不是继续保存失败回复

### 触发条件

pi-durable 的 Session 遇到 Storage 错误后永久失败（`SessionFailed`）。应用当前在 `src/telegram.ts` 的 `reply` 调用处捕获所有异常，统一生成“本次处理未能完成”的回复并继续轮询。底座已经关闭后，后续每个请求都会立刻失败，但进程仍在运行，进程管理器的 `Restart=on-failure` 也不会触发。

### 修复要求

1. 在 `src/agent.ts` 区分“底座已不可用”和“本次请求失败”。捕获 `SessionFailed`（从 `@earendil-works/pi-durable` 导出）后，重新抛出带稳定错误码（例如 `AGENT_SESSION_FAILED`）的错误，并保留 `cause`。也可直接检查 Harness 的失败状态，但不要复制底座状态机。
2. 在 `src/telegram.ts` 中，致命错误不写入失败回复：请求保持 `pending`，由 `serveTelegram` 向上抛出。非致命错误维持现有行为（保存失败提示、继续处理后续请求）。
3. 同时把 `inbox.saveReply` 等本地存储异常视为致命：本地状态已不可信时继续轮询没有意义。
4. `src/main.ts` 现有顶层捕获在未收到关闭信号时设置退出码 1，配合 systemd `Restart=on-failure` 与 Compose `restart: unless-stopped` 重启进程。确认这条路径生效，并确保重启后请求通过原 requestId 从底座恢复，不会重复执行已完成任务。
5. 日志只记录安全错误码，不输出 SDK 请求对象或凭据。

### 回归测试

- 让 `reply` 抛出 `SessionFailed`（或使用包装 Storage 在写入时抛错，复现真实失败），运行 `serveTelegram`：断言它向调用方抛出、请求仍为 `pending`、没有新增投递记录。
- 重启 `openAgent` 后，同一 requestId 能取回原结果或继续执行；模型调用次数符合契约。
- 普通模型错误（现有 `AGENT_UNANSWERED`）仍生成失败回复并继续处理后续请求，现有测试必须保持通过。

### 完成标准

底座失败后进程退出，不再接收新请求；普通请求失败仍可继续服务。两类错误有测试和日志证据。

## F2（P1）模型输出被长度上限截断时不能当作完整成功

### 触发条件

pi-durable 把 `stopReason === "length"` 与正常结束同样视为答案。`src/agent.ts` 提取文本后直接返回，`serveTelegram` 将其作为成功回复保存投递。用户收到的是不完整内容，且本地没有任何截断标记；重启后仍复用该结果。

### 修复要求

1. 在 `src/agent.ts` 取回答案时检查最后一条 assistant 消息的 `stopReason`。为 `"length"` 时不得按成功返回。
2. 保留已生成的部分文本，并显式标记不完整。推荐实现：抛出带 `code: "AGENT_TRUNCATED"` 和 `partialReply` 的错误；`src/telegram.ts` 捕获后发送“部分文本 + 明确截断说明”，并用现有 `failures` 表记录该错误码。
3. 截断说明使用用户语言，明确内容未完成；不要声称已完整回答。
4. 不要自动重试或继续生成；是否继续由用户决定。完整会话记录仍由底座保存，不因投影文本而丢失。

### 回归测试

- 模型返回 `fauxAssistantMessage("partial answer", { stopReason: "length" })`：断言投递文本包含原部分内容与截断提示，`failures` 中记录 `AGENT_TRUNCATED`，且不会把该文本当作无错误成功。
- 正常 `stopReason: "stop"` 的回复不受影响。
- 空回复仍返回 `EMPTY_REPLY`。

### 完成标准

截断结果有稳定错误码和用户可见说明；重启后不会把截断文本当作完整结果重新投递。

## F3（P1）Docker 备份命令必须备份真实数据卷

### 触发条件

`docker-compose.yml` 的命名卷未设置显式 `name`，Compose 实际创建 `personal-agent-base-durable_personal-agent-data`（前缀为项目名）。README 备份命令挂载 `personal-agent-data`，会创建或备份另一个空卷，命令成功返回，真实数据未被备份。

### 修复要求

1. 在 `docker-compose.yml` 的顶层 `volumes` 中为 `personal-agent-data` 设置显式 `name: personal-agent-data`，使文档、备份命令与实际卷名一致；不要依赖项目目录名。
2. 更新 README 备份段落，写清卷名来源，并增加还原步骤与验证方式（列出归档内容，确认包含 `inbox.sqlite`、`agent.sqlite`、`workspace/MEMORY.md` 及其 WAL 文件）。
3. 明确备份前停止服务、备份后确认归档非空；不要把“命令退出码为 0”当作备份成功的证据。

### 验证

- `docker compose config` 输出中的卷名必须为 `personal-agent-data`。
- 按 README 执行一次备份与还原演练，确认归档包含上述文件；演练结果记录到 `docs/mvp-verification.md`（阶段 F 可执行时补做，本地无 Docker 则标注未执行）。

### 完成标准

文档命令与 Compose 实际卷名一致；备份步骤有可核对的非空检查；还原步骤完整。

## F4（P2）恢复执行必须处在请求超时保护之内

### 触发条件

`src/agent.ts` 在 `openAgent` 中立即调用 `harness.resume()`，早于任何 `reply()` 的 300 秒等待上限。启动时底座会恢复遗留任务并开始执行；此时 `serveTelegram` 可能正在补发另一条已保存回复，被恢复的任务没有超时约束。若该任务卡住，会长期占用唯一执行通道。

### 修复要求

1. 不在 `openAgent` 中恢复执行。改为在 `reply()` 内、提交请求前后调用 `harness.resume()`，确保恢复的每项工作都处于该请求的 `AbortSignal.timeout(300_000)` 等待范围内。
2. 保持现有语义：超时调用 `root.abort()`；正常关闭只停止等待、不取消执行；`close()` 保留可恢复状态。
3. 确认重复提交同一 requestId 仍复用原提交，不会因延迟恢复产生第二次模型调用。

### 回归测试

- 打开 agent 后不调用 `reply`，断言模型调用次数为 0（恢复的遗留任务不会自行运行）。
- 构造一个已提交但未完成的任务，重开后通过 `reply` 等待；断言超过 300 秒上限时触发取消并返回 `AGENT_TIMEOUT`，且任务最终为可恢复状态。可沿用现有测试对 `AbortSignal.timeout` 的 mock 方式。
- 补发已保存回复期间，不应有脱离超时保护的 agent 执行；用模型调用计数和时序断言证明。

### 完成标准

所有 agent 执行都发生在某个 `reply()` 的等待与超时范围内；关闭与恢复语义不变。

## F5（P2）崩溃后遗留的 `sending` 分段必须可被投递 CLI 核查

### 触发条件

进程在发送某分段时被强杀，投递记录停留在 `sending`。`inbox.recover()` 会把 `sending` 转为 `uncertain`，但 `src/deliveries.ts` 打开数据库后没有调用它。于是 `list` 看不到该分段，`resolvePart` 以“Part is not failed or uncertain”拒绝，人工核查无法进行。

### 修复要求

1. 投递 CLI 在打开数据库后、执行 `list`／`retry`／`sent` 前调用 `inbox.recover()`。该操作要求应用已停止，与 README 现有约束一致。
2. `recover()` 的现有语义保持不变：`sending → uncertain`，请求状态同步为 `uncertain`，旧版本整条回复记录补建分段。
3. 更新 README 与契约文档：CLI 核查前会执行恢复；`sending` 不会出现在列表中，恢复后以 `uncertain` 出现。

### 回归测试

- 用 `test/fixtures/crash-inbox.ts` 制造 `sending` 残留，直接以 CLI 逻辑（或 `Inbox` + `recover`）核查：`blocked()` 能看到该段，`retry`／`sent` 可成功执行。
- 恢复后未确认分段仍不会自动重发。

### 完成标准

强杀后无需先启动应用，也能用 CLI 列出并处理遗留分段；重复运行 `recover()` 幂等。

## F6（P3）复用底座的文本提取辅助函数

### 触发条件

`src/agent.ts` 手工展开 assistant 消息的 `content` 并过滤 `text`，与 pi-ai 已导出的 `contentText` 重复。

### 修复要求

- 用 `contentText`（来自 `@earendil-works/pi-ai`）替换手工 flatMap。保留“只取 assistant 消息”“结果 trim”“空文本报 `EMPTY_REPLY`”的现有行为。
- 这是清理项，不改变任何对外行为；不要为此调整测试断言。

### 完成标准

行为不变，原有用例全部通过。

## F7（条件性，P3）Telegram 输入在边界完成运行时校验

审查将该问题判为 PLAUSIBLE：正常 Telegram HTTPS 响应中未证实存在畸形字段，但当前 `toRequest` 只检查私聊、owner 和 `message.text` 为真值，没有验证 `update_id`、`chat.id`、`from.id`、`text` 的类型。缺失或非字符串值会构造 `telegram:99:undefined` 之类的请求标识，或把对象当作文本写入 SQLite。`CLAUDE.md` 要求接口输入按不可信数据处理并在边界校验，因此本项作为边界加固执行。

### 修复要求

1. `toRequest` 增加运行时校验：`update_id` 为安全整数，`chat.id`、`from.id` 为数字或数字字符串，`text` 为字符串；不满足时返回 `undefined`。
2. `serveTelegram` 只在 `update_id` 合法时推进消费位置；非法 update 记录安全诊断后跳过。不要因单条畸形数据陷入重复拉取同一批次，也不要静默把无效 ID 写入 checkpoint。
3. 增加边界测试：缺 `update_id`、缺 `chat.id`、对象型 `text`、非 owner、群聊均被拒绝，且合法请求不受影响。

### 完成标准

畸形 update 不产生内部请求、不写入非法标识；合法路径行为不变。

## 执行顺序

1. F1、F4（同改 `src/agent.ts`、`src/telegram.ts`，先做 F1 再调整恢复时机）。
2. F2（`src/agent.ts`、`src/telegram.ts`）。
3. F5（`src/deliveries.ts`、文档）。
4. F7（`src/telegram.ts`）。
5. F3（`docker-compose.yml`、README；有 Docker 环境时演练）。
6. F6（清理，最后做）。

每完成一组运行一次类型检查与相关测试；全部完成后运行全量检查。

## 最终验收

| 检查 | 要求 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 全部通过，原 27 项保留，新增回归用例覆盖 F1、F2、F4、F5、F7 |
| `npm run build` | 通过 |
| 文档 | `docs/mvp-verification.md` 有每项修复记录；README 备份与投递说明与实际一致 |
| 范围 | 未新增提供商、未改变单用户串行模型、未引入新依赖 |
| 遗留 | F3 的 Docker 演练若无环境则标记未执行，不得写成已通过 |

完成后输出：修改文件清单、新增测试名称、三项检查结果、未执行项及原因。
