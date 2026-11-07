# Remote PTC Phase 1／2 实机部署与验收 Runbook

本文覆盖 **Phase 1（远程 PTC sandbox）** 与 **Phase 2（direct RPC bash 与文件原语）** 在真实双 VPS 上的部署和验收。Phase 0 的通道、证书、systemd 与负向检查仍以 [Phase 0 Runbook](runbook-execution-rpc-phase0.md) 为准，本文不重复其证书细节。

- Phase 1／2 的自动化验收见 [2026-11-03 验收记录](acceptance/20261103-remote-ptc-phase2.md)。
- 规格与验收条件见 [远程 PTC spec](spec-20261102-remote-ptc-sandbox.md) 16.2／16.3。
- Phase 0 已在 2026-11-02 通过真实双 VPS 验收；本文的部署直接建立在同一套 mTLS 通道上。

## 1. 通过判定

Phase 1／2 必须同时满足：

1. 自动化基线全部通过，且在 POSIX 上实际执行符号链接和 Unix socket 用例。
2. Phase 1 的 16.2 检查全部通过。
3. Phase 2 的 16.3 检查全部通过。
4. 负向用例全部按预期失败，没有静默回退、越界读取或重复执行。
5. 第 8 节的证据已保存。

任何一项失败都不能标记为通过。只有 loopback、同机容器或本地自签证书的结果不能替代双 VPS 验收。

### 1.1 自动化基线

在控制面或 Linux CI 执行：

```sh
npm run check
npm run build
npm test
```

预期：三个命令退出码为 0，测试为 0 fail。Windows 会跳过依赖 POSIX 符号链接、Unix socket 与 `process.execve` 的用例；不得把跳过当作通过。当前 Windows 基线（含本分支修复）：374 tests、360 pass、0 fail、14 skipped；Linux CI 在当前 head `dc5560e` 上为 374 tests、366 pass、0 fail、8 skipped（run `41602806264`），符号链接、Unix socket 与 cgroup 预入组用例均实际执行。远程 codemode 用例已改为 direct-session 拓扑，在所有平台运行。

## 2. 部署位置与拓扑

```text
控制面 VPS（CONTROL_HOST）
  持有 EXECUTION_MODE=remote + EXECUTION_REMOTE_TRANSPORT=rpc 的进程
        │  私网 TCP 9443，mTLS（Phase 0 通道）
        ▼
执行 VPS（EXECUTION_HOST）
  aster-rpc-agent（systemd）
    ├─ PTC session：bwrap + cgroup v2 + job workspace + runner
    └─ direct session：每个请求一个 bwrap + 共享目录 + 私有 /tmp
```

**部署位置必须明确**：打开 RPC 连接的是持有 `EXECUTION_MODE=remote` 的进程（`openAgent` 在启动时连接并做 health 检查）。本 Runbook 的 Phase 1／2 验收在**控制面主机的宿主环境**运行应用或验收脚本，与 Phase 0 相同；该主机必须能通过私网访问执行 VPS 的 9443。

Docker app 容器只允许访问宿主 Unix socket，**不要**为了 RPC 给容器增加执行 VPS 路由。全线 RPC 的生产形态由宿主网络里的 `rpc-gateway` 容器承担 mTLS 客户端身份，app 容器只连 Unix socket；部署与回滚见 5.4。该 gateway 是本分支新增的部署能力，Phase 1／2 的既有验收证据仍来自宿主环境运行，不因 5.4 而回溯改写。

前提沿用 Phase 0：

| 项 | 示例 |
| --- | --- |
| 控制面私网地址 | `CONTROL_HOST` |
| 执行 VPS 私网地址 | `EXECUTION_HOST` |
| Agent 监听端口 | `9443` |
| 服务端名称 | `execution.internal` |
| Gateway 客户端 CN | `aster-gateway` |
| 代码目录 | `/opt/aster` |
| 证书目录 | `/etc/aster/rpc` |

本阶段新增前提：

| 项 | 示例 | 约束 |
| --- | --- | --- |
| 执行用户 | `aster-exec` | 运行 Agent；不需要 root |
| PTC job 根目录 | `/home/aster/jobs` | `PTC_WORKSPACE_ROOT`，仅该用户可写 |
| 共享工作区 | `/srv/shared` | `PTC_SHARED_WORKSPACE`，挂到沙箱 `/shared` |
| 共享工作区模式 | `rw` | Phase 2 direct 与文件工具要求 `rw`；`ro` 只能验收只读边界 |
| direct tmp 根 | `/run/aster` | `PTC_DIRECT_TMP_ROOT`；每个 session 在其下建私有目录 |
| cgroup 根 | `/sys/fs/cgroup/system.slice/aster-rpc-agent.service/ptc` | 单元 cgroup 的委派子树内；不能进入时 Agent 拒绝启动 |
| bwrap | `/usr/bin/bwrap` | 实际 probe，不以安装包存在为准 |

## 3. 执行 VPS 前提与预检

以下命令以 `aster-exec` 身份执行，除非明确使用 `sudo`。先记录内核与运行时事实：

```sh
uname -a
node --version
bwrap --version
cat /proc/sys/user/max_user_namespaces
stat -fc %T /sys/fs/cgroup
cat /sys/fs/cgroup/cgroup.controllers
cat /sys/fs/cgroup/cgroup.subtree_control
```

要求：

- Node.js 为 `.node-version` 指定的 24.19.0。
- `bwrap --version` 成功。
- `/proc/sys/user/max_user_namespaces` 大于 0。
- `/sys/fs/cgroup` 文件系统类型为 `cgroup2fs`。
- `cgroup.controllers` 至少包含 `memory pids cpu`。

### 3.1 user namespace 与 AppArmor

实际启动一个最小的用户命名空间，而不是只看 sysctl：

```sh
bwrap --unshare-user --uid 0 --gid 0 --ro-bind / / true
```

预期退出码 0。若在 Ubuntu 24.04 上失败并出现 `operation not permitted`，先检查：

```sh
sysctl kernel.apparmor_restrict_unprivileged_userns
```

该值为 1 时，未授权的用户命名空间会被 AppArmor 拒绝。处理方式由主机安全负责人决定（例如为执行用户配置 AppArmor profile，或调整 sysctl）；**不要**把失败静默降级为 `PTC_ALLOW_DEGRADED=1`，降级会失去网络与命名空间隔离，不能用于 Phase 1／2 通过判定。

### 3.2 cgroup v2 委派

Agent 在 `PTC_CGROUP_ROOT` 下创建每个 session 的子 cgroup，并写入 `memory.max`、`pids.max`、`cpu.max`。根的位置不是任意的：内核做 cgroup 迁移时，除了目标 `cgroup.procs`，还要求写入者拥有**源与目标最近公共祖先**的写权限。Agent 自己运行在单元 cgroup 里，所以根必须是单元 cgroup 之内的目录；像 `/sys/fs/cgroup/aster-ptc` 这样的旁挂根，公共祖先是 root 拥有的 `/sys/fs/cgroup`（`0644`），未提权服务写 `cgroup.procs` 会得到 `EACCES`。

单元 cgroup 只有在没有自身进程时才能开启控制器（“no internal process”），因此用 `DelegateSubgroup=` 把 Agent 放进子组 `agent`。systemd 254 起支持该设置，并把整个单元 cgroup 交给服务用户；systemd 只让控制器“可用”，不会替服务开启，所以 Agent 自己在启动时写入 `subtree_control`（幂等，每次创建 session 前也会补写）。

```ini
[Service]
User=aster-exec
Delegate=yes
DelegateSubgroup=agent
```

`PTC_CGROUP_ROOT` 用默认值即可（Agent 从 `/proc/self/cgroup` 推导出单元 cgroup，再取同级的 `ptc` 目录）：

```sh
PTC_CGROUP_ROOT=/sys/fs/cgroup/system.slice/aster-rpc-agent.service/ptc
```

说明：

- 布局是 `<unit>/agent`（Agent 自身）与 `<unit>/ptc/<session>`（sandbox）；迁移的公共祖先是 `<unit>`，已委派给 `aster-exec`，可写。systemd 在启动服务时会把单元 cgroup 目录连同 `cgroup.procs`、`cgroup.subtree_control` 一起交给服务用户（`cg_set_access`），所以这里不需要任何 root 侧的 `echo > cgroup.procs` 预置。
- 不设置 `DelegateSubgroup=` 时 Agent 留在 `<unit>` 内，开启控制器返回 `EBUSY`。`--check` 的 `cgroupReason` 会指出这一点。
- 不要继续沿用 `/sys/fs/cgroup/aster-ptc`：即使 root 手动建好目录并开启两级 `subtree_control`，未提权服务也无法把任务迁入（2026-11-03 验收实测 `EACCES`）。
- 进程必须在 bwrap 启动前进入目标 cgroup。bwrap 带 `--unshare-cgroup`，一旦执行，父进程再写该 session 的 `cgroup.procs` 会被内核拒绝（`EACCES`／`ENODEV`）。当前实现由 helper 先写入自身 PID 再 `execve` bwrap；验证时观察日志里不应出现 `could not be accounted for`。
- 这是对执行主机的配置变更，不是防火墙变更；记录到证据中。

以上目录由单元和 Agent 在运行时创建，部署前并不存在，所以验证放在 4.3 首次启动之后。自迁移写入失败（`Permission denied`／`No such device`／`No such file`）说明位置、委派或控制器不对，此时不要继续 Phase 1／2。

### 3.3 目录与挂载

```sh
sudo install -d -m 0750 -o aster-exec -g aster-exec \
  /home/aster/jobs /srv/shared
sudo install -d -m 0755 -o aster-exec -g aster-exec /srv/shared/aster
```

- `/srv/shared` 是执行主机上的持久目录，不是容器卷；重放依赖它，不能被部署更新清空。
- Phase 1 的 job workspace 由 Agent 在 `/home/aster/jobs/<jobId>/workspace` 创建；控制面不读写该目录。
- Phase 2 的 direct session 只看到 `/srv/shared`（挂为 `/shared`）和该 session 的私有 `/tmp`；`/workspace` 不会挂载。
- `PTC_DIRECT_TMP_ROOT` 必须存在且可写。使用 systemd 时推荐 `RuntimeDirectory=aster`，即 `/run/aster`。

## 4. 执行 VPS 部署

### 4.1 代码与构建

```sh
cd /opt/aster
sudo -u aster-exec git fetch origin feat/remote-ptc-sandbox-phase1
sudo -u aster-exec git switch feat/remote-ptc-sandbox-phase1
sudo -u aster-exec npm ci
sudo -u aster-exec npm run build
git rev-parse HEAD
```

记录 commit。Phase 1／2 代码不在 `main` 上，不能从 `main` 构建后声称验收的是本分支。控制面与执行面必须使用同一 commit 与同一 lockfile，避免 runner／QuickJS 版本不一致导致重放指纹失败。

### 4.2 Agent 配置

在 Phase 0 的 `/etc/aster/rpc-agent.env` 基础上追加：

```sh
PTC_ENABLED=1
PTC_WORKSPACE_ROOT=/home/aster/jobs
PTC_SHARED_WORKSPACE=/srv/shared
PTC_SHARED_WORKSPACE_MODE=rw
PTC_DIRECT_ENABLED=1
PTC_DIRECT_TMP_ROOT=/run/aster
PTC_CGROUP_ROOT=/sys/fs/cgroup/system.slice/aster-rpc-agent.service/ptc
PTC_CGROUP_MEMORY_MAX_BYTES=536870912
PTC_CGROUP_PIDS_MAX=128
PTC_CGROUP_CPU_MAX="200000 100000"
PTC_ALLOW_DEGRADED=0
PTC_BWRAP_PATH=/usr/bin/bwrap
PTC_NODE_PATH=/usr/local/bin:/usr/bin:/bin
PTC_JOB_RETENTION_HOURS=168
```

注意：

- `PTC_CGROUP_CPU_MAX` 含空格，写入 EnvironmentFile 时保持原样；systemd 会按整行传值。
- 入组 helper 是一个短暂的 Node 进程（约 11 个任务、40 MiB 左右），它先计入 session cgroup，再 `execve` bwrap 变成只有一个任务的 sandbox。`PTC_CGROUP_PIDS_MAX` 不能低于 ~16，`PTC_CGROUP_MEMORY_MAX_BYTES` 不能低于 ~64 MiB，否则 helper 自己会被拒绝入组（`EAGAIN`）；上面的 128／512 MiB 是留有余量的取值。
- `PTC_ALLOW_DEGRADED` 只能是 `0` 或 `1`；验收必须为 `0`。
- `PTC_DIRECT_ENABLED=1` 同时要求 `PTC_SHARED_WORKSPACE` 和可写的 `PTC_DIRECT_TMP_ROOT`，否则 `--check` 失败。
- `PTC_ENABLED=1` 且隔离不可用时，Agent 直接拒绝监听；这是有意的失败关闭，不要绕过。

### 4.3 systemd

在 Phase 0 单元基础上增加运行目录和可写路径：

```ini
[Service]
RuntimeDirectory=aster
RuntimeDirectoryMode=0750
# 委派给单元自己的 cgroup 子树：Agent 要在这里建 session cgroup 并写 cgroup.procs。
Delegate=yes
DelegateSubgroup=agent
ReadWritePaths=/home/aster/jobs /srv/shared /run/aster /sys/fs/cgroup/system.slice/aster-rpc-agent.service
# ProtectSystem=strict 默认同时隐藏 home 与只读 cgroupfs；PTC 与 direct 路径都在 /home/aster 下。
ProtectHome=false
ProtectKernelTunables=false
ProtectControlGroups=false
```

`ProtectSystem=strict` 会把文件系统其余部分挂成只读；没有上面的 `ReadWritePaths`，Agent 能启动但无法创建 job workspace、写入共享目录或创建 cgroup，错误会在第一次 session 打开时才出现。`PrivateTmp=true` 保留；`PTC_DIRECT_TMP_ROOT=/run/aster` 不使用服务的私有 `/tmp`。不要启用 `ProtectKernelTunables=true`，否则 Agent 无法写入 cgroup 控制文件；`ProtectHome=true` 会让 `/home/aster/jobs` 不可见，`ProtectControlGroups=true` 会让 `/sys/fs/cgroup` 整个只读。三项都必须显式设为 `false`，因为 `ProtectSystem=strict` 的默认值不是 `false`。

> 实测：2026-11-03 的两轮真实双 VPS 验收都失败在两个部署前提上，第二轮（head `415bb67`）的结论已并入本节。
>
> 第一轮：进程在 bwrap `--unshare-cgroup` 之后才被写入 `cgroup.procs`（`EACCES`／`ENODEV`）。修复为先由 helper 把自身 PID 写入目标 cgroup，再 `execve` bwrap，PID 与归属随 exec 保留，迁移发生在 unshare 之前。
>
> 第二轮：入组顺序正确后仍报 `EACCES`，因为根是旁挂的 `/sys/fs/cgroup/aster-ptc`，迁移的公共祖先是 root 拥有的 `/sys/fs/cgroup`。修复为把根放进单元 cgroup 的委派子树（`Delegate=yes`＋`DelegateSubgroup=agent`）；`--check` 同时改为执行真实自迁移，不再用“能建目录、能写 `pids.max`”冒充可用。同一轮还暴露出 bubblewrap 0.11.1 不认识 `--no-new-privs`（`bwrap: Unknown option`，exit 1）：该标志已移除，bwrap 在解析参数前就自行设置 `PR_SET_NO_NEW_PRIVS`。
>
> 若出现 "the sandbox process could not be accounted for: …"，先看 `--check` 的 `cgroupReason`；控制器启用、公共祖先权限与入组位置都会在那里给出内核原始错误。

```sh
sudo systemctl daemon-reload
sudo systemctl restart aster-rpc-agent
systemctl status aster-rpc-agent --no-pager
journalctl -u aster-rpc-agent -n 50 --no-pager
```

日志必须包含实际监听地址和 `executionId`，不包含私钥、token 或 workspace 之外的路径细节；也不能出现 `PTC is enabled but this host cannot provide`（那条错误会带上 `cgroupReason`）。

单元第一次启动后，单元 cgroup 与 `ptc` 目录才存在。这时可以按生产路径手工复验一次自迁移：

```sh
sudo -u aster-exec sh -eu -c '
  unit=/sys/fs/cgroup/system.slice/aster-rpc-agent.service
  d=$unit/ptc/acceptance-probe
  mkdir -p "$d"
  echo 8 > "$d/pids.max"
  # 与运行时相同：进程在 exec 之前把自己的 PID 写入 cgroup.procs。
  sh -euc "echo \$\$ > $d/cgroup.procs"
  rmdir "$d"
  echo cgroup-probe-ok
'
```

`-e` 让任一前提失败（目录不可写、`pids.max` 写不进、迁移被拒、目录残留）在打印 `cgroup-probe-ok` 之前以非零退出；看到 `cgroup-probe-ok` 才说明探针成功，不要把错误输出和成功标记一起抄进证据。若 `rmdir` 报 `Device or resource busy`，说明进程仍留在该 cgroup，按 3.2 检查委派与入组顺序。

### 4.4 配置检查

在 4.3 重启单元之后执行（单元 cgroup 只有在服务运行时才存在；`--check` 本身不启动服务）：

```sh
cd /opt/aster
sudo -u aster-exec sh -c '
  set -a
  . /etc/aster/rpc-agent.env
  set +a
  npm run execution:rpc-agent -- --check
'
```

预期 JSON 至少包含：

```json
{
  "transport": "tls",
  "ptc": {
    "bwrap": true,
    "userNamespace": true,
    "cgroup": true,
    "workspaceRoot": true,
    "sharedWorkspace": true,
    "directTmpRoot": true,
    "usable": true
  },
  "direct": {
    "direct": true,
    "sharedWorkspace": true,
    "directTmpRoot": true
  }
}
```

`ptc` 的 `bwrap`、`userNamespace`、`cgroup`、`workspaceRoot`、`sharedWorkspace`、`directTmpRoot`、`usable` 必须全为 `true`。任一为 `false` 且输出里带 `cgroupReason` 时，按该内核错误修正 3.2 的委派；不要把 `cgroupReason` 抄进验收结论而不修配置。

这个 `--check` 从 SSH shell 运行，进程不在单元 cgroup 里，因此它检查的是单元 cgroup 可写、控制器可用这两项前提；真正“把任务迁入 session cgroup”的探针由 Agent 启动时在单元内执行。运行时 `health.isolation` 必须是 `{"mode":"bwrap","bwrap":true,"userNamespace":true,"cgroup":"v2","network":"none"}`；出现 `degraded-prlimit`、`cgroup: "none"`、`network: "host"` 或任一 `false` 时停止，先修复主机能力。

### 4.5 监听检查

```sh
ss -ltnp sport = :9443
```

仍然要求只绑定 `EXECUTION_HOST:9443` 或 loopback，不出现 `0.0.0.0`、`[::]` 或公网地址。cgroup 与 bwrap 是执行边界的补充，不能替代私网监听与 mTLS。

## 5. 控制面部署与配置

### 5.1 构建

```sh
cd /opt/aster
git fetch origin feat/remote-ptc-sandbox-phase1
git switch feat/remote-ptc-sandbox-phase1
npm ci
npm run build
git rev-parse HEAD
```

### 5.2 配置

```sh
EXECUTION_MODE=remote
EXECUTION_REMOTE_TRANSPORT=rpc
EXECUTION_REMOTE_CWD=/shared/aster
EXECUTION_RPC_TRANSPORT=tls
EXECUTION_RPC_ADDRESS=EXECUTION_HOST:9443
EXECUTION_RPC_SERVER_NAME=execution.internal
EXECUTION_RPC_CA_PATH=/etc/aster/rpc/ca.crt
EXECUTION_RPC_CERT_PATH=/etc/aster/rpc/client.crt
EXECUTION_RPC_KEY_PATH=/etc/aster/rpc/client.key
EXECUTION_RPC_CONNECT_TIMEOUT_MS=5000
EXECUTION_RPC_REQUEST_TIMEOUT_MS=30000
EXECUTION_DEFAULT_TIMEOUT_SECONDS=300
EXECUTION_MAX_TIMEOUT_SECONDS=3600
CODEMODE_ENABLED=1
```

关键约束：

- `EXECUTION_REMOTE_CWD` 在 rpc 传输下必须是 `/shared` 或 `/shared` 下的路径；`/shared/aster` 必须在执行主机上预先存在。直接 `bash` 的默认 cwd 就是它。
- 应用启动时会做 health 检查，要求 `protocol === 1`、`directBash === true`、`fileTools === true`、`sharedMode === "rw"`；任一不满足则启动失败，不会退回本地或 ssh。
- 远程 codemode 即使 direct 传输是 ssh，也会使用 `EXECUTION_RPC_*` 连接同一个 Agent；两条路径的 Agent 与证书必须一致。
- 不要把客户端的私钥、token 或真实地址写进 `.env` 提交；验收记录只保存脱敏摘要。

### 5.3 通道回归

沿用 Phase 0 的 6 节正向与负向检查，确认通道本身没有回归。Phase 1／2 的 Agent 仍应通过 `health.check` 返回执行面的 `executionId`，且 TLS 负向用例仍被拒绝。`EXECUTION_AGENT_TEST_EXECUTOR` 在生产应为 `0`；验收期间如需运行 `execution:rpc-e2e`，可临时设为 `1`，验收后恢复。Phase 1／2 的检查不依赖 test executor。

### 5.4 全线 RPC：app 容器 + 宿主 gateway

app 容器在 `aster_mitm_clients` 内没有到执行 VPS 的路由（ADR-0021）。迁移后这一点不变：`rpc-gateway` 容器使用宿主网络命名空间持有 mTLS 客户端身份，app 容器只连宿主上的 Unix socket。gateway 逐字节转发 RPC 帧，不解释、不重放、不授权；身份仍由 `aster-gateway` 客户端证书和 agent 的 CN 校验决定。

```text
app 容器 ── /run/aster/execution/rpc.sock ──▶ rpc-gateway（宿主网络）── TCP 9443 mTLS ──▶ agent
```

准备（控制面宿主）：

```sh
# gateway 只挂载这三件套；目录 0700、私钥 0600
install -d -m 0700 ~/Aster/secrets/execution-rpc
install -m 0644 /etc/aster/rpc/ca.crt ~/Aster/secrets/execution-rpc/ca.crt
install -m 0644 /etc/aster/rpc/client.crt ~/Aster/secrets/execution-rpc/client.crt
install -m 0600 /etc/aster/rpc/client.key ~/Aster/secrets/execution-rpc/client.key

# app 与 gateway 共享的 socket 目录
install -d -m 0700 -o 1000 -g 1000 ~/Aster/run/execution
```

执行主机上创建直接命令的默认 cwd（`/shared` 就是 `/srv/shared`）：

```sh
sudo install -d -m 0775 -o aster-exec -g aster-exec /srv/shared/aster
```

`.env` 追加（app 容器不再需要任何执行证书路径）：

```sh
EXECUTION_REMOTE_CWD=/shared/aster
EXECUTION_RPC_ADDRESS=EXECUTION_HOST:9443
EXECUTION_RPC_SERVER_NAME=execution.internal
EXECUTION_RPC_CERT_DIR=/home/ubuntu/Aster/secrets/execution-rpc
CODEMODE_ENABLED=1
```

启动时**不要**叠加 `docker-compose.execution.yml`（它定义的是旧 SSH broker）：

```sh
docker compose -f docker-compose.yml -f docker-compose.mitm.yml \
  -f docker-compose.rpc.yml --env-file .env up -d personal-agent rpc-gateway
```

验证：

```sh
# gateway 配置与 TLS 材料可读，不监听、不连接
docker compose ... run --rm rpc-gateway --check
# 启动日志只出现 rpc-gateway-ready，不打印证书或帧内容
docker compose ... logs rpc-gateway
# 从宿主经同一个 socket 做 health 检查（与 app 走同一路径）
cd /opt/aster && EXECUTION_RPC_TRANSPORT=unix \
  EXECUTION_RPC_SOCKET=/home/ubuntu/Aster/run/execution/rpc.sock \
  node --input-type=module -e '
    import { readRpcClientConfig } from "./dist/src/execution/rpc-config.js";
    import { connectRpcClient } from "./dist/src/execution/rpc-connect.js";
    const client = await connectRpcClient(readRpcClientConfig());
    console.log(JSON.stringify(await client.health()));
    await client.close();'
```

- gateway 只接受 `EXECUTION_RPC_TRANSPORT=tls`，socket 路径必须是绝对 POSIX 路径；路径上已有非 socket 文件时拒绝启动，不会删除它。
- app 容器的环境与镜像里不出现 `EXECUTION_RPC_*_PATH`、客户端证书或私钥；它只能打开 socket。
- socket 权限为 0600，所在目录 0700（uid 1000）；同一宿主上的其他用户不能借 gateway 访问执行面。
- 回滚：`docker compose ... stop rpc-gateway`，改回 `docker-compose.execution.yml` 的 SSH 路径并重建 app；回滚前先让未完成任务收敛。

## 6. Phase 1 验收（远程 PTC）

以下脚本在控制面执行，使用 `dist` 构建产物，直接走统一 RPC 协议。脚本只打印结果，不写入控制面文件。所有 session 都要在 `finally` 中关闭。

### 6.1 准备工作目录

```sh
mkdir -p /root/aster-accept
```

把脚本保存为 `/root/aster-accept/phase1.mjs`。`jobId` 使用固定的验收值，便于在证据中引用；不要复用真实会话的 jobId。PTC sessionId 同时是 cgroup 目录名，必须是 16 个小写十六进制字符（`/^[a-f0-9]{16}$/`）；带 `jobId` 的 `session.open` 传入其他格式会得到 `invalid_request`，重放 session 也要单独生成一个 16 hex id（不能拼接后缀）。direct session 没有这个格式限制。

```js
import { randomBytes } from "node:crypto";
import { readRpcClientConfig } from "/opt/aster/dist/src/execution/rpc-config.js";
import { connectRpcClient } from "/opt/aster/dist/src/execution/rpc-connect.js";

const client = await connectRpcClient(readRpcClientConfig());
const sessionId = randomBytes(8).toString("hex");
const replaySessionId = randomBytes(8).toString("hex");
const jobId = `ptc-${"1".repeat(32)}`;
const report = {};
const toolResults = [];
let terminal;

const fail = (message) => { throw new Error(message); };
const callArgs = (command) => ({
  command,
  cwd: "/workspace",
  env: {},
  inheritEnv: false,
  timeoutMs: 30_000,
  window: { maxBytes: 32 * 1024, maxLines: 1_000, minIntervalMs: 0, bytesPerSecond: 0 },
});

// `done.value` 是脚本返回值的 JSON 文本（stringify），所以字符串返回值要解析一次才拿到原文。
// 只保留有界尾部：模型可见窗口是 32 KiB，回传完整 10 MiB 会直接违反下面的可见长度断言。
const MAX_VISIBLE_BYTES = 32 * 1024;
function tailBytes(text, max) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  let start = buf.length - max;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

function startScript(code, scriptSessionId = sessionId) {
  terminal = undefined;
  return client.startVm(scriptSessionId, { request: { data: {
    code,
    tools: [{ name: "bash", jsName: "bash", description: "Run a command" }],
    globals: [],
    store: {},
  } } }, {
    deadlineMs: 180_000,
    onVmMessage: (event) => {
      const done = event.messages.find((message) => message.type === "done");
      if (done !== undefined) terminal = done;
      if (event.callId === undefined) return;
      const call = event.messages.find((message) => message.type === "call" && message.id === event.callId);
      if (call === undefined) return;
      const args = JSON.parse(String(call.args));
      let tail = "";
      const tool = client.startToolCall(scriptSessionId, {
        tool: "bash",
        callId: event.callId,
        args: callArgs(args.command),
      }, {
        deadlineMs: 120_000,
        onToolOutput: (chunk) => { tail = tailBytes(tail + chunk.text, MAX_VISIBLE_BYTES); },
      });
      void tool.result.then(
        (result) => {
          toolResults.push({
            callId: event.callId,
            outputRef: result.outputRef ?? null,
            spillTruncated: result.spillTruncated,
            exitCode: result.exitCode,
          });
          return client.replyVm(scriptSessionId, {
            callId: event.callId,
            reply: {
              type: "result", id: event.callId, ok: true,
              payload: JSON.stringify({ output: tail, exitCode: result.exitCode }),
            },
          });
        },
        (error) => client.replyVm(scriptSessionId, {
          callId: event.callId,
          reply: { type: "result", id: event.callId, ok: false, payload: String(error?.message ?? error) },
        }),
      ).catch(() => undefined);
    },
  });
}

try {
  const health = await client.health();
  report.health = {
    executionId: health.executionId,
    phase: health.phase,
    isolation: health.isolation,
    directBash: health.directBash,
    fileTools: health.fileTools,
    sharedMode: health.sharedMode,
  };
  if (health.phase !== 2 || health.isolation?.mode !== "bwrap") fail("the agent does not report a Phase 2 bwrap sandbox");
  if (health.isolation.network !== "none" || health.isolation.cgroup !== "v2") fail("isolation is not bwrap+cgroup v2+no network");

  const preflight = await client.preflight();
  report.preflight = preflight;
  if (preflight.ok !== true) fail("preflight is not ok");

  const opened = await client.openSession(sessionId, { jobId });
  report.workspace = opened.workspaceReady;
  if (opened.workspaceReady?.path !== "/workspace") fail("the workspace path is not /workspace");

  const ten = startScript(`
    const values = [];
    for (let i = 0; i < 10; i++) {
      const result = await tools.bash({ command: "uname -n" });
      values.push(String(result.output).trim());
    }
    return values.join(",");
  `);
  await ten.result;
  if (terminal?.ok !== true) fail(`the ten-call script failed: ${String(terminal?.value)}`);
  const hostnamesText = JSON.parse(String(terminal.value));
  if (typeof hostnamesText !== "string") fail("the ten-call script did not return a string");
  report.hostnames = hostnamesText.split(",");
  if (report.hostnames.length !== 10) fail("the ten-call script did not return ten values");
  if (report.hostnames.some((name) => name.length === 0)) fail("a sandbox identity came back empty");
  if (new Set(report.hostnames).size !== 1) fail("the ten bash calls did not all return the same hostname");

  const net = startScript(`
    const dev = await tools.bash({ command: "cat /proc/net/dev" });
    const route = await tools.bash({ command: "cat /proc/net/route" });
    return JSON.stringify({ dev: dev.output, route: route.output });
  `);
  await net.result;
  if (terminal?.ok !== true) fail(`the network script failed: ${String(terminal?.value)}`);
  // 脚本返回 JSON.stringify(...)（字符串），`done.value` 又是该字符串的 JSON 文本，所以要解析两层。
  const networkText = JSON.parse(String(terminal.value));
  if (typeof networkText !== "string") fail("the network script did not return a JSON string");
  report.network = JSON.parse(networkText);
  if (!/^\s*lo:/m.test(report.network.dev)) fail("/proc/net/dev does not contain lo");
  if (/\b(eth|ens|enp|docker|veth)[0-9]/m.test(report.network.dev)) fail("/proc/net/dev shows a non-loopback interface");
  if (report.network.route.trim().split("\n").length > 1) fail("/proc/net/route is not empty beyond the header");

  const write = startScript(`
    const first = await tools.bash({ command: "printf reusable > replay.txt && cat replay.txt" });
    return String(first.output);
  `);
  await write.result;
  if (terminal?.ok !== true) fail(`the workspace write failed: ${String(terminal?.value)}`);
  if (JSON.parse(String(terminal.value)).trim() !== "reusable") fail("the workspace write did not round-trip");

  report.tenCallConnection = "one RPC connection; verify with ss on the control plane and the agent session count";
  await client.closeSession(sessionId);

  const reopened = await client.openSession(replaySessionId, { jobId, workspaceReady: true });
  report.replayWorkspace = reopened.workspaceReady;
  if (reopened.workspaceReady?.reused !== true) fail("the same jobId did not reuse its workspace");
  await client.closeSession(replaySessionId);

  // 重放 session 已关闭；后续脚本继续使用原 sessionId 会得到 not_found，所以再开一个同 job 的 session。
  const bigSessionId = randomBytes(8).toString("hex");
  report.bigSessionId = bigSessionId;
  await client.openSession(bigSessionId, { jobId, workspaceReady: true });
  const big = startScript(`
    const result = await tools.bash({ command: "head -c 10485760 /dev/zero | tr '\\0' x" });
    return String(result.output.length);
  `, bigSessionId);
  await big.result;
  if (terminal?.ok !== true) fail(`the 10 MiB script failed: ${String(terminal?.value)}`);
  const visibleLength = Number(JSON.parse(String(terminal.value)));
  if (!Number.isSafeInteger(visibleLength)) fail("the 10 MiB script did not return a length");
  const bigCall = toolResults.at(-1);
  report.bigOutput = {
    visibleLength,
    outputRef: bigCall?.outputRef ?? null,
    spillTruncated: bigCall?.spillTruncated,
  };
  // 客户端只回传有界尾部，脚本收到的长度必须落在 32 KiB 窗口内。
  if (visibleLength > MAX_VISIBLE_BYTES) fail("the model-visible result exceeded the window");
  if (bigCall?.outputRef === null || bigCall?.outputRef === undefined) fail("the 10 MiB call produced no OutputRef");
  if (bigCall.outputRef.jobId !== jobId) fail("the OutputRef names another job");
  if (bigCall.outputRef.size !== 10 * 1024 * 1024) fail("the OutputRef size is not the full output size");
  if (bigCall.spillTruncated !== false) fail("the output was truncated instead of spilled");

  console.log(JSON.stringify({ status: "ok", ...report }, null, 2));
} finally {
  await client.closeSession(sessionId).catch(() => undefined);
  await client.closeSession(replaySessionId).catch(() => undefined);
  await client.closeSession(report.bigSessionId ?? "").catch(() => undefined);
  await client.close();
}
```

运行：

```sh
node /root/aster-accept/phase1.mjs
```

检查：

- `status` 为 `ok`。
- `health.phase` 为 `2`，`isolation.cgroup` 为 `"v2"`，`network` 为 `"none"`。
- `hostnames` 恰好 10 个、全部非空且相同，用 `uname -n` 取值（`hostname` 在沙箱内可能为空，不能作为身份判据）；再与执行 VPS 的 `uname -n` 对比，且与控制面不同。`ledger` 中这类空值必须判失败，不能当成“一致”。
- `network.dev` 只有 `lo`；`network.route` 除表头外为空。
- `workspace.created === true`；重开同一 jobId 时 `workspace.reused === true`。重放使用独立的 16 hex sessionId，不是带后缀的字符串。
- 运行期间在控制面执行 `ss -tnp dport = :9443`，只看到一条到执行面的连接用于该脚本；在 Agent 侧 `journalctl` 或 `ss` 中不应出现每个 bash 调用一条新连接。

### 6.2 输出上限与 `OutputRef`

`phase1.mjs` 的最后一段已经执行 10 MiB 输出检查，结果记录在 `bigOutput`。要求：

- `bigOutput.visibleLength` 不超过 32 KiB／1000 行；脚本返回的长度只反映它收到的有界尾部。
- `bigOutput.outputRef.jobId` 等于验收用的 `jobId`，`size` 为 10485760，`spillTruncated` 为 `false`。
- 窗口只限制模型可见部分，完整输出留在执行 VPS。用 `outputRef.blobId` 校验内容：

  ```sh
  sha256sum /home/aster/jobs/<jobId>/workspace/.ptc/outputs/<blobId>
  ```

  结果必须等于 `bigOutput.outputRef.sha256`。控制面不保存完整输出；journal 只保留有界结果和引用元数据。

### 6.3 应用级 codemode 检查

脚本级检查证明协议与沙箱；应用级检查证明 registry、`NestedCallDoc` 和 transcript 行为。在控制面宿主启动应用（不要在现有 app 容器内改网络），使用一个专用会话发送：

> 调用 codemode 工具，执行：连续 10 次 `await tools.bash({ command: "hostname" })`，把结果用逗号连接后返回。不要使用其他工具。

检查：

- 回复中的主机名是执行 VPS，不是控制面。
- conversation 中只有一个 codemode 的 `toolResult`；10 次嵌套 bash 不进入 transcript。
- 执行 VPS 的 `/home/aster/jobs/ptc-*` 出现该 job 的 workspace，文件在脚本结束后保留。
- 控制面数据的增长有界；不要因为大输出把完整 stdout 写进控制面数据库。

再发送一次 10 MiB 输出任务，要求脚本只返回长度与首尾片段。检查用于该 job 的 `NestedCallDoc` 只含尾部，`OutputRef` 元数据完整，控制面数据库增量远小于 10 MiB。

`jobId` 由 `sha256("remote-ptc-sandbox\0<conversationId>\0<taskId>")` 前 32 位生成；验收记录可以只记录 `ptc-` 前缀与目录数量，不必记录会话内容。

### 6.4 超时、取消与进程清理

在 Agent 主机上先记录基线：

```sh
pgrep -a -f 'aster-ptc-runner|bwrap' || true
ls /sys/fs/cgroup/system.slice/aster-rpc-agent.service/ptc
```

通过 PTC 脚本执行 `sleep 30`，`tool.call` 的 `timeoutMs` 设为 1000，或用 `AbortController` 在调用开始后取消 VM。预期：

- 工具调用以 `timeout` 或 `aborted` 失败，`outcome` 为 `unknown`；脚本不会返回成功。
- `session.close` 后，`pgrep` 不再出现该 session 的 runner、bwrap 或 `sleep 30`；`/sys/fs/cgroup/system.slice/aster-rpc-agent.service/ptc` 下没有残留 session 子目录。
- job workspace 保留，便于重放；清理只发生在 `PTC_JOB_RETENTION_HOURS` 之后，不由取消触发。
- 同一 `jobId` 再次打开时仍能复用 workspace，未完成的 bash 不会自动重跑。

### 6.5 workspace 缺失

只对专用验收 job 执行：

1. 用 `ptc-2222…` 打开并关闭一个 session，确认 workspace 创建。
2. 在执行 VPS 删除该目录：

   ```sh
   rm -rf /home/aster/jobs/ptc-22222222222222222222222222222222
   ```

3. 重新打开同一 `jobId` 且 `workspaceReady: true`。
4. 确认 `/home/aster/jobs/ptc-22222222222222222222222222222222` 没有被重建（`test -e` 必须为假）。

预期：返回 `workspace_missing`，`outcome` 为 `not_started`，既不创建 `<jobId>/workspace`，也不创建父目录 `<jobId>`；不会以空目录继续执行。验收记录必须写明这是有意删除的验收 job。

### 6.6 协议负向

- 未知帧字段、错误协议版本、超大帧、无法解析的 JSON：帧外壳无效，连接关闭，不执行。
- 合法帧但 payload 非法（未知项、`..` 越界、NUL／相对路径、错误 `cwd`／`tool`）：请求级错误，`invalid_request` 或 `permission_denied`，连接保持可用；随后同一连接上的 `health.check` 必须成功。不能把请求参数错误当成传输错误而断开整条连接。
- 错误 `sessionId`（含带 `jobId` 的非 16 hex PTC id）或错误 `callId`：请求失败，`outcome` 为 `not_started`，不产生嵌套执行。
- `tool.call` 的 `cwd` 不是 `/workspace`：`invalid_request`。
- 非 `bash` 的 `tool`：`invalid_request`。
- 同一脚本内超过 `CODEMODE_MAX_TOOL_CALLS`／`CODEMODE_MAX_JOURNAL_BYTES`：后续调用被拒绝并产生诊断，不静默截断。

这些在自动化测试中已有覆盖；实机至少复核一条错误 `callId`、一条错误 `cwd`，并确认两次负向之后连接仍能完成 `health.check`。

### 6.7 沙箱身份与 fd 诊断（BUG-6 待查）

静态复核中有一条**未证实**的观察：沙箱内 `hostname` 返回空，而 `uname -n` 正常。报告把它归因于 fd 1 被关闭，但代码里没有关闭 fd 1 的路径（`executeLocalBash`／DirectExecutor 用 `stdio: ["ignore","pipe","pipe"]`，入组 helper 只关闭 fd 3），报告自身的证据也矛盾。根因未定位，因此实现未改，只把身份判据改为 `uname -n` 并在空值时判失败。

实机复验时用同一脚本记录以下输出（全部经过 `tools.bash`，结果进入证据，不进入模型上下文）：

```js
const identity = await tools.bash({ command: "uname -n; cat /proc/sys/kernel/hostname; hostname; ls -l /proc/self/fd" });
return JSON.stringify({ identity: identity.output, exitCode: identity.exitCode });
```

判读：

- 三个身份值都非空且一致：BUG-6 未复现，按自动化基线通过处理。
- `uname -n` 非空而 `hostname` 为空：记录两者的 exitCode 与 `ls -l /proc/self/fd` 中 `1 ->` 的目标。若 fd 1 指向 `/dev/null` 或已关闭，才是报告所说的路径；否则根因在 `hostname` 自身或 bwrap 的 `/proc` 视图，继续收集 `strace -f -e trace=execve,write` 的对应片段。
- 任何身份值为空都不得作为通过证据；不得把“与另一个空值一致”当成一致。

## 7. Phase 2 验收（direct RPC bash 与文件原语）

以下检查使用 direct session（`openSession` 不带 `jobId`）。所有路径都是虚拟路径；主机路径不能出现在请求或响应中。

保存为 `/root/aster-accept/phase2.mjs`：

```js
import { randomBytes } from "node:crypto";
import { readRpcClientConfig } from "/opt/aster/dist/src/execution/rpc-config.js";
import { connectRpcClient } from "/opt/aster/dist/src/execution/rpc-connect.js";

const client = await connectRpcClient(readRpcClientConfig());
// direct session 不建 cgroup，没有 16 hex 限制；仍统一用 16 hex，便于同一脚本改开 PTC session。
const sessionId = randomBytes(8).toString("hex");
const otherId = randomBytes(8).toString("hex");
const report = {};

const fail = (message) => { throw new Error(message); };
async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    if (error?.code !== code) fail(`expected ${code}, got ${error?.code}: ${error?.message}`);
    return error?.options?.outcome ?? "failed";
  }
  fail(`expected ${code}, the call succeeded`);
}
function command(payload) {
  const chunks = [];
  const handle = client.startBashExecute(sessionId, {
    executor: "bash",
    command: payload.command,
    cwd: payload.cwd ?? "/shared/acceptance",
    env: {},
    inheritEnv: false,
    timeoutMs: payload.timeoutMs ?? 30_000,
    window: { maxBytes: 32 * 1024, maxLines: 1_000, minIntervalMs: 0, bytesPerSecond: 0 },
  }, {
    deadlineMs: (payload.timeoutMs ?? 30_000) + 60_000,
    onOutput: (event) => chunks.push(event.text),
  });
  return handle.result.then((result) => ({ exitCode: result.exitCode, output: chunks.join("") }));
}

try {
  const health = await client.health();
  report.health = {
    executionId: health.executionId,
    phase: health.phase,
    directBash: health.directBash,
    fileTools: health.fileTools,
    sharedMode: health.sharedMode,
  };
  if (health.phase !== 2 || health.directBash !== true || health.fileTools !== true) fail("direct Phase 2 is not advertised");
  if (health.sharedMode !== "rw") fail("sharedMode is not rw");

  const opened = await client.openSession(sessionId);
  report.session = opened;
  if (opened.direct?.sharedMode !== "rw" || opened.direct?.workspace !== "/shared") fail("the direct session shape is wrong");
  await client.openSession(otherId);

  const setup = await command({ command: "mkdir -p /shared/acceptance", cwd: "/shared" });
  if (setup.exitCode !== 0) fail(`mkdir failed: ${setup.output}`);

  // `hostname` 在沙箱内可能为空，身份判据用 uname -n；空值必须判失败。
  const identity = await command({ command: "printf '%s\\n%s\\n' \"$(uname -n)\" \"$(pwd)\"" });
  if (identity.exitCode !== 0) fail("identity command failed");
  report.identity = identity.output.trim().split("\n");
  if (report.identity.length !== 2 || report.identity.some((value) => value.length === 0)) {
    fail("the sandbox identity or cwd came back empty");
  }

  const net = await command({ command: "cat /proc/net/dev" });
  if (!/^\s*lo:/m.test(net.output)) fail("/proc/net/dev does not contain lo");
  if (/\b(eth|ens|enp|docker|veth)[0-9]/m.test(net.output)) fail("the direct sandbox has a non-loopback interface");

  await expectCode(client.fileRequest(sessionId, "file.readText", { path: "/etc/passwd" }), "permission_denied");
  await expectCode(client.fileRequest(sessionId, "file.readText", { path: "/shared/../etc/passwd" }), "permission_denied");
  await expectCode(client.fileRequest(sessionId, "file.readText", { path: "/shared/a\0.txt" }), "invalid_request");
  await expectCode(client.fileRequest(sessionId, "file.readText", { path: "passwd" }), "invalid_request");
  // payload 错误是请求级的：同一条连接必须还能服务请求，不能被负向用例打断。
  await client.health();

  const written = await client.fileRequest(sessionId, "file.write", {
    path: "/shared/acceptance/hello.txt",
    content: Buffer.from("hola").toString("base64"),
  });
  report.fileInfo = written.info;
  const text = await client.fileRequest(sessionId, "file.readText", { path: "/shared/acceptance/hello.txt" });
  if (Buffer.from(text.data, "base64").toString("utf8") !== "hola") fail("the file did not round-trip");

  const bytes = Buffer.alloc(300 * 1024, 7);
  await client.fileRequest(sessionId, "file.write", {
    path: "/shared/acceptance/blob.bin",
    content: bytes.toString("base64"),
  });
  const openedFile = await client.fileRequest(sessionId, "file.open", { path: "/shared/acceptance/blob.bin" });
  const chunks = [];
  let offset = 0;
  for (;;) {
    const chunk = await client.fileRequest(sessionId, "file.read", {
      handle: openedFile.handle, offset, length: 256 * 1024,
    });
    if (chunk.nextOffset !== offset + chunk.bytesRead) fail("file.read returned an inconsistent nextOffset");
    chunks.push(Buffer.from(chunk.data, "base64"));
    offset = chunk.nextOffset;
    if (chunk.eof) break;
  }
  if (chunks.length < 2) fail("the 300 KiB read was not split into chunks");
  if (!Buffer.concat(chunks).equals(bytes)) fail("the chunked read did not reconstruct the file");
  await client.fileRequest(sessionId, "file.close", { handle: openedFile.handle });

  await command({ command: "printf target > /shared/acceptance/target.txt && ln -sfn /etc/passwd /shared/acceptance/escape-link && ln -sfn /shared/acceptance/target.txt /shared/acceptance/inside-link && ln -sfn /tmp/cross-root.txt /shared/acceptance/cross-root-link" });
  await expectCode(client.fileRequest(sessionId, "file.readText", { path: "/shared/acceptance/escape-link" }), "permission_denied");
  await expectCode(client.fileRequest(sessionId, "file.readText", { path: "/shared/acceptance/cross-root-link" }), "permission_denied");
  await expectCode(client.fileRequest(sessionId, "file.open", { path: "/shared/acceptance/escape-link", noFollow: true }), "invalid_request");
  await expectCode(client.fileRequest(sessionId, "file.open", { path: "/shared/acceptance/inside-link", noFollow: true }), "invalid_request");
  // 根内绝对虚拟路径的链接按虚拟路径解析，返回虚拟路径而非宿主机路径。
  const canonical = await client.fileRequest(sessionId, "file.canonical", { path: "/shared/acceptance/inside-link" });
  if (canonical.path !== "/shared/acceptance/target.txt") fail("a link inside the root was not resolved");
  const inside = await client.fileRequest(sessionId, "file.readText", { path: "/shared/acceptance/inside-link" });
  if (Buffer.from(inside.data, "base64").toString("utf8") !== "target") fail("a link inside the root did not read its target");

  await client.fileRequest(sessionId, "file.write", {
    path: "/shared/acceptance/atomic.txt",
    content: Buffer.from("atomic").toString("base64"),
  });
  const leftovers = await command({ command: "find /shared/acceptance -maxdepth 1 -name '.aster-tmp-*' -print" });
  if (leftovers.output.trim() !== "") fail("an atomic write left a temporary file");

  const timed = client.startBashExecute(sessionId, {
    executor: "bash", command: "sleep 30", cwd: "/shared/acceptance",
    env: {}, inheritEnv: false, timeoutMs: 1_000,
    window: { maxBytes: 1_024, maxLines: 10, minIntervalMs: 0, bytesPerSecond: 0 },
  }, { deadlineMs: 60_000 });
  report.timeoutOutcome = await expectCode(timed.result, "timeout");

  await client.fileRequest(otherId, "file.write", {
    path: "/tmp/other-session.txt",
    content: Buffer.from("b").toString("base64"),
  });
  const isolated = await client.fileRequest(sessionId, "file.exists", { path: "/tmp/other-session.txt" });
  if (isolated.exists !== false) fail("one session can see another session's /tmp");

  console.log(JSON.stringify({ status: "ok", ...report }, null, 2));
} finally {
  await client.closeSession(sessionId).catch(() => undefined);
  await client.closeSession(otherId).catch(() => undefined);
  await client.close();
}
```

运行：

```sh
node /root/aster-accept/phase2.mjs
```

检查：

- `session.direct.sharedMode === "rw"`，`session.direct.workspace === "/shared"`。
- `identity[0]` 是执行 VPS 的 `uname -n`（非空），`identity[1]` 是 `/shared/acceptance`；说明命令确实在远端，且 cwd 已固定。`hostname` 为空不算通过。
- `/proc/net/dev` 只有 `lo`；direct sandbox 的网络也为空。
- 越界、`..`、NUL、相对路径全部被拒绝，错误码与表一致；`/shared` 下的符号链接逃逸为 `permission_denied`，跨根虚拟链接同样拒绝，`noFollow` 打开的链接本身为 `invalid_request`；根内绝对虚拟链接的 `file.canonical` 返回虚拟路径，`file.readText` 读到目标内容。
- 四条负向用例之后 `client.health()` 仍成功：payload 错误不关闭连接。若这里失败，先怀疑 BUG-1 类回归。
- 300 KiB 文件被拆成至少 2 次读取，`nextOffset` 连续，重组后字节一致。
- 写入后目录中没有 `.aster-tmp-*` 残留。
- `timeoutOutcome === "unknown"`；随后在 Agent 主机确认没有残留 `sleep 30`／bwrap／runner，cgroup 子目录已删除。
- 另一个 session 的 `/tmp` 文件不可见；关闭 session 后 `/run/aster/aster-direct-*` 目录被删除。

### 7.1 `/shared` 一致性

1. 在控制面通过 direct `bash` 写入 `/shared/acceptance/consistency.txt`。
2. 在控制面执行 `ssh aster-exec@EXECUTION_HOST 'cat /srv/shared/acceptance/consistency.txt'`（或用受控通道）。
3. 通过 `file.write` 更新同一文件，再读回。
4. 在 Agent 主机直接读取 `/srv/shared/acceptance/consistency.txt`，内容与最后一次写入一致。

预期：direct 沙箱的 `/shared` 与主机 `/srv/shared` 是同一目录；没有复制、缓存或按 session 分离的副本。如果使用 `PTC_SHARED_WORKSPACE_MODE=ro`，写入必须被拒绝，不能只读成功一次后静默写入。

### 7.2 旧 SSH 路径仍可用

在控制面用一个独立的环境（不要覆盖验收配置）设置：

```sh
EXECUTION_MODE=remote
EXECUTION_REMOTE_TRANSPORT=ssh
EXECUTION_BROKER_SOCKET=/run/aster/execution/broker.sock
EXECUTION_REMOTE_CWD=/home/aster/workspace
```

预期：

- 启动成功，直接 `bash` 走原 broker；`read`／`write`／`edit` 返回 `not_supported`。
- 不因为 rpc 配置存在就自动切换到 rpc，反之亦然。
- `EXECUTION_REMOTE_TRANSPORT=auto` 或拼写错误时启动失败。
- 在 rpc 模式下 `EXECUTION_REMOTE_CWD=/home/aster/workspace` 启动失败，提示必须在 `/shared` 下。

## 8. 必须保存的证据

```text
验收时间：
执行 VPS 地址／私网网段：
控制面地址／私网网段：
代码分支：feat/remote-ptc-sandbox-phase1
Git commit（执行面／控制面，必须相同）：
Node 版本：
npm 版本：
执行面 executionId：
证书 SHA-256 指纹（ca/server/client）：
配置摘要（路径、CN、端口、cgroup 根；不含私钥）：
uname -a / bwrap --version / max_user_namespaces / cgroup 类型与 controllers：
cgroup 委派与 AppArmor 处理记录：
rpc-agent --check 输出（含 ptc／direct）：
ss -ltnp sport = :9443 输出：
health／preflight 输出：
Phase 1 脚本输出（hostname、网络、10 次调用、workspace 复用）：
Phase 1 输出窗口与 OutputRef 校验（size、sha256、spillTruncated）：
Phase 1 超时／取消后的进程与 cgroup 状态：
Phase 2 脚本输出（路径边界、符号链接、分块、原子写、超时、tmp 隔离）：
`/shared` 一致性检查：
旧 ssh 路径回归：
控制面数据库增量（大输出前后）：
负向用例输出：
现有网络策略／安全组只读快照（不包含变更）：
Agent journal：
控制面日志：
结论：PASS / FAIL
失败项与修复：
```

证据中不得包含私钥、token、完整远端输出或真实用户消息。

## 9. 失败处理

- `--check` 出现 `degraded-prlimit`／`cgroup: "none"`／`network: "host"`：停止，不继续验收，不启用 `PTC_ALLOW_DEGRADED`。
- bwrap 或 user namespace 不可用：按 3.1 由主机安全负责人处理；不以关闭隔离或改用本地执行替代。
- cgroup 失败：先看 `--check` 的 `cgroupReason`。`EBUSY` 说明单元没有 `DelegateSubgroup=`；`EACCES` 说明 `PTC_CGROUP_ROOT` 不在单元委派的 cgroup 子树内（典型是旧的 `/sys/fs/cgroup/aster-ptc`）；`ENOENT` 说明控制器没有开启。按 3.2 修正，不要让 Agent 在 root 下运行。
- bwrap 启动即 exit 1 且 stderr 为 `Unknown option …`：安装的 bubblewrap 不支持某个参数。参数以实际版本为准（0.11.1 已移除 `--no-new-privs`），不要用包装脚本吞掉该错误。
- 越界读取、符号链接逃逸或 `/tmp` 跨 session 可见：视为严重失败，停止验收并修复实现。
- 超时／取消后仍有残余进程或 cgroup 子目录：视为失败；不得把“连接断开”当作“执行未发生”。
- 同一 `jobId` 重放执行了已完成的 bash，或 workspace 缺失时自动重建：视为失败。
- 任何情况下出现静默回退到 ssh、本地执行或其他传输：视为失败。
- 负向用例意外成功：立即停止 Agent，不放宽 mTLS、不修改防火墙、不把端口暴露到公网。

## 10. 回滚

迁移验收通过前，控制面可随时切回旧路径：

```sh
EXECUTION_REMOTE_TRANSPORT=ssh
EXECUTION_BROKER_SOCKET=/run/aster/execution/broker.sock
EXECUTION_REMOTE_CWD=/home/aster/workspace
```

`CODEMODE_ENABLED=1` 时，远程 codemode 仍需要 `EXECUTION_RPC_*` 与可达的 Agent；如果只想回滚直接 `bash`，不必关闭 codemode，但要保留 Phase 0／Phase 1 的 mTLS 通道。回滚不删除执行主机上的 job workspace 与 `/srv/shared`；这些是持久数据，按 `PTC_JOB_RETENTION_HOURS` 清理。

## 11. 不在本 Runbook

- RPC client 移入独立 gateway 容器的**生产验收**（实现、部署与回滚步骤见 5.4；本 Runbook 的 Phase 1／2 证据仍来自控制面宿主环境）。
- 多租户、跨用户共享执行主机、脚本递归、外网访问、GPU 或 Windows 执行主机。
- 用 RPC request id 去重替代 durable replay 或外部副作用幂等。
- 证书轮换与吊销流程的自动化；沿用 Phase 0 的手工签发与分发。
- 把控制面作为远程输出的存储；完整输出只留在执行主机，控制面只保存有界结果与引用。
