# 架构决策记录（ADR）

本目录保存决策及相关缺陷记录：选了什么、放弃了什么、代价是什么，以及相关缺陷的表现、影响、处理状态与验证证据。部署步骤、接口契约和完整验收记录放在 `docs/` 的其他文件里，ADR 引用相应证据。

新功能 ADR 放在 `docs/adr/<feature-name>/`，新建的跨功能仓库级 ADR 放在 `docs/adr/repository/`，子目录名使用英文小写连字符；现有 ADR 保留在根目录原位，内容与引用不因本规则改变，详见 [目录约定](../README.md#按功能的临时规格)。

每个功能长期保留一份 ADR，持续记录该功能所有部分的决策、取舍与相关缺陷。一个功能可以有多个临时 spec，每份只覆盖部分开发工作，并链接同一份功能 ADR。ADR 按时间记录相关 spec 名称及对应的取舍、缺陷；命名与收尾规则见 [临时 spec 约定](../README.md#按功能的临时规格)。

spec 在功能开发完成后删除，ADR 及其记录长期保留。ADR 中的 spec 文件名用行内代码作为历史标识，不要求对应文件仍然存在，也不算失效链接；可附 Git 提交引用追溯原文。缺陷处理与后续决策继续在该 ADR 中追加，不受 spec 是否存在影响。

文件名 `NNNN-标题.md`，编号不复用。已接受的决定不覆盖为另一个决定；功能开发中的后续调整和缺陷处理以带日期的附记保留原结论及演变。后续新功能改变既有取舍时，在新功能对应 ADR 中记录后继决定，并在被取代的 ADR 状态中注明。错别字可以直接修正。

仓库没有记录的价格、工期或损失不补数字。决策证据放在附录或对应的验收记录里，正文只保留支撑结论所需的摘要。

上下文和备选方案中的 MVP 范围、实现数量与未完成项描述的是决策当时的情况；新功能的范围与验收要求按 [临时 spec 约定](../README.md#按功能的临时规格) 分别定义。已接受决策的具体取舍仍然有效，改变取舍时按上述规则记录后继 ADR。

## 模板

```markdown
# ADR-NNNN：标题

- **状态**：Proposed | Accepted | Deprecated | Superseded by ADR-NNNN
- **日期**：YYYY-MM-DD
- **功能**：feature-name

## 上下文

发生了什么，当时哪些事实已经写在仓库或提交说明里。

## 决策驱动因素

影响取舍的长期约束。

## 备选方案

每个选项的优缺点，以及没有采纳的原因。

## 决策

选定的做法。

## 后果

得到什么，接受什么成本，之后哪些行为以此为准。

## 分阶段决策与缺陷历史

### YYYY-MM-DD：本次开发部分

- 相关 spec：`docs/spec-YYYYMMDD-feature-name.md`（历史文件名，完成后删除；可附 Git 提交引用）
- 决策与取舍：本部分的选择、备选方案、代价及对既有决定的调整。
- 相关缺陷：表现与影响、原因（已确认或待确认）、处理状态及验证证据；尚未发现时写「尚未发现」。

后续 spec 按时间追加章节，保留原有结论和缺陷状态变化；spec 删除后本节继续保留。
```

## 索引

| 编号 | 标题 | 状态 | 位置 |
| --- | --- | --- | --- |
| 0001 | 生产环境 MCP 以 stdio + token 为主，OAuth 走带外授权 | Accepted，2026-10-28 | [0001-mcp-access-stdio-first-oauth-out-of-band.md](0001-mcp-access-stdio-first-oauth-out-of-band.md) |
| 0002 | 工具检索先用 BM25，语义检索按信号延后 | Accepted，2026-10-28 | [0002-tool-search-bm25-before-semantic.md](0002-tool-search-bm25-before-semantic.md) |
| 0003 | 工具体系 v0.1：统一治理先行，按瘦身清单分期 | Accepted，2026-10-28 | [0003-tool-governance-v01-scope.md](0003-tool-governance-v01-scope.md) |
| 0004 | 退役 `workspace/MEMORY.md` | Accepted，2026-10-28 | [0004-retire-workspace-memory-md.md](0004-retire-workspace-memory-md.md) |
| 0005 | 删除 Agent Vault，改为单服务 | Accepted，2026-10-28 | [0005-remove-agent-vault-single-service.md](0005-remove-agent-vault-single-service.md) |
| 0006 | 提供商只登记显式 API key | Accepted，2026-10-21 | [0006-explicit-api-key-providers.md](0006-explicit-api-key-providers.md) |
| 0007 | 投递不承诺恰好一次 | Accepted，2026-10-21 | [0007-delivery-not-exactly-once.md](0007-delivery-not-exactly-once.md) |
| 0008 | 外部工具调用不自动重放 | Accepted，2026-10-21 | [0008-unsafe-tool-replay.md](0008-unsafe-tool-replay.md) |
| 0009 | 同一回合的工具顺序执行 | Accepted，2026-10-21 | [0009-sequential-tool-execution.md](0009-sequential-tool-execution.md) |
| 0010 | 状态用内置 SQLite，不另起数据服务 | Accepted，2026-10-21 | [0010-sqlite-no-extra-data-services.md](0010-sqlite-no-extra-data-services.md) |
| 0011 | Telegram 长轮询，不开公网 webhook | Accepted，2026-10-21 | [0011-telegram-long-polling.md](0011-telegram-long-polling.md) |
| 0012 | 安装方式改为 Docker，systemd 只留迁移 | Accepted，2026-10-27 | [0012-docker-replaces-systemd.md](0012-docker-replaces-systemd.md) |
| 0013 | agent loop 只用 pi-durable | Accepted，2026-10-21 | [0013-pi-durable-agent-loop.md](0013-pi-durable-agent-loop.md) |
| 0014 | 工具由人注册 | Accepted，2026-10-22 | [0014-humans-register-tools.md](0014-humans-register-tools.md) |
| 0015 | 旧版画像字段导致 working memory 损坏态 | Accepted，2026-10-31 | [working-memory/0015-legacy-profile-memory-corrupt-state.md](working-memory/0015-legacy-profile-memory-corrupt-state.md) |
| 0016 | 用户画像暂存 working memory | Accepted，2026-10-29 | [0016-user-profile-working-memory.md](0016-user-profile-working-memory.md) |
| 0018 | GitHub 官方托管 HTTP MCP 与 OpenBao 只读 PAT | Accepted，2026-11-01（实现与真实链路未验收） | [github-access/0018-github-access.md](github-access/0018-github-access.md) |
| 0019 | PTC 代码调用工具（codemode） | Accepted，2026-11-02 | [codemode-ptc/0019-codemode-ptc.md](codemode-ptc/0019-codemode-ptc.md) |
| 0020 | 远程 PTC sandbox（脚本与工具同在执行 VPS；2026-11-02 修订为统一 RPC） | Accepted，2026-11-02 | [remote-ptc-sandbox/0020-remote-ptc-sandbox.md](remote-ptc-sandbox/0020-remote-ptc-sandbox.md) |
| 0021 | 控制面与执行面分离，工具执行先下沉到执行 VPS | Proposed，2026-10-31 | [0021-control-execution-split.md](0021-control-execution-split.md) |
| 0022 | 提醒由宿主持久化并在进程内调度 | Accepted，2026-11-05 | [reminders/0022-reminders-in-process-scheduler.md](reminders/0022-reminders-in-process-scheduler.md) |
| 0023 | 开箱即用的 Bot 运行环境与平台能力清单 | Accepted，2026-11-06 | [zero-setup-bot-runtime/0023-zero-setup-bot-runtime.md](zero-setup-bot-runtime/0023-zero-setup-bot-runtime.md) |
