# 第 6 章　匹配与异步 PVP

到上一章为止，两个人要打一局，得先在游戏外面约好一个房间号。这一章解决"和谁打"的问题：想玩的人怎么凑成一局，凑不齐怎么办，对方根本不在线又怎么办。顺带把第 5 章留下的两件事做完：房间号由服务端分配，对局结束后留下记录。

这一章的代码在 [examples/shared/src/matchmaking.ts](../examples/shared/src/matchmaking.ts)、[examples/server/src/matchmaker.ts](../examples/server/src/matchmaker.ts)、[examples/server/src/match/](../examples/server/src/match/) 和 [examples/server/src/room.ts](../examples/server/src/room.ts)。

## 6.1 三种开局方式

示例项目现在有三种开局方式，后面各节分别展开：

| 方式 | 对手是谁 | 入口 | 计分 |
|---|---|---|---|
| 好友房 | 拿到房间号的人 | `POST /rooms` | 不计分 |
| 排位匹配 | 排队时配到的另一个玩家；等不到时是机器人 | `GET /match/ws`（WebSocket） | 计分 |
| 镜像对战 | 另一个玩家过去某一局的录像 | `POST /mirror` | 计分 |

三种方式最后都落到同一个东西上：**一个由服务端开好的房间**。房间里坐的是真人、机器人还是录像，对房间来说只是"这个座位由谁来出手"的区别，规则、结算、清理都是同一套。所以这一章先讲开房，再讲匹配，最后讲机器人和录像。

## 6.2 房间由服务端开

### 没开过的房间不存在

上一章的房间有个问题：任何人用任何名字去连，都会得到一个可用的房间。这意味着谁都能凭空造出对象，也没有办法规定"这个房间只给这两个人"。

现在房间多了一个 `open` 方法，只有服务端能调用。没有被 `open` 过的房间，谁也连不上：

```ts
async open(options: RoomOptions): Promise<void> {
  if (await this.ctx.storage.get(CONFIG_KEY)) return;

  // 机器人和录像在开房时就入座并准备好，走的是和真实玩家一样的规则。
  let state = initialState();
  for (const bot of options.bots) { /* join、ready */ }

  const timers: Timers = { start: Date.now() + (options.kind === "private" ? IDLE_MS : JOIN_MS) };
  await this.ctx.storage.put({ [CONFIG_KEY]: options, [STATE_KEY]: state, [TIMERS_KEY]: timers });
  await this.arm(timers);
}
```

开房时定下来的内容之后不再改变：

```ts
export interface RoomOptions {
  /** 好友房不计分；排位赛和镜像对战计分。 */
  kind: "private" | "ranked" | "mirror";
  /** 可以进这个房间的玩家。null 表示知道房间号的人都可以进。 */
  allowed: string[] | null;
  /** 开房时各个玩家的分数。 */
  ratings: Record<string, number>;
  bots: BotSeat[];
}
```

连接进来时先过这一关，再走上一章的加入逻辑：

```ts
const options = await this.options();
if (!options) return new Response("room_not_found", { status: 404 });
if (options.allowed && !options.allowed.includes(playerId)) {
  return new Response("not_allowed", { status: 403 });
}
```

有三处细节：

- **`open` 可以重复调用。** 第一行检查配置是否已经存在，存在就直接返回。调用方超时之后不知道上一次有没有成功，可以放心再调一次，不会把已经开始的对局冲掉。这和 3.7 节的操作编号是同一个要求：跨对象的调用都要能重试。
- **房间清理后，房间号就失效了。** 上一章清理房间时清空了全部存储，配置也在其中。之后拿着旧房间号来连的人会得到 404，客户端按"没有进行中的对局"处理。
- **`open` 是对象的 RPC 方法，外面访问不到。** 对象只能通过绑定访问，而绑定只在你自己的 Worker 里。入口没有把 `open` 暴露成 HTTP 接口，客户端就没有任何办法开房。

### 房间号用随机生成的对象 ID

房间号不再是一个名字，而是平台生成的对象 ID：

```ts
const id = env.ROOM.newUniqueId();
await env.ROOM.get(id).open({ kind: "private", allowed: null, ratings: {}, bots: [] });
return json({ roomId: id.toString() });
```

`id.toString()` 是一个 64 位的十六进制字符串。入口收到连接时用 `idFromString` 把它还原：

```ts
// 房间号是服务端生成的对象 ID，64 位十六进制。
const ROOM_WS = /^\/room\/([0-9a-f]{64})\/ws$/;

let id: DurableObjectId;
try {
  id = env.ROOM.idFromString(match[1]!);
} catch {
  // 不是这个命名空间生成的 ID。
  return fail(404, "room_not_found");
}
return env.ROOM.get(id).fetch(new Request(request, { headers }));
```

用随机 ID 而不是名字，有三个好处：

- **第一次访问更快。** 按名字第一次访问一个对象时，平台要确认全球没有同名对象在别处运行，这次检查最多要几百毫秒（3.3 节）。随机生成的 ID 不可能重名，这次检查被跳过。房间是整个系统里创建得最频繁的对象，这笔开销值得省。
- **猜不到。** 好友房的准入规则是"知道房间号的人都能进"，这要求房间号本身不能被枚举。
- **不会和别的房间撞名。** 用名字时，两组人恰好选了同一个名字就会进到一起。

代价是房间号很长，没法口头告诉朋友。好友房要给玩家一个短码时，另外存一张"短码到房间号"的对照表。短码的有效期和房间一样短，适合放在 KV 里并设置过期时间；短码要足够长（比如 6 位字母数字），并且对查询接口限流，否则可以被枚举。示例项目没有做短码，直接分享完整的房间号或者带房间号的链接。

### 开了房没人来

服务端开房带来一个新问题：房间开好了，该来的人没来。配置和初始状态已经写进了存储，如果没有人连接，上一章"人走光就清理"的逻辑永远不会触发，这个房间会一直占着存储。

所以开房的同时就定下一个开局的最后期限，记在第 5 章的那张定时表里：

```ts
interface Timers {
  /** 开局的最后期限。过了还在等待阶段，房间作废。 */
  start?: number;
  /** 轮到机器人时，它什么时候出手。 */
  bot?: number;
  turn?: number;
  settle?: number;
  close?: number;
}
```

到期时如果还在等待阶段，房间直接清理；对局一旦开始，这一项就被删掉：

```ts
// 该来的人没来齐，或者建了房一直没开局。
if (due((await this.timers()).start) && (await this.load()).phase === "waiting") {
  await this.destroy();
  return;
}
```

匹配房给 30 秒，好友房给 10 分钟。这两个数是示例的取值，原则只有一条，和上一章"每一局必须能自己结束"是同一条：**每一个被创建出来的房间，都必须有一条不依赖任何玩家的路径走向清理。**

## 6.3 匹配队列：一条连接就是一张票

### 排队用轮询还是用连接

玩家点了"开始匹配"之后，需要在一段不确定的时间之后得到一个结果。有两种做法：

| | 轮询 | WebSocket |
|---|---|---|
| 怎么排队 | 调一次接口入队，然后每隔一两秒查一次结果 | 建一条连接，等服务端推送结果 |
| 怎么取消 | 另外调一个接口 | 断开连接 |
| 玩家杀掉应用 | 队列里留下一张没人要的票，要靠超时清理 | 连接断了，票自动消失 |
| 请求量 | 每个等待中的玩家每秒约 0.5 到 1 次 | 入队一次 |
| 对象能否休眠 | 一直有请求进来，不能 | 没有事件时可以 |

单个对象的请求量有每秒约 1,000 次的软限制（1.6 节）。轮询的话，一千个人同时排队，光查询就把一个队列对象占满了。所以示例用 WebSocket：**连上就是入队，断开就是取消，配好之后服务端推送房间号并主动断开。**

```ts
/** 排队时服务端发给客户端的消息。排队的连接上，客户端不需要发任何消息，断开就是取消。 */
export type QueueMessage = { type: "queued" } | { type: "matched"; roomId: string };
```

鉴权方式和房间一样，访问令牌放在子协议里（4.8 节）。入口校验之后，把三样东西写进请求头交给匹配对象：

```ts
const player = env.PLAYER.getByName(playerId);
const [profile, account] = await Promise.all([player.getProfile(), player.getAccount()]);
if (account.banned) return fail(403, "banned");

// 地区取自请求进入 Cloudflare 的位置，分数取自玩家对象，都不由客户端提供。
const region = regionOf(request.cf?.continent as string | undefined);
const headers = new Headers(request.headers);
headers.set(PLAYER_HEADER, playerId);
headers.set(RATING_HEADER, String(profile.rating));
headers.set(REGION_HEADER, region);
```

注意分数的来源。匹配要用到玩家的分数，而分数是会被人动心思的数据：把自己报低一点，就能一直打新手。所以它和玩家 ID 一样，只能由服务端从可信的地方读出来，不能出现在客户端的请求里。

### 队列不需要另外保存

匹配对象里没有一张"队列表"。每条连接的附加数据里放着这张票的内容：

```ts
/** 跟着排队连接走的数据。队列本身不另外保存：还连着的就是还在排的。 */
interface Attachment extends Ticket {
  region: Region;
  /** 已经配好、正在开房。开房期间不能再被配给别人。 */
  matched: boolean;
}
```

要知道现在谁在排队，把所有连接过一遍就行：

```ts
for (const ws of this.ctx.getWebSockets()) {
  if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
  const ticket = ws.deserializeAttachment() as Attachment;
  if (ticket.matched) continue;
  sockets.set(ticket.playerId, ws);
  tickets.push(ticket);
}
```

这样做的好处是没有两份数据需要保持一致。如果另外存一张队列表，就要处理"表里有这个人，但他的连接已经断了"和"连接还在，但表里没有他"两种不一致。现在只有连接这一份数据，连接断了票就没了，不需要任何清理代码：

```ts
/** 连接断开就是取消排队。队列是从连接算出来的，不需要另外清理。 */
webSocketClose(ws: WebSocket): void {
  try {
    ws.close();
  } catch {
    // 已经关闭。
  }
}
```

附加数据在休眠后仍然保留（3.3 节），所以匹配对象在没人进出的间隙可以休眠，醒来后队列还在。

同一个玩家重复排队时，新的连接顶替旧的，做法和房间里一样，按玩家 ID 打标签，关闭码用 4001。

## 6.4 匹配规则是一个纯函数

"谁和谁配"是规则，和游戏规则一样放在 `shared` 里，写成纯函数：输入是当前所有的票和当前时间，输出是这一刻的结果。

```ts
export interface Ticket {
  playerId: string;
  rating: number;
  /** 开始排队的时间（Unix 毫秒）。 */
  since: number;
}

export interface MatchPlan {
  /** 配成对的玩家。 */
  pairs: [Ticket, Ticket][];
  /** 等得太久、要用机器人补位的玩家。 */
  solo: Ticket[];
  /** 下一次需要重新计算的时间；没有人在等时为 null。 */
  nextCheck: number | null;
}

export function planMatches(tickets: Ticket[], now: number): MatchPlan;
```

匹配是在两个目标之间找平衡：对手要实力接近，等待要短。常见的做法是让可接受的范围随等待时间放宽：

```ts
/** 等了 waitedMs 之后，能接受多大的分数差。 */
export function ratingWindow(waitedMs: number): number {
  return BASE_WINDOW + Math.floor(Math.max(0, waitedMs) / WIDEN_EVERY_MS) * WIDEN_STEP;
}
```

示例的取值是：起步接受 100 分以内的对手，每等 3 秒放宽 100 分，等满 10 秒还没有对手就安排机器人。

配对的过程是：按排队时间从早到晚，每个人在还没被配走的人里找分数最接近的那一个，条件是**双方**都能接受这个分数差。

```ts
// 双方都要能接受这个分数差。刚进来的人不会被立刻配给一个差距很大的对手。
if (gap > ratingWindow(now - ticket.since) || gap > ratingWindow(now - other.since)) continue;
```

"双方都接受"是一个选择。另一种选择是"任何一方接受就行"，这样等得久的人更快配到，但刚进来的人可能立刻遇到一个差距很大的对手。前者对局质量更好，后者等待更短。示例选了前者，因为等不到的人有机器人兜底。

### 时间由调用方传入

和第 5 章一样，规则里不读时钟。`planMatches` 的第二个参数就是当前时间，所以"等了 6 秒之后会怎样"不需要真的等：

```ts
it("差距太大时先等着，范围放宽后才配上", () => {
  const tickets = [ticket("a", 1000), ticket("b", 1250)];
  expect(planMatches(tickets, 0).pairs).toEqual([]);
  // 250 分的差距需要放宽两次。
  expect(planMatches(tickets, WIDEN_EVERY_MS).pairs).toEqual([]);
  expect(planMatches(tickets, WIDEN_EVERY_MS * 2).pairs).toHaveLength(1);
});
```

### 下一次什么时候算

匹配结果只在两种时候会变：有人进来或离开，或者某个人的等待时间跨过了一个门槛（范围放宽了一档，或者到了该补机器人的时间）。前者由连接事件触发，后者要靠定时器。

`planMatches` 把下一个门槛的时间算出来放在 `nextCheck` 里，匹配对象照着设定时器：

```ts
if (plan.nextCheck === null) await this.ctx.storage.deleteAlarm();
else await this.ctx.storage.setAlarm(plan.nextCheck);
```

不要用"每秒算一次"的写法。那样只要有一个人在排队，对象每秒都被唤醒一次；而按门槛来算，一个人从入队到配上机器人，最多被唤醒四次。

### 分数怎么变

示例的计分是最简单的一种：赢了加 16 分，输了扣 16 分，最低到 0。

```ts
export function ratingDelta(won: boolean): number {
  return won ? RATING_STEP : -RATING_STEP;
}
```

分数存在玩家对象里，和金币一样随结算一起更新，同一个事务，同一个操作编号：

```ts
sql.exec(
  `UPDATE profile SET coins = coins + ?, wins = wins + ?, games = games + 1,
     rating = MAX(0, rating + ?) WHERE id = 1`,
  result.coins,
  result.won ? 1 : 0,
  result.rating ?? 0,
);
```

`rating` 是结算参数里新增的一个可选字段。发版期间新旧代码并存（3.3 节），旧版本的房间调用新版本的玩家对象时不会带这个字段，按 0 处理。

固定加减分的问题是不看对手：赢了一个比自己强很多的人和赢了一个新手，加的分一样。正式的游戏通常用 Elo 这一类算法，按双方的分数差计算预期胜率，爆冷赢的加得多，赢了弱者加得少。换算法只需要改 `ratingDelta` 和它的调用处，因为开房时双方的分数已经记在房间配置里了。算法本身不是这本书的范围。

## 6.5 配好之后：开房时的并发

匹配对象每次计算的流程是：收集票，调用规则，给配好的人开房，把房间号发给他们。

```ts
private async run(): Promise<void> {
  // ……收集票……
  const plan = planMatches(tickets, Date.now());
  const groups = [...plan.pairs, ...plan.solo.map((ticket) => [ticket])] as Attachment[][];

  // 开房要调用别的对象，等待期间新的连接可以进来并再次触发计算。
  // 所以在等待之前，先把这些人标成"已配好"，并把下一次计算的时间定下来。
  for (const group of groups) {
    for (const ticket of group) this.mark(sockets.get(ticket.playerId)!, ticket, true);
  }
  if (plan.nextCheck === null) await this.ctx.storage.deleteAlarm();
  else await this.ctx.storage.setAlarm(plan.nextCheck);

  await Promise.all(groups.map((group) => this.start(group, sockets)));
}
```

中间那段注释说的是这一节的重点。

### 先标记，再等待

开房要调用房间对象，这是一次对外的调用。3.6 节讲过，对象在等待外部调用返回时，别的事件可以插进来。在这里就是：甲和乙刚被配成一对，正在等房间开好，这时丙连了进来，触发了又一次计算。如果这次计算看到的队列里还有甲，丙就可能和甲配到一起，甲同时出现在两个房间里。

所以顺序必须是：**先同步地把配好的人标记出来，再去做任何需要等待的事。** 标记写在连接的附加数据里，是同步操作，中间不会被打断。之后的计算会跳过被标记的人。

定时器也在等待之前设好，原因相同：每次计算设的是"按我看到的队列，下一次该什么时候算"。如果放在等待之后，一次较早开始但较晚结束的计算，会用它过时的结论覆盖掉较新的那一次。

### 房间就绪之后再通知

```ts
private async start(group: Attachment[], sockets: Map<string, WebSocket>): Promise<void> {
  const region = group[0]!.region;
  try {
    const id = this.env.ROOM.newUniqueId();
    const room = this.env.ROOM.get(id, { locationHint: REGIONS[region].hint });
    await room.open({ /* …… */ });
    // 房间已经就绪，再通知玩家。玩家连过来时不会遇到一个还不存在的房间。
    for (const ticket of group) {
      const ws = sockets.get(ticket.playerId)!;
      this.send(ws, { type: "matched", roomId: id.toString() });
      ws.close(1000, "matched");
    }
  } catch (error) {
    console.error("开房失败，稍后重试", error);
    // 把人放回队列。他们的连接还在，下一次计算时会重新参与。
    for (const ticket of group) this.mark(sockets.get(ticket.playerId)!, ticket, false);
    // ……把定时器提前到 1 秒之后……
  }
}
```

先开房再通知，有两个作用。一是玩家连过来时房间一定已经存在。二是这次调用顺便把房间对象拉起来了，玩家的连接到达时不用再等一次冷启动（3.3 节）。

开房失败时，把标记去掉，这些人回到队列里，一秒后重新计算。他们的排队时间没有被重置，所以不会因为一次失败而多等。

### 从配好到进房之间的空档

通知发出去之后，匹配对象的工作就结束了，它不再跟踪这两个人。但从"收到房间号"到"连进房间"之间有一段空档，这期间什么都可能发生：玩家的网络断了，应用被切到后台，或者玩家反悔了。

这种情况不需要匹配对象来处理。房间自己有 30 秒的开局期限（6.2 节），到期没开局就清理，已经进来的那个人的连接被关闭，关闭码是 4003。客户端看到这个关闭码，重新去排队即可。

这里有一个设计上的取舍：示例里没有"确认"这一步。有些游戏在配好之后会让双方各点一次"接受"，都接受了才开房。那样能减少有人没来的情况，代价是多一轮交互和多一种状态。对休闲游戏来说，直接开房、没来就作废，通常已经够了。

另外，示例没有处理一种情况：玩家已经在一局对局里，又跑去排队。防止这种情况需要在玩家对象里记下"当前所在的房间"（5.5 节提过），排队前检查。做这件事的时候要记得，那条记录只是一个提示，以房间自己的状态为准。

## 6.6 按地区分片

### 为什么要分

把所有玩家放进一个队列，有两个问题。

第一是延迟。对象创建之后不会迁移，一个巴西玩家和一个日本玩家配到一起，房间不论放在哪，总有一个人的每次操作要绕半个地球。回合制游戏对延迟不敏感，几百毫秒可以接受；但越接近实时的玩法，越需要把同一局的人限制在同一个地区。

第二是容量。一个对象每秒约 1,000 个请求，全球的排队流量都压在一个对象上，迟早会超。

所以队列按地区分开，每个地区一个匹配对象：

```ts
export const REGIONS = {
  asia: { hint: "apac" },
  europe: { hint: "weur" },
  america: { hint: "enam" },
} as const satisfies Record<string, { hint: DurableObjectLocationHint }>;

/** 按请求进入 Cloudflare 的位置所在的大洲决定地区。这个值由平台给出，客户端改不了。 */
export function regionOf(continent: string | undefined): Region {
  switch (continent) {
    case "AS":
    case "OC":
      return "asia";
    case "EU":
    case "AF":
      return "europe";
    case "NA":
    case "SA":
      return "america";
    default:
      return DEFAULT_REGION;
  }
}
```

`request.cf.continent` 是平台根据请求进入的位置填的，和玩家 ID、分数一样，不接受客户端传入。

### 分得越细，等得越久

地区划分是在延迟和等待时间之间做交换。分得越细，同一局的人离得越近；但每个队列里的人也越少，越难配到分数接近的对手，等待越长，机器人出现得越多。

示例只分了三个，把大洋洲并进亚洲，把非洲并进欧洲，把南美并进北美。这是一个偏向"先保证能配到人"的划分。实际怎么分要看你的玩家在哪：如果八成的玩家在东南亚，把东南亚单独拿出来、其余的合成一个，比按大洲均分更合理。

还有两个可以用的手段：

- **在线人数少的时段合并队列。** 入口根据时间或者各队列的人数，把小地区的玩家导向相邻的大地区。
- **等太久之后跨地区。** 玩家在自己地区的队列里等到一定时间还没有结果，客户端断开，改连相邻地区的队列。断开重连的成本很低，因为票不需要迁移。

### 位置提示

对象默认创建在离第一个访问者较近的地方（3.3 节）。匹配对象和房间都不能依赖这个默认行为：

- 匹配对象的名字是固定的，比如 `ranked:asia`。它的第一个访问者是谁完全是偶然的，可能是一个挂着代理、从别的大洲进来的玩家。
- 房间由匹配对象创建。不加提示的话，它会建在匹配对象附近，这通常是对的，但前提是匹配对象自己的位置是对的。

所以两处都明确给出位置提示：

```ts
// 入口：访问匹配对象时带上这个地区的提示。
env.MATCHMAKER.getByName(`ranked:${region}`, { locationHint: REGIONS[region].hint })

// 匹配对象：房间建在这个队列所在的地区，而不是匹配对象恰好运行的地方。
const room = this.env.ROOM.get(id, { locationHint: REGIONS[region].hint });
```

位置提示可以取的值有 `wnam`、`enam`、`sam`、`weur`、`eeur`、`apac`、`apac-ne`、`apac-se`、`oc`、`afr`、`me`。使用时要知道：

- **只在对象第一次被访问时生效。** 对象创建之后，提示不再起作用。所以每一次访问匹配对象都带上提示，保证不论谁是第一个，位置都是对的。
- **是尽力而为，不是保证。** 平台会选一个离提示地区延迟最低的数据中心，不一定就在那个地区内。
- **`sam`、`afr`、`me` 目前不会真的创建在当地。** 对象会被放到邻近的、支持的地点，官方举的例子是提示南美时会创建在北美东部。面向这三个地区的游戏要实测延迟，不要假设提示能解决问题。
- **`apac-ne` 和 `apac-se` 是 `apac` 里更小的范围。** 官方建议一般情况用 `apac`，只有玩家明确集中在东北亚或东南亚时才用更细的值。

好友房没有加提示。它由第一个访问者（建房的人）的请求创建，默认就在他附近，朋友之间通常也在同一个地区。

## 6.7 队列再大怎么拆

一个地区一个队列，能撑到多大？粗略算一下。每个玩家排一次队对匹配对象产生的事件大约是三四个：连接进来，一两次定时器触发，连接关闭。按每秒 1,000 个事件的软限制，一个队列每秒能接纳两三百人入队。对大多数休闲游戏的单个地区来说，这已经很多了。

另一个约束是计算量。`planMatches` 是平方级的，队列里同时等待的人数以百计时没有问题，上千就要考虑了。不过在匹配正常工作的情况下，同时等待的人数远小于在线人数：人越多，配得越快，每个人在队列里待的时间越短。

真的不够时，拆分的方向是**再加一个维度**，而不是优化单个对象：

- **按分段拆。** 青铜、白银、黄金各一个队列，对象的名字变成 `ranked:asia:gold`。分段边界上的玩家会配不到隔壁分段里分数很接近的人，解决办法和跨地区一样：等一段时间之后改投相邻的分段。
- **按玩法拆。** 不同的模式（两人局、四人局、限时活动）本来就不该互相配到，各用各的队列。

每拆一次，单个队列里的人都变少，等待都变长。所以原则是**能不拆就不拆**，先用一个队列上线，有了真实的数据再决定按哪个维度拆。拆分本身很便宜：对象是按名字自动创建的，改的只是入口里拼名字的那一行，以及发版时旧队列里还在等的那几秒钟的人（他们重连一次就到了新队列）。

## 6.8 机器人补位

### 为什么需要

新游戏上线的头几周，在线人数撑不起匹配。凌晨时段，小地区，高分段，都会出现排了半天没有对手的情况。玩家等 30 秒没有结果，大概率就走了，而他一走，下一个人更配不到。机器人是用来打破这个循环的。

示例的规则是等满 10 秒没有对手就补一个机器人。`planMatches` 把这些人放在 `solo` 里，匹配对象给他们开一个带机器人座位的房间：

```ts
// 只有一个人时，用机器人补上另一个座位。
bots: group.length === 1 ? [{ id: `bot:${crypto.randomUUID().slice(0, 8)}`, rolls: [] }] : [],
```

### 机器人是一个由服务端出手的座位

机器人没有连接，没有玩家对象，也没有单独的进程。它只是房间状态里的一个座位，区别在于轮到它时由房间自己出手。

它在开房时就入座并准备好，走的是和真人完全一样的规则操作：

```ts
for (const bot of options.bots) {
  for (const type of ["join", "ready"] as const) {
    const result = applyAction(state, { type, playerId: bot.id });
    if (!result.ok) throw new Error(`机器人入座失败：${result.error}`);
    state = result.state;
  }
}
```

轮到机器人时，房间在定时表里记一个出手时间：

```ts
if (current && isServerSeat(current)) {
  // 轮到机器人：过一小段时间再出手，不要瞬间完成。
  if (currentPlayer(before) !== current || timers.bot === undefined) {
    timers.bot = Date.now() + BOT_MIN_MS + Math.floor(Math.random() * BOT_SPREAD_MS);
  }
} else {
  delete timers.bot;
}
```

到点之后，定时器处理函数替它掷一次骰子，交给同一个 `apply`：

```ts
private async playBot(): Promise<void> {
  const botId = currentPlayer(await this.load());
  // ……
  const dice = seat?.rolls[played] ?? rollDice();
  await this.apply({ type: "roll", playerId: botId, dice });
}
```

这样做的结果是机器人不需要任何特殊处理：

- **规则不知道机器人的存在。** `rules.ts` 一行没改。机器人的每一步都经过和真人一样的校验，不可能做出规则不允许的事。
- **不占资源。** 没有连接，没有常驻的东西。机器人"思考"的那一两秒里，房间对象可以休眠，到点被定时器唤醒。
- **结算时跳过。** 机器人没有玩家对象，结算名单里过滤掉 `isServerSeat` 的座位。但它仍然在对局记录的参与者名单里。
- **真人走光时一样能结束。** 真人中途退出，剩下机器人一个，按上一章的规则直接判胜、结算、清理。

延迟出手不只是为了像人。瞬间出手的话，真人的操作和机器人的回应会挤在同一刻广播出去，客户端来不及播动画，体验上像是丢了一步。示例里是 1 到 3 秒的随机延迟。

### 机器人的决策

这个示例游戏没有决策，轮到谁谁就掷骰子，所以机器人只需要"出手"。有决策的游戏（走哪个棋子、出哪张牌）里，机器人还需要一个选择动作的函数。它应该和规则放在一起，同样写成纯函数：

```ts
// 示意：输入是机器人能看到的状态，输出是一个操作。随机数由调用方传入。
export function chooseBotAction(view: PlayerView, botId: string, random: number): Action;
```

写成纯函数的理由和规则一样：能用测试覆盖，行为能复现，出了问题能拿着当时的状态重放。几条实践上的建议：

- **用规则算法，不要调用模型。** 第 1 章说过，机器人的决策不要交给大模型。一次模型调用几百毫秒到几秒，每一步都要花钱，输出不稳定，而且房间对象在等待期间既不能休眠，又会让别的消息插进来。写几十行启发式规则（能吃子就吃，能到终点就走，否则走最靠前的那个）又快又便宜，对休闲游戏已经足够。
- **只给它看它该看的。** 有隐藏信息的游戏，机器人拿到的应该是 5.3 节那种按玩家过滤过的视图，而不是完整状态。否则它等于在作弊，而且玩家迟早会发现。
- **难度靠犯错来调，不靠作弊。** 让低难度的机器人以一定概率选次优的动作，而不是偷偷改它的骰子。前者是可以公开的设计，后者被发现一次就够了。

### 要不要告诉玩家

示例里机器人的 ID 以 `bot:` 开头，客户端一看就知道对面不是真人。很多游戏选择不告诉玩家：给机器人起一个像真人的名字和头像，计分照常。

这是产品上的决定，但技术上有几点要知道：

- **要隐瞒就得处处一致。** 机器人的 ID 格式、名字、出手节奏、资料页、对局记录，任何一处露出破绽都瞒不住。ID 要和真人用同一种格式，是不是机器人只记在服务端的房间配置里，不进入发给客户端的状态。
- **计分要想清楚。** 示例里打机器人和打真人一样加减分。如果机器人很弱，玩家可以靠在冷门时段刷机器人上分；如果打机器人不计分，玩家立刻就能分辨出来。常见的折中是机器人的强度跟着玩家的分数走，并且只在低分段和等待超时的时候出现。
- **涉及真钱的玩法不要用机器人冒充真人。** 有门票和奖金的对局里让玩家和伪装成真人的机器人对赌，在很多地区有法律风险。这类玩法宁可让玩家多等，或者退票。

## 6.9 对局记录

### 记下每一步

上一章结尾说，房间清理之后，这一局的信息只剩玩家对象流水里的几行。现在把完整的记录留下来。

房间在每次掷骰子或超时轮空时，往一份日志里追加一条：

```ts
// 把这一步记下来。这份记录既是对局记录，也是以后镜像对战用的录像。
let log: LogEntry[] | null = null;
if (action.type === "roll" || action.type === "timeout") {
  const entry = { playerId: action.playerId, dice: action.type === "roll" ? action.dice : 0 };
  log = [...(await this.log()), entry];
  writes[LOG_KEY] = log;
}
```

`writes` 就是上一章那次合并写入：状态、定时表、日志、待结算记录，在同一次 `put` 里完成。不会出现"状态往前走了一步，但日志里没有这一步"的情况。

记下来的是**操作**，不是每一步之后的状态。规则是确定性的（2.3 节），有了初始状态和完整的操作序列，任何一个中间状态都能重新算出来。这份日志有三个用途：

- **客服和排查。** 玩家说"我明明赢了"，拿出日志重放一遍。
- **反作弊。** 离线分析哪些玩家的操作模式异常（第 11 章）。
- **录像。** 下一节的镜像对战直接用它。

日志存在房间自己的存储里，对局期间不出对象。这个游戏一局十几到二三十步，一条记录几十个字节，大小不是问题。步数很多的游戏要注意单个值的大小上限，按回合分段存，或者每隔一段直接送出去。

### 送出去：和结算走同一条路

对局结束时，记录和结算一起写进待办：

```ts
writes[PENDING_KEY] = {
  matchId,
  results: /* 给各个玩家对象的结算 */,
  record: { matchId, kind, winner: after.winner, players, ratings: options?.ratings ?? {}, log, endedAt: Date.now() },
} satisfies PendingSettlement;
```

然后在 `settle` 里依次送出：

```ts
for (const r of pending.results) {
  await this.env.PLAYER.getByName(r.playerId).applyMatchResult(pending.matchId, { /* …… */ });
}
// 对局记录送进队列。队列可能重复投递，消费者按 matchId 去重。
if (pending.record) await this.env.MATCH_LOG.send(pending.record);
await this.ctx.storage.delete(PENDING_KEY);
```

和第 3 章的结算是同一个模式：先把待办存进自己的存储，再往外送，全部成功才删掉待办；任何一步失败，定时器过几秒重试。重试时前面已经成功的步骤会再执行一次，所以每个接收方都要按 `matchId` 去重。房间的清理仍然排在这一切成功之后，记录没送出去的房间不会被清掉。

`if (pending.record)` 这个判断是为发版准备的。新代码上线的那一刻，可能有旧代码写下的待办还没处理完，那里面没有 `record`。5.12 节说过房间的状态要兼容，这就是一个具体的例子。

为什么是送进队列，而不是由房间直接写 D1？

- **房间不该等一次数据库写入。** 队列的发送很快，而且失败的方式简单。
- **削平写入。** 晚高峰每秒结束几百局，直接写就是每秒几百次单行写入。消费者一批处理几十条，合成一次批量写入。
- **换存储时不用动房间。** 以后想把记录改存 R2，或者同时送一份到数据分析的管线，改的只是消费者。

### 消费者：批量写入，重复无害

入口多了一个 `queue` 处理函数：

```ts
/** 对局记录的消费者：把一批记录写进 D1。抛出异常时整批会被重新投递，写入是幂等的。 */
async queue(batch: MessageBatch<MatchRecord>, env: Env): Promise<void> {
  await saveRecords(
    env.DB,
    batch.messages.map((message) => message.body),
  );
},
```

`saveRecords` 把一批记录拼成一组语句，用 `db.batch` 一次提交：

```ts
statements.push(
  db
    .prepare("INSERT OR IGNORE INTO match_record (match_id, kind, winner, players, log, ended_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(record.matchId, record.kind, record.winner, JSON.stringify(record.players), JSON.stringify(record.log), record.endedAt),
);
// ……排位赛里每个真实玩家再写一行录像……
if (statements.length > 0) await db.batch(statements);
```

要点有三个：

- **`INSERT OR IGNORE` 加主键就是去重。** 队列保证至少投递一次，同一条记录可能来两次；房间重试时也可能发两次。`match_id` 是主键，第二次写入被忽略。
- **`db.batch` 是一个事务。** 一批语句要么都成功，要么都不成功。
- **失败就抛出异常。** 处理函数抛出异常时，整批消息会被重新投递。因为写入是幂等的，重投没有副作用，所以这里不需要逐条确认。

### 配置

```jsonc
// 对局记录和录像。没有填 database_id：第一次发布时由 wrangler 创建并把 ID 写回这个文件。
"d1_databases": [{ "binding": "DB", "database_name": "game-example", "migrations_dir": "migrations" }],

// 房间把对局记录送进队列，同一个 Worker 的 queue 处理函数负责写进 D1。
"queues": {
  "producers": [{ "binding": "MATCH_LOG", "queue": "match-log" }],
  "consumers": [
    {
      "queue": "match-log",
      "max_batch_size": 50,
      "max_batch_timeout": 5,
      "max_retries": 5,
      "dead_letter_queue": "match-log-dlq"
    }
  ]
},
```

- **批量的两个参数是"或"的关系。** 攒够 50 条，或者等满 5 秒，先到哪个就触发。记录晚几秒落库没有关系，所以可以攒得多一些。
- **一定要配死信队列。** 一条消息重试 5 次仍然失败（比如记录的格式有问题），会被转到 `match-log-dlq`。不配的话，官方的说法是这些消息最终会被丢弃，你甚至不知道丢过。死信队列里的东西要有人看，第 10 章会给它加告警。
- **资源可以自动创建。** D1 和队列的绑定没有填资源 ID 时，`wrangler deploy` 会自动创建，并把 ID 写回配置文件。预发环境用的是另一组名字，两个环境的数据互不相干（2.9 节）。
- **表结构要自己执行。** 自动创建的是一个空库。建表语句在 `migrations/` 目录里，发布前执行 `wrangler d1 migrations apply DB --remote`，本地开发时把 `--remote` 换成 `--local`。

队列按操作次数计费，一条消息从写入、读取到删除通常算 3 次操作。付费版每月包含 100 万次操作，也就是大约 33 万局的记录，超出每百万次 0.40 美元。对局记录这点量基本不用考虑费用。

### 保留多久

对局记录会一直增长。D1 单个库的上限是 10 GB，一局的记录按 1 KB 算，是一千万局。需要定下保留策略：比如 D1 里只留最近 30 天，更早的按天打包存进 R2，或者直接删除。定期清理用定时触发器来做，第 9 章会讲。

## 6.10 异步对战：对手不需要在线

### 三种做法

实时匹配要求两个人同时在线、同时有空。很多手机游戏的主要玩法并不要求这一点：玩家随时打开，立刻有对手，打完就走。对手是另一个真实玩家留下的某种"替身"。按替身记录的内容，有三种做法：

| 做法 | 替身是什么 | 适合 | 要求 |
|---|---|---|---|
| 快照 | 对手某一刻的配置：阵容、防守布局、卡组 | 对手不需要做决策，或者决策由固定的 AI 完成。SLG 的攻城、卡牌的竞技场防守 | 最少。存一份数据即可 |
| 操作重放 | 对手在某一局里的完整操作序列 | 双方互不影响的玩法：竞速、各玩各的再比分数 | 规则必须是确定性的 |
| 决策重放 | 对手在各种局面下做过的选择 | 双方互相影响的玩法：棋类、互动的卡牌 | 要定义"局面"怎么比对，以及没见过的局面怎么办 |

三种做法从上到下越来越像在和真人对战，实现上也越来越难。

**快照**最简单。玩家调整完防守阵容，存一份到 D1；别人来打时取出来，由规则里的 AI 操作这套阵容。玩家对象仍然是这份数据的唯一写入者，D1 里的是用来被别人查到的副本，由队列异步同步过去，具体的做法见第 7 章的发件箱。

**操作重放**要求两边的操作互不影响。如果对手的操作序列是"第三回合吃掉你的棋子"，而这一局里你的棋子不在那个位置，这条操作就失去了意义。所以它只适合竞速类和各自计分类的玩法。

**决策重放**是为互相影响的玩法准备的：记录的不是"做了什么"，而是"在什么局面下选了什么"。重放时拿当前的局面去找最接近的记录，找不到就交给机器人的决策函数。它的效果取决于局面怎么抽象，是游戏设计层面的问题，这里不展开。

不论哪一种，有一个共同的前提：**规则是确定性的，随机数由外部传入。** 这是 2.3 节定下的约定，到这里才真正用上。如果规则内部自己调用随机数，同样的操作序列每次重放的结果都不一样，后两种做法都无法成立。

### 异步对战里谁在线

异步对战的房间里只有一个真人。这带来几个和实时对战不同的地方：

- **不需要排队。** 对手是从库里挑出来的，立刻就有。所以入口是一个普通的 HTTP 接口，不是 WebSocket。
- **被挑战的人不知情。** 他的替身输了或赢了，他本人不在场。要不要影响他的分数是一个设计决定：示例里不影响；有防守玩法的游戏通常会给防守方记一条战报，并且扣分比进攻方加的分少，否则玩家一觉醒来掉了几百分。
- **节奏可以更快。** 没有人在另一头等，回合计时可以更宽松，替身的出手延迟可以更短。

## 6.11 示例里的镜像对战

示例实现的是操作重放。骰子竞速正好是"双方互不影响"的玩法：每个人只管往前走，对手走到哪里不影响自己。

### 录像从哪里来

上一节的对局记录里已经有每一步了。消费者在写对局记录的同时，把排位赛里每个真实玩家的操作单独抽出来，存成一行录像：

```ts
// 只有排位赛里真实玩家的操作才进录像池。
if (record.kind !== "ranked") continue;
for (const playerId of record.players) {
  const rating = record.ratings[playerId];
  if (isServerSeat(playerId) || rating === undefined) continue;
  const rolls = record.log.filter((e) => e.playerId === playerId && e.dice > 0).map((e) => e.dice);
  if (rolls.length < MIN_REPLAY_ROLLS) continue;
  // ……INSERT OR IGNORE INTO replay……
}
```

哪些东西不进录像池是有讲究的：

- **好友房不进。** 好友房没有分数，而且两个人可以串通打出一段特别弱的录像。
- **机器人和录像不进。** 否则录像池会被自己的产物填满。
- **太短的不进。** 开局就掉线的那种录像，拿来当对手没有意义。

### 挑一个对手

```ts
export async function pickReplay(db: D1Database, rating: number, excludePlayerId: string, window = 200) {
  const row = await db
    .prepare(
      `SELECT player_id, rolls FROM replay
       WHERE rating BETWEEN ? AND ? AND player_id != ?
       ORDER BY RANDOM() LIMIT 1`,
    )
    .bind(rating - window, rating + window, excludePlayerId)
    .first<{ player_id: string; rolls: string }>();
  // ……
}
```

这是第 3 章说的"需要跨玩家查询的数据放 D1"的一个具体例子：要在所有玩家的录像里按分数范围找一条，这件事任何单个玩家对象都做不了。

`ORDER BY RANDOM()` 会把范围内的行都读一遍再随机取一条。`rating` 上有索引，范围内只有几百上千行时没有问题；D1 按读取的行数计费，录像池很大时这条查询就贵了。到那时换一种取法：给每行存一个随机数并建索引，查询时随机生成一个值，取大于它的第一行。

### 录像是一个预先定好点数的座位

镜像对战的接口做三件事：挑录像，开房，返回房间号。

```ts
const replay = await pickReplay(env.DB, profile.rating, claims.sub);
// 录像池里没有合适的对手时，退回到普通的机器人。
const opponent = replay
  ? { id: `ghost:${replay.playerId}`, rolls: replay.rolls }
  : { id: `bot:${crypto.randomUUID().slice(0, 8)}`, rolls: [] };
const id = env.ROOM.newUniqueId();
await env.ROOM.get(id).open({
  kind: "mirror",
  allowed: [claims.sub],
  ratings: { [claims.sub]: profile.rating },
  bots: [opponent],
});
return json({ roomId: id.toString(), opponent: opponent.id });
```

房间这边不需要为录像写任何新代码。录像和机器人是同一种座位，唯一的区别是 `rolls` 里有没有预先定好的点数：

```ts
// 这个座位已经走了几步，就从录像的第几步接着取。
const played = (await this.log()).filter((entry) => entry.playerId === botId).length;
const dice = seat?.rolls[played] ?? rollDice();
```

有点数就按顺序取，取完了就随机掷。后一种情况是会发生的：录像的主人在原来那一局里输了，他的录像没有走到终点，而这一局里对手可能比当时慢。录像用完之后，这个座位就变成了普通的机器人。这也是所有重放类玩法都要回答的问题：**记录用完了，或者对不上了，怎么办。** 答案通常都是退回到机器人。

`allowed` 里只有挑战者一个人。镜像对战是一个人的对局，别人拿到房间号也进不来。

### 这个例子的局限

要说清楚的是，这个示例游戏没有决策，录下来的"操作"其实只是骰子的点数，也就是对手当时的运气。所以这里的镜像对战在玩法上没有什么意思，它演示的是机制：操作怎么记下来，怎么进到一个可查询的池子里，怎么变成另一局里的一个座位，记录用完之后怎么收尾。

换成一个有决策的竞速游戏，记录的内容会变成"在第几步选了哪条路"，重放时把选择交给规则去执行，骰子重新掷。机制完全一样，改的只有 `LogEntry` 里记什么，和 `playBot` 里怎么用它。

还有一件事示例没有做：**录像要带上规则的版本。** 规则改了之后（比如终点从 20 格改成 30 格），旧录像在新规则下的含义就变了。每条录像记下它产生时的规则版本，挑选时只挑当前版本的，或者在规则变更时清空录像池。

## 6.12 测试

这一章的东西大多和时间有关，而且跨了几个对象。测试的办法和上一章相同：把时钟拨快，然后让指定对象的定时器立即触发。

```ts
async function advance(stub: DurableObjectStub, ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
  await runDurableObjectAlarm(stub);
}

/** 排队直到拿到房间号。只有一个人时需要把时钟拨到补位的时间。 */
async function matchAlone(session: Session): Promise<string> {
  const ticket = await enqueue(session);
  expect(await ticket.next()).toEqual({ type: "queued" });
  await advance(matchmaker(), BOT_AFTER_MS);
  const matched = await ticket.next();
  // ……
}
```

和机器人打完一整局的测试，就是轮到自己时发消息，轮到对方时触发房间的定时器：

```ts
while (message.state.phase === "playing") {
  const current = message.state.players[message.state.turn]!.id;
  if (current === me.playerId) me.ws.send(JSON.stringify({ type: "roll", version: message.state.version }));
  else await advance(await roomStub(room), BOT_MIN_MS + BOT_SPREAD_MS);
  message = expectState(await me.next());
}
```

D1 和队列在测试环境里都是本地模拟的，有两处要配置。

**D1 的表结构。** 测试用的是一个空库，要在测试开始前把迁移执行一遍。迁移文件在 Node.js 这一侧读取，通过一个只在测试里存在的绑定传给测试代码：

```ts
// vitest.config.ts
cloudflareTest(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: { /* …… */ TEST_MIGRATIONS: migrations } },
  };
}),

// test/apply-migrations.ts，在 vitest 配置的 setupFiles 里引用
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

**队列的消费者。** 可以直接构造一批消息，调用入口模块导出的处理函数：

```ts
const batch = createMessageBatch<MatchRecord>("match-log", [
  { id: `msg-${i}`, timestamp: new Date(), body, attempts: 1 },
]);
await worker.queue(batch, env);
```

同一条记录这样投递两次，再去查表里是不是只有一行，幂等就测到了。

另外有一个端到端的测试：真的排队，和机器人打完一局，然后等记录出现在 D1 里。本地的队列会按配置的 5 秒批量等待时间投递，所以这个测试要真实地等几秒。它是这一组里唯一慢的测试，但它验证的是整条链路确实接上了，值得留着。

## 6.13 示例项目的变化

这一章结束时，示例项目多了这些东西：

- `shared/src/matchmaking.ts`：匹配规则 `planMatches`、可接受分数差的计算、计分。
- `shared/src/protocol.ts`：排队连接上的消息类型，以及判断一个座位是不是由服务端操作的 `isServerSeat`。
- `server/src/matchmaker.ts`：匹配对象。队列从连接的附加数据里算出来，没有额外的存储。
- `server/src/match/`：地区划分（`region.ts`）、匹配和开房的接口（`routes.ts`）、对局记录和录像的读写（`record.ts`）。
- `server/src/room.ts`：新增 `open` 和准入检查；定时表多了开局期限和机器人出手两项；每一步写进日志；结算时把对局记录送进队列；结算带上分数的变化。
- `server/src/player.ts`：资料里多了排位分数，随结算更新。
- `server/src/index.ts`：房间号改为对象 ID；新增 `queue` 处理函数。
- `server/migrations/0001_match_records.sql`：对局记录表和录像表。
- `server/wrangler.jsonc`：新增匹配对象、D1 和队列的绑定，两个环境各一套。
- 测试：规则新增 8 个，一共 29 个；服务端新增 `test/match.test.ts`，18 个测试，覆盖开房准入、配对、取消、顶替、封禁、机器人补位、无人到场的房间作废、对局记录的幂等写入、录像的筛选、镜像对战。服务端一共 58 个测试。
- 联调页面：多了排位匹配、镜像对战、建好友房三个按钮。

**接口有不兼容的变化**：`/room/:id/ws` 里的房间号不再接受任意名字，必须是服务端返回的房间号。

本地运行前要先建表：

```bash
npm run db:local -w server
```

它执行的是 `wrangler d1 migrations apply DB --local`。

## 本章小结

- 房间由服务端开。没有开过的房间不存在，开房时定下谁能进；开房可以重复调用。
- 房间号用随机生成的对象 ID：首次访问不需要全球重名检查，也猜不到。
- 每一个被创建出来的房间都要有一条不依赖玩家的路径走向清理，所以开房的同时定下开局期限。
- 排队用一条 WebSocket：连上是入队，断开是取消。队列从连接的附加数据里算出来，不另外保存，也就没有需要清理的残留。
- 分数、地区和玩家 ID 一样，由服务端从可信的来源读取，不接受客户端传入。
- 匹配规则是纯函数，时间由调用方传入。可接受的分数差随等待时间放宽；规则告诉调用方下一次什么时候再算，不要每秒空转。
- 调用别的对象之前，先同步地把已经配好的人标记出来。等待期间别的事件会插进来。
- 先把房间开好，再通知玩家。从通知到进房之间的空档由房间的开局期限兜底。
- 队列按地区分开，匹配对象和房间都明确给出位置提示。提示只在首次访问时生效，是尽力而为，部分地区目前不会真的创建在当地。
- 分片越细，等待越长。先用一个队列上线，有数据之后再决定按什么拆。
- 机器人是一个由服务端出手的座位，走和真人一样的规则，用定时器延迟出手，结算时跳过。决策用规则算法，不调用模型。
- 对局记录记的是操作而不是状态，和状态在同一次写入里保存；结束时和结算一起进待办，经队列批量写入 D1，消费者按主键去重，并配置死信队列。
- 异步对战有快照、操作重放、决策重放三种做法，前提都是规则是确定性的。记录用完或对不上时退回到机器人。
- 录像和机器人是同一种座位，区别只是有没有预先定好的操作。

下一章做排行榜和社交：没有 Redis 时排行榜怎么做，好友和邀请关系存在哪里，以及邀请奖励怎么防刷。
