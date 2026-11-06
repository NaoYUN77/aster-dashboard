# 验收标准与运行方式

面向运维在**单机部署**上执行。应用与本地 `execution-host`（共享 CVM Execution Host 的同机替代）
都由 `dashboard/docker-compose.dashboard.yml` 定义；控制台只发布在宿主 `127.0.0.1:8787`，
并强制 `WEB_TOKEN`。

> 本套验收针对**旧版显式 profile** 能力面：`run.sh` 会设置 `ALLOW_LEGACY_CATALOG=1`
> （宿主级兼容开关，正常部署默认为 0）。Phase 1 只迁移 Bash / Read / Write / Edit，
> `CODEMODE_ENABLED=0`，因此即使显式提交 `ptc=true` 也不会加载 codemode。生产部署默认走
> 零配置模式：首次进入控制台自动创建并初始化 Bot，用户无需选择 Tool / Capability / MCP /
> API Key。零配置流程由 `test/zero-setup-wiring.test.ts` 与 `test/zero-setup.test.ts` 覆盖。
> 生产拓扑使用 `docker-compose.rpc.yml`（既有 mTLS RPC Gateway）连到共享 CVM 主机，步骤见
> [共享执行主机 Runbook](../../docs/runbook-shared-execution-host.md)；本验收不修改 CVM。

## 前置条件

- 一台干净主机（或至少 8787 端口空闲），Linux + Docker ≥ 24、Docker Compose ≥ 2.24
  （overlay 使用 `!override`），`curl` 可用。
- 仓库根目录存在 `dashboard/.env`（从 `dashboard/.env.example` 复制），填入：
  - `WEB_TOKEN`：16–256 个非空白字符；
  - `MODEL_PROVIDER`、`MODEL_ID`：`src/providers.ts` 支持的组合；
  - 对应 provider 的 API key（如 `DEEPSEEK_API_KEY`）。
- 验收使用独立 compose 项目 `aster-acceptance` 和独立卷
  （`aster-acceptance-app/runtime/workspaces`），不会读写其它部署的数据。
  覆盖 `ASTER_APP_VOLUME`、`ASTER_EXECUTION_RUNTIME_VOLUME`、
  `ASTER_EXECUTION_WORKSPACES_VOLUME` 或 `ACCEPTANCE_PROJECT` 可改。

## 一键验收

```bash
cd <仓库根目录>
bash dashboard/acceptance/run.sh
```

脚本按顺序执行，每条打印 `PASS`/`FAIL`，最后输出失败组数量并以非零码退出。它不会自动清理，
便于查看现场。加 `--with-tests` 会额外运行 `npm test` 和 `npm run test:topology`（需要 Node 24）。

预期：全部 `PASS`，最后 `Acceptance summary: 0 failing check group(s).`

`console-check.mjs` 创建两个 bot 时均向 `POST /api/bots` 提交完整 `profile`，包含
`core/shell/files/web/ptc/memory/reminders/mcp` 八个必填布尔字段，可选约束为 `toolScope`。
两组都显式启用 `core/shell/files/memory/reminders/mcp`、关闭 `web`，仅 `ptc` 分别为 false 和 true。
第二个 bot 的 `ptc=true` 是**兼容性负向用例**：Phase 1 下它同样不应加载 codemode。
`DEFAULT_CATALOG_PROFILE` 的初值与关闭 PTC 的这一组一致，但 API 不允许省略 profile。
创建与返回均无 bot role；宿主 `configureBot` 必须提供完整 `catalogProfile`，没有 tools-only 回退。
profile 是能力授权的唯一来源，`toolScope` 只能收窄；`tools` 是受部署可用性限制的兼容输出投影。

## 10 条验收与证据

| # | 标准 | 由谁执行 | 通过证据 |
| --- | --- | --- | --- |
| 1 | overlay 一次 up 成功 | `run.sh` | `compose up -d --build` 退出 0；两个服务 running；execution-host healthy |
| 2 | 两个显式 profile 的 bot，两行 conversationId 不同 | `run.sh` + `console-check.mjs` | `bots` 表两行、conversationId 不同；带完整 profile 的创建请求返回 201 |
| 3 | prompt/能力隔离；Phase 1 不授予 codemode | `console-check.mjs` | 两行 systemPrompt 不同；返回与持久化的 profile 匹配创建值；`tools` 投影两组都含 `bash` 且都不含 `ptc`；`loadedTools` 两组都不含 `codemode`；运行中无 codemode 工具事件 |
| 4 | 各自默认工作目录下 A 写 a.txt、B 的目录看不到；文件原语不能越出会话根或读到 `/data` | `console-check.mjs` + `execution-host-check.mjs` | A 的 bash 输出自己的 `/workspaces/<botId>`；B 的列目录没有 `acceptance-a.txt`；B 执行 `ls -A /data` 无条目（基础镜像自带空 `/data`）；`file.readText` 对 `../`、兄弟 bot 和 `/data` 返回 `permission_denied`；A/B 的 `pwd` 各自独立 |
| 5 | 两个 `sleep 30` 并行约 30 秒 | `console-check.mjs` + `execution-host-check.mjs` | 两个 bot 同时发任务，总耗时 < 48s（串行约 60s） |
| 6 | 事件流实时、running→terminal | `console-check.mjs` | SSE 依次收到 `run_start` → 工具事件 → `run_end`（同一次运行内） |
| 7 | 取消 A 不影响 B | `console-check.mjs` + `execution-host-check.mjs` | `cancel` 返回 `cancelled: true`；A 的历史无迟到答案；B 的「OK」正常完成；RPC 层取消后另一会话命令照常退出 0 |
| 8 | restart 后 bot、profile 和历史还在 | `run.sh`（重启）+ `console-check.mjs --verify-restart` | 重启后两个 botId/conversationId 不变；完整 profile 保留；A 的历史仍含 `WROTE-A` |
| 9 | `npm test` 和 `test:topology` 全绿 | `run.sh --with-tests` 或 CI | `npm test`：0 fail；`test:topology`：`Topology acceptance passed` |
| 10 | 无 token 401、端口只绑宿主 127.0.0.1 | `run.sh` | 无 token 请求 401；`docker compose port` 输出 `127.0.0.1:8787`，或 MITM overlay 下由 `console-ingress` 在宿主 `127.0.0.1:8787` 监听；`ss` 显示仅 127.0.0.1 |

模型相关条目（2/3/4/5/6/7）由真实模型执行脚本内置的确定性 prompt；若模型未按指令调用
bash，对应检查会失败并打印实际事件，重跑即可。第 4/5/7 条另有 RPC 层的确定性检查
（`execution-host-check.mjs`），不依赖模型。

## 手动复核（可选）

```bash
COMPOSE="docker compose -p aster-acceptance -f docker-compose.yml -f dashboard/docker-compose.dashboard.yml --env-file dashboard/.env"

# 10: 端口与 token
$COMPOSE port personal-agent 8787            # 期望 127.0.0.1:8787
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/bots   # 期望 401
curl -s -H "Authorization: Bearer $WEB_TOKEN" http://127.0.0.1:8787/api/bots

# 2: bots 表
$COMPOSE exec -T personal-agent node -e \
  "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/inbox.sqlite');console.log(d.prepare('select botId,profile,conversationId,tools from bots').all())"

# 6: 事件流（浏览器不可用时）
curl -sN "http://127.0.0.1:8787/api/bots/<botId>/events?token=$WEB_TOKEN"
```

## Phase 1 工具面

- 单机 overlay 的 `execution-host` 是**共享 CVM Execution Host 的同机替代**，不是每 Bot 容器：
  两个服务使用同一个镜像，执行面以专用非 root uid（1000）运行 `rpc-main.js` 的
  `EXECUTION_AGENT_SHARED_HOST=1` 模式，不启动 bwrap、cgroup 或 PTC。
- `CODEMODE_ENABLED=0`；`health.check` 必须报告 `directBash: true`、`fileTools: true`、
  `sharedMode: "rw"`、`ptc: false`、`testExecutor: false`。`execution-host-check.mjs` 的 S1
  即校验这些字段，而不是校验容器隔离。
- Bash / Read / Write / Edit 走既有 RPC 协议；执行超时、`EXECUTION_AGENT_MAX_CONCURRENT`（3）、
  进程组终止、输出窗口与审计沿用原有路径。CC、Herdr 等 CLI 在本阶段不抽象为独立 Agent Tool，
  统一通过 Bash 使用。
- 隔离来源是**单用户 MVP 的架构取舍**，不是容器命名空间：不做每 Bot UID、每 Bot 容器或
  多租户资源隔离。

## 已知边界

- 原始 bash 仍可 `ls /workspaces` 看到兄弟 bot 目录，这是共享主机被接受的设计，不计失败；
  文件原语与每个会话的默认工作目录被限制在 `/workspaces/<botId>`，`/data` 未挂载。
  验收脚本会把这一点打印为 `NOTE`。
- 并发上限是每条 RPC 连接的 3（本部署全局只有应用这一条连接）；第二客户端会各自有 3。
- 会话不跨连接重放；RPC 断线不自动重跑命令，结果未知的取消不会自动重放。
- 验收写入独立卷；确认后可用 README 末尾的 `down -v` 清理。

## 清理

```bash
docker compose --project-name aster-acceptance \
  -f docker-compose.yml -f dashboard/docker-compose.dashboard.yml down -v
```

不加 `-v` 只删容器，保留验收数据卷供复查。
