# 第 7 章　排行榜与社交

> 状态：初稿　｜　文档核实与实际运行日期：2026-11-24

排行榜、好友、邀请，这三样东西看起来互不相干，但在这套架构里遇到的是同一个问题。到目前为止，一个玩家的数据都在他自己的对象里，只有他自己的请求会去读写。这一章的三个功能，都要求**一个玩家的数据被别人看到，或者一个玩家的行为改变另一个玩家的数据**：

- 排行榜：所有玩家的分数要放在一起排序。
- 好友：甲加了乙，乙的列表里也得有甲。
- 邀请：乙达到了某个条件，甲要拿到奖励。

所以这一章先建一个通用的机制，再用它依次做出这三个功能。

这一章的代码在 [examples/server/src/player.ts](../examples/server/src/player.ts) 和 [examples/server/src/social/](../examples/server/src/social/)。

## 7.1 发件箱：玩家对象怎么把变化告诉外面

### 问题

第 3 章定下的原则是：玩家的数据以玩家对象为准，对象是它唯一的写入者；需要跨玩家查询的数据在 D1 里放一份副本。当时没有回答的问题是，副本怎么保持更新。

最直接的写法是在改完数据之后顺手写一下 D1：

```ts
// 不要这样写。
sql.exec("UPDATE profile SET rating = ? WHERE id = 1", rating);
await this.env.DB.prepare("UPDATE leaderboard SET score = ? WHERE player_id = ?").bind(rating, id).run();
```

第二行可能失败。网络抖动，D1 暂时不可用，对象恰好在两行之间被重启，都会让分数改了而排行榜没改，并且之后没有任何东西会去补上它。

第 3 章的结算解决过同样的问题：房间先把"要发给谁、发什么"存进自己的存储，再去调用玩家对象，成功之后才删掉。这里把同样的做法做成玩家对象的一个通用部件，叫发件箱。

### 写进发件箱

发件箱是玩家对象里的一张表：

```sql
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL
);
```

对象里任何需要让外面知道的变化，都在**修改数据的同一个事务里**往这张表插一行：

```ts
/** 把一条通知写进发件箱。必须在修改数据的同一个事务里调用。 */
private emit(event: PlayerEventDraft): void {
  this.ctx.storage.sql.exec("INSERT INTO outbox (body) VALUES (?)", JSON.stringify(event));
}
```

以结算为例：

```ts
this.ctx.storage.transactionSync(() => {
  // ……去重、写流水……
  const row = sql
    .exec(
      `UPDATE profile SET coins = coins + ?, wins = wins + ?, games = games + 1,
         rating = MAX(0, rating + ?), rated_wins = rated_wins + ?
       WHERE id = 1
       RETURNING rating, rated_wins, inviter, invite_rewarded`,
      /* …… */
    )
    .one();

  // 分数变了：通知排行榜。通知和分数在同一个事务里写下，不会只成功一半。
  if (delta !== 0) {
    this.emit({ type: "score", playerId: this.id, rating: Number(row.rating), at: now });
  }
});
await this.flush();
```

事务提交之后，"分数是多少"和"有一条通知要发"这两件事要么都发生了，要么都没发生。这是整个机制的基础：**不可能出现分数变了而通知丢了的情况。**

### 送出去

`flush` 把发件箱里的东西送进队列，送达之后删除：

```ts
private async flush(): Promise<void> {
  const sql = this.ctx.storage.sql;
  const rows = sql.exec("SELECT seq, body FROM outbox ORDER BY seq LIMIT ?", OUTBOX_BATCH).toArray();
  if (rows.length === 0) return;
  try {
    await this.env.PLAYER_EVENTS.sendBatch(
      rows.map((row) => ({ body: { ...JSON.parse(String(row.body)), seq: Number(row.seq) } as PlayerEvent })),
    );
    sql.exec("DELETE FROM outbox WHERE seq <= ?", Number(rows[rows.length - 1]!.seq));
    if (rows.length === OUTBOX_BATCH) await this.flush();
  } catch (error) {
    console.error("通知没有送出，稍后重试", error);
    await this.ctx.storage.setAlarm(Date.now() + OUTBOX_RETRY_MS);
  }
}

/** 定时器只用来重发发件箱里没送出去的通知。 */
async alarm(): Promise<void> {
  await this.flush();
}
```

有四点要说明：

- **送不出去不报错。** 数据已经保存好了，调用方的操作是成功的。通知留在发件箱里，定时器 5 秒后再试。
- **可能送出不止一次。** 队列收到了但对象没等到确认，或者两次 `flush` 在等待期间交错，同一条通知都会被发两次。这是可以接受的，前提是接收方能重复处理，后面每一种通知都会说明它为什么可以。
- **序号在送出时加上。** 每条通知带着它在发件箱里的序号 `seq`。同一个玩家的通知，序号大的一定是后发生的。7.2 节用它处理乱序。
- **对象知道自己是谁。** 通知里要写"这是哪个玩家的分数"。按名字访问的对象可以从 `ctx.id.name` 读到自己的名字，也就是玩家 ID，不需要调用方每次传进来。定时器触发时没有调用方，这个属性尤其有用。

### 通知的种类

所有通知是一个类型：

```ts
export type PlayerEvent = { seq: number } & (
  | { type: "score"; playerId: string; rating: number; at: number }
  | { type: "friend_request"; from: string; to: string; at: number }
  | { type: "friend_accept"; from: string; to: string; at: number }
  | { type: "friend_remove"; from: string; to: string; at: number }
  | { type: "invited"; inviter: string; invitee: string; at: number }
  | { type: "invite_reward"; inviter: string; invitee: string; at: number }
);
```

消费者按种类做两类事：更新 D1 里的副本，或者去调用另一个玩家对象。

```ts
export async function handlePlayerEvents(batch: MessageBatch<PlayerEvent>, env: Env): Promise<void> {
  // 分数更新合成一次批量写入。
  const scores = batch.messages.filter((message) => message.body.type === "score");
  if (scores.length > 0) {
    try {
      await saveScores(env.DB, scores.map((message) => message.body /* …… */));
      for (const message of scores) message.ack();
    } catch (error) {
      for (const message of scores) message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }

  // 其余的各自处理、各自确认：一条失败不影响同一批里的其他通知。
  for (const message of batch.messages) {
    if (message.body.type === "score") continue;
    try {
      await handleOne(message.body, env);
      message.ack();
    } catch (error) {
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}
```

和上一章的对局记录相比，这里的确认方式不同。对局记录是整批写同一个库，失败就整批重投。这里一批通知要去往不同的玩家对象，其中一个对象暂时不可用，不应该让其余的也重来一遍，所以**逐条确认**：成功的 `ack`，失败的 `retry`。

两个队列共用入口的同一个 `queue` 处理函数，按队列名分发：

```ts
async queue(batch: MessageBatch<MatchRecord | PlayerEvent>, env: Env): Promise<void> {
  if (batch.queue.startsWith("match-log")) {
    await saveRecords(env.DB, (batch as MessageBatch<MatchRecord>).messages.map((message) => message.body));
  } else {
    await handlePlayerEvents(batch as MessageBatch<PlayerEvent>, env);
  }
},
```

这个队列的批量等待时间配成了 1 秒，比对局记录的 5 秒短。好友申请要尽快到对方那里，晚一秒可以，晚五秒就能感觉到了。

### 这意味着什么

用了发件箱之后，跨玩家的数据是**最终一致**的：玩家的分数变了，排行榜大约一两秒后跟上；甲接受了乙的申请，乙的列表一两秒后才变。这一章后面所有的设计都建立在这个前提上，界面也要按这个前提来做，比如操作之后先在本地显示结果，不要立刻去拉对方的数据来确认。

## 7.2 排行榜的数据放在哪

### Redis 提供了什么

传统的做法是 Redis 的有序集合：写入一个分数，取前 N 名，查某个人排第几，都是一条命令，都很快。它的本质是一个放在内存里、按分数排好序的结构。这个平台上没有对应的产品，要用别的东西把这三个操作凑出来。

| 方案 | 写入 | 前 N 名 | 我排第几 | 问题 |
|---|---|---|---|---|
| KV | 每个玩家一个键 | 做不了，KV 不能按值排序 | 做不了 | 不适合 |
| 一个全局对象，SQLite 存储 | 快 | 快 | 可以 | 所有读写压在一个对象上，每秒约 1,000 个请求的软限制 |
| D1 | 经队列批量写入 | 一条带索引的查询，结果可以缓存 | 可以，但要注意读取的行数 | 单库有容量和吞吐上限 |

示例用 D1。理由是：分数的更新本来就经过队列，可以批量写入；前 N 名所有人看到的都一样，可以缓存；而且 D1 可以直接从入口查询，不需要再经过一个对象。全局对象的方案在 7.6 节讨论，它适合另一类榜。

### 表结构和写入

```sql
CREATE TABLE leaderboard (
  board TEXT NOT NULL,
  player_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  -- 玩家对象发出这次更新时的序号，用来丢弃迟到的旧更新。
  seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (board, player_id)
);
CREATE INDEX leaderboard_rank ON leaderboard (board, score DESC, updated_at);
```

每个榜里每个玩家一行。`board` 是榜的名字，7.5 节会用到。索引按"榜、分数从高到低、更新时间"排列，取前 N 名时数据库沿着索引读 N 行就结束，不需要排序。

写入是一条带条件的"有则更新、无则插入"：

```ts
const statement = db.prepare(
  `INSERT INTO leaderboard (board, player_id, score, seq, updated_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT (board, player_id) DO UPDATE
     SET score = excluded.score, seq = excluded.seq, updated_at = excluded.updated_at
     WHERE excluded.seq > leaderboard.seq`,
);
await db.batch(events.map((e) => statement.bind(RATING_BOARD, e.playerId, e.rating, e.seq, e.at)));
```

最后那个 `WHERE` 是关键。队列不保证顺序，一个玩家连打两局，两条通知可能后发的先到。如果直接覆盖，先发的那条晚到时就会把分数改回旧值。带上序号之后，只有比库里更新的才会生效：

- 重复投递：序号相同，条件不成立，什么都不改。
- 乱序到达：旧的序号更小，条件不成立，被丢弃。

这里有一个设计上的选择值得说明：通知里带的是**分数的当前值**，不是"加了多少分"。如果通知的内容是"加 16 分"，同一条通知处理两次就会加两次，而且没有办法用序号来挡。7.5 节的周榜会再遇到这个问题。能发绝对值的时候，就发绝对值。

## 7.3 读榜：前 N 名

```ts
/** 前若干名。分数相同时，先达到这个分数的排在前面。 */
export async function topOf(db: D1Database, board: string, limit = TOP_SIZE): Promise<Entry[]> {
  const rows = await db
    .prepare(
      `SELECT player_id, score FROM leaderboard WHERE board = ?
       ORDER BY score DESC, updated_at ASC LIMIT ?`,
    )
    .bind(board, limit)
    .all<{ player_id: string; score: number }>();
  return rows.results.map((row) => ({ playerId: row.player_id, score: row.score }));
}
```

**同分怎么排要事先定好。** 不定的话，同分的几个人每次查询的顺序可能不一样，玩家会看到自己的名次在跳。示例的规则是先达到这个分数的人排在前面，这也是最常见的规则，它不会让后来者把先到的人挤下去。

### 缓存

前 50 名对所有人都一样，而且看榜的请求远多于分数的更新。每个请求都去查一次 D1 是浪费的，结果缓存 30 秒：

```ts
/** 榜单前列。先看这个数据中心的缓存，没有再查 D1。 */
async function cachedTop(env: Env): Promise<unknown> {
  const cache = caches.default;
  const hit = await cache.match(TOP_CACHE_KEY);
  if (hit) return hit.json();
  const top = await topOf(env.DB, RATING_BOARD);
  await cache.put(
    TOP_CACHE_KEY,
    Response.json(top, { headers: { "Cache-Control": `max-age=${TOP_CACHE_SECONDS}` } }),
  );
  return top;
}
```

接口把"所有人都一样的部分"和"每个人不同的部分"分开取：

```ts
// 榜单走缓存，自己的名次每次现查。两部分分开，缓存才能所有人共用。
return json({ top: await cachedTop(env), me: await standingOf(env.DB, RATING_BOARD, me) });
```

如果把两部分拼成一个响应再缓存，缓存的键里就得带上玩家 ID，等于没有缓存。

`caches.default` 是 Workers 的缓存接口，使用时要知道三件事：

- **缓存不跨数据中心。** 在东京缓存的结果，法兰克福的请求看不到，要自己再查一次。所以它省掉的是同一个地方的重复查询，全球有多少个数据中心在服务你的玩家，每 30 秒最多就有多少次查询。对排行榜来说这完全够了。
- **只在自定义域名上生效。** 官方文档的说法是，部署在自定义域名上的 Worker 才有可用的缓存操作。用 `workers.dev` 地址调试时，每次都会查库。
- **没有主动失效的必要。** 榜单晚 30 秒是可以接受的，过期后自然会刷新。不要在每次写入分数时去清缓存，那样缓存就没有意义了。

需要所有数据中心共用一份结果时，可以改用 KV，但 KV 的键最短过期时间是 60 秒，而且写入之后其他地方可能要 60 秒或更久才能看到。

### 榜上要显示什么

示例的榜单里只有玩家 ID 和分数。真实的榜单还要显示昵称和头像。不要在读榜的时候去问 50 个玩家对象各要一次资料，而是把昵称和头像也放进排行榜这张表里：玩家改昵称时，同样通过发件箱发一条通知，消费者更新这一行。这是用冗余换读取速度，代价是改名之后榜上有一两秒的延迟。

另外，没打过计分对局的玩家不在榜上。表里没有他的行，他的名次是"未上榜"，而不是最后一名。

## 7.4 我排第几

### 名次就是数人数

一个玩家的名次，等于排在他前面的人数加一。

```sql
SELECT COUNT(*) FROM leaderboard WHERE board = ? AND score > ?
```

这条查询有索引可用，但数据库仍然要把排在前面的每一行都读一遍才能数出来。排第 10 名读 9 行，排第 50 万名就要读 50 万行。

D1 按读取的行数计费，付费版每月包含 250 亿行，超出每百万行 0.001 美元。一个排在第 50 万名的玩家每查一次名次，读取 50 万行；一天有 100 万次这样的查询，就是 5,000 亿行，一天 500 美元。而且越是普通玩家（排名靠后的占绝大多数），查询越贵。

### 只数到一千

对策来自一个观察：**只有排在前面的人才在乎精确的名次。** 第 37 名和第 38 名有区别，第 384,512 名和第 384,513 名没有区别。所以精确的名次只算到一个上限：

```ts
const [higher, earlier] = await db.batch<{ n: number }>([
  db
    .prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM leaderboard WHERE board = ? AND score > ? LIMIT ?)")
    .bind(board, me.score, RANK_CAP),
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM leaderboard WHERE board = ? AND score = ? AND updated_at < ? LIMIT ?
       )`,
    )
    .bind(board, me.score, me.updated_at, RANK_CAP),
]);
const ahead = (higher?.results[0]?.n ?? 0) + (earlier?.results[0]?.n ?? 0);
return { score: me.score, rank: ahead >= RANK_CAP ? null : ahead + 1 };
```

内层查询带了 `LIMIT`，读到 1,000 行就停。不论玩家排在多后面，这次查询读取的行数都有上限。第二条查询处理同分的情况：分数相同、但更早达到的人也排在前面。两条都是沿着同一个索引的范围扫描。

超过 1,000 名的玩家，接口返回的名次是 `null`，客户端显示"1000 名以外"。

### 靠后的玩家显示百分比

只显示"1000 名以外"对玩家没什么激励。更好的做法是告诉他"你超过了 63% 的玩家"，这个数字不需要精确，可以用一张分数分布表来估算。

定期（比如每 5 分钟）把所有人按分数段统计一遍：

```sql
SELECT score / 50 AS bucket, COUNT(*) AS n FROM leaderboard WHERE board = ? GROUP BY bucket
```

结果是几十到几百行，存起来（KV 或者 D1 的另一张表都可以）。查询某个玩家的大致位置时，把分数比他高的各段人数加起来，再加上他所在的段里按比例估算的一部分。每次查询读的是这张很小的分布表，和总人数无关。

这次统计本身要把整个榜读一遍，100 万玩家就是 100 万行，每 5 分钟一次，一天约 2.9 亿行，在包含的额度之内。它用定时触发器来跑，第 9 章会讲。示例项目没有实现分布表。

## 7.5 赛季、周榜和多个榜

### 重置就是换个名字

表里的 `board` 列就是为多个榜准备的。赛季榜的名字里带上赛季，比如 `season:2026-11`；周榜带上周数，比如 `weekly:2026-W48`。

这样做的结果是**重置不需要任何操作**。新的一周开始，写入用的榜名变了，新榜一开始是空的；旧榜的数据原样留着，可以用来发奖、展示"上周排名"。不需要在零点执行一次清空全表的操作，也就不存在"清到一半失败了"或者"清的过程中有人在写"的问题。

旧榜不会自己消失，要定期删除不再需要的。按榜名删除是一条带索引的语句，可以放在定时任务里慢慢做。

赛季结束时的发奖要注意一件事：发奖依据的是某一个时刻的名次，而队列里可能还有那个赛季最后几局的分数没有落库。稳妥的做法是赛季结束后等一小段时间（比如几分钟）再生成最终名次，并把它另存一份作为发奖的依据。发奖流程是第 9 章的内容。

### 累计型的榜要小心

排位分数是一个"当前值"，通知里带的是绝对值，重复处理没有影响。但很多榜是累计型的：本周胜场数、本周获得的金币、活动期间的积分。

最容易想到的写法是每赢一局发一条"加 1"的通知，消费者执行 `score = score + 1`。这是错的：同一条通知处理两次，就多加了一次，而且序号挡不住它（两次的序号相同时可以挡住，但 `score + 1` 的写法通常不带这个条件，带了又会在乱序时丢掉更新）。

正确的做法有两种：

- **仍然发绝对值。** 累计的数由玩家对象自己记，比如在资料表里记"本周胜场"和"这是哪一周"，通知里带的是累计之后的结果。消费者照旧按序号覆盖。这是推荐的做法，和示例里的排位分数是同一条路径。
- **消费者自己去重。** 通知带一个唯一的编号，消费者在加分的同一个事务里把编号记进一张去重表。这样要多一张表，而且这张表要定期清理。

规则可以概括成一句：**能让接收方直接覆盖的，就不要让它做加法。**

## 7.6 榜再大怎么办

一张 D1 表能撑多大？单个库的上限是 10 GB。排行榜一行大约 100 字节，加上索引按 200 字节算，一百万玩家是 200 MB。对绝大多数游戏，一个库放下所有的榜没有问题，瓶颈不在容量。

写入的吞吐也不容易成为问题，因为写入经过了队列：消费者一批 50 条合成一次提交。真正会先出问题的是读取，而读取已经用缓存和上限处理过了。读取量仍然很大时，D1 支持读副本，把读查询分散到各个地区的只读副本上，需要通过它的会话接口来使用。

如果确实要拆，方向有两个。

### 一个榜一个对象

有一类榜天然很小，而且需要实时：公会内部的排名，一场限时活动里一个分组的排名，一个房间打完之后的积分榜。几十到几百人，分数变了要立刻看到。

这类榜适合用对象来做，一个榜一个对象，对象的名字就是榜的名字。对象自带的 SQLite 里放一张和上面一样的表，查询语句也一样。好处是：

- **写入是同步的。** 不经过队列，写完立刻能查到。
- **可以推送。** 榜上的人连着这个对象的 WebSocket，名次变化直接广播。
- **天然分片。** 一万个公会就是一万个对象，互不影响，没有任何一个对象会成为热点。
- **用完就清。** 活动结束，对象清空存储，和房间一样。

这就是 1.6 节说的"分片"在排行榜上最自然的形式：不是把一个大榜切开，而是让每个榜本来就小。设计玩法的时候可以主动往这个方向靠：把十万人的全服活动榜，改成每一百人一组的分组榜，玩家的体验通常更好（名次看得见、追得上），后端也简单得多。

### 一个大榜拆成几个对象

如果一定要用对象来承载一个全服的大榜（比如需要秒级更新的全服实时榜），单个对象每秒约 1,000 个请求的软限制就成了约束。办法是这几条，第 1 章提过：

- **写入在上游合并。** 不要每次分数变化都调用一次榜对象。让队列的消费者把一批更新合成一次调用，对象一次处理几十上百条。
- **读取走缓存。** 前 N 名由对象定期算好，放进 KV 或者缓存接口，玩家的请求不直接打到对象上。
- **按分数段或地区拆成多个对象。** 每个对象管一段分数。查前 N 名时从最高的一段开始取，不够再取下一段；查名次时，把更高各段的总人数加上自己段内的名次。各段的总人数是一个很小的数据，可以缓存。分数变化跨段时，要从旧段删除、往新段插入，这是一次跨对象的操作，要按 3.7 节的方式做。

最后一条的复杂度不低。在走到这一步之前，先确认 D1 加缓存确实不够用。

## 7.7 好友：一段关系存两份

### 存在哪

"甲和乙是好友"这件事属于谁？按"玩家的数据在玩家对象里"的原则，它同时属于两个人：甲的好友列表里有乙，乙的好友列表里有甲。所以它要存两份，每个玩家对象里各一份：

```sql
CREATE TABLE friend (
  player_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`status` 有三种：我发出的申请（`outgoing`）、我收到的申请（`incoming`）、好友（`friend`）。

存两份的好处是读取很简单。"我的好友列表"是这个游戏里最频繁的社交查询，它只读自己的对象，不需要任何跨对象的操作。代价是两份要保持一致，而它们在两个不同的对象里，不可能在同一个事务里修改。

### 用通知把另一半补上

每一个操作都是：先改自己这一半，同时写一条通知；消费者拿着通知去改对方那一半。

```ts
/** 我向对方发出好友申请。对方已经申请过我的话，直接成为好友。 */
async requestFriend(target: string, now: number): Promise<FriendResult> {
  if (target === this.id) return "self";
  const status = this.friendStatus(target);
  if (status === "friend" || status === "outgoing") return "ok";
  if (this.friendCount() >= MAX_FRIENDS) return "full";
  this.ctx.storage.transactionSync(() => {
    if (status === "incoming") {
      this.setFriend(target, "friend", now);
      this.emit({ type: "friend_accept", from: this.id, to: target, at: now });
    } else {
      this.setFriend(target, "outgoing", now);
      this.emit({ type: "friend_request", from: this.id, to: target, at: now });
    }
  });
  await this.flush();
  return "ok";
}
```

完整的流程是：

| 操作 | 发起方的对象 | 通知 | 对方的对象 |
|---|---|---|---|
| 甲申请加乙 | 记一行 `outgoing` | `friend_request` | 记一行 `incoming` |
| 乙接受 | 把那一行改成 `friend` | `friend_accept` | 把 `outgoing` 改成 `friend` |
| 任何一方删除、撤回或拒绝 | 删掉那一行 | `friend_remove` | 删掉那一行 |

删除好友、撤回申请、拒绝申请是同一个操作：把自己这边的那一行去掉，并告诉对方。不需要为三种意图写三套代码。

### 每个操作都能重复执行

通知可能被处理不止一次，所以对方对象上的每个方法都要保证执行两次和执行一次的结果相同。做法是这些方法都写成"把状态设成什么"，而不是"在现有状态上改一下"：

```ts
/** 由消费者调用：对方把我去掉了。 */
friendRemoved(by: string): void {
  this.ctx.storage.sql.exec("DELETE FROM friend WHERE player_id = ?", by);
}
```

删除一行不存在的数据什么也不会发生。把一行设成 `friend`，它本来就是 `friend` 的话也什么都不变。

### 两边同时操作

两个对象各自独立地处理请求，所以会出现两边的操作交叉的情况。每一种都要有明确的结果。

**甲和乙同时申请对方。** 甲这边是 `outgoing`，乙那边也是 `outgoing`，然后各自收到对方的申请。这时两个人显然都愿意，没有理由再让他们各点一次接受：

```ts
if (status === "outgoing" || status === "friend") {
  // 我也申请过对方（或者我这边已经是好友了）：直接成为好友，并让对方知道。
  this.setFriend(from, "friend", now);
  this.emit({ type: "friend_accept", from: this.id, to: from, at: now });
  return;
}
```

**甲撤回了申请，同时乙点了接受。** 乙这边已经变成 `friend`，接受的通知到达甲时，甲这边已经没有这一行了：

```ts
if (status === null) {
  // 我已经撤回了申请，对方却接受了。以我这边为准，让对方把我去掉。
  this.emit({ type: "friend_remove", from: this.id, to: by, at: now });
}
```

规则是：**一段关系要两个人都同意才成立，所以任何一方不同意，结果就是不成立。** 甲撤回了，那就不是好友，再发一条通知让乙那边也去掉。

处理这类交叉情况没有通用的公式，但有一个检查的办法：把两个对象上每一种状态的组合都列出来，确认每一种组合在所有通知都处理完之后，最终会落到"两边都是好友"或者"两边都没有对方"这两种状态之一。不能停在一边有、一边没有的状态上。

### 上限和防骚扰

好友系统是一个玩家能主动影响另一个玩家数据的地方，所以每一处都要有上限：

- **好友数上限。** 示例是 50，包括自己发出去还没回音的申请。这个数还受另一处约束，下一小节会说。
- **收到的申请有上限。** 一个人没处理的申请超过 50 条之后，新来的直接丢弃。否则有人可以用很多账号向同一个玩家发申请，把他的对象写满。
- **不存在的玩家不能加。** 入口在发起申请前先确认对方存在。
- **申请接口要限流。** 第 11 章统一处理。

"确认对方存在"这一步背后有一个容易忽略的问题。对象是按名字自动创建的，访问一个从没用过的名字，会得到一个全新的对象，它的构造函数会建表，于是在存储里留下了数据。如果好友申请的接口不做任何检查，任何人都可以用随便编的 ID 让服务端创建出无数个空的玩家对象。

示例做了两层防护：

```ts
/** 玩家 ID 的格式。不符合的直接拒绝，不去碰对应的对象。 */
const PLAYER_ID = /^p_[0-9a-f]{24}$/;

// 先确认对方是一个真实存在的玩家，否则任何人都能让服务端为一个随便编的 ID 建对象、存数据。
if (target !== me && !(await env.PLAYER.getByName(target).getPublic()).exists) return fail(404, "not_found");
```

格式检查挡住了乱填的值。`getPublic` 判断的是这个对象有没有绑定过身份，只有注册过的玩家才有。但要注意，调用 `getPublic` 本身就已经让那个对象被创建了，格式正确但不存在的 ID 仍然会留下一个空对象。彻底的办法是在 D1 里维护一张玩家名录，查名录而不是查对象。这一章先靠格式检查来控制，名录在第 11 章做。

这是上一章"没开过的房间不存在"在玩家对象上的对应：**凡是名字由客户端提供的对象，都要想清楚一个不存在的名字会造成什么。**

### 好友榜

好友榜是"我和我的好友在榜上的分数"。好友列表在我自己的对象里，分数在 D1 里，所以是两步：

```ts
const friends = (await player.listFriends()).filter((f) => f.status === "friend").map((f) => f.playerId);
return json({ entries: await scoresOf(env.DB, RATING_BOARD, [me, ...friends]) });
```

```ts
const marks = playerIds.map(() => "?").join(", ");
const rows = await db
  .prepare(
    `SELECT player_id, score FROM leaderboard WHERE board = ? AND player_id IN (${marks})
     ORDER BY score DESC, updated_at ASC`,
  )
  .bind(board, ...playerIds)
  .all<{ player_id: string; score: number }>();
```

D1 的一条查询最多绑定 100 个参数。榜名占一个，自己占一个，所以好友最多 98 个。示例把好友上限定在 50，就是为了让好友榜能用一条查询取完。好友上限更高的游戏要分几次查询再合并，或者换一种存法：在 D1 里也存一份好友关系，用连接查询来取。

好友榜不要去访问每个好友的玩家对象。50 个好友就是 50 次对象调用，其中大部分对象还处于休眠状态，要一个个唤醒。

### 好友在不在线

示例没有做在线状态。它不适合放在玩家对象里：上线下线非常频繁，每次变化都通知所有好友的话，一个有 50 个好友的玩家上线一次就是 50 条通知。常见的做法是：

- 进入好友列表页面时才去查，而不是持续推送。
- 在线状态放在专门的地方。用了 Ably 这类服务的话（5.11 节），它自带在线状态的功能；没有用的话，放进 KV 并设置一个较短的过期时间，客户端定期续期。

## 7.8 邀请关系

### 关系存在哪

"乙是甲邀请来的"这条关系，记在被邀请的人（乙）的对象里：

```sql
ALTER TABLE profile ADD COLUMN inviter TEXT;
```

理由是这条关系的约束都在乙这一侧：一个人只能有一个邀请人，只能设置一次。把它放在乙的对象里，这两条约束靠一次本地的读写就能保证，不涉及任何跨对象的协调。

反过来的查询，"甲邀请了哪些人"，需要跨玩家，放在 D1 里：

```sql
CREATE TABLE invite (
  invitee TEXT PRIMARY KEY,
  inviter TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rewarded_at INTEGER
);
CREATE INDEX invite_inviter ON invite (inviter, created_at);
```

这张表由发件箱的通知来填，和排行榜一样是副本。它同时也是运营和风控要用的数据：哪些人的邀请量异常，哪些被邀请的账号从来不活跃，都要从这张表里查（第 11 章）。

### 设置邀请人的四条规则

```ts
async setInviter(inviterId: string, inviterCreatedAt: number, now: number): Promise<InviteResult> {
  if (inviterId === this.id) return "self";
  const sql = this.ctx.storage.sql;
  const row = sql.exec("SELECT inviter, created_at FROM profile WHERE id = 1").one();
  if (row.inviter) return row.inviter === inviterId ? "ok" : "already";
  if (now - Number(row.created_at) > INVITE_WINDOW_MS) return "too_late";
  if (inviterCreatedAt >= Number(row.created_at)) return "invalid";
  this.ctx.storage.transactionSync(() => {
    sql.exec("UPDATE profile SET inviter = ? WHERE id = 1", inviterId);
    this.emit({ type: "invited", inviter: inviterId, invitee: this.id, at: now });
  });
  await this.flush();
  return "ok";
}
```

- **不能填自己。**
- **只能填一次。** 重复提交同一个邀请人返回成功（客户端可能重试），换一个邀请人则被拒绝。
- **只在注册后的一段时间内有效。** 示例是 24 小时。邀请奖励是为拉来新用户付的钱，一个玩了三个月的老玩家不应该还能被"邀请"。
- **邀请人必须注册得更早。** 这一条挡住了两个账号互相填对方、各拿一份奖励的做法，也让邀请关系不可能成环。

注册时间取的是玩家对象第一次建表的时刻，记在资料里，由服务端自己写入。

### 邀请码怎么传进来

示例里的邀请码就是邀请人的玩家 ID，由客户端在注册后调用 `POST /invite/accept` 提交。这个值是客户端填的，但它能造成的后果有限：填谁都只是把奖励给了那个人，上面四条规则保证了不能填自己、不能反复填。

在 Telegram 小程序里有更好的来源。分享链接可以带一个启动参数（`https://t.me/你的机器人?startapp=邀请码`），它会出现在 `initData` 的 `start_param` 字段里，而 `initData` 是 Telegram 签过名的（4.5 节）。所以登录时顺便读出这个字段，就得到了一个经过平台背书的"这个用户是从哪个链接进来的"。这比让客户端另外提交一次更可靠，也省掉了一步。

邀请码不要直接用内部的玩家 ID 时，另建一张"邀请码到玩家"的对照表，做法和上一章的好友房短码相同。

## 7.9 邀请奖励怎么防刷

邀请奖励是整个游戏里最容易被刷的地方，因为它的本质是：**创建一个新账号，就有人能拿到好处。** 而创建游客账号的成本几乎是零。

### 奖励发给行为，不发给注册

第一条也是最重要的一条：**新账号注册的那一刻不发任何奖励。** 奖励要等被邀请的人做了某件需要真实投入的事之后才发。

示例的门槛是被邀请的人赢下两局计分的对局：

```ts
// 被邀请的人达到了门槛：通知邀请人领奖。标记保证只发一次。
if (row.inviter && Number(row.invite_rewarded) === 0 && Number(row.rated_wins) >= INVITE_WINS_REQUIRED) {
  sql.exec("UPDATE profile SET invite_rewarded = 1 WHERE id = 1");
  this.emit({ type: "invite_reward", inviter: String(row.inviter), invitee: this.id, at: now });
}
```

这段代码在结算的事务里。达到门槛、打上"已触发"的标记、写下通知，三件事一起提交。

门槛选什么，决定了刷一个奖励要花多少成本。写这个示例的时候，前两个想到的门槛都有漏洞：

| 门槛 | 怎么刷 |
|---|---|
| 完成 3 局对局 | 进房间立刻退出也算完成了一局。镜像对战不用排队，三局几秒钟就打完 |
| 赢 2 局 | 两个小号开好友房，一个进来就退，另一个就赢了 |
| 赢 2 局计分的对局 | 要真的和机器人或录像打完，每局十几秒，胜率一半左右 |

最后一种也不是刷不了，写一个脚本就行。但成本从"几秒钟一个"变成了"一分钟左右一个"，而且每个账号都要走完登录、匹配、对局的全流程，留下的痕迹足够风控去识别。**没有刷不了的门槛，只有成本不同的门槛。** 目标是让刷的成本高于奖励的价值。

真实的游戏里，门槛通常是更能代表"这是一个真玩家"的行为：次日还来登录，达到某个等级，或者完成首次付费。越靠后的行为越难伪造，但发奖也越晚，邀请人的积极性越低。这是运营上的权衡。

### 发奖要能重复，要有上限

邀请人这边收到通知后发奖：

```ts
grantInviteReward(invitee: string): RewardResult {
  const sql = this.ctx.storage.sql;
  const opId = `invite:${invitee}`;
  let outcome: RewardResult = "duplicate";
  this.ctx.storage.transactionSync(() => {
    if (sql.exec("SELECT 1 FROM ledger WHERE op_id = ?", opId).toArray().length > 0) return;
    const paid = Number(sql.exec("SELECT invites_paid FROM profile WHERE id = 1").one().invites_paid);
    const granted = paid < INVITE_REWARD_CAP && !this.isBanned();
    const coins = granted ? INVITE_REWARD_COINS : 0;
    // 没发钱也写一行流水：下次同一个被邀请人的通知再来时，仍然会被认出是重复的。
    sql.exec("INSERT INTO ledger (op_id, kind, coins, created_at) VALUES (?, 'invite', ?, ?)", opId, coins, Date.now());
    if (granted) {
      sql.exec("UPDATE profile SET coins = coins + ?, invites_paid = invites_paid + 1 WHERE id = 1", coins);
    }
    outcome = granted ? "granted" : "capped";
  });
  return outcome;
}
```

- **按被邀请人去重。** 操作编号是 `invite:被邀请人的 ID`，写在流水表里，和结算用的是同一张表、同一种做法。同一个被邀请人的通知来多少次，都只发一次。
- **有总量上限。** 示例是 20 次。上限把最坏情况下的损失框住了：不论刷的人多有耐心，一个账号最多拿走 20 份奖励。
- **超过上限也要记账。** 没发钱的那次同样写一行流水，金额是 0。否则下一次同样的通知到来时，系统认不出它是重复的，如果那时上限恰好调高了，就会补发一笔不该发的。

被邀请人那边有 `invite_rewarded` 标记，邀请人这边有流水去重，是两道独立的保险。任何一边因为重试或者缺陷多发了一次通知，另一边都能挡住。

### 还有哪些手段

代码能做的是把规则定死、把损失框住。识别"这一批新账号是不是同一个人"，靠的是代码之外的信号。常用的手段如下，其中涉及风控的部分第 11 章展开：

| 手段 | 说明 |
|---|---|
| 平台账号代替游客账号 | 只有绑定了 Telegram 这类平台身份的账号才算有效邀请。注册一个平台账号的成本远高于生成一个游客账号 |
| 设备和网络信号 | 同一个设备、同一个地址段在短时间内出现大量被同一人邀请的新账号 |
| 延迟发放 | 奖励先记为"待发放"，过几天确认被邀请的账号没有被判定为异常之后再到账 |
| 可以追回 | 事后发现是刷的，把奖励扣回来。流水表里有每一笔的来源，追回本身也是一笔带编号的流水 |
| 奖励的类型 | 发只能在游戏里消耗的东西，不发能提现、能转让的东西。后者会招来专业的刷子 |

还有一条是关于设计本身的：**只做一级邀请。** 甲邀请乙，乙邀请丙，丙的行为只给乙带来奖励，不给甲。多级返利在很多国家和地区会被认定为传销，而且奖励逐级放大之后，刷的收益也逐级放大。

## 7.10 测试

这一章的功能都是"这边做了一件事，过一会儿那边变了"，测试也是这个形状：做操作，然后轮询另一边，直到它变成预期的样子。

```ts
it("申请、接受、删除，两边的列表最终一致", async () => {
  const a = await guest();
  const b = await guest();

  expect((await post("/friends/request", { playerId: b.playerId }, { token: a.accessToken })).status).toBe(200);
  expect(await friendsOf(a)).toEqual([{ playerId: b.playerId, status: "outgoing" }]);
  await expect.poll(() => friendsOf(b)).toEqual([{ playerId: a.playerId, status: "incoming" }]);
  // ……
});
```

注意两种断言的区别：发起方自己的状态用普通的 `expect`，因为它是同步改的；对方的状态用 `expect.poll`，因为它要等通知经过队列。这个区别本身就是一份文档，写明了哪些变化是立刻的，哪些是稍后的。

重复处理用上一章的办法测：构造同一条通知，交给消费者两次，检查结果和一次相同。

```ts
const event: PlayerEvent = { type: "friend_accept", from: b.playerId, to: a.playerId, at: 1, seq: 1 };
for (let i = 0; i < 2; i++) {
  const batch = createMessageBatch<PlayerEvent>("player-events", [
    { id: `dup-${i}`, timestamp: new Date(), body: event, attempts: 1 },
  ]);
  await worker.queue(batch, env);
}
expect(await friendsOf(a)).toEqual([{ playerId: b.playerId, status: "friend" }]);
```

乱序用排行榜的写入函数直接测，先写序号大的，再写序号小的：

```ts
await update(1100, 5);
await update(1000, 3);
await update(1100, 5);
expect(await scoresOf(env.DB, RATING_BOARD, ["p_seq"])).toEqual([{ playerId: "p_seq", score: 1100 }]);
```

"某件事不应该发生"比较难测，因为没有东西可以轮询。示例里的做法是等一段足够长的时间（1.5 秒，队列的批量等待是 1 秒）再检查。这类测试比较慢，只留了三个：不计分的对局不进排行榜，不计分的对局不触发邀请奖励，达到门槛之后不会发第二次。

## 7.11 示例项目的变化

这一章结束时，示例项目多了这些东西：

- `server/src/player.ts`：新增发件箱（`emit`、`flush` 和定时器重发）；结算时发出分数通知和邀请奖励通知；新增好友的七个方法、邀请的两个方法和 `getPublic`；资料表新增注册时间、计分胜场、邀请人等列。
- `server/src/social/events.ts`：通知的类型定义和消费者。
- `server/src/social/leaderboard.ts`：排行榜的写入和三种查询。
- `server/src/social/routes.ts`：`GET /leaderboard`、`GET /leaderboard/friends`、`GET /friends`、`POST /friends/request`、`POST /friends/accept`、`POST /friends/remove`、`POST /invite/accept`、`GET /invites`。
- `server/src/index.ts`：`queue` 处理函数按队列名分发。
- `server/migrations/0002_social.sql`：排行榜表和邀请关系表。
- `server/wrangler.jsonc`：新增 `player-events` 队列，两个环境各一套。
- 测试：新增 `test/social.test.ts`，16 个测试，覆盖分数进榜、乱序和重复的更新、同分的名次、好友的申请接受删除、互相申请、通知的重复处理、好友榜、邀请人的各条规则、达到门槛后发奖、去重和上限。服务端一共 74 个测试。

表结构有变化，本地运行前要再执行一次 `npm run db:local -w server`。

## 本章小结

- 排行榜、好友、邀请是同一类问题：一个玩家的数据要被别人看到，或者要去改另一个玩家的数据。
- 玩家对象用发件箱对外通知：通知和数据在同一个事务里写下，再送进队列，送不出去由定时器重发。跨玩家的数据因此是最终一致的，延迟在一两秒。
- 通知可能重复、可能乱序。能发绝对值就不发增量，接收方按序号覆盖；必须做加法时由接收方按编号去重。
- 去往不同对象的通知逐条确认，一条失败不拖累同一批里的其他通知。
- 排行榜的数据放 D1，是玩家对象里分数的副本。索引按榜名、分数、更新时间建，同分的排序规则要事先定好。
- 前 N 名所有人都一样，用缓存；自己的名次每次现查。两部分分开取，缓存才能共用。
- 名次是数出来的，排得越靠后越贵。精确名次只算到一个上限，更靠后的用分数分布表估算百分比。
- 榜名里带上赛季或周数，重置就是换个名字，不需要清空任何东西。
- 小而需要实时的榜，一个榜一个对象。把大榜设计成很多个小的分组榜，通常对玩家和后端都更好。
- 好友关系在两个人的对象里各存一份，每个操作先改自己这一半，再用通知改对方那一半。对方的每个方法都要能重复执行。两边交叉操作的每一种组合，最终都要落到两边一致的状态上。
- 名字由客户端提供的对象，要想清楚一个不存在的名字会造成什么。
- 好友数、待处理的申请数、单条查询的参数个数，都是要事先定下的上限。
- 邀请关系记在被邀请人的对象里：只能设置一次，只在注册后一段时间内有效，邀请人必须注册得更早。
- 邀请奖励发给行为，不发给注册。没有刷不了的门槛，只有成本不同的门槛。发奖按被邀请人去重，设总量上限，超限也要记账。只做一级邀请。

下一章做经济系统和支付：货币和背包怎么保证不出错，外部支付平台的回调怎么核销，掉单了怎么补。
