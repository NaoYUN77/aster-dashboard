# Remote PTC Phase 1／2 自动化验收记录（2026-11-03）

- 状态：**自动化通过；静态复核修复了 5 个实现缺陷与 8 个 Runbook 缺陷；真实双 VPS 两轮 FAIL（cgroup 入组顺序、cgroup 委派位置与 bwrap 参数），修复后待复验**
- 分支：`feat/remote-ptc-sandbox-phase1`
- Phase 1 commit：`b82aaeb`
- Phase 2 commit：`4c304d1`
- PR：[#59](https://github.com/NaoYUN77/Aster/pull/59)
- 验收环境：Windows 11 + Node 24.19.0；POSIX-only 用例跳过
- 标准：[远程 PTC 与统一 RPC 执行通道 spec](../spec-20261102-remote-ptc-sandbox.md) 16.2／16.3

## 自动化基线

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | 0 |
| `npx tsx --test test/*.test.ts`（Windows 11，`71d94c1` 之前的 head） | 370 tests，356 pass，0 fail，14 skipped |
| 同一套件（Windows 11，含静态修复） | 374 tests，360 pass，0 fail，14 skipped |
| 同一套件（GitHub Actions Linux，`71d94c1`） | 371 tests，363 pass，0 fail，8 skipped（run `41583892171`） |
| 同一套件（GitHub Actions Linux，含静态修复，`dc5560e`） | 374 tests，366 pass，0 fail，8 skipped（run `41602806264`） |

Windows 的 14 个 skipped：8 个记忆库／部署文件权限类、Unix socket RPC、Windows 无法创建的符号链接用例、4 个依赖 `process.execve` 与 cgroup 的用例。Linux 上符号链接、Unix socket、远程 codemode 与 cgroup 入组用例实际执行并通过；剩余 8 个 skipped 是部署文件权限类用例，需要相应的宿主条件。涉及 bwrap／cgroup／user namespace／`/shared` 绑定和真实跨 VPS 的检查不在本机执行范围内。

## 真实双 VPS 首轮验收（2026-11-03，`63091e8`）：FAIL

- 环境：Ubuntu、systemd 259.5、bubblewrap 0.11.1、Node v24.19.0；私网 mTLS `EXECUTION_HOST:9443`；`PTC_ENABLED=1`、`PTC_DIRECT_ENABLED=1`、`PTC_ALLOW_DEGRADED=0`；cgroup 根 `/sys/fs/cgroup/aster-ptc`，两级 `subtree_control` 已开启 `+memory +pids +cpu`；`rpc-main --check` 通过，`health` 为 phase 2，isolation 为 bwrap／userns／cgroup v2／network none，preflight 全 `true`。
- Phase 1：首次 `vm.start` 失败，`code: internal`、`outcome: not_started`：`the sandbox process could not be accounted for: ENODEV: no such device, write`（修复前一个 head `0c83c33` 上为 `ESRCH`）。
- Phase 2：首次 direct `session.open` 失败：`the sandbox process could not be accounted for: EACCES: permission denied, write`。
- 归因：agent 在 bwrap 已 `--unshare-cgroup` 之后才把 PID 写入 session 的 `cgroup.procs`；目标 cgroup 在该任务的 cgroup namespace 之外，内核拒绝迁移。普通 `sleep` 可复现；`Delegate=yes`＋`DelegateSubgroup=agent` 因 “no internal process” 返回 `EBUSY`，不采用。
- systemd 侧同时确认：`ProtectSystem=strict` 下需要 `ProtectHome=false`、`ProtectKernelTunables=false`、`ProtectControlGroups=false`，否则 `/home/aster` 不可见或 cgroupfs 只读。
- 修复：先由 helper 把自身 PID 写入目标 cgroup，再 `execve` bwrap（PID／进程组／归属保留），入组确认后才让 sandbox 运行；失败即拒绝启动，不伪造成功。见 ADR-0020“cgroup 入组顺序修复”、Runbook 3.2／4.3。
- 结论：首轮不能判定通过；验收主机已恢复 Phase 0 状态，未改动防火墙、安全组、Docker、SSH broker、Tool Registry、Journal 或 QuickJS。修复后的 commit 需按 Runbook 重新执行 16.2／16.3 才算通过。

## 真实双 VPS 第二轮验收（2026-11-03，`415bb67`）：FAIL

- 环境：同首轮（Ubuntu、systemd 259.5、bubblewrap 0.11.1、Node v24.19.0）；cgroup 根仍是 `/sys/fs/cgroup/aster-ptc`，两级 `subtree_control` 由 root 开启；`rpc-main --check` 通过，`health.isolation` 为 bwrap／userns／cgroup v2／none。
- Phase 1：首次 `vm.start` 失败，`code: internal`、`outcome: not_started`：`the sandbox process could not be accounted for: EACCES: permission denied, write`。Phase 2：首次 direct `session.open` 同样失败。
- 归因 A：迁移顺序已正确（helper 先入组再 exec），但位置错误。内核在迁移任务时还要求写者拥有源与目标最近公共祖先的 `cgroup.procs` 权限；Agent 在 `system.slice/aster-rpc-agent.service`，目标在 `/sys/fs/cgroup/aster-ptc/<session>`，公共祖先是 root 拥有的 `/sys/fs/cgroup`（`0644`），因此 `EACCES`。Runbook 旧版的自迁移探针也复现失败（`sh: 1: echo: echo: I/O error`），而旧 `--check` 只建目录、写 `pids.max`，无法发现这一点。
- 归因 B（独立阻塞）：bubblewrap 0.11.1 不支持 `--no-new-privs`，`bwrap: Unknown option --no-new-privs`、exit 1；两个 argv 构造器都传了该参数，cgroup 修好后仍会在 bwrap 启动阶段失败。bwrap 在解析参数前自行设置 `PR_SET_NO_NEW_PRIVS`（0.11.1 源码第 2915 行），参数无效且多余。
- 修复：session cgroup 根迁到单元委派子树（`Delegate=yes`＋`DelegateSubgroup=agent`，默认 `<unit>/ptc`）；Agent 自己开启两级 `subtree_control`；`--check` 改为执行真实自迁移并把内核原因写进 `cgroupReason`；移除 `--no-new-privs` 并新增 `test/ptc-bwrap.test.ts` 固定隔离参数。见 ADR-0020“第二轮失败与 cgroup 委派模型修正”、Runbook 3.2／4.3。
- 结论：第二轮仍不能判定通过。修正后的 head 需按新 Runbook 重新执行 16.2／16.3；首轮与第二轮共用同一套验收记录，不重复记录已恢复的 Phase 0 证据。

## 静态复核修复（基于 `71d94c1` 的缺陷报告）

报告见外部审阅记录（BUG-1..BUG-6、RB-1..RB-8）。逐条核对后处理如下：

| 项 | 结论 | 修复与覆盖 |
| --- | --- | --- |
| BUG-1 帧 payload 错误断连 | 属实 | 解析器把“帧外壳合法、payload 非法”表示为请求级 `payloadError`，`RpcServer` 用原请求 id 应答并保留连接；只有外壳错误才关闭连接。`test/execution-rpc.test.ts` 覆盖分类，`test/direct-rpc.test.ts` 覆盖同一连接在负向用例后仍可用 |
| BUG-2 16 hex sessionId 被报成 `internal` | 属实，但错误发生在 `vm.start`／`spawnRunner` 的 cgroup 创建，不是 `session.open` | `openSession` 在带 `jobId` 时先校验 16 hex 并返回 `invalid_request`；`spawnRunner` 保留 `PtcHostError`，不再包成 `internal`。`test/ptc-rpc.test.ts` 覆盖 |
| BUG-3 根内绝对虚拟链接 `file.canonical` 返回 `not_found` | 属实 | 文件服务改为逐组件解析：同根内的绝对虚拟链接目标映射回宿主树，跨根或逃逸目标拒绝。`test/ptc-files.test.ts` 覆盖虚拟绝对链接、悬空链接与跨根链接 |
| BUG-4 `workspace_missing` 仍创建空 job 目录 | 属实 | 先校验既有 job 目录，不再无条件 `mkdir`；`workspaceReady: true` 且 workspace 缺失时直接失败。新增 `test/ptc-workspace.test.ts` |
| BUG-5 错误 `callId` 的 `vm.reply` 被静默接受 | 属实 | `RpcServer`（wire 契约）与 `PtcExecutor`（runner 状态）都只接受 VM 当前等待的调用；投递成功后只清除被消费的 id，避免清除同一 await 中新到达的下一次调用。`test/ptc-rpc.test.ts` 覆盖 |
| BUG-6 沙箱内 `hostname` 为空 | **未证实** | 报告中“fd 1 被关闭”的推断与代码不符：`executeLocalBash` 与 DirectExecutor 都用 `stdio: ["ignore","pipe","pipe"]`，入组 helper 只关闭 fd 3，没有路径关闭 fd 1；报告自身的证据也互相矛盾（直接 `hostname` 可用，重定向到文件为 0 字节）。根因未定位，未修改实现；Runbook 改用 `uname -n` 并把空身份判为失败，实机复验时单独记录 |

Runbook 同步修复（RB-1..RB-8）：PTC sessionId（含重放）改为独立 16 hex；`done.value` 先 `JSON.parse` 再处理；身份判据改用 `uname -n` 并断言非空；网络结果解析两层；客户端只回传 32 KiB 有界尾部；cgroup 探针加 `set -e`，失败不得打印成功标记；负向用例与 `file.canonical` 期望和实现对齐，并检查连接仍可用；§6.5 明确 `workspace_missing` 不重建 job 目录。

归因更正两条：BUG-2 的 `internal` 来自 `vm.start` 的 cgroup 创建路径，改在 `session.open` 校验才能真正给出 `invalid_request`；BUG-6 的 fd-1 假设不成立，保持“未证实”。

## Phase 1：远程 PTC

| 验收点 | 覆盖 |
| --- | --- |
| `vm.start` / `vm.message` / `vm.reply` 与嵌套 `tool.call` | `test/ptc-rpc.test.ts`：TLS loopback 上启动 VM、脚本内 bash 回调、输出事件与终态响应 |
| 控制面工具授权与 `NestedCallDoc` 绑定 | `test/ptc-control.test.ts`：嵌套任务输入解析、`callId` 来源、`OutputRef` 提交先于结果交付、失败映射 |
| Job／workspace／`OutputRef` 持久化 | `test/ptc-control.test.ts`：job 记录只创建一次、`OutputRef` 去重与淘汰、引用与字节自校验 |
| 文件工具在 PTC session 内执行 | `test/ptc-control.test.ts`、`test/ptc-files.test.ts`：`file.readText`／`file.write` 走 session，目录等不支持操作保持 `not_supported` |
| 大小／超时／重放边界 | `test/ptc-control.test.ts`：超限 timeout 在本地拒绝、输出 ref 提交失败按“可能已执行”失败 |

未在本机执行：bwrap／cgroup 实际隔离、`/proc/net/dev` 无网络、强杀后无遗留进程、`/shared` 挂载模式、真实跨 VPS 重放。这些需要 POSIX 执行主机与双 VPS 环境。

## Phase 2：direct bash 与文件原语

| 验收点 | 覆盖 |
| --- | --- |
| 直接 `bash` 走 RPC `execute` | `test/direct-rpc.test.ts`：TLS loopback 上 health 显示 phase 2、direct bash、文件工具与 `sharedMode: rw`；`execute` 流式输出与退出码 |
| 传输显式选择，无静默回退 | `test/execution-remote-env.test.ts`：`EXECUTION_REMOTE_TRANSPORT` 只接受 `ssh`／`rpc`；rpc 要求 `/shared` cwd；两种传输的配置形状互斥。`test/ptc-files.test.ts`：执行面未开放 direct session 时返回 `unknown`，不退回本地或 broker |
| session 生命周期 | `test/ptc-files.test.ts`：首次使用时打开一次、关闭后不再执行；被 TTL 清理后仅在 `not_found`＋`not_started` 时重建一次并重试 |
| 路径边界 | `test/ptc-files.test.ts`：`/workspace`、`/shared`、`/tmp` 之外的绝对路径、`..`、NUL、反斜杠、相对路径被拒绝；POSIX 上符号链接逃逸、悬空链接和 root 内链接均按预期处理 |
| `/shared` 只读／可写 | `test/ptc-files.test.ts`：只读根拒绝写；Phase 2 direct 环境要求可写并在 health 中声明 |
| 分块读取 | `test/ptc-files.test.ts`、`test/direct-rpc.test.ts`：`file.read` 返回 `bytesRead`／`nextOffset`／`eof`，客户端校验范围；`RemoteFileSystem` 把大读取拆成 ≤256 KiB 的帧 |
| 原子写入与上限 | `test/ptc-files.test.ts`：写入后目录只保留目标文件，失败不留临时文件；写 >2 MiB、读文本 >2 MiB 显式拒绝，超限在发送前拦截 |
| 句柄隔离 | `test/ptc-files.test.ts`：句柄只属于打开它的 session，关闭或跨 session 访问返回 `not_found` |
| 嵌套文件工具 | `test/ptc-control.test.ts`：PTC 环境把 `readText`／`write` 交给 session，虚拟路径跨线，主机路径不出现 |
| 协议边界 | `test/execution-rpc.test.ts`：Phase 0 agent 对 bash `execute` 与 `tool.call` 仍返回 `not_implemented`；非法 bash 载荷作为请求级 `payloadError` 分类（`invalid_request`／`permission_denied`），连接不因此关闭 |

## 未覆盖与下一步

1. 在 POSIX 执行主机运行 `npm test`，使符号链接与 Unix socket 用例实际执行。
2. 按 [Phase 1／2 Runbook](../runbook-remote-ptc-phase1-2.md) 的 16.2 检查执行 bwrap／cgroup／无网络／强杀验收，并记录 `cgroup="none"` 等降级实况。
3. 按同一 Runbook 的 16.3 检查在真实双 VPS 上验证 direct `bash`、`/shared` 读写一致性、断线后的未知结果记录与重放不重复执行。
4. 迁移验收通过前，生产可继续使用 `EXECUTION_REMOTE_TRANSPORT=ssh`；该模式不提供远程文件工具。
