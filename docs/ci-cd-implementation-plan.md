# Aster CI/CD 设计与实施计划

日期：2026-10-27（2026-10-28 更新：Agent Vault、CONNECT 路由与 broker 子系统已整体移除，部署改为受限环境变量；本文的设计章节与任务表已按单服务拓扑更新，含 vault／router／broker 的日期验收记录为当时事实，保留原文）。状态：实施中。

本文记录本次 CI/CD 的设计、任务与验收进度。运行命令以 `package.json` 和相应脚本为准；部署步骤见 [部署指南](deployment-test-guide.md)。本文的待办项不代表已实现或已获生产准入。

## 当前事实

以下句子描述 2026-10-29 在仓库里能核对的状态。下文按日期保存的 Vault、router、broker、Go job 和「18/18 拓扑」是当时的记录。它们不表示当前流水线仍在跑这些检查，也不表示已经上线。

- 运行拓扑是单个 `personal-agent` 服务（`docker-compose.yml`）。仓库里没有 `release.yml` 和 `deploy.yml`。
- `.github/workflows/ci.yml` 有两个 job：Node.js（`npm ci`、`check`、`test`、`build`）和最终镜像（构建、Linux 卷预检、只读 WAL、`scripts/ci/topology-on-docker-host.sh`）。2026-10-29 的 main 运行 [40826470475](https://github.com/NaoYUN77/Aster/actions/runs/40826470475) 成功。Node job 为 235 项、227 过、0 失败、8 跳过；这 8 项在镜像 job 里另有 root 或 Docker 开关下的覆盖。拓扑日志为 6 项通过，并写明 **NOT COVERED: live Telegram/model business flow**。
- `npm run release:preflight` 成功时仍输出 `productionAdmission: "not-evaluated"`。本文件不是生产部署记录。脱敏上线记录的空位在 [部署指南第 9 节](deployment-test-guide.md#9-上线判定与验证边界)。

记忆验收在腾讯云 4 核机器上做过测试补测，见 [记忆系统验收](memory-verification.md)。那次记录不能代替上面的部署记录。

## 目标与交付边界

交付单位是一组已验收的镜像与 Compose。CI 验证代码、最终运行镜像与密钥边界；发布绑定受测产物的 digest；部署验证真实环境条件。生产密钥只留在部署环境，普通 PR 不接触真实 Telegram 或模型凭据。

当前优先交付完整 Compose 验收与 PR CI。镜像发布、签名、远端设置和生产部署须在相应关卡具备证据后接入；本次本地实施不等于已经执行发布或部署。

## 工作流与权限

| 文件 | 触发 | 职责 | 权限 |
| --- | --- | --- | --- |
| `.github/workflows/ci.yml` | PR、main 提交、手动 | Linux Node 检查，最终镜像与部署验收 | contents read；无真实凭据，无发布权限 |
| `.github/workflows/release.yml`（待实现） | 指定 main 提交或版本 tag | 构建并验收待发布产物，SBOM、扫描、签名与发布清单 | 发布 job 才获得 packages write / id-token write |
| `.github/workflows/deploy.yml`（待实现） | 初期手动选择发布版本 | 验签、目标机预检、单实例更新及业务检查 | 受保护部署环境，仅部署所需权限 |

Actions 固定完整 commit SHA。PR 不通过 `pull_request_target` 携带秘密执行贡献者代码。没有完整准入结果时，基础 CI 成功只能说明其实际覆盖的检查成功。

## 最终镜像与架构验收

下面是设计目标，不是当前 `ci.yml` 的覆盖范围。现行检查见上文「当前事实」：单服务 6 项，不含 Telegram→模型业务链。

验收链路为：最终应用镜像 → 模拟 Telegram／模型／工具 API（fixture）。

运行镜像中的正式 `main.js`、实际协议客户端与 pi-durable。通过临时 DNS 和测试 CA 指向 fixture；不增加生产任意 endpoint 或关闭 TLS 的测试开关。模拟服务实现所需协议和流式响应，不替换正式业务入口。

测试 Compose 必须保留生产 UID 与只读挂载边界，只替换 fixture、CA、虚构凭据和临时资源。生产 Compose 使用显式卷名，CI 必须覆盖成每次运行独立的卷，不能仅改 project name。清理只操作本次创建的资源。

| 验收面 | 通过标准 |
| --- | --- |
| 正常业务 | Telegram 接收 → 模型流式响应 → 回复投递，状态持久化 |
| 恢复 | 明确同步点中断并重启，复用执行和已保存回复；未知投递遵守现有契约 |
| 单实例与关闭 | 同卷第二实例被拒绝；SIGTERM 关闭；强杀后恢复 |
| 日志 | 上游错误夹带秘密时，容器日志与 API 无秘密 |
| 镜像及挂载 | 镜像层与发布材料不含秘密 |

每轮生成虚构随机秘密，检查原值及常见编码。允许目标接收认证值；应用输出、日志及产物不允许。诊断先扫描再输出，不无条件上传容器日志、数据库或环境。保留测试失败状态，不能将“检测到了泄露”计为生产验收通过。

Linux 文件系统失败测试应触发真实失败并断言旧文件完整和重试行为；修正 `chmod 0444` 可以阻止 Linux rename 的错误假设，不跳过用例。

## 发布产物

构建最终镜像 → 验收同一批镜像 → 完整镜像 SBOM 与漏洞扫描 → 发布同一产物 → digest 签名 → 签名发布清单。验收后不重新构建另一批镜像。

清单关联应用镜像 digest、源码 commit 与 Compose 摘要及验收证据。上游镜像验证预期发布身份；受审构建验证本仓库 release workflow 身份。签名／扫描工具失败不跳过，漏洞例外明确范围和期限。初期只发布实际验收过的 linux/amd64，其他架构需补运行证据。

## 部署环境预检与更新

CI 无法证明生产机器身份和旧数据卷状态。目标机预检只返回状态或受限错误码，不导出秘密：

- 核对真实机器身份仅对指定项目、环境、路径静态读取，包含引用展开边界。拒绝写入、兄弟路径、其他环境和未使用动态租约的验证在专用测试项目进行。
- 核对实际卷权限、备份与被批准配置匹配。
- 使用独立测试 bot 做真实服务联调，记录目标机资源使用；单台 4c/4g 不同时启动两个实例消费同一 bot。

验证签名清单 → 预检 → 停止并备份持久化状态 → 更新服务 → 业务验收。容器 running、离线配置检查均不能单独证明业务就绪。

离线绑定预检 `npm run release:preflight` 已实现：严格校验版本化清单，核对预期 commit、应用镜像的 `repository@sha256` 引用、一份 Compose 与调用者显式选择的策略文件的原始字节摘要。它只证明本次读取的材料一致，不验签、不扫描、不检查策略内容或目标环境；成功输出固定标注 `productionAdmission: "not-evaluated"`，不能作为部署授权。契约见 [CI 运行入口](ci-entrypoint.md#离线发布清单绑定预检ci-07-基础)。单服务拓扑的决定见 [ADR-0005](adr/0005-remove-agent-vault-single-service.md)。

回滚需区分镜像与数据兼容性；失败可以停止推进，不能自动恢复旧数据库备份冒充无损回滚。

## 同机测试与生产隔离

`test` 与 `production` 共用一份业务 Compose，由各自的版本化环境描述区分项目名、应用卷与 bot 身份。描述只含标识与资源名，不含凭据。`npm run deployment:environment` 提供渲染核对、只读宿主资源冲突检查与跨环境重叠检查，失败码固定且不回显路径或值。字段与用法见 [部署环境描述](deployment-environments.md)。

已实现的是配置与离线／只读检查；测试实例启停／重置、合成生产哨兵演练、两环境真实 Linux 并行证据与真实 bot 身份核对尚未实现，不能把渲染通过当作隔离已验收。

## 实施任务与进度

| 编号 | 交付 | 完成条件 | 状态 |
| --- | --- | --- | --- |
| CI-01 | 方案保存、来源及验收边界 | 本文、README 入口 | 已完成 |
| CI-03 | Linux 基础 CI | Node check/test/build，文件失败测试修正 | 已完成（本地与托管均通过） |
| CI-04 | 完整最终镜像拓扑 | 临时资源、业务链路、恢复用例 | 历史：多服务拓扑 18/18（托管运行 40493637513）。当前 `ci.yml` 只跑单服务 6 项检查，不含 Telegram→模型业务链。不要把 18/18 当成现行 CI 或上线证据 |
| CI-06 | 发布与供应链验证 | 同产物扫描、签名、发布清单 | 待实现 |
| CI-07 | 部署预检与 CD | 真实最小权限、卷保护、备份更新与业务检查 | 离线发布绑定、卷元数据预检及整卷备份已实现；本地演练与目标机准备见下文，真实准入与 CD 待实现 |

验收记录随实施追加在相应任务下，明确本地执行结果、Linux/GitHub 执行情况和剩余阻塞。

### 2026-10-27 第一阶段记录

- 已增加 `.github/workflows/ci.yml` 的 Node、Go 与最终镜像验收 jobs，工作流仅 `contents: read`，checkout 不持久化凭据。Action 版本固定完整 SHA，`actionlint v1.7.12` 校验通过；尚未推送或触发 GitHub 托管执行。
- 文件失败测试改用真实临时路径冲突，Windows 和 Linux 的 memory daily 用例均 7/7 通过。Linux Node 24.19.0 独立临时容器中 `npm ci`、`npm run check`、137/137 测试、`npm run build` 通过；精简镜像第一次因缺 OpenSSL 为 136/137，安装测试所需 OpenSSL 后全量通过。验证容器未挂载生产目录或卷。
- Linux Go 1.25.6 独立临时容器中 `go test -race ./...` 和 `go vet ./...` 通过。
- `npm run test:vault-security` 使用临时断网 fixture、每轮随机合成秘密与内存数据卷，涵盖正常 HTTPS 同步、管理权限、上游错误、重定向及 TLS。受审镜像 `aster-vault:ci` 16/16 通过。以原始 `0.40.0` 作反向验证时，正常同步通过，错误日志检查如预期失败，退出 1；这次预期失败证明该旧镜像被阻断，不是生产验收通过。
- Compose broker 默认改为 `ASTER_VAULT_IMAGE`／`aster-vault:local`，避免默认继续使用已确认存在问题的上游 tag。受审构建位于 `deploy/agent-vault/broker/`，固定上游 commit、SDK commit、Go 归档与运行基底 digest；构建阶段执行客户端安全测试，失败即中止。
- 完整拓扑脚本已增加 `npm run test:topology`。`npm run test:topology -- --render-only` 本地通过，验证独立卷、无生产 private 挂载、无发布端口、正式 app/router 入口及 UID／只读／capabilities 边界。
- 本机完成四个最终镜像构建后，完整拓扑运行验收 11/11 通过：Compose 隔离与生产边界、最终镜像存在、临时 CA、broker HTTPS 同步与 proxy 权限（含匿名 401、proxy reveal／改规则／建外部 vault 均 403、隧道内未知主机 403）、最终 `main.js` 的 Telegram 接收→模型流式响应→回复投递与持久化、同命名空间 uid 0 网络正控、uid 1000 防火墙拒绝与 CONNECT 允许、同卷第二实例 flock 拒绝、SIGTERM 与 SIGKILL 重启不重放已完成请求、容器日志无合成凭据。
- 本机构建 `aster-router:ci` 与 `aster-network:ci` 时，Docker Hub 匿名 token 服务连接超时。改用本地已有的同 digest 基础镜像（`debian:bookworm-slim`、`alpine:3.24.1@sha256:28bd5fe8…`）后构建成功；仓库 Dockerfile 的固定引用未改动，因此产物与固定基础镜像一致，但这只说明本机取镜像路径受限，不代表托管 runner 的网络条件已验收。
- 拓扑脚本修正了两处验收层错误：CONNECT 隧道由 broker 用自签发 CA 终结，未匹配主机策略在隧道内判定，原先对 CONNECT 响应断言 403 属错误层级；fixture 控制请求需要显式 JSON Content-Type。诊断只输出步骤名，不输出容器日志、环境或断言值。
- 本阶段脚本只覆盖完成请求的重启去重；后续执行中／投递中崩溃验收见补充记录。IPv6 无可达正控时不计为已覆盖；API 方法与路径限制、凭据回显预防归 CI-05。未完成的安全关卡不以基础测试成功替代。

### 2026-10-27 托管执行记录

- `ci.yml` 已推送到 `feat/memory-archive` 并由 PR 触发托管执行。运行 40376404907 三个 job 全部通过：Node.js（`npm ci`、`check`、137/137 测试、`build`）、Go router（`go test -race ./...`、`go vet ./...`，补齐了本机 Windows 无 CGO 的缺口）、Final images and credential boundaries（受审 broker 构建含构建期客户端测试、16/16 密钥边界回归、三个正式镜像构建、11/11 完整拓扑）。
- 托管 runner 上的实际检查输出为 `Vault image regression passed: 16 checks` 与 `Topology acceptance passed: 11 checks`，与本机结果一致；因此四个最终镜像在托管 runner 上同样构建成功，先前记录的取镜像受限只是本机网络条件。
- 托管执行暴露了一个本机无法复现的缺陷：fixture 容器以 root 加 `--cap-drop ALL` 运行，没有 `CAP_DAC_OVERRIDE`，而 `openssl` 以调用者身份写出 0600 的 `key.pem`；runner 上调用者既非 root 也不在文件组内，读失败导致 fixture 退出 21。Windows bind mount 不保留真实 mode，所以本机一直通过。修复方式是在 fixture 启动前把合成 `key.pem` 放宽到 0644（与 `ca.pem` 一致），不为此给 fixture 容器增加特权；本机用 1001 属主的 0600 key 复现了退出 21，改权限后恢复正常。
- 诊断仍只输出固定标识。fixture 自身的启动失败改为固定退出码（20 凭据、21 key、22 证书、23 监听、24 未捕获），编排脚本据此报告失败类别，不输出容器 stderr、日志、环境或断言值。拓扑 fixture 以 `user: "0:0"` 运行并显式保留 `DAC_OVERRIDE`，不存在同一问题，未改动。
- 本次托管执行不发布镜像、不签名、不部署，也没有使用真实 Infisical、Telegram 或模型凭据。`release.yml` 与 `deploy.yml` 仍未实现；该次运行早于 CI-05 策略实施，后续进度见下方各节。

### 2026-10-27 执行中与投递中崩溃验收补充

- 修改范围为三个 `scripts/ci/*topology*.mjs` 和本验收记录。沿用正式最终镜像入口、UID／只读／capabilities、实际 grammY 与模型协议、router、broker 及持久化数据卷；不向生产代码加入 endpoint、故障注入或测试开关。所有身份、token、CA 均为临时合成数据，不读取生产 private 文件。broker 的测试挂载显式覆盖为隔离数据卷和测试 CA，避免继承生产 private 挂载。
- 执行中：fixture 通过真实模型流返回 `bash` 工具调用，向数据卷追加一次 `completed` 标记；收到携带该工具结果的后续模型请求时进入屏障，尚不返回模型响应。探针确认请求仍为 `pending`、无回复／投递、消费位置已保存和标记只有一行，再 SIGKILL。停止状态下复查持久化窗口，释放屏障、重放同一 Telegram update 并启动原容器。恢复后模型调用恰为 3 次（工具调用、中断请求、恢复请求），标记仍仅一行，原 requestId 只有一条 inbox，回复送达一次，无 failure 记录。
- 投递中：回复为三个分段。第一段确认保存；fixture 接收第二段后记录外部送达、阻塞确认响应。探针确认 `sent / sending / pending` 及完整已保存回复后 SIGKILL，并在停止状态复查。重启且重放同一 update 后得到 `sent / uncertain(PROCESS_INTERRUPTED) / pending`，模型调用仍为一次、上游发送仍为两次。停止应用，通过最终镜像内正式 `deliveries.js list` 核查，仅对第二段执行 `sent`；再次启动只发送第三段，最终三段均 sent，无自动重发已确认段或未知段。人工确认不伪造 Telegram message ID。
- 屏障由 fixture 明确上报并由编排器释放；轮询仅等待状态，不用固定 sleep 猜测强杀时刻。失败只打印步骤、固定错误类别及代码行号，不输出 API 正文、断言值或凭据。退出保留失败结果，并清理本次项目容器、网络、卷与临时目录。
- 本地验证：三个脚本 `node --check` 通过；加入两个崩溃场景后的完整拓扑实际运行 **13/13 通过**，包括容器日志合成凭据扫描。复用本机已有 `aster:ci`、`aster-router:ci`、`aster-network:ci`、`aster-vault:ci`，未重建 broker。上述结果不包含同时实施的 CI-05 策略，也不代表托管 CI 已运行新增场景。
- 随后加入 IPv6 ULA 双栈测试网及真实监听端口，在同一最终 app 容器分别以 uid 0 做可达正控、uid 1000 做拒绝断言。Compose render-only 通过；运行时 uid 0 正控超时，整次拓扑退出 1，uid 1000 不计为通过。恢复检查移到 IPv6 前后重跑，两项崩溃场景再次通过；当时 IPv6 仍阻塞，后续修复与复验见下一节。公网 IPv6、IPv6 DNS 正控和执行中 unsafe 工具的最终镜像重放仍未覆盖。

### 2026-10-27 拓扑整合与 IPv6 修复

- 确认 IPv6 正控超时由 INPUT 丢弃邻居发现报文引起：目标邻居状态为 FAILED，而无防火墙对照可达。`network.sh` 仅放行 code 0、hop limit 255 的邻居请求与通告，保留其他入站拒绝与 uid 出站限制。独立容器验证单 vault 和 router 模式的 uid 0 正控与 uid 1000／1001 拒绝，并验证 IPv4／IPv6 入站 TCP 被拒绝。
- 使用重建的应用、router、network 镜像及 `aster-vault:ci05`，为 broker 挂载隔离的合成策略，完整拓扑 **16/16 本地通过**：含两 vault CONNECT/TLS 操作正反例及上游计数、真实业务、执行／投递中断恢复、IPv6 可达正控和 uid 限制、入站 TCP 拒绝以及日志凭据扫描。没有使用生产凭据或卷；该次运行尚无托管证据，见下方推送后的运行记录。公网 IPv6、IPv6 DNS 和获准接口的凭据回显防护仍未覆盖。
- 最终 broker 构建 `aster-vault:mitm-reviewed-20261027` 通过：构建期 Infisical 回归、适配新策略后的 MITM 全包（56 PASS／8 显式 SKIP／0 FAIL）与 `go vet`。8 项跳过为 6 个 WebSocket 入口（含两个需真实密钥的集成）、普通 HTTP WebSocket 和 IPv6 转发成功用例，新策略禁止这些成功路径；对应入口的拒绝由 `TestReviewedAPI*` 在真实 CONNECT/TLS 下验证，跳过项不计为通过。该镜像的 `vault-security` **21/21** 通过；以它运行完整拓扑再次 **16/16** 通过，退出码 0，容器、卷、网络及临时目录已清理。旧 `aster-vault:ci` 标签未更新；CI 工作流构建的是当前源码，托管结果见下一条。
- 推送后的托管运行 40457199779 三个 job 全部通过：Node（检查、148 项测试、构建）、Go（`go test -race`、`go vet`）、最终镜像与凭据边界（受审 broker 构建含 MITM 全包、`Vault image regression passed: 21 checks`、四个镜像构建、`Topology acceptance passed: 16 checks`），与本机结果一致。
- 托管 runner 暴露两处本机无法复现的 Compose 渲染差异：其版本在 `config --format json` 中省略 `bind.create_host_path: false`（仍保留空 `bind` 对象）。断言因此改为仅在渲染器显式报告 `true` 时失败；策略源文件在渲染前已写入，挂载本身未变。两次失败运行保留在历史中，不作为通过证据。
- 记录上述结果的提交 9a4b098 再次触发托管运行 40457892602，三个 job 全部通过，仍为 148 项 Node 测试、`Vault image regression passed: 21 checks` 与 `Topology acceptance passed: 16 checks`。

### 2026-10-27 CI-05 可验证第一阶段

- `deploy/agent-vault/broker/api_policy.go.in` 中的 Go YAML 类型与严格加载器为唯一策略 schema：`version: 1`、`rules`，规则精确绑定认证后的 vault、DNS host:port、method 与注入前 path。拒绝未知／重复字段、重复规则、多文档、通配符、非规范路径与超限输入。未配置或空规则默认拒绝；显式配置文件缺失／不可读／无效时启动失败。
- 补丁在正式 `cmd/server.go` 加载策略快照，在 MITM `forwardRequest` 的凭据读取、替换、请求正文读取及上游 I/O 前逐次判定。单 vault 直连与多 vault router 复用该入口，不能靠改变客户端 hint 获得其他 vault 的规则。普通 HTTP、升级及常用 method/path override header 被拒绝。Compose 给 broker 只读挂载 `private/api-policy.yaml`，不自动创建缺失源路径；示例、运行说明与凭据注入 selector 的职责已区分。
- 使用独立标签 `aster-vault:ci05` 完成本机构建，保留原 `aster-vault:ci` 供另一拓扑任务使用。构建的 Infisical 测试、真实 CONNECT/TLS 的 `TestReviewedAPI*` 及 MITM `go vet` 通过。操作正反覆盖允许的模型与 Telegram placeholder、错误方法、同域导出／token／echo 路径、百分号与双重编码、点段／斜线变体、override、upgrade、错误目标／端口、跨 vault 及 tunnel 复用；拒绝检查凭据解析和上游访问计数不变。上游旧 MITM 测试随后已适配新策略，见上一节最终构建记录。
- `$env:VAULT_CI_IMAGE='aster-vault:ci05'; npm run test:vault-security` **21/21 本地通过**，包括真实最终镜像中单 vault 与多 vault agent hint 的允许／拒绝和上游访问计数、未配置／空规则默认拒绝、配置文件缺失／无效启动失败，以及原有 16 项取密、权限、日志、重定向与 TLS 回归。`npm run check`、三个 vault 脚本 `node --check` 和 `git diff --check` 通过。此处记录的是当时的本机结果；托管证据见上一节的运行 40457199779。
- 本阶段不约束获准路径的 query/body 参数语义、不检查或过滤响应，不承诺阻止获准接口回显认证值、派生 token 或任意编码。凭据回显仍是 CI-05 与生产准入阻塞；示例不是所有模型与工具接口的审核清单。真实服务联调、发布绑定与部署准入仍需后续完成。

### 2026-10-27 CI-07 主机准备与离线备份

- 新增 `scripts/deploy/` 的 Ubuntu Docker 安装、只读主机基线与停止写入后的整卷备份入口，用法见该目录 README。目标机 SSH 和只读检查成功：Ubuntu 26.04 LTS、x86_64、4 核、内存 8,053,121,024 字节、基线检查时根分区可用 171,026,588 KiB。未发现被检查的旧服务和常见目录；未递归检查全部主机数据。官方 Docker 下载站连接曾被重置，首轮远程 apt 操作曾被自动审批拒绝，后续经 Ubuntu 签名软件源安装成功。实际 Engine 29.1.3、Compose 2.40.3+ds1-0ubuntu1，Docker 服务 enabled／active；目标机脚本已返回 `host-baseline-ok`，当时没有容器和数据卷。没有把本地 Docker 验收当成目标机业务验收。
- 应用镜像新增 `deployment-volume-preflight.js`，只读检查固定版本 broker 的包装元数据、明文 DEK 缺失、选定文件 UID／权限及有界 inbox 诊断。须停写并只读挂载现有卷；不运行迁移、恢复或 checkpoint，不解密，不证明密码正确／密文有效，不做全卷或 ACL 审计。存在 sending／uncertain／failed 时只统计，不阻止保存状态或擅自重试。
- broker 镜像预建 `.agent-vault/` 从 0755 收紧至 0700，解决上游 MkdirAll 不收紧已有目录的问题；旧卷保持原状并由预检显式拒绝不安全权限。持久化格式未改动。重建 `aster-vault:ci07` 后，原有客户端／MITM 构建期测试及镜像安全回归 **21/21** 通过。
- 整卷备份只接受已存在的普通 local 卷、不可变本地镜像引用和私有备份目录，检查无活跃消费者并做只读元数据预检；归档流式写入宿主，保留隐藏文件、SQLite sidecar 和数值属主。校验条目、SHA256、再次检查无写入后才生成 COMPLETE；失败保留部分目录，无自动还原或数据库降级。宿主 private 配置另行备份；工具锁不阻止其他 Docker 管理员并发启动服务。
- `npm run check`、`npm run build` 和主机 `npm test` 通过：160 项中 149 PASS、11 显式 SKIP（Windows 无 POSIX UID 语义的 10 项与需独立 Docker 编排的 1 项），不把跳过计为通过。Linux 容器下的卷预检用例 **11 PASS、1 显式 SKIP**（另一个需 Docker 编排的用例），独立运行后者 **1/1 PASS**：SIGKILL 后合法 WAL 能读，明文 DEK 仅在 WAL 中时同样拒绝，检查前后源文件字节／权限／属主／mtime 与目录项不变。
- 最终应用 `aster:ci07`、broker `aster-vault:ci07`、既有 router/network 最终镜像的完整拓扑 **18/18 本地通过**。新增停止写入后真实业务卷的预检、整卷备份、还原到独立空卷、归档比较和活跃消费者拒绝；重建 app/router/tool-network 后请求及已完成工具未重放、分段投递与 uid 防火墙仍有效。首轮因遗漏停止 tool-network 导致未替换而失败，第二轮因复用旧 checkpoint 预期失败，修正后全量复验通过。演练仅为同版本重建，不证明跨版本升级／降级兼容性。
- 新增 `scripts/ci/topology-on-docker-host.sh`：以预先构建的临时运维镜像运行同一组拓扑检查，宿主无需 Node／Go／OpenSSL，目标运行期间不拉取或构建镜像。运维镜像补入固定来源的 Compose CLI；拓扑入口可复用调用者提供的运维镜像。完整入口已在本地 Linux Docker 环境再次运行 **18/18 通过**，包括嵌套运维、相同绝对路径 bind、退出清理；这是本地结果。目标机临时目录创建被自动审批以缺少远程写授权为由拒绝，尚未上传镜像或运行目标机业务演练。
- 独立检查发现 Docker 会在首次挂载空命名卷时从镜像复制内容，即使挂载只读。所有备份／预检来源挂载增加 `volume-nocopy`。专项实测以含合成标记的镜像作正控，确认普通只读挂载会复制；备份使用修复后挂载时拒绝空源卷且两个源卷仍为空。该专项和拓扑演练的临时容器／卷均已清理。
- 工作流已接入 Linux 卷权限、只读 WAL 回归及 Docker 主机完整演练入口。首轮推送 `86908a6` 的托管运行 [40492198704](https://github.com/NaoYUN77/Aster/actions/runs/40492198704) 中 Node、Go、broker 21 项回归、Linux 卷预检 11 PASS／1 显式 SKIP，以及独立 WAL 1/1 均通过；完整拓扑因外层运维容器使用 UID 0 且移除能力，无法访问非 root runner 创建的 0700 临时目录，在 `mkdtemp` 处报 EACCES。入口改为复用调用者 UID／GID、补入 socket 组 ID，并把 HOME 放入同一私有可写目录，不放宽目录权限。修正后以本地 Linux UID 1001／GID 1001、socket 补充组运行完整入口，**18/18 通过**；完整托管结果待修正后复验。
- CI-06、真实身份权限和 API 响应边界、目标机业务联调、签名交付与生产 CD 仍未完成；所有预检结果保留 `productionAdmission: "not-evaluated"`。

### 2026-10-27 阶段 A 配置与校验基础（PR A1）

- 新增版本化环境描述（`aster.deployment-environment` v1）与 `npm run deployment:environment`（`render`／`router`／`host`／`compare`）。描述是项目名、卷、网络名／网段、broker 地址、管理端口与私有目录的唯一权威；Compose、`network.sh` 与 router 上游都从同一组值派生。
- `docker-compose.agent-vault.yml` 的宿主可见资源改为 `ASTER_*` 插值，默认值保持现有生产部署不变；broker 管理端口默认改为不发布到宿主，需要宿主访问时叠加新的 `docker-compose.management-loopback.yml`，只绑定 `127.0.0.1`。`network.sh` 在使用 `iptables` 前校验 broker 地址与端口；router 目录随私有目录参数化。
- `render` 用描述派生插值后重新解析 `docker compose config --format json`，逐项核对项目、卷、网络、broker 地址、管理端口、私有文件确切挂载与 UID／只读／capabilities 边界；`host` 只读查询 Docker 报告项目、卷、网络与端口冲突。全部失败只返回固定码，不回显路径或渲染值。
- 本机（Windows + Docker Desktop linux/amd64）`npm run check`、`npm run build` 通过；`npm test` 168 项中 157 PASS、11 显式 SKIP（与既有 POSIX／Docker 编排用例相同）；`npm run test:topology -- --render-only` 通过，完整拓扑 18/18 通过。新增 8 项环境测试包含真实 Compose 渲染与篡改拒绝，未使用真实凭据、私有配置或生产卷。
- 首轮托管运行在启动 `agent-vault` 时报 `conflicting options: port exposing and the container type network mode`：`expose` 与共享另一服务网络命名空间不能并存。该端口在共享命名空间内本已可达，删除这条 `expose` 后本机完整拓扑复验 18/18 通过。
- Stage A 验收 review 提出三项检查缺口，已在本 PR 内补齐：管理端口回环 override 现在要求 broker 恰好一条映射（单条错误端口与双条目都被拒绝，单条错误端口此前会抛 TypeError 而非返回固定码）；渲染核对新增断言 `tool-network` 收到的 `ASTER_BROKER_PORT` 等于拓扑常量 14322；`privateFiles` 删除 `vaultEnv`／`appEnv`／`appRouterEnv` 三个无法核对的字段（Compose 渲染会把 `env_file` 内联并丢弃路径），env 文件名改为模板常量 `vault.env`／`app.env`／`app.router.env`，描述仍携带渲染结果可核对的策略、CA、owner 文件与 router 目录。
- 尚未实现：测试实例启停／重置、合成生产哨兵隔离演练、两环境真实 Linux 并行运行证据、真实 bot／Infisical 身份与凭据作用域核对。阶段 A 与 issue #18 均未完成；本记录不代表生产准入。
