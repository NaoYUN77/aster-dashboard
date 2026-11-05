# 历史 PR 草稿：修复代码审查问题 F1–F7

历史 PR 正文草稿：仅保留基线 `57ef390` 后该批修复的实现与验证描述。下文「待做」与阻塞只反映当时，不能据此判断当前功能范围或部署状态；systemd 部署已退役。后续功能采用 [临时 spec](README.md#按功能的临时规格) 推进，运行事实见 [README](../README.md)，镜像交付见 [部署指南](deployment-test-guide.md)。

基线：`57ef390`。执行范围与要求见 [docs/review-fix-plan.md](review-fix-plan.md)，逐项记录见 [docs/mvp-verification.md](mvp-verification.md)。

## 已完成

### F1（P1）底座 Session 失效后停止接收

- `src/agent.ts`：`reply()` 区分请求级失败与 Session 失效。宿主关闭信号原样透传；`AGENT_TIMEOUT`／`AGENT_UNANSWERED`／`AGENT_TRUNCATED`／`EMPTY_REPLY` 原样返回；其余持久化调用异常统一包装为 `AGENT_SESSION_FAILED`，`cause` 为 `SessionFailed`。首个 Storage 错误在 Session 锁存前会以原始错误抛出（已核对 pi-durable 1.3.0 `SessionImpl.#call`），因此不能只判断 `instanceof SessionFailed`。
- `src/telegram.ts`：致命错误不写失败回复、不投递，直接向上抛出，请求保持 `pending`；`main.ts` 顶层捕获在未收到关闭信号时置退出码 1，交给进程管理器重启。
- `confirmPart` 移出发送 `try`：本地写入失败不再被误记为 Telegram 投递失败。

### F2（P1）长度截断不按完整成功处理

- 最后一条 assistant 消息 `stopReason === "length"` 时抛出 `AGENT_TRUNCATED` 并携带 `partialReply`。
- 投递层发送部分文本 + “回复因长度限制被截断，内容不完整”，错误码写入 `failures`；不自动续写或重试；空回复仍为 `EMPTY_REPLY`。

### F3（P1）Docker 备份卷名

- `docker-compose.yml` 顶层卷显式 `name: personal-agent-data`，不随项目目录名变化。
- README 写明卷名来源、旧前缀卷的迁移提示、备份后归档内容核对（`inbox.sqlite`、`agent.sqlite`、`workspace/MEMORY.md` 及 WAL/SHM）、以及完整还原步骤；明确退出码 0 不算备份成功。

### F4（P2）恢复执行纳入请求超时

- 移除 `openAgent` 中的 `harness.resume()`，改在 `reply()` 创建 300 秒等待信号后、提交请求前调用。打开时不派发恢复任务（已核对 `Harness.open` → `scheduler.open` 只把 `running` 改回 `pending`）。
- 超时仍调用 `root.abort()`；关闭仍只停止等待并保留可恢复状态。

### F5（P2）投递 CLI 先执行恢复

- `src/deliveries.ts` 在 `list`／`retry`／`sent` 前调用 `inbox.recover()`，遗留 `sending` 以 `uncertain` 出现在列表，`retry`／`sent` 可执行。
- README 与 `docs/contracts-and-lifecycle.md` 同步说明。

### F6（P3）复用底座文本提取

- 用 pi-ai 的 `contentText` 替换手工 `flatMap`，行为与断言不变。

### F7（P3）Telegram 输入边界校验

- `update_id` 必须为非负安全整数；`chat.id`、`from.id` 接受安全整数或数字字符串并统一为字符串；`text` 必须为非空字符串。
- `serveTelegram` 只在 `update_id` 合法时推进消费位置，非法 update 记录不含内容的安全诊断后跳过，不写入 `NaN`、不阻塞轮询。

### 验证

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 38 项通过，0 失败 |
| `npm run build` | 通过 |

测试由 27 项增至 38 项，原 27 项全部保留且断言未放宽。新增用例：

- F1：`a failed agent session stops polling and leaves the request pending`、`a local storage failure while saving a reply is fatal`、`a failed agent session is fatal and the same request recovers after restart`、`a model failure is delivered as a notice and later requests still run`
- F2：`a length-limited answer is reported as truncated with its partial text`、`a truncated agent answer is delivered with an explicit incompleteness notice`
- F4：`reopening does not start recovered work until a reply is waiting`、`a recovered task is bounded by the waiting reply's timeout`
- F5：`delivery CLI recovers an interrupted send before listing and resolving it`
- F7：`malformed Telegram updates are rejected at the boundary`、`invalid updates are skipped without writing an unusable checkpoint`

### 附带改动

- `Dockerfile`：删除 `# syntax=docker/dockerfile:1`（本地构建环境无法拉取该前端镜像）。
- `src/deliveries.ts`：数据库不存在时给出明确的 `DATA_DIR` 提示并以 1 退出。

## 后续补充（2026-10-21，Docker 与安装脚本演练）

- **F3 的 Docker 备份／还原演练已执行**（Windows Docker Desktop 29.7.2 / Compose v5.3.1）：镜像构建成功；`docker compose config` 确认卷名为 `personal-agent-data`；按 README 的 `alpine tar` 命令备份，归档内容核对通过；删改数据后按 README 还原，文件内容与属主恢复，应用自己的 `Inbox` 与 SQLite 存储可正常打开；容器内投递 CLI 的 `list` 与 `sending → uncertain` 恢复行为符合预期。详见 [mvp-verification.md](mvp-verification.md) 的 F3 与阶段 F。
- **`deploy/install-systemd.sh` 在容器中演练并修复五个缺陷**（`systemctl` 为桩，unit 未实际启动）：
  - 只要求**所选提供商**的 API key，`openai` 配置下留空的 `ANTHROPIC_API_KEY` 不再被误判为“配置仍为空”。
  - 配置校验移到构建前与 `systemctl` 之前，避免留下重启循环。
  - Node 路径检查覆盖 `/root`、`/run/user`（`ProtectHome=true` 同样隐藏这些路径）。
  - 从宽松权限的检出复制后，代码目录会被重置为 `755`，不再保留 `777`。
  - 必需键整行缺失或被注释时不再视为已配置（原先只匹配“键存在但值为空”）。

## systemd 部署（新增路径，未取代 Docker）

同一分支新增 `deploy/install-systemd.sh`、`deploy/personal-agent.service` 与 `deploy/README-systemd.md`，面向“主机已有 QQ bot 等容器”的共存场景；Docker 路径保持完整可用，本轮对它的改动只有显式卷名与内存上限说明的更正。

- 单实例：`flock --nonblock` 包住 `ExecStart`。
- 资源：`MemoryHigh=768M`、`MemoryMax=1G`、`TasksMax=64`，为 4 GB 主机上与其他服务共存收紧；单独使用可通过 `systemctl edit` 调高。
- 隔离：`ProtectSystem=strict` + `ReadWritePaths=/var/lib/personal-agent`、`ProtectHome=true`、`NoNewPrivileges=true`、`UMask=0077`。
- 配置位于 `/etc/personal-agent.env`（root 600），代码与数据目录分离。

## 待做

1. **阶段 E：真实联调仍阻塞。** 缺少测试 bot 的 `TELEGRAM_BOT_TOKEN`／`TELEGRAM_OWNER_ID`、受支持提供商的 `MODEL_PROVIDER`／`MODEL_ID`／API key 及联调授权。真实 Telegram 与真实模型路径、真实记忆文件、真实“发送已到达但确认丢失”窗口都还没有证据。
2. **阶段 F：Linux 部署验收仍阻塞。** 缺少 4 核／4 GB 目标主机。需补测 Node 版本与权限、单实例约束、SIGTERM 与 45 秒停止宽限期配合、强杀恢复、Linux 进程组取消、内存与磁盘峰值、日志脱敏、卷备份还原、容器内 bash 可用性。安装脚本只在容器内以 `systemctl` 桩验证过，未在真实 systemd 下启动 unit。
