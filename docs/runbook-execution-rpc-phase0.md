# Execution RPC Phase 0 部署与验收 Runbook

本文只覆盖 **Phase 0：统一 RPC 最小闭环**。Phase 0 不包含远程 PTC、QuickJS、真实 `bash`、`tool.call` 或远程文件工具。验收通过前不得进入 Phase 1。

> 2026-11-02 已在真实双 VPS 上按本 Runbook 验收通过（PASS，执行面 `executionId 3a0d7374b09e9b05`）；证据见 [验收记录](acceptance/20261102-execution-rpc-phase0.md)。后续复验仍按本文执行。

## 1. 通过判定

Phase 0 必须同时满足两组条件：

1. **本地／自动化验收**全部通过；Unix socket 用例在 POSIX 环境补跑。
2. **真实双 VPS 验收**全部通过，并保存第 7 节要求的证据。

任何一项失败都不能标记为通过。  
真实跨 VPS 验收不能只用 loopback、Docker 同机容器或本地自签证书替代。

### 1.1 本地／自动化基线

在两台主机部署前，先在控制面或 CI 执行：

```sh
npm run check
npm run build
npm test
npx tsx --test test/execution-rpc.test.ts
```

预期：

- `npm run check`、`npm run build`、`npm test` 退出码为 0。
- `test/execution-rpc.test.ts` 在 Linux／POSIX 上全部通过，包括 Unix socket 用例。
- Windows 只允许跳过 Unix socket 用例；TLS loopback 和其余用例必须通过。
- 如果 Unix socket 用例被跳过，不能把该结果当作 Unix socket 部署已验证；必须在 POSIX 环境补跑。

测试夹具 `test/fixtures/rpc-tls/` 只用于自动化测试，不是部署证书，不得复制到 `/etc/aster/rpc` 或用于真实跨 VPS 验收。

## 2. 拓扑与前提

```text
控制面 VPS（Gateway）
  私网地址：CONTROL_HOST
        │  私网 TCP 9443，mTLS
        ▼
执行 VPS（Execution Agent）
  私网地址：EXECUTION_HOST
```

占位值：

| 项 | 示例 |
| --- | --- |
| 控制面私网地址 | `CONTROL_HOST` |
| 执行 VPS 私网地址 | `EXECUTION_HOST` |
| Agent 监听端口 | `9443` |
| Gateway 校验的服务端名称 | `execution.internal` |
| Gateway 客户端证书 CN | `aster-gateway` |
| 代码目录 | `/opt/aster` |
| 证书目录 | `/etc/aster/rpc` |

前置条件：

- 两台主机有可互通的私网路由；执行 VPS 的 9443 端口不暴露公网。
- **本阶段不执行防火墙变更**，不修改主机、Docker/容器或云安全组现有规则；部署方只做只读核验。
- 私网是云 VPC 的 RFC1918 地址（`10/8`、`172.16/12`、`192.168/16`）、loopback 或链路本地地址。当前配置会拒绝公网 IP、`0.0.0.0`、`::`、主机名，以及 Tailscale 常用的 `100.64/10` CGNAT 地址；如果实际内网属于后者，先不要部署，需先确认并调整地址校验，不能把公网地址伪装成内网。
- 内网通信不是信任边界：同一 VPC 内的其他主机仍可能访问 9443，所以必须保留 mTLS 和客户端 CN allowlist，不能因为“是内网”而关闭证书校验。
- Node.js 为仓库 `.node-version` 指定的版本，本项目基线是 24.19.0。
- 控制面能访问私有 Git 仓库，或已同步 `feat/execution-rpc-phase0` 分支的代码。
- 执行 VPS 不通过 Docker 发布 9443；如果使用容器，必须使用 host 网络或显式私网绑定，不得映射到 `0.0.0.0`。
- 证书和私钥不进入仓库、不写入 `.env`、不输出到日志。

## 3. 证书准备

建议在一台受控主机生成，再通过安全通道分发。

### 3.1 CA、服务端证书、客户端证书

```sh
export RPC_DIR=/etc/aster/rpc
sudo install -d -m 0700 "$RPC_DIR"
sudo install -d -m 0700 "$RPC_DIR/generate"
cd "$RPC_DIR/generate"

# CA
openssl genrsa -out ca.key 3072
openssl req -x509 -new -key ca.key -sha256 -days 3650 \
  -subj "/CN=Aster RPC CA" -out ca.crt

# 服务端证书：SAN 必须是 Gateway 实际校验的名称
cat > server.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:execution.internal
EOF

openssl genrsa -out server.key 3072
openssl req -new -key server.key -subj "/CN=execution.internal" -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 825 -sha256 -extfile server.ext -out server.crt

# Gateway 客户端证书：CN 必须等于 Agent 的 EXECUTION_AGENT_CLIENT_CERT_CN
cat > client.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
EOF

openssl genrsa -out client.key 3072
openssl req -new -key client.key -subj "/CN=aster-gateway" -out client.csr
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAserial ca.srl \
  -days 825 -sha256 -extfile client.ext -out client.crt
```

如果 Gateway 通过 IP 而不是 `execution.internal` 连接，服务端证书 SAN 必须加入实际 IP；同时 `EXECUTION_RPC_SERVER_NAME` 必须填写该 IP 或匹配的 DNS 名称。推荐使用 DNS 名称，避免 IP 变更。

### 3.2 负向验收证书

错误客户端 CN：同一 CA 签发，但 CN 不在 allowlist：

```sh
openssl genrsa -out wrong-client.key 3072
openssl req -new -key wrong-client.key -subj "/CN=unknown-gateway" -out wrong-client.csr
openssl x509 -req -in wrong-client.csr -CA ca.crt -CAkey ca.key -CAserial ca.srl \
  -days 1 -sha256 -extfile client.ext -out wrong-client.crt
```

错误 CA：

```sh
openssl genrsa -out other-ca.key 3072
openssl req -x509 -new -key other-ca.key -sha256 -days 1 \
  -subj "/CN=Unrelated RPC CA" -out other-ca.crt
```

### 3.3 分发与权限

先在执行 VPS 创建运行用户：

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin aster-exec || true
```

只把各主机需要的文件放到 `/etc/aster/rpc`；CA 私钥 `ca.key` 留在签发主机或离线介质，不分发到执行 VPS 或控制面运行目录。

执行 VPS 需要：

- `ca.crt`
- `server.crt`
- `server.key`

控制面需要：

- `ca.crt`
- `client.crt`
- `client.key`
- 验收期间额外准备 `other-ca.crt`、`wrong-client.crt`、`wrong-client.key`

私钥权限：

```sh
chown -R aster-exec:aster-exec /etc/aster/rpc
chmod 0600 /etc/aster/rpc/*.key
chmod 0644 /etc/aster/rpc/*.crt
```

控制面按 Gateway 实际运行用户设置属主，不要照搬 `aster-exec`；私钥只需该用户可读。

## 4. 执行 VPS 部署

### 4.1 获取代码并构建

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin aster-exec || true
sudo install -d -o aster-exec -g aster-exec -m 0755 /opt/aster
sudo -u aster-exec git clone <仓库地址> /opt/aster
cd /opt/aster
sudo -u aster-exec git fetch origin feat/execution-rpc-phase0
sudo -u aster-exec git switch feat/execution-rpc-phase0
sudo -u aster-exec npm ci
sudo -u aster-exec npm run build
git rev-parse HEAD
```

把 `git rev-parse HEAD` 的 commit 记入验收证据。Phase 0 代码不在 `main` 上，不能从 `main` 构建后声称验收的是本分支。

### 4.2 Agent 配置

创建 `/etc/aster/rpc-agent.env`：

```sh
EXECUTION_AGENT_BIND=EXECUTION_HOST
EXECUTION_AGENT_PORT=9443
EXECUTION_AGENT_TLS_CERT_PATH=/etc/aster/rpc/server.crt
EXECUTION_AGENT_TLS_KEY_PATH=/etc/aster/rpc/server.key
EXECUTION_AGENT_TLS_CA_PATH=/etc/aster/rpc/ca.crt
EXECUTION_AGENT_CLIENT_CERT_CN=aster-gateway
EXECUTION_AGENT_REQUIRE_CLIENT_CERT=1
EXECUTION_AGENT_TEST_EXECUTOR=1
EXECUTION_AGENT_SESSION_TTL_MS=270000
EXECUTION_AGENT_HEARTBEAT_MS=15000
```

权限：

```sh
chown root:aster-exec /etc/aster/rpc-agent.env
chmod 0640 /etc/aster/rpc-agent.env
```

注意：

- `EXECUTION_AGENT_BIND` 必须是本机私网或 loopback IP 字面量。`0.0.0.0`、`::`、公网地址和主机名都会被拒绝。
- `EXECUTION_AGENT_CLIENT_CERT_CN` 必须与控制面客户端证书 CN 完全一致。
- `EXECUTION_AGENT_REQUIRE_CLIENT_CERT` 只能是 `1` 或 `true`；设为关闭会直接配置失败。
- Phase 0 验收期间必须保持 `EXECUTION_AGENT_TEST_EXECUTOR=1`，否则 `rpc-e2e` 无法执行。

### 4.3 先做配置检查

```sh
cd /opt/aster
sudo -u aster-exec sh -c '
  set -a
  . /etc/aster/rpc-agent.env
  set +a
  npm run execution:rpc-agent -- --check
'
```

预期：输出 JSON，包含 `transport: "tls"`、私网 `bind`、`clientCertName`、`testExecutorEnabled: true`。输出不得包含私钥内容。

再验证错误绑定会被拒绝：

```sh
sudo -u aster-exec sh -c '
  set -a
  . /etc/aster/rpc-agent.env
  set +a
  EXECUTION_AGENT_BIND=0.0.0.0 npm run execution:rpc-agent -- --check
'
```

预期：非零退出，提示 wildcard 地址被拒绝。

### 4.4 systemd 启动

创建 `/etc/systemd/system/aster-rpc-agent.service`：

```ini
[Unit]
Description=Aster Execution RPC Agent (Phase 0)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aster-exec
Group=aster-exec
WorkingDirectory=/opt/aster
EnvironmentFile=/etc/aster/rpc-agent.env
ExecStart=/usr/bin/node /opt/aster/dist/src/execution/rpc-main.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/aster/rpc

[Install]
WantedBy=multi-user.target
```

按实际 Node 路径调整 `ExecStart`。

```sh
systemctl daemon-reload
systemctl enable --now aster-rpc-agent
systemctl status aster-rpc-agent --no-pager
journalctl -u aster-rpc-agent -n 50 --no-pager
```

预期日志包含实际监听地址和 `executionId`，不包含证书私钥。

### 4.5 网络与监听检查

```sh
ss -ltnp sport = :9443
```

必须满足：

- 监听地址是 `EXECUTION_HOST:9443` 或明确的私网地址。
- 不出现 `0.0.0.0:9443`、`[::]:9443` 或公网地址。
- `users:(("node",...))` 指向 Agent 进程。
- Docker 没有 `0.0.0.0:9443->9443/tcp` 之类的端口发布：

  ```sh
  docker ps --format '{{.Names}}\t{{.Ports}}' | grep 9443 || true
  ```

  预期：没有发布到 `0.0.0.0` 或公网地址的 9443 映射。

网络策略只读核验：

- 本次部署不执行任何防火墙变更，保留现有主机、Docker/容器和云安全组规则。
- 只检查控制面能否通过私网访问 9443。
- 如果现有策略不满足私网访问，或允许非预期来源，记录现状并停止，由网络负责人处理；不得自行变更规则。
- 验收不把“新增/修改防火墙规则”作为前提，也不把“未改防火墙”当作已完成网络隔离。

## 5. 控制面 Gateway 部署与正向验收

### 5.1 构建

```sh
cd /opt/aster
git fetch origin feat/execution-rpc-phase0
git switch feat/execution-rpc-phase0
npm ci
npm run build
git rev-parse HEAD
```

### 5.2 配置

```sh
export EXECUTION_RPC_TRANSPORT=tls
export EXECUTION_RPC_ADDRESS=EXECUTION_HOST:9443
export EXECUTION_RPC_SERVER_NAME=execution.internal
export EXECUTION_RPC_CA_PATH=/etc/aster/rpc/ca.crt
export EXECUTION_RPC_CERT_PATH=/etc/aster/rpc/client.crt
export EXECUTION_RPC_KEY_PATH=/etc/aster/rpc/client.key
export EXECUTION_RPC_CONNECT_TIMEOUT_MS=5000
export EXECUTION_RPC_REQUEST_TIMEOUT_MS=30000
```

`EXECUTION_RPC_SERVER_NAME` 必须匹配服务端证书 SAN；地址本身可以是私网 IP。

### 5.3 运行端到端验收

```sh
cd /opt/aster
npm run execution:rpc-e2e
```

预期 JSON：

```json
{
  "status": "ok",
  "executionId": "执行 VPS 的 executionId",
  "transport": "tls",
  "protocol": 1,
  "preflightOk": true,
  "streamChunks": 3,
  "streamBytes": 123,
  "cancelCode": "aborted",
  "cancelOutcome": "unknown"
}
```

至少检查：

- `status` 为 `ok`。
- `executionId` 与执行 VPS 日志中的 `executionId` 一致，且不是控制面的值。
- `transport` 为 `tls`。
- `protocol` 为 `1`。
- `streamChunks` 为 `3`，`streamBytes` 大于 0。
- `cancelCode` 为 `aborted`。
- `cancelOutcome` 为 `unknown`。

## 6. 负向与断线验收

以下命令都应在控制面执行，且都应失败；失败时不能出现 `status: "ok"` 或 health 结果。

### 6.1 错误 CA

```sh
EXECUTION_RPC_CA_PATH=/etc/aster/rpc/other-ca.crt \
  npm run execution:rpc-e2e
```

预期：非零退出，TLS 证书校验失败。

### 6.2 错误服务端名称／SAN

```sh
EXECUTION_RPC_SERVER_NAME=wrong.internal \
  npm run execution:rpc-e2e
```

预期：非零退出，证书 hostname／SAN 校验失败。

### 6.3 客户端 CN 不在 allowlist

```sh
EXECUTION_RPC_CERT_PATH=/etc/aster/rpc/wrong-client.crt \
EXECUTION_RPC_KEY_PATH=/etc/aster/rpc/wrong-client.key \
  npm run execution:rpc-e2e
```

预期：非零退出；TLS 链可能成功，但 Agent 在 RPC 帧处理前断开连接。

### 6.4 缺少客户端证书

```sh
openssl s_client \
  -connect EXECUTION_HOST:9443 \
  -servername execution.internal \
  -CAfile /etc/aster/rpc/ca.crt \
  -verify_return_error \
  -brief </dev/null
```

预期：握手失败或服务端返回 certificate required／alert；不能进入应用层，不能出现 health JSON。  
`openssl` 在 TLS 1.3 下可能完成握手后才收到 alert，验收以“没有可用 RPC 连接、e2e 无法完成”作为判定，不以进程退出码单独判定。

### 6.5 断线处理

注意：当前 `rpc-e2e` 约 0.2 秒正常完成，`timeout 1s node dist/src/execution/rpc-e2e.js` 不能稳定停在 `test.sleep` 阶段，不能用它作为断线验收的唯一证据。应使用独立的测试客户端：

1. 建立 session；
2. 启动 `test.sleep`（5 秒）；
3. 收到执行已开始后约 300ms，向客户端进程发送 `SIGKILL`；
4. 立即检查 Agent：

   ```sh
   ss -tn state established '( sport = :9443 )'
   ```

   预期：没有来自控制面的 `ESTABLISHED` 连接。

5. 等待至少 `EXECUTION_AGENT_SESSION_TTL_MS` 后重新执行：

   ```sh
   npm run execution:rpc-e2e
   ```

   预期：仍能正常完成，Agent 进程没有崩溃或持续增长。

   为缩短验收，可在执行 VPS 的验收配置中临时设置 `EXECUTION_AGENT_SESSION_TTL_MS=10000` 并重启 Agent；验收后恢复默认 `270000`。该值只影响空闲 session 清理，不改变断线时的立即清理。

6. Phase 0 的自动化测试已覆盖“客户端关闭后 pending 执行失败且不自动重跑”。当前 Agent 没有暴露公开的 session gauge，跨 VPS 验收以 TCP 连接消失、无残留执行进程、重新 e2e 成功和自动化测试结果为证据；不得把“连接断开”当作“执行未发生”。

2026-11-02 的真实双 VPS 验收采用上述 SIGKILL 方式，记录见 [Phase 0 验收记录](acceptance/20261102-execution-rpc-phase0.md)。

### 6.6 权限边界

必须确认 Phase 0 不存在任意命令路径：

```sh
cd /opt/aster
npx tsx --test test/execution-rpc.test.ts
```

该测试包含 `executor: "bash"`、任意 `command`、`tool.call`、重复 request id、超大帧和错误版本的拒绝用例；全部必须通过。跨 VPS 不必实际执行 `bash`；如果任何 `bash` 请求成功执行，验收直接失败。


## 7. 必须保存的证据

验收记录至少包含：

```text
验收时间：
执行 VPS 地址／私网网段：
控制面地址／私网网段：
代码分支：feat/execution-rpc-phase0
Git commit：<git rev-parse HEAD>
Node 版本：
npm 版本：
Agent executionId：
证书 SHA-256 指纹（ca/server/client）：
配置摘要（路径、CN、端口；不含私钥）：
npm run check 结果：
npm run build 结果：
npm test 结果：
test/execution-rpc.test.ts 结果：
rpc-agent --check 输出：
ss -ltnp sport = :9443 输出：
rpc-e2e 正向输出：
错误 CA 输出：
错误 SAN 输出：
错误客户端 CN 输出：
缺少客户端证书输出：
断线检查输出：
现有网络策略／安全组只读快照（不包含变更）：
Agent journal：
Gateway 输出：
结论：PASS / FAIL
失败项与修复：
```

证书指纹：

```sh
openssl x509 -in /etc/aster/rpc/ca.crt -noout -fingerprint -sha256
openssl x509 -in /etc/aster/rpc/server.crt -noout -fingerprint -sha256
openssl x509 -in /etc/aster/rpc/client.crt -noout -fingerprint -sha256
```

## 8. 失败处理

- 任何负向用例意外成功：立即停止 Agent 服务和验收；不自行修改防火墙或放宽 mTLS，由网络负责人处理，不把 Agent 暴露到公网。
- Agent 绑定到 wildcard 或公网地址：视为失败，不继续测试。
- 证书 CN／SAN 不匹配：重新签发证书，不改代码绕过校验。
- 断线后出现自动重跑、重复执行或结果被当作未执行：视为失败。
- 任何 `bash`／`tool.call` 被执行：视为严重失败，停止部署。
- 不允许为了验收通过而关闭客户端证书、关闭 CN allowlist、改用 Unix socket 或回退到其他执行通道。

## 9. 明确不在本阶段

- 远程 QuickJS VM、`vm.start`／`vm.message`／`vm.reply`。
- 真实 `tool.call` 和 `bash`。
- bwrap、user namespace、cgroup、workspace、`OutputRef`。
- 远程 `read`／`write`／`edit`。
- 接入 app／broker／普通工具。
- 多租户、网络访问、GPU、Windows 执行主机。

这些属于 Phase 1／Phase 2，必须在 Phase 0 验收通过后单独实施和验收。
