# ADR-0005：删除 Agent Vault，部署收成单个应用服务

- **状态**：Accepted
- **日期**：2026-10-28

## 上下文

仓库曾经包含 Agent Vault、出口路由器和多份 Compose overlay。PR #23（合并提交 `bccba8b`）记录的事实是：这条注入链从未在真实环境启用，因为凭据源 Infisical 云在正式部署的腾讯云（中国区）不可达。同日已决定正式部署改用受限环境变量（当时的 `AGENT_VAULT_ENABLED=0`），并进一步把 Vault 代码删掉。

## 决策

删除 Agent Vault、Go 出口路由器和 vault／router Compose。运行拓扑只保留一个 `personal-agent` 服务。凭据放在受限 env 文件里，应用只做存在性和形状校验。`TELEGRAM_OWNER_ID` 使用内联值，不再从 vault 私有目录读文件。

## 备选方案

- **保留代码但默认关闭。** PR 说明里写的是先改成 `AGENT_VAULT_ENABLED=0`，随后仍选择删除，以免维护一套不会启用的子系统。仓库没有记录保留关闭代码的费用数字。
- **换成另一家可从中国区访问的密钥托管。** PR #23 没有比较其他厂商或价格，只记录 Infisical 云不可达，以及删除后的部署形态。

## 后果

- 少维护 broker、路由器、Go job 和多服务网络。CI 不再跑这些检查。当前 `.github/workflows/ci.yml` 是 Node job 加单服务镜像检查。
- 失去的是 Vault 注入、出口路由和当时的多服务隔离。应用直接持有 env 里的 bot token 和模型 key。
- `release-preflight` 的通用文件字节绑定与 broker 无关，PR 说明写明保留。
- 历史验收文档里的 Vault 字样按 PR 说明保留为当时记录，不表示现行拓扑。
