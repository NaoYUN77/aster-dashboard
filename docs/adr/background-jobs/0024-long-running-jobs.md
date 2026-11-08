# ADR-0024：长任务转为后台作业，并在完成时回报

- **状态**：Accepted
- **日期**：2026-11-08
- **功能**：background-jobs

## 上下文

现状事实，均可在仓库内核对：

- 一条请求的等待预算写死 300 秒（`src/agent.ts:451`），到点先 `conversation.abort()` 再抛 `AGENT_TIMEOUT`（`src/agent.ts:463-464`）。该基线已作为验收记录在案（`docs/mvp-verification.md:72`），并有两条断言钉住字面量（`test/durable.test.ts:251,338`）。
- 底座把后台当作边界：`{ background: true }` 的任务不被 `conversation.abort()` 标记，也不进入 `waitForIdle`（`@earendil-works/pi-durable` `dist/harness/types.d.ts:623-632`）；README:574 写明此类任务 "survives the parent's abort and does not keep the parent busy"。
- 不设 `abandonOnRestart` 的后台任务跨进程重启继续跑；设了才会被标记 `restart`（`types.d.ts:249-254,489-496`）。被标记的任务必须在一次新的 invocation 里提交终态（`types.d.ts:214-215`）。
- 本仓已有活样本：MEM-05 归档任务（`src/memory/archive-task.ts:409`，`phases` 与 `abort` 形态见 `:123-125,:332-337`）。
- README:579 的 `23-subagent-background` 给出后台任务的参考实现：后台锚任务持有工作，完成时由后台 reporter 以稳定 request ID 把答案作为 follow-up input 回投父会话。**本决策不采用 reporter 回投**（见决策 5、8 与文末历史），引用它只为确认底座的后台能力边界。
- `harness.taskGraph()` / `watchTaskGraph()` 提供 live 任务视图，明确是给任务面板用的；**终态任务不在其中**（README:610）。`harness.getTask(id)` 才是持久真相入口。
- 执行面并发：`EXECUTION_AGENT_MAX_CONCURRENT` 默认 4（`src/execution/rpc-config.ts:279`），共享执行主机 runbook 现行显式值为 3（`docs/runbook-shared-execution-host.md:88`）；超限返回 `busy` 且结果为 `not_started`（`src/execution/rpc-server.ts:448-449`），即未执行、可安全重试。
- 操作者报告执行机公网出口为 1 Mib/s（未在仓库中独立核对）。它决定了前台路径的天花板由 RPC 线路而非预算封顶：单次执行 `timeoutMs` ≤ 3,540,000 ms（`src/execution/rpc-protocol.ts:22,41,652`），即 59 分钟。
- 现行契约把控制台回复定为终态，且明确不创建分段投递记录（`docs/contracts-and-lifecycle.md:160`）；ADR-0007 已标为已废弃，但保留"结果未知不等于未发送、失败不自动重发、投递失败不重跑 agent"的语义。

## 决策驱动因素

- 等待预算追不上"体积 ÷ 带宽"：预算必须 ≥ 任务的挂钟时间，而体积不可控，带宽由云厂商给定。把预算抬高只是把失败点往后推。
- 后台不等于并行。底座让任务脱离请求的生命周期，不提供模型侧的并行保证；单 bot 的 worker 仍是串行的（`src/bot-manager.ts:723-754`）。
- CLAUDE.md 的硬约束：输入、输出、时长与并发须有边界；结果未知须明确记录，不得当作未执行；下游幂等键由宿主生成且重试保持稳定；展示回复与运行记录分离。
- ADR-0022 的既有理由依然成立：以用户请求为单位的账本无法承载"生命周期由触发时刻定义"的对象。

## 备选方案

- **抬高请求预算。** 只对时长可预测的 CPU 型长任务成立；带宽型任务的时长是体积的函数，1 GiB 在 1 Mib/s 下约 2.3 小时，已超过 RPC 线路 59 分钟的硬上限。且与已验收契约行及两条既有断言正面冲突。
- **提示词绕过（`setsid nohup` 派出去再轮询）。** 不受管、控制台看不见、留下无人回收的进程，并且刻意绕开仓库已文档化的进程组终止行为（`docs/mvp-verification.md:77`）。
- **只延长控制台回复的保留。** 解决不了"人不在时收不到"，也没回答"任务在不在跑"。
- **把完成通知塞进 `inbox`/`deliveries`。** `deliveries.requestId` 非空且外键指向 `inbox`（`src/inbox.ts:109`），作业通知没有请求可挂；ADR-0022 已就同一形状否决过一次。
- **（采纳）后台作业 + 完成回报。**

## 决策

1. **作业是后台任务。** 用 `{ background: true }` 的底座任务承载执行，**不设** `abandonOnRestart`，因此任务本身跨进程重启续跑；abort 协议必须实现，并提交终态。续跑不等于重放命令：一条命令一旦交给执行环境，重启后不重放，记为 `unknown`（见文末历史）。
2. **每个作业有自己的工作目录**：`<bot 工作目录>/jobs/<uuid>/` —— 目录名取 `jobId` 的末段（`job:<botId>:<uuid>`），即作业自己的 UUID；`jobId` 里带 `:`，直接做目录名在 Windows 上不是合法路径。bot 工作目录由 `src/bot-manager.ts:603-613` 派生，始终落在 `/shared` 或 `/workspaces` 之下，满足 `src/config.ts:347` 的校验。
3. **状态有独立索引表 `background_jobs`**，用于列举与回答"哪些作业做完了"；终态真相以 `harness.getTask(taskId)` 为准。`taskGraph` 只覆盖 live 任务，不能当作索引。
4. **模型侧只有"看"和"取消"，没有等待。** 工具为 `job_start` / `job_list` / `job_status` / `job_cancel`，名字一律用下划线：工具名是发给模型的**线上值**，OpenAI 兼容端点要求它匹配 `^[a-zA-Z0-9_-]+$`，一个点号会让每个 bot 的**每个请求**在模型运行之前就被 400 拒掉（2026-11-08 实际发生过一次）。任何 `job_wait` 都会把请求重新挂住，等于退回 300 秒陷阱。
5. **完成后由宿主直接落通知，不经过模型。** 作业进入终态时写一行确定性通知（命令、退出码、耗时、输出尾）。它准确、便宜、不依赖模型可用，因此"完成即提醒"不会因为一次模型调用失败而静默消失。
6. **通知写入独立的通知表，不写 `inbox`。** `inbox` 的含义保持严格："操作者请求"；通知没有操作者请求可挂。
7. **本次通知只在控制台内。** 出站通道（webhook／邮件）留作后续 spec；因此本次投递即落盘，不存在投递失败重试问题，`part`/`uncertain` 那套账本等到有出站通道时再引入。
8. **模型用自己的话说明结果，发生在下一次交互**，事实由 `job_list` / `job_status` 提供，**不由宿主定时唤醒**。定时唤醒等于重建 ADR-0022 已废弃的调度器，并且为一次"好了"付出成数量级的生成；而这里的事件源就在自己的库里，轮询是多余的。
9. **本次不引入新的模型生成路径**，因此没有需要新定的生成边界。若后续要做"完成即由模型开口"，那条无请求的生成路径必须带自己的时长上限与失败可见性。
10. **每 bot 同时只有一个写型作业，且作业不写 bot 的模型可见会话。** 进度只进作业侧记录，避免污染前台模型的上下文。

## 后果

- 得到：长任务不再受 300 秒约束；操作者可以离开，回来看到结果；多个作业的状态可查；`AGENT_TIMEOUT` 不再等于"这次请求什么都没发生"。
- 接受的成本：作业的字节仍受执行机带宽约束，后台化不改善吞吐；单条命令仍受 RPC 线路 59 分钟的硬顶，因此"作业 = 一条命令"在超过该上限的传输上不够用，可续推进留作后续；控制台成为通知的唯一出口；删除 bot 时必须把作业与通知行一并纳入清账。
- 之后以本 ADR 为准：通知不是回复，`AGENT_TIMEOUT` 不再等于"这次请求什么都没发生"；`docs/contracts-and-lifecycle.md` 中"控制台回复直接记为终态且不建投递记录"的表述需要按本决策修订。

## 分阶段决策与缺陷历史

### 2026-11-08：后台作业与完成回报

- 相关 spec：`docs/spec-20261108-background-jobs.md`
- 决策与取舍：见上。两处演变记在这里：完成通知最初定为"后台 reporter 以 follow-up input 回投、由模型用自己的话回报"，同日在实现前改为**宿主直接落确定性通知**——理由是通知渠道已限定在控制台内，未读徽标本身即完成"提醒"，而模型开口需要一条无请求的生成路径及其边界；模型用自己的话说明结果挪到下一次交互，事实由查询工具提供。另一次是并发上限的显式化：共享执行主机的 `EXECUTION_AGENT_MAX_CONCURRENT` 由 3 提到 4，与代码默认值一致，作业占 1 个槽位、前台留 3 个；`busy` 结果是 `not_started`，重试安全，但仍须在工具错误里与执行失败区分。
- 相关缺陷：尚未发现。
- 实现期决策（与上文一并生效）：
  - **作业任务的每一条终态都提交 `completed`**，作业自己的终态（`done` / `failed` / `canceled` / `unknown`）放在 `result` 里。原因在删除门禁：`src/conversation-purge.ts` 的 `unknownOutcomes` 统计的是"终态任务里 outcome 不为 completed"的记录，若作业按业务结果提交 `failed`，每一个跑完的作业都会变成"无法解释的工作"，删 bot 必须 `force`。作业的成败是作业层的事实，不是底座任务执行的成败。
  - **重启只续跑尚未开始执行的作业。** 任务的 `execute` 阶段首行判断 `attempts`：大于 0 说明这条命令已经被交给过执行环境，进程被杀时它可能已产生副作用，重放不安全，因此提交 `unknown` + `JOB_INTERRUPTED`，并在通知与索引里如实保留。没有断点续跑语义的命令（`curl -C -`、`rsync --partial`）不因此变得安全，续跑留给后续 spec。
  - **启动门禁按任务种类排除作业，而不是按 `background` 排除。** `harness.inspect()` 里的后台任务不止作业：MEM-05 归档任务同样是 `background: true`，但它会做模型调用、会写会话上下文，必须继续计入 `hasConflictingWork`（原 `inspection.tasks.length > 0`）。判据从 "非 background" 改成 "`kind !== personal.job`"，否则一次运行中的作业会让 GitHub 审批变更触发 `GITHUB_APPROVAL_RECOVERY`，或推迟每个 bot 的 MCP pin 安装。
  - **命令时长上限按传输实际接受值派生。** 取 `EXECUTION_MAX_TIMEOUT_SECONDS` 会与线路封顶打架：RPC 直连的 `#maxTimeoutMs` 是 `min(配置值 × 1000, 3,540,000)`，默认配置 3600 s 正好超过它，请求会在命令启动前被判 `timeout`。因此 `jobTimeoutSeconds()` 复用环境自己的派生（`rpcMaxTimeoutSeconds`），本地部署无传输可派生，用 `JOB_LOCAL_TIMEOUT_SECONDS = 3600`。
  - **控制台如何"提醒"。** 通知是宿主写的确定文本，落在通知表；控制台的三个面都读它：bot 列表与对话头的未读数、作业面板（完整记录 + 标为已读）、时间线末尾的未读通知文本。作业完成不产生任何会话事件，所以 SSE 流在心跳里顺带读一次作业索引，变了才推一帧 `{type:"jobs"}`；页面只在时间线空闲时重绘，避免打断正在流式输出的回复。
  - **`job.*` 工具归入 `shell` 能力组。** 一个不能在请求内跑命令的 profile，也不该能把命令派发到请求之外。
