# 远程 PTC 与统一 RPC 执行通道（Phase 0：跨 VPS RPC；Phase 1：远程 PTC sandbox；Phase 2：文件原语）

- **状态**：Phase 0 已通过真实双 VPS 验收（2026-11-02，`executionId 3a0d7374b09e9b05`）；Phase 1／2 代码已实现，自动化验收通过（2026-11-03），真实双 VPS 验收待执行
- **日期**：2026-11-02
- **功能**：remote-ptc-sandbox
- **所属 ADR**：[ADR-0020](adr/remote-ptc-sandbox/0020-remote-ptc-sandbox.md)
- **前置决策**：[ADR-0019](adr/codemode-ptc/0019-codemode-ptc.md)、[ADR-0021](adr/0021-control-execution-split.md)

> 本文区分“仓库当前已实现”“Phase 0 已通过真实双 VPS 验收”“Phase 1／2 已实现但真实双 VPS 验收待执行”。除明确标注为已实现的内容外，均不是现有代码能力。Phase 0 的验收证据见 [2026-11-02 验收记录](acceptance/20261102-execution-rpc-phase0.md)；Phase 1／2 的自动化证据见 [2026-11-03 验收记录](acceptance/20261103-remote-ptc-phase2.md)。

## 1. 实现状态

| 内容 | 状态 | 证据／说明 |
| --- | --- | --- |
| 本地 codemode（`CodemodeSandbox`） | 已实现 | `src/codemode.ts`、`src/agent.ts`、`test/codemode.test.ts` |
| 远程 `bash`（一次调用一条 Unix socket 请求 + 一条 SSH） | 已实现 | `src/execution/broker.ts`、`broker-client.ts`、`ssh.ts`、`remote-env.ts` |
| `RemoteExecutionEnv` shell 半边 | 已实现 | 文件 API 仍返回 `not_supported` |
| 远程 PTC（`RemoteCodemodeSandbox`） | Phase 1 已实现 | `src/ptc-gateway.ts`、`src/ptc-session.ts`、`src/execution/ptc-host.ts`；`test/ptc-control.test.ts`、`test/ptc-rpc.test.ts` |
| 统一 RPC 协议、Transport、Gateway Client、Execution Agent | Phase 0 已实现 | `src/execution/rpc-protocol.ts`、`rpc-transport.ts`、`rpc-client.ts`、`rpc-server.ts`、`rpc-config.ts`、`rpc-main.ts`、`rpc-test-executor.ts` |
| TCP/TLS + mTLS 私网通信 | Phase 0 代码已实现 | `listenTlsRpc`／`tlsRpcTransport`；TLS loopback 双向认证、客户端 CN allowlist 与拒绝测试通过 |
| 端到端 CLI 闭环 | TLS loopback 与真实双 VPS 均已通过 | `execution:rpc-agent --check`、`execution:rpc-e2e` 完成 health／stream／cancel；真实跨 VPS 证据见验收记录 |
| Session、心跳、流式响应、取消、deadline、断线处理 | Phase 0 已实现 | `rpc-server.ts`、`rpc-client.ts`；见 `test/execution-rpc.test.ts` |
| 真实双 VPS RPC 闭环 | 已通过 | 2026-11-02，执行面 `executionId 3a0d7374b09e9b05`；正向／负向／断线证据见验收记录 |
| PTC bwrap／cgroup／workspace／`OutputRef` | Phase 1 已实现 | `ptc-bwrap.ts`、`ptc-cgroup.ts`、`ptc-executor.ts`、`ptc-host.ts`、`ptc-runner-*.ts`、`ptc-workspace.ts`；POSIX 自动化验收通过，真实双 VPS 验收待执行 |
| 直接 `bash` 迁移到统一 RPC、远程文件工具 | Phase 2 已实现 | `remote-rpc-env.ts`、`direct-executor.ts`、`ptc-fs.ts`、`remote-files.ts`；`test/direct-rpc.test.ts`、`test/ptc-files.test.ts`；真实双 VPS 验收待执行 |
| gRPC、消息队列、额外数据库 | 暂不实现 | 不引入 |

Phase 0 已通过真实双 VPS 验收；Unix socket 用例在 POSIX 验收中 9/9 通过。Phase 1／2 的代码路径与自动化验收已完成（2026-11-03），真实双 VPS 场景（bwrap／cgroup、`/shared` 一致性、断线重放）仍需按 16.2／16.3 执行。Phase 0 不改变现有 Tool Registry、pi-durable Journal、`NestedCallDoc` 或 QuickJS 执行核心。

## 2. 用户目标

模型写一段程序调用工具，程序本身和它调用的工具都在执行 VPS 的同一个受限 sandbox 内运行；控制面只负责工具授权、调用日志、恢复和最终投递。目标是：

- 脚本中的密集过滤、解析和循环不占用控制面的 4 核／4 GB 资源。
- 所有远程调用经过一条长期、可复用的 RPC 通道，而不是每次工具调用重新建立 SSH。
- 嵌套工具调用仍经过控制面的工具注册表、参数校验、authz、必要的审批和 durable 记录，不绕过既有安全边界。
- 只有脚本的精简结果进入模型上下文；单次工具的大输出留在执行 VPS，控制面 journal 只保存有界结果和有效引用。
- 控制面重启后，同一 `jobId` 复用同一 workspace 继续重放；已完成调用不重复执行，未完成的 unsafe 调用不自动重跑。
- 默认无网络；脚本、命令和子进程受 bwrap、user namespace、cgroup v2（或显式降级的 `prlimit`）约束。

## 3. 阶段划分

### Phase 0：统一 RPC 最小闭环（必须先完成）

Phase 0 只建立通道和执行代理，不接入 PTC，不迁移普通工具。

必须实现：

- 统一 RPC 协议及 Transport 抽象。
- Gateway RPC Client。
- 常驻 Execution Agent。
- TCP/TLS + 双向证书认证的私网双 VPS 通信。
- Session、心跳、流式响应、取消、deadline 和断线处理。
- 受限测试执行器（只开放 `test.*` 能力，不接受任意命令）。
- 本地 Unix socket 测试、TLS loopback 测试和真实跨 VPS 验收。

实现状态：上述代码路径均已落地；TLS loopback 自动化测试通过，Unix socket 在 POSIX 验收中 9/9 通过。2026-11-02 已完成真实双 VPS 验收（PASS），证据见 [验收记录](acceptance/20261102-execution-rpc-phase0.md)。Phase 0 验收已完成；Phase 1 代码随后完成（PR #59），真实双 VPS 验收待执行。

Phase 0 明确不实现：

- PTC QuickJS VM 的远程运行。
- `tool.call` 的真实 bash 执行。
- 直接 `bash` 迁到 RPC。
- 远程 `read`／`write`／`edit`。
- bwrap、cgroup、PTC workspace 和 `OutputRef` 的代码。
- 修改 Tool Registry、pi-durable Journal、`NestedCallDoc` 或 QuickJS 核心。

### Phase 1：远程 PTC sandbox

Phase 0 验收通过后实施：

- `RemoteCodemodeSandbox` 接入统一 RPC。
- QuickJS VM 与 PTC `bash` 在同一执行 VPS、同一 bwrap sandbox。
- 控制面仍负责 registry、schema、authz、审批、`NestedCallDoc` 和 journal。
- 稳定 `jobId`、workspace 复用、`OutputRef`、大输出过滤和 Token 消耗对比验收。
- 只开放 `bash`；文件原语留到 Phase 2。

实现状态：Phase 1 代码已于 2026-11-03 完成并提交（PR #59）；Loopback／自动化测试通过，真实双 VPS 验收按 16.2 待执行。

### Phase 2：直接工具迁移与文件原语

- 直接 `bash` 从现有 one-shot SSH 迁移到统一 RPC。
- 增加远程 `read`／`write`／`edit`，以及必要的 `file.stat` 等只读操作。
- 保留旧 SSH 路径作为兼容，直到迁移验收通过；不得静默降级。

实现状态：Phase 2 代码已于 2026-11-03 完成。`EXECUTION_REMOTE_TRANSPORT=ssh|rpc` 显式选择传输，默认 `ssh`；rpc 模式下直接 `bash` 与文件工具都走统一 RPC，ssh 模式保持原 broker 路径并且文件工具仍不可用，两种模式之间没有回退。自动化证据见 [验收记录](acceptance/20261103-remote-ptc-phase2.md)，真实双 VPS 验收按 16.3 待执行。

### 非目标

- 脚本内调用 MCP、Web、记忆或模型工具；这些仍由模型直接调用。
- Phase 0 提供任意命令执行、通用 shell 服务或“远程 root”。
- 控制面并发执行嵌套工具；Phase 1 仍串行，协议只预留多 `callId` 的形状。
- 在控制面保存完整远端输出，或让控制面读取 `/home/aster/jobs/...` 下的文件。
- 多租户隔离、跨用户共享执行主机、脚本递归、网络访问、GPU、Windows 执行主机。
- 用 RPC request id 去重替代 durable replay 或外部副作用幂等。
- 使用 gRPC、消息队列、Redis 或额外数据库；Phase 0 只用 Node.js 内置能力。

## 4. 现有事实与约束

- 本地 codemode 使用 `CodemodeSandbox`：每次执行一个 QuickJS WASM worker，VM 在控制面进程内。远程模式下，嵌套 `bash` 通过 one-shot broker 打开 SSH；脚本本身仍在控制面。
- 现有 broker 协议是“一连接一请求”的换行 JSON：`exec` 或 `ping`，没有 session、没有 `callId`、没有双向持续流。`RemoteExecutionEnv` 只实现 `exec()`；所有文件 API 返回 `not_supported`。
- `@earendil-works/pi-codemode` 已提供 `RemoteCodemodeSandbox` 和 `serveCodemodeRemote`：VM 可以运行在远端，工具仍由调用方执行；消息是 `CodemodeRemoteMessage[]`，工具调用通过 `exchange` 回到宿主。它本身只解决 VM 位置，不提供远程工具执行或 sandbox。
- pi-durable codemode 的持久化分三层：
  - `pi.codemode.run`：脚本开始数据、指纹、最终结果。
  - `pi.codemode.journal`：按交付顺序记录 VM 调用 id、时间和全局调用结果。
  - 每个嵌套工具的 `NestedCallDoc`：以 `c<callId>` 为 key 保存该嵌套任务的真实结果。
  
  本 spec 中的“journal”指这些 durable 记录的整体；控制面不保存远端原始 stdout。
- 嵌套 bash 的 `structuredOutput` 含 `output`（宿主保留的尾部）、`truncated`、可选 `fullOutputPath` 和 `exitCode`。`fullOutputPath` 在远程模式下只能是 sandbox 内路径，控制面不能打开它。
- ADR-0009 要求同一回合工具顺序执行；ADR-0008 规定不安全工具不自动重放。`bash` 是 unsafe；codemode 工具本身是 safe replay。
- 执行 VPS 是 Linux，执行用户示例为 `aster`，job 根目录为 `/home/aster/jobs`；要求支持 unprivileged user namespaces 和 cgroup v2，安装 bubblewrap。控制面是单台 4 核／4 GB 主机。
- ADR-0021 的网络约束仍然有效：app 容器只能访问宿主 Unix socket，不能直接路由到执行 VPS；执行 VPS 不加入 MITM 网络，也不新增公网端口。

## 5. 目标架构

```text
控制面 VPS
┌──────────────────────────────────────────────────────────┐
│ app 容器                                                 │
│   pi-durable + codemode extension                        │
│   RemoteExecutionEnv / RemoteCodemodeSandbox             │
│        │ 现有 Unix socket（app 只能到这里）               │
│        ▼                                                 │
│ execution-gateway / broker 容器                          │
│   Gateway RPC Client                                     │
│   RemoteExecutionTransport                               │
└───────────────┬──────────────────────────────────────────┘
                │ TCP/TLS + mTLS，只绑定私网地址
                ▼
执行 VPS
┌──────────────────────────────────────────────────────────┐
│ Execution Agent（常驻）                                  │
│   RPC Server / Session Manager / Dispatcher              │
│   ├─ TestExecutor（Phase 0，仅 test.*）                  │
│   ├─ BwrapPtcExecutor（Phase 1）                         │
│   └─ FileExecutor（Phase 2）                             │
└──────────────────────────────────────────────────────────┘
```

### 5.1 角色边界

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| 控制面 codemode extension | 脚本开始数据、journal、嵌套调用任务、最终结果上限 | 执行脚本、执行命令、读写远端文件 |
| `RemoteCodemodeSandbox` | 宿主侧 VM 控制、调用 id、deadline、abort、结果交付 | 远端进程和文件隔离 |
| Gateway RPC Client | 建立 mTLS 连接、session、请求／响应、流式事件、取消、断线处理 | 业务授权、工具执行、journal |
| Execution Agent | RPC 服务端、Session Manager、Dispatcher、执行器生命周期 | 自行授权任意工具、保存业务 journal、替代控制面 replay |
| TestExecutor（Phase 0） | `test.echo`／`test.stream`／`test.sleep`／`test.fail` | 任意命令、文件、网络、环境变量 |
| BwrapPtcExecutor（Phase 1） | 在 bwrap 内运行 QuickJS 和 bash、输出窗口、spill | 访问控制面状态、网络、宿主任意路径 |
| 旧 broker／SSH | 现有远程 `bash` 兼容路径 | 新 RPC 路径的授权或持久化 |

### 5.2 为什么 app 不直接连执行 VPS

ADR-0021 已确认 app 容器在 `aster_mitm_clients` 内没有到执行 VPS 的路由。为统一 RPC 给 app 加路由、发布端口或放宽 MITM 白名单会改变既有隔离语义。

因此：

- app 仍只连接宿主 Unix socket。
- gateway 作为 RPC 客户端，运行在控制面宿主网络；它使用私网 mTLS 连接执行 VPS。
- Phase 0 可以先由 `rpc-e2e` 客户端充当 gateway 验证链路；Phase 1 再把 broker/gateway 接到 app。

### 5.3 为什么不是 gRPC

gRPC 双向流是候选，但 Phase 0 不引入：

- 需要 `@grpc/grpc-js`、protobuf 生成、HTTP/2 调优和 TLS 配置，依赖和运维面扩大。
- 当前协议只需要请求／响应、服务端流式事件、取消和心跳；长度前缀 JSON 已足够。
- Transport 抽象允许将来把 gRPC 作为实现接入，而不改 Gateway Client、Session Manager 或 Dispatcher。

不引入 gRPC 不影响 Phase 0 的跨 VPS 闭环。

## 6. 统一 RPC 协议

### 6.1 传输与帧

- Transport 抽象：`RemoteExecutionTransport` / `RpcConnection`，上层不直接依赖 Unix socket、TCP 或 TLS。
- Phase 0 实现两种 Transport：
  - Unix socket：本地测试、同机部署。
  - TCP/TLS：跨 VPS；必须启用 mTLS。
- 帧格式：4 字节大端长度 + UTF-8 JSON。
- 单帧默认上限 4 MiB；输出 chunk 默认不超过 64 KiB。
- 协议版本 `1`；所有未知字段、未知 kind、版本不符都拒绝。

### 6.2 TCP/TLS、mTLS 与私网监听

统一 RPC **需要监听端点**，不能假定 RPC 天然无需监听。Phase 0 的端点约束：

- Execution Agent 只绑定私网地址或 WireGuard 地址，例如 `10.x.x.x:9443` 或 `fd00::1:9443`。
- 禁止绑定 `0.0.0.0`、`::` 或公网地址；不发布 Docker 端口。
- 本阶段不修改现有防火墙、Docker/容器网络或云安全组规则；部署方只读核验现有网络策略。若现有策略不满足私网访问或允许非预期来源，记录并停止，不自行变更。
- 服务端证书 SAN 必须包含实际连接地址；客户端校验证书链和主机名。
- Gateway 使用客户端证书；Agent 要求并校验客户端证书。
- CA 固定，证书由部署阶段签发；证书和私钥不进入仓库、不写入 `.env`、不暴露给模型。
- 客户端证书身份绑定到一个明确的 gateway 身份；Agent 拒绝未知客户端证书。
- 反向连接（Agent 主动连控制面私网监听）是部署受限时的备选，不是 Phase 0 主路径；无论方向如何，都需要一个私网监听端点。
- 如果私网路由不可用，兼容适配器可以用持久 SSH stdio 承载同一套 RPC 帧；它不是 gRPC，也不是每次命令新建 SSH。

明确：Phase 0 新增的是**私网监听**，不是公网端口；旧约束“不新增公网监听端口”保持不变。

### 6.3 信封

```ts
type RpcFrame = RpcRequestFrame | RpcResponseFrame | RpcEventFrame;

type RpcRequestFrame = {
  v: 1;
  kind: "request";
  id: string;                 // 请求唯一 id；同一连接内不得复用
  correlationId?: string;     // 日志／追踪关联，不用于去重
  method: RpcMethod;
  sessionId?: string;
  jobId?: string;
  deadlineMs: number;         // 相对预算，避免跨主机时钟偏差
  payload: Record<string, unknown>;
};

type RpcResponseFrame =
  | {
      v: 1;
      kind: "response";
      id: string;
      correlationId?: string;
      status: "ok";
      result?: unknown;
    }
  | {
      v: 1;
      kind: "response";
      id: string;
      correlationId?: string;
      status: "error";
      error: {
        code: RpcErrorCode;
        message: string;
        outcome?: "not_started" | "failed" | "unknown";
        retryable?: boolean;
      };
    };

type RpcEventFrame =
  | {                            // Agent → Gateway
      v: 1;
      kind: "event";
      event: "output";
      id: string;                // 对应的 execute 请求 id
      sessionId: string;
      seq: number;               // 同一请求内递增
      stream: "stdout" | "stderr";
      text: string;
    }
  | {                            // Agent → Gateway
      v: 1;
      kind: "event";
      event: "heartbeat";
      timestamp: number;
      sessionId?: string;
    }
  | {                            // Agent → Gateway
      v: 1;
      kind: "event";
      event: "session.closed";
      sessionId: string;
      reason: string;
    };
```

取消不是独立帧，而是 `method: "cancel"` 的请求，`payload` 为 `{ targetId, reason? }`；Agent 用普通响应确认取消请求本身，目标请求以 `aborted` 错误响应终止。

实现边界：Phase 0 的 Agent 只接受 `request` 帧；收到其他帧类型会关闭连接。Gateway 只接受 `response`／`event` 帧。`tool.output`、`vm.message`、`session.closed` 事件在 Phase 1 实现；`file.*` 方法在 Phase 1（PTC session）与 Phase 2（direct session）实现。

### 6.4 方法

| 方法 | Phase 0 | Phase 1 | Phase 2 | 说明 |
| --- | --- | --- | --- | --- |
| `health.check` | 实现 | 实现 | 实现 | executionId、Agent 版本、协议版本、已实现方法 |
| `preflight` | 实现基础版 | 扩展 | 扩展 | Phase 0 检查 TLS／测试执行器；Phase 1 加 bwrap/cgroup |
| `session.open` | 实现 | 实现 | 实现 | 携带 `sessionId`、`jobId`、limits |
| `session.close` | 实现 | 实现 | 实现 | 关闭会话并中止活动请求 |
| `execute` | 仅 `executor: "test"` | 不开放 bash（`not_implemented`） | 实现 bash | 需要 direct session；语义见第 13 节 |
| `tool.call` | `not_implemented` | 实现 `bash` | 扩展 `read`／`write`／`edit` | 嵌套 PTC 工具调用；先过控制面授权 |
| `cancel` | 实现 | 实现 | 实现 | 按 target request id 中止 |
| `vm.start` | 仅协议 | 实现 | 实现 | `RemoteCodemodeSandbox` 启动 |
| `vm.message` / `vm.reply` | 仅协议 | 实现 | 实现 | VM 消息交换 |
| `file.stat`／`exists`／`canonical`／`open`／`read`／`scanLines`／`close`／`readText`／`write` | 仅设计 | 实现（PTC session） | 实现（direct session） | 有界文件原语；路径限制见第 13 节 |

Phase 0 的 `execute` 只接受受限测试能力：

```ts
type RpcTestExecute =
  | { executor: "test"; operation: "echo"; text: string }
  | { executor: "test"; operation: "stream"; chunks: number; chunkBytes: number; delayMs?: number }
  | { executor: "test"; operation: "sleep"; ms: number }
  | { executor: "test"; operation: "fail"; code: "test_error" };
```

限制：

- `text` ≤ 4 KiB；`chunks` ≤ 100；`chunkBytes` ≤ 16 KiB；`delayMs` ≤ 1000；`sleep.ms` ≤ 60 000。
- 不接受 `command`、`cwd`、`env`、`inheritEnv` 或任意文件路径。
- `executor: "bash"`、`tool.call` 在 Phase 0 返回 `not_implemented`。
- 这样 Phase 0 可以真实验证连接、流式输出、取消和断线，而不把 Agent 变成无约束命令服务。

### 6.5 错误码

```text
invalid_request, unsupported_version, not_found, busy,
not_implemented, timeout, aborted, too_large,
spawn_error, unavailable, protocol_error, test_error, internal
```

`test_error` 只由 Phase 0 受限测试执行器的 `test.fail` 产生，代表业务执行失败，不是传输失败。

`outcome` 用来区分“确定未开始”和“结果未知”。取消、超时、连接断开默认 `unknown`；除非执行器能证明命令尚未启动。

### 6.6 Session、心跳与背压

- 一条 TCP/mTLS 连接可以承载多个逻辑 `sessionId`；Phase 0 默认最多 16 个。
- Session 由客户端在 `session.open` 中提出，Agent 校验格式和唯一性；重复的活跃 sessionId 返回 `busy`。
- 心跳默认 15 秒；服务端 session TTL 默认 270 秒；空闲会话被清理并发送 `session.closed`。
- 背压高水位默认 1 MiB；超过时关闭连接，显式失败，不静默丢输出。
- 输出事件带 `seq`；终止响应在流式事件之后。

### 6.7 断线、重连与去重语义

| 现象 | RPC 层 | Durable／PTC 层 |
| --- | --- | --- |
| 同一连接重复 request id | 拒绝，不执行第二次 | 与 journal 无关 |
| 请求进行中连接断开 | 该请求失败，执行类标记 `outcome: "unknown"` | 不能当作未执行；不自动重跑 |
| 重连 | 新建连接，重新 `session.open` | 同一 `jobId` 只用于 Phase 1 workspace 恢复 |
| 已完成嵌套调用 | 不重新发送 `tool.call` | `NestedCallDoc` 返回已保存结果 |
| 未完成 bash | 不自动重跑 | unsafe；按结果未知记录 |
| 相同业务请求重试 | 新 request id，可能重复执行 | 外部副作用仍不是恰好一次 |

关键约束：

- RPC request id 去重只防止同一连接内的重复执行，**不替代** pi-durable 的 durable replay。
- 重连不会自动重跑结果未知的 `bash`。
- `correlationId` 只用于日志和追踪，不能作为幂等键。
- Phase 0 不缓存跨连接结果；Agent 重启后 session 和 pending 请求全部失效。

## 7. 执行权限边界

### 7.1 控制面是授权权威

真正的 `bash`／`tool.call` 必须经过控制面：

1. 工具名称存在于 registry，且未被禁用。
2. 参数通过 TypeBox schema 和运行时校验。
3. authz／approval 通过；需要审批的工具在控制面完成。
4. 嵌套任务以 `c<callId>` 写入 `NestedCallDoc`。
5. 只有通过上述步骤的调用才允许发送 `tool.call` 或 `execute` 到 Agent。

Agent 不是授权服务；它不能自行决定某个工具是否被允许。Agent 只接受已认证 gateway 发来的、自身 allowlist 和资源上限允许的调用。

### 7.2 执行面仍有第二层限制

即使控制面已授权，Execution Agent 仍必须：

- 只接受 allowlist 中的执行器（Phase 0：`test`；Phase 1：`bash` + bwrap；Phase 2：文件原语）。
- 在 bwrap 内执行 PTC 命令，限制文件系统、网络、PID、IPC、UTS、cgroup namespace。
- 强制 cgroup v2 或显式降级的 `prlimit` 资源上限。
- 校验命令、argv、cwd、env、timeout、输出窗口和帧大小。
- 拒绝未知工具、未知字段、越界路径和越界资源请求。
- 不把执行器错误伪装成业务成功；结果未知标记 `outcome: "unknown"`。

### 7.3 Phase 0 不开放任意命令

Phase 0 的 TestExecutor 只有 `test.echo`、`test.stream`、`test.sleep`、`test.fail`。它不读取文件、不访问网络、不继承宿主环境、不接受 shell 字符串。这样跨 VPS 验收不需要先实现生产 bash 或 bwrap，也不会提前制造一个无约束远程执行服务。

## 8. Gateway RPC Client

### 8.1 职责

- 通过 `RemoteExecutionTransport` 建立到 Agent 的长期连接。
- 发送 `health.check`、`preflight`、`session.open`、`execute`（Phase 0 仅 test）、`cancel`、`session.close`。
- 管理 pending 请求、deadline、AbortSignal 和输出回调。
- 连接断开时统一失败 pending；执行类请求标记 `outcome: "unknown"`。
- 不保存业务 journal，不决定工具授权。

### 8.2 不变量

- 模型不能指定 Agent 地址、证书、私钥、sessionId 或 requestId。
- 同一连接内的 request id 唯一；重试必须使用新 id，并重新经过控制面授权。
- 输出回调不能把完整大输出写入模型 transcript；Phase 0 只用于测试事件。
- Client 不自动重连后重放；是否重试由上层按工具 replay 策略决定。

## 9. Execution Agent

### 9.1 常驻服务

- 一个常驻进程，监听私网 TCP/TLS 或本地 Unix socket。
- 启动时加载证书、CA、allowlist、资源上限和版本信息。
- `--check` 只校验配置和证书，不监听、不执行。
- 收到连接后校验 mTLS 客户端身份，再进入 RPC 帧处理。

### 9.2 Session Manager

- 维护 `sessionId` → `{ jobId?, createdAt, lastActiveAt, activeRequests }`。
- 活动请求按 request id 索引，取消时中止对应 `AbortController`。
- 连接关闭时中止该连接的所有活动请求，清理 session。
- 空闲 TTL 到期时关闭 session，发送 `session.closed`。
- Phase 0 不做跨连接 session 恢复；Phase 1 的 PTC workspace 恢复由控制面 `jobId` 驱动。

### 9.3 Dispatcher

- 根据 `method` 和执行器 allowlist 路由。
- Phase 0 只路由 `test.*`；`tool.call` 和 `execute` 的 bash 形态返回 `not_implemented`。
- Phase 1 路由 `vm.*` 和 `tool.call`（bash）到 `BwrapPtcExecutor`。
- 未知 method、未知 executor、未授权工具返回 `not_implemented`／`invalid_request`，不尝试“尽力执行”。

## 10. 远程 PTC（Phase 1）

### 10.1 流程

1. 模型调用 `codemode`。宿主从 `conversationId` 和 codemode durable `taskId` 派生稳定 `jobId`。
2. 控制面提交 `PtcJobDoc`（`jobId`、`workspaceReady`、创建时间）。
3. Gateway 打开 RPC session，发送 `session.open`。
4. Agent 创建或复用 `/home/aster/jobs/<jobId>/workspace`，准备 cgroup，启动 bwrap 内的 PTC runner。
5. Agent 返回 `session.ready`，包含 workspace 状态和隔离信息。
6. 控制面提交 `workspaceReady=true`，发送 `vm.start`；runner 调用 `serveCodemodeRemote`。
7. VM 发出 `call`。控制面 `RemoteCodemodeSandbox` / codemode extension 以 `api.executeTool(name, args, context, { key: "c" + callId })` 进入正常工具路径。
8. 通过 registry、schema、authz、审批后，嵌套 `bash` 以 `tool.call` 发到同一 RPC session；Agent 在 bwrap 内执行。
9. 输出按窗口流式返回；完整输出写入 job workspace，控制面只保存有界结果和 `OutputRef`。
10. 控制面把嵌套结果写入 `NestedCallDoc`，交付给 VM；只有最终脚本结果进入模型上下文。
11. 脚本结束、失败、超时或取消时关闭 RPC session；workspace 保留到保留期结束。

### 10.2 身份

- `jobId`：`sha256("remote-ptc-sandbox\0" + conversationId + "\0" + codemodeTaskId)` 前 32 个十六进制字符，前缀 `ptc-`；模型不能指定。
- `sessionId`：每次连接尝试随机生成 16 个十六进制字符；重放生成新 `sessionId`，复用同一 `jobId`。
- `callId`：pi-codemode VM 的整数调用 id（从 1 开始），一次脚本执行内唯一；`NestedCallDoc` key 为 `c<callId>`。
- `correlationId`：日志／追踪用，不是幂等键。

### 10.3 PTC 载荷

Phase 1 在统一 RPC 信封内使用 `vm.*` 和 `tool.call` 方法；不再单独定义一条 SSH 协议。

```ts
type PtcVmStartPayload = {
  request: CodemodeRemoteRequest;
};

type PtcVmMessagePayload = {
  messages: CodemodeRemoteMessage[];
};

type PtcVmReplyPayload = {
  reply: CodemodeRemoteReply;
};

type PtcToolCallPayload = {
  tool: "bash";
  callId: number;
  args: {
    command: string | string[];
    cwd: "/workspace";
    env: Record<string, string>;
    inheritEnv: boolean;
    timeoutMs: number;
    window: PtcOutputWindow;
  };
};
```

`PtcOutputWindow` 至少包含 `maxBytes`、`maxLines`、`minIntervalMs`、`bytesPerSecond`。Agent 用本机配置再 clamp，不能由控制面放宽本机上限。

### 10.4 控制面接入点

- `createCodemodeHost()` 在远程模式下使用 `SessionBoundCodemodeSandbox`（`RemoteCodemodeSandbox` 的子类），由 Gateway session 提供 `remote()`；本地模式继续 `CodemodeSandbox`。
- 包装层每次 codemode 调用先打开或拒绝 session，然后用 `AsyncLocalStorage` 把该 session 绑定在整次 `execute()` 上；并发脚本各自拿到自己的 session，不会串用。
- 嵌套调用不通过 context 传递身份：调度器的 `HarnessOptions.env` 只看到后台 context，看不到单次调用 context。绑定层改为包裹 `bash` 工具，从持久化嵌套任务输入读取 `parent`（codemode 任务 id）和 `key`（`c<callId>`），据此找到 session 并派生 `callId`；`callId` 不从模型参数读取，找不到 session 或 key 形状不符则失败关闭。
- 每个嵌套 `bash` 调用构造一个 `PtcExecutionEnv`（`cwd=/workspace`），把 `env.exec` 转成同一 session 上的 `tool.call`；返回值带 `outputRef`／`spillTruncated`。`OutputRef` 在结果交付给 VM 之前提交到 `PtcOutputDoc`，提交失败则调用失败（命令可能已执行）。
- 模型直接调用 `bash` 在 `EXECUTION_REMOTE_TRANSPORT=rpc` 时走同一 RPC 的 `execute`（direct session），在默认 `ssh` 时仍走原有 broker 路径；两种模式都不静默回退到另一种，文件工具在 ssh 模式保持不可用。
- `restrictScriptTools` 在 Phase 2 的远程白名单为 `{ "bash", "read", "write", "edit" }`（与本地一致）；模型仍能看到全部工具。
- 包装层继续串行化嵌套调用，并在 codemode 调用结束、失败、超时或取消时中止仍在运行的嵌套 context；随后关闭 RPC session。

## 11. Workspace、重放与输出引用

### 11.1 Workspace

- job 根目录：`PTC_WORKSPACE_ROOT`，默认 `/home/aster/jobs`。
- job workspace：`/home/aster/jobs/<jobId>/workspace`，属主为执行用户，权限 `0700`。
- 沙箱内挂载为 `/workspace`，可写；`/workspace` 是默认 cwd。
- 只持久化 `/workspace`；`/tmp` 是 tmpfs，VM 内存、进程、临时目录和文件锁不跨重放保留。
- 启动前检查 `jobId` 格式、路径不逃逸根目录、workspace 不是符号链接。

### 11.2 重放

| 情况 | 行为 |
| --- | --- |
| 首次运行，目录不存在 | 创建；`session.ready.workspace.created=true`；提交 `workspaceReady` 后启动 VM |
| 首次运行，目录已存在 | 复用并记录 `reused=true`；不自动清空 |
| 重放，`workspaceReady=true`，目录存在 | 复用；同一 `jobId` 的文件上下文衔接 |
| 重放，`workspaceReady=true`，目录不存在 | 失败 `workspace_missing`；不创建空目录，不执行 live 调用 |
| 重放，`workspaceReady` 未提交，目录存在 | 复用；记录 `reused=true` |
| 重放，`workspaceReady` 未提交，目录不存在 | 创建；记录 `created=true`；journal 中已完成结果仍可交付，但相关文件可能缺失，必须产生诊断 |

重放流程：

1. 同一 codemode durable task 重新执行，派生同一 `jobId`。
2. 打开新 RPC session，挂载同一 workspace；VM 重新开始并读取 `pi.codemode.run` 的 start 数据。
3. 对 journal 中已完成的 `callId`，`executeTool` 以 `c<callId>` 重新关联 `NestedCallDoc`，直接返回已保存结果，不发送 `tool.call`，不重新执行命令。
4. journal 未覆盖的 live 调用继续执行；它们看到的是上次尝试留下的 `/workspace` 文件。
5. 若 VM 指纹、模块版本或脚本路径与上次不一致，显式失败，不执行 live 调用。

### 11.3 输出窗口与 `OutputRef`

- runner 对每个工具的 stdout／stderr 按到达顺序维护一个合并窗口（默认 32 KiB／1000 行，保留尾部），与 `ShellOutputWindow` 的“合并尾部”语义一致；不能对两个流各留一份。
- runner 只把保留的尾部通过 `output`／`tool.output` 事件发送给控制面；被丢弃的内容用 `ShellOutputSkip` 计数。
- 控制面 bash 工具仍用自己的输出缓冲做第二层上限；最终 `structuredOutput.output` 是有界尾部。
- 完整输出从开始就写入 job workspace；超过 `PTC_SPILL_MAX_BYTES` 时停止写入并标记 `spillTruncated`。
- 不再只保存一个可能失效的路径。完整输出以内容寻址方式保存：

```ts
type OutputRef = {
  blobId: string;                  // sha256(content) 或等价内容 id
  jobId: string;
  sessionId: string;
  callId: number;
  path: string;                    // sandbox 内内容寻址路径
  size: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
  state: "available" | "evicted" | "unknown";
};
```

- 存储路径示例：`/workspace/.ptc/outputs/<sha256>`；写入先落到同目录临时文件，flush 后 rename，避免半写文件。
- 控制面用独立的扩展 durable 文档 `PtcOutputDoc` 保存 `OutputRef` 元数据；不修改 pi-durable journal 核心，也不把完整内容写进 `NestedCallDoc`。
- `NestedCallDoc` 保存有界尾部、`truncated` 和 `OutputRef` 元数据；完整内容只在执行 VPS。
- 读取时校验 `size` 和 `sha256`；文件缺失或 hash 不符返回 `output_unavailable`，不当作空文件。
- 清理与 workspace 保留期一致；有引用的 blob 不删除。清理前标记 `evicted`；崩溃后首次访问时重新校验，缺失则标记 `unknown`。

### 11.4 QuickJS 如何读取完整输出

QuickJS VM 仍然没有文件系统、网络、计时器或模块能力。它不能直接打开 `/workspace` 路径；必须通过工具读取：

- Phase 1（只有 `bash`）：
  - 脚本从 bash 结果拿到有界尾部和 `OutputRef`；
  - 需要过滤时，用同一 sandbox 内的 `bash` 处理 `ref.path`，例如 `grep`、`awk`、`sed`、`head`、`tail`；
  - 只把过滤后的有界结果返回给脚本；完整输出不经 RPC 传输。
- Phase 2（增加 `read`）：
  - 脚本或模型直接调用 `read`，`RemoteFileSystem` 通过 `file.open`／`file.read`／`file.scanLines` 读取；
  - `file.read` 每次最多 256 KiB，返回 `{ data, bytesRead, nextOffset, eof }`；客户端校验 `nextOffset` 与请求范围一致；
  - 内置 `read` 的 offset／limit 与行扫描在宿主侧组合，返回文本及其截断状态；单次远程读取不超过 2 MiB。
- 分块默认 32 KiB／1000 行；按字节 offset，UTF-8 边界不拆分；每个脚本有累计读取预算。
- 不用“把完整输出塞进一次 tool result”的方式；也不让控制面读取执行 VPS 文件。

网络传输与 Token 优化分开：

- 网络：完整输出留在执行 VPS；RPC 只传有界尾部或分块结果。
- Token：嵌套输出不进入 LLM transcript；只有 codemode 精简结果进入上下文。

### 11.5 Phase 1 大输出与 Token 验收

- 构造至少 10 MiB 的日志／CSV fixture，脚本过滤出错误计数或摘要。
- 验收：
  - 模型 transcript 中只有一条 codemode `toolResult`；
  - 嵌套 bash 输出不出现在 transcript；
  - codemode 最终结果 ≤ 32 KiB／1000 行；
  - 控制面 SQLite 不出现完整 10 MiB 输出；
  - 记录 transcript 字节数和估算 token，和“直接多次读取／多轮工具调用”的基线对比，报告下降比例；
  - 大输出过滤不因 32 KiB 窗口截断而丢失脚本所需的聚合结果。
- 具体下降阈值在 Phase 1 实施时固定；验收必须给出测量方法和原始数据，不能只写“明显减少”。

## 12. 隔离、资源与网络（Phase 1）

### 12.1 启动预检

Execution Agent 的 `--check` 和 `preflight` 必须检查：

1. `bwrap` 可执行文件存在且可运行。
2. user namespace 可用：实际执行 `bwrap --unshare-user --uid 0 --gid 0 true` 或等价 probe，不能只看 sysctl；处理 `unprivileged_userns_clone` 和 Ubuntu 24.04 `apparmor_restrict_unprivileged_userns`。
3. cgroup v2 可用：`memory`、`pids`、`cpu` controller 可写，`PTC_CGROUP_ROOT` 可创建子 cgroup；检查 `cgroup.kill`。
4. runner 版本、`@earendil-works/pi-codemode`／QuickJS 版本与构建指纹；与控制面不一致时启动失败。
5. workspace 根目录可写；共享 workspace 路径（若配置）存在且不是危险符号链接。
6. `prlimit` 可用（仅降级路径需要）。

失败策略：

- user namespace 或 bwrap 不可用：默认失败关闭；只有显式 `PTC_ALLOW_DEGRADED=1` 才允许 `prlimit`-only，并记录 `isolation.mode="degraded-prlimit"`。
- cgroup 不可用但 bwrap 可用：保留 namespace 隔离，资源限制降级到 `prlimit`，记录 `cgroup="none"`。
- `prlimit` 不能替代 user namespace。

### 12.2 bwrap

目标命令形状（实现时按发行版调整只读运行时绑定）：

```sh
bwrap \
  --die-with-parent --new-session \
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts \
  --unshare-cgroup --unshare-net \
  --clearenv \
  --setenv PATH /usr/local/bin:/usr/bin:/bin \
  --setenv HOME /workspace --setenv TMPDIR /tmp \
  --setenv LANG C.UTF-8 --setenv TZ UTC \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin --ro-bind /sbin /sbin \
  --ro-bind /opt/aster/ptc /opt/aster/ptc \
  --ro-bind-try /etc/passwd /etc/passwd \
  --ro-bind-try /etc/group /etc/group \
  --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf \
  --ro-bind-try /etc/ld.so.cache /etc/ld.so.cache \
  --proc /proc --dev /dev --tmpfs /tmp \
  --bind /home/aster/jobs/<jobId>/workspace /workspace \
  --chdir /workspace \
  --cap-drop ALL --no-new-privs \
  -- /usr/bin/node /opt/aster/ptc/runner.mjs
```

- 不使用 `--unshare-all`：它的 `-try` 变体可能在 user namespace 不可用时静默继续。
- `/shared` 默认不挂载；显式 `PTC_SHARED_WORKSPACE_MODE=ro` 时只读绑定，Phase 2 才允许 `rw`。
- `/usr`、`/lib*`、`/bin`、`/sbin` 按发行版实际路径只读绑定；禁止整体 `--ro-bind / /`。
- `/etc` 只绑定最小运行时文件；`/home`、SSH 目录、凭据不绑定。
- `--die-with-parent`、`--new-session`、`--cap-drop ALL`、`--no-new-privs` 必须保留。

### 12.3 cgroup 与 `prlimit`

优先 cgroup v2：

| 文件 | 默认 | 说明 |
| --- | --- | --- |
| `memory.max` | 512 MiB | 包含 Node、runner、QuickJS、bash、tmpfs |
| `memory.swap.max` | 0 | 不用 swap 缓冲 |
| `pids.max` | 128 | 限制 fork |
| `cpu.max` | `200000 100000` | 2 核配额 |
| `cgroup.kill` | 关闭时写 `1` | 强杀整个组 |

- 关闭时先写 `cgroup.kill`，等待 `cgroup.events` 为空，再删除 cgroup。
- 内核不支持 `cgroup.kill` 时逐项 SIGKILL；记录该回退。
- cgroup 不可用时用 `prlimit --nproc/--nofile/--fsize/--cpu/--core=0` 包裹 bwrap；记录 `cgroup="none"`。
- `prlimit` 不能可靠限制聚合进程组；这是显式接受的降级代价。

### 12.4 网络

- PTC sandbox 默认 `--unshare-net`，无外部网络、无 DNS、无监听端口。
- 验收检查 `/proc/net/dev` 只有 `lo`，`curl`／`wget` 失败，DNS 失败。
- 执行 VPS 不加入控制面的 MITM 网络；模型调用仍由控制面经既有代理完成，sandbox 不持有模型密钥。
- RPC 的 mTLS 监听属于 Agent 进程，不在 PTC sandbox 内；sandbox 不能访问该连接。

## 13. 失败、恢复与超时

### 13.1 失败语义

| 现象 | 含义与处理 |
| --- | --- |
| 预检失败（TLS／证书） | Agent 或 Gateway 启动失败，不降级到明文 |
| 预检失败（bwrap／userns） | Phase 1 默认启动失败；显式 `PTC_ALLOW_DEGRADED=1` 才进入 `degraded-prlimit` |
| cgroup 不可用 | bwrap 仍在；资源限制降级到 `prlimit`，记录 |
| `workspace_missing` | 已初始化 job 在重放时找不到 workspace；显式失败，不创建空目录（也不创建 job 父目录） |
| `busy` | 并发 session 或请求超限；显式拒绝，不排队 |
| `invalid_request`（payload 级） | 帧外壳合法但参数非法（未知项、`cwd`／`tool` 不符、NUL／相对路径、PTC sessionId 非 16 hex、`vm.reply` 的 `callId` 不是 VM 当前等待的调用）：以该请求的 id 返回错误，`outcome: "not_started"`，连接保持可用 |
| `permission_denied`（payload 级） | 虚拟路径中的 `..` 越界，或符号链接指向根外／另一个根：请求级拒绝，连接保持可用 |
| `protocol_error`（帧外壳级） | 未知帧类型／字段／版本、无法解析的帧、超大帧、id 错配：关闭连接，不执行 |
| RPC 连接断开 | 在途请求结果未知；执行类 `outcome: "unknown"`；不自动重跑 |
| 脚本超时 | 关闭 session、强杀 VM 和命令进程组；返回 timeout |
| 请求取消 | 返回 aborted；外部副作用按未知记录 |
| bash 非零退出 | 工具结果 `isError`＋`exitCode`；不是 sandbox 失败，脚本可继续 |
| 输出截断 | 返回尾部、`truncated`、`OutputRef`；不把截断当完整 |
| `OutputRef` 缺失／hash 不符 | `output_unavailable`；不伪造内容 |
| 调用／journal 预算超限 | 拒绝后续调用并附加诊断 |
| 指纹／版本不匹配 | 重放显式失败，不执行 live 调用 |

### 13.2 超时与强杀

- 脚本期限：`CODEMODE_TIMEOUT_MS` 是主时钟；Agent session TTL 为期限加余量。
- 工具期限：`bash` timeout 和 `EXECUTION_MAX_TIMEOUT_SECONDS` 生效；Agent 再 clamp 到 session 剩余时间。
- 取消：控制面发送 `cancel`；Agent 中止对应执行器；PTC 关闭 session 时强杀 bwrap。
- 强杀顺序：
  1. Gateway 发送 `session.close` 或断开连接；
  2. Agent 中止活动请求，关闭 bwrap；
  3. 有 cgroup 时写 `cgroup.kill=1`；没有 cgroup 时杀 bwrap 进程组并等待；
  4. runner 退出，停止 VM 和命令；
  5. workspace 保留，供同一 `jobId` 重放。
- 不能把“连接断了”当作“命令没执行”。
- 控制面超时后不得让远端 VM 长时间继续计算；Phase 1 验收必须检查无遗留进程。

### 13.3 恢复

- codemode 工具本身 `replay: "safe"`；脚本开始数据、指纹、journal 和嵌套结果按 pi-durable 规则恢复。
- `bash` 仍是 unsafe：崩溃时正在运行、尚未保存结果的命令不自动重跑；按结果未知记录。
- 已保存结果的调用从 `NestedCallDoc` 返回，不重新执行。
- 文件原语（Phase 2）沿用各工具的重放策略；已完成结果不重跑，未完成按未知处理。
- 同一 `jobId` 重放挂载同一 workspace；只恢复文件系统，不恢复进程、内存、文件锁、后台任务或 `/tmp`。
- RPC 重连不改变上述语义；request id 去重不能替代 durable replay。

## 14. 配置与部署

### 14.1 控制面 Gateway

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EXECUTION_MODE` | `local` | `local`／`remote`；只有 `remote` 才读取下列变量 |
| `EXECUTION_REMOTE_TRANSPORT` | `ssh` | `ssh`（旧 broker）或 `rpc`（统一 RPC direct session）；不做隐式回退 |
| `EXECUTION_REMOTE_CWD` | 无 | 两种传输都必填；rpc 模式必须在 `/shared` 下 |
| `EXECUTION_RPC_TRANSPORT` | `tls` | `tls` 或 `unix`；生产用 `tls` |
| `EXECUTION_RPC_ADDRESS` | 无 | Agent 私网地址，例如 `EXECUTION_HOST:9443` |
| `EXECUTION_RPC_SERVER_NAME` | 无 | 证书 SAN 校验名 |
| `EXECUTION_RPC_CA_PATH` | 无 | CA 证书 |
| `EXECUTION_RPC_CERT_PATH` | 无 | Gateway 客户端证书 |
| `EXECUTION_RPC_KEY_PATH` | 无 | Gateway 客户端私钥 |
| `EXECUTION_RPC_CONNECT_TIMEOUT_MS` | `5000` | 建连上限 |
| `EXECUTION_RPC_REQUEST_TIMEOUT_MS` | `30000` | 默认请求 deadline |
| `EXECUTION_RPC_MAX_FRAME_BYTES` | `4194304` | 单帧上限 |
| `EXECUTION_RPC_MAX_BUFFERED_BYTES` | `1048576` | 背压高水位 |

### 14.2 Execution Agent

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EXECUTION_AGENT_BIND` | 无 | 私网监听地址，禁止 `0.0.0.0` |
| `EXECUTION_AGENT_PORT` | `9443` | 私网端口 |
| `EXECUTION_AGENT_TLS_CERT_PATH` | 无 | 服务端证书 |
| `EXECUTION_AGENT_TLS_KEY_PATH` | 无 | 服务端私钥 |
| `EXECUTION_AGENT_TLS_CA_PATH` | 无 | 客户端 CA |
| `EXECUTION_AGENT_CLIENT_CERT_CN` | 无 | 允许连接的 gateway 客户端证书 CN；TLS 模式必填 |
| `EXECUTION_AGENT_REQUIRE_CLIENT_CERT` | `1` | 必须为 `1` |
| `EXECUTION_AGENT_SESSION_TTL_MS` | `270000` | 空闲 session 清理 |
| `EXECUTION_AGENT_HEARTBEAT_MS` | `15000` | 心跳间隔 |
| `EXECUTION_AGENT_MAX_SESSIONS` | `16` | 并发 session |
| `EXECUTION_AGENT_MAX_CONCURRENT` | `4` | 并发执行 |
| `EXECUTION_AGENT_MAX_FRAME_BYTES` | `4194304` | 单帧上限 |
| `EXECUTION_AGENT_MAX_BUFFERED_BYTES` | `1048576` | 背压高水位 |
| `EXECUTION_AGENT_TEST_EXECUTOR` | `1` | Phase 0 测试执行器开关；生产 Phase 1 关闭 |
| `EXECUTION_AGENT_UNIX_SOCKET` | 无 | 仅本地测试／同机部署 |

Phase 1／2 执行面配置（已实现）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PTC_ENABLED` | 无 | 必须显式 `1` 才启用 PTC sandbox |
| `PTC_WORKSPACE_ROOT` | `/home/aster/jobs` | job 根目录 |
| `PTC_SHARED_WORKSPACE` | `/home/aster/workspace` | 直接 `bash` 工作目录；`PTC_SHARED_WORKSPACE_MODE` 非 `none` 时必填 |
| `PTC_SHARED_WORKSPACE_MODE` | `none` | `none`／`ro`／`rw`；Phase 2 直接模式要求 `rw` |
| `PTC_DIRECT_ENABLED` | `0` | `1` 时开放 direct session（`execute` bash＋文件工具）；需要 `PTC_SHARED_WORKSPACE` |
| `PTC_DIRECT_TMP_ROOT` | `/tmp/aster-direct` | 每个 direct session 的私有 `/tmp` 根 |
| `PTC_CGROUP_ROOT` | `<单元 cgroup>/ptc`（由 `/proc/self/cgroup` 推导） | cgroup v2 子树；必须位于 systemd 委派的单元 cgroup 内，否则无法把 sandbox 迁入（最近公共祖先只读） |
| `PTC_CGROUP_MEMORY_MAX_BYTES` | `536870912` | 512 MiB |
| `PTC_CGROUP_PIDS_MAX` | `128` | 进程／线程上限 |
| `PTC_CGROUP_CPU_MAX` | `200000 100000` | 2 核配额 |
| `PTC_OUTPUT_CHUNK_BYTES` | `32768` | 分块读取上限 |
| `PTC_NESTED_OUTPUT_MAX_BYTES` | `32768` | 单工具尾部上限 |
| `PTC_NESTED_OUTPUT_MAX_LINES` | `1000` | 单工具行数上限 |
| `PTC_SPILL_MAX_BYTES` | `67108864` | 单个完整输出上限 |
| `PTC_ALLOW_DEGRADED` | `0` | 仅显式允许 `prlimit` 降级 |
| `PTC_JOB_RETENTION_HOURS` | `168` | workspace 保留期 |

### 14.3 部署

1. 控制面生成／分发 CA，签发 Gateway 客户端证书和 Agent 服务端证书；证书不进仓库。
2. Agent 绑定执行 VPS 私网地址；本阶段不修改现有防火墙、Docker/容器网络或云安全组，只做只读核验。
3. Gateway 配置 CA、客户端证书、服务端 SAN；`rejectUnauthorized` 必须为真。Agent 的 `EXECUTION_AGENT_CLIENT_CERT_CN` 必须等于该客户端证书 CN，其他 CA 签发或 CN 不符的证书在进入 RPC 前被拒绝。
4. 不发布 Docker 端口；Agent 进程直接绑定私网地址，或在 host 网络容器中运行。
5. 先运行 `execution-agent --check` 和 Gateway `health.check`；失败则不进入 Phase 0 验收。
6. Phase 0 不修改现有 SSH broker 的配置和路径。

执行 VPS（示例值均为占位）：

```sh
npm ci && npm run build
export EXECUTION_AGENT_BIND=EXECUTION_HOST
export EXECUTION_AGENT_PORT=9443
export EXECUTION_AGENT_TLS_CERT_PATH=/run/aster/rpc/server.crt
export EXECUTION_AGENT_TLS_KEY_PATH=/run/aster/rpc/server.key
export EXECUTION_AGENT_TLS_CA_PATH=/run/aster/rpc/ca.crt
export EXECUTION_AGENT_CLIENT_CERT_CN=aster-gateway
export EXECUTION_AGENT_REQUIRE_CLIENT_CERT=1
npm run execution:rpc-agent -- --check
npm run execution:rpc-agent
```

控制面（只运行受限测试执行器，不会执行 shell）：

```sh
export EXECUTION_RPC_TRANSPORT=tls
export EXECUTION_RPC_ADDRESS=EXECUTION_HOST:9443
export EXECUTION_RPC_SERVER_NAME=execution.internal
export EXECUTION_RPC_CA_PATH=/run/aster/rpc/ca.crt
export EXECUTION_RPC_CERT_PATH=/run/aster/rpc/client.crt
export EXECUTION_RPC_KEY_PATH=/run/aster/rpc/client.key
npm run execution:rpc-e2e
```

`rpc-e2e` 输出 `executionId`、`streamChunks`、`streamBytes`、`cancelCode` 和 `cancelOutcome`；同时用 `ss -ltn` 确认执行 VPS 只监听私网地址。

证书签发、systemd、网络策略只读核验、负向 mTLS 用例、断线检查和证据模板见 [Phase 0 部署与验收 Runbook](runbook-execution-rpc-phase0.md)。

## 15. 实施步骤

### 15.1 Phase 0

状态：以下代码步骤 1～7 已实现；步骤 6 的真实跨 VPS 验收已于 2026-11-02 通过。步骤 7 的兼容边界已遵守。

1. **协议**
   - 已实现 `src/execution/rpc-protocol.ts`：帧类型、严格解析、长度前缀编解码、错误码、`RPC_PROTOCOL_VERSION`。
   - 已有单测覆盖分片帧和超大帧；未知字段、错误版本、错误响应、事件顺序在服务端／客户端路径中校验。
2. **Transport**
   - 已实现 `src/execution/rpc-transport.ts`：`RpcConnection`、`RpcServer`、`RpcClientTransport`。
   - 已实现 Unix socket transport（本地测试）。
   - 已实现 TCP/TLS transport + mTLS（跨 VPS），并要求客户端证书 CN 命中 `EXECUTION_AGENT_CLIENT_CERT_CN`。
   - 已实现帧上限、发送缓冲高水位和连接关闭。
3. **Gateway Client**
   - 已实现 `src/execution/rpc-client.ts`：连接、health、preflight、session、execute（test）、cancel、断线处理。
   - 已实现 pending map、deadline、AbortSignal、输出回调；不自动重连或重试。
4. **Execution Agent**
   - 已实现 `src/execution/rpc-server.ts`：Session Manager、Dispatcher、心跳、TTL、取消、同连接重复 request id 拒绝。
   - 已实现 `src/execution/rpc-test-executor.ts`：只实现 `test.echo`、`test.stream`、`test.sleep`、`test.fail`。
   - 已实现 `src/execution/rpc-main.ts`：Agent CLI，`--check` 和启动；证书、私网绑定、allowlist。
   - 已实现 `src/execution/rpc-config.ts`：环境变量、私网地址与 TLS 材料校验。
5. **跨 VPS 验收工具**
   - 已实现 `src/execution/rpc-e2e.ts`：在控制面运行，连接 Agent，执行 health、stream、sleep cancel、session.close。
   - 测试证书夹具位于 `test/fixtures/rpc-tls/`；真实跨 VPS 仍需部署证书。
6. **测试**
   - 已实现 `test/execution-rpc.test.ts`：协议解码、TLS loopback、mTLS 拒绝、流式、取消、断线、重复 id、配置校验。
   - 真实跨 VPS 验收已按第 16 节执行并记录证据（2026-11-02，PASS）。
7. **兼容**
   - 未修改 `broker.ts`、`ssh.ts`、`remote-env.ts` 的行为。
   - `package.json` 只增加 Agent／e2e 脚本。

### 15.2 Phase 1

状态：步骤 1～5 的代码与自动化测试已实现（2026-11-03，PR #59）；真实双 VPS 验收按 16.2 待执行。

1. 增加 `vm.start`、`vm.message`、`vm.reply`、`tool.call`（bash）载荷和测试。
2. `RemoteCodemodeSandbox` / `PTC_SESSION` 接入 Gateway Client。
3. `aster-ptc-host`、`aster-ptc-runner`、bwrap、cgroup、workspace、`PtcJobDoc`。
4. `OutputRef`、`PtcOutputDoc`、输出窗口、spill、分块读取。
5. 预算、重放、强杀、预检。
6. 大输出过滤和 Token 消耗对比验收。

### 15.3 Phase 2

状态：步骤 1～4 的代码与自动化测试已实现（2026-11-03）；真实双 VPS 验收按 16.3 待执行。

1. 直接 `bash` 从 one-shot SSH 迁到 RPC `execute`（`EXECUTION_REMOTE_TRANSPORT=rpc`；默认仍为 `ssh`）。
2. 远程 `read`／`write`／`edit` 和 `/shared`。
3. 路径、符号链接、原子写入、幂等和重放验收。
4. 旧 SSH 路径保留到迁移验收通过。

## 16. 验收条件

### 16.1 Phase 0

**本地／自动化**（2026-11-02 已在控制面执行：`npm run check`、`npm test`、`test/execution-rpc.test.ts`、TLS loopback 的 `execution:rpc-agent --check` 与 `execution:rpc-e2e`）

- 协议：未知字段、错误版本、超大帧、分片帧、错误响应均按预期拒绝或解析。
- Unix socket：health、session.open、test.echo、session.close；该用例在 POSIX 运行，Windows 上跳过（Windows 使用命名管道语义，不代表 Unix socket 部署）。
- TLS loopback：mTLS 成功；无客户端证书、错误 CA、错误 SAN、未列入 `EXECUTION_AGENT_CLIENT_CERT_CN` 的客户端证书被拒绝。
- 流式：test.stream 的输出分多个 `output` 事件到达，`seq` 递增，最终响应在输出之后。
- 取消：test.sleep 在 cancel 后返回 `aborted`，`outcome: "unknown"`；Agent 活动请求清理。
- 断线：客户端断开后，在途请求失败；重新连接不会自动重跑。
- 重复 request id：第二个请求被拒绝，执行器只运行一次。
- 权限边界：`execute` 的 `executor: "bash"`、任意 `command`、`tool.call` 均返回 `not_implemented` 或 `invalid_request`；不存在任意命令执行路径。
- 现有测试：`npm run check`、`npm test` 不回归。

**真实跨 VPS**（状态：2026-11-02 已执行并通过；证据见 [验收记录](acceptance/20261102-execution-rpc-phase0.md)）

- Agent 部署在执行 VPS，只绑定私网地址；`ss -ltn` 不显示公网监听，Docker 不发布端口。
- Gateway 部署在控制面宿主，使用 mTLS 连接；`health.check` 返回执行 VPS 的 `executionId`。
- `test.stream` 的字节实际跨 VPS 到达 Gateway；`test.sleep` 可取消。
- 无客户端证书、错误 CA、错误 SAN、错误客户端 CN 的连接被拒绝。
- 断开 Gateway 后，Agent 在 TTL 内清理 session，无活动请求残留。
- 记录：命令、配置摘要（不含私钥）、Agent／Gateway 日志、`ss` 输出、health 和 stream／cancel 结果；本次 `executionId` 为 `3a0d7374b09e9b05`。

### 16.2 Phase 1

状态：自动化部分（loopback RPC、网关、嵌套调用、输出窗口）于 2026-11-03 通过；bwrap／cgroup／无网络／进程清理／真实跨 VPS 部分待 POSIX 与双 VPS 执行，步骤见 [Phase 1／2 Runbook](runbook-remote-ptc-phase1-2.md)。

- 脚本 `tools.bash({ command: "hostname" })` 返回执行 VPS 主机名；控制面主机名不同。
- 一个脚本内连续 10 次 bash 只使用一条 RPC 连接；嵌套调用经过 registry、`NestedCallDoc`；transcript 中只有一个 codemode `toolResult`。
- VM 与 bash 在同一 bwrap 进程树／cgroup；`/proc/net/dev` 只有 `lo`；无外网和 DNS。
- 同一 `jobId` 重放复用 workspace；已 journal 的调用不重复执行；未完成 bash 不自动重跑；workspace 缺失返回 `workspace_missing`。
- 超时／取消后无遗留 `sleep`、runner、bwrap 进程；cgroup 为空；workspace 保留。
- 10 MiB 输出：模型可见结果 ≤ 32 KiB／1000 行；`NestedCallDoc` 只有有界尾部；SQLite 无完整输出；`OutputRef` 有效；缺失时 `output_unavailable`。
- 大输出过滤与 Token 对比：按第 11.5 节记录 transcript 字节／估算 token 和下降比例。
- 预算：超过 `CODEMODE_MAX_TOOL_CALLS` 或 `CODEMODE_MAX_JOURNAL_BYTES` 时拒绝后续调用并产生诊断。
- 协议：帧外壳错误（未知帧类型／字段、超大帧、错误版本）关闭连接且不执行；合法帧的 payload 错误（错误 `sessionId`／`callId`、越界路径、错误 `cwd`／`tool`）以该请求的 id 返回 `invalid_request`／`permission_denied`，连接保持可用。错误 `callId` 的 `vm.reply` 不得被当成已投递。

### 16.3 Phase 2

状态：自动化部分于 2026-11-03 通过（`test/direct-rpc.test.ts`、`test/ptc-files.test.ts`、`test/execution-rpc.test.ts`、`test/execution-remote-env.test.ts`）；`/shared` 只读绑定、bwrap 下的真实路径与符号链接行为、跨主机重放需按部署环境复验，步骤见 [Phase 1／2 Runbook](runbook-remote-ptc-phase1-2.md)。Windows 上依赖 POSIX 符号链接与 Unix socket 的用例被跳过，需在 POSIX 执行。

- 直接 `bash` 可通过 RPC 执行，旧 SSH 路径仍可显式启用；切换模式不静默降级。
- 远程 `read`／`write`／`edit` 在 `/workspace`、`/shared`、`/tmp` 边界内工作；越界、符号链接逃逸、NUL 被拒绝。
- `read` 分块返回 `nextOffset`／`eof`；大文件不整块进入 journal。
- 写入使用同目录临时文件＋flush＋rename；失败不留半写文件。
- 重放：已完成编辑不重复，未完成按未知处理；直接 `bash` 与 `/shared` 一致性验证通过。

## 17. 风险与待验证

- **TCP/TLS 与证书运维**：mTLS 需要证书签发、轮换、SAN 和私网绑定；Phase 0 已用真实证书验收，后续仍需轮换与吊销流程，不能只用本地自签。
- **私网监听**：虽然不暴露公网，仍需绑定地址、客户端证书和现有网络策略三层限制；本阶段不改防火墙，Agent 不是任意命令服务。
- **跨 VPS 验收环境**：需要两台真实主机和私网路由；CI 只能覆盖 loopback TLS，真实验收按 runbook 记录。
- **userns 环境差异**：Debian／Ubuntu 的 sysctl、AppArmor 和 bwrap 版本可能使 `bwrap --unshare-user` 失败；必须实际 probe。
- **cgroup 委派**：容器或 systemd 环境可能没有可写子树；降级到 `prlimit` 后聚合限制更弱。
- **直接 bash 安全不对称**：Phase 1 的 bwrap 只覆盖 PTC；直接 `bash` 在 Phase 2 迁移前仍是旧路径。
- **OutputRef 生命周期**：workspace 清理、retention、hash 校验和重放必须一起验证；不能把路径当永久引用。
- **远端 VM 超时语义**：`serveCodemodeRemote` 可能在客户端超时后继续计算；Phase 1 必须靠 session 强杀验证无遗留计算。
- **journal 预算精度**：累计字节是估算值，验收检查有界增长，不追求精确页级限制。
- **版本一致性**：控制面与执行主机的 pi-codemode／QuickJS／runner 版本不一致会导致重放指纹失败；部署必须同步构建产物。

## 18. 参考

- [ADR-0019：PTC 代码调用工具（codemode）](adr/codemode-ptc/0019-codemode-ptc.md)
- [ADR-0021：控制面与执行面分离](adr/0021-control-execution-split.md)
- [ADR-0009：同一回合工具顺序执行](adr/0009-sequential-tool-execution.md)
- [ADR-0008：外部工具调用不自动重放](adr/0008-unsafe-tool-replay.md)
- [远程工具执行阶段 1](execution-remote.md)
- [代码调用工具（PTC／codemode）](codemode.md)
