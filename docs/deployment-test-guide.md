# Aster Docker 部署运行手册

生产交付统一使用 Docker 镜像 **Aster**（镜像仓库名 `aster`）。服务器只需要 Docker Engine 24+ 和 Compose 2.24.4+，不需要主机 Node.js 或 Go。开发运行仍可使用 README 中的 npm 命令。

状态：本手册是部署步骤和验收标准。所有者确认 Aster 已部署在腾讯云服务器上并持续运行。文中的“预期”是操作时的核对标准。第 9 节的脱敏记录（日期、镜像 digest、场景、结果）是可选项，没有它也不改变已部署这一事实。原 systemd 部署已停止支持，只保留[迁移路径](#7-从-systemd-迁移)。决定见 [ADR-0012](adr/0012-docker-replaces-systemd.md)。删除 Agent Vault、改成单服务的决定见 [ADR-0005](adr/0005-remove-agent-vault-single-service.md)。

## 1. 交付物与镜像

| 文件 | 用途 |
| --- | --- |
| `docker-compose.yml` | 基础部署：只运行应用，镜像为 `${ASTER_IMAGE:-aster:local}`，不含 `build` |
| `docker-compose.build.yml` | 本地构建覆盖：为应用添加 `build: .` |

镜像仓库目前没有发布 Aster 的公共镜像。示例中的 `aster:local` 是本地标签，生产应替换为你自己的镜像仓库引用。

资源上限（配置值，不是实测峰值）：

| 服务 | 内存 | 进程/线程 |
| --- | --- | --- |
| `personal-agent` | 1 GB | 128 |

停止宽限 45 秒（`docker-compose.yml` 的 `stop_grace_period`）。应用容器以 uid 1000 运行，可写卷 `/data`；它的根文件系统并非只读。镜像内置 Bash、`flock`、npm 和 Node 24.19.0，并设置 `HOME=/data`、`NPM_CONFIG_CACHE=/data/.npm`。

### 同一数据卷的单实例保护

镜像入口为 `flock --no-fork --nonblock /data/app.lock node dist/src/main.js`。同一个数据卷上的第二个应用容器会因拿不到锁而立即退出，这是有意的保护。它只覆盖“同卷多容器”：

- 不同数据卷、同一个 bot token 或同一个 owner 的两个实例不会被镜像检测。Telegram 长轮询会互相争抢，可能产生重复回复。
- 迁移、回滚或演练期间不要让旧实例和新实例同时消费同一个 bot。
- 同一数据卷只允许一个容器使用；不要用 `docker compose up --scale` 扩容。

同一主机上的 `test` 与 `production` 共用这份 Compose，由版本化环境描述区分项目名、卷和 bot 身份。检查入口是 `npm run deployment:environment`。字段见 [部署环境描述](deployment-environments.md)。渲染通过不等于两环境已经隔离验收。

## 2. 配置

基础部署使用项目目录下的 `.env`：

```sh
cp .env.example .env
vi .env
chmod 600 .env
```

必填项：

- `TELEGRAM_BOT_TOKEN`：BotFather 创建的 bot token。
- `TELEGRAM_OWNER_ID`：纯数字 Telegram 用户 ID；不要写用户名。
- `MODEL_PROVIDER`：`src/providers.ts` 注册表内的 id。
- `MODEL_ID`：该提供商在 pi-ai 1.3.0 模型目录中的 id。
- 当前提供商对应的 API key 变量（如 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`）；其他提供商的 key 留空。
- `TELEGRAM_API_ROOT`（可选）：https 前缀，无 query 或 fragment。供无法直连 `api.telegram.org` 的主机把 Bot API 指到自建反向代理。未设置时使用官方根地址。仓库没有记录这项是否在某台机器上使用。

只检查键是否存在，不要在终端或日志中回显值：

```sh
grep -cE '^(TELEGRAM_BOT_TOKEN|TELEGRAM_OWNER_ID|MODEL_PROVIDER|MODEL_ID)=.+' .env   # 预期 4
grep -cE '^[A-Z0-9_]*_API_KEY=.+' .env                                            # 至少 1
```

`DATA_DIR` 由 Compose 固定为 `/data`，`.env` 中的值不生效。数据卷的显式名称是 `personal-agent-data`，不随项目目录名变化；升级 Aster 改名时也不改卷名。

离线配置检查不联网、不回显凭据：

```sh
docker compose run --rm --no-deps personal-agent node dist/src/check-config.js
```

预期输出 `Configuration OK: MODEL_PROVIDER=... MODEL_ID=... MCP_SERVERS=...`。缺失项会打印 `Missing configuration: <KEY>`，提供商或模型 id 错误会打印候选列表；先修配置，不要反复重启。bot 已有 webhook 时应用拒绝启动，需先在原部署中停用。

MCP 配置默认读取 `DATA_DIR/mcp.json`，即卷内 `/data/mcp.json`；文件不存在表示关闭。默认路径上的文件级错误只禁用 MCP，`MCP_CONFIG` 显式指定的文件错误会使检查失败。配置格式见 [工具与 MCP](mcp.md)。

容器内的绝对路径是卷内路径，不是旧主机路径：`cwd`、stdio `command`/`args` 必须指向 `/data/...` 或镜像内已有程序。迁移 systemd 配置时，把 `/var/lib/personal-agent/...` 改为 `/data/...`，并把 `command` 改为镜像内可用的绝对路径（如 `/usr/local/bin/node`）。镜像不会自动安装 stdio server 的依赖；需要在派生镜像中预装，或显式允许并审计运行时下载。

## 3. 构建与分发镜像

生产 Compose 文件本身不构建。构建在构建机执行：

```sh
# 应用镜像
docker compose -f docker-compose.yml -f docker-compose.build.yml build personal-agent
```

等价的单镜像命令是 `docker build -t aster:local .`。构建机需要能访问 npm registry 和 Docker 基础镜像仓库。本地验证中应用镜像已成功构建。

通过镜像仓库分发时，推送后记录不可变 digest。通过文件分发时：

```sh
# 构建机
docker save aster:local | gzip > aster-image.tar.gz

# 服务器
docker load < aster-image.tar.gz
```

生产不在服务器上临时构建。选择一种交付方式并在部署记录中写明镜像 digest 或归档校验和。

## 4. 基础部署

```sh
docker compose config --quiet
docker compose run --rm --no-deps personal-agent node dist/src/check-config.js
docker compose up -d --no-build
docker compose logs --tail 50 personal-agent
```

预期日志出现 `Personal agent starting; single-owner private Telegram messages enabled.`，随后进入长轮询且无持续报错。`docker compose ps` 显示 `running` 只表示进程存在，不代表已通过 Telegram 验收。

用 owner 账号私聊 bot 发送“现在几点？”。预期收到与服务器 UTC 时间一致的回复，日志中没有 `Agent request failed`。数据卷中应出现：

```sh
docker compose exec personal-agent ls -la /data /data/workspace
```

`inbox.sqlite`、`agent.sqlite`、`workspace/` 应存在。

### 生产更新（不可变引用）

在 `.env` 中设置实际镜像引用，例如：

```env
ASTER_IMAGE=registry.example.com/team/aster@sha256:<digest>
```

然后：

```sh
docker compose pull personal-agent
docker compose stop personal-agent
docker compose up -d --no-build personal-agent
docker compose logs --tail 50 personal-agent
```

数据卷保持不变。更新前先按第 6 节备份。不要用 `docker compose down -v` 代替普通停服。

### 回滚

把 `ASTER_IMAGE` 改回上一个可用 digest，执行 `docker compose up -d --no-build personal-agent`。镜像回滚不会自动回滚数据；应用没有数据库降级机制，旧镜像也不保证能读取新版本写入的状态。

- 若新版本只运行过、未产生不可逆数据，直接用旧镜像启动即可。
- 若出现 schema 或数据不兼容，这是一个显式的恢复决策：按第 6 节还原备份会丢失备份之后产生的会话、记忆和投递状态，可能造成重复回复。先停服、备份当前卷，再决定是否还原；不要把它当作回滚的默认步骤。
- 回滚前始终先备份当前卷，保留现场以便排查。

## 5. 维护命令

所有一次性命令使用同一镜像，先停应用，避免与运行中的进程争用 SQLite 或 OAuth token 文件。

```sh
# 投递核查
docker compose stop personal-agent
docker compose run --rm --no-deps personal-agent node dist/src/deliveries.js list
docker compose start personal-agent

# MCP 连接检查
docker compose stop personal-agent
docker compose run --rm --no-deps personal-agent node dist/src/mcp-check.js
docker compose start personal-agent
```

`deliveries.js list` 输出 `blocked` 与 `failures` 两个数组；该命令会先执行恢复，强杀时处于 `sending` 的分段会以 `uncertain` 出现。先核对 Telegram 实际收到的内容，再决定 `retry` 或 `sent`。命令语义见 [投递核查与补发](deliveries.md)。这两条命令只改本地投递状态，不重新执行 agent。

### MCP OAuth

`mcp-auth.js` 在进程内监听 `127.0.0.1:<redirectPort>`。普通 `docker compose run` 的容器有自己的网络命名空间；`-p 127.0.0.1:8765:8765` 把宿主端口转发到容器网络接口，而进程只监听容器回环，回调因此不会到达进程。因此使用下面的宿主网络流程完成授权。

在 Linux 运维主机上，可以直接用宿主网络运行同一个镜像，让授权进程和操作者的 SSH 转发共享回环。显式指定镜像，先停应用：

```sh
docker compose stop personal-agent
docker run --rm --network host --env-file .env \
  -e DATA_DIR=/data -v personal-agent-data:/data \
  aster:local node dist/src/mcp-auth.js calendar
docker compose start personal-agent
```

使用 `ASTER_IMAGE` 引用时把最后一条命令中的 `aster:local` 换成该值；`--network host` 只在 Linux 上可用。授权进程会读写卷内 `mcp-oauth/`，因此必须先停应用。操作者本机先建立 `ssh -L 8765:127.0.0.1:8765 user@host`（端口与 `auth.redirectPort` 一致），再打开命令打印的 URL。

不要删除已有的 client 注册信息；重新注册会让旧授权失效。授权文件必须保持 uid 1000、`600`。

### 日志与资源

```sh
docker compose ps
docker compose logs --tail 100 personal-agent
docker stats --no-stream $(docker compose ps -q personal-agent)
docker inspect --format '{{.State.OOMKilled}}' $(docker compose ps -q personal-agent)
```

关注初始化日志、`Agent request failed`、`delivery`、`polling retry`、重启次数和 `OOMKilled`。1 GB 是保护线，不是性能保证；真实峰值仍需在目标机测量。

## 6. 备份与还原（整个卷）

备份前停止应用，保证 SQLite 连接已关闭。备份和还原都针对整个数据卷，不做单文件挑选。

```sh
docker compose stop personal-agent

docker run --rm -v personal-agent-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/aster-data.tgz -C /data .

tar tzf aster-data.tgz | grep -E '(^|/)(agent|inbox)\.sqlite(-wal|-shm)?$|(^|/)workspace/|(^|/)mcp-oauth/'
ls -l aster-data.tgz

docker compose start personal-agent
```

通过标准：

- 归档非空，列表包含 `agent.sqlite`、`inbox.sqlite`、`workspace/`；SQLite 的 `-wal`、`-shm` 文件可能同时存在。
- 配置了 MCP 时包含 `mcp.json`，使用过 OAuth 时包含 `mcp-oauth/<server>.json`。
- 只有空列表或找不到文件，说明卷名错误或目录为空，不能当作备份成功。

还原会覆盖现有数据：

```sh
docker compose down
docker run --rm -v personal-agent-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/aster-data.tgz -C /data; \
    chown -R 1000:1000 /data'
docker compose up -d --no-build
docker compose logs --tail 20 personal-agent
```

`chown` 保证应用以 uid 1000 读写；不要跳过。还原后确认记忆和会话回到备份时状态。

## 7. 从 systemd 迁移

旧部署的 systemd unit 与安装脚本已从仓库删除；这些命令只用于停止和迁移旧实例，不是受支持的安装方式。迁移期间保持旧数据目录完整，先备份再导入。

```sh
# 1. 停止旧应用；如果旧主机上仍有 unit
sudo systemctl stop personal-agent
sudo systemctl disable personal-agent

# 2. 备份整个旧数据目录
sudo tar czf /root/aster-legacy-data.tgz -C /var/lib/personal-agent .
sudo tar tzf /root/aster-legacy-data.tgz | \
  grep -E '(^|/)(agent|inbox)\.sqlite(-wal|-shm)?$|(^|/)workspace/|(^|/)mcp-oauth/'

# 3. 目标卷必须为空。先确认没有旧实例写入；已有内容时先单独备份，不要直接覆盖。
docker volume create personal-agent-data
docker run --rm -v personal-agent-data:/data alpine \
  sh -c 'set -e; [ -z "$(ls -A /data)" ] || { echo "target volume is not empty; back it up and import into a new volume" >&2; exit 1; }'

# 4. 导入命名卷，保留所有文件并改为 uid 1000
docker run --rm -v personal-agent-data:/data -v /root:/backup alpine \
  sh -ec '[ -z "$(ls -A /data)" ] || { echo "target volume is not empty" >&2; exit 1; }; \
    tar xzf /backup/aster-legacy-data.tgz -C /data; chown -R 1000:1000 /data'

# 5. 检查并启动
docker compose run --rm --no-deps personal-agent node dist/src/check-config.js
docker compose up -d --no-build
docker compose logs --tail 50 personal-agent
```

第 3 步故意在目标卷非空时失败，避免把已有卷内容删除后才发现归档错误。已有目标卷（例如之前演练过）先按第 6 节整卷备份；需要保留时改为导入一个新卷，再通过 `docker-compose.yml` 的卷名或复制数据切换，不要用 `rm -rf /data/*` 清空正在使用的卷。

迁移时必须保留：

| 内容 | 说明 |
| --- | --- |
| `agent.sqlite` 及其 WAL/SHM | 底座会话与执行恢复状态 |
| `inbox.sqlite` 及其 WAL/SHM | 请求消费位置、身份绑定和投递状态 |
| `workspace/` | 记忆和任务文件 |
| `mcp.json` | 可选，MCP 配置 |
| `mcp-oauth/` | 可选，MCP OAuth token 与动态注册信息 |
| `.npm/` | 可选，stdio MCP 的缓存；保留可减少重新下载 |

配置迁移应在上述第 5 步启动前完成：

- MCP 的 `cwd` 改为容器内路径，例如 `/data/workspace`；宿主 `/opt` 或用户目录下的命令不可直接复用，应在派生镜像中安装依赖并更新绝对路径。
- 从 `/etc/personal-agent.env` 摘取 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_OWNER_ID`、`MODEL_PROVIDER`、`MODEL_ID` 和对应 API key 到 `.env`。
- 不要复制 `DATA_DIR=/var/lib/personal-agent`；容器内固定 `/data`。
- owner ID 使用 `.env` 中的内联 `TELEGRAM_OWNER_ID`。
- 旧 systemd 专用的 `ProtectHome`、`MemoryMax`、`ReadWritePaths` 等设置不再适用；资源限制由 Compose 提供。

已有卷名必须保留：应用卷 `personal-agent-data`。如果旧 Compose 创建的是带项目前缀的卷（如 `<目录名>_personal-agent-data`），把内容复制到显式命名的卷后再启动，不要改名或新建空卷。迁移验收通过并保留一段回滚窗口后，再删除旧 unit 和旧数据目录；在此之前不要删除 `/var/lib/personal-agent`。

## 8. 常见故障

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `pull access denied` / 找不到镜像 | 镜像未构建、未 `load` 或引用写错 | 核对 `ASTER_IMAGE`；构建机分发或从仓库拉取 |
| 启动即退出，`Missing configuration` | `.env` 缺项 | 补齐对应键 |
| 启动即退出，webhook 错误 | bot 已有 webhook | 先停用原 webhook |
| 启动即退出，`belongs to another Telegram bot or owner` | 数据卷来自别的 bot／用户 | 换独立数据卷，或确认身份后迁移 |
| 启动即退出，`flock` 无法加锁 | 同一数据卷已有实例 | 停掉旧容器；不要并行运行 |
| `EACCES` / `Unable to open the database file` | 卷内文件属主不是 uid 1000 | `chown -R 1000:1000 /data` |
| 容器 `running` 但无回复 | 模型或 Telegram 网络失败 | 看日志错误码；核对服务器出网与模型端点可达性 |
| 备份归档为空 | 卷名错误 | `docker volume ls` 核对 `personal-agent-data` |
| 收到截断提示 | 模型输出达到长度上限 | 让用户拆分问题；不会自动续写 |
| 回复重复 | 发送结果曾未知后人工 `retry` | 核对 Telegram 实际消息，重复属预期风险 |

## 9. 上线判定与验证边界

全部满足才算部署验收完成：

- [ ] 配置检查输出 `Configuration OK`。
- [ ] owner 私聊、会话连续、工具调用、记忆跨重启、非授权隔离均通过。
- [ ] 正常重启、执行中断、强杀三种场景通过。
- [ ] `deliveries.js list` 可用且输出可读。
- [ ] 未触发 OOM，重启次数稳定。
- [ ] 备份归档包含 SQLite、WAL、`workspace/` 和 `mcp-oauth/`，整卷还原演练成功。
- [ ] 日志中没有凭据或完整消息内容。
- [ ] 记录了镜像 digest、Compose 版本、真实模型和当日费用。

仓库里能核对的范围：应用镜像可构建；基础 Compose 与 build 覆盖可渲染；主机测试和 GitHub Actions 的单服务拓扑通过。拓扑不覆盖真实 Telegram／模型链路，见 [CI/CD 实施计划的当前事实](ci-cd-implementation-plan.md#当前事实)。所有者确认生产环境已在腾讯云运行。上面的清单是可选核对项，未勾选不否定已部署。

### 部署记录

> **TODO（维护者填写，可选）**  
> 可在这里追加一条脱敏记录，至少包括：日期、镜像 digest（`repository@sha256:…`）、场景（例如 owner 私聊、记忆跨重启、容器重启）、结果。不要粘贴 token、聊天原文或日志全文。  
> 没有这条记录时，仍以所有者确认为准：Aster 已部署在腾讯云并持续运行。记忆验收里的腾讯云机器是测试补测，见 [记忆系统验收](memory-verification.md)，不能代替本条生产说明。
