# GitHub 首期只读接入

实现依据：[规格](spec-20261101-github-access.md) 与 [ADR-0018](adr/github-access/0018-github-access.md)。本变更提供离线可验证的宿主策略与接线；真实托管声明、PAT 权限、代理/OpenBao 链路、轮换与目标主机容量仍待独立验收。接入默认关闭，没有批准基线时不会发布工具。

## 宿主配置

真实 `mcp.json` 放在仓库外（默认 `DATA_DIR/mcp.json`），不要把本例写成已启用配置提交。本功能只支持普通 github.com，允许未列出的公开仓；私有资源由单个细粒度 PAT 的资源授权限制。没有 remote gh、OAuth、备用 token 或自动增权路径。

```json
{
  "servers": [{
    "name": "github",
    "transport": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": {
      "Authorization": "Bearer __vault_GITHUB_MCP_TOKEN__",
      "X-MCP-Readonly": "true",
      "X-MCP-Tools": "search_repositories,get_file_contents,search_code,list_issues,search_issues,issue_read,list_pull_requests,search_pull_requests,pull_request_read,actions_list,actions_get,get_job_logs"
    },
    "githubPolicy": {
      "approvalVersion": "github-read-v1",
      "baselinePath": "/var/lib/aster-approvals/github-approval.json"
    },
    "connectTimeoutMs": 10000,
    "timeoutMs": 60000
  }]
}
```

`githubPolicy` 只接受以上两个字段，基线路径必须为绝对路径。配置缺失、未知字段、错误 endpoint、非占位 Authorization、OAuth、额外 header、toolsets、过长时限或 GitHub pin/write 定级会拒绝 GitHub 条目。宿主调用入口也检查关键配置，模型不能指定凭据或连接参数。其他 server 的 pin/authz/OAuth 规则不变。

12 个工具全部 deferred，通过原生 `tool_search` 加载，下一轮模型调用生效。定级为 read 只在策略与声明批准之后发生。底座 schema 校验与执行边界复核共同约束参数；owner、嵌套、已加载与恢复调用共享该边界。工具名、annotations、pin 或提示词均不构成授权。

分页读取必须显式提供 `perPage`（1～30），只读一页；不自动翻页。搜索/游标最多 4096 UTF-8 字节，页号为正安全整数。PR `after` 仅用于 `get_review_comments`，此方法不传 `page`。`issue_read`、`pull_request_read`、`actions_list` 与 `actions_get` 只允许规格列出的 method。Actions 的 `resource_id` 按 method 解释；可选高级 filter 字段首期不发布。单 job 日志必须有 `job_id`、`return_content:true`、`failed_only:false` 和 1～200 的 `tail_lines`，拒绝 `run_id`。

## 批准与漂移

批准文件与启动观察 catalog 分离，包含批准版本、endpoint、固定操作策略、原始身份/注册名、完整原始声明与收窄后的有效声明。比较排序对象键、保留数组顺序，描述、annotations、输出 schema 和其他返回字段均参与比较。工具集合必须恰好为 12 个，重复、额外、缺失、过滤、不支持 schema 或不完整分页都会停用整个接入。可选未知输入字段不进入有效声明；未知必填字段拒绝适配。

首次运行或 `npm run mcp:check` 会在缺少有效批准文件时，向 `DATA_DIR/github-policy/candidate.json` 写候选并保持关闭。该文件包含不可信远端声明，不能由模型、启动同步或健康检查自动批准。操作者逐项审阅完整声明、有效 schema 与每个允许 method 的覆盖，然后在独立运维流程中将批准文件置于宿主只读目录。审批目录应由另一身份拥有，应用只能读取；不要放在模型工作区、临时目录或代码更新目录。此 PR 不创建真实批准文件，不批准 fixture。

每次业务 `tools/call` 前在同一并发闸口内做一次 `tools/list` 对账，最多 10 秒。业务调用总限时最多 60 秒，GitHub 并发上限 1，忙时直接拒绝，不排队。list-changed、对账失败或非取消/超时的调用失败会同步冻结后续调用，并将安全原因与批准指纹写入 `DATA_DIR/github-policy/disabled.json`。调用方取消与总时限到期只按取消/超时失败处理，不据此推断声明漂移。搜索排除停用工具，已经加载的执行也会被阻断。完整发现最多 100 工具/10 页，达到截断条件即拒绝。

普通重连、重启或健康恢复不清除同一批准指纹的停用。重新核准要审阅差异、收敛未完成任务并使用新的 `approvalVersion` 更新独立基线；同一原始声明也需明确新批准版本才可重新启用。存在未完成工作时，不允许新批准替换旧声明继续执行。空闲启动通过既有上下文 reset 边界刷新 deferred 声明与加载元数据；历史加载序号与记录保留。所有 MCP 调用仍为 `replay: unsafe`。

对账之后到业务请求处理之前仍有变化窗口；声明不变的远端语义变化无法由此检测。官方托管端无法在本地固定 release 或回滚。

## 传输、结果和诊断

Node 必须启用 `NODE_USE_ENV_PROXY=1`、HTTP(S) 代理及 `NODE_EXTRA_CA_CERTS`，不能禁用 TLS 校验或通过 `NO_PROXY` 绕开 GitHub host。沿用宿主认证代理配置。GitHub fetch 固定 endpoint，拒绝 HTTP 重定向，补齐 pi-mcp 1.3.0 请求取消到真实 HTTP 的信号传递。SDK SSE 自动重连在 GitHub 连接上关闭，业务调用无自动重试。

JSON/SSE 响应流累计最多 1 MiB；一次 list 的各页共用预算，一次业务响应及相关 stream 共用当前作用域预算。输入超限会取消 reader，传输失败冻结接入。成功结果只接受文本/结构化 JSON，不展开图片、资源、下载链接、artifact 或日志 URL。文本上下文沿用底座 32 KiB/1000 行显式截断；截断内容不能视为完整读取。文件过大时缩小路径或 ref；列表显式读下一页；日志缩小 tail。

错误保留 `isError`、安全 code、阶段及批准指纹；策略拒绝明确业务未发送，对账可能已发送。HTTP/协议/网络失败保留可能已发送、远端终态未知的语义；不把本地取消称为远端停止。401 是 PAT 核对提示，407 是代理认证，403 不推断唯一权限原因，404 可能隐藏私有资源，429 不循环重试。远端 MCP `isError` 保持业务失败，不转为空集合。日志只记录关联标识、工具、批准指纹与安全原因，不写参数、Authorization、查询或 CI 正文；结果仍按既有 durable 会话契约保存。投递失败只重投已存回复。

## 后续独立运维验收

不在本 PR 修改真实 OpenBao 映射。操作者后续单独增加 `GITHUB_MCP_TOKEN` → 精确 `api.githubcopilot.com` 的凭据释放规则，KV v2 逻辑路径 `secret/aster/GITHUB_MCP_TOKEN`、字段 `value`，HTTP 路径 `/v1/secret/data/aster/GITHUB_MCP_TOKEN`。不增加 api.github.com、github.com、githubusercontent.com 或通配 host。

只由操作者写 PAT 到 OpenBao。初始核对 Metadata/Contents/Issues/Pull requests/Actions/Checks 的必要 Read 权限、资源所有者、私有仓、期限、审批与轮换责任；不申请写权限，不以真实写操作探测权限。代理 token、OpenBao token 与 PAT 分开。沿用凭据缓存 300 秒，正常轮换确认缓存到期，紧急撤销在 GitHub 侧进行并先停用能力。

MITM 认证与 OpenBao mTLS/内部网络需由独立基础设施变更提供并验收；本分支从 origin/main 开始，不合入其他在途部署分支。后续在隔离环境验证真实 12 工具及每个 method、公开/私有资源、代理错误与取消、轮换、容量（4 核/4 GB 同机负载）。`mcp:check` 只验证发现与批准，不执行业务读取，不证明这些验收已完成。
