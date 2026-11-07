# archive/ptc-codemode — 已停用的 PTC / Code Mode 子系统

**状态：已停用、非功能、不参与构建。**

本目录是 PTC（Programmatic Tool Calling，模型写 JavaScript 在 QuickJS WASM
沙箱里编排嵌套工具调用，即 `codemode` 工具）及其远端执行沙箱的历史快照。
自本次整理起：

- PTC / code mode **不再是 Aster Dashboard 的功能**：没有工具、没有配置项、
  没有能力开关、没有启动路径，也不会注册到模型可见的工具目录。
- 目录内的 `.ts` 文件不在 `tsconfig.json` 的 `include`（`src/**/*.ts`、
  `test/**/*.ts`）范围内，**不会被编译、不会被执行、不会被测试运行器加载**，
  也不作为任何运行时模块的依赖。保留它们只为代码审阅与历史追溯。
- 目录内的文档是历史记录（含当时 Accepted 的 ADR），**不是当前架构说明**。
  当前执行面以 `docs/runbook-shared-execution-host.md` 为准。

## 目录内容

| 路径 | 内容 |
| --- | --- |
| `src/` | 控制面 code mode 宿主、远端 PTC Gateway、会话与持久化文档族、执行环境适配 |
| `src/execution/` | bwrap / cgroup v2 隔离、PTC executor、QuickJS runner 及其 stdio 协议、旧 `DirectExecutor` |
| `test/` | 上述功能的专项测试与夹具 |
| `docs/` | 专项设计文档、spec、runbook、验收记录，以及 ADR-0019 / ADR-0020 |

这些文件保持移入时的原文；相对 import 路径因此**不再指向有效目标**，这是刻意的，
不要"修好"它们，也不要在 `src/` 或 `test/` 里重新引用本目录。

## 哪些 PTC 名字的代码没有移进来，为什么

Phase 1 的共享 CVM 执行主机（`EXECUTION_AGENT_SHARED_HOST=1`，Bash / Read /
Write / Edit）复用了几项当年以 `ptc-` 命名的**通用执行原语**。它们不是 PTC
功能，删掉会切断生产链路，因此保留在 `src/execution/`，并改成中性名字：

| 原文件 | 现文件 | 用途 |
| --- | --- | --- |
| `src/execution/ptc-fs.ts` | `src/execution/file-service.ts` | 会话虚拟根下的文件原语（`file.*`） |
| `src/execution/ptc-host.ts` | `src/execution/direct-host.ts` | `DirectHost` 接口与失败类型 |
| `src/execution/file-requests.ts` | 同名保留 | `handleFileRequest()` 分派 |
| `src/execution/direct-executor.ts` 的 `clampWindow()` | `src/execution/output-window.ts` | 输出窗口钳制 |

`src/execution/rpc-protocol.ts` 中的 `vm.start` / `vm.reply` / `vm.message` /
`tool.call` / `tool.output` 是**版本化 wire 契约的一部分**，仍保留在协议解析层；
服务端对这些方法一律显式返回 `not_implemented`，不再有实现、不再启动 VM，
也不再暴露任何客户端调用入口。保留枚举值是为了不改动既有 mTLS RPC 的帧格式，
不是为了保留功能。

## 恢复条件

若将来要重新启用 PTC，需要一次完整的、单独评审的改动：把这些文件移回
`src/` / `test/`，重新接线配置、能力清单、工具目录、agent 注册表与执行面启动，
补齐测试，并重新核对本仓库所有安全边界。**仅把文件复制回 `src/` 不足以启用，
也不会通过类型检查。**
