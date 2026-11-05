# 内置 Web 工具已知问题

状态：WEB-01 已修复（离线），待真实 smoke test；WEB-02 开放。首次记录：2026-10-29。本文记录 `web_search` 与 `web_fetch` 在线使用中已经复现的问题、证据边界和后续验收条件；提供商契约和接入依据仍以 [内置 Web 工具提供商调研](web-search-provider-research.md) 为准。

本文不包含 API key、Authorization header、原始提供商正文或 Telegram 对话全文。

## WEB-01：Search 合法结果被判为上游协议错误

### 状态与影响

- **状态**：已修复，离线回归测试通过；待获得授权后做一次真实 key 脱敏 smoke test。
- **用户可见错误**：`UPSTREAM_PROTOCOL_ERROR`，不可重试。
- **影响**：一条结果包含 Aster 不接受的字段值时，整批搜索结果失败；用户看不到其余有效结果。
- **已观察场景**：查询 OpenAI blog 最新文章时连续出现该错误。现有运行记录只保存归一化后的错误码，没有保存上游响应字段，不能据此认定线上具体是哪一个字段触发。

### 已确认根因

`src/web-search.ts` 使用 `boundedProviderText()` 处理 `title`、`snippet` 和 `summary`。该函数清理文本后把空字符串或纯空白字符串转成 `undefined`；`normalizeResponse()` 随后把任一 `undefined` 判为协议错误。

DeepSeek 官方 Search schema 只声明这些字段为字符串，没有声明非空约束。DeepSeek 官方 Harness 的 Search 适配器与测试进一步明确支持以下情况：

- `title`、`snippet`、`summary` 可以是空字符串；空值在输出映射时省略，不使整次请求失败。
- `summary` 可以缺失。
- `date` 可以是 `null` 或空字符串。
- `site_name`、`site_icon`、`rerank_score`、`authority` 等未消费字段不参与其输出映射。

将 DeepSeek 官方 Harness 测试中的成功响应 fixture 原样送入 Aster 的 `searchWeb()`，可以稳定得到：

```text
UPSTREAM_PROTOCOL_ERROR
```

逐字段最小复现同样稳定：

```text
title=empty: UPSTREAM_PROTOCOL_ERROR
snippet=empty: UPSTREAM_PROTOCOL_ERROR
summary=empty: UPSTREAM_PROTOCOL_ERROR
```

因此可以确认 Aster 的响应适配器与 DeepSeek 的实际成功响应边界不兼容。空 `snippet`／`summary` 是已有第一方 fixture 支持、并已本地复现相同错误的首要触发条件。

### 同类兼容风险

当前适配器还施加了提供商响应 schema 未声明的限制：

- `title` 最多 500 个字符。
- URL 最多 2,048 个字符，且必须能被本地 `URL` 解析为 HTTP(S) 绝对地址。
- `snippet` 最多 2,000 个字符。
- `summary` 最多 4,000 个字符。
- `site_name` 最多 300 个字符。
- `date` 必须匹配本地限定的 UTC RFC 3339 表达式。
- 返回结果数不得超过请求的 `count`。

这些限制可能继续把提供商认为成功的响应转换为 `UPSTREAM_PROTOCOL_ERROR`。它们是否应保留、放宽或改为安全截取，需要在修复时逐项决定；本记录不预先指定实现方案。

### 修复结果

修复只改 `src/web-search.ts` 的 DeepSeek 响应适配与 `test/web-search.test.ts`；工具注册、`tool_search`、schemaHash、tool ledger 与输出接口（`title`／`snippet`／`summary` 为字符串，`publishedAt` 为字符串或 null）均不变。

- 空的 `title`、`snippet`、`summary` 归一为 `""`，不再使整批失败。
- 缺失的 `summary` 归一为 `""`；空字符串 `date` 归一为 `null`。
- 不再校验未消费的 `rerank_score`、`authority`、`content`、`site_icon`。
- 上游结果多于请求数量时只取前 N 条，不再整批失败。
- 移除 schema 未声明的单字段长度上限（title、URL、snippet、summary、site_name）；资源边界由 256 KiB 上游响应预算和 24 KiB 模型输出预算承担，超出仍显式失败。
- 保留：字段类型错误、非法 Unicode、非法非空日期、非 HTTP(S) 或含凭据的 URL 仍返回 `UPSTREAM_PROTOCOL_ERROR`。

`web_fetch` 经复核不做同类放宽：空标题本就被接受；官方把无法提取正文定义为 HTTP 404，没有第一方成功 fixture 证明 200 加空正文是可用结果，因此空正文仍判为协议错误，1,000 字符标题上限保留。

### 尚未确认

- 线上失败响应具体包含空字段、缺失字段、超长字段，还是其他合法变体。
- DeepSeek 是否偶发以 HTTP 2xx 返回错误 envelope、空 body、HTML 或畸形 JSON。
- OpenAI 相关查询是否更容易产生空摘要；现有证据不足以建立这种关联。

在没有经过脱敏的真实响应结构前，不能把上述任一项写成线上直接触发原因。若需要捕获现场，只记录 HTTP 状态、顶层键名、字段类型、是否为空和字符数；不得记录正文、URL、headers 或凭据。

### 修复验收条件

后续修复至少应提供以下证据：

1. 先用 DeepSeek 官方 Harness 的成功 fixture 建立失败回归测试，证明旧实现返回 `UPSTREAM_PROTOCOL_ERROR`。
2. 修复后，空的可省略展示字段不再导致整批结果失败。
3. 缺少或类型错误的真正必需字段仍明确失败，不用默认值伪造数据。
4. 响应和模型输出仍受明确的字节预算约束；若改用截取，必须显式表达截取语义。
5. provider body、headers、URL 查询串和凭据不进入工具结果或日志。
6. 重新运行 Web 工具聚焦测试、TypeScript 检查、构建和全量测试。
7. 在获得明确授权后，用真实 key 做一次脱敏 smoke test；该测试可能产生费用，不属于离线修复的默认步骤。

## WEB-02：DeepSeek Fetch 无法取得部分 OpenAI 页面正文

### 状态与影响

- **状态**：提供商返回已定位；目标站点侧原因未确认。
- **用户可见错误**：`CONTENT_UNAVAILABLE`，不可重试。
- **已观察 URL**：`https://openai.com/blog`、`https://openai.com/news/`、`https://openai.com/index/`、`https://www.openai.com/news`。
- **影响**：`web_fetch` 无法为这些 URL 返回 Markdown 正文。

### 已确认行为

Aster 只在 DeepSeek Fetch API 返回 HTTP 404 时产生 `CONTENT_UNAVAILABLE`。该错误发生在读取和解析成功正文之前，不是 Aster 的 URL 输入校验或 Markdown 正文解析失败。

DeepSeek 官方文档把 Fetch 404 定义为未能取得可用正文，可能包括：

- URL 不可用。
- 目标站点访问策略限制。
- 目标站点错误。
- 不支持的内容类型。
- 页面无法提取为 Markdown。

因此这里的 404 不表示 OpenAI 源站一定返回 HTTP 404，也不能证明具体原因是 JavaScript 渲染、robots、反爬、出口区域、重定向或其他策略。

### 当前结论

Aster 对 DeepSeek HTTP 404 到 `CONTENT_UNAVAILABLE` 的映射符合公开契约，目前没有证据表明这是本地实现缺陷。该现象应按提供商或目标页面能力限制处理，和 WEB-01 的 Search 解析器缺陷分开。

若要继续定位，需要使用同一部署环境和同一 DeepSeek 账户，对官方已知可提取的静态公共页面与 OpenAI 页面做对照。未经明确授权不得发起可能收费的真实请求。

## 证据与来源

- Aster Search 响应校验：`src/web-search.ts`。
- Aster Fetch 状态映射：`src/web-fetch.ts`。
- 离线边界测试：`test/web-search.test.ts`、`test/web-fetch.test.ts`。
- [DeepSeek Search API Reference](https://api-docs.deepseek.com/api/search/)
- [DeepSeek Search & Fetch Guide](https://api-docs.deepseek.com/guides/search/)
- [DeepSeek Fetch API Reference](https://api-docs.deepseek.com/api/fetch/)
- [DeepSeek 官方 Harness Search 适配器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-deepseek-api/src/search.ts)
- [DeepSeek 官方 Harness Search 测试](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-deepseek-api/tests/search.spec.ts)

## 变更记录

- 2026-10-29：首次记录 WEB-01 与 WEB-02。诊断期间未修改实现，未执行真实收费请求。
- 2026-10-29：修复 WEB-01 的 Search 响应适配（见“修复结果”）；Fetch 维持原约束。未执行真实收费请求。
