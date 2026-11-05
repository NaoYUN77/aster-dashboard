# 部署环境描述与检查（阶段 A 配置基础）

日期：2026-10-27。状态：配置与离线／只读检查已实现；测试实例启停／重置、同机并行运行证据与真实凭据核对尚未实现。2026-10-28 更新：随 Agent Vault 子系统整体移除，环境描述与检查已简化为单服务拓扑（只有 `personal-agent`），原 broker、网络与私有目录字段一并删除。

本文是 `test`／`production` 两个部署环境的公开资源身份和检查入口的唯一说明。字段语义以 [`src/deployment-environment.ts`](../src/deployment-environment.ts) 的 TypeBox schema 为准；其他文档引用本文件，不另列一份参数清单。

## 职责划分

| 内容 | 权威来源 | 是否进入仓库 |
| --- | --- | --- |
| 公开部署参数（项目名、应用卷名、bot 标识） | 一份环境描述 JSON，经 `deployment-environment` schema 校验 | 只有 `deploy/environments/*.example.json` 占位示例 |
| 宿主私有配置（应用 env 文件中的凭据） | 目标机部署目录，权限受限 | 否 |
| 镜像与 Compose 字节 | 发布清单与后续版本化发布契约 | 是 |

环境描述只包含标识与资源名，不含任何凭据。`identity.botId` 是 Telegram bot 的数字用户 ID，属于标识而非秘密；它让离线检查拒绝两个环境消费同一个 bot。真实 bot 身份与凭据作用范围需要可信适配层核对（阶段 A2），本文件描述的检查不能代替。

## 描述格式

完整字段见 `EnvironmentSchema`，示例见 [`deploy/environments/test.example.json`](../deploy/environments/test.example.json) 与 [`production.example.json`](../deploy/environments/production.example.json)。要点：

- `schemaVersion: 1`、`kind: "aster.deployment-environment"`；未知字段被拒绝。
- `environment` 只能是 `test` 或 `production`。
- `composeProject` 是小写 Docker 项目名；`volumes.app` 是显式卷名，不由 Compose 从项目名派生。`docker-compose.yml` 中该卷的 `name` 由 `ASTER_APP_VOLUME` 插值，缺省为已部署环境在用的 `personal-agent-data`。
- 描述不再包含网络、broker 或宿主私有文件字段：单服务拓扑使用 Compose 默认网络，应用不发布任何端口，凭据只存在于部署的 env 文件中。

实际描述放在目标机（例如 `/srv/aster/<environment>/environment.json`），不提交到仓库；示例文件中的卷名与 bot ID 都是占位值。

## 检查入口

```sh
npm run build
npm run deployment:environment -- <command> [options]
```

| 命令 | 作用 |
| --- | --- |
| `render --environment <file>` | 用描述派生 `ASTER_*` 插值，渲染 Compose 并逐项核对 |
| `host --environment <file> [--volumes absent\|present\|any]` | 只读查询 Docker，报告宿主资源冲突 |
| `compare --first <file> --second <file>` | 拒绝会在同一主机上冲突的两个环境 |

所有命令只读。`render` 在临时目录写一个仅含资源名的 env 文件，调用 `docker compose config --format json`，不创建容器、网络或卷；`host` 只执行 `docker ps`／`volume inspect`。成功输出固定带 `productionAdmission: "not-evaluated"`。

`--volumes absent` 用于首次安装（项目不得有任何容器，目标卷必须不存在），`present` 用于更新（项目不得有运行中的容器，卷必须已存在且无任何消费者）。更新预检应在停止写入者之后运行。已存在的生产卷不会被静默改名、迁移或接管。

## 渲染核对内容

`render` 不信任 Compose 插值结果，渲染后逐项比较：

- 项目名与应用卷的显式名称；服务集合必须恰好只有 `personal-agent`，`/data` 必须挂载该卷。
- 不得出现具名网络（只有 Compose 隐含的默认网络），任何服务不得发布端口。
- 边界不回退：`cap_drop` 含 `ALL`、`no-new-privileges` 在位、应用不使用共享网络命名空间（`network_mode` 必须缺省）。

## 失败码

检查只输出固定错误码，不回显路径、渲染值、环境内容或 daemon 输出。

| 前缀 | 含义 |
| --- | --- |
| `ENVIRONMENT_*` | 描述本身：过大、JSON 非法、重复键、schema 不符、不可读、非普通文件、资源重叠 |
| `RENDER_*` | 渲染结果与描述不符：项目／卷／网络／已发布端口／服务集合／边界；`RENDER_COMPOSE_FAILED` 表示 Compose 本身未能渲染，而不是渲染结果不符 |
| `HOST_*`／`PROJECT_*`／`VOLUME_*`／`DOCKER_UNAVAILABLE` | 宿主上已有资源冲突或无法查询 |
| `ARGUMENTS_INVALID` | 命令或参数不合法 |

## 与 Compose 的关系

`docker-compose.yml` 中唯一由描述驱动的插值是 `ASTER_APP_VOLUME`（对应 `volumes.app`）；其余资源（服务名、卷键名）是模板固定值，由 `render` 按固定值核对。修改卷名必须通过 `render` 检查，不能只改 Compose 或只改描述。

## 尚未实现

- 测试实例启停／重置入口、合成生产哨兵隔离演练、两环境真实 Linux 并行运行证据（PR A2）。
- 真实 bot 身份与凭据作用范围的可信核对。
- 宿主资源检查不验证凭据、策略内容、签名或业务就绪；`host` 通过只说明当前查询结果没有冲突。
