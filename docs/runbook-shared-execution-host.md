# Phase 1 共享 CVM Execution Host：部署与验收 Runbook

> **本文件是待人工审查的步骤清单，不会自动执行。** 仓库中的代码、compose 与测试不修改 CVM
> 生产服务、系统权限或防火墙；下列命令须由运维在确认后自行在对应主机上执行。本文只覆盖
> Phase 1 的 Bash / Read / Write / Edit，其它工具族留待后续阶段迁移。

## 1. 适用范围与架构决策

Aster Dashboard 当前明确是**单用户 MVP**：不考虑多租户，不要求每个 Bot 拥有独立的 OS 执行环境。
停止实施的方案：「每 Bot Docker 容器」「Bot Container Provisioning」「每 Bot 独立 UID」
「多租户资源隔离」。

| 位置 | 职责 |
| --- | --- |
| Lighthouse（10.1.4.9） | Agent Runtime、Session、Memory、Task、Tool Registry、Dashboard Console 适配；应用容器 |
| CVM（172.16.0.7） | 一台共享 Computer / Execution Host，运行 `rpc-main.js` 的 `EXECUTION_AGENT_SHARED_HOST=1` 模式 |
| 两者之间 | 既有 RPC Gateway + 私网 mTLS（`docker-compose.rpc.yml`），**不重新开发传输协议** |

所有 Bot 经同一条 mTLS RPC 共用 CVM 上的软件环境（Bash、Git、Python、Node.js、Claude Code、
Herdr 等 CLI）。CC、Herdr **不抽象为独立 Agent Tool**，统一通过 Bash 使用。每个 Bot 保有独立
对话、记忆与任务状态及各自默认工作目录 `/workspaces/<botId>`，但底层文件与软件共享，**没有
OS 级隔离**。原始 bash 能看到兄弟工作区目录是被接受的取舍，不是待修复缺陷。

保留的边界：执行超时、并发控制、进程组终止、输出限制、审计，以及 **RPC 断线不自动重放**。
Execution Service 以专用非 root Linux 用户运行，不允许 root、sudo、Docker Socket 或 Lighthouse
凭据访问。Phase 1 不启动 bwrap、cgroup 或 PTC，`health.check` 报告 `ptc: false`。

## 2. 前置条件（沿用 Phase 0，不新增网络变更）

- Node.js 24.19.0（与 `.node-version` 一致）、`npm ci` 可完成；仓库代码部署到 CVM 的只读目录
  （下文示例 `/opt/aster`）。
- 沿用 [Phase 0 RPC Runbook](runbook-execution-rpc-phase0.md) 已签发的 mTLS 材料与私网路由：
  - 服务端 `server.crt` / `server.key`，CA `ca.crt`，客户端证书 CN `aster-gateway`；
  - `EXECUTION_AGENT_BIND` 为 CVM 私网 IP 字面量（示例 `172.16.0.7`），端口 `9443`；
  - 证书目录 `/etc/aster/rpc` 权限与 Phase 0 一致，只对执行用户可读。
- **本 runbook 不修改防火墙、安全组或 systemd 全局配置**。9443 的私网可达性是 Phase 0 既有
  前提；若不通，由运维按既有变更流程处理，不在本次代码交付范围内。
- 控制面（Lighthouse）的 `docker-compose.rpc.yml` 无需改动传输层；其默认
  `EXECUTION_REMOTE_CWD=/workspaces` 即为 Phase 1 配置；PTC／codemode 已退役。

## 3. 专用非 root 用户与目录（人工执行，需审查）

示例用户 `aster-exec`（如 Phase 0 已存在则复用，不要新建第二个身份）：

```sh
# 以 root 执行；先确认该用户不存在 sudo / docker 组权限
id aster-exec
getent group sudo docker | grep -E '(^|:)aster-exec(:|$)' || true   # 预期：无输出

install -d -o aster-exec -g aster-exec -m 0750 /workspaces
install -d -o root:aster-exec -m 0750 /etc/aster/rpc
install -d -o aster-exec -g aster-exec -m 0700 /opt/aster
```

核对清单：

- `aster-exec` 不在 `sudo`、`docker`、`wheel` 等提权组；没有 `/var/run/docker.sock` 的访问权限。
- `/etc/aster/rpc` 下没有 Lighthouse 的客户端私钥或任何控制面凭据；只有服务端证书与 CA。
- `/workspaces` 必须是**已存在的真实目录**且属于 `aster-exec`：`rpc-main.js` 启动时会 `stat`
  校验，缺失或不属主会直接拒绝监听（`fail-closed`）。
- 代码与持久化数据分离：`/opt/aster` 放代码，`/workspaces` 放 Bot 文件；部署更新只替换代码，
  不清理 `/workspaces`。

## 4. 部署代码（不触碰系统服务）

```sh
cd /opt/aster
# 以 aster-exec 构建，避免 root 产物混入执行目录
sudo -u aster-exec npm ci
sudo -u aster-exec npm run build
sudo -u aster-exec npm run check
git rev-parse HEAD     # 记入验收证据；不要从别的分支构建后声称验收本分支
```

## 5. 执行面环境文件

创建 `/etc/aster/shared-host.env`（**不要设置** `EXECUTION_AGENT_UNIX_SOCKET`，否则会退回
Unix 传输；生产沿用 TLS + mTLS）：

```sh
EXECUTION_AGENT_SHARED_HOST=1
EXECUTION_AGENT_WORKSPACES=/workspaces
EXECUTION_AGENT_TMP_ROOT=/tmp/aster-sessions
EXECUTION_AGENT_SHELL=/bin/bash
EXECUTION_AGENT_PATH=/usr/local/bin:/usr/bin:/bin
EXECUTION_AGENT_OUTPUT_CHUNK_BYTES=32768
EXECUTION_AGENT_OUTPUT_BYTES_PER_SECOND=4194304
EXECUTION_AGENT_MAX_CONCURRENT=3
EXECUTION_AGENT_MAX_SESSIONS=32
EXECUTION_AGENT_SESSION_TTL_MS=270000
EXECUTION_AGENT_HEARTBEAT_MS=15000
EXECUTION_AGENT_TEST_EXECUTOR=0
PTC_ENABLED=0

# 沿用 Phase 0 的 mTLS 配置，值按实际主机调整
EXECUTION_AGENT_BIND=172.16.0.7
EXECUTION_AGENT_PORT=9443
EXECUTION_AGENT_TLS_CERT_PATH=/etc/aster/rpc/server.crt
EXECUTION_AGENT_TLS_KEY_PATH=/etc/aster/rpc/server.key
EXECUTION_AGENT_TLS_CA_PATH=/etc/aster/rpc/ca.crt
EXECUTION_AGENT_CLIENT_CERT_CN=aster-gateway
EXECUTION_AGENT_REQUIRE_CLIENT_CERT=1
```

```sh
chown root:aster-exec /etc/aster/shared-host.env
chmod 0640 /etc/aster/shared-host.env
```

要点：

- `EXECUTION_AGENT_SHARED_HOST=1` 是必需配置；缺失时 `rpc-main.js` 直接拒绝启动：
  `EXECUTION_AGENT_SHARED_HOST=1 is required; the retired PTC / bwrap execution agent is no longer supported`。
- `PTC_ENABLED` 只能是 `0` 或空；其它值在 shared-host 模式下直接配置失败。
- `EXECUTION_AGENT_WORKSPACES` 必须与控制面 `EXECUTION_REMOTE_CWD` 同为 `/workspaces`。
  控制面把 `/workspaces/<botId>` 作为虚拟 cwd 下发，执行面的 `sessionWorkspacePath()` 只接受
  该前缀；沿用旧值 `/shared/aster` 会在 `session.open` 时被拒绝（不是静默回退）。
- 监听前执行 `assertNotRoot()`、`stat(workspacesRoot)` 与 `direct.preflight()`；
  `PTC_ENABLED` 必须未设置、为空或为 `0`。PTC／codemode 已退役，不再启动 `PtcGateway`。

## 6. 配置检查（先于监听）

```sh
cd /opt/aster
sudo -u aster-exec sh -c '
  set -a
  . /etc/aster/shared-host.env
  set +a
  npm run execution:rpc-agent -- --check
'
```

预期 JSON：`transport: "tls"`、私网 `bind`、端口 `9443`、`clientCertName: "aster-gateway"`、
`testExecutorEnabled: false`、`sharedHost.mode: "shared-host"`、
`sharedHost.workspacesRoot: "/workspaces"`、`direct.sharedHost: true`。输出不含私钥内容。

负向检查（均预期非零退出）：

```sh
# root 必须被拒绝
sudo sh -c 'set -a; . /etc/aster/shared-host.env; set +a; npm run execution:rpc-agent -- --check'
# 预期：shared host mode must not run as root

# 已退役的 PTC 不能重新启用；遗留配置必须被拒绝
sudo -u aster-exec sh -c '
  set -a; . /etc/aster/shared-host.env; set +a
  PTC_ENABLED=1 npm run execution:rpc-agent -- --check
'
# 预期：shared host mode is Phase 1 (Bash / Read / Write / Edit only); set PTC_ENABLED=0
```

## 7. systemd unit（模板，人工审查后启用）

创建 `/etc/systemd/system/aster-shared-host.service`：

```ini
[Unit]
Description=Aster Shared CVM Execution Host (Phase 1)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aster-exec
Group=aster-exec
WorkingDirectory=/opt/aster
EnvironmentFile=/etc/aster/shared-host.env
ExecStart=/usr/bin/node /opt/aster/dist/src/execution/rpc-main.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/aster/rpc
ReadWritePaths=/workspaces
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
```

按实际 Node 路径调整 `ExecStart`。`PrivateTmp=true` 让 `/tmp/aster-sessions` 落在服务私有的
`/tmp`；`ProtectSystem=strict` 下只有 `/workspaces` 可写，代码与证书只读。

```sh
systemctl daemon-reload
systemctl enable --now aster-shared-host
systemctl status aster-shared-host --no-pager
journalctl -u aster-shared-host -n 50 --no-pager
```

预期日志包含 `transport tls`、私网监听地址与 `executionId`，不含私钥或凭据。

## 8. 控制面验收（从 Lighthouse 应用容器内执行）

确认 `docker-compose.rpc.yml` 已带 `EXECUTION_REMOTE_CWD=/workspaces` 启动
`personal-agent` + `rpc-gateway`；控制面不再配置 PTC／codemode。随后执行：

```sh
docker compose -f docker-compose.yml -f docker-compose.mitm.yml -f docker-compose.rpc.yml \
  exec -T personal-agent node --input-type=module <<'JS'
import { readRpcClientConfig } from "./dist/src/execution/rpc-config.js";
import { connectRpcClient } from "./dist/src/execution/rpc-connect.js";
const client = await connectRpcClient(readRpcClientConfig());
const health = await client.health();
console.log(JSON.stringify({
  protocol: health.protocol, directBash: health.directBash, fileTools: health.fileTools,
  sharedMode: health.sharedMode, ptc: health.ptc, testExecutor: health.testExecutor,
}));
if (health.protocol !== 1 || health.directBash !== true || health.fileTools !== true
    || health.sharedMode !== "rw" || health.ptc !== false || health.testExecutor !== false) {
  throw new Error("shared host health.check is not Phase 1");
}
const session = `runbook-${Date.now().toString(36)}`;
const cwd = `/workspaces/${session}`;
await client.openSession(session, { cwd });
const window = { maxBytes: 65536, maxLines: 1000, minIntervalMs: 0, bytesPerSecond: 0 };
const chunks = [];
const run = client.startBashExecute(session, {
  executor: "bash", command: "pwd && printf 'shared-host-ok' > probe.txt",
  cwd, env: {}, inheritEnv: false, timeoutMs: 10000, window,
}, { onOutput: (event) => chunks.push(event.text) });
const result = await run.result;
const read = await client.fileRequest(session, "file.readText", { path: `${cwd}/probe.txt` });
const content = Buffer.from(String(read.data), "base64").toString("utf8");
console.log(JSON.stringify({ exitCode: result.exitCode, output: chunks.join(""), content }));
if (result.exitCode !== 0 || !chunks.join("").includes(cwd) || content !== "shared-host-ok") {
  process.exitCode = 1;
}
await client.closeSession(session);
await client.close();
JS
```

预期：`exitCode: 0`，`output` 含 `/workspaces/runbook-...`，`content: "shared-host-ok"`。
这一条同时证明 Bash、Write（经 bash）、Read（经 `file.readText`）走通既有 mTLS RPC。

**Edit 没有独立的 wire 方法。** `src/execution/rpc-protocol.ts` 的 `FILE_METHODS` 只含
`stat` / `exists` / `canonical` / `open` / `read` / `scanLines` / `close` / `readText` /
`write`（均以 `file.` 为前缀），不存在 `file.edit`。pi-durable 的 `createEditTool()` 在
`RemoteRpcExecutionEnv` 上依次执行 `readTextFile` → 精确文本替换 → `writeFile`，由
`src/execution/remote-files.ts:145-167` 分别落到 `file.readText` 与 `file.write`（原子写）。
补测 Edit 应调用已安装的 `edit` 工具，或在同一会话按「读—改—写」顺序复现该往返
（`file.readText` 的 `data`、`file.write` 的 `content` 均为 base64）；不得发起 `file.edit`。
该补测只覆盖工具执行，不覆盖模型循环。

补充负向验收（沿用 Phase 0 的检查，不重复造协议）：

- 错误客户端 CN / 非授信 CA 仍被拒绝（Phase 0 runbook 6.2／6.3）。
- `EXECUTION_REMOTE_CWD=/shared/aster` 时 `session.open` 被 `sessionWorkspacePath()` 拒绝。
- `file.readText` 读 `/data/inbox.sqlite` 或 `../<其它 bot>/...` 返回 `permission_denied`。
- `file.edit` 或任何不在 `FILE_METHODS` 内的 file 方法返回 `invalid_request`
  （`unknown file method`，`not_started`，见 `src/execution/rpc-server.ts:573`），不产生写副作用。
- `bash` 请求的 `env` 试图设置 `PATH` / `LANG` / `HOME` / `TMPDIR` / `PTC_INSIDE_SANDBOX`
  时返回 `invalid_request` 且不执行命令；宿主的运行时环境不随 wire 参数覆盖，普通任务变量
  仍可透传（`test/shared-host.test.ts` 覆盖）。`inheritEnv` 被有意忽略，执行服务的进程环境
  （含 TLS 路径与宿主配置）不会进入命令。
- 超过 `EXECUTION_AGENT_MAX_CONCURRENT` 的请求被排队／拒绝，超时命令的进程组被终止且结果
  为失败而非成功；这些语义由 `test/shared-host.test.ts` 在真实 Unix socket 回环中覆盖。
- 断开 RPC 连接后**不自动重放**：新连接开新会话，结果未知的命令不会重跑。

## 9. 回滚

1. 在 Lighthouse 停止应用侧的 RPC 组合（`docker compose ... down`，不要 `-v`，保留 `/data`）。
2. 在 CVM 执行 `systemctl stop aster-shared-host` 并 `systemctl disable aster-shared-host`；
   保留 `/etc/aster/shared-host.env`、`/workspaces` 与 systemd unit 文件供复查。
3. [Remote PTC Phase 1／2 Runbook](../archive/ptc-codemode/docs/runbook-remote-ptc-phase1-2.md)
   仅保留为历史记录，不是回滚目标；当前版本不支持恢复已退役的 PTC agent。
4. `/workspaces` 内的 Bot 文件不随回滚删除；会话是连接作用域的，断线不重放，回滚不会自动
   重跑任何命令。

## 10. 记录边界

- 本 runbook 的 CVM 部署验收**尚未执行**；仓库不把未执行的部署验证记为通过。
- 单机 `dashboard/docker-compose.dashboard.yml` 的 `execution-host` 只是同机替代（Unix socket、
  uid 1000、`EXECUTION_AGENT_SHARED_HOST=1`），**不是**生产拓扑；生产仍走
  `docker-compose.rpc.yml` 的 mTLS Gateway。
- 决策历史见 [ADR-0023](adr/zero-setup-bot-runtime/0023-zero-setup-bot-runtime.md)
  「2026-11-06：共享 CVM Execution Host」一节。
