# 工具与 MCP

常驻工具：`bash`、`read`、`write`、`edit`（pi-durable 提供）、`current_time`，以及记忆开启时的 `memory_search`、`memory_read`、`working_read`、`working_update`。工具不是文件系统沙箱。生产环境应使用独立低权限用户运行。在 `src/tools.ts` 用底座 `defineTool` 定义新工具并注册，名称冲突在注册时直接拒绝。工具契约、错误语义与重放规则见 [契约与生命周期](contracts-and-lifecycle.md)。

## 配置文件

MCP server 通过 `DATA_DIR/mcp.json`（或 `MCP_CONFIG`）接入，无需改代码。文件不存在表示不启用。默认路径上的文件级错误只禁用 MCP 并记录原因；显式指定路径的错误使启动失败。

```json
{
  "servers": [
    {
      "name": "local-tools",
      "transport": "stdio",
      "command": "node",
      "args": ["/opt/aster/mcp-server.mjs"],
      "cwd": "/data/workspace",
      "env": { "EXAMPLE_TOKEN": "${EXAMPLE_TOKEN}" },
      "timeoutMs": 60000,
      "connectTimeoutMs": 10000
    },
    {
      "name": "notion",
      "transport": "http",
      "url": "https://mcp.notion.com/mcp",
      "auth": { "type": "oauth" }
    }
  ]
}
```

配置要点：

- `name` 唯一，匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$`；最多 8 个 server（stdio 最多 4 个），超出的条目忽略并告警。
- stdio：`command` 必填；`cwd` 必须是存在的绝对路径；默认 `inheritEnv: false`，子进程只得到运行所需变量加 `env` 条目，bot 的凭据不会传入。
- http：必须是 `https`（仅回环允许 `http`）；显式 `auth.type` 目前只支持 `oauth`。静态 header 凭据可省略 `auth`；GitHub 强制走这条路径且禁止 OAuth。
- `name` 为 `github` 的条目保留给官方只读 HTTP 接入，必须使用精确 endpoint、占位 PAT header 与 `githubPolicy`，且不得 pin 或定为 write。配置与运维说明见 [GitHub 只读接入](github-access.md)。
- `args`、env 值、header 值中的 `${NAME}` 从应用环境解析；缺失变量只禁用该条目并只报告变量名。单条无效、重名只跳过该条，不影响其他 server。
- 配置文件含凭据引用，部署时设为 `600`，不要提交仓库。

工具以 `mcp__<server>__<tool>` 命名，默认不直接提供给模型。系统提示列出启动时发现的 server 与工具数量。模型先调 `tool_search` 检索并加载需要的工具，之后才能调用。已加载集合随会话保存。观察到连接关闭后，该 server 的工具从搜索候选中移除；已加载声明保留，新调用在发送前返回 `TOOL_UNAVAILABLE`。适配器报告恢复时自动恢复搜索和调用，健康变化不改声明或加载 epoch。

## 常驻 pin 与授权

需要常驻的工具可在同一 `mcp.json` 顶层按注册名配置：

```json
{
  "servers": [],
  "tools": {
    "mcp__local-tools__read_file": { "pin": true, "authz": "read" }
  },
  "residentToolBudgetTokens": 8192
}
```

把 `servers` 换成实际连接配置。工具名以 `tool_search` 返回的注册名为准（清洗或截断后的名字可能带 hash）。启动时校验工具存在、可用，并按注册名顺序依次检查预算。通过后成为常驻工具，可直接调用。预算包含内置、记忆和搜索工具及已接受的 pin 的完整声明，默认 8192，允许 1～1048576。使用底座 token 估算，不是提供商精确计数。超限、未知或不可用的 pin 拒绝晋升并留日志，不阻止其他工具使用。已注册且可用的工具仍可按需加载。

运行中改配置不会立即生效，需重启。空闲重启时 pin 集合变化会结束当前上下文周期并增加一次声明 epoch。历史记录、记忆、已完成请求和已有加载序号保留。若有未完成工作（包括已写入记忆快照但尚未提交输入的请求），保留上次结算的 pin（即使新预算更小），待恢复完成后再次空闲重启才应用新配置。取消 pin 设为 `false` 或删除该项。此前已由搜索加载的工具仍按原生已加载集保留。彻底禁用连接需删除 server。详细契约见 [契约与生命周期](contracts-and-lifecycle.md)。

MCP 工具默认定级 `write`，不采信远端 annotations 的只读声明。所有者确认工具用途后，可按精确注册名配置 `authz: "read"`。此选项可单独使用，也可与 `pin` 合用，重启后生效。pin 只决定是否常驻，不授予权限。当前 Telegram 入口只接收所有者请求，拥有 read／write 全权。宿主 API 预留 `toolAuthority: "restricted"`，该实例及其恢复和嵌套调用只允许 read 工具。每次实际执行前复核注册、可用状态和授权。拒绝调用不发送外部请求。复核决定及原因码以 `tool_review` JSON 行写入 stderr，不含工具参数或结果。

MCP 调用一律按不可重放处理（`replay: "unsafe"`，见 [ADR-0008](adr/0008-unsafe-tool-replay.md)）。进程中断后不自动重跑，避免重复外部副作用。启动时连不上的 server 只记录错误码并跳过。连接关闭时已发送的调用仍可能返回 `MCP_CLOSED`。当前 SDK 只公开最终关闭事件，关闭后需重启建立新连接。HTTP SSE 的内部重连不提供健康事件。本应用不增加探活或自动重连策略，具体边界见 [契约与生命周期](contracts-and-lifecycle.md)。

## GitHub 只读接入

GitHub 使用官方托管 HTTP MCP、OpenBao 占位 PAT 与宿主四层只读策略，是 [ADR-0001](adr/0001-mcp-access-stdio-first-oauth-out-of-band.md) 默认路线的局部例外（[ADR-0018](adr/github-access/0018-github-access.md)）。它不接受 `pin`、`authz: "write"`、OAuth、toolsets、额外 header、远程 endpoint 或远程 gh 后备；12 个允许工具全部 deferred，经 `tool_search` 按需加载。

发布前必须有独立的、经人审阅的批准基线。缺少基线或发现声明漂移时整个 GitHub 条目停用，候选声明写入 `DATA_DIR/github-policy/candidate.json` 供操作者审阅，不能由启动、健康恢复或模型自动批准。每次业务调用前还会做一次有界 `tools/list` 对账；对账失败同样停用，直到以新的 `approvalVersion` 更新基线。配置样例、字段限制、错误语义和后续运维验收见 [GitHub 只读接入](github-access.md)。

## 检查与 OAuth

离线检查配置：

```sh
npm run build && node dist/src/check-config.js
```

连接冒烟测试（逐个连接、列出工具名后关闭，不启动 Telegram 与模型）：

```sh
npm run build && npm run mcp:check
```

对 GitHub，`mcp:check` 还会比对批准基线；缺少批准时只生成候选并使检查失败。它不执行业务读取，不能证明 PAT 权限、只读 method 或代理/OpenBao 链路已验收。

OAuth 首次授权或重新授权时先停 bot，再执行：

```sh
npm run build && DATA_DIR=./data npm run mcp:auth -- <server>
```

打开打印的 URL，在浏览器登录并同意，回到终端等待回调。headless 服务器需先建 SSH 端口转发（如 `ssh -L 8765:127.0.0.1:8765 user@host`）。支持 RFC 7591 动态注册的授权服务器（如 Notion）会自动完成客户端注册。`client_id` 与 token 一起保存在 `mcp-oauth/<server>.json`。不要删除该文件，重新注册会让已有授权失效。refresh token 失效后工具调用会报 `MCP_AUTH_REQUIRED`。这是预期行为，重新执行 `mcp:auth` 即可，不要反复重启。

容器内的授权命令不能靠普通端口映射把回调送进进程回环，见 [部署指南](deployment-test-guide.md) 第 5 节的宿主网络流程。

部署注意：容器内路径是卷内路径（`cwd` 等写 `/data/...`）。stdio server 依赖宜在派生镜像中预装，运行时从 npm registry 临时安装会把可用性绑到外部网络。每个 stdio server 都增加常驻进程与内存，4 GB 主机上优先少而稳。
