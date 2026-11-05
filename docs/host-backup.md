# CI-07 主机准备与离线备份

这些入口实现 CI-07 的一部分：主机基线、停止写入后的卷元数据检查与整卷备份。发布验签、生产业务验收和 CD 仍未实现，参见 [实施计划](ci-cd-implementation-plan.md)。所有成功结果保留 `productionAdmission: "not-evaluated"`。

同一主机上的 `test`／`production` 资源隔离、环境描述格式与检查命令见 [部署环境描述](deployment-environments.md)。

## 主机准备

目标为 Linux x86_64，资源基线见 [CLAUDE.md](../CLAUDE.md)。目标机只需 Docker 和常见 Linux 命令，不安装 Node。检查、备份通过镜像中的 Node 与 SQLite 执行。

先审阅并在 Ubuntu 目标机上以 root 运行：

```sh
sudo bash scripts/deploy/install-docker.sh
sudo bash scripts/deploy/host-preflight.sh
```

安装脚本使用 Ubuntu 自带的签名软件源安装 `docker.io`、`docker-compose-v2`，开启 Docker 服务；要求 Engine >= 24、Compose >= 2.24.4，不配置第三方镜像源、不修改安全组、不把用户加入 docker 组。主机检查仅核对 Linux/amd64、Docker、Compose、CPU、可用内存基线及根分区至少 10 GiB 空间；它不检查私有配置、实际卷和真实服务。Docker 官方下载站不可达时不执行远程安装脚本。

## 离线卷元数据检查

以已选定的应用镜像完整 digest 引用执行。应用卷必须已初始化、所有写入者已停止；只读挂载是必需的。不要在应用容器里挂载 Docker socket，也不要对生产卷运行测试 fixture。

```sh
docker run --rm --pull never --network none --read-only --user 0:0 \
  --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges:true \
  --mount type=volume,source=personal-agent-data,target=/app-data,readonly,volume-nocopy \
  --entrypoint node "$APP_IMAGE" dist/src/deployment-volume-preflight.js \
  --app-volume /app-data --inbox-diagnostics
```

工具契约与固定错误码以 [`deployment-volume-preflight.ts`](../src/deployment-volume-preflight.ts) 为准：

- 应用根目录与选定 SQLite 文件属主为 1000；检查服务属主访问权限，拒绝其他用户可写、symlink、特殊文件和超大文件。不递归审计卷内全部文件或 ACL。
- 必须已有应用 `agent.sqlite` 与 `inbox.sqlite`；首次安装空卷不能据此通过。`--inbox-diagnostics` 仅检查有界数量的记录并返回投递分段计数；`sending`／`uncertain`／`failed` 会保留，不阻止保存备份。不执行 `Inbox.recover()`、不改变投递结果、不打印消息或请求标识，计数也不能替代上线前的人工核查。
- 有非空 WAL 时，仅在验证为 Linux 只读挂载后通过 SQLite 的只读连接读取已提交 WAL；无 WAL 时使用 immutable URI 防止生成 SHM。需要恢复写入的状态拒绝，不删除 sidecar、不忽略 WAL、不自动 checkpoint。

预检若报告权限错误，须在确认卷身份、停止写入并保留备份后单独处理，检查命令不会代为修复。

## 整卷备份

`backup-volumes.sh` 要求 Linux 上可访问 Docker、`flock`、GNU `timeout`、`tar`、`sha256sum`，且备份根目录已存在、由调用者拥有、权限 0700。应用镜像必须已在本机，支持完整 digest 引用或本地完整 `sha256:<image-id>`；不会拉取或构建镜像。

先停止写入者，再备份：

```sh
docker compose stop personal-agent
install -d -m 700 /var/backups/aster
bash scripts/deploy/backup-volumes.sh \
  --image "$APP_IMAGE" \
  --app-volume personal-agent-data \
  --backup-root /var/backups/aster
```

脚本先确认已存在的普通 local 应用卷、没有运行／暂停／重启中的消费者，然后在只读卷上执行前述元数据预检。所有来源挂载同时设置 `volume-nocopy`，防止 Docker 在首次挂载空卷时把镜像内容复制进去；只读本身不阻止这种初始化。归档前检查备份目标空间，保留约两倍卷大小加 64 MiB 的余量。归档通过 stdout 流式写入宿主，不把整个卷装进内存；保留隐藏文件、数值属主、SQLite 与 sidecar，校验关键归档条目和 SHA256。归档文件权限 0600，目录 0700。只有全部完成且再次确认写入者仍停止，才生成 `COMPLETE`；失败的部分目录保留供核查，没有该标记不能当作完整备份。

锁仅串行化使用相同备份根目录的本工具调用，不阻止其他 Docker 管理员启动服务；调用期间必须维持停服。脚本不会停服、更新、删除卷、还原数据或自动重试。Docker daemon 级的并发修改仍属于运维边界；无法把检查与归档描述为一个事务。

宿主 `.env` 等配置不包含在卷归档中，仍需按 [运行手册](deployment-test-guide.md#6-备份与还原整个卷) 单独安全备份。卷归档本身含会话与 OAuth 数据，也按秘密材料管理。校验和用于检测损坏，不提供发布者身份认证。

## 隔离演练

`npm run test:topology` 使用合成数据卷验证停止写入后的预检、整卷备份、还原到新空卷、归档与还原数据比较，以及运行中消费者拒绝。独立运维容器为编排演练临时访问 Docker socket；它只在可信 CI 运行，不能部署为应用服务。备份材料只留在该容器 tmpfs，结束删除；固定生产卷不参与。这是同版本重建演练，不证明任意版本升级或数据降级兼容性。

只有 Docker 的 Linux 主机可使用 [`topology-on-docker-host.sh`](../scripts/ci/topology-on-docker-host.sh)。在准备机完成应用镜像和临时运维镜像的构建，将其通过受控渠道导入目标机；目标机不拉取、不构建，运行期间不需要宿主 Node 或 OpenSSL。运维镜像包含 Node、Docker CLI 与 Compose，只用于可信测试环境。此入口有 Docker 管理权限，不得在共享生产主机运行未经审阅的代码。

```sh
# 准备机：基于已选定的应用镜像构建临时运维镜像
# 应用镜像的构建方法见 docs/ci-entrypoint.md
docker build -f scripts/ci/deployment-tools.Dockerfile \
  --build-arg "APP_IMAGE=$ASTER_IMAGE" -t "$ASTER_DEPLOYMENT_TOOLS_IMAGE" .

# 目标机：两个镜像必须已在本机；仅导出公开镜像引用
export ASTER_IMAGE ASTER_DEPLOYMENT_TOOLS_IMAGE
bash scripts/ci/topology-on-docker-host.sh
```

脚本只复制两个公开 Compose 文件和拓扑脚本到独立临时目录，使用相同宿主／容器绝对路径解析 bind mount。外层运维容器使用调用者 UID／GID，并补入 Docker socket 的组 ID，保持宿主私有临时目录可访问；同时使用只读根文件系统、无网络和受限资源，临时生成文件放在单独可写目录。`ASTER_DEPLOYMENT_TOOLS_IMAGE` 使拓扑复用已导入的运维镜像，结束时不会删除调用者提供的镜像。目录和本轮容器／卷在退出时清理；意外 SIGKILL 或断电后须核查残留测试资源。

尚未实现 `deploy.yml` 或自动生产更新。后续必须先完成 CI-06 验签和真实环境准入，再接入更新；不能把离线预检退出 0 当作上线授权。
