# ADR-0011：Telegram 用长轮询，不开公网 webhook

- **状态**：Accepted
- **日期**：2026-10-21

阅读说明（2026-10-30）：下文的早期 MVP 范围属于决策背景；入口与用户模型的扩展按 [临时 spec 约定](../README.md#按功能的临时规格) 推进。本篇仍定义现行 Telegram 长轮询方式，改变该方式时记录后继 ADR。

## 上下文

当时的交付设计采用 Telegram 长轮询，不要求对公网开放 webhook。实现在 `src/telegram.ts`：`getUpdates` 长轮询，启动时如果 bot 已有 webhook URL，直接拒绝启动。每次最多取 10 条 update。

## 决策

生产入口是所有者私聊的长轮询。服务器不需要为 Bot API 暴露入站端口。已配置 webhook 的 bot 必须先在原处停用，否则本进程不起。

## 备选方案

- **公网 webhook。** MVP 范围写的是不要求公网入口。仓库没有记录证书、入站端口或 webhook 与长轮询的费用对比。
- **同时允许 webhook 和长轮询。** 代码在 webhook 仍有效时拒绝启动。文档写明同一个 bot token 不能有两个轮询实例，否则会抢更新。没有记录双实例造成的具体账单。

## 后果

- 进程必须保持轮询。停机期间更新留在 Telegram，恢复后按 offset 继续。这不是长期离线收件箱。
- 中国区主机如果直连不到 `api.telegram.org`，可以用 `TELEGRAM_API_ROOT` 指到 https 反向代理。仓库没有把某次部署的代理地址写进决策。
- Compose 不发布应用端口。这和「不接公网 webhook」一致，但不是网络隔离的完整证明。
