# Aster 镜像迁移验证

> 阅读边界（2026-10-29）：本文是 2026-10-26 当天的本地验证记录，写明未连接生产数据、未部署目标服务器。文中的 Go、router、Vault、四个镜像，以及文末「托管 CI 已通过」描述的是当时的仓库，不是当前 `.github/workflows/ci.yml`。当前流水线和「是否已上线」以 [CI/CD 实施计划的当前事实](ci-cd-implementation-plan.md#当前事实) 与 [部署指南第 9 节](deployment-test-guide.md#9-上线判定与验证边界) 为准。本文不追加生产部署结论。

日期：2026-10-26。环境：Windows 11、Node.js 24.19.0、Go 1.25.6、Docker Desktop Linux engine、Compose 5.3.1。仅使用本地镜像、临时容器和临时卷，未连接生产数据或发布镜像，未部署目标服务器。

注：2026-10-28 起 Agent Vault 子系统与 egress router 已整体移除。本文是当日的验证记录，涉及 router、Vault 组合与 broker 的条目保留为历史事实，不再代表当前单服务拓扑。

## 已通过

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 类型检查通过 |
| `npm test` | 137/137，通过；这是 Windows 上的离线回归结果 |
| `npm run build` | 构建通过 |
| `go -C router test ./...`、`go -C router vet ./...` | 通过；包含私有 broker IP 接入及公共／元数据 IP 拒绝用例 |
| Linux router 二进制 | `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath` 成功，临时只读挂载到 Aster Linux 容器后 `version` 执行成功；不替代独立 router 镜像构建 |
| `docker build -t aster:local .` | 最终镜像构建通过，包含共享卷 `flock` 单实例锁 |
| Aster 运行环境 | uid 1000、`HOME=/data`、Bash、flock、Node 24.19.0、内存 SQLite 建表通过；不包含 tsx／TypeScript 开发依赖 |
| 镜像配置预检 | 无配置时返回退出码 1；以虚构 token／key、有效目录模型执行离线检查返回 0，不发网络请求 |
| 共享卷互斥 | 一个临时容器持有锁时，第二个容器使用同一临时卷取得锁失败，退出码 1；验证后已删除临时容器／卷 |
| Compose | 普通、普通＋build、Vault、Vault＋build、Vault＋router、Vault＋router＋两项 build 共六种组合通过 `config --no-env-resolution`；生产配置不含 build；router 覆盖后的应用只读取 `app.router.env`，共享网络命名空间，不发布 router 端口 |
| 网络脚本 | Linux `sh -n` 通过；以替身记录 iptables 调用，直接模式允许 uid 1000 到 broker，router 模式仅允许 uid 1001 到 broker，两模式 IPv4／IPv6 默认拒绝规则完整，非法模式失败 |

## 阻塞与待验收

- `aster-router:local` 与 `aster-network:local` 的首次 Docker 构建在下载基础镜像元数据阶段失败：`auth.docker.io` 连接超时。改用本机已有的同 digest 基础镜像后，两个镜像及完整拓扑已于 2026-10-27 本地通过；托管 runner 随后在无镜像替代的正常网络条件下构建同一 Dockerfile 并通过，见 [CI/CD 实施计划](ci-cd-implementation-plan.md)。
- `go test -race` 未能执行：当前 Windows Go 环境未启用 CGO。普通测试及 vet 已通过；Linux Go 1.25.6 容器与 GitHub 托管 runner 中 `go test -race ./...` 与 `go vet ./...` 均已通过，见 [CI/CD 实施计划](ci-cd-implementation-plan.md)。
- 未在 Linux 容器中执行全部 137 项 Node 测试。每日文件只读替换失败的测试假设存在平台差异，需要单独处理；该用例已改为真实临时路径冲突，Windows 与 Linux 均通过，Linux 全量 137/137 已在独立 Node 24.19.0 容器中执行。
- 未执行真实 Telegram、模型、Infisical、OAuth 和流式响应验收；未在 4 核／4 GB Linux 主机测量资源峰值。
- systemd 数据导入步骤已提供，但未操作真实服务器。切换前须停用旧实例并备份全部数据；不能因镜像改名而重建空状态。
- 没有应用就绪探针；容器运行或离线配置检查成功不等于真实业务已就绪。
- 本次未建立 GitHub Actions、发布镜像仓库或更改 GitHub 合并规则。PR CI 工作流现已加入仓库，并在托管 runner 上通过（Node、Go race/vet、四个最终镜像与 27 项容器验收），见 [CI/CD 实施计划](ci-cd-implementation-plan.md)；发布、签名与部署关卡仍待实现。
