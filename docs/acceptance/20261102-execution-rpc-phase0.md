# Execution RPC Phase 0 验收记录（2026-11-02）

- 状态：**PASS**
- 分支：`feat/execution-rpc-phase0`
- Commit：`2fbbe087a83cb6c0eab4e309483043f31149fc95`
- PR：[#57](https://github.com/NaoYUN77/Aster/pull/57)
- 验收时间：2026-11-02 23:30–23:57 CST
- 执行面 Agent executionId：`3a0d7374b09e9b05`
- 部署与验收标准：[Phase 0 Runbook](../runbook-execution-rpc-phase0.md)

## 拓扑

两台真实 VPS，同一 VPC、不同子网，Ubuntu 26.04 LTS，Node 24.19.0：

```text
控制面（private CONTROL_HOST）
  私网 TCP 9443，mTLS
        │
        ▼
执行面（private EXECUTION_HOST）
```

执行面只监听 `EXECUTION_HOST:9443`；公网地址的 9443 不可达。

## 自动化基线

控制面 `/opt/aster`，Node 24.19.0：

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 0 |
| `npm run check` | 0 |
| `npm run build` | 0 |
| `npm test` | 301 tests，293 pass，0 fail，8 skipped |
| `test/execution-rpc.test.ts` | 9 tests，9 pass，0 fail，0 skipped |

8 个 skipped 是记忆库文件权限／属主类用例，不是 RPC 或 Unix socket 用例。RPC 测试在 POSIX 上包含 Unix socket、mTLS 正向、负向、流式、取消、断线和权限边界。

## 证书与 Agent

- CA、服务端证书、客户端证书由受控 CA 签发；`ca.key` 未分发到执行面。
- 服务端：CN／SAN `execution.internal`。
- 客户端：CN `aster-gateway`，命中 Agent 的 `EXECUTION_AGENT_CLIENT_CERT_CN`。
- 执行面 `/etc/aster/rpc` 为 `aster-exec:aster-exec 0700`，`server.key` 为 `0600`。
- Agent 配置：`EXECUTION_AGENT_BIND=EXECUTION_HOST`、`EXECUTION_AGENT_PORT=9443`、`EXECUTION_AGENT_REQUIRE_CLIENT_CERT=1`、`EXECUTION_AGENT_TEST_EXECUTOR=1`。
- `--check` 输出 `transport: tls`、私网 `bind`、`clientCertName: aster-gateway`、`testExecutorEnabled: true`，无私钥内容。
- `EXECUTION_AGENT_BIND=0.0.0.0` 的 `--check` 退出 1，提示 wildcard 地址被拒绝。
- systemd：`aster-rpc-agent.service` active / enabled。
- 监听证据：`LISTEN 0 511 EXECUTION_HOST:9443 0.0.0.0:* users:(("MainThread",pid=...))`。
- 启动日志：`Execution agent listening on tls EXECUTION_HOST:9443; executionId 3a0d7374b09e9b05`。

## 正向 e2e

```json
{
  "status": "ok",
  "executionId": "3a0d7374b09e9b05",
  "transport": "tls",
  "protocol": 1,
  "preflightOk": true,
  "streamChunks": 3,
  "streamBytes": 123,
  "cancelCode": "aborted",
  "cancelOutcome": "unknown"
}
```

`executionId` 与执行面 Agent 日志一致，且不是控制面的值。恢复默认 TTL 并重启 Agent 后，重新执行 e2e 仍为 `status: ok`。

## 负向结果

| 用例 | 结果 |
| --- | --- |
| 错误 CA | 失败，`SELF_SIGNED_CERT_IN_CHAIN` |
| 错误服务端名称／SAN | 失败，`ERR_TLS_CERT_ALTNAME_INVALID` |
| 客户端 CN 不在 allowlist | 失败，`unavailable: RPC connection closed` |
| 缺少客户端证书 | TLS 1.3 握手后收到 alert 116 `certificate required`，连接关闭，无 health JSON |
| 断线 | 无残留 `ESTABLISHED`；Agent 存活；TTL 后 e2e 成功 |
| 权限边界 | 9/9 通过；无 `bash`／`tool.call` 执行 |

## 断线验收方法

Runbook 原先的 `timeout 1s node dist/src/execution/rpc-e2e.js` 在当前实现下约 0.2 秒正常完成，无法稳定停在 `test.sleep` 阶段。本次验收改用等价方式：

1. 建立 session；
2. 启动 5 秒 `test.sleep`；
3. 300ms 后向客户端发送 `SIGKILL`（退出 137）；
4. 执行面 `ss -tn state established '( sport = :9443 )'` 无任何 `ESTABLISHED`；
5. Agent 仍 active，RSS 约 59 MB，无持续增长；
6. 等待超过临时 TTL（10 秒）后重跑 e2e，`status: ok`。

未观察到自动重跑、重复执行或“结果未知被当作未执行”。

## 网络只读核验

- 执行面、控制面的主机防火墙和 `ufw` 未被部署方修改；Docker／容器网络未被修改。
- 控制面到执行面 `EXECUTION_HOST:9443` 可连通；公网执行面地址的 9443 不可达。
- 用户在执行面实例的云安全组中单独加入入站规则：TCP 9443 ← 控制面私网 `/32`。这是验收环境准备，不是部署 agent 对主机或容器防火墙的修改。
- 未执行 Phase 1／2；未修改现有 SSH broker、Tool Registry、Journal、QuickJS。

## 结论

**PASS**。Phase 0 第 1、3、4、5、6 节在真实双 VPS 上完成，满足 Runbook 的正向、负向、断线和权限边界要求。Phase 1／2 仍未实现。
