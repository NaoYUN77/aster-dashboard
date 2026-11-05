# ADR-0012：受支持的安装方式是 Docker，systemd 只留迁移

- **状态**：Accepted
- **日期**：2026-10-27

## 上下文

提交 `49eb169` 的说明是用 Docker 镜像和 Compose 替换 systemd 部署，并加上校验这些镜像的 CI。当时的镜像集合还包括后来被 ADR-0005 删除的 Vault 和路由器。现行部署指南写明：生产交付是 Docker，服务器需要 Docker Engine 24+ 和 Compose 2.24.4+，不需要主机上的 Node.js。systemd unit 和安装脚本已从仓库删除，只保留迁移步骤。

## 决策

新的安装和更新走镜像与 `docker-compose.yml`。数据在命名卷里。旧的 systemd 数据目录只通过部署指南第 7 节导入，不再作为安装方式。

## 备选方案

- **继续维护 systemd unit。** 部署指南和 `docs/mvp-execution-plan.md` 写明该入口已退役。仓库没有记录两套安装方式并存的维护成本数字。
- **在生产主机上 `npm install` 后直接跑 Node。** 部署指南写的是生产不在服务器上临时构建，主机不需要 Node。没有和 Docker 的费用对比。

## 后果

- 主机只需 Docker。应用用户、内存和进程上限写在镜像和 Compose 里。
- 更新依赖镜像引用。`down -v` 会删掉数据卷，指南禁止拿它当普通停服。
- 提交 `49eb169` 里的多镜像拓扑已被 ADR-0005 取代。本篇不把那些镜像继续当成现行交付物。
