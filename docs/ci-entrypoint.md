# CI 运行入口

设计与进度见 [CI/CD 实施计划](ci-cd-implementation-plan.md)。这些检查使用虚构凭据，不读取生产数据卷，也不联系真实 Telegram 或模型服务。

## 基础栈拓扑

基础栈验收由 `compose-topology.mjs` 和 `topology` 系列脚本运行 `docker-compose.yml`（叠加 `docker-compose.build.yml`）与最终应用镜像：

```sh
docker build -t aster:ci .
npm run test:topology
```

仅检查 Compose 渲染及边界，不启动镜像：

```sh
npm run test:topology -- --render-only
```

镜像可通过 `ASTER_IMAGE` 与 `ASTER_DEPLOYMENT_TOOLS_IMAGE` 指定，默认均为 `:ci` tag。脚本使用独立临时项目与卷，不读取生产 `.env` 或生产卷。

只有 Docker 的 Linux 主机可通过 `bash scripts/ci/topology-on-docker-host.sh` 在临时运维容器里执行同一组检查，要求显式设置 `ASTER_IMAGE` 与 `ASTER_DEPLOYMENT_TOOLS_IMAGE`，镜像须已导入本机。准备方法和隔离限制见 [主机演练入口](host-backup.md#隔离演练)。直接运行 Node 入口时，若未提供运维镜像则自动构建本轮临时运维镜像；提供时只复用，不拉取、不重建或删除该镜像。

验收内容：渲染恰好一个 `personal-agent` 服务、无具名网络与发布端口、应用卷名与 `/data` 挂载正确、安全边界（`cap_drop: ALL`、`no-new-privileges`、无 `network_mode`）成立；缺少 provider key 时容器启动失败且输出不回显凭据值；同卷第二实例被 flock 拒绝；合成数据卷的停止写入预检、整卷备份与还原彩排通过；容器日志不含合成凭据。

未覆盖真实 Telegram／模型链路、发布与生产准入。失败时只输出失败步骤名与阶段标识，不输出容器日志、环境、断言值或响应正文；排查需自行复现，不能把日志上传当作诊断捷径。

## 离线发布清单绑定预检（CI-07 基础）

`npm run release:preflight` 是只读、离线的发布材料一致性检查，要求 Node.js（版本见 `.node-version`）及本地已安装的项目依赖；可在交付准备机运行，不改变目标服务器只需 Docker 的部署基线。它不运行 Docker、Compose、Git 或外部程序，不读取环境里的镜像变量和数据卷，不拉取镜像、不联网、不写部署文件。这里的策略文件由调用者显式选择，工具只绑定其原始字节摘要，不解释内容。

版本化 JSON 契约的权威来源是 [`ReleaseManifestSchema`](../src/release-manifest.ts)。v1 的 `kind` 固定为 `aster.release-bindings`，表示完整发布清单的绑定基础；未来签名、扫描与验收证据需要单独定义和验证，不能往 v1 填入 `signatureVerified`、`accepted` 等字段冒充完成。所有层级拒绝未知字段，JSON 重复键（含转义后同名）也拒绝。

清单形状如下；尖括号为必须替换的占位说明，不能原样通过校验：

```json
{
  "schemaVersion": 1,
  "kind": "aster.release-bindings",
  "sourceCommit": "<40 位小写十六进制 Git commit>",
  "platform": "linux/amd64",
  "images": {
    "app": "ghcr.io/<owner>/aster@sha256:<64 位小写十六进制>"
  },
  "compose": [
    { "path": "docker-compose.yml", "sha256": "sha256:<64 位小写十六进制>" }
  ],
  "policy": { "sha256": "sha256:<64 位小写十六进制>" }
}
```

摘要计算对象是本地文件的**完整原始字节**，不规范化换行、不解析 YAML、不展开 Compose 环境变量。Compose 仅支持 `docker-compose.yml` 一份文件，不接受 build override、其他部署模式或清单提供的任意路径。策略对象没有路径字段；本地路径只来自 `--policy`。文件必须是普通文件，清单上限 64 KiB，单份 Compose／策略上限 1 MiB；策略不能为空。使用 POSIX 命名管道等特殊文件也会拒绝。清单编码限定严格 UTF-8，无 BOM。

[部署环境描述](deployment-environments.md)不属于 v1 绑定范围：v1 语义保持不变，也不会因为文件出现在仓库里就被视为已绑定。把它们纳入发布材料需要新的版本化契约（阶段 B）。

从独立、可信的交付选择中取得预期 commit 和应用镜像完整引用，再显式传入（以下变量需由运维自行设置，不从待检查清单提取）：

```sh
npm run release:preflight -- \
  --manifest /staging/release.json \
  --compose-root /staging/checkout \
  --policy /staging/selected-policy.yaml \
  --commit "$EXPECTED_COMMIT" \
  --app "$APP_REF"
```

应用镜像必须使用显式 DNS registry（可带 1–65535 端口）及无 tag 的 `repository@sha256:<digest>`，例如 `ghcr.io/team/aster@sha256:…`；拒绝裸 digest、本地 tag、隐式 Docker Hub、带 tag 的 digest 引用及 URL。核对的是**完整引用**，相同 digest 换仓库也失败。`sourceCommit` 与调用者预期值比较，不证明本地 checkout 或镜像由该提交构建。`platform` 仅限定清单声明为当前支持的 `linux/amd64`，不证明镜像平台。把预期引用从同一份未受信清单复制出来无法提供独立核对。

通过时退出 0，并输出：

```json
{"status":"offline-bindings-ok","productionAdmission":"not-evaluated"}
```

失败时退出 1，仅输出固定 `code`，例如 `MANIFEST_INVALID_SCHEMA`、`COMMIT_MISMATCH`、`IMAGE_APP_MISMATCH`、`COMPOSE_0_DIGEST_MISMATCH`、`POLICY_UNREADABLE`、`POLICY_DIGEST_MISMATCH`；不回显输入内容、路径或底层异常。`--help` 只展示用法，不执行检查。

此结果只证明本次读取的材料绑定一致。策略内容视为不透明字节：任意非空文件即使摘要匹配，也不能证明其内容满足任何安全要求。缺失策略文件会失败，没有“跳过策略”选项；测试中的合成策略仅用于验证摘要绑定。

该工具还不验证清单或镜像签名、发布者身份、registry 内容／平台、同产物验收证据、SBOM／扫描，不证明当前环境实际使用该镜像引用；也不检查卷权限、备份、单实例更新及业务就绪。独立的卷元数据检查与整卷备份入口见 [CI-07 主机准备与离线备份](host-backup.md)，不改变此工具的离线绑定职责。调用后文件仍可能变化，不提供部署锁或事务。后续 CD 必须在完成验签与其他准入关卡后，使用相同材料和引用并防止检查后被替换；退出 0 不能直接作为生产 `up` 的授权。CI-06 和完整 CI-07 保持待完成。

测试随 `npm test` 执行；单独运行：

```sh
npx tsx --test test/release-preflight.test.ts
```

## GitHub Actions

`ci.yml` 包含 Linux Node 与最终镜像 jobs。它不发布镜像、不部署，也不持有生产 secrets。最终镜像 job 构建应用镜像、运行 Linux 卷权限及独立只读 WAL 检查，最后构建临时运维镜像并通过 Docker 主机入口执行拓扑检查。构建、检查或网络依赖失败均保留失败状态，不使用 `continue-on-error` 放行。
