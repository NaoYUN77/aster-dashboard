# OpenBao + MITM 出站密钥占位

Aster 应用的模型、Web 工具与 Langfuse 请求经 MITM 代理出站；代理把请求头和 URL 路径里的 `__vault_<NAME>__` 占位符换成 OpenBao 中 `secret/aster/<NAME>` 的值。应用进程与模型只看到占位符，明文密钥不写入 `.env`、镜像、仓库、日志或聊天。

代理与 OpenBao 都不共享通用网络：应用只能经专用内网访问代理，OpenBao 只对代理可达，两个端口都不发布到宿主机。代理端口还要求客户端出示代理 token；OpenBao 的 `8200` 监听要求 TLS 客户端证书（mTLS），因此未认证的 `/v1/sys/health` 无法经代理或同网直连读取。详见下文“网络可达性”。

## 行为速览

MITM 只把客户端**显式发出**的 `__vault_<NAME>__` 换成 OpenBao 中的值，不做其它凭据注入。

- **触发条件**：请求头或 URL 路径（`?` 之前）出现占位符，且目标 Host 与该 `<NAME>` 在 [`addon/allowlist.json`](addon/allowlist.json) 中的条目精确匹配（不做后缀或通配匹配）。请求头中的 `Authorization: Basic` 会先解码，再匹配其中的占位符并重新编码；普通 Basic 凭据原样转发。
- **不自动塞 `Authorization`**：代理不按目标主机推断凭据；客户端没发占位符，请求原样转发。
- **body 不替换**：请求体一律不动，避免 `web_fetch` 把模型提供的 URL 当作外带通道。
- **无映射即 403**：占位符名不在 allowlist、Host 不匹配或 OpenBao 读取失败，整条请求返回 `403`，不做部分替换；日志只记占位符名与主机。

替换策略见 [`addon/vault_placeholders.py`](addon/vault_placeholders.py)，支持的主机映射以 `allowlist.json` 为唯一来源。

> **历史背景**：[ADR-0005](../../docs/adr/0005-remove-agent-vault-single-service.md) 删除的是依赖 Infisical 云的旧 Agent Vault 子系统；本方案使用同机自建的 `aster-openbao` + `aster-mitm` 内网服务完成出站占位替换。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `compose.yml` | `aster-openbao` 与 `aster-mitm` 两个服务，项目名 `aster`；三个专用网络（`aster_vault`、`aster_mitm_clients`、`aster_egress`），不发布端口 |
| `openbao/config.hcl` | 单节点 OpenBao 配置：`0.0.0.0:8200` 为 TLS + mTLS 内网监听，`127.0.0.1:8201` 为容器内明文 loopback（健康检查与 CLI） |
| `addon/aster_vault_addon.py` | mitmproxy 插件：按主机白名单将请求头（含解码后的 Basic 凭据）和 URL 路径中的 `__vault_<NAME>__` 替换为 OpenBao KV 值，越权或未知占位符返回 403；源地址不在白名单返回 403；代理 token 无效返回 407；经 TLS 客户端证书读 OpenBao |
| `addon/vault_placeholders.py` | 占位符替换纯函数策略（无 mitmproxy 依赖，可独立单测） |
| `addon/allowlist.json` | 占位符名 → 允许的目标主机列表（精确匹配） |
| `addon/client_allowlist.py` | 代理客户端源地址白名单（默认只允许 Aster 应用容器 `10.89.143.3/32`） |
| `addon/proxy_token.py` | 代理 token 校验：`Proxy-Authorization: Basic aster:<token>`，常量时间比较，失败关闭 |
| `addon/test_vault_placeholders.py` | 占位符策略单测 |
| `addon/test_client_allowlist.py` | 客户端源地址白名单单测 |
| `addon/test_proxy_token.py` | 代理 token 校验单测 |
| `bootstrap.sh` | 运维引导：生成 TLS CA／服务端／客户端证书与代理 token，启用 KV v2、写只读策略、签发只读 token、录入密钥（隐藏输入）、导出不含私钥的公共 CA 证书 |
| `../../docker-compose.mitm.yml` | 应用侧 Compose overlay：注入代理变量、挂载 MITM CA 证书与代理 token，只加入内部网络 `aster_mitm_clients`（固定地址 `10.89.143.3`，不接默认网络） |

## 替换规则与安全边界

- **替换位置**：仅替换 HTTP 请求头与 URL 路径（`?` 之前）。**绝不替换请求体**：内置 `web_fetch` 会把模型提供的目标 URL 放在请求体里发给 `api.deepseek.com`，不替换请求体可防止提示词注入借抓取接口外带真实密钥。
- **主机白名单**：仅当请求目标主机精确匹配 `allowlist.json` 中该 `<NAME>` 允许的主机时才替换（例如 `api.deepseek.com.evil.example` 会被拒绝）。
- **失败关闭**：未知占位符名、不允许的目标主机或 OpenBao 读取失败时，整条请求直接返回 `403`，日志只记占位符名与目标主机，不打印任何密钥值。
- **代理访问三层门**：① 只监听 `10.89.143.2`；② `ASTER_PROXY_CLIENT_ALLOW` 源地址校验；③ 代理 token。CONNECT 与明文 HTTP 请求都必须带 `Proxy-Authorization: Basic aster:<token>`，缺失或错误返回 `407`；明文 HTTP 校验后会移除该头，不转发给目标站。
- **OpenBao 传输鉴权**：`8200` 使用 TLS + `tls_require_and_verify_client_cert`。只有 `aster-mitm` 内的 addon 进程持有客户端证书，且它只读 `secret/aster/<NAME>`。`/v1/sys/health` 本身免 token，但无证书的客户端在 TLS 握手阶段即失败，因此经代理或同网直连都拿不到 200。明文监听仅存在于容器内 `127.0.0.1:8201`。
- **启动期失败关闭**：代理 token 文件或 TLS 材料缺失／格式错误时 `mitmdump` 启动失败；应用侧 `ASTER_MITM_TOKEN_FILE` 不可读或 token 形状不合法时 `configureEnvProxy()` 抛 `ConfigurationError`，不会以未认证方式连接代理。

| 变量名（`.env`） | 是否占位 | 占位符值 | OpenBao KV 路径 | 允许出站主机 |
| --- | --- | --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | `__vault_DEEPSEEK_API_KEY__` | `secret/aster/DEEPSEEK_API_KEY` | `api.deepseek.com` |
| `PLATFORM_WEB_SEARCH_API_KEY` | 是（可选，零配置 Web 能力） | `__vault_PLATFORM_WEB_SEARCH_API_KEY__` | `secret/aster/PLATFORM_WEB_SEARCH_API_KEY` | `api.deepseek.com` |
| `DEEPSEEK_WEB_API_KEY` | 是（已退役，仅兼容） | `__vault_DEEPSEEK_WEB_API_KEY__` | `secret/aster/DEEPSEEK_WEB_API_KEY` | `api.deepseek.com` |
| 其他提供商 `*_API_KEY` | 是（按需） | `__vault_<NAME>__` | `secret/aster/<NAME>` | 见 `addon/allowlist.json` |
| `MODEL_PROVIDER` / `MODEL_ID` / `DATA_DIR` / `MEMORY_*` | 否 | 普通配置值 | — | — |
| `LANGFUSE_SECRET_KEY` | 是（启用 Langfuse Trace 时） | `__vault_LANGFUSE_SECRET_KEY__` | `secret/aster/LANGFUSE_SECRET_KEY` | `cloud.langfuse.com`、`us.cloud.langfuse.com` |
| `LANGFUSE_PUBLIC_KEY` | 否（公开值） | 明文即可；要统一管理也可用 `__vault_LANGFUSE_PUBLIC_KEY__` | `secret/aster/LANGFUSE_PUBLIC_KEY`（可选） | `cloud.langfuse.com`、`us.cloud.langfuse.com` |

代理 token 不是 `.env` 变量：宿主机文件 `~/Aster/secrets/openbao/mitm-proxy-token` 由 `bootstrap.sh` 生成，同时只读挂入 `aster-mitm` 与应用容器；应用通过 `ASTER_MITM_TOKEN_FILE` 读取，并在启动时注入代理 URL 的 userinfo（`aster:<token>`）。`secret/aster/MITM_PROXY_TOKEN` 保存同一值的副本，供运维核对。

## 网络可达性与端口暴露

两个监听端口都不发布到宿主机，并且各自只在专用网络中可监听：

| 端口 | 监听位置 | 谁能连 | 谁不能连 |
| --- | --- | --- | --- |
| `14322`（MITM 代理） | 仅绑定 `aster_mitm_clients` 上的 `10.89.143.2`，不是 `0.0.0.0` | 只有 Aster 应用容器 `10.89.143.3`，并且必须带有效代理 token；addon 同时校验源地址与 token | 宿主机（未 publish；即使能路由到该子网，源地址也不在白名单 → `403`）；`aster_vault`／`aster_egress` 上的容器；其它任何网络的容器；无 token 或 token 错误 → `407` |
| `8200`（OpenBao） | `aster_vault` 内网 `10.89.82.2:8200`，TLS + mTLS | 只有持有客户端证书的 `aster-mitm` addon；运维经容器内 `docker exec` 或 SSH 隧道 + 客户端证书 | Aster 应用容器（不在 `aster_vault`，且无证书）；经 MITM 用绝对地址访问（mitm 代理核心不信任该私有 CA、也没有客户端证书，握手失败）；宿主机上无证书的直连；`aster_egress` 及其它网络的容器 |
| `8201`（OpenBao loopback） | 容器内 `127.0.0.1:8201`，明文 | 仅容器内的 `bao` CLI 与 healthcheck | 任何 Docker 网络与宿主机（loopback 不出容器网络命名空间） |

- `aster_vault` 与 `aster_mitm_clients` 都是 Docker `internal: true`：没有默认路由，应用不能绕过代理直连外网，OpenBao 流量也不会离开宿主机内网。
- 只有 `aster-mitm` 接入 `aster_egress` 负责公网出口，该网络上没有其它业务容器。
- 代理额外做了连接治理：`connection_timeout=30` 关闭空闲连接，避免半开隧道长期占用。
- 运维访问 OpenBao 不要发布端口，使用容器内 CLI 或 SSH 隧道：
  ```bash
  docker exec -it aster-openbao bao status        # 容器内 loopback 8201，无需证书
  ssh -L 8200:10.89.82.2:8200 <user>@<server>     # 本机 127.0.0.1:8200；8200 要求客户端证书
  curl --cacert ~/Aster/secrets/openbao/tls/ca.pem \
       --cert ~/Aster/secrets/openbao/tls/client.pem \
       --key ~/Aster/secrets/openbao/tls/client-key.pem \
       https://127.0.0.1:8200/v1/sys/health
  ```
- 宿主机对 `10.89.143.2:14322` 即使 TCP 可达，也会因源地址不在 `ASTER_PROXY_CLIENT_ALLOW` 而收到 `403`；即便源地址被加入白名单，没有 token 仍会收到 `407`。
- 子网固定为 `10.89.82.0/24`（vault）与 `10.89.143.0/24`（clients）。若与宿主机现有网段冲突，同时修改 `compose.yml` 中的 subnet、`ipv4_address`、`--listen-host`、`ASTER_PROXY_CLIENT_ALLOW`、`bootstrap.sh` 中服务端证书的 IP SAN，以及 `docker-compose.mitm.yml` 中的 `ipv4_address`，保持各处一致。

## 宿主机证书与凭据目录（不进仓库）

```text
~/Aster/secrets/openbao/                    chmod 700
  openbao-mitm-token                        chmod 600，只读策略 token（bootstrap.sh 生成，仅挂入 aster-mitm）
  mitm-proxy-token                          chmod 600，代理 token（bootstrap.sh 生成，挂入 aster-mitm 与应用容器）
  mitmproxy-ca.pem                          chmod 644，仅含公共 CA 证书（由 mitmproxy-ca-cert.pem 导出，只读挂入 personal-agent）
  mitmproxy/                                aster-mitm 的 confdir（容器内 uid 1000 可写）
    mitmproxy-ca.pem                        含 CA 私钥 + 证书，仅 aster-mitm 使用，严禁挂入应用容器
    mitmproxy-ca-cert.pem                   mitmproxy 生成的纯公钥证书，bootstrap.sh 会将它复制为上层 ../mitmproxy-ca.pem
  tls/                                      chmod 700，OpenBao mTLS 材料（bootstrap.sh 生成）
    ca.pem                                  chmod 644，内部 CA 证书
    ca-key.pem                              chmod 600，CA 私钥；只留在宿主机，不挂入任何容器
    server.pem / server-key.pem             chmod 644 / 644，OpenBao 服务端证书与私钥（仅挂入 aster-openbao）
    client.pem / client-key.pem             chmod 644 / 600，客户端证书与私钥（仅挂入 aster-mitm）
```

> `aster-mitm` 以镜像内的 uid 1000 运行。`mitm-proxy-token`、`tls/client-key.pem` 与 `openbao-mitm-token` 必须对该 uid 可读：若运行 compose 的运维账号就是 uid 1000，直接使用即可；否则在宿主机执行 `sudo chown 1000:1000` 仅针对这三个文件（目录仍保持 700，公钥证书保持 644）。

> **生产 CA 信任正式做法**：
> - 严禁在生产环境使用 `ssl_insecure` 或 `NODE_TLS_REJECT_UNAUTHORIZED=0`（应用配置校验 `readConfig` 与 `configureEnvProxy` 也会直接拒绝 `NODE_TLS_REJECT_UNAUTHORIZED=0`）。
> - 将 `aster-mitm` 生成的纯公钥证书导出到 `~/Aster/secrets/openbao/mitmproxy-ca.pem`（仅包含 `-----BEGIN CERTIFICATE-----`，不含 `PRIVATE KEY`），通过 `docker-compose.mitm.yml` 只读挂载到容器内 `/run/aster-mitm/mitmproxy-ca.pem`，并设置 `NODE_EXTRA_CA_CERTS=/run/aster-mitm/mitmproxy-ca.pem`。
> - 若生产机器上证书放在其他路径，可通过环境变量 `ASTER_MITM_CA_CERT=/actual/path/to/ca-cert.pem` 覆盖挂载源路径；代理 token 同理用 `ASTER_MITM_PROXY_TOKEN=/actual/path/to/mitm-proxy-token` 覆盖。两个挂载都设置了 `create_host_path: false`，文件缺失时 `docker compose up` 直接失败，而不是创建空目录。

## 1. 启动或核对 OpenBao 与 MITM（若尚未运行）

```bash
cd ~/Aster/deploy/openbao-mitm
export OPENBAO_IMAGE=<生产固定版本 OpenBao 镜像>
export MITMPROXY_IMAGE=<生产固定版本 mitmproxy 镜像>
export ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao
mkdir -p "$ASTER_OPENBAO_SECRETS/mitmproxy" && sudo chown 1000:1000 "$ASTER_OPENBAO_SECRETS/mitmproxy"

# 1) 先生成 TLS CA／服务端／客户端证书与代理 token。容器未运行时脚本在此停下，不提示任何密钥。
./bootstrap.sh

# 2) 启动 OpenBao（8200 已是 TLS + mTLS），初始化并解封；CLI 走容器内 loopback 8201
docker compose up -d openbao
docker exec -it aster-openbao bao operator init        # 离线保存 unseal key 与 initial root token
docker exec -it aster-openbao bao operator unseal      # 按提示重复足够次数
docker exec -it aster-openbao bao status               # 期望 Sealed false

# 3) 写入 KV、只读 token 与代理 token（隐藏输入根 token 与各密钥值）
ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao ./bootstrap.sh DEEPSEEK_API_KEY PLATFORM_WEB_SEARCH_API_KEY LANGFUSE_SECRET_KEY

# 4) 启动 mitm；首次启动生成 mitmproxy CA 后再跑一次（不传密钥名）导出公共 CA
docker compose up -d mitm
ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao ./bootstrap.sh
```

`bootstrap.sh` 可重复执行：已有 TLS 文件、token 文件、KV 条目保持不变。服务端证书 SAN 覆盖 `aster-openbao`、`localhost`、`10.89.82.2`、`127.0.0.1`；客户端证书仅含 `clientAuth`。更换 IP 或网络名后需删除 `tls/` 重新生成，并同步 `compose.yml`。

从明文 `8200` 的旧栈升级时，先 `docker compose down`（`openbao-data` 卷保留；重启后需要重新 unseal），再按上面顺序执行。不要在旧容器仍运行时只重跑 `bootstrap.sh`：旧容器没有新的 loopback `8201` 环境，也不会加载 TLS 配置。

## 2. 应用加入 `aster_mitm_clients` 并切换为占位符（迁移步骤）

1. **备份原 `.env`（保存在仓库外）**：
   ```bash
   cp ~/Aster/.env ~/Aster/secrets/env.plaintext.bak
   chmod 600 ~/Aster/secrets/env.plaintext.bak
   ```
2. **确认公共 CA 证书与代理 token 存在**：
   ```bash
   grep -c "BEGIN CERTIFICATE" ~/Aster/secrets/openbao/mitmproxy-ca.pem   # 应 >= 1
   grep -c "PRIVATE KEY" ~/Aster/secrets/openbao/mitmproxy-ca.pem || true # 必须为 0
   test -s ~/Aster/secrets/openbao/mitm-proxy-token && echo "proxy token present"
   ```
3. **将 `.env` 中的密钥改为 `__vault_<NAME>__` 占位符**（非密钥配置保持不变；代理 token 不写入 `.env`）：
   ```dotenv
   DEEPSEEK_API_KEY=__vault_DEEPSEEK_API_KEY__
   PLATFORM_WEB_SEARCH_API_KEY=__vault_PLATFORM_WEB_SEARCH_API_KEY__
   LANGFUSE_SECRET_KEY=__vault_LANGFUSE_SECRET_KEY__
   ```
4. **叠加 `docker-compose.mitm.yml` 启动应用**（项目名保持 `aster-production`，不要用 `aster`，以免与 OpenBao/MITM 栈争夺网络名）：
   ```bash
   cd ~/Aster
   docker compose -p aster-production --env-file .env \
     -f docker-compose.yml -f docker-compose.mitm.yml up -d
   ```
   应用此时只接入 `aster_mitm_clients`（固定地址 `10.89.143.3`），不再接入默认网络或 `aster_default`。

`docker-compose.mitm.yml` 为 `personal-agent` 注入的环境变量与挂载：
- `HTTPS_PROXY=http://aster-mitm:14322`、`HTTP_PROXY=http://aster-mitm:14322`（本身不含凭据；`configureEnvProxy()` 启动时把 token 注入 URL userinfo）
- `NO_PROXY=localhost,127.0.0.1,::1,aster-mitm`（只保留回环与代理自身；OpenBao 不在应用的任何可达网络上）
- `NODE_USE_ENV_PROXY=1`（应用启动时由 `configureEnvProxy()` 把代理 token 注入 URL userinfo；Node 运行时的 `fetch` 使 LLM、`web_search`/`web_fetch`、MCP 与 Langfuse 请求全部走代理）
- `NODE_EXTRA_CA_CERTS=/run/aster-mitm/mitmproxy-ca.pem`（只读挂载 `${ASTER_MITM_CA_CERT:-~/Aster/secrets/openbao/mitmproxy-ca.pem}`）
- `ASTER_MITM_TOKEN_FILE=/run/aster-mitm/mitm-proxy-token`（只读挂载 `${ASTER_MITM_PROXY_TOKEN:-~/Aster/secrets/openbao/mitm-proxy-token}`）
- 只加入内部网络 `aster_mitm_clients`（固定地址 `10.89.143.3`）；没有默认网络，也没有直连公网的路由

## 3. 验证与验收步骤

### 本地自动化测试（无需真实 OpenBao 或真实密钥）

```bash
npm run check
npx tsx --test test/mitm-proxy.test.ts
python -m unittest discover -s deploy/openbao-mitm/addon -p "test_*.py" -v
```

### 生产／Compose 验收步骤

```bash
# 1. 核对应用只接入 aster_mitm_clients（固定地址 10.89.143.3），不在任何共享网络上
docker inspect aster-production-personal-agent-1 \
  --format '{{json .NetworkSettings.Networks}}'
# 期望输出中只有 aster_mitm_clients，且 IPAddress 为 10.89.143.3

# 2. 经 MITM 请求允许的主机（DeepSeek 模型 API）：占位符被替换，返回 200（或业务状态码，非 403/407）
#    下面的前五行复现应用启动时的凭据注入（真实 token 从文件读取，不打印、不出现在 argv）。
docker exec aster-production-personal-agent-1 node -e '
  const fs = require("node:fs");
  const proxy = new URL(process.env.HTTPS_PROXY);
  proxy.username = "aster";
  proxy.password = fs.readFileSync("/run/aster-mitm/mitm-proxy-token", "utf8").trim();
  process.env.HTTPS_PROXY = process.env.HTTP_PROXY = proxy.toString();
  require("node:http").setGlobalProxyFromEnv(process.env);
  fetch("https://api.deepseek.com/v1/models", {
    headers: { Authorization: "Bearer __vault_DEEPSEEK_API_KEY__" },
  }).then((r) => console.log("deepseek status:", r.status));
'

# 3. 经 MITM 调用内置 web_search / web_fetch（DeepSeek Web 工具端点）
docker exec aster-production-personal-agent-1 node -e '
  const fs = require("node:fs");
  const proxy = new URL(process.env.HTTPS_PROXY);
  proxy.username = "aster";
  proxy.password = fs.readFileSync("/run/aster-mitm/mitm-proxy-token", "utf8").trim();
  process.env.HTTPS_PROXY = process.env.HTTP_PROXY = proxy.toString();
  require("node:http").setGlobalProxyFromEnv(process.env);
  fetch("https://api.deepseek.com/v1/tools/search", {
    method: "POST",
    headers: {
      Authorization: "Bearer __vault_DEEPSEEK_WEB_API_KEY__",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: "example", max_results: 1 }),
  }).then((r) => console.log("web_search status:", r.status));
'

# 4. 越权主机拦截验证：把占位符发往非白名单主机必须返回 403
docker exec aster-production-personal-agent-1 node -e '
  const fs = require("node:fs");
  const proxy = new URL(process.env.HTTPS_PROXY);
  proxy.username = "aster";
  proxy.password = fs.readFileSync("/run/aster-mitm/mitm-proxy-token", "utf8").trim();
  process.env.HTTPS_PROXY = process.env.HTTP_PROXY = proxy.toString();
  require("node:http").setGlobalProxyFromEnv(process.env);
  fetch("https://example.com/", {
    headers: { Authorization: "Bearer __vault_DEEPSEEK_API_KEY__" },
  }).then((r) => console.log("disallowed host status (expected 403):", r.status));
'

# 5. 检查 aster-mitm 日志不泄露路径中的 bot token、代理 token 或任何密钥值（mitmdump -q）
docker logs aster-mitm 2>&1 | grep -c '/bot' || true            # 期望为 0
docker logs aster-mitm 2>&1 | grep -c 'Proxy-Authorization' || true  # 期望为 0

# 6. 网络边界核对：应用不能直连 OpenBao（不在 aster_vault 上，主机名不可解析）
docker exec aster-production-personal-agent-1 node -e '
  fetch("http://aster-openbao:8200/v1/sys/health", { signal: AbortSignal.timeout(3000) })
    .then((r) => console.log("UNEXPECTED openbao status:", r.status))
    .catch((e) => console.log("expected openbao unreachable:", e.cause?.code ?? e.name));
'

# 7. 其它网络（例如 aster_egress）上的容器不能把 MITM 当代理：14322 只绑定在 aster_mitm_clients 上
docker run --rm --network aster_egress --entrypoint node "$ASTER_IMAGE" -e '
  fetch("http://10.89.143.2:14322", { signal: AbortSignal.timeout(3000) })
    .then((r) => console.log("UNEXPECTED proxy status:", r.status))
    .catch((e) => console.log("expected proxy unreachable:", e.cause?.code ?? e.name));
'

# 8. 宿主机没有 8200／14322 的监听或发布端口
docker port aster-openbao; docker port aster-mitm        # 均为空
ss -ltn | grep -E ':(8200|14322)\b' || echo "no host listeners on 8200/14322"
```

### R-S4 验收：无有效凭证经 MITM 打 OpenBao health 不得为 200

```bash
# 9a. 应用把 http://10.89.82.2:8200 作为绝对地址交给 MITM（先按应用方式带上代理 token，
#     排除“只是被 407 挡住”的干扰）。OpenBao 的 8200 只接受 TLS + mTLS，代理核心到上游
#     既没有客户端证书也不会命中明文监听，因此不会返回 200。
docker exec aster-production-personal-agent-1 node -e '
  const fs = require("node:fs");
  const proxy = new URL(process.env.HTTPS_PROXY);
  proxy.username = "aster";
  proxy.password = fs.readFileSync("/run/aster-mitm/mitm-proxy-token", "utf8").trim();
  process.env.HTTPS_PROXY = process.env.HTTP_PROXY = proxy.toString();
  require("node:http").setGlobalProxyFromEnv(process.env);
  fetch("http://10.89.82.2:8200/v1/sys/health", { signal: AbortSignal.timeout(5000) })
    .then((r) => console.log("openbao health status (must not be 200):", r.status))
    .catch((e) => console.log("expected openbao health blocked:", e.cause?.code ?? e.name));
'

# 9b. 同样打 https://10.89.82.2:8200：mitm 不信任该私有 CA，且 OpenBao 要求客户端证书，
#     双向都会让上游 TLS 失败，不会返回 200。
docker exec aster-production-personal-agent-1 node -e '
  const fs = require("node:fs");
  const proxy = new URL(process.env.HTTPS_PROXY);
  proxy.username = "aster";
  proxy.password = fs.readFileSync("/run/aster-mitm/mitm-proxy-token", "utf8").trim();
  process.env.HTTPS_PROXY = process.env.HTTP_PROXY = proxy.toString();
  require("node:http").setGlobalProxyFromEnv(process.env);
  fetch("https://10.89.82.2:8200/v1/sys/health", { signal: AbortSignal.timeout(5000) })
    .then((r) => console.log("openbao tls status (must not be 200):", r.status))
    .catch((e) => console.log("expected openbao tls blocked:", e.cause?.code ?? e.name));
'

# 9c. 合法的容器内探活仍可用（loopback 明文 8201）
docker exec aster-openbao bao status

# 9d. 无客户端证书直连 8200（宿主机经 bridge 地址或 SSH 隧道）在 TLS 握手阶段被拒
openssl s_client -connect 10.89.82.2:8200 -CAfile ~/Aster/secrets/openbao/tls/ca.pem </dev/null 2>&1 | grep -E 'alert|verify|CONNECTED' | head
```

期望：9a／9b 都不是 `200`；9c 正常；9d 显示握手失败（服务端要求客户端证书）。带客户端证书的运维连接（见“网络可达性”中的 `curl`）可正常拿到 health。

## 4. 回滚步骤（去掉 proxy/CA/token、恢复明文 env）

若需回退到无代理直连模式：

1. **恢复仓库外备份的明文 `.env`**：
   ```bash
   cp ~/Aster/secrets/env.plaintext.bak ~/Aster/.env
   chmod 600 ~/Aster/.env
   ```
2. **仅使用基础 `docker-compose.yml` 重建应用容器**（去掉 `-f docker-compose.mitm.yml`）：
   ```bash
   cd ~/Aster
   docker compose -p aster-production --env-file .env -f docker-compose.yml up -d
   ```
   此时 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`、`NODE_EXTRA_CA_CERTS`、`ASTER_MITM_TOKEN_FILE`、两个只读挂载以及 `aster_mitm_clients` 网络连接均从 `personal-agent` 容器移除，应用恢复直连默认网络。
3. **网络与 OpenBao/MITM 栈**：回滚应用不需要删除专用网络。若要把 OpenBao 恢复为明文 8200，必须同时把 `deploy/openbao-mitm/openbao/config.hcl` 与 `compose.yml` 中的 TLS 挂载、`OPENBAO_ADDR`、代理 token 配置一起回退；只回退其中一侧会导致 mitm 无法读取 KV。不要删除 `tls/` 与 token 文件，保留以便回滚或轮换。
4. 若整个 OpenBao + MITM 栈下线，在 `deploy/openbao-mitm` 执行 `docker compose down`（会一并移除 `aster_vault`、`aster_mitm_clients`、`aster_egress`）。

## 5. 已知问题说明

- **模型／Web 端点出口网络超时**：若宿主机所在网络无法直连 `api.deepseek.com`（即使经同机 `aster-mitm` 出站仍受限于宿主机出口网络），模型与 Web 工具请求超时属于**已知主机出口网络问题**，不是本 PR 的回归；先核对 `HTTPS_PROXY`、`ASTER_PROXY_CLIENT_ALLOW` 与 `addon/allowlist.json` 中的目标主机，不要为此放宽白名单。
