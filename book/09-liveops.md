# 第 9 章　LiveOps

游戏上线之后，大部分工作不再是写新功能，而是运营：调一个价格，开一个周末活动，给受故障影响的玩家发补偿，封掉一个开挂的账号，查一笔玩家说没到账的充值。这些事每天都在发生，而且不能每次都靠发版来做。

这一章做的就是让这些事不用发版。前面几章留下的"第 9 章再做"的事项也都在这里收尾。

这一章的代码在 [examples/shared/src/liveops.ts](../examples/shared/src/liveops.ts) 和 [examples/server/src/ops/](../examples/server/src/ops/)。

## 9.1 运营要动的三类东西

| 类别 | 例子 | 谁来改 | 放在哪 |
|---|---|---|---|
| 所有人共用的配置 | 商店价格、活动时间、公告、实验分组 | 运营，通过后台 | KV |
| 针对某个玩家的操作 | 封禁、补偿、补单、查流水 | 客服，通过后台 | 玩家对象 |
| 定期要做的事 | 清理过期数据、核实未付款的订单、重算统计 | 没有人，定时触发 | D1 和各种对象 |

三类东西有一个共同的要求：**改动必须是有记录、可回退的。** 发版有代码评审、有版本历史、有回滚命令；运营操作绕过了这一切，所以要自己把这几样补上。

## 9.2 在线配置

### 用 KV

第 3 章说过 KV 的脾气：读很快，全球都有缓存；写入之后，其他地方可能要 60 秒甚至更久才能读到新值。它不适合任何"写完马上要读到"的数据，但非常适合配置：读得极多，改得极少，晚一分钟生效没有关系。

整份配置是一个 JSON 文档，放在一个键里：

```ts
export interface GameConfig {
  /** 每次修改加一。客户端和缓存都靠它判断配置变了没有。 */
  version: number;
  /** 公告。空字符串表示没有。 */
  notice: string;
  shop: Record<string, ShopEntry>;
  events: GameEvent[];
  experiments: Record<string, Experiment>;
}
```

为什么是一整份文档，而不是每个配置项一个键？因为配置项之间是有关联的：活动引用了商品，实验引用了活动。分成多个键，就可能在某个瞬间读到新的活动配上旧的商品。一份文档要么整个是旧的，要么整个是新的。KV 单个值的上限是 25 MiB，一份配置远远用不完。

读取时带上缓存时间：

```ts
/** 读当前的配置。还没发布过时用代码里的默认值。 */
export async function loadConfig(env: Env): Promise<GameConfig> {
  const stored = await env.CONFIG.get<GameConfig>(CURRENT_KEY, { type: "json", cacheTtl: CACHE_TTL_SECONDS });
  return stored ?? DEFAULT_CONFIG;
}
```

`cacheTtl` 是这个值在当地缓存多久，最小 30 秒，示例用 60 秒。缓存期内的读取不离开当前的数据中心，延迟很低，这也是每个请求都读一次配置而不用担心开销的原因。

**代码里要有一份默认配置。** KV 里什么都没有的时候（新环境、测试、本地开发），服务要能正常运行。

### 配置在哪里读

配置由入口来读，不由对象来读。以商店为例：

```ts
// 商品和价格来自运营配置，价格里已经算上了此刻正在进行的折扣。
const config = await loadConfig(env);
const price = shopCost(config, body.itemId, Date.now());
if (!price) return fail(400, "bad_request");
// 扣钱和给东西是同一次变更，不会出现扣了钱没拿到东西。
const cost = { coins: -price.coins, gems: -price.gems };
const result = await player.transact(`buy:${body.opId}`, "buy", combine(cost, config.shop[body.itemId]!.grant));
```

入口读出配置，算好这次购买的内容，把结果交给玩家对象。玩家对象不知道配置的存在。这样做的理由是 3.6 节的约定：对象在读、改、写之间不要等待外部调用，而读 KV 是一次外部调用。

第 8 章的商店商品表原来写在代码里，现在搬进了配置。充值商品（用真钱买的）仍然留在代码里，这是有意的：充值的订单从下单到付款之间隔着一段时间，这期间价格如果被改了，就会出现"付的钱和商品的价格对不上"。要把充值商品也放进配置，订单在创建时就得把当时的价格和内容完整地记下来，发货时用订单里记的，而不是再去读配置。示例没有做这一步。

### 发布之前先检查

配置一旦写进去，所有玩家都会读到。一份填错的配置造成的损失可能比一次有缺陷的发版更大：发版有灰度（2.10 节），配置没有。所以发布之前要把能查的都查了：

```ts
export function validateConfig(input: unknown): GameConfig | string {
  // ……
  for (const [itemId, raw] of Object.entries(input.shop)) {
    // ……
    if (!isCount(coins) || !isCount(gems)) return `shop.${itemId} 的价格必须是非负整数`;
    // 免费的商品几乎一定是填错了。
    if (coins + gems === 0) return `shop.${itemId} 没有价格`;
    // ……
    if (!isCount(qty) || qty === 0 || qty > 1000) return `shop.${itemId} 发放的数量不合理`;
  }
  // ……活动的结束时间要晚于开始时间，折扣在 1 到 90 之间，实验的权重不能全是 0……
}
```

校验分两层。第一层是格式：该是数字的是数字，该有的字段都有。第二层是常识：价格为 0，一次发一万个道具，打 100 折，这些在格式上都合法，但几乎一定是填错了。**第二层比第一层重要。** 运营事故里很少有"格式不对"，大多是"多打了一个零"。

这个函数还做了一件事：只把认识的字段取出来重新组装，多余的字段不会被保存。这和第 5 章解析客户端消息的做法相同。

### 版本号、历史和回滚

```ts
export async function publishConfig(env: Env, input: unknown): Promise<GameConfig | string> {
  const next = validateConfig(input);
  if (typeof next === "string") return next;
  const current = await loadConfig(env);
  if (next.version !== current.version + 1) {
    return `版本号应该是 ${current.version + 1}，收到的是 ${next.version}`;
  }
  const text = JSON.stringify(next);
  // 每个版本单独留一份，出问题时可以找回任何一个历史版本。
  await env.CONFIG.put(`config:v${next.version}`, text);
  await env.CONFIG.put(CURRENT_KEY, text);
  return next;
}
```

**版本号必须正好加一。** 运营甲和运营乙同时打开后台，各自在版本 7 的基础上改了点东西。甲先提交，版本变成 8。乙提交的也是 8，被拒绝，他需要重新加载再改。没有这个检查的话，乙的提交会悄悄盖掉甲的修改。

要说明的是，这个检查并不严密。KV 是最终一致的，读到的"当前版本"可能是旧的，两个几乎同时的提交有可能都通过。对配置发布这种一天几次的人工操作，这已经够用。需要严格保证时，把"当前版本号"放进一个对象里，由对象来裁决。

**每个版本都留一份。** 回滚就是把某个旧版本的内容作为一个新版本重新发布：

```ts
// 回滚：把某个历史版本的内容作为一个新版本重新发布。版本号只增不减。
const result = await publishConfig(env, { ...old, version: current.version + 1 });
```

版本号只增不减。回滚不是"退回到版本 5"，而是"发布版本 9，内容和版本 5 一样"。这样客户端和缓存的"版本号变大了才更新"的逻辑不需要任何特殊处理，历史记录也完整地保留了"发生过一次回滚"这件事。

## 9.3 客户端怎么知道配置变了

第 5 章讨论跨房间广播时说过：公告、活动、配置更新这类东西，晚一分钟没关系，不要推送，让客户端来拉。现在把拉取做出来。

```ts
const config = await loadConfig(env);
// 版本没变就不用再传一遍内容。活动的开始和结束不改变版本，所以客户端按时间自己判断。
const etag = `"v${config.version}"`;
if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
```

客户端启动时取一次配置，记下应答头里的 `ETag`。之后每隔几分钟（或者每次回到大厅时）带着它再问一次。版本没变，服务端返回 304，没有正文。这是 HTTP 自带的机制，不需要自己设计协议。

应答里给客户端的内容：

```ts
const body = {
  version: config.version,
  notice: config.notice,
  // 商品给出原价，以及此刻的实际价格。
  shop: /* …… */,
  // 正在进行和将要开始的活动都发下去，客户端可以提前显示倒计时。
  events: config.events.filter((event) => event.endsAt > now),
  active: activeEvents(config, now).map((event) => event.id),
  variants,
  serverTime: now,
};
```

两处细节：

- **带上服务端的当前时间。** 客户端要显示"活动还有多久结束"，但玩家手机的时钟可能不准，甚至是故意调过的。客户端用 `serverTime` 和本地时间的差值来修正显示。判断活动是否生效的永远是服务端，客户端的时间只影响显示。
- **只发客户端需要的。** 实验的完整定义（有哪些组、各占多少）留在服务端，客户端只拿到自己被分到了哪一组。

需要更快感知时，可以在别的接口的应答里捎带当前的配置版本号（比如放在一个应答头里），客户端发现版本变了再去拉。这样不用缩短轮询的间隔，活跃的玩家几秒内就能感知到。

每次轮询都是一次请求。一万个在线玩家每 5 分钟问一次，是每秒 33 次请求，全部由入口和 KV 的缓存处理，不碰任何对象。和为了推送而维持一万条长连接相比，这几乎没有成本。

## 9.4 活动：按时间生效，不按发布生效

最直接的开活动的办法，是在活动开始的那一刻发布一份新配置。这有两个问题：

- **各地生效的时间不一样。** KV 的写入传播到全球需要一分钟左右。东京的玩家看到活动开始了，法兰克福的还没有。
- **要有人在那个时刻操作。** 周六零点的活动，就得有人周六零点守着。

所以活动是配置里的一段带时间的数据：

```ts
export interface GameEvent {
  id: string;
  type: "shop_discount";
  /** 开始和结束的时间（Unix 毫秒）。配置可以提前发布，到点自动生效。 */
  startsAt: number;
  endsAt: number;
  /** 打几折：20 表示减 20%。 */
  percent: number;
}

/** 此刻正在进行的活动。 */
export function activeEvents(config: GameConfig, now: number): GameEvent[] {
  return config.events.filter((event) => event.startsAt <= now && now < event.endsAt);
}
```

配置在周三发布，里面写着周六零点开始。到了周六零点，全球所有的节点同时开始认为活动生效，因为它们比较的是同一个时间，而配置早就传播到了每个地方。结束也一样，到点自动恢复，不需要有人去关。

这和第 5 章"时间不进规则，由调用方传入"是同一个做法。`activeEvents` 和 `shopCost` 都是纯函数，当前时间是参数，所以活动的开始和结束可以直接用测试写出来：

```ts
it("只在时间窗口内生效，开始算、结束不算", () => {
  expect(activeEvents(config, 999)).toEqual([]);
  expect(activeEvents(config, 1000)).toHaveLength(1);
  expect(activeEvents(config, 1999)).toHaveLength(1);
  expect(activeEvents(config, 2000)).toEqual([]);
});
```

活动效果的计算也在服务端。示例的活动是商店打折：

```ts
export function shopCost(config: GameConfig, itemId: string, now: number): { coins: number; gems: number } | null {
  const entry = config.shop[itemId];
  if (!entry) return null;
  const off = Math.max(0, ...activeEvents(config, now).map((event) => event.percent));
  const apply = (price: number | undefined) => (price ? Math.max(1, Math.ceil((price * (100 - off)) / 100)) : 0);
  return { coins: apply(entry.cost.coins), gems: apply(entry.cost.gems) };
}
```

要事先定好的几件小事：多个折扣同时生效时取最大的一个，不叠加；打折后的价格向上取整；最低是 1，不会打成免费。这些规则不写清楚，迟早会有两个活动叠在一起把价格打成 0。

活动结束的那一瞬间，总有玩家卡在边界上：界面上显示的还是折扣价，点下去的时候活动刚好结束。服务端按点下去那一刻的时间算，返回的是原价扣款之后的结果，或者余额不足。更友好的做法是让客户端在购买请求里带上它看到的价格，服务端发现不一致时拒绝并返回新价格，而不是直接按新价格扣。示例没有做这一步。

## 9.5 A/B 测试

### 分组要稳定，实验之间要独立

A/B 测试是把玩家随机分成几组，各给不同的体验，然后比较数据。对后端来说，核心只有一个函数：给定一个玩家和一个实验，他在哪一组。

```ts
export function variantOf(playerId: string, key: string, experiment: Experiment): string | null {
  const total = experiment.variants.reduce((sum, variant) => sum + variant.weight, 0);
  if (total <= 0) return null;
  let point = hash(`${key}:${playerId}`) % total;
  for (const variant of experiment.variants) {
    if (point < variant.weight) return variant.name;
    point -= variant.weight;
  }
  return null;
}
```

它没有存储任何东西。分组是**算出来的**：把实验名和玩家 ID 拼在一起做哈希，落在哪个区间就是哪一组。这带来三个性质：

- **稳定。** 同一个玩家在同一个实验里，每次算出来都一样。不需要记录"谁在哪一组"，也不存在记录丢了的问题。
- **实验之间独立。** 哈希的输入里有实验名，所以玩家在实验甲里的分组和在实验乙里的分组没有关系。如果只用玩家 ID 做哈希，所有实验的"实验组"都是同一批人，几个实验的效果就分不开了。
- **哪里都能算。** 入口、对象、离线的数据分析，用同一个函数得到同一个结果。

哈希用的是 FNV-1a，一个很简单的非加密哈希。这里不需要安全性，只需要分布均匀。测试里验证了这一点：两千个玩家大约各占一半，并且在实验甲里进了实验组的人，在实验乙里仍然是一半一半。

### 逐步放量

实验通常从一个很小的比例开始：先给 5% 的玩家，没问题再扩到 20%、50%。调整权重时要注意分组函数的行为：它是按顺序累加权重的，所以**保持各组的顺序和总权重不变**，只把权重从对照组挪到实验组时，原来在实验组的人仍然在实验组，只有一部分对照组的人被移了过去。

如果总权重变了，或者组的顺序变了，所有人的分组都可能重新洗牌，实验数据就被污染了。约定总权重固定为 100，并且永远把对照组放在第一个，可以避免这个问题。

### 实验要在服务端生效

客户端从 `/config` 拿到自己的分组，可以据此显示不同的界面。但凡是涉及数值的实验（价格、奖励、难度），必须由服务端按分组来执行，客户端的分组只用于显示。否则改一下客户端收到的应答，就能把自己换到更划算的那一组。

另外两件事留给后面的章节：玩家"看到了"某个实验分组这件事要上报一条埋点，否则没法分析（第 10 章）；对不同玩家显示不同的价格在一些地区有法规上的限制（第 11 章）。

## 9.6 管理后台的鉴权

### 不要自己做登录

管理后台能封号、能发钱、能改全服的配置。它的登录系统如果自己做，就要处理密码存储、两步验证、离职员工的账号回收、登录日志，每一样都容易做错。

更好的做法是把登录交给 Cloudflare Access。它架在你的管理接口前面，接入公司已有的身份系统（Google、Okta、GitHub 等），谁能进、要不要两步验证，都在 Access 里配置。员工离职时在身份系统里停用账号，后台的权限同时就没了。

请求通过 Access 之后，会带着一个请求头 `Cf-Access-Jwt-Assertion`，里面是 Access 签发的令牌。

### Worker 里仍然要校验

既然 Access 已经挡在前面了，Worker 里还需要校验吗？**需要。** Access 保护的是某个域名下的某条路径。但一个 Worker 往往不止一个访问入口：`workers.dev` 的地址，别的自定义域名，预览地址。只要有一个入口没被 Access 覆盖，管理接口就是公开的。在 Worker 里校验令牌，保证的是不论请求从哪里进来，没有合法令牌的都进不来。

```ts
export async function verifyAccess(request: Request, env: Env, now = Date.now()): Promise<Admin | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  // 没有配置 Access 时，管理接口一律不可用，而不是一律放行。
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  // ……拆出头部、内容和签名；算法必须是 RS256……

  // 按令牌里的密钥编号找公钥。轮换期间新旧两把都在列表里。
  const key = (await accessKeys(env.ACCESS_TEAM_DOMAIN, now)).get(header.kid);
  if (!key) return null;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) return null;

  // 签名是真的还不够：必须是签给这个应用的，并且在有效期内。
  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (!audiences.includes(env.ACCESS_AUD)) return null;
  if (typeof payload.exp !== "number" || payload.exp <= seconds) return null;
  if (typeof payload.nbf === "number" && payload.nbf > seconds) return null;
  if (typeof payload.email !== "string" || payload.email === "") return null;
  return { email: payload.email };
}
```

校验的内容和第 4 章、第 8 章是同一个套路，多了一项：

- **签名**：公钥从 `https://<团队域名>/cdn-cgi/access/certs` 取，按令牌头部的 `kid` 找对应的那一把。
- **受众（`aud`）**：每个 Access 应用有一个唯一的标识。令牌必须是签给**这个**应用的。同一个团队下可能有很多 Access 应用，一个能登录内部文档站的人，不应该因此就能调用游戏的管理接口。
- **签发方（`iss`）和有效期**。

官方文档特别强调了这一点：签名有效不等于令牌对你的应用有效。

Access 默认每 6 周轮换一次签名密钥，旧密钥在轮换后还有 7 天有效。公钥的缓存放在模块级的变量里，缓存 1 小时，做法和第 8 章缓存广告平台的公钥相同。

**没有配置时拒绝，而不是放行。** `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD` 是两个普通的配置变量（它们不是秘密）。新建一个环境、忘了填这两个值的时候，管理接口应该全部不可用。安全相关的配置，缺失的时候应该拒绝，而不是放行。

玩家的访问令牌和管理后台的令牌是两套东西，互不相通。测试里专门验证了拿着玩家的令牌调用管理接口会被拒绝。

### 每一次操作都留记录

```sql
CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  admin TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL
);
```

谁（令牌里的邮箱），什么时候，对谁，做了什么。每一个会改动数据的管理接口，最后都调用一次 `record`。这张表只增不改，后台本身也不提供修改它的接口。

封禁和解封还要求填写原因：

```ts
// 管理操作必须说明原因。几个月后有人问"为什么封他"，答案只能从这里来。
if (reason === "") return fail(400, "reason_required");
```

操作记录有三个用处：玩家申诉时查得到当时的依据；内部出了问题（有人给自己的小号发了一万宝石）时能追到人；它的存在本身就让人在操作前多想一下。

示例的后台没有区分角色，能进来的人什么都能做。真实的后台至少要分出"只读"（客服查询）、"操作"（封禁、补偿）、"配置"（改全服配置）几档。Access 的令牌里可以带上用户所属的组，据此在每个接口上检查。

## 9.7 封禁，并把人踢出去

第 4 章做了封禁的方法，第 5 章做了踢人的方法，但两者没有连起来：封禁发生在玩家对象上，而玩家对象不知道这个玩家此刻在哪个房间。

### 记下当前所在的房间

5.5 节提过这个办法：在玩家对象里记一个"当前所在的房间"。入口在玩家成功进入房间之后写入：

```ts
const response = await env.ROOM.get(id).fetch(new Request(request, { headers }));
// 进房成功后记下"这个玩家在这个房间"，重新打开游戏和封禁时用得上。
if (response.status === 101) await env.PLAYER.getByName(playerId).setCurrentRoom(match[1]!);
return response;
```

对局结算时清掉，就在结算的那条 `UPDATE` 语句里顺手做了，不需要额外的调用。

这个记录**只是一个提示**。玩家可能已经离开了那个房间，房间可能已经清理了，而记录还在；反过来，入口写入记录的那一步也可能失败。它的两个用途都容得下这种不准确：

- **重新打开游戏时找回对局。** `/me` 接口返回这个值，客户端拿着它去连。连得上就回到了对局里，连不上（404 或者 403）就当作没有进行中的对局。
- **封禁时找到要踢的房间。** 踢不到也不影响封禁本身。

以房间自己的状态为准，这个原则在第 5 章就定下了。

### 封禁的完整流程

```ts
case "/ban": {
  if (reason === "") return fail(400, "reason_required");
  const roomId = await player.ban();
  let kicked = false;
  if (roomId) {
    try {
      await env.ROOM.get(env.ROOM.idFromString(roomId)).kick(playerId);
      kicked = true;
    } catch (error) {
      // 房间可能已经结束。封禁本身已经生效，踢不到不算失败。
      console.error("封禁后踢出失败", roomId, error);
    }
  }
  await record(env, admin, "player.ban", playerId, { reason, roomId, kicked }, now);
  return json({ ok: true, kicked });
}
```

`ban` 在玩家对象里做三件事：打上封禁标记，删掉所有会话，返回当前所在的房间。然后由管理接口去踢。

封禁之后，这个玩家的各条路是这样被堵上的：

| 路径 | 怎么堵上的 |
|---|---|
| 正在进行的对局 | 被踢出，按弃权处理，连接以 4002 关闭 |
| 重新登录、刷新令牌 | 会话已删除，登录和刷新都检查封禁标记（第 4 章） |
| 排队匹配 | 入口在排队前检查封禁标记（第 6 章） |
| 手上还没过期的访问令牌 | 最长还能用 15 分钟，但进不了匹配，也没有会话可以续期 |
| 他邀请别人带来的奖励 | 发奖时检查封禁标记（第 7 章） |

表里第四行的"15 分钟"是第 4 章做的取舍：访问令牌不查库，换来的是每个请求都很快，代价是封禁不是立刻对所有接口生效。需要立刻生效的接口（比如涉及钱的）可以单独加一次封禁检查。

## 9.8 邮件和补偿

邮件是运营给玩家发东西的标准通道：补偿、活动奖励、系统通知。它比直接改余额好，因为玩家看得到是为什么发的，而且是自己点了领取。

### 给一个人发

每个玩家的邮箱在自己的对象里：

```sql
CREATE TABLE mail (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  attachment TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER
);
```

附件是第 8 章的那个"一组变化量"。领取时，标记已领和发放附件在同一个事务里：

```ts
claimMail(mailId: string, now: number): MailResult {
  // ……
  if (row.claimed_at !== null) return "duplicate";
  if (Number(row.expires_at) <= now) return "expired";
  let outcome: MailResult = "ok";
  this.ctx.storage.transactionSync(() => {
    outcome = this.applyDelta(`mail:${mailId}`, "mail", JSON.parse(String(row.attachment)) as Delta, now);
    sql.exec("UPDATE mail SET claimed_at = ? WHERE id = ?", now, mailId);
  });
  return outcome;
}
```

发放走的仍然是统一的资产入口，流水的编号是 `mail:邮件编号`。

邮件的编号由发信的人指定，同一个编号只会放进邮箱一次。客服点了发送，后台卡住了，再点一次，玩家不会收到两封。

几处上限：

- **邮箱最多 100 封。** 超出时先删过期的，再删已经领过的，最后才删最旧的。玩家的对象不应该因为从不清理邮箱而无限增长。
- **附件有上限，而且只能是增加。**

```ts
/** 一封邮件的附件最多能发多少。防的不是坏人，是手滑多打的一个零。 */
const MAX_ATTACHMENT = { coins: 10_000, gems: 1_000, itemQty: 100 };
```

这个上限防的不是恶意的管理员（操作记录管那个），而是失误。超过上限的补偿应该走另一个需要第二个人确认的流程。

### 给所有人发

服务器故障了两个小时，要给所有玩家发补偿。有一百万个玩家。

最直接的想法是遍历所有玩家，往每个人的邮箱里放一封。这做不了，也不该做：

- 没有办法"遍历所有的玩家对象"。对象是按名字访问的，平台不提供在代码里列出一个类的所有对象的接口。
- 即使有名单，一百万次对象调用要把一百万个休眠的对象全部唤醒，其中大部分玩家可能再也不会回来。

正确的做法是反过来：**全服邮件只存一份，玩家打开邮箱时自己来取。**

```sql
CREATE TABLE broadcast_mail (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  attachment TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  -- 只发给这个时间之前注册的玩家。补偿某次故障时，故障之后才来的人不该领。
  registered_before INTEGER NOT NULL
);
```

发一封全服邮件，就是往这张表里写一行。玩家读邮箱时，把自己邮箱里的和这张表里此刻有效的合在一起：

```ts
const [personal, broadcasts, info] = await Promise.all([
  player.listMail(now),
  activeBroadcasts(env, now),
  player.getPublic(),
]);
const eligible = broadcasts.filter((mail) => info.createdAt < mail.registered_before);
const claimed = new Set(await player.hasOps(eligible.map((mail) => `mail:${mail.id}`)));
```

这里有一个巧妙的地方：**全服邮件不需要记录"谁领过了"。** 领取时写的流水编号是 `mail:邮件编号`，一个玩家领没领过，看他的流水里有没有这个编号就知道了。流水表本来就是去重用的，它同时也回答了"领过没有"这个问题。

```ts
// 全服邮件没有"已领"的标记，领没领过看的是这个玩家的流水里有没有这个编号。
result = await player.transact(`mail:${mailId}`, "mail", JSON.parse(mail.attachment) as Delta);
```

一百万玩家的补偿，写入量是一行。之后谁来领，才产生谁的那一次读写。再也不回来的玩家，不产生任何开销。

`registered_before` 解决的是"谁有资格领"。补偿是给受影响的人的，故障之后才注册的玩家不该领到。更细的条件（某个地区、某个等级以上）也是同样的做法：把条件写在邮件上，领取时由服务端判断。

这个做法依赖流水的保留期：邮件的有效期必须比流水的保留期短，否则流水被清理之后，玩家能再领一次。示例里全服邮件最长 30 天，流水保留 180 天。

## 9.9 定时任务

### 定时触发器

有些事没有请求来触发，要按时间来做。Workers 的定时触发器用 cron 表达式配置：

```jsonc
// 定时任务：每 5 分钟一次的例行检查，和每天一次的清理（UTC 时间）。
"triggers": { "crons": ["*/5 * * * *", "0 19 * * *"] },
```

到点时，平台调用入口的 `scheduled` 处理函数：

```ts
/** 定时触发器。waitUntil 让任务在处理函数返回之后继续跑完。 */
scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(runScheduled(controller.cron, controller.scheduledTime, env));
},
```

`controller.cron` 是触发这次调用的表达式，按它分发到不同的任务：

```ts
switch (cron) {
  case "*/5 * * * *":
    result = {
      buckets: await refreshScoreBuckets(env.DB),
      orders: await sweepPendingOrders(env, scheduledTime),
    };
    break;
  case "0 19 * * *":
    result = await cleanup(env.DB, scheduledTime);
    break;
}
// 每次执行留一条日志：做了什么、花了多久。定时任务没有人盯着，靠这个发现它悄悄坏了。
console.log(JSON.stringify({ job: cron, ms: Date.now() - started, result }));
```

要知道的几件事：

- **时间是 UTC。** `0 19 * * *` 是北京时间凌晨 3 点。清理类的任务放在玩家最少的时段。
- **改动要过一会儿才生效。** 新增、修改、删除一个定时触发器，最长需要 15 分钟传播到全网，期间到点的那一次可能被错过。不要在活动开始前 5 分钟才去加一个定时任务。
- **有时间限制。** 一次调用最长 15 分钟。间隔小于 1 小时的任务，CPU 时间默认 30 秒，最多可调到 5 分钟；间隔 1 小时及以上的最多 15 分钟。
- **数量有限。** 付费版每个账号 1,000 个，免费版 5 个。所以是少数几个表达式，每个表达式下面挂几件事，而不是每件事一个表达式。

### 写定时任务的三条规矩

**能重复执行。** 定时任务可能因为部署、平台重试等原因多跑一次，也可能漏跑一次。任务的效果不能依赖"恰好执行一次"。示例里的三个任务都满足：重算分布表是整张表换成新的；核实订单走的是可以重复的发货函数；清理过期数据，再清一次也只是没有东西可清。

**每次只做有限的事。**

```ts
/** 删除过期的数据。每张表一次最多删一批，表很大时分很多次删完，不会有一次特别慢的执行。 */
const bounded = (table: string, column: string) =>
  db
    .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`)
    .bind(before, CLEANUP_BATCH);
```

一条不带上限的 `DELETE` 在表小的时候没有问题。等数据积累了半年，某一天它要删一千万行，超时了，什么都没删掉，第二天要删的更多，永远也删不完。带上限之后，每次删一千行，删不完的留给下一次。积压多的时候可以临时提高执行频率。

**留下痕迹。** 定时任务失败了没有人会收到错误提示，它只是不再发生。每次执行都打一条日志，写明做了什么、处理了多少、花了多久。第 10 章会在这上面加告警：一个每 5 分钟该出现一次的日志，过了一段时间还没有出现，就是出了问题。

### 这一章的三个任务

**重算分数分布。** 第 7 章留下的：排在精确名次之外的玩家，要告诉他"超过了百分之多少的人"。

```ts
export async function refreshScoreBuckets(db: D1Database, board = RATING_BOARD): Promise<number> {
  const rows = await db
    // 绑定进来的数是浮点数，除法的结果也是，所以要显式取整。
    .prepare(
      "SELECT CAST(score / ? AS INTEGER) AS bucket, COUNT(*) AS players FROM leaderboard WHERE board = ? GROUP BY bucket",
    )
    .bind(BUCKET_SIZE, board)
    .all<{ bucket: number; players: number }>();
  const insert = db.prepare("INSERT INTO score_bucket (board, bucket, players) VALUES (?, ?, ?)");
  await db.batch([
    db.prepare("DELETE FROM score_bucket WHERE board = ?").bind(board),
    ...rows.results.map((row) => insert.bind(board, row.bucket, row.players)),
  ]);
  return rows.results.length;
}
```

删除旧的和插入新的在同一个 `batch` 里，是一个事务，读的人不会看到一张空表。代码里的那条注释记的是写这一段时踩到的一个坑：通过参数绑定传进去的数字在 D1 里是浮点数，`score / 50` 得到的是小数，结果每个不同的分数各占一段。测试发现了它：一百个玩家应该落进 20 段，实际出来了 100 段。

排行榜接口在名次超出上限时读这张表：

```ts
// 排在精确名次之外的玩家，告诉他超过了百分之多少的人。这个数来自定时重算的分布表。
const percent = standing && standing.rank === null ? await percentileOf(env.DB, standing.score) : null;
```

**核实未付款的订单。** 第 8 章说的掉单补救的第三层。它需要跨玩家找出"哪些订单还没付"，所以这一章让未付款的订单也通过发件箱进了 D1 的支付记录表：

```ts
const rows = await env.DB.prepare(
  `SELECT order_id, external_id FROM payment
   WHERE status = 'pending' AND provider = 'stripe' AND external_id IS NOT NULL
     AND created_at BETWEEN ? AND ?
   ORDER BY created_at LIMIT ?`,
)
  .bind(now - SWEEP_UNTIL_MS, now - SWEEP_AFTER_MS, SWEEP_BATCH)
  .all<{ order_id: string; external_id: string }>();
```

时间窗口的两头都有讲究。下单不到 10 分钟的不查，玩家可能还在付款页面上，回调也可能还在路上。超过 24 小时的也不查：绝大多数没付款的订单是玩家点开看了一眼就关了，永远不会付，不能让它们一直占着每一轮的扫描。

每个订单的核实放在各自的 `try` 里，一个订单查不了不影响其他的。

**清理过期数据。** 第 6 章留下的对局记录和录像，保留 30 天；过期的全服邮件一并清掉。

### 定时任务做不了的事

定时任务跑在一个普通的 Worker 调用里，它能直接操作的是 D1、KV、队列这些全局的资源。它**没有办法遍历所有的对象**。

第 8 章留下的"清理流水"就是这种情况：流水在每个玩家自己的对象里，一百万个玩家就是一百万个对象。做法和全服邮件一样，反过来：让每个对象在被用到的时候顺手清理自己。

```ts
// 没有办法从外面定时遍历所有玩家对象，所以每个对象在被用到时顺手清理自己：每天最多一次。
const pruned = Number(sql.exec("SELECT pruned_at FROM profile WHERE id = 1").one().pruned_at);
if (now - pruned > DAY_MS) {
  this.pruneLedger(now - LEDGER_RETENTION_MS);
  sql.exec("UPDATE profile SET pruned_at = ? WHERE id = 1", now);
}
```

这段代码在登录时执行。活跃的玩家每天清一次；不活跃的玩家不登录，流水也不会增长，不需要清。

这是这套架构里反复出现的一个模式：**需要对"所有玩家"做的事，改成每个玩家在自己下次出现时做。** 全服邮件、流水清理、表结构迁移（3.5 节）都是它。它不适用的情况是那些必须在某个时刻对不在线的玩家生效的事，那时就需要一份名单（D1 里的某张表）加上队列来逐个处理。

还有一类是单次执行时间很长的任务：赛季结束时给十万个上榜的玩家发奖。一次调用里做不完，做到一半失败了也不知道做到了哪里。这类任务的做法是定时任务只负责"把要做的事拆成小块放进队列"，由队列的消费者逐块完成，每一块自己带编号、可以重试。平台另有一个专门做这种多步骤长任务的产品 Workflows，本书的示例没有用到。

## 9.10 赛季结算

第 7 章留下了赛季结束的发奖。示例没有实现赛季，这里把步骤写清楚，因为它把这一章的几样东西都用上了。

1. **赛季的边界是时间，不是操作。** 榜名里带着赛季（7.5 节），哪一局算哪个赛季由对局结束的时间决定。不需要有人在零点"切换赛季"。
2. **等一小段时间。** 赛季结束的那一刻，队列里可能还有最后几局的分数没有落进 D1。定时任务在赛季结束后几分钟再开始结算。
3. **把最终名次另存一份。** 从排行榜读出要发奖的名次，写进一张单独的表（赛季、玩家、名次、奖励）。从这一刻起，发奖只依据这张表，不再看排行榜。排行榜之后再有迟到的更新，也不影响已经定下的结果。
4. **用邮件发奖。** 对结果表里的每一行，给对应的玩家发一封邮件，邮件编号是 `season:赛季:名次奖`。人数多时分批放进队列。
5. **每一步都能重来。** 结果表按主键去重，邮件按编号去重，附件的领取按流水去重。结算任务在任何一步中断，重新跑一遍都不会多发。

第 3 步是关键。"先定下结果，再按结果执行"把一个要读变化中的数据的长任务，变成了一个读固定数据的长任务。

## 9.11 好友房的短码

第 6 章的房间号是 64 位的十六进制字符串，没法口头告诉朋友。现在建好友房时多返回一个 6 位的短码：

```ts
// 再给一个方便口头分享的短码。它只在房间等人的这段时间里有用，到期自动消失。
const code = newRoomCode();
await env.CONFIG.put(`room-code:${code}`, id.toString(), { expirationTtl: ROOM_CODE_TTL_SECONDS });
return json({ roomId: id.toString(), code });
```

短码到房间号的对照放在 KV 里，带过期时间。这是 KV 很合适的另一种用法：数据是临时的，到期自动消失，不需要任何清理代码。有效期是 15 分钟，比好友房 10 分钟的开局期限稍长。KV 的键最短的过期时间是 60 秒。

短码的字符表去掉了容易看错的字符（0 和 O，1、I 和 L），剩 31 个，6 位一共约 8.9 亿种组合。

这里有两处受 KV 最终一致性的影响，要心里有数：

- **朋友可能要等一下才查得到。** 建房的人和他的朋友如果不在同一个数据中心，短码刚生成的几秒到几十秒里，朋友那边可能查不到。客户端查不到时提示"稍等几秒再试"。
- **重复的短码没有检查。** 两个房间恰好生成了同一个短码时，后写的会盖掉先写的。同时有效的短码有一万个时，新生成的一个撞上的概率大约是十万分之一。要完全避免，就得用一个能保证唯一的地方来分配短码，比如一个对象。

用短码换房间号的接口上线前要限流。短码的空间不大，不限流的话可以一个个试出来。试出来的后果是能进别人的好友房，而好友房本来的准入规则就是"知道房间号的人都能进"，所以危害有限，但仍然应该挡住。

## 9.12 离线通知

玩家不在线的时候想通知他（体力满了，好友邀请你对战，活动要结束了），前面这些机制都够不着，因为没有连接，也没有请求。这要靠各个平台自己的消息通道：

| 平台 | 通道 | 后端要做什么 |
|---|---|---|
| Telegram 小程序 | 机器人给用户发消息 | 调用 Bot API 的 `sendMessage`，用户必须先和机器人对话过 |
| 原生应用 | FCM（安卓）、APNs（苹果） | 保存设备的推送令牌，调用对应的接口 |
| 网页 | Web Push | 保存浏览器的订阅信息，按标准协议推送 |

示例项目没有实现离线通知。做的时候注意这几点：

- **走队列，不要在请求里直接发。** 调用外部的推送接口可能很慢、可能失败。把"要给谁发什么"放进队列，由消费者去发，失败了重试。
- **各平台都有频率限制。** 给大量用户群发时要控制速度，队列的消费者正好是做这件事的地方。
- **推送令牌存在玩家对象里。** 它是这个玩家的数据。令牌会失效（卸载了应用、换了设备），推送接口报告令牌无效时要删掉它。
- **要让玩家能关掉。** 通知的开关也在玩家对象里，发之前检查。发得太多的结果是玩家屏蔽你，或者卸载。

## 9.13 测试

管理接口的测试要有一个合法的 Access 令牌。办法和第 8 章测广告回调一样：测试里自己扮演 Access，生成一对 RSA 密钥，让替身在代码取公钥时返回公钥，再用私钥签发令牌。这样可以分别测出每一项检查：

```ts
it("签名是真的还不够：受众、签发方、有效期都要对", async () => {
  expect((await admin("GET", "/admin/config")).status).toBe(200);
  const past = Math.floor(Date.now() / 1000) - 10;
  expect((await admin("GET", "/admin/config", undefined, await accessToken({ aud: ["other-app"] }))).status).toBe(403);
  expect((await admin("GET", "/admin/config", undefined, await accessToken({ iss: "https://evil.example" }))).status).toBe(403);
  expect((await admin("GET", "/admin/config", undefined, await accessToken({ exp: past }))).status).toBe(403);
});
```

活动的开始和结束用拨快时钟来测：发布一份折扣正在进行的配置，买一次，价格是折后的；把时间拨到活动结束之后，再买一次，价格恢复了。

定时任务有两种测法。任务函数本身直接调用，传入想要的"当前时间"：

```ts
// 刚下的单还不到核实的时间。
expect((await sweepPendingOrders(env, Date.now())).checked).toBe(0);
// ……让支付平台的替身返回"已付款"……
const result = await sweepPendingOrders(env, Date.now() + 15 * 60 * 1000);
```

分发的逻辑用测试库提供的工具构造一次定时触发：

```ts
const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: Date.now() });
const ctx = createExecutionContext();
worker.scheduled(controller, env, ctx);
await waitOnExecutionContext(ctx);
```

`waitOnExecutionContext` 等的是处理函数里交给 `waitUntil` 的那些工作。

## 9.14 示例项目的变化

这一章结束时，示例项目多了这些东西：

- `shared/src/liveops.ts`：配置的类型、默认配置、活动是否生效、商品此刻的价格、实验分组、配置校验。
- `server/src/ops/config.ts`：配置的读取、发布、历史版本。
- `server/src/ops/access.ts`：校验 Cloudflare Access 的令牌。
- `server/src/ops/admin.ts`：管理接口。配置的读取、发布、回滚；全服邮件；按天对账；查看玩家；封禁、解封、发邮件、核实订单。
- `server/src/ops/routes.ts`：玩家这一侧的 `GET /config`、`GET /mail`、`POST /mail/claim`。
- `server/src/ops/jobs.ts`：三个定时任务和分数百分位的估算。
- `server/src/player.ts`：邮件、当前所在的房间、流水查询、登录时清理旧流水；封禁返回当前房间，新增解封；未付款的订单也发出通知。
- 商店的商品表从代码搬进了配置；建好友房多返回一个短码，新增 `GET /rooms/code/:code`；`/me` 多返回当前所在的房间；排行榜接口多返回百分位。
- `server/migrations/0004_liveops.sql`：操作记录、全服邮件、分数分布三张表，支付记录表多一列。
- `server/wrangler.jsonc`：新增 KV、定时触发器和两个 Access 相关的变量，两个环境各一套。
- 测试：规则新增 7 个，一共 36 个；服务端新增 `test/liveops.test.ts`，22 个测试。服务端一共 120 个测试。

本地运行前要再执行一次 `npm run db:local -w server`。

要启用管理后台，需要在 Cloudflare 的控制台里建一个 Access 应用保护 `/admin/` 路径，然后把团队域名和应用的受众标识填进配置文件的 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD`。不填的话，所有管理接口返回 403。

## 本章小结

- 运营操作绕过了发版的评审、历史和回滚，所以要自己补上：发布前校验，每个版本留档，每次操作留记录。
- 配置放 KV：一整份文档带版本号，读取时带缓存时间，代码里留一份默认值。配置由入口读，算好结果再交给对象。
- 配置校验分格式和常识两层，后者更重要。版本号必须正好加一；回滚是把旧内容作为新版本再发一次。
- 配置更新用拉取：带版本号的条件请求，没变就返回 304。应答里带上服务端时间，客户端的时钟只用于显示。
- 活动按时间生效，不按发布生效。配置提前发布，到点全球同时开始，到点自动结束。
- 实验分组是算出来的，不是存下来的。哈希里带上实验名，实验之间才互相独立。涉及数值的实验必须在服务端生效。
- 管理后台的登录交给 Access，Worker 里仍然要校验令牌：签名、受众、签发方、有效期。没有配置时拒绝，而不是放行。
- 每一次管理操作都留记录，涉及玩家的操作要写原因。
- 玩家对象里记一个"当前所在的房间"作为提示，用于找回对局和封禁时踢人。以房间自己的状态为准。
- 邮件的附件走统一的资产入口。全服邮件只存一份，玩家打开邮箱时自己来取，领没领过看流水。
- 定时任务要能重复执行，每次只做有限的事，每次留一条日志。
- 需要对所有玩家做的事，改成每个玩家在自己下次出现时做。定时任务遍历不了对象。
- 长任务先把结果定下来另存，再按固定的结果分批执行，每一步都能重来。
- 临时的对照关系放 KV 并设过期时间，同时要清楚最终一致性会带来什么。

下一章做埋点和可观测：线上发生了什么，怎么知道；出了问题，怎么在玩家来投诉之前发现。
