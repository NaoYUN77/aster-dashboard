# 内置 Web 工具提供商调研与接入依据

状态：调研与实施依据。核对日期：2026-10-29。范围：Aster 内置 `web_search` 与 `web_fetch`。本文核对公开官方文档／规范，未使用 API key 发起真实搜索或抓取，也未验证生产服务器的网络、检索质量与正文提取质量；在线文档可能继续变化。实现与实际配置以代码、schema 和 README 为准。

## 1. 建议

首选 **DeepSeek Search**，直接调用独立 REST Search API，不调用聊天模型。它现在已有正式的 Search／Fetch 文档，不能再沿用“DeepSeek API 不提供搜索”的旧结论。其请求小、结构化结果明确、错误与空结果计费规则清楚，适合只返回来源及摘要的窄工具。[D1][D2]

这是基于接口和运维成本的选择，并非检索质量排名：DeepSeek 的公开价格为 **$0.75／1,000 次成功且非空搜索**；Tavily PAYGO 的 basic 搜索折算为 **$8／1,000 次**（1 credit／次，$0.008／credit），另有每月 1,000 免费 credits；TinyFish 免费额度更大，但其价格页与 API 文档当前不一致，超额收费单价未在所查 Search 参考中给出。[D2][T1][T2][F1][F3]

关键限制：DeepSeek `query` 最多 **128 个 Unicode 字符**，需要明确拒绝过长输入，不能静默截断。若后续确需专用域名列表、较多参数化过滤或更长查询，应重新评估 Tavily；本期不做多提供商切换或自动降级。[D1][T1] 部署地并未提供，不能以“中国／海外提供商”推断可达性或性能；生产容器验证通过后才启用。

## 2. 官方能力与线缆契约

| 项目 | TinyFish Search | Tavily Search | DeepSeek Search |
| --- | --- | --- | --- |
| 实际搜索能力 | 独立排名搜索；`web`、`news`、`research_paper`。Search 找 URL，Fetch 取正文，Agent 执行网页工作流，三者不同。[F1][F2] | 独立 Search；`general`、`news`、`finance`，返回相关内容片段；可选生成答案与原文。[T1] | 自有搜索引擎，独立 Search 返回排名结果；Fetch 是另一端点，不需要使用 DeepSeek 聊天模型。[D1][D2] |
| HTTP／认证 | `GET https://api.search.tinyfish.ai`；`X-API-Key` header。其官方远程 MCP 使用 OAuth 2.1；自建本地包装 REST 不需要该 OAuth 流程。[F2][F4] | `POST https://api.tavily.com/search`；`Authorization: Bearer <key>`，JSON body。[T1] | `POST https://api.deepseek.com/v1/tools/search`；`Authorization: Bearer <key>`，`Content-Type: application/json`。[D1][D2] |
| 最小输入 | URL query 参数 `query`。`page` 从 0 开始、最大 10；当前参数表未列出每页条数控制，也未明确 `query` 长度上限，不据示例推导保证。[F2] | 必填 `query`；`max_results` 0–20、默认 10；`search_depth` 默认 basic，可选 advanced／fast／ultra-fast。[T1] | `query` 1–128 Unicode 字符、不能全空白；`count` 1–50、默认 10；可选 `ori_question`（1–128 字符，null 等同省略）、`localization`（IP 地址）、`need_content`（默认 false）。未知 body 字段被忽略。[D1][D2] |
| 过滤与上下文 | `include_domains`／`exclude_domains` 为逗号分隔字符串；`location`／`language` 自动配对，均省略时 US／en；`purpose` 最多 2,000 字符；日期、相对新鲜度及论文年份过滤。[F2] | 域名数组分别最多 300／150 项；日期／时间窗口、国家、语言等控制；`auto_parameters` 可能选择 advanced 并增加 credit 消耗。[T1] | 查询保留搜索语法，支持 `site:`、`-site:`、`-`、引号、`lang:`、`after:`、`before:`，多个站点可用 OR；不另造未记录的 JSON 域名参数。[D2] |
| 成功响应 | `{query,results,total_results,page}`；每项含 `position,site_name,title,snippet,url`，按类别附带日期、publisher 或论文信息。`total_results` 是返回数量，不是全网命中总数。[F2] | 顶层 `query,results,images,response_time` 等；每项含 `title,url,content,score`，可选 `raw_content,published_date` 等。`answer` 为可选生成答案；`usage` 需请求。内容片段长度为目标值，不是硬上限。[T1] | `{results:[...]}`，空匹配为 `[]`。每项字段见下节；`need_content:false` 时 `content` 始终为空字符串。[D1][D2] |

TinyFish 新鲜度参数：`recency_minutes` 为 1–5,256,000 整数，不可与 `after_date`／`before_date` 混用；日期格式 YYYY-MM-DD，起始不得晚于结束；论文搜索不支持这些日期参数，应使用 0–9999 的 `pub_year_min/max`。[F2]

Tavily 的日期是估计的发布或最后更新时间；默认日期窗口仍可能保留未知日期结果，严格剔除需 `filter_by_published_date:true`。其参考的 OpenAPI 仍把 `answer` 列入 required，而字段说明说只在 `include_answer` 开启时返回；不应依赖该 required 列表强制读取可选答案。[T1]

## 3. 价格、额度与错误

| 提供商 | 官方价格／限制 | 错误契约与取舍 |
| --- | --- | --- |
| TinyFish | **存在官方冲突**：Search 参考写每日 12,000 次免费、00:00 UTC 重置，之后需钱包余额为正；个人默认 30 requests/min，组织按合同。价格页却写 Search $0／次、任意钱包余额免费，30/min 且 500/hour。不能据此承诺无限免费；超过免费额的精确单价与实际生效限额应向账户后台／厂商确认。[F2][F3] | Search 参考列 400、401、402、403、404、429、500、503。402 为 `INSUFFICIENT_CREDITS`，不扣钱包的 beta 产品可能为 `FREE_ALLOWANCE_EXHAUSTED`；503 建议退避。不要把它的 Agent 运行错误当 Search 错误。[F2] |
| Tavily | 每月 1,000 free credits、无需信用卡；basic／fast／ultra-fast 1 credit，advanced 2。PAYGO $0.008／credit；月套餐例如 $30／4,000、$100／15,000、$220／38,000、$500／100,000。Development 100 RPM，Production 1,000 RPM；生产 key 需付费套餐或开通 PAYGO。[T1][T2][T3] | 400 请求错误，401 key 错误，422 字段校验；429 限流（有 `Retry-After` 时遵守）；432 key／plan limit，433 PAYGO limit，434 免费方案的实时抓取容量不足，500 服务错误。通常为 `{detail:{error:...}}`，422 的 detail 是数组；按状态分类，不匹配错误文本。[T1][T3] |
| DeepSeek | Search **$0.75／1,000 次**；仅 HTTP 200 且 `results` 非空计费，失败、空结果、超时不收费，count 不影响单价。每账户 Search 100 QPS、Fetch 25 QPS，互不占用，与模型并发额度独立。[D2] | OpenAI 风格 `{error:{message,type,param:null,code}}`。400、401、402、408、413、429、500、504；403／404 在指南中针对 Fetch，不能把搜索无结果解释成 404。官方建议 408／429／5xx 等待重试，402 充值后再试，其余 4xx 改正后再试。[D2] |

DeepSeek 的临时免费说明特指通过 DeepSeek Harness／Claude Code／Codex 的服务端工具调用，文档宣布 **2026-11-01 00:00 北京时间**开始按次计费；不能把这段说明外推为自建 Aster REST 调用永久免费或当前必然免费。预算按公开单价计算。[D2]

## 4. 本地工具契约

以下是本次实现采用的项目契约，不是厂商承诺。只实现一个提供商和两个内置工具，不增加第二套 agent loop，也不通过 MCP 子进程接入。[R1]

### 输入与宿主配置

内置工具名为 `web_search` 与 `web_fetch`，通过 Aster 受治理注册表直接注册；两者均为 `authz:"read"`，远端调用可能计费，故保持 `replay:"unsafe"`。[R1][R2]

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query": { "type": "string", "minLength": 1, "maxLength": 128 },
    "maxResults": { "type": "integer", "minimum": 1, "maximum": 10, "default": 5 }
  }
}
```

schema 的 default 只是声明；执行边界仍显式应用省略时的 5。底座 schema 校验与工具执行边界都校验，不依赖模型输入已经可信。query 拒绝全空白、孤立 Unicode surrogate 及超限，按 Unicode code point 数计数；首尾空白在边界清理，其余原样转发，不静默裁剪，不自动改写搜索语法。模型参数不包含 key、endpoint、header、代理、IP 定位或身份。[R1][D1][D2]

宿主从 `DEEPSEEK_WEB_API_KEY` 读取凭据；未设置时不注册两个 Web 工具，设置后在启动组合根一次性注册。执行边界仍拒绝空 key，不把凭证问题伪装成空结果。固定 HTTPS API 端点并拒绝跟随其重定向，避免把 Authorization 转发到别处。模型参数与持久化调用中没有 key、endpoint 或 header。环境变量注入**不是对 agent 的秘密隔离保证**：同 uid 的内置 bash 仍可能读取进程环境和文件；需要更强隔离时应拆分服务或使用受控凭证代理。[R1][R2]

### 上游请求与结果转换

一次调用只发一个请求：

```http
POST /v1/tools/search HTTP/1.1
Host: api.deepseek.com
Authorization: Bearer <宿主环境中的 key>
Content-Type: application/json
Accept: application/json

{"query":"用户 query 原文","count":5,"need_content":false}
```

`count` 取已验证的 maxResults。省略 `ori_question`、`localization`；不额外发送完整聊天记录或用户 IP。一次 `web_search` 调用不会隐式调用 Fetch，也不生成 answer；需要正文时由模型显式调用独立 `web_fetch`。[D1][D2]

上游每个 result 的正式字段：`rerank_score`（文档语义 0–3）、`title`、`url`、`snippet`、`summary`、`content`、`site_name`（string/null）、`site_icon`（string/null）、`date`（UTC RFC 3339/null）、`authority`（整数 -1–4，-1 为未知）。snippet 通常 100–200 字符，summary 通常 600–800；“通常”不是可安全分配内存的上限。[D1][D2]

成功的项目结果对象：

```ts
{
  ok: true,
  provider: "deepseek",
  query: string,
  results: Array<{
    rank: number,                 // 按上游数组顺序，从 1 开始
    title: string,
    url: string,
    snippet: string,
    summary: string,
    siteName: string | null,
    publishedAt: string | null   // 有效日期归一为 UTC ISO 8601
  }>
}
```

在适配边界只校验 Aster 实际消费的字段：`title`／`snippet`／`summary`／`site_name` 的类型与 Unicode、日期格式及绝对 HTTP(S) URL（拒绝含用户名／密码的 URL）；`rerank_score`、`authority`、`content`、`site_icon` 等未消费字段与未知新增字段忽略。空的展示文本归一为 `""`，缺失的 `summary` 归一为 `""`，`date` 为 null 或空字符串时为 `null`；类型错误、非法日期或非法 URL 返回 `UPSTREAM_PROTOCOL_ERROR`，不把 null 变成编造的站点／时间，不丢掉坏结果伪装完整成功。保留上游排序，结果多于请求 count 时只取前 count 条；不设 schema 未声明的单字段长度上限，资源由响应与输出总预算约束。score 与 authority 留在供应商边界内，不包装成跨提供商通用可信度。`results:[]` 是 `ok:true`，表示没有匹配。修复记录见 [WEB-01](web-tools-known-issues.md#web-01search-合法结果被判为上游协议错误)。[R1][D1][D2]

内置工具返回底座原生 `output` JSON 文本与同值 `structuredOutput`，并声明覆盖成功与失败对象的 `structuredOutputSchema`。预期业务失败设置 `isError:true`，供模型修正或向用户解释；不复制 MCP 协议对象。[R1]

### 失败、取消与资源上限

预期执行失败返回 `isError:true`，文本与 structuredContent 同含：

```ts
{ ok: false, error: { code: string, message: string, retryable: boolean } }
```

message 使用本地固定安全文案，可说明修改 query／检查 key／余额等恢复动作；不透传响应 body、headers、URL 查询串、key、环境或底层异常。错误码如下；retryable 仅表示后续重新调用可能成功，**本期不自动重试**。

| 条件 | code | retryable |
| --- | --- | --- |
| 工具参数不合法；不发 HTTP | `INVALID_ARGUMENT` | false |
| 达到本地并发上限；不发 HTTP | `BUSY` | true |
| HTTP 400／413 | `UPSTREAM_REQUEST_REJECTED` | false |
| HTTP 401 | `PROVIDER_AUTH_FAILED` | false |
| HTTP 402 | `PROVIDER_BALANCE_REQUIRED` | false |
| HTTP 429 | `RATE_LIMITED` | true |
| HTTP 408／5xx（包括 504） | `PROVIDER_UNAVAILABLE` | true |
| 其他非 200／重定向 | `UPSTREAM_HTTP_ERROR` | false |
| DNS／连接／TLS 等网络失败 | `NETWORK_ERROR` | true |
| 本地 20 秒上游总超时 | `TIMEOUT` | true |
| HTTP 200 但 JSON／字段／日期／URL 不合法 | `UPSTREAM_PROTOCOL_ERROR` | false |
| 上游 body 或最终模型文本超过预算 | `RESULT_TOO_LARGE` | false |

厂商状态含义依据 [D2]；错误码、总超时、并发和输出预算是本项目策略。一次请求的实际 I/O 使用工具上下文取消信号，覆盖建连及 body 读取，20 秒后 abort；调用方已取消时不伪造成功，本地 deadline 到期返回 TIMEOUT。[R1] 中断连接不能证明远端未搜索／未计费；若远端已经返回成功但响应丢失，客户端无法断言其是否收费，不承诺“取消必不计费”。

资源边界：Search 与 Fetch 共享最多 2 个正在执行的请求，无内存等待队列，超额立即 BUSY；Search 上游响应按解压后的实际读取字节限 **256 KiB**，超过即取消读取；序列化后的模型文本限 **24 KiB**，超过显式失败，不静默删结果。使用紧凑 JSON 保持低于 Aster 的 32 KiB／1,000 行文本上限；搜索最多 10 项。没有自动重试、分页追取、结果缓存或 durable 重放，避免重复费用与恢复状态混淆；read 授权不改变 `replay:"unsafe"` 策略。[R1][R2]

参数语义、上游 API 与业务失败用工具 `isError`，不能用成功空数组吞掉失败。Search 结果与 Fetch 正文都属于不可信外部内容，不把其中的指令、标题或链接作为宿主授权来源。[R1][R2]

## 5. 网络与部署验收

三者的上述路径都是远端 HTTPS API；内置工具仍需出站 DNS／TLS／443。建议只允许固定 `api.deepseek.com` 出站：Aster 不直接访问用户给出的目标 URL，而由 DeepSeek Fetch 从其网络抓取；无需本地浏览器、GPU、入站端口或 OAuth 回调。[D1][D3][F2][T1]

需要代理／企业 CA 时，确认 Node 内置 fetch 实际采用部署网络配置；不默认承诺它自动读取 `HTTP_PROXY`。内置工具随应用镜像构建，不在运行时通过未固定的 npx 下载依赖。[R1][R5]

实施前验收：从实际生产镜像与网络测试 key 的权限、DNS／TLS／代理路径、中文／英文查询及操作符、空结果、128 字符边界、401／402／429／504 映射、取消及超时是否终止读取、并发与输出预算、stdout 协议纯净度、日志无秘密。用固定样本比较检索质量与延迟后再决定是否调整提供商；本调研没有给出中国大陆可达性、全球数据驻留或 SLA 的保证。

## 6. DeepSeek Fetch：内置 web_fetch 的契约调研

本节截至 **2026-10-29**，仅依据 DeepSeek 官方中英文 API Reference／guide，未发起付费 API 调用。下列厂商契约与 Aster 项目策略分开描述；`web_fetch` 不自动继承 Search 的输入或错误语义。[D3][D4][D5]

### 厂商已公开的契约

| 项目 | 核对结论与来源 |
| --- | --- |
| 端点与用途 | `POST https://api.deepseek.com/v1/tools/fetch`，抓取**单个网页**并返回标题与 Markdown 正文；独立 JSON API，不要求先 Search 或调用聊天模型。[Fetch Reference](https://api-docs.deepseek.com/api/fetch/)、[指南概述](https://api-docs.deepseek.com/guides/search/) |
| 认证与编码 | 必填 `Authorization: Bearer <DeepSeek API Key>`、`Content-Type: application/json`；参考示例还发送 `Accept: application/json`，指南未将其列为必填。[鉴权](https://api-docs.deepseek.com/guides/search/#authentication)、[参考示例](https://api-docs.deepseek.com/api/fetch/) |
| 请求字段与 URL | JSON body 唯一列出的字段为必填 `url:string`，**非空、最多 8192 characters、HTTP/HTTPS、必须含 host、不得携带用户名或密码**。无可省略的默认 URL；未公开其他 Fetch 参数。此处长度未像 Search 的 query 一样明确写为 Unicode 字符，不能据此保证字节／code point／UTF-16 的计数方式。未知 body 字段忽略的说明位于 Search 请求小节，不能外推到 Fetch。[请求 schema](https://api-docs.deepseek.com/api/fetch/#request)、[Fetch 请求](https://api-docs.deepseek.com/guides/search/#request-1) |
| 成功响应 schema | HTTP **200**、`application/json` 对象，必填 `title:string` 与 `content:string`；`title` 不可用时为 `""`，`content` 为提取的 Markdown 正文。两字段均未声明可为 null；没有公开返回最终 URL、源站状态／headers 或抓取时间的字段，也没有公开正文长度硬上限。不能套用 Search 的 `results`、摘要与日期字段。[响应 schema](https://api-docs.deepseek.com/api/fetch/#responses)、[Fetch 响应](https://api-docs.deepseek.com/guides/search/#response-1) |
| URL／重定向限制 | 已公开的 URL 语法约束如上；Fetch 受目标站点可用性与访问策略影响。未公开是否跟随目标网页重定向、允许的跨域／协议转换、跳数或逐跳校验。参考示例中的 `curl -L` 作用于客户端到 API 端点的请求，不能据此推导 DeepSeek 抓取目标网页时的重定向契约。[参考示例](https://api-docs.deepseek.com/api/fetch/)、[Fetch 响应说明](https://api-docs.deepseek.com/guides/search/#response-1) |
| 价格与收费条件 | 中文指南标 **5 元／1,000 次成功 Fetch**，英文标 **$0.75／1,000 次**；按请求次数，非 token／正文长度。**仅 HTTP 200 且返回网页正文才计费**，失败与超时不计费；官方未解释币种适用或结算转换规则。DeepSeek Harness／Claude Code／Codex 经服务端工具的调用当前未计费，公告为 **2026-11-01 00:00 北京时间**开始按次收费；该特定说明不能外推为 Aster 直接 REST 调用的免费承诺。[中文计费](https://api-docs.deepseek.com/zh-cn/guides/search/#billing)、[英文计费](https://api-docs.deepseek.com/guides/search/#billing) |
| Rate limits | Fetch **每账号 25 QPS**，与 API key 无关；与 Search 的 100 QPS 及模型并发限制独立。另有**目标域名级 QPS 限制**，但未公布数值、域名归并方式、共享范围、窗口／突发算法；任一限额超出均返回 429。不能通过多 key 推导更多额度，也不能把 25 QPS 当成本地推荐并发数。[限速](https://api-docs.deepseek.com/guides/search/#rate-limits) |
| SSRF／网络语义 | 厂商称 Search／Fetch 为只读请求；Fetch 安全策略拒绝映射为 403，但未公开 SSRF 防护机制、私网／回环／链路本地／云元数据地址规则、IP literal／端口限制、DNS 重绑定与重定向逐跳校验。调用链为 Aster → DeepSeek HTTPS API → 目标站点；文档未保证抓取出口地域／IP、实时直连或缓存、DNS／TLS／代理行为、JS 渲染、cookie／登录态或 robots 策略细节。“只读”不是目标站点无访问日志／统计等副作用或无 SSRF 风险的证明。[概述](https://api-docs.deepseek.com/guides/search/)、[错误与只读说明](https://api-docs.deepseek.com/guides/search/#errors)、[目标站点限制](https://api-docs.deepseek.com/guides/search/#response-1) |

最小线缆示意（不是项目工具 schema）：[D3][D4]

```http
POST /v1/tools/fetch HTTP/1.1
Host: api.deepseek.com
Authorization: Bearer <宿主持有的 DeepSeek API Key>
Content-Type: application/json

{"url":"https://example.com/article"}
```

```json
{"title":"Example article","content":"# Example article\n\nArticle content."}
```

### 错误、超时与重试

错误为 OpenAI 兼容对象 `{error:{message,type,param,code}}`，`param` 恒为 `null`；指南只给出示例，没有逐状态的 `type`／`code` 枚举或稳定 message 契约。不得按示例错误文本识别 Fetch 失败。[官方错误格式与状态表](https://api-docs.deepseek.com/guides/search/#errors)

| HTTP 状态 | 官方含义 |
| --- | --- |
| 400 | 请求头／body 不合法，含 JSON 损坏或字段值无效。 |
| 401 | API key 缺失或无效。 |
| 402 | 账号余额不足。 |
| 403 | Fetch 请求被安全策略拒绝；文档没有细分触发条件。 |
| 404 | Fetch 未能取得可用正文：例如 URL 不可用、站点策略拦截、源站错误、不支持的内容类型、无法提取 Markdown。**不是源站一定返回 404，也不是成功空正文。** |
| 408 | 读取调用方请求 body 超时，不能解释为目标网页抓取超时。 |
| 413 | 请求 body 过大；具体字节阈值未公开。 |
| 429 | 账户级或 Fetch 目标域名级 QPS 超限；未说明如何区分二者或保证 `Retry-After`。 |
| 500 | 服务内部错误。 |
| 504 | 下游请求超时；未公开时长及连接／读取／总时限拆分。 |

以上逐状态均来自 [官方错误表](https://api-docs.deepseek.com/guides/search/#errors)。官方建议 408／429／5xx 等待后重试，402 充值后重试，其他 4xx 未改变请求不要重试；没有给出退避秒数、尝试次数或幂等键协议。若 Aster 取消连接或发生本地超时，不能仅据此证明 DeepSeek 同样超时或没有完成收费条件；重试可能形成另一笔成功请求。[错误与重试](https://api-docs.deepseek.com/guides/search/#errors)、[计费](https://api-docs.deepseek.com/guides/search/#billing)

### 项目策略与待确认项

模型参数只表达目标 URL；key、固定 API endpoint、超时、并发、输出字节预算与重试由宿主持有。输入在边界解析为绝对 HTTP(S) URL，拒绝凭据、IP literal、localhost／常见内部域名与自定义端口；这减少明显误用，但无法证明 DeepSeek 远端抓取及每次重定向都满足同一网络策略。目标页面正文作为不可信外部内容处理。[D3][D4]

Fetch 使用 20 秒本地总 deadline、512 KiB 解压后上游响应预算和 24 KiB 模型输出预算，与 Search 共享 2 路执行并发且不排队、不自动重试。正文超出模型预算时在 Unicode 边界截取，并以 `truncated:true` 明示；空正文或畸形响应失败，不伪装成功。403 映射安全策略拒绝，404 映射无法取得可用正文，408／5xx 可重试。以上数字和策略均属项目约束，不是厂商限制。[R1][本节官方请求字段](https://api-docs.deepseek.com/api/fetch/#request)、[限速](https://api-docs.deepseek.com/guides/search/#rate-limits)、[错误](https://api-docs.deepseek.com/guides/search/#errors)

官方资料**尚不能确认**：8192 的精确长度计数及未知字段处理；请求 body／正文大小上限和正文是否可能截断；具体超时秒数；单域名 QPS 数值与归并／共享规则及重试 headers；目标重定向、完整 SSRF／DNS／IP／端口规则；源站请求方法／headers、JS 与受保护页面能力、支持的 MIME 类型清单、缓存／新鲜度／出口位置；币种适用规则；取消后的远端执行与收费状态。应保留为待确认项，不能根据 SDK 惯例、Search 参数或错误示例补齐。[Fetch Reference](https://api-docs.deepseek.com/api/fetch/)、[Fetch 指南](https://api-docs.deepseek.com/guides/search/#fetch-api)、[错误](https://api-docs.deepseek.com/guides/search/#errors)、[计费](https://api-docs.deepseek.com/guides/search/#billing)、[限速](https://api-docs.deepseek.com/guides/search/#rate-limits)

## 7. 一手来源

- [D1] DeepSeek [Search API Reference](https://api-docs.deepseek.com/api/search/)：端点、认证示例、完整输入／结果 schema。
- [D2] DeepSeek [Search & Fetch guide](https://api-docs.deepseek.com/guides/search/)：搜索能力、操作符、空结果、错误、收费条件、限流与 2026-11-01 计费说明。
- [D3] DeepSeek [Fetch API Reference](https://api-docs.deepseek.com/api/fetch/)，[中文参考](https://api-docs.deepseek.com/zh-cn/api/fetch/)：Fetch 端点、认证示例、唯一请求字段及 200 响应 schema。
- [D4] DeepSeek [Search & Fetch guide：Fetch](https://api-docs.deepseek.com/guides/search/#fetch-api)、[Errors](https://api-docs.deepseek.com/guides/search/#errors)、[Billing](https://api-docs.deepseek.com/guides/search/#billing)、[Rate Limits](https://api-docs.deepseek.com/guides/search/#rate-limits)：目标站点限制、错误语义、美元价格与成功收费条件、账号及域名限速。
- [D5] DeepSeek [网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)：交叉核对中文契约、人民币价格与北京时间计费切换说明。
- [F1] TinyFish [Search overview](https://docs.tinyfish.ai/search-api)：搜索用途及与 Fetch／Agent／Browser 的区分。
- [F2] TinyFish [Search API Reference](https://docs.tinyfish.ai/search-api/reference)：参数、结果、状态码、每日额度和 RPM。
- [F3] TinyFish [Pricing](https://www.tinyfish.ai/pricing)：Search 免费、30/min／500/hour，与参考文档的差异。
- [F4] TinyFish [Authentication](https://docs.tinyfish.ai/authentication)：REST API key 与官方远程 MCP OAuth 的区别。
- [T1] Tavily [Search API Reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)，[同页原始 OpenAPI](https://docs.tavily.com/documentation/api-reference/endpoint/search.md)：端点、认证、参数、结果、状态码与 schema 差异。
- [T2] Tavily [Credits & Pricing](https://docs.tavily.com/documentation/api-credits)：免费 credits、套餐和 PAYGO 单价。
- [T3] Tavily [Rate Limits](https://docs.tavily.com/documentation/rate-limits)：开发／生产 key、429／Retry-After、434。
- [R1] 仓库 [CLAUDE.md](../CLAUDE.md)：技术基线、数据／凭据／副作用与资源边界。
- [R2] 仓库 [contracts-and-lifecycle.md](contracts-and-lifecycle.md)：工具注册、宿主授权、输出与重放契约。
- [R5] 仓库 [deployment-test-guide.md](deployment-test-guide.md)：Docker 镜像、网络与部署验收要求。
