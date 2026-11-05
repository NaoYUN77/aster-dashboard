# 投递核查与补发

网络超时可能发生在 Telegram 已经收到消息之后。结果未知的发送不会自动重发，也不会为了补发而重新执行 agent。取舍见 [ADR-0007](adr/0007-delivery-not-exactly-once.md)。

先停应用，再查看待核查分段：

```sh
npm run deliveries -- list
```

核对 Telegram 实际收到的内容后二选一。这两条命令只改本地投递状态；重启应用后才继续发送：

```sh
npm run deliveries -- retry telegram:123:456 1   # 确认需要重发该分段（可能与已送达的重复）
npm run deliveries -- sent telegram:123:456 1    # 已确认该分段送达，继续后面的分段
```

把示例里的 `telegram:123:456` 和分段号换成 `list` 输出的请求 id 与 part。

容器里的等价命令、停服顺序和 `sending` 在强杀后变成 `uncertain` 的行为见 [部署指南](deployment-test-guide.md) 第 5 节。
