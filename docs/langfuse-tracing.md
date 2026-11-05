# Langfuse Cloud Tracing

第一阶段把一次 Agent 请求及其内部执行导出到 Langfuse Cloud，用于查看耗时、调用层级、模型用量和失败原因。Trace 是诊断数据，不参与会话状态、工具执行、Loop Guard 或 Durable 恢复；关闭或导出失败都不改变 Aster 的业务结果。

实现集中在 [`src/trace.ts`](../src/trace.ts)，使用 Langfuse 官方 SDK 的 OpenTelemetry 处理器，不再写本地 JSONL 文件。

## 追踪范围

一次请求共用同一个 `traceId`，父子关系如下：

```text
agent.request                 agent  （根 span，session = 会话 id）
├── llm.generation            generation（每次模型响应一条）
├── codemode                  tool（一次 codemode 工具调用）
│   ├── codemode.prepared     span（真正交给 QuickJS 的脚本；内容采集开启时含 input）
│   ├── tool.<name>           tool（脚本内的嵌套工具调用，如 tool.read、tool.write）
│   │   └── rpc.<method>      span（远程执行 RPC；本地模式没有）
│   ├── runner.vm             span（远程 QuickJS VM；本地模式没有）
│   └── runner.message        event（有上限）
├── registry.decision         event（工具授权 allow/deny）
└── loop_guard.warning/halt   event（Loop Guard 证据）
```

- `agent.request` 以 durable 会话 id（`root.id`）为 `session.id`，以 `requestId` 区分同一会话的不同请求。
- `codemode` 在工具授权之前创建，因此被拒绝的调用同样可见。
- `codemode` 的 Input 是模型原始提交的 `code` 参数；`codemode.prepared` 的 Input 是预处理后真正交给 QuickJS 的脚本，两者不会混淆。Output 是实际返回给模型的 Tool Result。
- `tool.<name>` 的观测类型是 `tool`，名称来自实际执行的嵌套工具名；Input 为工具名和实际参数，Output 为工具返回给脚本的结果。授权事实仍由 `registry.decision` event 单独记录。
- 上述 Input/Output 只在 `LANGFUSE_CAPTURE_CONTENT` 开启时上传；默认只记录字节数、条目数和错误码。
- `rpc.cancel` 对已结束目标的 `not_found` 是幂等清理，span 以 `ok` + `cancelOutcome=not_active` 结束；真正的取消异常仍为 `error`。
- `rpc.file.canonical` 在新建文件前的 `not_found` 探针以 `ok` + `probe=missing` 结束；权限、传输等非预期错误仍为 `error`。
- `llm.generation` 关联提供商、模型、stop reason 和 token 用量；模型 Prompt 与回复原文不在采集范围内。
- 远端 RPC 请求帧携带 `<traceId>.<spanId>` 形式的 `correlationId`（49 字节），供执行端未来接入同一 Trace；第一阶段所有 span 都由控制面创建。
- 第一阶段只覆盖 codemode 路径；非 codemode 的直连工具目前只有授权 event，没有独立执行 span。

单个 trace 内的活跃请求和 codemode span 各限 256 个，单个 codemode span 的 event 限 256 条；超限时结束最旧 span（标记 `unknown`）或写一条 `events.truncated`，不静默丢弃。

## 配置

所有配置都来自环境变量。未配置时 tracing 完全关闭，不加载处理器、不产生网络请求。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LANGFUSE_PUBLIC_KEY` | 启用时必填 | Langfuse 项目公钥，`pk-lf-...`。 |
| `LANGFUSE_SECRET_KEY` | 启用时必填 | Langfuse 项目密钥。 |
| `LANGFUSE_BASE_URL` | 否 | Langfuse 地址，默认 `https://cloud.langfuse.com`。兼容旧别名 `LANGFUSE_HOST`；两者都设置时以 `LANGFUSE_BASE_URL` 为准。自建或 US 区域时填写实际地址。 |
| `LANGFUSE_TRACING_ENABLED` | 否 | `1`/`true` 强制请求启用；`0`/`false` 在保留密钥的情况下关闭。其他值启动失败。 |
| `LANGFUSE_CAPTURE_CONTENT` | 否 | `1`/`true` 上传 codemode 与嵌套工具的 Input/Output；默认关闭。只建议在个人开发环境开启。其他值启动失败。 |
| `LANGFUSE_TRACING_ENVIRONMENT` | 否 | SDK 透传的环境标签（如 `production`、`test`）。 |

启用规则：

- 公钥和密钥都非空即启用；只配一个视为未配置。
- `LANGFUSE_TRACING_ENABLED=0` 优先级最高，用于临时停用而不删除密钥。
- `LANGFUSE_TRACING_ENABLED=1` 但密钥缺失时，启动日志写一行说明并保持关闭。
- 其余取值（如 `yes`）是配置错误，按现有严格配置约定在启动前失败。

SDK 还会自行读取 `LANGFUSE_FLUSH_AT`、`LANGFUSE_FLUSH_INTERVAL`、`LANGFUSE_TIMEOUT`、`LANGFUSE_OTEL_COMPRESSION` 等批量与超时变量，默认值即可用于当前单机规模。

### 内容采集模式（仅个人开发环境）

需要检查模型实际生成的 JavaScript 和 QuickJS 真实执行结果时，在部署目录的 `.env` 增加：

```dotenv
LANGFUSE_CAPTURE_CONTENT=1
```

重建应用容器后，一次 `codemode → write → read → text()` 会产生：

- `codemode`：Input 是模型提交的原始 `{ code }`，Output 是最终返回给模型的 Tool Result；
- `codemode.prepared`：Input 是经过 TypeScript 剥离、`textOnly` 包装等预处理后真正交给 QuickJS 的 `{ code }`；metadata 的 `scriptChanged` 表明两者是否不同；
- `tool.write` / `tool.read` / `tool.bash`：Input 是 `{ tool, arguments }`，Output 是 `{ isError, structuredOutput }`；
- `registry.decision` 仍是独立的 event，用于证明授权决定，不与执行结果混用；
- `rpc.*`、`runner.vm` 继续存在，用于证明脚本确实在 QuickJS/执行面运行。

不会因为开启采集而改变 `text()` 的输出契约，也不会把 Langfuse 中的中间结果重新注入 LLM Context。采集默认关闭；生产环境保持关闭，只有个人开发调试时临时开启。

在 Langfuse 中的检查步骤：

1. 打开 Tracing，选择最近一次 `agent.request`。
2. 展开 `codemode`，在 Input 中查看模型原始 `code`，在 Output 中查看返回给模型的 Tool Result。
3. 展开 `codemode.prepared`，在 Input 中查看真正执行的脚本；与上一步不同即表示预处理发生了改写。
4. 依次展开 `tool.write`、`tool.read`、`tool.bash`，核对 Input 中的参数与 Output 中的返回结果。
5. 对照 `registry.decision` event 与对应 `tool.*` observation：前者是授权决定，后者是真实执行。
6. 确认没有任何 `Authorization`、token、secret 或 API key 原文；超长内容应显示截断标记。

## 隐私边界

默认（`LANGFUSE_CAPTURE_CONTENT` 未开启）不上传：

- 用户消息、模型回复、thinking、工具参数、脚本体、命令、文件内容、路径字符串、错误消息原文；
- 任何凭据或认证头。

默认只上传宿主已知的边界信息：

- 会话 id、请求 id、task/call/session/job id；
- 字节长度（`textBytes`、`scriptBytes`、`argsBytes`、`contentBytes` 等）、条目数、token 用量、耗时；
- 工具名、模型/provider 名称、stop reason、错误码、授权决定；
- span 结果（`ok`/`error`/`aborted`/`halted`/`unknown`）。

开启 `LANGFUSE_CAPTURE_CONTENT=1` 后，额外上传：

- `codemode` 的 Input：模型原始 `code` 参数；Output：实际返回给模型的 Tool Result；
- `codemode.prepared` 的 Input：预处理后真正交给 QuickJS 的脚本；
- `tool.<name>` 的 Input：工具名与实际参数；Output：工具返回给脚本的结果（文本内容或结构化值）。

即使用内容采集，也不会上传：

- 用户消息、模型回复、thinking；
- 图片二进制（只保留 `type`）；
- `Authorization`、`Cookie`、token、secret、password、API key 等凭据键及常见凭据形态；
- 超过上限的内容。

限制：

- 单个字符串字段最多 32 KiB，超出部分以 `…[truncated N bytes]` 标记；
- 单条 observation 的 Input 或 Output 序列化后最多 64 KiB，超出时保存 `truncated`、`originalBytes` 和 `preview`；
- 对象最多保留 100 个键或数组项，嵌套深度最多 6 层。

采集只读取现有参数和结果用于导出，不改变 PTC 的 `text()` 契约、工具返回值或 LLM Context。Langfuse 中的中间结果不会重新进入对话。

实现上不设置模型消息的 `input`/`output`，媒体上传显式关闭（`mediaUploadEnabled: false`）；metadata 只从固定字段构造，不序列化消息对象。

## 失败隔离

- 处理器或 provider 构造失败：写一行日志，tracing 关闭，进程继续。
- span 创建、更新、结束或导出失败：写一行固定前缀的日志（只含错误类型名），不向工具、hook、RPC 或关闭路径抛错。
- 关闭时先结束遗留 span，再在 5 秒超时内 flush；超时或异常都只记日志。

因此 Langfuse 不可达、密钥失效或账号限流时，Telegram 消息仍正常回复，durable 状态不受影响。

## 部署

### 直接使用密钥（非 MITM 模式）

在部署目录的 `.env` 增加：

```sh
LANGFUSE_PUBLIC_KEY=<langfuse-public-key>
LANGFUSE_SECRET_KEY=<langfuse-secret-key>
# 可选
# LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
# LANGFUSE_TRACING_ENVIRONMENT=production
```

```sh
docker compose up -d --force-recreate personal-agent
docker compose logs --tail=50 personal-agent
```

日志应无 `Langfuse tracing disabled`。若出现该行，按提示检查密钥或地址。

### MITM（OpenBao 占位符）模式

生产部署的 `.env` 只保留占位符，真实密钥由 OpenBao 提供。Langfuse SDK 在发出 OTLP 请求前把 `publicKey:secretKey` 编码进 `Authorization: Basic`；`aster-mitm` 的占位符策略会先解码 Basic 凭据，按 allowlist 替换其中的占位符，再重新编码后转发。因此 Langfuse 密钥与其他密钥一样走 OpenBao，不需要明文写入 `.env`。

OTLP 导出器默认自建 keep-alive agent，不会继承 Node 的全局代理配置。`src/trace.ts` 在检测到 `HTTP(S)_PROXY` 时用同一组 Langfuse 地址和认证头构造支持 `proxyEnv` 的导出器，使 Langfuse 请求和其他出站请求一样经过 `aster-mitm`；`NO_PROXY` 仍按 Node 的规则生效。

`.env`：

```dotenv
# 公钥不是秘密，可明文保留；要统一由 OpenBao 管理也可写成 __vault_LANGFUSE_PUBLIC_KEY__
LANGFUSE_PUBLIC_KEY=<langfuse-public-key>
LANGFUSE_SECRET_KEY=__vault_LANGFUSE_SECRET_KEY__
```

部署顺序：

1. 更新并重启 MITM，使 Basic 解码生效（`vault_placeholders.py` 已包含该逻辑）：
   ```bash
   cd ~/Aster/deploy/openbao-mitm
   docker compose up -d --force-recreate mitm
   ```
2. 把真实 secret key 写入 OpenBao；已有条目会保持不变，可重复执行：
   ```bash
   ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao ./bootstrap.sh LANGFUSE_SECRET_KEY
   ```
3. 按 MITM 迁移步骤把 `.env` 改为上面的占位符，再重建应用容器。

边界：

- `allowlist.json` 已为 `LANGFUSE_PUBLIC_KEY` 与 `LANGFUSE_SECRET_KEY` 列出 `cloud.langfuse.com` 和 `us.cloud.langfuse.com`。使用自建 Langfuse 或其他区域时，加入实际 host 的精确匹配；不做后缀或通配匹配。
- 代理模式使用自建 OTLP 导出器，`LANGFUSE_OTEL_COMPRESSION` 不再生效（请求默认不压缩）；批量条数、flush 间隔和 `LANGFUSE_TIMEOUT` 仍按 Langfuse SDK 的变量处理。
- 只有当解码后的凭据里出现占位符时才改写 `Authorization`；普通 Basic 凭据原样转发。
- 未知占位符或 host 不匹配仍使整条请求返回 403，且不会部分替换。
- MITM 只解码 `Basic`；其他认证方案中的编码值不会尝试识别。

### 关闭与轮换

- 临时关闭：设置 `LANGFUSE_TRACING_ENABLED=0` 并重启。
- 彻底关闭：删除两个密钥变量并重启。
- 轮换：在 Langfuse 控制台创建新密钥，更新 `.env`（MITM 模式则更新 OpenBao 条目）后重启；旧密钥可立即吊销。轮换期间丢失的 trace 不影响业务。

数据写入 Langfuse Cloud，不进入 `DATA_DIR`，备份与恢复流程不涉及 Trace。

## 第一条真实 Trace 验收

前置：已完成上面的部署，密钥有效，容器可以访问 Langfuse 主机。

1. **确认启动未降级**

   ```sh
   docker compose logs personal-agent | grep -i langfuse
   ```

   预期没有输出，或只有你主动设置的启用/关闭说明；不应出现 `Langfuse tracing disabled`。

2. **产生一次包含工具调用的请求**

   用 owner 的 Telegram 账号私聊 bot，发送需要读取或计算的消息，例如：

   ```text
   用 codemode 执行：读取当前工作目录下的 package.json，返回 name 字段。
   ```

   等待 bot 正常回复。回复本身应与未开启 tracing 时一致。

3. **在 Langfuse 找到该 Trace**

   打开 Langfuse 项目的 Tracing 页面，按最近时间排序；根 observation 名为 `agent.request`，`Session` 等于该 Telegram 会话对应的 durable 会话数字 id。

4. **核对层级**

   - `agent.request` 下至少有 1 条 `llm.generation`；
   - 触发 codemode 时存在 `codemode` 子 span，其下为 `tool.read`、`tool.write` 或 `tool.bash` 这类实际工具 observation；
   - 每个工具 observation 都有正确的父 span、`outcome` 和 `durationMs`；
   - 远程执行模式下继续出现 `rpc.*` 和 `runner.vm`，且与调用方共用同一 `traceId`；
   - `registry.decision`、`loop_guard.*` 作为 event 出现在对应父 span 下。

5. **核对隐私**

   默认配置下，打开根 span 和 `codemode` span 的 Input/Output：应为空。Metadata 中只应看到 id、长度、计数、工具名、模型名、错误码等边界字段；不应出现消息原文、脚本体、命令或文件内容。

   开启 `LANGFUSE_CAPTURE_CONTENT=1` 时，`codemode` 与 `tool.*` 的 Input/Output 会显示脚本、参数和工具结果；此时仍需确认根 span 没有消息原文，且凭据已替换为 `[REDACTED]`、超长内容带截断标记。

6. **核对失败隔离**

   临时把 `LANGFUSE_SECRET_KEY` 改成无效值并重启，再发送一条消息。预期：

   - bot 仍正常回复；
   - 日志最多出现 `Langfuse tracing failed: ...`（或 SDK 的导出告警），进程不退出；
   - 恢复正确密钥并重启后，新请求重新出现在 Langfuse。

7. **核对正常结束**

   等待一次请求完成后刷新 Langfuse：根 span 应已结束并带 `outcome`、`durationMs`；不应长期停留在进行中。进程正常退出时，未结束的 span 会以 `unknown` + `abandoned` 结束，而不是丢失。

## 已知限制

- 第一阶段只覆盖控制面；执行端（远端 VPS）不独立产生 span，跨机关联依赖 RPC 帧里的 `correlationId`。
- 没有采样配置和本地缓冲；导出失败即丢弃该批 span，后续请求继续尝试。
- `LANGFUSE_TRACING_ENABLED` 之外的新变量沿用 SDK 默认解析；需要调整批量行为时参考 SDK 文档。
