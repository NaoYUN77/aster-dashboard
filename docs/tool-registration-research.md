# 私有工具与运行时注册：同类 personal agent 的做法

状态：调研记录；阶段 3（MCP 客户端）已实现，设计与运行方式见 [contracts-and-lifecycle.md](contracts-and-lifecycle.md) 和 [README.md](../README.md)。日期：2026-10-22。

本文回答两个问题：其他 personal agent 是否让模型自己注册工具；用户要接入课表、活动这类私有数据时，凭据和实现放在哪里。结论见 [ADR-0014](adr/0014-humans-register-tools.md)。模型仍不能在运行时自注册可执行工具。

## 1. 结论

主流 personal agent **没有让模型在运行时自由注册可执行工具**。它们把“工具是否存在”和“模型能否调用”分开：

- 工具的注册、安装、授权由用户或管理员完成；
- 模型只负责发现 `tools/list` 或工具描述，并在权限内调用；
- 私有凭据属于集成方，不进入模型上下文；
- 写操作通常需要额外确认。

“模型自己写工具”出现在研究型 agent（如 Voyager 的技能库）里，通常配合沙箱和人工审核，不是生产 personal agent 的默认能力。

## 2. 同类产品的处理方式

| 产品／协议 | 工具如何进入系统 | 凭据在哪里 | 对模型的限制 |
| --- | --- | --- | --- |
| MCP（本地 stdio server） | 用户配置 server，协议发现 `tools/list` | server 自己的环境或 OS secret store；官方明确警告不要全局导出凭据 | 工具描述可能被投毒；建议最小权限、逐 server 隔离、人工确认 |
| MCP（远程 HTTP） | 用户配置 URL，OAuth 授权 | OAuth 短期 token，加密存储，支持撤销 | scope 限制；token 不跨 server 复用 |
| OpenClaw | 用户安装 skill／配置 MCP server；node 向 Gateway 发布工具描述 | skill 文件和执行留在 node 上；node-hosted MCP 目前不支持 OAuth server | Gateway 是信任域；技能由用户放置，模型不自动生成 |
| PersonalClaw | 本地优先，MCP 双向；应用需显式启用 | 本地保存 | “permission-gated app platform”，工具调用前需授权 |
| Letta | 服务端定义工具／MCP；hosted MCP 用 API key 连接 | Letta 服务端 | 工具由开发者或用户注册，模型调用 |
| Manus | 用户在 integrations 页面连接 app／自定义 MCP；OAuth 或 API token | Manus 侧保存，用户可撤销；外部 Open App 走 OAuth2 | 标准 OAuth client 只能拿到用户授予的 connector |
| ChatGPT connectors／actions | 开发者或用户配置 connector／action；OAuth 或 API key | 连接方保存；用户连接时审查权限 | 读与写分开；写操作需确认；可随时断开 |
| Open WebUI | 管理员安装 Python tool；valve 保存配置 | valve 默认明文 JSON，可加密；tool 代码与主进程同权限 | 工具代码不是隔离边界；外部 MCP／OpenAPI server 才是 |
| Voyager 类研究 | 模型生成技能代码，写入技能库复用 | 沙箱内 | 依赖沙箱、审核与回滚；持久化代码本身就是攻击面 |

### 2.1 Manus、Grok、Cue 的具体管理方式

**Manus（云端 SaaS）**

- Telegram 入口是 Manus Agents：在 workspace 里点 Connect、扫码，不需要自己申请 bot token、跑服务器或写配置文件。
- agent 在 Manus 云端执行，消息可以触发研究、代码执行、数据处理和文档生成，结果回到聊天。
- 只能读直接发给它的私聊消息，不能读用户的其他 Telegram 会话、群或联系人。
- 工具接入分两类：内置 connector 在 integrations 页面用 OAuth 授权（Notion、Slack、Asana、Linear 等），也可以接自定义 MCP server 或保存 API token；用户可撤销授权。
- 工具注册、执行环境和凭据都由平台管理，用户只做连接和授权。

**Grok Telegram bot（@grokAI）**

- 官方 bot，Telegram Premium 可用；它是模型聊天入口，不是可扩展的个人集成平台。
- 工具是平台内置的（网页搜索、X 搜索等），用户不能安装自己的 connector，也没有“把课表接进来”的注册机制。
- 社区存在 `grok-telegram-bot` 之类的自建桥接：在本机执行 shell、读写文件、接 MCP，默认甚至可能自动批准工具。这类项目不是官方产品，权限模型取决于作者配置，不能当作 Grok bot 的能力。

**Cue by Manus（云端 personal agent）**

- Cue 是 Manus 在 Manus 2.0 同期推出的独立 personal agent 应用（2026-09-28），目前需要邀请码；agent 运行在 Manus 云端。
- 每个 agent 有独立的角色、会话和记忆，可选地拥有自己的电话号码、邮箱、钱包和 computer；可以加入群聊、离线继续工作，并在需要时把决定带回给用户批准。
- 消息通道包括 Telegram、iMessage、LINE、Slack；同一个 agent 可以同时连接多个平台。入口是 agent 的 **Agent Info → Integration → Messenger → Connect**，可逐项启用或停用。
- 工具包括 Gmail、Slack、Notion、Trip、Oura、MyFitnessPal 等；用户按 agent 选择可用工具，并指定哪些动作需要批准。商店说明称权限可随时修改。
- 记忆以 “Memory” 和 “Dream” 的形式保留偏好、既往决定和长期目标；公开资料没有说明底层存储和检索方式。
- 复杂连接仍走 Manus Connectors：OAuth、自定义 MCP、API token，可撤销；Cue 与 Manus 的 Skills 配置彼此独立。

**Cue OS（另一个产品，本地优先）**

- 注意：Cue OS（docs.cueos.ai）不是 Cue by Manus。它把 agent 运行在用户自己的电脑上；Telegram、Discord、WhatsApp、Feishu 是“聊天通道”，通过 Cue CLI 配置，属于 bot／linked device 适配层。
- 只有被加为 owner 的用户能使用这些通道；支持 DM／群 allowlist、频道限制、仅 @ 时响应。
- Discord 需要 bot token、Message Content Intent、`bot` 和 `applications.commands` scope、Send Messages 权限；电脑和后台 worker 必须保持运行。
- 服务连接器（Gmail、Google Calendar、Drive、Slack、GitHub 等）与聊天通道分开管理；`cue integration list` 会显示权限 scope、缺失 scope 和 token 过期时间。
- 工具和凭据留在本地，但模型调用仍是远端服务；这是“本地执行 + 云端推理”的混合边界。

共同点：

1. **注册是配置行为，不是模型行为。** 模型可以建议“需要一个查课表工具”，但安装和授权由人完成。
2. **凭据与执行放在集成侧。** 本地 server、独立进程或 OAuth token broker 持有凭据；模型只看到工具 schema 和结果。
3. **权限与副作用分级。** 只读工具可自动调用；写操作、外部发送、安装新工具需要确认。
4. **工具描述是元数据，不是可信指令。** MCP 官方把 tool poisoning 列为本地 server 的风险之一；描述会进入模型上下文。
5. **持久化代码需要版本与回滚。** 一旦工具被保存并在以后自动加载，错误或恶意行为会跨请求重复。

## 3. 对本项目的含义

调研时（2026-10-22）的实现主要是“代码注册”：`src/tools.ts` 定义，`createToolRegistry()` 在启动时安装。下述分期建议记录当时如何减少修改核心代码、重新部署及私有配置进入仓库的问题。

当前内置工具仍通过代码注册，MCP 已支持由所有者通过配置接入，无需为每个私有工具修改核心代码，见 [工具与 MCP](mcp.md)。下述三阶段保留为调研建议，不是当前必经的实施顺序；注册与授权的有效决策见 [ADR-0014](adr/0014-humans-register-tools.md)。

### 阶段 1：私有集成先走独立服务（现在即可）

- 课表、活动等查询放在独立小服务里，用独立系统用户运行，凭据在它自己的 env 文件或 systemd credential 中。
- agent 侧只保留一个通用 HTTP 工具，配置里只有 `CAMPUS_PROXY_URL`，没有校园凭据。
- 工具描述保持通用，不写学校名、学号、内部 URL；这些会随每次请求发给模型厂商。
- 服务只暴露窄接口（如“查本人指定日期课表”），返回脱敏后的最小字段。
- 代价：多一个进程和一份部署配置；换来的边界是 agent 的 bash 永远读不到校园凭据。

这也是最符合“隐私”诉求的做法：不是我写不写代码的问题，而是让模型运行时也拿不到凭据。

### 阶段 2：用户维护的工具清单（如果确实需要“不改核心代码加工具”）

在数据目录放工具清单，启动时加载，而不是让模型写：

```text
DATA_DIR/tools/
  campus_schedule.json    # 元数据 + 参数 schema + 实现类型
  campus_schedule.mjs     # 可选：用户自己维护的实现
```

清单字段沿用前一轮讨论的结构：`name`、`description`、`parameters`、`implementation`（`http` 或 `module`）、`replay`、`enabled`、`createdAt`、`approvedAt`。关键约束：

- 只有 `enabled && approvedAt` 的记录才加载；
- 单条损坏只禁用该工具，不阻止服务启动；
- `parameters` 根必须是 object schema，限制深度、属性数和 pattern 长度；
- HTTP 只允许 https 和目标 host 允许列表，拒绝私网／回环；
- 凭据只保存 `${ENV_NAME}` 引用，执行时由宿主解析；
- 模块 `realpath` 必须位于工具目录内，禁止符号链接逃逸；
- 写操作默认 `replay: "unsafe"`，并考虑 owner 确认。

这相当于“MCP-lite”，但比引入完整 MCP 客户端轻，适合 4 核／4 GB 单机。

### 阶段 3：接入 MCP client（已实现）

接入现成的 GitHub、日历、Notion 等 server 时，使用与底座同版本的 `@earendil-works/pi-mcp` 1.3.0 做协议客户端，不自建 JSON-RPC 和插件协议：

- 支持本地 stdio 与远程 Streamable HTTP；stdio server 负责执行和凭据，agent 只做协议客户端；
- 远程 server 走 OAuth，token 由宿主保存在数据目录，不交给模型；交互授权在独立 CLI 进程中完成；
- 工具发现后全部标记为 `deferred`，模型通过 `tool_search` 按需加载，降低常驻暴露面；
- 进程生命周期、连接与调用超时、取消、输出上限、schema 边界和 4 GB 主机预算按契约处理。

仍未实现按 server 的工具级允许列表：当前的信任边界是用户选择接入的 server，而不是 server 返回的每个工具。描述注入仍可能影响模型行为，不能据此放宽权限。

设计见 [contracts-and-lifecycle.md](contracts-and-lifecycle.md)「MCP 工具」，配置与运行方式见 [README.md](../README.md)。

## 4. 不建议：模型自注册可执行工具

如果让模型调用 `register_tool` 直接写实现并装入 registry，会同时引入：

- **持久化代码执行**：一次被诱导的注册会在以后每次启动时运行；
- **凭据外泄**：工具代码与 agent 同进程，能读 env、`MEMORY.md`、SQLite 和网络；
- **描述投毒**：工具 description 会进入后续请求的上下文，可影响模型行为；
- **恢复契约破坏**：已持久化的工具调用在工具被改名、改 schema 或删除后无法按原语义恢复；
- **审计困难**：需要额外记录谁在何时注册了什么、依据是什么。

如果一定要做，最低限制是：只允许声明式 HTTP、不允许代码；注册先落 `pending`，由 owner 明确批准；host 允许列表；只读默认；完整审计；可一键禁用。即使这样，它也只是“用户授权后添加集成”的快捷方式，不是真正的自主工具创造。

## 5. 隐私边界（课表例子）

| 数据 | 放在哪里 | 模型能否看到 |
| --- | --- | --- |
| 校园账号／cookie／token | 独立服务的 env 或 systemd credential | 不能 |
| 学校内部 URL | 独立服务配置 | 不能 |
| 工具 name／description／schema | agent 仓库，随请求发送 | 能，因此保持通用 |
| 课表结果 | 工具输出，随请求发送 | 能，因此只返回必要字段 |
| agent 的 API key／bot token | `/etc/personal-agent.env` | 能通过 bash 读到，应视为已暴露给模型 |

最后一行是当前架构的硬边界：只要 agent 有 bash 且继承环境，进程内的任何凭据都对模型可见。真正的隔离只能靠“凭据不在这个进程里”。

## 6. 待办与验收条件

若要推进阶段 2，完成标准建议如下：

- [ ] 用户新增一个工具只需放清单（不改 `src/tools.ts`），重启后生效；
- [ ] 清单 schema 非法、名称冲突、实现越界时，该工具不加载且服务继续启动；
- [ ] 凭据只以引用形式出现；`journalctl`、工具输出、错误信息中不出现值；
- [ ] 只读与写工具可区分，写工具需要 owner 批准；
- [ ] 删除／禁用工具时，未完成的持久化调用有明确错误，不静默重跑；
- [ ] HTTP 工具受 host 允许列表、超时、响应大小和输出大小限制；
- [ ] 测试覆盖非法清单、凭据不泄漏、启用／禁用、重启加载和恢复冲突。

在这些条件满足前，私有工具继续用阶段 1 的独立服务方案。

## 7. 资料来源

- MCP 本地 server 安全：<https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/tutorials/security/local-server-security.mdx>
- MCP 授权：<https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/tutorials/security/authorization.mdx>
- MCP 安全最佳实践：<https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/tutorials/security/security_best_practices.mdx>
- OWASP MCP Security Cheat Sheet：<https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html>
- OpenClaw 架构与 skills：<https://docs.openclaw.ai/start/why-openclaw>、<https://docs.openclaw.ai/nodes/mcp-and-skills>
- PersonalClaw：<https://github.com/PersonalClaw/PersonalClaw>
- Letta hosted MCP：<https://docs.letta.com/platform/hosted-mcp>
- Manus connectors：<https://help.manus.im/en/articles/12231777-how-can-i-use-manus-connectors>、<https://open.manus.ai/docs/v2/connectors>
- Manus Telegram Agents：<https://manus.im/cs/blog/manus-agents-telegram>
- Grok Telegram bot：<https://t.me/grokAI>、<https://help.x.com/en/using-x/about-grok>
- Cue by Manus：<https://www.cue.im/>、<https://help.manus.im/en/articles/14178640-can-i-connect-multiple-messaging-agents-at-once-in-cue>、<https://play.google.com/store/apps/details?id=ai.manus.agents>
- Cue OS integrations／bot channels：<https://docs.cueos.ai/integrations>、<https://docs.cueos.ai/integrations/discord>
- ChatGPT connectors／permissions：<https://help.openai.com/en/articles/11487775-connectors-in-chatgpt>、<https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt>
- Open WebUI tools／valves／hardening：<https://docs.openwebui.com/features/extensibility/plugin/tools/>、<https://docs.openwebui.com/features/extensibility/plugin/development/valves/>、<https://docs.openwebui.com/getting-started/advanced-topics/hardening/>
- 让 agent 自己写工具的风险：<https://docs.promptise.com/blog/let-an-agent-write-its-own-tools-safely/>
- Agent skill 安全综述：<https://arxiv.org/abs/2607.13987>
- OWASP Agentic Skills Top 10：<https://owasp.github.io/www-project-agentic-skills-top-10/>
- Voyager（技能库背景）：<https://arxiv.org/abs/2305.16291>
