# 远程工具执行（阶段 1）

本文是阶段 1 的运行说明：把 `bash` 等命令工具放到第二台 VPS 上执行，控制面只保留会话、记忆、投递与工具调用记录。设计取舍见 [ADR-0021](adr/0021-control-execution-split.md)。

> 统一 RPC Execution Agent 的 Phase 1／2 已在仓库实现：控制面设置 `EXECUTION_REMOTE_TRANSPORT=rpc` 时，直接 `bash` 与 `read`／`write`／`edit` 走同一条 RPC direct session，详见 [远程 PTC spec](spec-20261102-remote-ptc-sandbox.md) 与 [Phase 2 验收记录](acceptance/20261103-remote-ptc-phase2.md)。本文所述的 one-shot SSH 路径仍可显式选择（默认 `EXECUTION_REMOTE_TRANSPORT=ssh`），作为迁移验收前的兼容路径。
>
> 生产容器形态由 `docker-compose.rpc.yml` 提供：app 容器只连宿主 Unix socket，宿主网络里的 `rpc-gateway` 持有 mTLS 身份；部署步骤见 [Runbook 5.4](runbook-remote-ptc-phase1-2.md#54-全线-rpcapp-容器--宿主-gateway)。

SSH 传输只实现 **shell**。`read`／`write`／`edit` 等文件工具在该模式下返回 `not_supported`，这是有意的失败关闭：避免模型在控制面读到与执行面不同的同名文件。文件工作请通过 `bash` 在执行主机上完成；需要远程文件工具时改用 rpc 传输。

## 拓扑

```text
Aster 主机（控制面，例如 CONTROL_HOST）
┌────────────────────────────────────────────────────────────┐
│  app 容器（aster_mitm_clients，10.89.143.3）                │
│    EXECUTION_MODE=remote                                    │
│    /run/aster/execution/broker.sock  ← bind mount ──┐       │
│                                                      │       │
│  execution-broker 容器（network_mode: host）         │       │
│    SSH 源地址 = Aster 主机私网地址                    │       │
│    /run/aster/execution/broker.sock  ───────────────┘       │
└──────────────────────────┬─────────────────────────────────┘
                           │ SSH（BatchMode，显式 known_hosts）
                           ▼
                  执行 VPS（例如 EXECUTION_HOST）
                  本地工作目录／缓存；不是权威状态
```

- broker 不加入任何 Compose 网络，不发布 TCP 端口；应用与 broker 只通过宿主目录里的 Unix socket 通信。
- 应用容器的出站仍然只经 `aster-mitm`；执行 VPS 默认不加入 `aster_mitm_clients`／`aster_egress`。
- 这是可选 overlay：基础 `docker-compose.yml` 的单服务拓扑不变。

## 前置条件

1. 执行 VPS 上有一个专用用户（示例用 `<execution-user>`）和它的工作目录（示例 `/home/<execution-user>/workspace`）。
2. Aster 主机上有一把只用于该执行用户的 SSH 私钥，以及固定的 `known_hosts`。私钥不加口令，因为 broker 以 `BatchMode=yes` 运行；不放进仓库，也不写进 `.env`。
3. Aster 主机上有一个共享目录供 socket 使用，属主为镜像内的 `node` 用户（uid/gid 1000），权限 `0700`：

   ```bash
   install -d -m 0700 -o 1000 -g 1000 ~/Aster/run/execution
   ```

4. 先在 Aster 主机上手工验证 SSH 基线（替换占位而不要提交真实值）：

   ```bash
   ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes \
       -o UserKnownHostsFile="$HOME/Aster/secrets/execution/known_hosts" \
       -i "$HOME/Aster/secrets/execution/id_ed25519" \
       <execution-user>@EXECUTION_HOST true
   ```

## 配置

应用侧（也可直接写在 `.env`；overlay 会覆盖为 `/run/aster/execution/broker.sock`）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `EXECUTION_MODE` | 是（overlay 设置） | `remote` 启用远程执行；缺省或 `local` 使用控制面本地执行 |
| `EXECUTION_BROKER_SOCKET` | 是 | 容器内 socket 路径；必须是绝对 POSIX 路径，且不是 TCP 地址 |
| `EXECUTION_REMOTE_CWD` | 是 | 执行主机上的工作目录；必须是绝对 POSIX 路径 |
| `EXECUTION_DEFAULT_TIMEOUT_SECONDS` | 否 | 未指定超时时的默认值，默认 `300` |
| `EXECUTION_MAX_TIMEOUT_SECONDS` | 否 | 单次命令上限，默认 `3600`；默认值不得大于上限 |
| `EXECUTION_BROKER_CONNECT_TIMEOUT_MS` | 否 | 启动 ping 与连接 socket 的等待上限，默认 `5000` |

broker 侧（只在 `docker-compose.execution.yml` 中提供）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `EXECUTION_SSH_HOST` | 是 | 执行 VPS 的地址，例如 `EXECUTION_HOST` |
| `EXECUTION_SSH_USER` | 是 | 执行用户 |
| `EXECUTION_SSH_PORT` | 否 | 默认 `22` |
| `EXECUTION_SSH_KEY_FILE` | 是 | 宿主机私钥路径；只读挂载到容器内 `/run/aster/ssh/id_execution` |
| `EXECUTION_SSH_KNOWN_HOSTS_FILE` | 是 | 宿主机 known-hosts 路径；只读挂载到容器内 `/run/aster/ssh/known_hosts` |
| `EXECUTION_SSH_CONFIG_PATH` | 否 | 显式 SSH 配置；不设时 broker 使用 `-F /dev/null` |
| `EXECUTION_SSH_BIN` | 否 | SSH 可执行文件，默认 `ssh` |
| `EXECUTION_SSH_CONNECT_TIMEOUT_SECONDS` | 否 | 默认 `10` |
| `EXECUTION_SOCKET_DIR` | 否 | 宿主机共享目录；默认 `~/Aster/run/execution` |
| `EXECUTION_BROKER_MAX_CONCURRENT` | 否 | 并发执行上限，默认 `4` |
| `EXECUTION_BROKER_MAX_OUTPUT_BYTES` / `_LINES` | 否 | 每个流保留的尾部上限，默认 4 MiB／100000 行 |
| `EXECUTION_BROKER_REQUEST_TIMEOUT_MS` | 否 | 收到请求行的等待上限，默认 `15000` |

示例（写入宿主机的 shell 环境或 Compose 使用的 `.env`；值都是占位）：

```sh
EXECUTION_SOCKET_DIR=$HOME/Aster/run/execution
EXECUTION_SSH_HOST=EXECUTION_HOST
EXECUTION_SSH_USER=<execution-user>
EXECUTION_SSH_KEY_FILE=$HOME/Aster/secrets/execution/id_ed25519
EXECUTION_SSH_KNOWN_HOSTS_FILE=$HOME/Aster/secrets/execution/known_hosts
EXECUTION_REMOTE_CWD=/home/<execution-user>/workspace
```

## 启动

```bash
# 未使用 MITM overlay：
docker compose -f docker-compose.yml -f docker-compose.execution.yml --env-file .env up -d

# 使用 MITM overlay：
docker compose -f docker-compose.yml -f docker-compose.mitm.yml \
  -f docker-compose.execution.yml --env-file .env up -d
```

`docker-compose.execution.yml` 只新增 `execution-broker` 服务并给应用设置 `EXECUTION_MODE`。它不修改 `docker-compose.mitm.yml`、OpenBao、allowlist 或任何网络定义。

## 检查

先做不连 SSH、不开 socket 的配置检查：

```bash
docker compose -f docker-compose.yml -f docker-compose.execution.yml \
  --env-file .env run --rm execution-broker --check
```

输出包含 socket 路径、SSH 目标、用户、端口、密钥／known-hosts 路径和并发上限，不含密钥内容。确认无误后再 `up -d`。

应用启动时会 ping broker；broker 不可达、socket 权限不对或 SSH 目标配置非法时，进程以配置错误退出，不会静默回退到控制面执行。

## 失败语义

| 现象 | 含义 |
| --- | --- |
| 启动时报 `Execution broker is unavailable: ...` | socket 未挂载、broker 未启动、权限不对，或 ping 超时 |
| 命令返回超时错误 | 请求超时超过 `EXECUTION_MAX_TIMEOUT_SECONDS`，或远端 `timeout` 触发 |
| 命令返回 aborted | 请求被取消（例如请求整体超时），broker 已中止 SSH 子进程组 |
| `not_supported` | 在 ssh 传输下调用了文件工具；该传输只支持 shell |
| `execution broker is busy` | 同时执行的命令达到上限；这是显式拒绝，不排队、不静默丢弃 |
| 结果未知 | 连接中断或 broker 重启；按失败记录，不当作命令未执行 |

远端命令的退出码按原值返回；SSH 传输失败（`255`）与远端 `cd` 失败（`125`）在 broker 内部映射为错误帧，不会伪装成业务退出码。

## 边界与非目标

- 不承诺跨主机恰好一次。恢复重放仍按 [ADR-0008](adr/0008-unsafe-tool-replay.md) 保守处理，声明可安全重放前必须确认重复执行没有副作用。
- 切换 `EXECUTION_MODE` 或 `EXECUTION_REMOTE_TRANSPORT` 前先让未完成任务收敛。durable 恢复会把未完成的工具调用重放到当前配置的执行环境；在 ssh 传输下文件工具调用会显式失败并记录为错误，不会被当作成功。
- 执行 VPS 上的工作目录与缓存是本地状态，不参与控制面的会话／记忆／投递恢复。
- 本文的 SSH 传输不实现远程文件系统、文件监听或文件工具；rpc 传输的文件原语与其边界见 [远程 PTC spec](spec-20261102-remote-ptc-sandbox.md)。两种传输都不把执行 VPS 加入 MITM 网络，也不发布 broker 端口。
- 模型调用仍经 MITM，密钥仍由代理按占位符替换。阶段 2／3 的凭据签发与模型直连不在本文范围，见 [ADR-0021](adr/0021-control-execution-split.md#阶段顺序)。
