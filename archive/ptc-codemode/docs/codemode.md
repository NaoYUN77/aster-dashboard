# 代码调用工具（PTC／codemode）

`codemode` 让模型写一段 JavaScript，在 QuickJS WASM sandbox 中依次调用白名单工具；只有脚本结果回到模型上下文，嵌套工具的结果不进入 transcript。设计取舍见 [ADR-0019](adr/codemode-ptc/0019-codemode-ptc.md)。

## 启用

默认关闭。设置 `CODEMODE_ENABLED=1` 后重启应用；工具和 `codemode` 提示 section 才会出现。未启用时工具面、系统提示和配置返回值都保持原样。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CODEMODE_ENABLED` | `0` | `1` 启用；其他非空值启动失败 |
| `CODEMODE_SCRIPT_FIRST` | 跟随 `CODEMODE_ENABLED` | `1`／`true` 隐藏模型的直接文件与命令工具；`0`／`false` 回滚，空值跟随启用状态 |
| `CODEMODE_TIMEOUT_MS` | `240000` | 单次脚本期限，含嵌套工具时间；范围 1000–300000 |
| `CODEMODE_MEMORY_LIMIT_BYTES` | `134217728` | QuickJS 内存上限；范围 16 MiB–512 MiB |

脚本期限应小于单次请求的 300 秒等待上限；否则请求可能先被整体取消，模型收不到脚本自己的超时结果。

## 脚本能做什么

工具名 `codemode`，参数是 `{ code: string }`。`code` 是 async function body：

```js
const files = await tools.bash({ command: "printf '%s\\n' a b c" });
return files.output;
```

脚本可以使用：

- `await tools.<name>(args)`：调用宿主白名单工具；参数和结果做 JSON 往返。
- `text()`、`image()`、`exit()`：产生显式输出；`console.*` 和顶层 `return` 在普通模式进入结果，在 script-first 成功结果中被忽略（见下）。
- `store()`／`load()`：在同一个会话的多次 codemode 调用之间保存 JSON。
- `ALL_TOOLS`、`searchTools()`、`describeTool()`、`describeNamespace()`：发现脚本可调用的工具。

沙箱不提供文件系统、网络、`process`、`require`、计时器或模块加载。脚本只能通过注入的工具产生副作用。

## 脚本工具白名单

| 执行模式 | 脚本可调用 |
| --- | --- |
| 本地（默认） | `read`、`write`、`edit`、`bash` |
| 远程（`EXECUTION_MODE=remote`） | `read`、`write`、`edit`、`bash` |

限制通过工具注册的 `callers` 实现。白名单只决定哪些工具进入 `agent.callable`，也就是脚本的 `tools.*` 和 codemode section；每次嵌套调用仍经过注册表的名称、状态、authz 和参数校验。模型面的可见性另由下面的 script-first 策略决定。

MCP、记忆、`web_search`／`web_fetch` 和 `tool_search` 不进入 v1 脚本面，继续由模型直接调用。脚本不能用 `codemode` 调用自身。

## Script-first 曝光

`CODEMODE_ENABLED=1` 时默认启用 script-first：`read`、`write`、`edit`、`bash` 不再出现在模型的工具声明中，`codemode` 成为文件读写和命令执行的唯一入口，单步操作也一样。脚本仍可调用这四个工具；隐藏只收窄模型面，不会改变脚本白名单，也不会给任何工具新增脚本调用方。

模型侧的提示建议脚本使用纯 JavaScript（宿主也容忍轻量 TypeScript 类型标注，见下），在脚本内过滤并汇总，用 `text()` 返回结论。工具结果的 `[Full output: path (read with offset/limit)]` 提示应在 codemode 内用 `tools.read({ path, offset, limit })` 分块读取，而不是让整段输出回到上下文。

`CODEMODE_SCRIPT_FIRST=0`（或 `false`）恢复旧行为：模型直接看到并调用这四个工具，codemode 仅用于多步或需要过滤的任务。回滚只影响模型曝光，不改变已有会话记录或脚本白名单。

如果模型仍调用被隐藏的工具（例如旧会话中的调用或模型幻觉），注册表记录一条 `tool_review` 事件（`code=TOOL_NOT_EXPOSED`，`decision=deny`），随后由底座按 `tool_unavailable` 结算；不会执行该工具。

恢复兼容：进程启动时若存在未完成的、由模型发起的 `read`／`write`／`edit`／`bash` 调用，本次进程保留旧工具面，避免把“可能已部分执行”的调用误判为工具不存在；同时只要还有任何 live task，就推迟替换工具扩展，防止改变其注册身份。记录 `TOOL_EXPOSURE_RECOVERY` 后，在任务结束后的下一次空闲重启才应用隐藏。升级时因此可能出现一次额外重启，这是有意的保守行为。

## Loop Guard（有界自主熔断）

宿主对模型发起的工具调用按签名 `(工具名, 规范化参数 JSON)` 做连续计数：对象键排序，JSON 格式化空白不影响签名；`codemode` 的 `code` 先 trim 并把连续空白折叠为一个空格，因此同一脚本重新排版仍算同一调用。

- 连续第 3、4、5 次相同签名：调用照常执行，结果文本末尾追加 `[Loop Guard Warning]: You have made the exact same tool call N times consecutively. ...`。
- 连续第 6 次相同签名：记录 `LOOP_GUARD_HALT` 并取消当前会话运行，本次请求以 `AGENT_LOOP_DETECTED` 失败；第 6 次调用可能已经执行，其副作用不回滚。
- 连续 6 次工具结果为错误（`Error`／`isError`）：同样熔断，原因为 `consecutive_errors`。
- 出现不同签名时相同签名计数从 1 重新开始；成功结果把连续错误计数清零；用户发起下一次请求时两者都从零开始。
- 审计事件 `LOOP_GUARD_WARNING`／`LOOP_GUARD_HALT` 写入 `toolReviewLog`，只含工具名、次数、callId 与原因，不含工具参数。
- 熔断只终止当前运行，不破坏底层 `AgentDoc`／`Session` 持久化；下一次请求可以正常继续。
- 状态按 callId 幂等：同一进程内同一 callId 只计一次，重放不会重复累加；计数不落盘，进程重启后从零开始，不按历史 transcript 重新累计。

脚本内部另有一层：单次脚本执行中连续 6 次相同 `(嵌套工具名, 参数)` 调用会立即拒绝第 6 次并让脚本失败，错误为 `Nested tool loop detected: tool "<name>" called 6 times consecutively with identical arguments`，不必等到 240 秒沙箱期限。嵌套调用不进入上面的模型级计数。

## text() 输出契约

script-first 开启时（`CODEMODE_SCRIPT_FIRST=1`，默认跟随 `CODEMODE_ENABLED`），成功脚本的模型可见结果只包含显式 `text()` 与 `image()`：

- 顶层 `return` 的值被丢弃，`console` 输出在成功时被移除；转换在宿主内、`parseCodemodeSource` 和 QuickJS 之前完成，持久化的工具参数仍是模型原始脚本，跨版本恢复契约不变。
- 成功但没有任何 `text()`／`image()` 时，返回 `[Script finished with no text() output. In script-first mode, return values and raw console logs are not sent to context—call text(summary) explicitly to output your filtered result.]`。
- 脚本失败时保留失败前已产生的 `text()`、`console` 输出与错误堆栈，模型仍能据此修复脚本。
- `exit()` 是显式输出，不受影响；`CODEMODE_SCRIPT_FIRST=0` 恢复 return／console 的旧行为。

## TypeScript 类型标注容忍

在把脚本交给底座解析前，宿主用 Node `stripTypeScriptTypes(..., { mode: "strip" })` 擦除类型标注，支持 `: type`、`interface`、`as` 等纯类型语法。首行 `// @options` 原样保留；顶层 `return` 通过临时函数包装后擦除。擦除失败时回退原代码，由 QuickJS 报告真实语法错误；`import`／`export` 模块语法不受支持，也不会被包装掩盖。类型只在源码擦除阶段存在，运行时仍是纯 JavaScript。

## 输出与资源

- 模型可见的 codemode 结果上限为 32 KiB／1000 行，保留尾部；底座默认的 4 MiB／100000 行被覆盖。
- 脚本可用首行 `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}` 请求更小的预算或更短的期限；最终仍受宿主上限和请求等待约束。
- 每个脚本使用独立的 QuickJS worker；脚本结束或 sandbox 关闭后 worker 退出。
- 嵌套工具调用在宿主侧串行执行；脚本里的 `Promise.all` 不会让多个工具真正并发。
- codemode 调用结束（完成、失败或超时）或取消时，仍在运行的嵌套调用被取消；尚未开始的排队调用不会再启动。

## 远程执行

远程 codemode 的脚本面提供 `bash`、`read`、`write` 和 `edit`。它们都在执行主机的 PTC sandbox 内运行：`bash` 经 `tool.call` 进入 runner，文件工具经 `file.*` 请求访问 `/workspace`、`/tmp` 和显式启用的 `/shared`；控制面不打开这些文件。脚本里的大输出应写到执行主机文件，再用 `read` 或 `bash` 分块处理，而不是尝试整块返回：

```js
await tools.bash({ command: "some-command > /workspace/out.txt" });
text(await tools.read({ path: "/workspace/out.txt", limit: 200 }));
```

结果被截断时会附带说明；这只是提示，不代表控制面保存了完整内容。传输选择与文件边界见 [远程 PTC spec](spec-20261102-remote-ptc-sandbox.md)。

## 失败语义

| 现象 | 含义 |
| --- | --- |
| 脚本语法错误或抛异常 | codemode 返回错误结果，不执行后续调用；已执行的嵌套调用保持其真实状态 |
| 嵌套工具失败 | 脚本收到 reject 或结构化错误；由脚本决定是否继续 |
| 脚本超时 | 到 `CODEMODE_TIMEOUT_MS` 或脚本书写的 `timeout_ms` 后终止；正在运行的嵌套调用被取消 |
| 输出被截断 | 结果尾部保留，附截断说明；远程模式不会生成可读的完整输出文件 |
| 结果上限拒绝 | 脚本本身失败或输出被宿主截断；错误不伪装成成功 |
| 同一脚本内连续 6 次相同嵌套调用 | 第 6 次调用被拒绝，脚本以 `Nested tool loop detected` 失败，不等沙箱期限 |
| 模型级连续 6 次相同调用或 6 次错误 | 当前运行被取消，请求以 `AGENT_LOOP_DETECTED` 失败；会话保持可用 |
| 进程在脚本中途退出 | 底座按 codemode 日志恢复已完成调用；`bash` 等 unsafe 嵌套调用不会自动重跑，未完成结果按未知处理 |

## 恢复边界

codemode 的脚本启动数据、调用日志和输出目录是底座文档，按会话／任务持久化。恢复时脚本从已有日志继续，已完成的嵌套调用返回原结果；重新执行的判断仍遵循每个嵌套工具自己的 replay 策略。

不要把 codemode 当作恰好一次外部副作用：`bash` 仍是 unsafe 工具，崩溃或恢复时未完成的命令可能已经产生副作用。需要幂等的操作由宿主或脚本自行提供稳定标识与核对方式。

## 安全边界

- QuickJS 限制的是脚本运行时的能力，不是操作系统安全沙箱。
- 本地 codemode 的 `bash` 与模型直接调用 `bash` 具有相同的宿主权限；远程 codemode 的 `bash` 和文件工具在 PTC sandbox 内运行。生产环境仍应使用独立低权限用户或容器。
- 脚本由模型生成，属于不可信输入；不能把凭据、宿主路径或服务客户端放进脚本参数。
- 脚本源码和命令会进入 durable 会话记录；敏感值不应出现在其中。

## 非目标

- 脚本内 MCP／Web／记忆工具。
- 并行嵌套调用、脚本递归。
- 控制面读取远程文件；远程文件 API 只在执行 sandbox 内可见。
- 用 codemode 替代 OS 级隔离或命令审计。
