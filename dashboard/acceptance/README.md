# 验收标准与运行方式

面向运维在**单机部署**上执行。应用与 sandbox 都由 `dashboard/docker-compose.dashboard.yml`
定义；控制台只发布在宿主 `127.0.0.1:8787`，并强制 `WEB_TOKEN`。

## 前置条件

- 一台干净主机（或至少 8787 端口空闲），Linux + Docker ≥ 24、Docker Compose ≥ 2.24
  （overlay 使用 `!override`），`curl` 可用。
- 仓库根目录存在 `dashboard/.env`（从 `dashboard/.env.example` 复制），填入：
  - `WEB_TOKEN`：16–256 个非空白字符；
  - `MODEL_PROVIDER`、`MODEL_ID`：`src/providers.ts` 支持的组合；
  - 对应 provider 的 API key（如 `DEEPSEEK_API_KEY`）。
- 验收使用独立 compose 项目 `aster-acceptance` 和独立卷
  （`aster-acceptance-app/runtime/workspaces`），不会读写其它部署的数据。
  覆盖 `ASTER_APP_VOLUME`、`ASTER_SANDBOX_RUNTIME_VOLUME`、`ASTER_SANDBOX_WORKSPACES_VOLUME`
  或 `ACCEPTANCE_PROJECT` 可改。

## 一键验收

```bash
cd <仓库根目录>
bash dashboard/acceptance/run.sh
```

脚本按顺序执行，每条打印 `PASS`/`FAIL`，最后输出失败组数量并以非零码退出。它不会自动清理，
便于查看现场。加 `--with-tests` 会额外运行 `npm test` 和 `npm run test:topology`（需要 Node 24）。

预期：全部 `PASS`，最后 `Acceptance summary: 0 failing check group(s).`

## 10 条验收与证据

| # | 标准 | 由谁执行 | 通过证据 |
| --- | --- | --- | --- |
| 1 | overlay 一次 up 成功 | `run.sh` | `compose up -d --build` 退出 0；两个服务 running；sandbox healthy |
| 2 | 研究员 + 编程 bot，两行 conversationId 不同 | `run.sh` + `console-check.mjs` | `bots` 表两行、conversationId 不同；控制台返回 201 |
| 3 | prompt/工具隔离，非编程 bot 调不到 PTC | `console-check.mjs` | 两行 systemPrompt 不同；`tools` 列不同（programmer 含 `ptc`）；`loadedTools` 中 researcher 无 `codemode`；researcher 的 run 无 codemode 工具事件 |
| 4 | sandbox 内 A 写 a.txt、B ls 看不到；文件原语不能越出会话根或读到 `/data` | `console-check.mjs` + `sandbox-check.mjs` | A 的 bash 输出自己的 `/workspaces/<botId>`；B 的列目录没有 `acceptance-a.txt`；B 执行 `ls -A /data` 无条目（基础镜像自带空 `/data`）；`file.readText` 对 `../`、兄弟 bot 和 `/data` 返回 `permission_denied`；A/B 的 `pwd` 各自独立 |
| 5 | 两个 `sleep 30` 并行约 30 秒 | `console-check.mjs` + `sandbox-check.mjs` | 两个 bot 同时发任务，总耗时 < 48s（串行约 60s） |
| 6 | 事件流实时、running→terminal | `console-check.mjs` | SSE 依次收到 `run_start` → 工具事件 → `run_end`（同一次运行内） |
| 7 | 取消 A 不影响 B | `console-check.mjs` + `sandbox-check.mjs` | `cancel` 返回 `cancelled: true`；A 的历史无迟到答案；B 的「OK」正常完成；RPC 层取消后另一会话命令照常退出 0 |
| 8 | restart 后 bot 和历史还在 | `run.sh`（重启）+ `console-check.mjs --verify-restart` | 重启后两个 botId/conversationId 不变；A 的历史仍含 `WROTE-A` |
| 9 | `npm test` 和 `test:topology` 全绿 | `run.sh --with-tests` 或 CI | `npm test`：0 fail；`test:topology`：`Topology acceptance passed` |
| 10 | 无 token 401、端口只绑宿主 127.0.0.1 | `run.sh` | 无 token 请求 401；`docker compose port` 输出 `127.0.0.1:8787`，或 MITM overlay 下由 `console-ingress` 在宿主 `127.0.0.1:8787` 监听；`ss` 显示仅 127.0.0.1 |

模型相关条目（2/3/4/5/6/7）由真实模型执行脚本内置的确定性 prompt；若模型未按指令调用
bash，对应检查会失败并打印实际事件，重跑即可。第 4/5/7 条另有 RPC 层的确定性检查
（`sandbox-check.mjs`），不依赖模型。

## 手动复核（可选）

```bash
COMPOSE="docker compose -p aster-acceptance -f docker-compose.yml -f dashboard/docker-compose.dashboard.yml --env-file dashboard/.env"

# 10: 端口与 token
$COMPOSE port personal-agent 8787            # 期望 127.0.0.1:8787
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/bots   # 期望 401
curl -s -H "Authorization: Bearer $WEB_TOKEN" http://127.0.0.1:8787/api/bots

# 2: bots 表
$COMPOSE exec -T personal-agent node -e \
  "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/inbox.sqlite');console.log(d.prepare('select botId,role,conversationId,tools from bots').all())"

# 6: 事件流（浏览器不可用时）
curl -sN "http://127.0.0.1:8787/api/bots/<botId>/events?token=$WEB_TOKEN"
```

## PTC / codemode

- codemode 在 overlay 中开启（`CODEMODE_ENABLED=1`），但角色的工具清单由宿主决定：
  `programmer` 才加载 `codemode`，其它角色不加载（验收第 3 条）。
- sandbox 内的 PTC runner 以 bot 自己的目录为工作区，并把它映射成虚拟 `/workspace`；
  模型在 bash 中写的文件与 PTC 脚本看到的 `/workspace/<name>` 是同一份。
- 隔离来源是容器本身（`network none`、`cap_drop ALL`、非 root、只读根文件系统），
  健康检查中 `isolation.mode` 应为 `container`。

## 已知局限

- 原始 bash 仍可 `ls /workspaces` 看到兄弟 bot 目录；文件原语与每个会话的工作目录被限制在
  `/workspaces/<botId>`，`/data` 未挂载。验收脚本会把这一点打印为 `NOTE`，不计失败。
- 并发上限是每条 RPC 连接的 3（deployment 全局只有应用这一条连接）；第二客户端会各自有 3。
- sandbox 会话不跨连接重放；结果未知的取消不会自动重跑。
- 验收写入独立卷；确认后可用 README 末尾的 `down -v` 清理。

## 清理

```bash
docker compose --project-name aster-acceptance \
  -f docker-compose.yml -f dashboard/docker-compose.dashboard.yml down -v
```

不加 `-v` 只删容器，保留验收数据卷供复查。
