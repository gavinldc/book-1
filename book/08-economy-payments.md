# 第 8 章　经济系统与支付

> 状态：初稿　｜　文档核实与实际运行日期：2026-11-24

前面几章里，玩家的金币只有两个来源：赢一局，或者邀请到人。这一章把经济系统做完整：货币和背包，游戏内的商店，用真钱充值，看广告领奖励，以及出了问题之后怎么查、怎么补、怎么追回。

和钱有关的代码有一个特点：出错的代价不对称。少发了，玩家会来找你；多发了，没有人会告诉你，直到经济崩掉。所以这一章的重点不是功能，而是怎么让每一笔变动都**只发生一次、查得到、对得上**。

这一章的代码在 [examples/server/src/player.ts](../examples/server/src/player.ts) 和 [examples/server/src/economy/](../examples/server/src/economy/)。

## 8.1 三条规矩

先把规矩定下来，后面所有的代码都是在执行它们。

1. **所有资产的变动走同一个入口。** 金币、宝石、道具，不论因为什么原因增减，最后都调用同一个函数。不允许在别处直接写 `UPDATE ... SET coins = ...`。
2. **每一次变动都有编号，都写流水。** 编号相同的变动只生效一次。流水和余额在同一个事务里修改。
3. **余额等于流水的合计。** 任何时候把一个玩家的流水加起来，都应该等于他现在的余额。对不上就说明有代码违反了第一条。

第二条在第 3 章做结算时已经用过，第 7 章的邀请奖励又用了一次。这一章把它从"某几个功能的做法"变成"唯一的做法"。

示例里有两种货币和一个背包：

| | 来源 | 用途 |
|---|---|---|
| 金币（`coins`） | 对局、邀请、看广告 | 买普通道具 |
| 宝石（`gems`） | 充值 | 买付费道具 |
| 道具（`item` 表） | 用金币或宝石买 | 在对局里使用 |

把免费获得的货币和付费获得的货币分开，是出于几个实际的考虑：退款时知道该收回什么；对账时充值的钱只对应一种货币；有些地区对付费货币有单独的法规要求（比如余额的保护、未成年人退款）。

## 8.2 统一的入口

### 一次变更是一组变化量

```ts
/** 一次资产变更：每一项是变化量，正数是增加，负数是减少。 */
export interface Delta {
  coins?: number;
  gems?: number;
  items?: Record<string, number>;
}
```

"花 30 金币买一个护盾"是一次变更：`{ coins: -30, items: { shield: 1 } }`。它不是"先扣钱，再给东西"两步，而是一步。这一点很重要：分成两步，就存在第一步成功、第二步没做的可能。

### 先检查，再修改

```ts
private applyDelta(opId: string, kind: string, delta: Delta, now: number, allowDebt = false): TxResult {
  const sql = this.ctx.storage.sql;
  if (sql.exec("SELECT 1 FROM ledger WHERE op_id = ?", opId).toArray().length > 0) return "duplicate";

  const coins = delta.coins ?? 0;
  const gems = delta.gems ?? 0;
  const items = Object.entries(delta.items ?? {}).filter(([, qty]) => qty !== 0);
  // ……读出涉及的道具现有的数量……

  // 先检查，再修改。任何一项不够，整个操作都不做。
  if (!allowDebt) {
    const balance = sql.exec("SELECT coins, gems FROM profile WHERE id = 1").one();
    if (Number(balance.coins) + coins < 0 || Number(balance.gems) + gems < 0) return "insufficient";
    if (items.some(([itemId, qty]) => held.get(itemId)! + qty < 0)) return "insufficient";
  }

  sql.exec("UPDATE profile SET coins = coins + ?, gems = gems + ? WHERE id = 1", coins, gems);
  // ……更新道具的数量……
  sql.exec(
    "INSERT INTO ledger (op_id, kind, coins, gems, items, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    opId, kind, coins, gems, items.length > 0 ? JSON.stringify(Object.fromEntries(items)) : null, now,
  );
  return "ok";
}
```

这个函数只能在事务里调用，结果有三种：

- `ok`：变更生效，流水已写。
- `duplicate`：这个编号已经处理过，什么都没做。**调用方应该把它当作成功。**
- `insufficient`：有某一项不够扣，什么都没做。

对外的入口只是包了一层事务：

```ts
transact(opId: string, kind: string, delta: Delta): TxResult {
  let outcome: TxResult = "ok";
  this.ctx.storage.transactionSync(() => {
    outcome = this.applyDelta(opId, kind, delta, Date.now());
  });
  return outcome;
}
```

### 为什么这里不需要锁

在传统的后端里，"检查余额，然后扣款"是最经典的并发问题：两个请求同时检查，都看到余额够，都扣了，余额变成负数。解决它要用数据库的行锁，或者用带条件的更新语句，或者上分布式锁。

这里不需要。一个玩家只有一个对象，对象一次只处理一件事，而且检查和修改之间没有任何等待（它们在一个同步的事务里）。同一个玩家的两次购买不可能交错。这是第 1 章说的"一个玩家一个对象"带来的最实在的好处之一：**钱的并发问题在结构上就不存在。**

前提是遵守 3.6 节的约定：读、改、写之间不要等待外部调用。只要 `applyDelta` 所在的事务是同步的，这个保证就成立。

## 8.3 游戏内的商店

用金币或宝石买道具的接口：

```ts
if (pathname === "/shop/buy") {
  const entry = typeof body.itemId === "string" ? SHOP[body.itemId] : undefined;
  if (!entry || typeof body.opId !== "string" || !CLIENT_OP_ID.test(body.opId)) return fail(400, "bad_request");
  // 扣钱和给东西是同一次变更，不会出现扣了钱没拿到东西。
  const cost = { coins: -(entry.cost.coins ?? 0), gems: -(entry.cost.gems ?? 0) };
  const result = await player.transact(`buy:${body.opId}`, "buy", combine(cost, entry.grant));
  if (result === "insufficient") return fail(409, "insufficient");
  return json({ ok: true, duplicate: result === "duplicate", wallet: await player.getWallet() });
}
```

两件事要注意。

**价格在服务端。** 客户端只传商品的编号，价格和内容都从服务端的商品表里取：

```ts
export const SHOP: Record<string, { cost: { coins?: number; gems?: number }; grant: Delta }> = {
  shield: { cost: { coins: 30 }, grant: { items: { shield: 1 } } },
  dice_skin: { cost: { gems: 80 }, grant: { items: { dice_skin: 1 } } },
};
```

如果接口接受客户端传来的价格，那么价格是多少就由玩家说了算。这和第 5 章"骰子点数由服务端生成"是同一条原则。

**编号由客户端生成。** 之前的操作编号都是服务端定的（对局的编号、被邀请人的 ID），因为那些操作本来就是服务端发起的。购买是玩家发起的，而玩家的网络不可靠：点了购买，请求发出去了，应答没收到。客户端不知道这次买成了没有，只能重试。

所以购买的编号由客户端在**点击的那一刻**生成（一个随机的字符串），重试时用同一个。服务端看到同一个编号，知道这是同一次购买，返回成功但不再扣钱：

```ts
it("同一个购买编号重复提交，只扣一次钱", async () => {
  // ……
  for (let i = 0; i < 3; i++) {
    const response = await post("/shop/buy", { itemId: "shield", opId: "retry-0001" }, token);
    expect(await response.json()).toMatchObject({ ok: true, duplicate: i > 0 });
  }
  expect(await wallet(session)).toEqual({ coins: 70, gems: 0, items: { shield: 1 } });
});
```

客户端生成的编号只在这个玩家自己的对象里起作用（流水表在玩家对象里），所以不需要全局唯一，也不怕玩家故意用别人的编号。服务端给它加上 `buy:` 前缀，避免和别的种类的编号撞上。

### 在别的对象里花钱

商店是最简单的情况，钱和道具都在同一个对象里。麻烦的是花钱的地方在另一个对象里：进房间要交门票，对局中使用一个道具。

这类情况的做法是**先扣后用**，由需要这笔钱的一方带着编号来扣：

- 开房时，由开房的一方（匹配对象或入口）向每个玩家对象扣门票，编号是 `entry:房间号`。扣成功了才把这个玩家放进名单。
- 房间作废时（6.2 节的开局期限到了），向同一批玩家退还，编号是 `entry-refund:房间号`。
- 对局中使用道具，由房间向玩家对象扣，编号是 `use:对局编号:第几次`。

每一步都带编号，所以每一步都可以重试；先扣后用，所以最坏的情况是扣了钱但没用上，这时有明确的退还步骤。不要反过来做成"先用，对局结束时一起扣"，那样玩家可以在结算前把钱花到别处。

示例项目没有实现门票，这里列出的是做法。

## 8.4 真钱充值：订单

### 流程

用真钱买宝石，多了一个不受你控制的参与者：支付平台。整个流程是：

1. 玩家在游戏里点购买，客户端请求服务端下单。
2. 服务端**先在自己这边记下订单**，再向支付平台申请一个付款页面，把地址返回给客户端。
3. 玩家在支付平台的页面上付款。这一步完全在你的系统之外。
4. 支付平台通过回调通知服务端：付款成功了。
5. 服务端核对之后发货。

第 3 步和第 4 步之间可能隔几秒，也可能隔几天（银行转账）。回调可能来一次，也可能来五次，也可能不来。所以订单要有自己的状态，记在玩家对象里：

```sql
CREATE TABLE purchase (
  order_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
```

状态只有三种，只能朝一个方向走：`pending`（已下单）→ `paid`（已付款并发货）→ `refunded`（已退款）。

金额存的是支付平台的最小单位，用整数：Stars 是个数，美元是分。**钱不要用小数存**，0.1 加 0.2 不等于 0.3 这种问题不应该出现在账上。

### 下单

```ts
// 先在自己这边记下订单，再去找支付平台。反过来的话，付款成功的回调可能找不到订单。
const orderId = newOrderId();
const order = await player.createOrder(orderId, body.productId, provider satisfies Provider, Date.now());
if (order === "unknown") return fail(400, "bad_request");
if (order === "too_many") return fail(429, "too_many_orders");

const ref = formatRef({ playerId: claims.sub, orderId });
if (provider === "telegram") {
  return json({ orderId, url: await createInvoiceLink(env, order, ref) });
}
```

订单里的金额和币种是下单时从商品表里取出来记下的。之后付款的回调里带来的金额，必须和这里记下的一致。

`ref` 是"哪个玩家的哪个订单"，格式是 `玩家 ID:订单号`。它被交给支付平台，回调时原样带回来。回调是支付平台发起的请求，没有玩家的登录信息，服务端全靠这个引用找到该去哪个玩家对象发货。解析时严格按格式校验，格式不对的直接丢弃：

```ts
const REF = /^(p_[0-9a-f]{24}):(o_[0-9a-f]{24})$/;
```

下单接口还限制了一个玩家同时能有多少个没付款的订单（示例是一小时 20 个）。每下一单都要调用一次支付平台的接口，不限制的话可以被用来消耗你在支付平台那边的调用额度。

### 发货

所有支付渠道最后都调用同一个方法：

```ts
async fulfillOrder(orderId: string, proof: PaymentProof, now: number): Promise<FulfillResult> {
  const order = this.getOrder(orderId);
  if (!order) return "not_found";
  if (order.status !== "pending") return "duplicate";
  // 付的钱必须和下单时记下的一致。不一致说明有人改了金额，或者配置出了错，都不能发货。
  if (order.provider !== proof.provider || order.amount !== proof.amount || order.currency !== proof.currency) {
    return "mismatch";
  }
  this.ctx.storage.transactionSync(() => {
    this.applyDelta(`order:${orderId}`, "purchase", PRODUCTS[order.productId]!.grant, now);
    this.ctx.storage.sql.exec(
      "UPDATE purchase SET status = 'paid', external_id = ?, paid_at = ? WHERE order_id = ?",
      proof.externalId, now, orderId,
    );
    this.emitPayment(orderId, now);
  });
  await this.flush();
  return "ok";
}
```

事务里做了三件事：发货（走统一入口，写流水），把订单改成已付款，往发件箱写一条通知（7.1 节，用来更新 D1 里的支付记录）。三件事一起成功或一起失败。

这个方法有两道防重复的保险：订单的状态不是 `pending` 就直接返回；即使状态检查因为某种缺陷失效了，流水的编号 `order:订单号` 还会再挡一次。

`external_id` 记的是支付平台那边的流水号。退款时要用它，对账时要用它，客服查问题时也要用它，一定要存。

### 收了钱但发不了货

`fulfillOrder` 返回 `not_found` 或 `mismatch` 时，情况是：支付平台说钱已经收了，但我们这边找不到订单，或者金额对不上。

这时不能发货，也不能让支付平台重试（重试多少次结果都一样）。回调照常答复成功，同时记一条错误日志：

```ts
if (result === "not_found" || result === "mismatch") {
  // 钱已经收了，货却发不出去。重试没有用，需要人来处理：记下来，第 10 章给它加告警。
  console.error("收到付款但无法发货", { provider: "telegram", orderId: ref.orderId, result });
}
```

这种情况正常运行时不应该出现。出现了通常意味着商品表的价格在玩家下单后、付款前被改了，或者有人在尝试篡改。它必须有人看到并处理，处理方式往往是退款。

## 8.5 Telegram Stars

Telegram 小程序里卖数字商品，按平台的规定必须用 Stars 结算，币种代码是 `XTR`。玩家用苹果或谷歌的应用内购买向 Telegram 买 Stars，再用 Stars 向你付款。

### 申请付款链接

```ts
export async function createInvoiceLink(env: Env, order: Order, ref: string): Promise<string> {
  const product = PRODUCTS[order.productId]!;
  // 机器人令牌在地址里，这个地址不能出现在任何日志和错误信息中。
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/createInvoiceLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: product.title,
      description: product.description,
      // 回调里会原样带回来，用它找到是哪个玩家的哪个订单。
      payload: ref,
      // 数字商品用 Stars 结算，不需要支付服务商的令牌。
      provider_token: "",
      currency: order.currency,
      prices: [{ label: product.title, amount: order.amount }],
    }),
  });
  const body = (await response.json()) as { ok: boolean; result?: string };
  if (!body.ok || !body.result) throw new Error(`createInvoiceLink 失败：${response.status}`);
  return body.result;
}
```

`payload` 的长度限制是 1 到 128 字节，示例的引用是 53 字节。客户端拿到链接后，用小程序的 `openInvoice` 方法打开付款界面。

### 回调先验来源

Telegram 把付款相关的通知发到你设置的回调地址。这个地址是公开的，任何人都可以往上面发请求。如果不验证来源，伪造一条"付款成功"的通知就能拿到宝石。

设置回调地址时可以指定一个密钥，Telegram 之后的每次请求都会把它放在请求头里：

```ts
// 设置回调地址时指定的密钥，Telegram 每次请求都会带上。没有它，任何人都能伪造"付款成功"。
const secret = request.headers.get(SECRET_HEADER);
if (!secret || !(await safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))) {
  return new Response("forbidden", { status: 403 });
}
```

比较用的是耗时固定的方式（4.5 节），不用 `===`。密钥只能包含字母、数字、下划线和连字符，长度 1 到 256。它和机器人令牌是两个不同的密钥，各自放进密钥配置里（4.7 节）。

### 一次付款，两个通知

玩家点了付款之后，Telegram 会先后发来两个通知。

**第一个是付款前的确认**（`pre_checkout_query`）。Telegram 问：这笔订单现在还能付吗？你必须在 **10 秒内**答复，否则付款失败。

```ts
const query = update.pre_checkout_query;
if (query) {
  const ref = parseRef(query.invoice_payload);
  const order = ref ? await env.PLAYER.getByName(ref.playerId).getOrder(ref.orderId) : null;
  const ok =
    order !== null &&
    order.status === "pending" &&
    order.provider === "telegram" &&
    order.currency === query.currency &&
    order.amount === query.total_amount;
  // 直接在回调的应答里调用 Bot API 的方法，省掉一次对外请求，也更容易赶上 10 秒的时限。
  return json({
    method: "answerPreCheckoutQuery",
    pre_checkout_query_id: query.id,
    ok,
    ...(ok ? {} : { error_message: "订单已失效，请重新下单" }),
  });
}
```

这一步是拒绝付款的最后机会。订单已经付过了，商品下架了，金额对不上，都应该在这里拒绝，玩家的钱不会被扣。等钱扣了再发现问题，就只能走退款了。

答复的方式用了 Bot API 的一个特性：处理回调时，可以直接在 HTTP 应答的正文里写要调用的方法和参数，不用另外发起一次请求。这对 Workers 很合适，少一次对外调用，也少一个可能超时的地方。代价是你不知道这次调用是否成功，对于付款前的确认，这没有关系：没成功的话付款不会进行，玩家重新点一次就行。

**第二个是付款成功的消息**（`successful_payment`）。**只有收到它才能发货。** 官方文档特别警告过：答复了付款前的确认不代表付款成功，必须等到这个消息。

```ts
const paid = update.message?.successful_payment;
if (paid) {
  const ref = parseRef(paid.invoice_payload);
  if (ref) await settle(env, ref, paid, now);
  return json({ ok: true });
}
```

`settle` 调用上一节的 `fulfillOrder`，流水号用消息里的 `telegram_payment_charge_id`。

### 发货失败时让 Telegram 重发

`settle` 里没有捕获异常。如果调用玩家对象时出错（对象暂时不可用），异常会一路抛到入口，回调返回 500。Telegram 收到非成功的应答会重发这个通知，重发时发货再试一次，而 `fulfillOrder` 是可以重复调用的。

这就是回调处理的基本形状：**处理成功才答复成功；处理不了就让对方重发；处理本身可以重复。** 三条缺一不可。

反过来，不认识的通知类型、格式不对的引用，要答复成功。它们重发多少次都处理不了，不答复成功只会让 Telegram 一直重发。

### 上线前要做的配置

回调地址要自己调用一次 Bot API 来设置。下面的命令里有机器人令牌，在自己的终端里执行，不要写进脚本提交到仓库：

```bash
curl "https://api.telegram.org/bot<机器人令牌>/setWebhook" \
  -d "url=https://<你的域名>/webhooks/telegram" \
  -d "secret_token=<回调密钥>" \
  -d 'allowed_updates=["message","pre_checkout_query"]'
```

`allowed_updates` 限定了只接收这两类通知，别的类型不会发过来。

另外，Telegram 要求卖数字商品的机器人必须能响应 `/paysupport` 命令，处理玩家关于付款的问题，并且由你自己负责处理争议。

## 8.6 Stripe

游戏有网页版时，可以用 Stripe 收信用卡和各地的本地支付方式。流程和 Telegram 是同一个形状，细节不同。

### 创建结账页面

```ts
const form = new URLSearchParams({
  mode: "payment",
  success_url: returnUrl,
  cancel_url: returnUrl,
  // 结账会话上带着订单的引用，付款成功的回调里会原样带回来。
  client_reference_id: ref,
  // 同一个引用也放在付款意向上，它会被复制到扣款记录，退款的回调里靠它找到订单。
  "payment_intent_data[metadata][ref]": ref,
  "line_items[0][quantity]": "1",
  "line_items[0][price_data][currency]": order.currency,
  "line_items[0][price_data][unit_amount]": String(order.amount),
  "line_items[0][price_data][product_data][name]": product.title,
});
const response = await fetch(`${API}/checkout/sessions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
    // 用订单号做幂等键：这个请求超时后重试，不会创建出第二个结账页面。
    "Idempotency-Key": order.orderId,
  },
  body: form,
});
```

这里直接用 `fetch` 调用 Stripe 的接口，没有引入它的 SDK。只用到两三个接口时，这样更轻。

**幂等键是 Stripe 这一侧的"操作编号"。** 你调用它的接口时，网络同样可能出问题：请求发出去了，没收到应答。带上幂等键之后重试，Stripe 会返回第一次的结果，而不是再创建一个。这和你自己的接口接受客户端的购买编号是一回事，只是这次你是客户端。

引用放了两处，是因为后面两种回调带回来的对象不同。付款成功的回调带的是结账会话，能读到 `client_reference_id`；退款的回调带的是扣款记录，读不到结账会话上的字段。Stripe 的规则是：对象上的附加数据不会自动复制到关联的对象上，但有几个例外，其中一个是付款意向上的附加数据会在创建扣款记录时复制过去。所以通过 `payment_intent_data[metadata]` 把引用放到付款意向上，退款时就能从扣款记录里读到它。

### 校验签名

Stripe 的回调用签名来证明来源。请求头 `Stripe-Signature` 的样子是 `t=时间戳,v1=签名`，签名是用回调密钥对 `时间戳.请求体原文` 做的 HMAC-SHA256。

```ts
export async function verifyStripeSignature(
  secret: string,
  header: string | null,
  rawBody: string,
  nowSeconds: number,
): Promise<boolean> {
  if (!header) return false;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value) timestamp = value;
    // 密钥轮换期间会同时带着新旧两个签名，任何一个对得上都算通过。
    if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  for (const signature of signatures) {
    const bytes = fromHex(signature);
    if (bytes && (await hmacVerify(secret, `${timestamp}.${rawBody}`, bytes))) return true;
  }
  return false;
}
```

三个容易出错的地方：

- **必须用请求体的原文。** 签名是对收到的字节算的。如果先 `request.json()` 再 `JSON.stringify()`，字段的顺序和空格可能变化，签名就对不上了。所以处理函数里先 `request.text()` 拿到原文，验完签名再解析。
- **要检查时间。** 时间戳是被签名的内容的一部分，所以改不了。检查它和当前时间的差距，可以挡住重放：有人截获了一个真实的回调，过一段时间原样再发一次。Stripe 自己的库默认允许 5 分钟的误差。
- **可能有多个签名。** 轮换回调密钥期间，Stripe 会同时用新旧两个密钥签名，请求头里有两个 `v1`。

第 4 章校验 Telegram 的 `initData` 时遇到的是同样的三件事：验签名，查时间，比较要耗时固定。**所有来自外部平台的数据，都是这三步。**

### 处理事件

```ts
switch (event.type) {
  // 第二种是银行转账这类延迟到账的付款方式，到账时才会来。
  case "checkout.session.completed":
  case "checkout.session.async_payment_succeeded":
    await fulfillSession(env, event.data.object as unknown as Session);
    break;
  // 退款和拒付都要把发出去的东西收回来。
  case "charge.refunded":
  case "charge.dispute.created": {
    const metadata = event.data.object.metadata as { ref?: string } | undefined;
    const ref = parseRef(metadata?.ref);
    if (ref) await env.PLAYER.getByName(ref.playerId).refundOrder(ref.orderId, Date.now());
    break;
  }
}
// 不关心的事件也答复成功，否则 Stripe 会重试最长三天。
return json({ received: true });
```

```ts
async function fulfillSession(env: Env, session: Session): Promise<string> {
  // 会话完成不等于钱到账。延迟到账的付款方式，这时的状态还不是 paid。
  if (session.payment_status !== "paid") return "unpaid";
  // ……
}
```

关于 Stripe 的事件，官方文档明确说了三点，处理代码都要能应对：

- **同一个事件可能收到不止一次。**
- **事件到达的顺序不保证和发生的顺序一致。**
- **投递失败会重试。** 正式环境下最长重试三天，间隔逐渐拉长。

前两点靠 `fulfillOrder` 和 `refundOrder` 自己的状态检查来应对。重复的付款通知，第二次看到订单不是 `pending`，直接返回。乱序要多想一步：退款的通知比付款的通知先到时，订单还是 `pending`，没有东西可以收回。这时如果答复成功，Stripe 就认为这条退款已经处理完了，等付款的通知到达、货发出去之后，再也没有人来收回。所以这种情况要**故意不答复成功**，让 Stripe 稍后重发：

```ts
const result = ref ? await env.PLAYER.getByName(ref.playerId).refundOrder(ref.orderId, Date.now()) : null;
// 事件不保证按顺序到达。付款的事件还没处理到时不答复成功，让 Stripe 稍后重发这条退款。
if (result === "not_paid") return new Response("order not paid yet", { status: 409 });
```

写这一章时，第一版代码在这里答复的是成功，文字却写着"之后重试时再收回"。对照着把每一种到达顺序走一遍才发现对不上。**处理乱序不能只靠"每个操作都能重复"，还要确认每一种顺序走完之后，最终的状态是对的。** 这和 7.7 节检查好友关系的办法是同一个。

"会话完成不等于钱到账"和 Telegram 那边"答复了确认不等于付款成功"是同一个教训：**以"钱确实到了"的那个信号为准，不要以流程走到哪一步为准。**

### 先答复还是先处理

Stripe 的文档建议尽快答复成功，把耗时的处理放到后面，避免超时。这里的处理是一次对玩家对象的调用，几毫秒到几十毫秒，所以示例是处理完再答复，好处是处理失败时可以直接让 Stripe 重发。

如果发货的逻辑很重（要调用好几个外部系统），做法是：验完签名后把事件放进队列，立刻答复成功，由队列的消费者去发货。这样重试的责任从 Stripe 转到了你自己的队列上。两种方式选哪个，取决于处理要多久。

## 8.7 掉单：回调没来怎么办

玩家付了钱，游戏里没到账，这叫掉单。它一定会发生：回调在路上丢了，你的服务在那一刻出了问题，或者支付平台自己延迟了。玩家遇到掉单的第一反应是找客服，第二反应是申请退款，所以要尽量在玩家发现之前补上。

补单有三层，从快到慢：

**第一层：支付平台的重试。** 前面两节已经做了：处理失败就不答复成功，对方会重发。这一层解决的是"回调到了但没处理成"。

**第二层：玩家回到游戏时主动查。** 玩家付完钱回到游戏，客户端发现宝石没到账，可以让服务端去支付平台查一次：

```ts
// 付完钱回到游戏却没到账时，客户端可以让服务端主动去支付平台查一次。
if (pathname === "/pay/orders/sync") {
  // ……
  const order = await player.getOrder(body.orderId);
  if (!order) return fail(404, "not_found");
  if (order.status === "pending" && order.provider === "stripe" && order.externalId) {
    await syncCheckoutSession(env, order.externalId);
  }
  return json({ status: (await player.getOrder(body.orderId))!.status });
}
```

`syncCheckoutSession` 向 Stripe 查询这个结账会话的状态，已付款就调用同一个 `fulfillOrder`。下单时把结账会话的编号存在了订单的 `external_id` 里，就是为了这时候能查。

主动查询和回调可能同时到达，也可能一先一后。因为两条路最后都走 `fulfillOrder`，谁先到谁发货，后到的那个什么都不做：

```ts
it("回调没来时，主动查询也能把货发出去", async () => {
  // ……主动查询，发货……
  // 之后回调才到，不会再发一次。
  await stripe({ type: "checkout.session.completed", data: { object: stripeSession(session, orderId) } });
  expect((await wallet(session)).gems).toBe(100);
});
```

注意这个接口查的是玩家自己的订单，而且以支付平台的答复为准。客户端说"我付过了"不算数。

**第三层：定时扫描。** 玩家付完钱直接关了游戏，前两层都覆盖不到。需要一个定时任务，找出所有下单超过一段时间还没付款的订单，逐个去支付平台查。这要求能跨玩家查询"哪些订单还没付"，所以待付款的订单也要在 D1 里有一份副本。定时任务是第 9 章的内容，示例项目没有实现这一层。

Telegram 这边，Bot API 有一个 `getStarTransactions` 方法可以列出机器人的 Stars 收支记录，其中每一笔的编号和付款成功消息里的 `telegram_payment_charge_id` 是同一个，可以用来和自己的订单核对。

三层之外，还要给客服一个手动补单的工具：输入订单号，查支付平台，确认已付款后发货。它调用的仍然是 `fulfillOrder`，所以不用担心补重了。

## 8.8 退款与追回

退款有两种来源：你主动退的（客服同意了玩家的申请），和被动发生的（玩家向发卡行申请拒付，或者平台判定这笔交易有问题）。不论哪种，游戏这边要做的是同一件事：把发出去的东西收回来。

```ts
async refundOrder(orderId: string, now: number): Promise<RefundResult> {
  const order = this.getOrder(orderId);
  if (!order) return "not_found";
  if (order.status !== "paid") return "duplicate";
  this.ctx.storage.transactionSync(() => {
    this.applyDelta(`refund:${orderId}`, "refund", negate(PRODUCTS[order.productId]!.grant), now, true);
    this.ctx.storage.sql.exec("UPDATE purchase SET status = 'refunded' WHERE order_id = ?", orderId);
    this.emitPayment(orderId, now);
  });
  await this.flush();
  return "ok";
}
```

收回是**一笔新的、反向的流水**，编号是 `refund:订单号`。原来那笔发货的流水不动。任何时候都不要修改或删除已有的流水，账是只增不改的：出了错，记一笔冲正；要收回，记一笔反向的。这样流水表才是一份可信的历史。

### 已经花掉了怎么办

玩家充了 100 宝石，花了 80，然后退款。这时账上只剩 20，要收回 100。

示例的做法是**允许余额变成负数**：

```ts
expect(await wallet(session)).toEqual({ coins: 0, gems: -80, items: { dice_skin: 1 } });
// 欠着的时候什么都买不了。
expect((await post("/shop/buy", { itemId: "dice_skin", opId: "spend-0002" }, token)).status).toBe(409);
```

玩家欠着 80 宝石，下次充值先补上这部分。这是 `applyDelta` 的最后一个参数的用途，也是唯一允许余额为负的地方。

其他的处理方式：

| 做法 | 适合 |
|---|---|
| 余额变负，下次充值先抵扣 | 大多数情况。对玩家的影响最小，账是平的 |
| 收回用这些货币买到的道具 | 道具可以清楚地追溯到这笔充值时 |
| 封禁账号 | 反复恶意拒付的玩家 |
| 什么都不做 | 金额很小，处理成本高于损失时 |

用哪种是运营的决定。代码要保证的是：不论选哪种，退款这件事都被记录了下来，订单的状态是 `refunded`，流水里有对应的一笔。

主动退款时，顺序是先调用支付平台的退款接口（Telegram 是 `refundStarPayment`，需要付款时存下的流水号），退款成功的回调到达后再收回游戏里的东西。不要自己先收回再去退款，那样退款接口失败的话，玩家的钱和东西就都没了。

## 8.9 广告奖励

### 为什么不能信客户端

激励广告的流程是：玩家看完一段广告，得到游戏里的奖励。最简单的做法是广告播完之后，客户端调用一个"领取奖励"的接口。

这个接口等于是"调用一次，发一次钱"。不需要看广告，直接调用它就行。而且广告奖励通常很小，单次不起眼，脚本一天调用几万次才显现出来。

可靠的做法是让**广告平台的服务器**来通知你。玩家看完广告，广告平台在它那一侧确认这次观看是真实的，然后向你的服务端发一个带签名的回调。这叫服务端校验。

### 校验 AdMob 的回调

以 AdMob 为例。它的回调是一个 GET 请求，参数里有这次观看的编号、玩家的标识、奖励的数量，最后两个参数固定是签名和公钥的编号：

```text
/webhooks/admob?ad_network=…&reward_amount=1&transaction_id=…&user_id=…&signature=…&key_id=…
```

签名用的是 ECDSA，被签名的内容是 `signature` 之前的整段查询串。公钥从 AdMob 的密钥服务器取。

```ts
export async function verifyAdCallback(url: URL, now: number): Promise<URLSearchParams | null> {
  const query = url.search.slice(1);
  const at = query.indexOf("&signature=");
  if (at <= 0) return null;
  const signed = query.slice(0, at);
  const tail = new URLSearchParams(query.slice(at + 1));
  const signature = fromBase64Url(tail.get("signature") ?? "");
  const keyId = tail.get("key_id");
  if (!signature || !keyId) return null;

  const key = (await publicKeys(now)).get(keyId);
  // 签名是 DER 编码的，平台的校验接口要的是 r 和 s 直接拼起来的 64 个字节。
  const raw = derToRaw(signature);
  if (!key || !raw) return null;
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    raw,
    new TextEncoder().encode(signed),
  );
  return valid ? new URLSearchParams(signed) : null;
}
```

几个细节：

- **被签名的是查询串的原文。** 和 Stripe 的请求体一样，不能先解析成参数再拼回去。所以这里直接在原始的查询串上找 `&signature=` 的位置。
- **签名的编码要转换。** AdMob 的签名是 DER 编码的，而 Workers 的 Web Crypto 接口要的是把两个整数直接拼起来的 64 字节。`derToRaw` 做这个转换。这是在 Workers 上校验第三方 ECDSA 签名时经常遇到的问题。
- **公钥要缓存，但不能太久。** 每次回调都去取一次公钥太慢。官方的建议是缓存，但不超过 24 小时，因为公钥会定期轮换。示例缓存 1 小时。
- **校验通过后，只使用被签名的那部分参数。** 函数返回的是从签名内容里解析出来的参数，而不是整个地址的参数。签名之后的部分是没有被保护的。

公钥的缓存放在了模块级的变量里。第 2 章的约定是"不要用模块级的变量保存对象的状态"，这里并不违反：公钥是公开的、所有请求共用的、丢了可以重新取的数据。运行环境被回收之后重新拉一次即可。

### 发奖

```ts
const playerId = params.get("user_id") ?? "";
const transactionId = params.get("transaction_id") ?? "";
if (!PLAYER_ID.test(playerId) || transactionId === "" || transactionId.length > 128) {
  return new Response("bad request", { status: 400 });
}
const player = env.PLAYER.getByName(playerId);
// 签名只能说明这次观看是真的，不能说明这个玩家存在。
if (!(await player.getPublic()).exists) return new Response("unknown player", { status: 404 });
// 奖励多少由服务端决定，回调里的 reward_amount 只是广告后台里填的一个数，不使用。
const result = await player.grantAdReward(transactionId, Date.now());
```

- **玩家的标识是客户端在请求广告时设置的。** 客户端把自己的玩家 ID 交给广告的 SDK，它会出现在回调的 `user_id` 里，并且在签名的保护范围之内。
- **用广告平台给的观看编号去重。** 流水的编号是 `ad:观看编号`。广告平台也会重试回调。
- **奖励多少由服务端定。** 回调里的 `reward_amount` 是在广告后台配置的数，虽然它在签名的保护之内，但把发多少钱的决定权放在第三方的后台里不是好主意。
- **每天有上限。**

```ts
const dayStart = now - (now % DAY_MS);
const today = sql
  .exec("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'ad' AND coins > 0 AND created_at >= ?", dayStart)
  .one();
const capped = Number(today.n) >= AD_DAILY_CAP;
// 超过上限也记一行，金额为 0，这样同一次观看的通知再来时仍然会被认出是重复的。
this.applyDelta(opId, "ad", { coins: capped ? 0 : AD_REWARD_COINS }, now);
```

今天领了几次是直接从流水里数出来的，不需要另外维护一个计数器，也就不存在计数器和实际不一致的问题。超过上限时仍然写一行金额为 0 的流水，理由和第 7 章的邀请奖励相同。

即使有服务端校验，上限仍然需要。校验保证的是"广告平台认为这次观看是真的"，而刷广告的人针对的正是广告平台的判断。上限把这类行为的收益框住了。

### 奖励是异步到的

服务端校验带来一个体验上的变化：广告播完的那一刻，奖励还没有到账，要等广告平台的回调，通常是一两秒，偶尔更久。

客户端的做法是：广告播完后显示"奖励发放中"，然后每隔一两秒查一次钱包，看到余额变了再显示到账；等了十几秒还没到，就告诉玩家"奖励稍后到账"，不要让他一直等着。不要为了让奖励立刻出现而在客户端加一个直接领奖的接口，那就回到了这一节开头的问题。

其他广告平台的服务端校验形式不同（有的用 HMAC，有的让你回调时去查询它的接口），但要做的事是一样的：验来源，用平台给的编号去重，奖励由服务端定，设上限。

## 8.10 对账

### 余额和流水对得上

第三条规矩是余额等于流水的合计。把它写成一个可以调用的检查：

```ts
audit(): Audit {
  const sql = this.ctx.storage.sql;
  const profile = sql.exec("SELECT coins, gems, base_coins, base_gems FROM profile WHERE id = 1").one();
  const sum = sql.exec("SELECT COALESCE(SUM(coins), 0) AS coins, COALESCE(SUM(gems), 0) AS gems FROM ledger").one();
  const ledgerCoins = Number(profile.base_coins) + Number(sum.coins);
  const ledgerGems = Number(profile.base_gems) + Number(sum.gems);
  const coins = Number(profile.coins);
  const gems = Number(profile.gems);
  return { coins, gems, ledgerCoins, ledgerGems, ok: coins === ledgerCoins && gems === ledgerGems };
}
```

它的用处有两个。一是在测试里：每一个涉及钱的测试，最后都可以加一句对账，确认这条路径没有绕过流水。二是在线上：客服处理"我的金币不对"的投诉时先对一次账，对得上就按流水逐笔解释，对不上就是代码有缺陷。也可以抽样对活跃玩家定期对账，把结果做成指标（第 10 章）。

### 流水不能无限增长

每个玩家的流水都在增长。一个活跃玩家一天几十局，一年就是上万行。对象的存储按量计费，而且单个对象有 10 GB 的上限（虽然流水离这个上限很远）。

清理流水有两个要顾及的地方：

```ts
pruneLedger(before: number): number {
  const sql = this.ctx.storage.sql;
  let removed = 0;
  this.ctx.storage.transactionSync(() => {
    const old = sql
      .exec("SELECT COUNT(*) AS n, COALESCE(SUM(coins), 0) AS coins, COALESCE(SUM(gems), 0) AS gems FROM ledger WHERE created_at < ?", before)
      .one();
    removed = Number(old.n);
    if (removed === 0) return;
    sql.exec(
      "UPDATE profile SET base_coins = base_coins + ?, base_gems = base_gems + ? WHERE id = 1",
      Number(old.coins), Number(old.gems),
    );
    sql.exec("DELETE FROM ledger WHERE created_at < ?", before);
  });
  return removed;
}
```

**对账不能被破坏。** 被删掉的流水的合计，累加进资料表里的一个"基数"。对账时用基数加上剩余流水的合计，仍然等于余额。

**去重不能被破坏。** 流水同时也是去重的依据：一个编号的流水被删掉之后，同一个编号再来，就会被当成新的。所以保留期必须比任何一种重试可能持续的时间都长。这一章里最长的重试是 Stripe 的三天；加上客服补单、定时扫描这些人为的延迟，保留期应该以月计。示例没有定具体的数字，也没有安排自动清理，调用时机放在第 9 章的定时任务里。

删掉之前如果还需要保留（审计、数据分析），先把流水送出去：通过队列写进 R2 或者数据仓库。这和第 6 章的对局记录是同一条路。

### 和支付平台对账

每一笔付款和退款，都通过发件箱在 D1 里留了一行（7.1 节的机制）：

```sql
CREATE TABLE payment (
  order_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  -- 金额用支付平台的最小单位：Stars 是个数，美元是分。
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  seq INTEGER NOT NULL,
  paid_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

写入和排行榜一样按序号覆盖，付款和退款的通知乱序到达时，留下的是后发生的那个状态。

有了这张表，每天可以做一次汇总，和支付平台后台的账单比：

```ts
export async function totalsBetween(db: D1Database, from: number, to: number): Promise<Totals[]> {
  const rows = await db
    .prepare(
      `SELECT provider, currency, status, COUNT(*) AS orders, SUM(amount) AS amount
       FROM payment WHERE paid_at >= ? AND paid_at < ?
       GROUP BY provider, currency, status ORDER BY provider, currency, status`,
    )
    .bind(from, to)
    .all<Totals>();
  return rows.results;
}
```

比的是两个数：订单数和总金额。对得上，这一天就过了。对不上，再用 `external_id` 逐笔比对，找出是哪一笔。差异只有两种：

- **支付平台有、我们没有**：掉单。走补单流程。
- **我们有、支付平台没有**：发了货但没收到钱。这是最严重的一种，说明回调的校验有漏洞，或者有代码绕过了订单直接发货。

每天对一次账，不是因为每天都会出问题，而是因为出了问题要在一天之内知道，而不是月底结算时才发现。

## 8.11 测试

这一章的代码要调用外部的支付平台，测试里不能真的去调。做法是把 `fetch` 换成一个替身，记录发出去的请求，并返回预先准备好的应答：

```ts
beforeEach(() => {
  outbound = [];
  replies = {
    "api.telegram.org": { ok: true, result: "https://t.me/$test-invoice" },
    "api.stripe.com": { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" },
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    outbound.push({ url, init });
    const host = Object.keys(replies).find((key) => url.includes(key));
    if (!host) throw new Error(`测试里没有准备这个地址的应答：${url}`);
    return Response.json(replies[host]);
  });
});
```

没有准备应答的地址会直接抛出异常。这保证了测试不会意外地向真实的服务发出请求。

替身记录下的请求本身也是要检查的东西：发给 Stripe 的请求里有没有带幂等键，交给 Telegram 的引用对不对，价格是不是商品表里的。

回调的测试需要构造带合法签名的请求。Telegram 的只需要一个请求头；Stripe 的要用测试环境的密钥算一次 HMAC；AdMob 的要现场生成一对密钥，让替身在代码取公钥时返回它，再用私钥给查询串签名。

每一个回调至少测这几种情况：

| 情况 | 期望 |
|---|---|
| 来源校验不通过 | 拒绝，什么都不发生 |
| 正常的通知 | 发货 |
| 同一个通知来多次 | 只发一次 |
| 金额或订单对不上 | 不发货，订单保持原状 |
| 被篡改过的参数 | 拒绝 |
| 通知的顺序反了（退款先于付款） | 先到的那个不答复成功，重发后结果正确 |

## 8.12 示例项目的变化

这一章结束时，示例项目多了这些东西：

- `server/src/economy/catalog.ts`：资产变更的类型、充值商品表、商店的商品表。
- `server/src/player.ts`：新增宝石和道具；统一的资产变更入口 `transact` 和内部的 `applyDelta`；订单的创建、发货、退款；广告奖励；对账和流水清理。
- `server/src/economy/telegram.ts`：申请付款链接，处理 Telegram 的回调。
- `server/src/economy/stripe.ts`：创建结账会话、主动查询、校验签名、处理回调。
- `server/src/economy/admob.ts`：校验 AdMob 的服务端回调。
- `server/src/economy/reconcile.ts`：支付记录写入 D1，按渠道汇总。
- `server/src/economy/routes.ts`：`GET /wallet`、`POST /shop/buy`、`POST /pay/orders`、`POST /pay/orders/sync`，以及三个回调地址 `/webhooks/telegram`、`/webhooks/stripe`、`/webhooks/admob`。
- `server/migrations/0003_payments.sql`：支付记录表。
- 新增三个密钥：`TELEGRAM_WEBHOOK_SECRET`、`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`。
- 测试：新增 `test/economy.test.ts`，24 个测试。服务端一共 98 个测试。

本地运行前要再执行一次 `npm run db:local -w server`，并把 `.dev.vars.example` 里新增的三行补进自己的 `.dev.vars`。

三个回调地址是不需要玩家登录的接口，各自靠密钥或签名校验来源。第 4 章的约定是"不需要登录的接口必须限流"，这三个接口的限流放在第 11 章统一做。

## 本章小结

- 三条规矩：所有资产的变动走同一个入口；每一次变动都有编号、都写流水；余额等于流水的合计。
- 一次变更是一组变化量，要么全部生效，要么全部不生效。"扣钱"和"给东西"是一步，不是两步。
- 一个玩家一个对象，检查和修改在一个同步的事务里，钱的并发问题在结构上不存在。
- 价格在服务端，客户端只传商品编号。玩家发起的购买由客户端在点击时生成编号，重试用同一个。
- 在别的对象里花钱要先扣后用，每一步带编号，有明确的退还步骤。
- 充值时先在自己这边记下订单，再去找支付平台。订单的引用交给支付平台，回调时靠它找到玩家。付款的金额必须和下单时记下的一致。
- 回调的处理：先验来源；处理成功才答复成功，处理不了让对方重发；处理本身可以重复；处理不了的无效通知要答复成功。通知会乱序，来早了的通知也要让对方重发。
- 以"钱确实到了"的信号为准。Telegram 要等到付款成功的消息，Stripe 要看付款状态。
- 校验外部平台的数据是三步：用原文验签名，查时间，比较耗时固定。
- 调用支付平台的接口时带上幂等键，那是它那一侧的操作编号。
- 掉单一定会发生。补单有三层：平台重试、玩家回来时主动查、定时扫描。三条路走同一个发货函数。
- 退款是一笔反向的流水，不修改原来的流水。已经花掉的部分可以让余额变负。
- 广告奖励必须由广告平台的服务器通知，不能由客户端领取。奖励多少由服务端定，并设每日上限。
- 清理流水时把被删掉的合计记进基数，保留期要比任何一种重试持续的时间都长。
- 每天把自己的支付记录和支付平台的账单对一次。发了货但没收到钱是最严重的差异。

下一章做运营：配置怎么在线修改，活动怎么定时开关，邮件和补偿怎么发，以及前面几章留下的定时任务。
