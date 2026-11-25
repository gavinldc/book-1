# 附录 B　协议与错误码约定

> 对照示例项目整理的日期：2026-11-25

这份附录把散在各章的接口、消息格式、错误码和各种命名约定汇总成一份参考。它描述的是示例项目在第 12 章结束时的样子。正文里讲过"为什么这样设计"的地方，这里只给结论和章节号。

## B.1 通用约定

**请求和应答都是 JSON。** 请求体不超过 8 KB，必须是一个对象。出错时应答的形状固定：

```json
{ "error": "错误码" }
```

错误码是固定的小写下划线英文，客户端按它来分支，不要去匹配给人看的文字。完整的列表见 B.6 节。有两类应答不是这个形状：WebSocket 握手被房间或匹配对象拒绝时（客户端读不到正文，只看状态码，见 B.4 节），以及给第三方平台看的回调应答（B.5 节）。

**身份放在请求头里。** 需要登录的接口带 `Authorization: Bearer <访问令牌>`。访问令牌 15 分钟过期，过期后用刷新凭证换新的（第 4 章）。玩家是谁只从令牌里取，接口不接受客户端另外传入的玩家 ID。

**每个应答带请求编号。** 应答头 `X-Request-Id`。服务端内部出错时，应答体是 `{ "error": "internal", "requestId": "…" }`，客户端显示错误时把编号一起显示出来（10.3 节）。

**状态码的含义：**

| 状态码 | 含义 | 客户端怎么办 |
|---|---|---|
| 200 | 成功 | |
| 202 | 已受理，在后台处理 | 不用等结果 |
| 304 | 内容没有变化 | 继续用本地缓存的 |
| 400 | 请求的格式不对 | 是客户端的缺陷，不要重试 |
| 401 | 没有令牌，或者令牌无效、已过期 | 刷新令牌后重试一次；仍然 401 则重新登录 |
| 403 | 有身份，但不允许 | 不要重试 |
| 404 | 目标不存在 | 不要重试 |
| 405 | 请求方法不对 | 是客户端的缺陷 |
| 409 | 和当前的状态冲突 | 按错误码处理 |
| 410 | 已过期 | 不要重试 |
| 426 | 这个地址只接受 WebSocket | 是客户端的缺陷 |
| 429 | 太频繁 | 按应答头 `Retry-After` 等待后再试，不要立刻重试 |
| 500 | 服务端出错 | 可以稍后重试；带着请求编号报告 |

**会改动数据的操作要能重试。** 玩家发起的购买带一个客户端生成的编号（`opId`），同一个编号重复提交只生效一次，第二次的应答里 `duplicate` 为 `true`。客户端把 `duplicate: true` 当作成功处理（8.3 节）。

## B.2 标识的格式

所有标识都由服务端生成。客户端传来的标识先按格式校验，格式不对的直接拒绝。

| 标识 | 格式 | 例子 | 说明 |
|---|---|---|---|
| 玩家 ID | `p_` 加 24 位十六进制 | `p_8b9c0e1facc345499cfad760` | 不含任何个人信息 |
| 会话 ID | `s_` 加 24 位十六进制 | | 在访问令牌和刷新凭证里 |
| 订单号 | `o_` 加 24 位十六进制 | | |
| 订单引用 | `玩家 ID:订单号` | | 交给支付平台，回调时原样带回 |
| 房间号 | 64 位十六进制 | | 平台生成的对象 ID |
| 房间短码 | 6 位，字母数字，不含 `0 O 1 I L` | `K7MQ2X` | 15 分钟有效，查询时不分大小写 |
| 对局编号 | UUID | | |
| 邮件编号 | 4 到 64 位，字母、数字、下划线、连字符 | `comp-2026-11-25` | 由发信的人指定 |
| 购买编号 | 8 到 64 位，字母、数字、下划线、连字符 | | 由客户端在点击时生成 |
| 机器人的座位 | `bot:` 加 8 位十六进制 | `bot:e5ca15ab` | |
| 录像的座位 | `ghost:` 加原玩家的 ID | | |
| 身份对象的名字 | `guest:` 加凭证的哈希，或 `telegram:` 加用户 ID | | 只在服务端内部使用 |
| 分析标识 | 8 到 64 位，字母、数字、点、下划线、连字符 | | 客户端从分析 SDK 取得 |

真实玩家的 ID 里没有冒号，带冒号的座位都由服务端操作。

## B.3 接口一览

"限流"一列对应 11.2 节的分档：登录（每个来源地址每分钟 20 次）、敏感（每个玩家每分钟 30 次）、普通（每个玩家每分钟 120 次）、回调（每个来源地址每分钟 120 次）。

### 账号

| 接口 | 登录 | 限流 | 请求体 | 成功时返回 | 章 |
|---|---|---|---|---|---|
| `POST /auth/guest` | 否 | 登录 | 新账号：`{ turnstileToken? }`；老账号：`{ secret }` | 会话；新账号多一个 `guestSecret` | 4、11 |
| `POST /auth/telegram` | 否 | 登录 | `{ initData }` | 会话 | 4 |
| `POST /auth/refresh` | 否 | 登录 | `{ refreshToken }` | 会话 | 4 |
| `POST /auth/logout` | 是 | 登录 | `{}` | `{ ok }` | 4 |
| `POST /auth/bind/telegram` | 是 | 登录 | `{ initData }` | `{ ok }` | 4 |
| `GET /me` | 是 | 不限 | | `{ playerId, profile, identities, currentRoom }` | 4、9 |
| `GET /account/export` | 是 | 敏感 | | 这个玩家的全部数据 | 11 |
| `POST /account/delete` | 是 | 敏感 | `{}` | 202，`{ ok }` | 11 |
| `POST /analytics/client` | 是 | 普通 | `{ clientId }` | `{ ok }` | 10 |

"会话"的形状：

```json
{
  "playerId": "p_…",
  "accessToken": "…",
  "expiresAt": 1795000000,
  "refreshToken": "p_….s_….…"
}
```

`expiresAt` 是访问令牌的过期时间，单位是秒。刷新凭证每次使用后都会换成新的，旧的立刻作废；它的有效期是 30 天，每次刷新顺延。`guestSecret` 只在创建账号的那一次返回，客户端要自己保存。

`profile` 的形状：`{ coins, wins, games, rating }`。

### 开局

| 接口 | 登录 | 限流 | 请求体 | 成功时返回 | 章 |
|---|---|---|---|---|---|
| `GET /match/ws` | 是 | 普通 | WebSocket | 见 B.4 节 | 6 |
| `POST /rooms` | 是 | 敏感 | `{}` | `{ roomId, code }` | 6、9 |
| `GET /rooms/code/:code` | 是 | 敏感 | | `{ roomId }` | 9 |
| `POST /mirror` | 是 | 敏感 | `{}` | `{ roomId, opponent }` | 6 |
| `GET /room/:roomId/ws` | 是 | 普通 | WebSocket | 见 B.4 节 | 5、6 |

### 排行榜和社交

| 接口 | 登录 | 限流 | 请求体 | 成功时返回 | 章 |
|---|---|---|---|---|---|
| `GET /leaderboard` | 是 | 不限 | | `{ top, me }` | 7、9 |
| `GET /leaderboard/friends` | 是 | 不限 | | `{ entries }` | 7 |
| `GET /friends` | 是 | 不限 | | `{ friends }` | 7 |
| `POST /friends/request` | 是 | 敏感 | `{ playerId }` | `{ ok }` | 7 |
| `POST /friends/accept` | 是 | 普通 | `{ playerId }` | `{ ok }` | 7 |
| `POST /friends/remove` | 是 | 普通 | `{ playerId }` | `{ ok }` | 7 |
| `POST /invite/accept` | 是 | 敏感 | `{ playerId }`，邀请人的 ID | `{ ok }` | 7 |
| `GET /invites` | 是 | 不限 | | `{ invites }` | 7 |

- `top` 和 `entries` 是 `{ playerId, score }` 的数组，已按名次排好。
- `me` 是 `{ score, rank, percent }`，没有上榜时为 `null`。`rank` 超过 1,000 名时为 `null`，这时 `percent` 是"超过了百分之多少的玩家"；分布表还没生成时 `percent` 也是 `null`。
- `friends` 是 `{ playerId, status }` 的数组，`status` 取 `outgoing`、`incoming`、`friend`。
- `invites` 是 `{ playerId, rewarded }` 的数组，最多 50 条。
- 好友和邀请的变化经过队列，对方那一侧一两秒后才能看到（7.1 节）。

### 经济

| 接口 | 登录 | 限流 | 请求体 | 成功时返回 | 章 |
|---|---|---|---|---|---|
| `GET /wallet` | 是 | 不限 | | `{ coins, gems, items }` | 8 |
| `POST /shop/buy` | 是 | 普通 | `{ itemId, opId }` | `{ ok, duplicate, wallet }` | 8、9 |
| `POST /pay/orders` | 是 | 敏感 | `{ productId, provider }` | `{ orderId, url }` | 8 |
| `POST /pay/orders/sync` | 是 | 敏感 | `{ orderId }` | `{ status }` | 8 |

- `provider` 取 `telegram` 或 `stripe`。`url` 交给对应平台的付款界面打开。
- 订单的 `status` 取 `pending`、`paid`、`refunded`，只朝这个方向变化。
- `gems` 可以是负数：退款时已经花掉的部分记为欠款（8.8 节）。

### 运营

| 接口 | 登录 | 限流 | 请求体 | 成功时返回 | 章 |
|---|---|---|---|---|---|
| `GET /config` | 是 | 不限 | 可带 `If-None-Match` | 配置，或 304 | 9 |
| `GET /mail` | 是 | 不限 | | `{ mail }` | 9 |
| `POST /mail/claim` | 是 | 普通 | `{ mailId }` | `{ ok, duplicate, wallet }` | 9 |

`GET /config` 的应答：

```json
{
  "version": 12,
  "notice": "",
  "shop": { "shield": { "cost": { "coins": 30, "gems": 0 }, "grant": { "items": { "shield": 1 } }, "now": { "coins": 24, "gems": 0 } } },
  "events": [{ "id": "sale", "type": "shop_discount", "startsAt": 0, "endsAt": 0, "percent": 20 }],
  "active": ["sale"],
  "variants": { "new_shop": "control" },
  "serverTime": 1795000000000
}
```

`now` 是这件商品此刻的实际价格。`events` 里是还没结束的活动，`active` 是此刻正在进行的。除了会话里的 `expiresAt`，所有时间都是毫秒。客户端用 `serverTime` 修正本地时钟的偏差，只用于显示。

### 其他

| 接口 | 登录 | 说明 | 章 |
|---|---|---|---|
| `GET /health` | 否 | `{ ok, environment }`，只说明服务能应答 | 2 |

### 管理后台

全部在 `/admin/` 下，要求请求头 `Cf-Access-Jwt-Assertion` 里有合法的 Access 令牌，否则返回 403 `forbidden`。没有配置 Access 时全部不可用（9.6 节）。会改动数据的接口都会写操作记录。

| 接口 | 请求体 | 说明 |
|---|---|---|
| `GET /admin/config` | | 当前的完整配置 |
| `PUT /admin/config` | 完整的配置，`version` 必须是当前版本加一 | 发布。校验不通过时返回 400，`{ error: "invalid_config", detail }` |
| `POST /admin/config/rollback` | `{ version }` | 把一个历史版本作为新版本重新发布 |
| `POST /admin/mail/broadcast` | `{ id, title, body, attachment?, days? }` | 全服邮件，只发给此刻之前注册的玩家。`days` 是有效天数，1 到 30，不填或超出范围时按 7 天 |
| `GET /admin/payments/totals?day=YYYY-MM-DD` | | 这一天（UTC）各渠道的订单数和金额 |
| `GET /admin/matches/:matchId/verify` | | 重放一局，返回记录的结果和重放的结果 |
| `GET /admin/players/:playerId` | | 资料、账号、钱包、对账结果、最近 50 条流水、当前房间 |
| `POST /admin/players/:playerId/ban` | `{ reason }` | 封禁并踢出当前的对局，返回 `{ ok, kicked }` |
| `POST /admin/players/:playerId/unban` | `{ reason }` | |
| `POST /admin/players/:playerId/mail` | `{ id, title, body, attachment? }` | 30 天有效 |
| `POST /admin/players/:playerId/sync` | `{ orderId }` | 去支付平台核实一个订单 |

`attachment` 是一组只增不减的变化量：`{ coins?, gems?, items? }`，上限是 10,000 金币、1,000 宝石、每种道具 100 个。

## B.4 WebSocket

### 握手

浏览器的 WebSocket 不能设置请求头，访问令牌放在子协议里（4.8 节）：

```js
new WebSocket(url, ["game.v1", "auth." + accessToken]);
```

服务端在应答里选定 `game.v1`。握手阶段被拒绝时返回普通的 HTTP 状态码，浏览器的脚本读不到应答的正文，所以只看状态码：

| 状态码 | 含义 |
|---|---|
| 401 | 令牌无效 |
| 403 | 被封禁（排队），或者不在这个房间的名单里（进房） |
| 404 | 房间不存在：没开过，或者已经清理 |
| 409 | 进不去：房间满了，或者已经开局而你不在其中 |
| 426 | 没有用 WebSocket 访问 |
| 429 | 连接太频繁 |

心跳：客户端发文本 `ping`，平台直接回 `pong`，不唤醒对象。两种连接都支持。

### 房间

**客户端发给服务端：**

| 消息 | 说明 |
|---|---|
| `{ "type": "ready" }` | 准备。所有人都准备且至少两人时开局 |
| `{ "type": "roll", "version": 7 }` | 掷骰子。`version` 是客户端看到的状态版本号，对不上会被拒绝 |
| `{ "type": "leave" }` | 离开。对局中等同于弃权，服务端以 1000 关闭连接 |

单条消息不超过 256 个字符。每条连接每 10 秒最多 20 条。

**服务端发给客户端：**

```json
{ "type": "state", "state": { "version": 7, "phase": "playing", "players": [], "turn": 0, "winner": null, "forfeited": [] }, "deadline": 1795000030000 }
```

```json
{ "type": "error", "code": "not_your_turn" }
```

- 每次状态变化都广播完整的状态。客户端只接受版本号不小于本地的状态，更旧的丢弃。
- `phase` 取 `waiting`、`playing`、`finished`。
- `players` 里每一项是 `{ id, ready, position, connected, missed }`；`turn` 是当前轮到的人在 `players` 里的下标。
- `deadline` 是当前回合的截止时刻，不在对局中时为 `null`。发的是时刻而不是剩余秒数。
- `error` 只发给引起它的那条连接，状态没有变化。

`error` 里的 `code`：

| 错误码 | 含义 | 客户端怎么办 |
|---|---|---|
| `bad_message` | 消息的格式不对 | 客户端的缺陷 |
| `stale_version` | 操作带的版本号已经过时 | 等下一个状态，按新的状态重新决定 |
| `not_your_turn` | 没轮到你 | 忽略 |
| `not_playing` | 不在对局中 | 忽略 |
| `already_started` | 已经开局 | 忽略 |
| `not_in_room` | 你不在这个房间里 | 重新连接 |
| `room_full` | 房间满了 | 只在握手时出现（状态码 409） |

规则里还有一个 `bad_dice`（点数不合法）。点数由服务端生成，客户端收不到这个错误码。

### 排队

连上就是入队，断开就是取消。客户端不需要发任何消息（发了会被以 1003 关闭）。

| 服务端的消息 | 说明 |
|---|---|
| `{ "type": "queued" }` | 已入队 |
| `{ "type": "matched", "roomId": "…" }` | 配好了。随后服务端以 1000 关闭连接，客户端拿房间号去连房间 |

配好之后要在 30 秒内进房并准备，否则房间作废。

### 关闭码

| 关闭码 | 含义 | 客户端该不该重连 |
|---|---|---|
| 1000 | 正常结束：自己离开了，或者已经配好 | 不重连 |
| 1003 | 在排队的连接上发了消息 | 不重连，是客户端的缺陷 |
| 4001 | 同一个玩家从别处连了进来，这条连接被顶替 | **不重连**，否则两个设备会互相顶替 |
| 4002 | 被管理员移出房间 | 不重连 |
| 4003 | 房间已经结束并清理，或者没等到人作废了 | 不重连这个房间；回到大厅 |
| 4008 | 发消息太快 | 不立刻重连，是客户端的缺陷 |
| 其他（1006 等） | 网络断了，或者服务端在发版 | 重连，间隔逐次加倍并加上随机的抖动 |

重连就是再连一次同一个房间号。服务端按"再加入一次"处理，随后发来完整的状态（5.5 节）。

## B.5 第三方回调

这三个接口不走玩家的登录，各自校验来源。应答的规则相同（8.5、8.6 节）：

- 处理成功，或者永远处理不了（格式不对、不认识的类型）：返回 2xx。
- 暂时处理不了（内部出错，或者通知来早了）：返回非 2xx，让对方重发。
- 来源校验不通过：拒绝，不做任何处理。

| 接口 | 怎么校验 | 处理的通知 |
|---|---|---|
| `POST /webhooks/telegram` | 请求头 `X-Telegram-Bot-Api-Secret-Token` 等于回调密钥 | `pre_checkout_query`、`successful_payment`、`refunded_payment` |
| `POST /webhooks/stripe` | 请求头 `Stripe-Signature`，对请求体原文验签，时间差不超过 5 分钟 | `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`charge.refunded`、`charge.dispute.created` |
| `GET /webhooks/admob` | 查询串末尾的 `signature` 和 `key_id`，对它们之前的查询串原文验签 | 一次激励广告的观看 |

这三个接口的应答是给对方平台看的，不遵守 B.1 节的错误格式。

## B.6 错误码

HTTP 接口应答里 `error` 字段的所有取值：

| 错误码 | 状态码 | 含义 |
|---|---|---|
| `bad_request` | 400 | 请求体的格式或字段不对 |
| `self` | 400 | 目标是自己（填邀请人、加好友） |
| `reason_required` | 400 | 管理操作没有填原因 |
| `invalid_config` | 400 | 配置没有通过校验，`detail` 里是原因 |
| `unauthorized` | 401 | 没有令牌，或者令牌无效、已过期 |
| `invalid_signature` | 401 | 平台数据的签名不对，或者已经过期 |
| `invalid_session` | 401 | 刷新凭证无效、已用过或已过期。需要重新登录 |
| `banned` | 403 | 账号被封禁，或者正在删除 |
| `forbidden` | 403 | 管理接口没有合法的 Access 令牌 |
| `verification_required` | 403 | 创建账号需要先通过人机验证 |
| `not_found` | 404 | 目标不存在：玩家、订单、邮件、短码、好友申请、对局记录、配置的历史版本，或者路径本身不存在 |
| `room_not_found` | 404 | 房间号不是本服务生成的 |
| `method_not_allowed` | 405 | 请求方法不对 |
| `upgrade_required` | 426 | 这个地址只接受 WebSocket 连接 |
| `already` | 409 | 已经填过另一个邀请人 |
| `too_late` | 409 | 注册超过 24 小时，不能再填邀请人 |
| `invalid` | 409 | 邀请人注册得比你晚 |
| `full` | 409 | 好友数已满 |
| `already_linked` | 409 | 这个玩家已经绑定了另一个同类的平台账号 |
| `identity_taken` | 409 | 这个平台账号已经属于另一个玩家 |
| `insufficient` | 409 | 余额或道具不够 |
| `expired` | 410 | 邮件已过期 |
| `too_many_orders` | 429 | 没付款的订单太多 |
| `too_many_requests` | 429 | 请求太频繁。应答头里有 `Retry-After` |
| `internal` | 500 | 服务端出错。应答里有 `requestId` |

## B.7 操作编号

每一次资产的变动都有一个编号，写在玩家对象的流水里，同一个编号只生效一次（8.1 节）。前缀说明来源：

| 前缀 | 来源 | 编号里的内容 | 章 |
|---|---|---|---|
| `match:` | 一局的结算 | 对局编号 | 3 |
| `invite:` | 邀请奖励 | 被邀请人的 ID | 7 |
| `buy:` | 游戏内商店的购买 | 客户端生成的购买编号 | 8 |
| `order:` | 充值到账 | 订单号 | 8 |
| `refund:` | 退款收回 | 订单号 | 8 |
| `ad:` | 广告奖励 | 广告平台给这次观看的编号 | 8 |
| `mail:` | 领取邮件的附件 | 邮件编号 | 9 |

新增一种资产变动时，先定下它的前缀和"用什么做编号"。编号必须是业务上天然唯一的东西，不能是调用时临时生成的随机数，否则重试时会变成另一个编号。

## B.8 内部的消息和事件名

这一节的内容不对客户端公开，但它们同样是约定：改动它们会影响正在队列里的消息、已经配置好的告警和已有的图表。

### 玩家通知

玩家对象通过发件箱发出的通知（7.1 节），每一条都带 `seq`：

| `type` | 消费者做什么 | 章 |
|---|---|---|
| `score` | 更新 D1 里的排行榜，按 `seq` 覆盖 | 7 |
| `friend_request` | 在对方的对象里记一条收到的申请 | 7 |
| `friend_accept` | 在对方的对象里把关系改为好友 | 7 |
| `friend_remove` | 在对方的对象里删掉这段关系 | 7 |
| `invited` | 在 D1 里记下邀请关系 | 7 |
| `invite_reward` | 给邀请人发奖，更新 D1 里的记录 | 7 |
| `payment` | 更新 D1 里的支付记录，补报给分析平台 | 8、10 |
| `erase` | 分步清除这个玩家在各处的数据 | 11 |

每一种通知的处理都可以重复执行。新增一种时要说明它为什么可以。

### 日志的事件名

监控规则是按事件名配置的（10.7 节），改名等于让对应的规则失效。

| 级别 | 事件 | 含义 |
|---|---|---|
| error | `unhandled_error` | 没有被处理的异常，带请求编号 |
| error | `payment_unfulfillable` | 收了钱但发不了货 |
| error | `audit_mismatch` | 余额和流水对不上 |
| error | `dead_letter` | 有消息进了死信队列 |
| error | `job_failed`、`job_unknown` | 定时任务失败，或者没有对应的任务 |
| error | `turnstile_unavailable` | 人机验证服务访问不了 |
| warn | `settle_failed` | 结算失败，会自动重试 |
| warn | `leaderboard_write_failed` | 排行榜写入失败，会自动重试 |
| warn | `room_open_failed` | 匹配成功后开房失败，会自动重试 |
| warn | `rate_limited` | 一个请求被限流挡住，`tier` 是哪一档（`auth`、`sensitive`、`api`、`webhook`） |
| warn | `outbox_flush_failed` | 通知没送出去，稍后重发 |
| warn | `player_event_failed` | 一条玩家通知处理失败，会重新投递 |
| warn | `order_sync_failed` | 核实某个订单失败 |
| warn | `ban_kick_failed` | 封禁之后没能踢出对局 |
| warn | `analytics_report_failed` | 付款事件没能补报给分析平台 |
| info | `job_done` | 定时任务成功跑完。"任务还在跑"的规则数的是它 |
| info | `account_erase_requested`、`account_erased` | 账号删除的开始和完成 |
| info | `turnstile_rejected` | 人机验证没有通过 |

### 指标

指标的名字和字段顺序定义在 `server/src/obs/metrics.ts` 的 `METRICS` 里（10.4 节）。字段按位置对应，只能在末尾追加。

## B.9 改动协议时的规则

协议一旦上线，就有两类东西依赖着它：还没更新的客户端，和发版期间还在运行旧代码的对象。几条规则，分别来自正文各处：

- **只增不改。** 给消息和应答加新的可选字段，不要改已有字段的含义，不要删字段。客户端忽略不认识的字段，服务端解析时只取认识的字段（5.3 节）。
- **不兼容的改动换一个子协议名。** 握手时的 `game.v1` 就是为这个准备的：新协议用 `game.v2`，服务端在一段时间内两个都支持（5.12 节）。
- **对象之间的方法同样只增不改。** 发版期间新旧版本并存，新代码可能调用到还在运行旧代码的对象。只加新方法、只加可选参数（3.3 节）。
- **存储里的数据要让上一个版本的代码也读得懂。** 回滚只换代码，不动数据（2.10 节）。
- **错误码、关闭码、事件名、操作编号的前缀都是协议的一部分。** 它们没有出现在类型定义里，但客户端的分支、告警的规则、流水的去重都依赖着它们。
- **改了协议要同步改的地方：** `shared/src/protocol.ts`、联调页面、压测脚本，以及这份附录。
