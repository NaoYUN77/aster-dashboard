# 文档索引与阅读边界

新功能按各自的临时 spec 推进；配置与运行入口见 [README](../README.md)，仓库工程规则见 [CLAUDE.md](../CLAUDE.md)。历史任务中未纳入的功能，可以在新 spec 中定义并继续开发。

## 按功能的临时规格

spec 是临时规范，ADR 是按功能长期保留的决策历史。一个功能可以有多个 spec，分别覆盖该功能开发的一部分；这些 spec 都归属同一份该功能的 ADR。

新功能的 ADR 放在 `docs/adr/<feature-name>/` 子目录，目录名使用英文小写、单词以连字符分隔；spec 引用该目录下所属功能的 ADR。新建的跨功能仓库级 ADR 放在 `docs/adr/repository/`。本规则仅适用于新建 ADR；现有 ADR 保留在 `docs/adr/` 原位，内容和现有引用不因目录规则调整。

临时 spec 使用 `docs/spec-YYYYMMDD-<feature-name>.md`，`YYYYMMDD` 为开始该部分开发当天的日期，`<feature-name>` 使用英文小写、单词以连字符分隔，必要时加入本次开发部分以区分同一天的多个 spec。例如在 2026-10-30 开发计划任务的触发部分时，文件名可为 `docs/spec-20261030-scheduled-tasks-trigger.md`；这个示例不是已存在的任务或能力。跨日继续同一份 spec 的开发时保留原文件名。

每份 spec 只覆盖本次开发部分，写清用户目标、本次范围、相关接口与状态、副作用和授权、资源与失败恢复边界、实施步骤及可检查的验收条件。不把某次开发的排除项提升为全项目禁令。

引用关系以 ADR 为准：每份 spec 链接它所属的功能 ADR；ADR 按时间记录相关 spec 的文件名，以及各部分的决策、备选方案、取舍与代价和相关缺陷。spec 名称使用行内代码保留为历史标识，不要求是指向现存文件的链接；需要查看原文时可附 Git 提交引用。ADR 的命名与模板见 [ADR 约定](adr/README.md)。

ADR 持续记录该功能所有部分的取舍与缺陷，跨越各份 spec 的生命周期。缺陷记录包括表现、影响、处理状态和验证证据；尚未确认的原因或尚未完成的修复须明确标注，不能当作已有结论。

功能开发完成后删除临时 spec；已独立完成的部分也可先删除对应 spec。删除前，将仍需长期维护的配置、接口和运行说明更新到对应文档，将该部分的取舍、缺陷及必要验收证据归入所属 ADR 或由 ADR 引用。ADR 及其中的 spec 名称、决策与缺陷记录长期保留，不随 spec 删除；历史名称不算失效链接。其他指向被删除 spec 的文件链接须清理，当前文档改指所属 ADR。

仓库不维护总的 MVP 产品边界文档，不新增或恢复 `mvp.md`，也不在本索引重建一份总功能范围清单。

## 当前参考

| 文档 | 用途与权威范围 |
| --- | --- |
| [契约与生命周期](contracts-and-lifecycle.md) | 工具、权限、请求、执行恢复与投递契约，以及当前实现限制 |
| [Memory 与 Context 设计](memory-and-context-design.md) | 记忆架构与数据归属；模块实施结论按章节保留，验收状态链接到验收记录 |
| [工具与 MCP](mcp.md) | MCP 配置、工具发现、pin、授权与 OAuth 操作 |
| [ADR 索引](adr/README.md) | 已接受的工程取舍；正文中的早期范围描述是决策上下文 |
| [Web 提供商调研](web-search-provider-research.md) | Web 接入依据、适配契约及该任务的选型边界 |

## 运行与交付

- [部署指南](deployment-test-guide.md)：当前部署、备份、更新与上线验证。
- [远程工具执行](execution-remote.md)：阶段 1 的控制面／执行面分离、宿主 broker、SSH 基线与失败语义。
- [Phase 0 RPC 部署与验收](runbook-execution-rpc-phase0.md)：常驻 Execution Agent、私网 mTLS、证书、systemd、正向／负向验收与断线检查。
- [Phase 0 RPC 验收记录](acceptance/20261102-execution-rpc-phase0.md)：2026-11-02 真实双 VPS 的 PASS 证据、负向结果与网络变更边界。
- [Remote PTC Phase 1／2 Runbook](runbook-remote-ptc-phase1-2.md)：bwrap／cgroup 前提、direct／PTC 配置、实机正向与负向验收、证据与回滚。
- [代码调用工具](codemode.md)：可选的 PTC／codemode 配置、脚本工具白名单、输出边界与恢复语义。
- [一次性提醒](reminders.md)：`reminder_*` 工具、独立 SQLite 状态机、进程内调度、失败恢复与人工核查。
- [Langfuse Tracing](langfuse-tracing.md)：可选 Trace 的环境变量、隐私边界、部署与第一条真实 Trace 验收。
- [部署环境](deployment-environments.md)、[主机备份](host-backup.md)、[投递核查与补发](deliveries.md)：对应操作边界。
- [CI 运行入口](ci-entrypoint.md)：现行检查入口与发布材料契约。
- [CI/CD 设计与实施计划](ci-cd-implementation-plan.md)：当前工作流事实、后续交付设计和按日期保留的历史验收；任务待办不代表生产部署状态。

## 任务、调研与验收记录

| 文档 | 阅读边界 |
| --- | --- |
| [Memory 实施 issues](memory-implementation-issues.md) | MEM-01～08 的任务拆分与交接，不是新任务的领取顺序或全项目功能排除清单 |
| [Memory 验收](memory-verification.md) | 指定环境中的场景结果、缺陷与补测证据，不代替生产部署记录 |
| [工具注册调研](tool-registration-research.md) | 2026-10-22 的比较与分期建议；当前接入方式以 MCP 文档和有效 ADR 为准 |
| [早期 MVP 执行规划](mvp-execution-plan.md) | 2026-10-21 的历史执行步骤、原验收标准及范围，不作为新任务指令 |
| [早期 MVP 验收](mvp-verification.md) | 原阶段的环境与结果；其中的阻塞、测试数量和旧部署路径仅属于当时 |
| [早期代码审查修复规划](review-fix-plan.md) | 特定基线的 F1～F7 修复要求，任务范围限制不延伸到后续开发 |
| [早期 PR 正文草稿](pr-body.md) | F1～F7 当时的交付说明，不是当前待办或运行手册 |
| [历史 Docker 验证](docker-verification.md) | 2026-10-26 的镜像迁移证据，包含已移除的 Vault／router 拓扑 |
