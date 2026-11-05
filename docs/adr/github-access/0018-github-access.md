# ADR-0018：GitHub 官方托管 HTTP MCP 与 OpenBao 只读 PAT

- **状态**：Accepted（范围与架构决策已确认；实现、真实链路与部署尚未验收）
- **日期**：2026-11-01
- **功能**：github-access
- **范围确认**：Jay

## 上下文

Aster 基于 pi-durable / pi-mcp 1.3.0，在单台 4 核 CPU、4 GB 内存主机运行。需要读取 GitHub 仓库、issue、PR 与 CI，不新增模型循环。现有 MCP 已支持 Streamable HTTP static headers，省略 auth 时可使用静态 Bearer 凭据；应用出站经认证 MITM，代理按占位名与精确 host 从 OpenBao 取密钥并替换。

[ADR-0001](../0001-mcp-access-stdio-first-oauth-out-of-band.md) 规定生产 MCP 默认 stdio + token，OAuth 采用带外授权。该决策的驱动包括无头部署、可靠性、单人运维与秘密保管。GitHub 官方同时提供托管 HTTP MCP 和可固定版本的本地 server。HTTP + PAT 不涉及 OAuth 浏览器、回调、动态注册或 refresh，不能把 Notion OAuth token 服务的历史故障直接等同于 GitHub 静态 PAT 路径不可用。

Jay 已最终确认官方托管 HTTP + 细粒度 PAT、首期只读、允许未列出的公开仓、普通 github.com、无 Enterprise/SSO，并明确 remote gh 不同期。这些取舍已定，真实链路验收仍待实施。

## 决策驱动因素

- 复用现有 transport 与代理，减少小主机上的 GitHub 常驻进程、二进制供应链与发布维护。
- 无头部署不依赖交互 OAuth；真实 PAT 不进入 Aster 配置、环境、模型上下文或运行状态。
- 首期只读必须在身份、远端筛选、宿主工具和参数操作四层分别成立，不能依赖模型遵守提示。
- 托管服务不可固定本地版本，必须明确漂移检测、默认停用和持久化恢复的边界。

## 备选方案

| 方案 | 收益 | 代价与结论 |
| --- | --- | --- |
| 官方托管 HTTP + OpenBao 细粒度 PAT | 复用 pi-mcp HTTP，不新增本地 GitHub server 进程或二进制；PAT 适配无头环境 | 接受 GitHub 托管服务接收 PAT、网络依赖及实现更新不可本地回滚；采纳 |
| 官方固定版本 stdio 二进制 + 同一占位机制 | 符合 ADR-0001 默认，可固定 server release/校验和并保留旧实现 | 增加构建、供应链、进程与资源管理，还须验证 Go 的代理/CA/占位兼容；本次不采纳，也不自动回退 |
| OAuth / GitHub App | 可能适合其他身份与授权生命周期 | 本轮已确认细粒度 PAT，不引入额外授权或安装流程；不采纳 |
| remote gh 或弃用的 npm GitHub MCP | 可形成另一访问路径 | remote gh 不在同期范围，不能作为自动后备；不采用弃用 server 或运行期 npx 安装 |

4 GB 主机本身不证明 stdio 放不下，也不证明 HTTP 零开销；本次选择是减少本地组件与维护责任，没有虚构内存或性能比较数据。

## 决策

### 官方 HTTP 与凭据

使用 GitHub 官方 `https://api.githubcopilot.com/mcp/` 的 Streamable HTTP，通过宿主 static header 发送 `Authorization: Bearer __vault_GITHUB_MCP_TOKEN__`，不启用 OAuth provider。真实细粒度 PAT 存在 OpenBao `secret/aster/GITHUB_MCP_TOKEN` 的 `value` 字段，MITM 只允许在精确 `api.githubcopilot.com` 释放该占位符，不为本路线增加 `api.github.com` 或任何通配 host。

保留既有代理认证、CA 信任、应用无公网直连以及 OpenBao mTLS 隔离。占位映射只决定密钥能发往哪个 host，不提供仓库、路径或 MCP 操作授权。PAT 同时被 MITM 与 GitHub 官方托管 MCP 接收，这是明确接受的信任范围。

PAT 限定实际私有资源及必要 Read 权限，明确资源所有者、选仓、审批、期限与轮换责任；具体值在后续运维记录中填写，不在本 ADR 编造。允许读取未列出的公开仓，因此不实现绝对仓库允许清单。多个私有资源所有者超出单个细粒度 PAT 能力时另行决策，不自动增权或换身份。

### 首期操作边界

只读 repo / issue / PR / CI。CI 包含 workflow/run/job/check 状态与有界必要日志；不触发、重跑、取消或批准 Actions。不创建/修改 issue、评论、PR，不 merge，不写仓库、release、权限或 secrets。普通 github.com 以外的 Enterprise/SSO 不在本次接入范围；remote gh 不同期、不自动后备。

四层共同强制：

1. PAT 只授实际读取所需权限，不授 Actions Write 或其他写权限。
2. 官方 `X-MCP-Readonly: true` 与精确 `X-MCP-Tools` 缩小远端工具集合；不同时启用会相加扩展集合的 toolsets。
3. 宿主以精确原始身份/注册名允许清单约束注册、搜索、pin 和实际执行，未知工具默认拒绝，owner/嵌套/恢复路径也不能绕过。
4. 宿主校验 method/action、参数组合、分页、日志模式、资源预算；未知操作默认拒绝，无法可靠区分读写的工具不开放。

现有 pin 只改变常驻可见性，authz 只用于宿主定级，两者都不能替代允许清单。首期 GitHub 工具全部 deferred，经 tool_search 按需加载，无 GitHub pin；底座执行校验、加载账本和统一执行复核继续复用。声明与实际允许操作必须一致，外部内容和描述不成为可信指令。

### 托管漂移与恢复

保存独立、经人审阅的工具身份、完整声明与允许操作基线，不使用会被启动覆盖的 catalog 或仅含输入 schema 的 schemaHash 作为批准记录。无基线时默认停用；启动比较先于 catalog 覆盖和恢复调度。

首期每次 GitHub 业务调用前执行有界 tools/list 对账；收到变更信号时也停用待审。集合、schema、描述、输出声明或策略出现未批准变化，或发现不完整/对账失败，均阻断整个 GitHub 能力的后续业务调用。连接健康恢复不能自动解除漂移停用。接受对账的延迟与 API 成本，不增加后台无限轮询。

对账与业务调用之间仍有变化窗口，声明不变的远端语义变化也不可由此检测。托管端无法按本地镜像回滚，不能承诺保留旧远端实现或完全阻止漂移。

所有 MCP 调用继续遵循 [ADR-0008](../0008-unsafe-tool-replay.md) 的 `replay: unsafe`；只读不等于自动重放安全。未完成工作、尚未执行的旧参数与已加载声明在重新核准前须收敛或验证兼容。人审批准并确认空闲后经既有上下文边界发布新声明，同时处理 deferred 加载与 pin，保留历史记录。

## 对 ADR-0001 的局部例外

**仅 github-access 采用“官方托管 HTTP + 静态细粒度 PAT + OpenBao 占位”作为生产接入路线，形成对 ADR-0001 stdio 优先默认的局部例外。**

PAT 消除了本案浏览器、回调和 refresh 依赖；复用认证 MITM 与现有 HTTP transport，减少本地组件，满足无头运维与秘密保管的驱动。接受的额外风险是官方托管可用性、PAT 接收方增加以及无法本地固定/回滚远端实现；以四层只读和漂移停用降低暴露，但不承诺消除这些风险。

ADR-0001 继续为 Accepted，其 stdio + token 默认与 OAuth 带外授权规则对其他 MCP 保持有效。本次不改写其历史、不给整个仓库设定 HTTP 优先，也不据此重启 Notion 验证或改变其他 server。原 ADR 不作全局 Superseded 标记。

## 后果与后续

收益是无需新增 GitHub 本地 server 或远端 gh 身份，凭据进入现有 OpenBao 生命周期，GitHub 读取沿用统一工具发现、执行和持久化模型。公开仓读取与 PAT 私有资源授权被明确区分，不引入未被要求的绝对仓库限制。

接受的成本包括：依赖托管服务及网络；声明对账增加延迟与请求；必须新增现状尚缺失的宿主工具/操作允许清单、独立批准基线与恢复闸口；PAT 轮换、到期和审批仍由操作者负责。现有 300 秒缓存意味着 OpenBao 更新不是即时生效，紧急失效以 GitHub 撤销旧 PAT 为准。

失败必须区分宿主拒绝、远端业务 isError、PAT/代理认证、资源隐藏、限流、基础设施故障与结果未知。业务调用不自动重试或恢复重放；取消传递至实际 I/O，但不把本地等待结束解释为远端已停止。投递失败只重发已保存回复。日志不保留凭据、完整正文或 CI 日志，必要关联与安全诊断仍可追踪。

后续实现应按相关 spec 完成 allowlist、参数收窄、逐次对账、传输/结果预算与启动恢复接线，验证 OpenBao 精确 host 路径、只读范围、轮换/撤销、取消及目标主机容量。实施后更新 MCP/生命周期/部署长期文档并在本 ADR 追加验收证据，再按仓库约定删除完成部分的临时 spec。

如果托管链路、只读边界或漂移机制无法通过验收，暂停接入；不自动切换 stdio、remote gh、OAuth、其他 token 或更宽权限。需要改变路线时，在本功能 ADR 追加带日期的后续决定并重新定义验收。

## 分阶段决策与缺陷历史

### 2026-11-01：首期只读范围与 HTTP + PAT 路线定案

- 相关 spec：`docs/spec-20261101-github-access.md`（历史文件名；按临时 spec 生命周期保留/删除）。
- 决策与取舍：Jay 最终确认 HTTP + OpenBao 细粒度 PAT、普通 github.com、允许其他公开仓、repo/issue/PR/CI 只读及 remote gh 不同期；记录对 ADR-0001 的局部例外，接受托管服务与版本漂移成本。
- 现状差距：现有 `mcp.json.tools` 仅有 pin/authz，尚无强制工具允许清单；schemaHash 仅记录输入 schema；现有启动 catalog 同步与恢复顺序尚未加入独立批准闸口；运行期未实现 GitHub 专用声明对账。这些是待实现要求，不是已完成修复。
- 相关缺陷：尚未发现通过真实 GitHub 链路确认的接入缺陷；尚未实现或联调，不能视为“无缺陷验收通过”。
- 验证证据：本轮只读核对本地实现和公开官方文档，未读取真实 mcp.json/密钥，未连接带认证的 MCP、执行 GitHub 工具、测容量、运行代码测试或部署。只创建规格与 ADR，不 commit、push 或开 PR。
- 编号：当前主工作区编号至 0014；并行工作区已使用 0015～0017，扫描全仓工作区后选未占用的 0018。

## 依据

- [ADR-0001](../0001-mcp-access-stdio-first-oauth-out-of-band.md)、[ADR-0008](../0008-unsafe-tool-replay.md)、[ADR-0014](../0014-humans-register-tools.md)。
- [MCP 现行说明](../../mcp.md)、[工具契约与生命周期](../../contracts-and-lifecycle.md)、[OpenBao/MITM 说明](../../../deploy/openbao-mitm/README.md)。
- 2026-11-01 阅读的 GitHub 官方公开 [remote server 文档](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)、[配置指南](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md) 与 [README 工具列表](https://github.com/github/github-mcp-server/blob/main/README.md)。这些可变文档不代表真实托管服务已验通或版本已固定。
