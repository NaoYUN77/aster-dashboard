# ADR-0020：远程 PTC sandbox（脚本与工具同在执行 VPS）

- **状态**：Accepted
- **日期**：2026-11-02
- **功能**：remote-ptc-sandbox
- **当前决策口径**：2026-11-02 修订为统一 RPC Execution Agent，见文末「2026-11-02：统一 RPC 修订」。下文「决策」保留初次设计原文；两者冲突时以修订附记为准。

## 上下文

[ADR-0019](../codemode-ptc/0019-codemode-ptc.md) 在控制面用 QuickJS worker 实现了 PTC：模型写脚本，脚本通过 `tools.*` 调用白名单工具，只有脚本结果进入模型上下文。远程执行阶段 1（[ADR-0021](../0021-control-execution-split.md)）只有 `bash`，`RemoteExecutionEnv` 的文件 API 返回 `not_supported`；嵌套 `bash` 通过 one-shot broker 每次新建 SSH 连接。

这留下两个问题：

- PTC 的脚本可能包含密集的过滤、解析和循环；脚本本身跑在控制面的 4 核／4 GB 主机上，会和 agent、Telegram 适配器和持久化争抢资源。
- 脚本运行环境不是 OS sandbox。QuickJS 只限制 JavaScript 能力；真正执行命令的是高权限执行主机上的普通进程，PTC 没有把脚本和工具一起关进资源／文件系统／网络边界。

`@earendil-works/pi-codemode` 1.3.0 提供了 `RemoteCodemodeSandbox` 和 `serveCodemodeRemote`：VM 可以放在远端，宿主仍保留工具表、调用 id、deadline 和 abort。它解决“VM 在哪”，不解决“远端工具如何执行”和“脚本和工具如何被隔离”。现有 broker 协议是一连接一请求，没有 session、`callId` 或双向持续流。

执行 VPS 已具备 Linux、unprivileged user namespaces 和 cgroup v2，并计划安装 `bwrap`。控制面是单台 4 核／4 GB 主机，不新增公网监听。

## 决策驱动因素

- 脚本和嵌套工具必须在执行 VPS 的同一资源／文件系统／网络边界内运行，避免控制面被脚本计算拖垮，也避免脚本与工具处于不同隔离层。
- 每次嵌套调用仍需经过控制面注册表、参数 schema、authz、嵌套任务和 durable journal，以复用 ADR-0008／0009 的恢复与顺序语义。
- 一个脚本可能连续调用很多次工具；不能每次调用重建 SSH 连接，也不能把协议设计成只能一问一答。
- 中间大输出必须留在远端；控制面 journal 只保存有界结果，避免循环调用撑爆 SQLite。
- 控制面重启后，同一 `jobId` 必须复用同一 workspace，已完成调用从 journal 返回，未完成调用继续执行。
- 默认无网络；超时和取消必须传递到 VM、bwrap 和命令进程组，不能留下后台计算或孤儿进程。
- 隔离能力不能靠配置假设：user namespace 和 cgroup 必须实际探测；不能自动把“无 sandbox”当成降级。
- 阶段 1 用最少工具闭合链路；阶段 2 尽快提供文件原语，因为批量代码／文本读取与修改是 PTC 的核心高频场景，bash 拼接文件内容对模型不友好且容易触发转义问题。

## 备选方案

- **方案 A：脚本仍跑控制面，只把嵌套工具放远端**：成本最低，但 PTC 的 CPU 密集脚本仍占用控制面，脚本与工具不在同一 sandbox，且无法用 cgroup 统一限制。不采用。
- **方案 B：远端 runner 自己执行工具，只把最终结果回控制面，不逐次回调**：通道最简单，脚本和工具天然同 sandbox；但绕过控制面工具注册表、schema、authz 和 `NestedCallDoc`，需要另建授权、审计和重放语义，与 ADR-0008／0009 及既有 durable 恢复冲突。阶段 1 不采用。
- **只使用 `RemoteCodemodeSandbox`，工具仍在控制面进程内执行**：VM 在远端，文件／命令却仍在控制面，违背“脚本与工具共同受限”；并且嵌套 `bash` 仍走 one-shot SSH。不采用。
- **在控制面用 Node `vm` 或容器直接跑脚本**：与 ADR-0019 重复，需要自建工具桥和隔离；控制面资源问题仍未解决。不采用。
- **把全部命令升级为 bwrap 执行**：会改变直接 `bash` 的既有语义、路径和部署，超出 PTC 范围。阶段 1 只包装 PTC；直接 `bash` 的安全不对称在文档中明确。
- **默认降级到 `prlimit`-only**：实现简单，但没有 mount／PID／network namespace，不能称为 sandbox；默认失败关闭，只有显式 `PTC_ALLOW_DEGRADED=1` 才允许。
- **每次嵌套调用新建 SSH 连接**：复用现有 one-shot broker 最省事，但一个脚本几十次调用会产生大量握手、认证和 socket 开销，也无法在有在途调用时正确取消。不采用；改为一条 session SSH 流。
- **把完整工具输出存入控制面 journal，再由模型截断**：实现直观，但会随着循环调用线性放大 SQLite 和备份体积。改为远端窗口截断＋job workspace spill，控制面只保存有界结果。

## 决策

采用“远程 VM + 远程 bwrap sandbox，控制面保留授权与 journal”的混合架构。

### 控制面

- `CODEMODE_ENABLED=1` 且 `EXECUTION_MODE=remote` 时，`createCodemodeHost()` 使用 `RemoteCodemodeSandbox`；本地模式继续 `CodemodeSandbox`。
- 每个 codemode 调用由宿主派生稳定 `jobId`：`ptc-` + SHA-256 版本盐＋`conversationId`＋codemode 任务 id 的前 32 个十六进制字符。模型不能指定。
- 任务作用域提交 `PtcJobDoc`，记录 `jobId` 和 `workspaceReady`；收到 `session.ready` 后、发送 `vm.start` 前提交 `workspaceReady=true`。
- 每次嵌套调用仍走 `api.executeTool(name, args, context, { key: "c" + callId })`；注册表做名称、schema、authz，结果写入 `NestedCallDoc`。控制面把 session 放进嵌套 context，`HarnessOptions.env` 从上下文取到 `PTC_SESSION`，以 `cwd=/workspace` 构造带 session 的 `RemoteExecutionEnv`。
- 阶段 1 远程脚本白名单为 `{ "bash" }`；阶段 2 加 `read`／`write`／`edit`。模型仍能看到全部工具，白名单只影响脚本可见面。
- 嵌套调用继续串行；session 关闭、超时、取消时中止嵌套 context。

### 执行 VPS

- broker 在宿主侧保持 Unix socket；每个 PTC job 通过一条长生命周期 SSH 流连接到执行用户的强制命令 `aster-ptc-host`，不新增监听端口。
- `aster-ptc-host` 负责预检、workspace 创建／复用、cgroup 准备、启动 bwrap、转发帧和强杀。
- `aster-ptc-runner` 在 bwrap 内运行，使用 `serveCodemodeRemote` 启动 QuickJS VM，并在同一 sandbox 内执行 `bash`（阶段 2 加文件操作）。
- bwrap 使用 `--die-with-parent --new-session`，逐项强制 `--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup --unshare-net`，`--clearenv`、只读系统运行时和 runner bundle 绑定、可写 `/workspace`、tmpfs `/tmp`、`--cap-drop ALL --no-new-privs`；不整体绑定 `/` 或 `/home`。不使用 `--unshare-all`，因为它的 `-try` 变体会在 user namespace 不可用时静默继续。
- 默认无网络；不通过脚本参数或 session 帧打开网络。
- `/home/aster/jobs/<jobId>/workspace` 挂载为 `/workspace`；同一 `jobId` 重放必须复用同一目录。`workspaceReady=true` 而目录缺失时失败为 `workspace_missing`，不静默创建空目录。
- 阶段 2 可在显式配置时把直接 `bash` 的工作目录以 `ro` 或 `rw` 挂到 `/shared`，用于批量读取／修改代码；默认 `none` 不挂载。`/shared` 不是 job 私有，重放语义与直接 `bash` 相同。

### 通道与协议

- 新增独立的 `PTC_PROTOCOL_VERSION=1`，换行 JSON；`session.open` 后保持长连接，VM 帧和工具帧复用同一条流。
- 工具帧携带 `callId`；阶段 1 控制面串行发送，协议允许同一 session 内多个在途调用。所有帧带 `sessionId`；未知／错配 id、未知字段、版本不符都关闭 session 且不执行工具。
- 帧大小、命令、argv、env、cwd、并发 session 数都有硬上限；慢客户端触发 backpressure 时显式关闭，不静默丢帧。
- 超时／取消的强杀顺序：控制面发送 `session.close` 或断开 socket → broker 杀 SSH 进程组 → host 关闭 bwrap（`--die-with-parent`）→ 有 cgroup 时写 `cgroup.kill=1` → runner 退出并停止 VM／命令。

### 隔离与降级

- 启动前执行实际 probe，而不是只看 sysctl：`bwrap` 可运行、user namespace 可创建、cgroup v2 的 `memory`／`pids`／`cpu` 可用且可写、runner／QuickJS 版本匹配、workspace 路径安全。
- bwrap／user namespace 不可用时默认失败关闭；只有显式 `PTC_ALLOW_DEGRADED=1` 才进入 `prlimit`-only 模式，并记录 `isolation.mode="degraded-prlimit"`，明确它不是文件系统／网络隔离。
- cgroup 不可用但 bwrap 可用时，保留 namespace 隔离，资源限制降级到 `prlimit`，记录 `cgroup="none"`。`prlimit` 不能替代 user namespace；两者是不同层保护。
- cgroup 默认 `memory.max=512 MiB`、`memory.swap.max=0`、`pids.max=128`、`cpu.max="200000 100000"`；关闭时用 `cgroup.kill` 强杀整个组。

### 输出与 journal 增长

- runner 在本地维护单工具输出窗口（默认 32 KiB／1000 行，保留尾部），只把尾部、丢弃计数和元数据发给控制面；完整输出写入 `/workspace/.ptc/spill/`，有单文件上限。
- `NestedCallDoc` 只保存有界结果；`fullOutputPath` 是 sandbox 内路径，控制面不能读取。
- 每次脚本默认最多 500 次嵌套工具调用、累计结果预算 8 MiB；超过后拒绝新调用并附加诊断，不静默丢弃已有结果。codemode 最终给模型的文本仍限制为 32 KiB／1000 行。

### 分阶段

- 阶段 1：`bash` only，闭环验证远端 VM 注入、控制面工具回调、journal 重放、workspace 衔接、超时强杀和网络隔离。
- 阶段 2：阶段 1 验收通过后立即跟进，不作为可选后续。在同一 session／sandbox 上增加 `read`／`write`／`edit`，由 `RemoteExecutionEnv` 通过文件帧执行；路径限制在 `/workspace`、`/tmp` 和显式启用的 `/shared`，拒绝越界和符号链接逃逸。这是 PTC 批量处理代码／文本的核心场景，不能长期只靠 `bash` 拼接。

## 后果

- 控制面不再承担 PTC 脚本的 CPU 和内存；脚本和工具共同受 bwrap、user namespace、cgroup 和 network namespace 约束。
- 每个嵌套调用增加一次控制面往返，但复用一条 SSH 流和 `callId`，避免连接建立成本；阶段 1 的串行边界和 durable 语义不变。
- 控制面仍需承受与调用次数相关的 durable 记录开销，但不再与原始 stdout 大小相关；上限使 journal 增长有界。
- 执行主机新增部署要求：Node 24、bwrap、user namespaces、cgroup v2、执行用户、`/home/aster/jobs`、runner bundle、SSH 强制命令和保留期清理。预检失败会阻止远程 PTC 启动，而不是静默退回不安全模式。
- 重放只恢复 workspace 文件，不恢复进程、内存、文件锁、后台任务或 `/tmp`；未完成的 `bash` 仍是 unsafe，按结果未知处理，不能承诺恰好一次。
- 直接 `bash` 仍不在 bwrap 内，PTC 的隔离结论不能外推到直接命令；生产环境仍使用独立低权限执行用户。
- 新增 `@earendil-works/pi-codemode` 的远程运行形态和自有 runner 构建产物；控制面与执行主机的版本／指纹必须同步，否则重放显式失败。
- `/shared` 的 `rw` 模式是显式能力：脚本可以修改直接 `bash` 的工作区，重放时未完成的编辑按结果未知处理。

## 分阶段决策与缺陷历史

### 2026-11-02：设计阶段

- 相关 spec：`docs/spec-20261102-remote-ptc-sandbox.md`（本功能完成后删除，文件名保留为历史标识）
- 决策与取舍：确认采用远程 VM + 远程 sandbox，控制面保留 journal 和 authz；拒绝方案 A（脚本留控制面）和方案 B 阶段 1 形态（runner 完全自执行、不逐次回调）。通道采用单条 SSH session 流和 `callId`；阶段 1 只开放 `bash`，阶段 2 加文件原语。隔离以 bwrap + user namespace 为必需层，cgroup 优先、`prlimit` 仅作资源降级，且 userns 缺失时默认失败关闭。输出采用远端窗口截断＋workspace spill，控制面 journal 只存有界结果。workspace 通过稳定 `jobId` 和 `workspaceReady` 保证重放衔接，缺失时显式失败。
- 相关缺陷：尚未实现；已识别的风险包括 userns 在 Debian／Ubuntu／AppArmor 环境下的可用性差异、cgroup 委派失败后的弱降级、`serveCodemodeRemote` 在客户端超时后可能继续计算到下一个工具调用或中断预算、以及直接 `bash` 与 PTC 的安全不对称。实现阶段须用实际 probe、超时强杀和无遗留进程验收逐项确认，不能只以配置存在作为证据。

### 2026-11-02：统一 RPC 修订

- 相关 spec：`docs/spec-20261102-remote-ptc-sandbox.md`（历史文件名）
- 触发原因：初次设计把“每个 PTC job 一条长生命周期 SSH 流”当作通道，Phase 0 只实现 Unix socket 抽象会把 TCP/TLS、双向证书和真实跨 VPS 闭环推到后续；同时 RPC 不能演变成无约束远程命令服务，request id 去重也不能替代 durable replay。
- 决策与取舍：通道改为统一 RPC Execution Agent，保留自定义长度前缀 JSON（4 字节大端长度，协议版本 1），暂不引入 gRPC；Transport 抽象同时支持 Unix socket（本地测试）和 TCP/TLS + mTLS（跨 VPS）；Agent 只绑定私网地址，不新增公网监听，不发布端口。Phase 0 只实现健康检查、预检、session、心跳、流式输出、取消、断线和受限 `test.*` 执行器，不接受任意命令；真实 `bash`／`tool.call` 必须经过控制面 registry、schema、authz 和必要审批，执行面仍执行 allowlist、bwrap 和资源限制。Phase 0 验收必须包含真实双 VPS 的 mTLS 闭环，而不是只看 loopback 或 Unix socket。RPC request id 去重仅限同一连接；连接断开后执行类请求结果未知，不自动重跑；`NestedCallDoc`、unsafe 工具策略和 durable journal 不修改、不替代。PTC 仍以减少 LLM 上下文为目标：完整输出留在执行 VPS，控制面只保存有界尾部和 `OutputRef` 元数据；QuickJS 不能直接读文件，Phase 1 用同 sandbox `bash` 过滤，Phase 2 用分块 `read`；重放时校验 `OutputRef` 引用，缺失或 hash 不符返回 `output_unavailable`。Phase 0 完成后再做远程 PTC 集成；不得提前迁移全部普通工具。
- 备选方案与不采用原因：
  - gRPC 双向流：需要引入 protobuf、HTTP/2 调优和额外依赖；Phase 0 的请求／响应、流式事件、取消和心跳用长度前缀 JSON 已足够。保留 Transport 抽象，后续可替换。
  - 只实现 Unix socket，TCP/mTLS 后置：不满足真实跨 VPS 验收目标，不采用。
  - 由 app 容器直接连执行 VPS：违反 ADR-0021 的路由隔离；继续由控制面 gateway 连接。
  - 反向连接（Agent 主动连控制面）：仍需一个私网监听端点，且证书方向、NAT 和故障恢复更复杂；作为部署受限时的备选，不是 Phase 0 主路径。
  - 持久 SSH stdio 承载同一套 RPC 帧：可作为私网不可达时的兼容适配器，但仍需双向认证和帧协议，不把“SSH”当作 RPC 的安全边界。
  - Phase 0 开放进程执行器：会把 Agent 变成无约束远程命令服务；Phase 0 只开放受限测试能力，真实命令留到 Phase 1／2 并经过控制面授权。
  - 用 RPC request id 去重替代 durable replay：跨连接、重启和外部副作用都不成立；只保留同连接去重。
- 后果：新增一个常驻 Execution Agent 和一套私网 mTLS 证书运维；Phase 0 的跨 VPS 验收需要两台真实主机和私网路由，CI 只覆盖 loopback TLS。Phase 0 不改变现有 broker／SSH 路径、Tool Registry、Journal 或 QuickJS 核心。Phase 1 才引入 bwrap、cgroup、workspace、`OutputRef` 和 `RemoteCodemodeSandbox`；Phase 2 才迁移直接 `bash` 和远程文件工具。
- 实现状态：Phase 0 的协议、Transport 抽象、Gateway Client、常驻 Execution Agent、TCP/TLS + mTLS、客户端 CN allowlist、session／心跳／流式／取消／断线处理和受限测试执行器代码已落地；本地类型检查、TLS loopback 测试和 TLS loopback 的 `rpc-agent --check`＋`rpc-e2e` 闭环通过，Unix socket 用例在 POSIX 验收中 9/9 通过。2026-11-02 已完成真实双 VPS 跨私网验收（PASS，执行面 `executionId 3a0d7374b09e9b05`），证据见 [验收记录](../../acceptance/20261102-execution-rpc-phase0.md)；Phase 1／2 未实现。
- 相关缺陷：Phase 0 跨 VPS 验收已完成；剩余风险是证书轮换／吊销、现有网络策略的持续核验，以及断线验收需要独立测试客户端（`rpc-e2e` 当前约 0.2 秒完成，不能用 `timeout 1s` 稳定停在 sleep 阶段）。Phase 0 不存在任意命令路径；真实 `bash`／`tool.call` 仍留到 Phase 1／2。

### 2026-11-02：Phase 0 真实双 VPS 验收

- 结果：**PASS**。控制面与执行面位于同一 VPC、不同子网，通过私网 TCP 9443 建立 mTLS 连接；执行面 `executionId` 为 `3a0d7374b09e9b05`。
- 正向：`rpc-e2e` 返回 `status: ok`、`transport: tls`、`protocol: 1`、`streamChunks: 3`、`cancelCode: aborted`、`cancelOutcome: unknown`；`executionId` 与执行面日志一致。
- 负向：错误 CA、错误 SAN、错误客户端 CN、缺少客户端证书全部被拒绝；Agent 只监听私网地址，公网 9443 不可达。
- 断线：在 `test.sleep` 期间 SIGKILL 客户端后无残留 `ESTABLISHED`，Agent 存活，TTL 后重新 e2e 成功；未观察到自动重跑。
- 权限：`test/execution-rpc.test.ts` 9/9 通过；未执行任何 `bash`／`tool.call`；Phase 0 仍只有受限 `test.*` 执行器。
- 网络变更：部署方未修改主机、Docker／容器、`ufw` 或云安全组；用户在执行面实例的云安全组中单独加入 TCP 9443 ← 控制面私网 `/32` 的入站规则。该规则是环境准备，不是部署 agent 的防火墙变更。
- 证据：[2026-11-02 验收记录](../../acceptance/20261102-execution-rpc-phase0.md)。Phase 1／2 未实现。

### 2026-11-03：Phase 1／2 代码与自动化验收

- 相关 spec：`docs/spec-20261102-remote-ptc-sandbox.md`（历史文件名）
- 结果：Phase 1 代码随 PR #59 合入前完成：`vm.start`／`vm.message`／`vm.reply`／`tool.call`、`RemoteCodemodeSandbox` 网关绑定、bwrap／cgroup／workspace／`OutputRef` runner、预算、强杀与 preflight；自动化测试通过。
- Phase 2：直接 `bash` 通过统一 RPC `execute`（direct session）执行，文件原语以 `file.stat`／`exists`／`canonical`／`open`／`read`／`scanLines`／`close`／`readText`／`write` 提供；PTC 嵌套调用在 runner 内、直接工具在 agent 内共用 `PtcFileService` 的路径与原子写实现。控制面用 `EXECUTION_REMOTE_TRANSPORT=ssh|rpc` 显式选择传输（默认 `ssh`）；rpc 模式要求执行面同时支持 direct bash、文件工具和可写 `/shared`，否则启动失败，不静默回退。
- 会话修复：direct session 被 Agent TTL 清理后，只有请求被明确拒绝为 `not_found`＋`not_started` 时才重建一次并重试；文件级 `not_found` 与结果未知的情况都不重试，保持“未知不当作未执行”。
- 证据：[2026-11-03 自动化验收记录](../../acceptance/20261103-remote-ptc-phase2.md)。真实双 VPS 的 bwrap／cgroup、`/shared` 一致性和断线重放仍按 spec 16.2／16.3 待执行。

### 2026-11-03：Phase 1／2 自动化缺陷修复

- 触发原因：Phase 1／2 的 Linux CI 基线在执行此前被 Windows 跳过的用例时连续暴露缺陷。
- 缺陷与处理：
  - `file.open` 的 `noFollow` 先解析最终路径再检查，逃逸链接被报成 `permission_denied`，内核 `O_NOFOLLOW` 也作用在目标而不是调用方命名的链接上。改为只解析父目录、先 `lstat` 拒绝最终组件的符号链接，并把竞态下的 `ELOOP` 映射为同一种 `invalid_request`。
  - `file.write` 通过链接写入后报告链接的虚拟路径，而内容落在目标文件。改为从实际写入的目标反推虚拟路径。
  - `ensurePtcJobInTx` 返回 chord 的 overlay 代理；调用方在 commit 结束后读取 `workspaceReady` 时触发 `Cannot use a settled overlay`。改为返回脱离的 `PtcJobState` 快照。
  - `RpcCodemodeRemote` 把每个 `vm.message` 批次串行串在 `exchange` 之后；一次 call 的 exchange 要等工具结束，而工具启动依赖紧随其后的 idle 确认批次，两侧互相等待。改为按到达顺序立即投递，只串行化 `vm.reply`，并等待本执行产生的全部投递结束再归因失败。
- 验证：远程 codemode 用例改用 direct-session 拓扑，在 Windows 与 Linux 都实际运行；Windows 基线 362 tests、352 pass、0 fail、10 skipped。真实双 VPS 验收仍未执行。

### 2026-11-03：真实双 VPS 验收失败与 cgroup 入组顺序修复

- 结果：**FAIL**。在 `63091e8` 上按 Runbook 部署，Phase 1 首次 `vm.start` 返回 `code: internal`、`outcome: not_started`，错误为 `the sandbox process could not be accounted for: ENODEV: no such device, write`；Phase 2 首次 direct `session.open` 返回同一类错误的 `EACCES: permission denied, write`。
- 根因：`createPtcCgroup().addProcess()` 在子进程已经由 bwrap 执行 `--unshare-cgroup` 之后，才由 agent 把 PID 写入 `PTC_CGROUP_ROOT/<session>/cgroup.procs`。此时该任务处在新的 cgroup namespace 中，目标 cgroup 不在其命名空间根下，内核拒绝迁移（新版内核报 `ENODEV`，旧报 `EACCES`），与 systemd 委派无关。用普通 `sleep` 复现；`Delegate=yes`＋`DelegateSubgroup=agent` 因父节点有内部进程返回 `EBUSY`，不是可行替代。
- 处理：移除 `PtcCgroup.addProcess`。新增 `spawnInCgroup`：先以 Node 启动一个短命 helper，helper 把自身 PID 写入目标 cgroup，经额外 fd 3 报告成功后再 `process.execve` bwrap；PID、进程组与 cgroup 归属随 exec 保留，因此入组发生在 unshare 之前，全部后代（runner、bash 子进程）仍在同一 cgroup 内，`cgroup.kill` 与 `memory.max`／`pids.max`／`cpu.max` 继续有效。入组失败通过 fd 3 的 `error:` 行成为执行失败（`internal`／`not_started`），不会伪装成命令退出码；5 秒未确认则拒绝启动并强杀。
- 部署前提（写入 Runbook）：`ProtectHome=false`、`ProtectKernelTunables=false`、`ProtectControlGroups=false`，否则 `ProtectSystem=strict` 会隐藏 `/home/aster` 或让 cgroupfs 只读。
- 验证：Linux 专用 `test/ptc-cgroup.test.ts` 用临时目录代替 cgroup，覆盖“先写 PID 再 exec、PID 不变”“exec 失败按命令失败退出 125”“入组被拒时在启动前失败”。Windows 跳过该用例（无 `process.execve`／cgroup）。真实双 VPS 需要按 Runbook 复验后才能改判 PASS。
- 实现注意：确认通道不能对该 stdio 流调用 `removeAllListeners()`——那会同时移除 Node 自己用于登记 stdio 关闭的监听，导致子进程的 `close` 事件永不触发；两个执行器都用 `close` 结算命令与 runner 退出，实际会话会因此挂起。改为只摘除本模块的监听并 `resume()` 读到 EOF；helper 在 exec 前关闭 fd 3，sandbox 不再继承该通道。

### 2026-11-03：真实双 VPS 第二轮失败与 cgroup 委派模型修正

- 结果：**FAIL**（head `415bb67`）。自动化基线通过（Linux 366 tests／358 pass／0 fail／8 skipped，`ptc-cgroup` 4/4），但 Phase 1 首次 `vm.start` 与 Phase 2 首次 `session.open` 都返回 `the sandbox process could not be accounted for: EACCES: permission denied, write`。Runbook 3.2 自带的自迁移探针同样失败（`sh: 1: echo: echo: I/O error`）。
- 归因一：迁移方向对了，位置不对。cgroup v2 在迁移任务时检查的不只是目标 `cgroup.procs`，还包括源与目标**最近公共祖先**的写权限。`PTC_CGROUP_ROOT=/sys/fs/cgroup/aster-ptc` 时，源是 `system.slice/aster-rpc-agent.service`，公共祖先是 root 拥有的 `/sys/fs/cgroup`（`0644`），`aster-exec` 无权写入。此时即使 root 手工建好目录并开启两级 `subtree_control`，也只有 `--check` 的旧探针（建目录、写 `pids.max`）会通过。
- 归因二（独立阻塞）：bubblewrap 0.11.1 不认识 `--no-new-privs`，启动即 `bwrap: Unknown option --no-new-privs`、exit 1。`buildBwrapArgv` 与 `buildDirectBwrapArgv` 都传了该参数，cgroup 修好后 Phase 1／2 仍会在 bwrap 启动阶段失败。bwrap 的 `main` 在解析参数之前就调用 `prctl(PR_SET_NO_NEW_PRIVS, 1)`（0.11.1 源码），该参数既无效也多余。
- 决策：session cgroup 必须位于单元委派的子树内，与 Agent 自身 cgroup 共享 `<unit>` 作为最近公共祖先。
  - 单元使用 `Delegate=yes`＋`DelegateSubgroup=agent`：systemd 把服务主进程放入 `<unit>/agent`，使 `<unit>` 成为没有内部进程的中间节点，可开启控制器；委派让 `aster-exec` 拥有该子树。
  - `PTC_CGROUP_ROOT` 默认从 `/proc/self/cgroup` 推导为 `<unit>/ptc`；Agent 自己写入两级 `cgroup.subtree_control`（systemd 只让控制器可用，不替服务开启），并在每次创建 session 前幂等补写。无法推导出委派子组时，配置读取直接失败，要求显式指定，而不是选一个必然不可用的默认值。
  - 旁挂根 `/sys/fs/cgroup/aster-ptc` 不可用于未提权服务，从 Runbook 移除。
- 探针改为真实自迁移：`probeCgroup` 执行与生产相同的 `spawnInCgroup`（先把自身 PID 写入 `<root>/.probe-*`，再 exec），并继续写入 `pids.max`；失败原因进入 `--check` 的 `cgroupReason` 和启动错误信息，`cgroup: true` 才表示 Agent 真能把任务放进 session cgroup。
- 验证：新增 `test/ptc-bwrap.test.ts` 固定隔离参数（含“不得出现 `--no-new-privs`／`--unshare-all`”）；`ptc-cgroup` 增加“只补写缺失控制器”“非 cgroup 目录在创建 session 前被拒绝”。真实双 VPS 需按新 Runbook 重新验收才能改判 PASS。
