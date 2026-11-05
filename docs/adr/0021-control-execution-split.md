# ADR-0021：控制面与执行面分离，工具执行先下沉到执行 VPS

- **状态**：Proposed
- **日期**：2026-10-31
- **功能**：control-execution-split

## 上下文

当前部署是一台 Aster 主机（控制面，私网地址例如 `CONTROL_HOST`）上的单个应用容器。它同时承担 Telegram 收发、记忆与 durable 会话、模型调用和工具执行。应用容器只加入 `aster_mitm_clients`（`10.89.143.0/24`，固定地址 `10.89.143.3`），出站 HTTPS 必须经 `aster-mitm` 的 `14322` 端口。OpenBao 与代理的隔离语义由 [ADR-0005](0005-remove-agent-vault-single-service.md) 之后的 #48～#50 建立：专用网络 `internal: true`、固定地址、源地址白名单、代理 token、OpenBao TLS + mTLS、不发布端口。

第二台 VPS 作为执行面（例如 `EXECUTION_HOST`）。控制面容器在 `aster_mitm_clients` 内没有到执行 VPS 的路由，也不应为此获得新路由、发布端口或放宽代理白名单。执行 VPS 只负责跑命令和保存本地工作目录／缓存；会话、记忆、投递状态与工具调用记录仍以控制面为权威。

本次只落地阶段 1 的代码路径：把工具执行换到执行 VPS，不改 MITM／OpenBao／allowlist／`deploy/openbao-mitm`／`docker-compose.mitm.yml` 的网络隔离语义。

## 决策驱动因素

- `CLAUDE.md` 要求复用 pi-durable 的 agent loop、工具执行与持久化；宿主应提供执行环境，而不是另写模型循环或工具执行器。
- 安全审计边界要求外部输入在适配与执行边界校验，执行边界复核宿主条件；凭据、身份与运行目录由宿主上下文提供，不能由模型参数指定。
- 已有隔离不能被阶段 1 削弱：应用容器不新增网络、不发布端口、不绕过代理，执行 VPS 默认不加入 `aster_mitm_clients` 或 `aster_egress`。
- 单机 4 核／4 GB 的基线让“所有工具都在控制面容器里跑”成为资源与故障域的耦合点。
- 仓库以 Docker 为部署基线（[ADR-0012](0012-docker-replaces-systemd.md)），宿主机侧新增组件应沿用同一镜像与 Compose，而不是另立安装方式。

## 三个出站流

| 出站流 | 源 | 当前路径 | 阶段 1 后 |
| --- | --- | --- | --- |
| 模型调用 | 应用容器 | MITM → 提供商 | 不变 |
| 工具执行 | 应用容器 → 执行 VPS | 不可达 | 应用容器 → 宿主 Unix socket → 宿主侧 broker → SSH → 执行 VPS；不经过 MITM |
| 密钥读取 | MITM addon | mTLS → OpenBao | 不变 |

模型、工具、密钥是三条独立流。工具执行不要求“全量经 MITM”才能发生，也不把执行 VPS 接入 MITM 网络来换取可达性。

## 备选方案

- **在应用容器内直接执行远程命令（SSH 或反向代理）。** 应用容器在 `aster_mitm_clients` 内到不了执行 VPS；为它加路由或发布端口会改动 #48～#50 建立的隔离。否决。
- **把执行 VPS 加入 `aster_mitm_clients`／`aster_egress`，或让 MITM 监听 `127.0.0.1`／发布随机宿主机端口供执行 VPS 连接。** 前者扩大代理的客户端集合与源地址白名单，后者把只在专用网络内监听的代理暴露到宿主机或其他主机。否决。
- **用 systemd 在宿主机直接跑 broker。** 与 Docker 部署基线冲突，升级、权限与日志要另建一套。否决，改用同一镜像的宿主网络容器。
- **在阶段 1 同时实现远程文件系统（`ExecutionEnv` 的读、写、列目录、watch）。** 需要另一套文件协议、错误语义与权限模型，范围超出本阶段；只做 shell，文件工具显式失败。
- **替换 `CodingTools` 或自建工具执行器。** 绕过底座校验与执行恢复契约。否决，使用底座公开的 `ExecutionEnv` 接缝。
- **把 broker 放进应用容器。** 与应用容器同网络命名空间，仍然到不了执行 VPS。否决。

## 决策

1. **执行环境接缝**：应用通过 pi-durable 的 `Harness.open({ env })` 注入 `RemoteExecutionEnv`。它实现 `ExecutionEnv` 的 shell 半边；文件系统方法一律返回 `FileError("not_supported")`，避免模型在控制面读到与执行面不同的同名文件。
2. **宿主侧 broker**：`execution-broker` 容器使用同一镜像、`network_mode: host`，因此 SSH 源地址是 Aster 主机（例如 `CONTROL_HOST`）。它不加入任何 Compose 网络，不发布 TCP 端口，只监听共享宿主目录里的 Unix socket（`EXECUTION_BROKER_SOCKET`，例如 `/run/aster/execution/broker.sock`）。应用容器经同一 bind mount 访问该 socket。
3. **SSH 基线**：目标、用户、端口、私钥路径与 known-hosts 路径全部来自宿主配置，仓库只放占位。`ssh` 以 `BatchMode=yes`、`StrictHostKeyChecking=yes`、显式 `UserKnownHostsFile`、`IdentitiesOnly=yes`（配置私钥时）、`ClearAllForwardings=yes`、`ControlMaster=no`、`-F /dev/null`（或显式配置）运行；不使用 SSH agent 或用户默认配置来决定目标。
4. **协议边界**：应用与 broker 之间是每连接一个请求的换行分隔 JSON，版本固定为 1；未知字段拒绝；命令、cwd、环境变量、超时与输出窗口有显式上限。所有模型可影响的输入在进入 SSH argv 前校验，SSH 远端脚本以 base64 传输、由远端 `/bin/sh` 解码，避免二次解析。
5. **取消与超时**：请求的 `AbortSignal` 或客户端断开使 broker 中止 SSH 子进程组；远端再加 `timeout` 兜底。超时、abort、spawn 失败与业务退出码在协议中可区分；结果未知记为错误，不当作未执行。
6. **启动失败关闭**：`EXECUTION_MODE=remote` 时应用在组装 agent 前 ping broker；不可达则启动失败，不退回本地执行。
7. **部署形态**：远程执行是可选 overlay `docker-compose.execution.yml`，叠加在基础 Compose（或 MITM overlay）之上。基础单服务拓扑不变，`docker-compose.mitm.yml`、OpenBao、allowlist 与固定地址均不改动。
8. **权威状态**：durable 会话、记忆、投递与工具调用记录仍在控制面；执行 VPS 上的工作目录与缓存是本地状态，不参与恢复契约。跨主机的恢复重放仍按 [ADR-0008](0008-unsafe-tool-replay.md) 保守处理，不承诺外部命令恰好一次。

## 阶段顺序

1. **阶段 1（本 ADR、本 PR）**：工具执行改经宿主侧 broker 到执行 VPS；只支持 shell，文件工具失败关闭；控制面出站仍全部经 MITM。
2. **阶段 2**：由 Aster 主机签发／分发控制面与执行面之间的凭据，控制面（`10.89.143.3`）继续经 MITM；默认不把 Aster 主机（`CONTROL_HOST`）或执行 VPS 加入 MITM 客户端网络。是否让执行 VPS 直连模型服务另行决策。
3. **阶段 3**：模型调用直连出站。这一阶段对现有 MITM 占位符与 allowlist 的影响最大、迁移成本最高，暂缓，不在阶段 1／2 中预埋“绕开代理”的开关。

## 后果

- 工具执行与模型／Telegram 的故障域分开；执行 VPS 的资源使用不再占用控制面容器的 4 GB 预算。
- 控制面容器仍然只能经 MITM 出站，隔离语义不变；执行 VPS 默认不加入任何 MITM 网络。
- 阶段 1 的 `bash` 可以在执行 VPS 上读写文件，但 `read`／`write`／`edit` 等文件工具不可用。这是一条明确的已知限制，工具说明与启动提示都要写清楚。
- broker 是单点：它未启动、socket 权限不对或 SSH 材料缺失时，远程模式启动失败或工具调用失败；不会静默回退到控制面执行。
- 远程命令的环境变量来自 SSH 登录会话（`inheritEnv=true` 时）或显式传入的 `env`；执行 VPS 上的 `HOME`、缓存与工作目录由执行侧用户决定，控制面的 `DATA_DIR` 不适用。
- 命令输出超过窗口时只保留尾部，并通过 `skipped` 元数据报告省略量；输出与命令执行时长有上限。
- 不把新的宿主机端口、网络或代理客户端暴露出去；未来若要改动这三者，须另立 ADR，并在 #48～#50 的测试与文档中同步复核。
- 切换 `EXECUTION_MODE` 前应让未完成任务收敛。durable 恢复会把未完成的工具调用重放到当前配置的执行环境；远程模式下文件工具调用会显式失败并记录为错误，不会被当作成功，也不会把本地执行结果冒充为远程结果。

## 与 #48～#50 的关系

#48 建立 OpenBao + MITM 代理，#49 收紧网络（`internal: true`、固定地址、不发布端口），#50 增加代理 token 与 OpenBao TLS + mTLS。本 ADR 不修改这些组件的任何配置或语义，只新增一条不经过它们的执行路径。已知的张力是“所有对外流量都经 MITM”这一表述：阶段 1 起，工具执行流量走宿主 broker 的 SSH，而不是 MITM。**这不能被解读为允许把 MITM 绑定到 `127.0.0.1`、发布随机端口，或把执行 VPS 加入代理客户端白名单。** 相关 README、拓扑测试与代理单测在后续阶段若需调整，应逐项说明哪些隔离不变量保持不变；本 PR 只新增文档与执行路径测试，不改动既有 MITM 测试。

## 分阶段决策与缺陷历史

### 2026-10-31：阶段 1 代码路径

- 相关 spec：无独立临时 spec；本 ADR 直接记录阶段 1 的范围与限制。
- 决策与取舍：采用宿主网络 broker + 共享 Unix socket + SSH 基线；`RemoteExecutionEnv` 只实现 shell，文件工具失败关闭；远程执行作为可选 Compose overlay，基础拓扑与 MITM overlay 不变。
- 相关缺陷：尚未发现。阶段 1 的已知限制（无远程文件工具、broker 单点、输出只保留尾部）已写入“后果”，不是待修复缺陷。
