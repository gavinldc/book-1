# Cloudflare 出海游戏后端实战

TypeScript 全栈，用 Workers + Durable Objects 搭建出海游戏后端。

本书只讲后端：账号、房间对战、匹配、排行榜、支付、LiveOps、埋点与上线。客户端不在范围内，仓库里的最小客户端只用于联调演示。

> 写作中。章节状态见下表。

## 适合谁读

- 想用 Serverless 低成本做游戏后端的独立开发者和小团队
- 熟悉 TypeScript，想了解 Durable Objects 在游戏场景怎么用的后端工程师

## 目录

### 第一部分：起步

| 章 | 标题 | 状态 |
|---|---|---|
| 1 | [为什么用 Cloudflare 做游戏后端](book/01-why-cloudflare.md) | 初稿 |
| 2 | [工程搭建](book/02-project-setup.md) | 初稿 |
| 3 | [存储选型](book/03-storage.md) | 初稿 |

### 第二部分：核心系统

| 章 | 标题 | 状态 |
|---|---|---|
| 4 | [账号与鉴权](book/04-auth.md) | 初稿 |
| 5 | [房间与实时对战](book/05-rooms-realtime.md) | 未开始 |
| 6 | [匹配与异步 PVP](book/06-matchmaking-async-pvp.md) | 未开始 |
| 7 | [排行榜与社交](book/07-leaderboard-social.md) | 未开始 |
| 8 | [经济系统与支付](book/08-economy-payments.md) | 未开始 |

### 第三部分：运营与上线

| 章 | 标题 | 状态 |
|---|---|---|
| 9 | [LiveOps](book/09-liveops.md) | 未开始 |
| 10 | [埋点与可观测](book/10-observability.md) | 未开始 |
| 11 | [安全与合规](book/11-security-compliance.md) | 未开始 |
| 12 | [压测、账单与上线复盘](book/12-launch-retro.md) | 未开始 |

### 附录

- [A　Cloudflare 各产品限额速查表](appendix/a-cloudflare-limits.md)
- [B　协议与错误码约定](appendix/b-protocol-conventions.md)

## 示例项目

见 [examples/](examples/README.md)。

## 许可

文字 CC BY-NC-SA 4.0，代码 MIT，详见 [LICENSE.md](LICENSE.md)。
