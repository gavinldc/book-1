# 第 4 章　账号与鉴权

到上一章为止，示例项目里的玩家 ID 是客户端在地址里随手填的，填谁就是谁。这一章把它换成真正的账号体系，回答三个问题：玩家是谁，怎么证明，换了平台怎么还是同一个人。

这一章的代码在 [examples/server/src/auth/](../examples/server/src/auth/)、[identity.ts](../examples/server/src/identity.ts) 和 [player.ts](../examples/server/src/player.ts)。

## 4.1 三件事要分开

"登录"这个词里其实混着三件不同的事，它们的做法和存放位置都不一样：

| 事情 | 回答的问题 | 发生的频率 | 本章的做法 |
|---|---|---|---|
| 身份验证 | 你是谁 | 很低，每次登录一次 | 校验游客凭证或平台的签名 |
| 会话 | 怎么证明刚才验证过 | 很高，每个请求一次 | 签名的访问令牌，入口直接验，不查存储 |
| 授权 | 你能动什么 | 每个请求一次 | 玩家 ID 只从令牌里取，只能访问自己的对象 |

把它们分开的好处是成本。身份验证比较重，要查存储，有时还要调用外部平台，但它很少发生。会话校验每个请求都要做，所以必须轻：一次签名计算，不读任何存储，不唤醒任何对象。

整章只有一条不能破的规矩：**服务端永远不接受客户端自己报上来的玩家 ID。** 玩家 ID 只有一个来源，就是校验通过的令牌。地址、请求体、请求头里出现的玩家 ID 一律不信。

## 4.2 账号模型：玩家和身份是两回事

最容易犯的错误是直接把平台的用户 ID 当成玩家 ID，比如玩家对象就叫 `telegram:12345`。这样起步很快，但后面每一步都走不通：游客没有平台 ID；玩家想从游客升级成正式账号时，存档要整个搬家；同一个人在两个平台上玩，就是两份存档。

正确的模型是两层：

- **玩家**：游戏里的一个存档。玩家 ID 由服务端生成，是一串随机字符，和任何平台都没有关系，一旦生成永远不变。
- **身份**：证明"我是这个玩家"的一种方式。一个游客凭证是一个身份，一个 Telegram 账号是一个身份。一个玩家可以有多个身份。

```
身份 guest:9f2c…      ─┐
身份 telegram:12345   ─┼─→  玩家 p_3fa9c1…  →  存档、货币、战绩
身份 discord:98765    ─┘
```

登录就是"拿着某个身份，找到它对应的玩家"。绑定就是"给一个玩家再加一个身份"。游戏里的其他所有系统只认玩家 ID，完全不知道身份的存在。

## 4.3 身份对象：用命名保证唯一

身份到玩家的对应关系存在哪里？它有一个硬性要求：**一个身份只能对应一个玩家。** 两个请求同时用同一个 Telegram 账号首次登录，不能创建出两个玩家。

传统做法是数据库里一张表加唯一索引，在这里也可以用 D1 这么做。但本书的选择是为每个身份建一个 Durable Object，名字就是身份本身：

```ts
export class Identity extends DurableObject<Env> {
  async claim(candidate: string): Promise<string> {
    const owner = await this.ctx.storage.get<string>(PLAYER_KEY);
    if (owner) return owner;
    await this.ctx.storage.put(PLAYER_KEY, candidate);
    return candidate;
  }
}
```

整个类只有这一个核心方法。它的含义是"认领"：这个身份还没有归属时，归调用方提出的那个玩家；已经有归属时，什么都不改。**返回值永远是最终的归属者**，调用方比较返回值和自己提出的是不是同一个，就知道有没有认领成功。

唯一性不需要任何额外的机制。同名对象全球只有一个，并且单线程执行；等待存储的时候别的调用也插不进来（3.6 节）。两个请求同时认领同一个身份，一定是一个先执行完，另一个拿到前者的结果。

选对象而不选 D1 的理由有三条：

- **没有全局单点。** 登录是每个玩家都要走的路径。D1 的一个库是单线程的，所有登录都要经过它；身份对象则是每个身份各自一个，互不影响。
- **位置靠近玩家。** 身份对象创建在玩家首次登录的地方，以后每次登录都在附近完成。
- **和后面的代码一致。** 认领是一次普通的 RPC 调用，不需要引入另一套查询方式。

代价是它不能反过来查："列出所有绑定了 Telegram 的玩家"这类问题，身份对象回答不了。运营确实需要这种查询时，在登录成功后往队列里发一条消息，由消费者写一份副本到 D1（3.10 节），那份副本只用于查询，不参与登录。

身份对象的名字要注意两点：

- **带上来源前缀**，比如 `telegram:12345`、`discord:98765`。不同平台的用户 ID 可能撞号。
- **不要把秘密放进名字。** 游客凭证本身是秘密，所以名字用的是它的哈希：`guest:<SHA-256>`。名字会出现在日志和控制台里。

## 4.4 游客账号

出海的休闲游戏里，游客是默认的入口：玩家点开就能玩，不需要注册。游客账号的做法很简单：

1. 客户端第一次启动，调用登录接口，不带任何东西。
2. 服务端生成一个 256 位的随机凭证，为它创建身份和玩家，把凭证返回给客户端。
3. 客户端把凭证存在本地。以后每次启动都带着它登录，回到同一个玩家。

```ts
async function guestLogin(env: Env, body: Record<string, unknown>): Promise<Response> {
  const provided = body.secret;
  if (provided !== undefined && (typeof provided !== "string" || !SECRET_FORMAT.test(provided))) {
    return fail(400, "bad_request");
  }
  const secret = provided ?? randomSecret();
  const identityName = `guest:${await sha256Hex(secret)}`;
  const session = await login(env, "guest", identityName);
  if (!session) return fail(403, "banned");
  // 凭证只在生成的那一次返回，客户端要自己保存。
  return json(provided === undefined ? { ...session, guestSecret: secret } : session);
}
```

登录的公共部分对所有身份来源都一样：

```ts
async function login(env: Env, provider: string, identityName: string) {
  // 玩家 ID 由服务端生成，和任何外部身份都无关。身份已有归属时，这个候选 ID 直接丢弃。
  const candidate = newId("p_");
  const playerId = await env.IDENTITY.getByName(identityName).claim(candidate);
  const player = env.PLAYER.getByName(playerId);
  if (playerId === candidate) await player.linkIdentity(provider, identityName, Date.now());

  const sessionId = newId("s_");
  const refreshSecret = randomSecret();
  const opened = await player.openSession(sessionId, await sha256Hex(refreshSecret), Date.now());
  if (opened !== "ok") return null;
  return issue(env, playerId, sessionId, refreshSecret);
}
```

注意这里没有"先查有没有，没有再创建"的两步。每次登录都带着一个新生成的候选玩家 ID 去认领：身份是新的，候选 ID 就成为正式的玩家 ID；身份已有归属，候选 ID 被丢弃，没有任何东西需要清理，因为玩家对象在被访问之前并不存在。

关于游客账号，有几件事要想清楚：

**凭证由谁生成。** 由服务端生成，不要用客户端上报的设备 ID。设备 ID 可以被猜到或者伪造，知道了别人的设备 ID 就等于拿到了别人的账号。服务端生成的随机凭证没有这个问题。

**服务端只存哈希。** 身份对象的名字是凭证的哈希，凭证的原文在服务端不落地。即使身份对象的名字列表泄露，也无法反推出凭证。这里用一次 SHA-256 就够了，不需要专门的密码哈希算法：凭证是 256 位的随机数，不存在被字典攻击的可能。

**凭证丢了账号就丢了。** 玩家清除应用数据、换手机、浏览器清理存储，凭证就没了，服务端无法证明"这个新设备上的人就是原来那个游客"。这是游客账号固有的限制，不是实现的缺陷。应对的办法是在合适的时机（第一次充值之前、达到某个等级时）引导玩家绑定一个平台身份，4.9 节讲绑定。

**任何人都能无限创建游客。** 这个接口不需要任何凭证就能调用，每调用一次就多出一个玩家对象。所以它必须限流，见 4.10 节。

## 4.5 平台身份：以 Telegram 为例

游戏运行在某个平台里时（Telegram 的小程序、Discord 的活动），平台知道当前用户是谁，会把用户信息交给客户端。问题是服务端不能相信客户端转交过来的东西，必须自己验证这份信息确实出自平台。

各个平台的做法归结起来只有三种：

| 方式 | 原理 | 服务端要做什么 | 例子 |
|---|---|---|---|
| 共享密钥签名 | 平台用一个只有它和你知道的密钥给数据签名 | 用同一个密钥重新算一遍签名并比较，不需要发网络请求 | Telegram 小程序 |
| 公钥签名的令牌 | 平台用私钥签发一个身份令牌，公钥公开 | 取平台的公钥验签，并检查签发方、受众和过期时间 | Google、Apple 登录 |
| 授权码换取 | 客户端从平台拿到一个一次性的授权码 | 带着授权码和应用密钥去调用平台接口，换回用户信息 | Discord |

示例项目实现了第一种。Telegram 小程序启动时，客户端能拿到一个叫 `initData` 的字符串，形式是一串查询参数，里面有用户信息、签发时间和一个 `hash` 字段。校验算法是官方文档规定的：

1. 取出 `hash`，把剩下的所有字段按键名排序，写成 `键=值` 的形式，用换行符连接。
2. 用固定字符串 `WebAppData` 作为密钥，对机器人的令牌做一次 HMAC-SHA256，得到签名密钥。
3. 用这个签名密钥对第一步的字符串做 HMAC-SHA256，结果应该和 `hash` 一致。

```ts
export async function verifyTelegramInitData(
  initData: string,
  botToken: string,
  nowSeconds: number,
): Promise<TelegramUser | null> {
  const params = new URLSearchParams(initData);
  const hash = fromHex(params.get("hash") ?? "");
  if (!hash) return null;
  params.delete("hash");

  // 除 hash 以外的所有字段，按键名排序，用换行拼接。
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // 密钥是用固定字符串 WebAppData 对机器人令牌做一次 HMAC 得到的。
  const secretKey = await hmacSign("WebAppData", botToken);
  if (!(await hmacVerify(secretKey, dataCheckString, hash))) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || nowSeconds - authDate > TELEGRAM_MAX_AGE_SECONDS) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "") as TelegramUser;
    return Number.isSafeInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}
```

这段代码里有四个细节，换成任何平台都适用：

**先验签名，再用数据。** 签名通过之前，`initData` 里的任何字段都不能用，包括用来判断"要不要继续"的字段。代码的顺序是先验签，再看时间，最后才解析用户信息。

**比较签名要用恒定时间的方法。** 用 `===` 比较两个字符串时，遇到第一个不同的字符就返回，攻击者可以通过测量响应时间一位一位地猜出正确的签名。这里用的是 `crypto.subtle.verify`，比较过程由平台完成，耗时不随内容变化。需要直接比较两段字节时，Workers 提供了 `crypto.subtle.timingSafeEqual`，这是平台自己的扩展，不在 Web 标准里。

**一定要检查签发时间。** 签名只证明数据出自平台，不证明它是刚刚签发的。没有时间检查的话，一份 `initData` 被截获一次就可以永久使用。示例里的上限是 1 小时，这是本书的取值，官方文档只说"可以检查"，没有规定具体数字。

**机器人令牌是密钥，不是配置。** 它能用来伪造任何用户的登录数据，必须按 4.7 节的方式保存。

验签通过之后的事情和游客登录完全一样，只是身份的名字换成了 `telegram:<用户 ID>`：

```ts
const user = await verifyTelegramInitData(body.initData, env.TELEGRAM_BOT_TOKEN, nowSeconds());
if (!user) return fail(401, "invalid_signature");
const session = await login(env, "telegram", `telegram:${user.id}`);
```

另外两种方式本书不提供代码，这里说明要点：

- **公钥签名的令牌**（OpenID Connect 的身份令牌）。它是一个 JWT，要校验的东西比看上去多：签名、签发方、受众是不是你自己的应用 ID、过期时间。漏掉受众检查是最常见的漏洞，它意味着别的应用拿到的令牌也能登录你的游戏。平台的公钥会轮换，要按令牌头里的密钥编号去取，并把取到的公钥缓存起来。这部分建议用成熟的库（比如 `jose`，它可以在 Workers 上运行），不要自己实现。
- **授权码换取**。服务端要向平台发一次网络请求，所以要设置超时，并且要想好平台接口不可用时的表现：已登录的玩家不受影响（他们有自己的会话），只有新登录会失败。应用密钥只能放在服务端。

Telegram 还提供了第二种校验方式：用 Telegram 公开的 Ed25519 公钥验证 `signature` 字段，不需要机器人令牌。它是给第三方用的，自己的后端用上面的 HMAC 方式即可。

## 4.6 会话：访问令牌加刷新凭证

身份验证通过之后，服务端要发给客户端一个东西，让它在之后的请求里证明自己。有两种思路：

| | 有状态的会话 | 签名的令牌 |
|---|---|---|
| 做法 | 发一个随机的会话 ID，服务端存着它对应谁 | 把"是谁、何时过期"写进令牌，再签名 |
| 每次请求的成本 | 读一次存储 | 一次签名计算，不读存储 |
| 能否立即作废 | 能，删掉记录即可 | 不能，只能等它过期 |

在这套架构里，"每次请求读一次存储"意味着每次请求都要唤醒一次玩家对象，包括那些本来只需要转发给房间的请求。这个成本不值得。但纯粹的签名令牌无法作废，封禁一个玩家要等到他的令牌过期才生效。

通行的折中是两者各用一半：

- **访问令牌**：签名的，有效期很短（示例里是 15 分钟）。每个请求都带着它，入口只验签名，不查存储。
- **刷新凭证**：随机的，有效期长（示例里是 30 天），记录在玩家对象里。访问令牌过期后，客户端用它换一个新的访问令牌，这时才访问玩家对象。

这样，绝大多数请求不碰存储；而封禁、退出登录这些需要立即生效的操作，最长延迟一个访问令牌的有效期。**访问令牌的有效期，就是你愿意接受的"作废延迟"。** 15 分钟是一个常见的取值，对资产敏感的操作可以另外加一层检查（4.10 节）。

### 访问令牌

示例里的访问令牌是自己定义的格式，只有两段：载荷和签名。

```ts
export async function signAccessToken(secret: string, claims: AccessClaims): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await hmacSign(secret, payload);
  return `${payload}.${toBase64Url(signature)}`;
}
```

载荷里只有三个字段：玩家 ID、会话 ID、过期时间。校验的顺序同样是先验签名，再解析内容，最后检查过期：

```ts
if (!(await hmacVerify(secret, payload, signature))) return null;
// ……解析载荷……
if (claims.exp <= nowSeconds) return null;
```

没有用标准的 JWT，是因为这里用不上它的灵活性，而那份灵活性正是多数漏洞的来源：JWT 的头部里写着"我用的是什么算法"，校验方如果按这个字段去选算法，攻击者就可以把它改成"不签名"或者换一种算法。示例的令牌里没有算法字段，算法写死在代码里，这一类问题不存在。如果令牌要给第三方校验，或者你需要非对称签名，那就用 JWT，并且用成熟的库，在校验时显式指定只接受哪一种算法。

访问令牌里放什么，有两条原则：

- **只放校验时需要的东西。** 不要把金币、等级、权限放进去。令牌在有效期内不会更新，放进去的数据必然是过时的。
- **不要放敏感信息。** 载荷只是编码，没有加密，任何人拿到令牌都能读出内容。

### 刷新凭证

刷新凭证的格式是 `玩家 ID.会话 ID.随机串`。前两段用来定位到玩家对象里的那条会话记录，第三段是真正的秘密。玩家对象里只保存第三段的哈希：

```ts
rotateSession(sessionId: string, currentHash: string, nextHash: string, now: number): SessionResult {
  if (this.isBanned()) return "banned";
  const sql = this.ctx.storage.sql;
  const row = sql.exec("SELECT refresh_hash, expires_at FROM session WHERE id = ?", sessionId).toArray()[0];
  if (!row || Number(row.expires_at) <= now) return "invalid";
  if (row.refresh_hash !== currentHash) {
    sql.exec("DELETE FROM session WHERE id = ?", sessionId);
    return "invalid";
  }
  sql.exec(
    "UPDATE session SET refresh_hash = ?, expires_at = ? WHERE id = ?",
    nextHash,
    now + SESSION_TTL_MS,
    sessionId,
  );
  return "ok";
}
```

这里有一个值得照搬的设计：**刷新凭证只能用一次。** 每次刷新都换一个新的，旧的立即作废。如果有人拿着一个已经用过的凭证来刷新，只有两种可能：客户端出了问题，或者凭证被别人偷走并且用过了。服务端分不清是哪一种，所以直接删掉整个会话，让两边都重新登录。

它的副作用是：客户端发出了刷新请求但没收到响应（比如网络中断），下一次再用旧凭证就会失败，需要重新登录。对游客来说重新登录是无感的，用本地的游客凭证再走一次登录即可；对平台身份，重新取一次平台的登录数据。所以客户端要把"刷新失败"当成一条正常的路径来处理，而不是当成错误弹给玩家。

会话相关的其他几个决定：

- **会话记录放在玩家对象里。** 它是玩家自己的数据，写入者只有这个玩家的请求。不需要另建存储。
- **限制会话数量。** 示例里每个玩家最多保留 5 个会话，超出时删掉最旧的。不限制的话，一个反复登录的客户端会让会话表无限增长。
- **哈希的计算放在入口，不放在对象里。** 入口算好哈希再调用对象，对象里的方法全是同步的 SQL，中间没有任何等待，也就不存在被别的调用插入的问题。
- **比较哈希可以直接用 `!==`。** 这里比较的是哈希值而不是秘密本身，攻击者无法通过响应时间反推出原文。

### 客户端应该怎么用

这部分不属于后端，但后端的设计依赖客户端这样做，所以写在这里：

1. 启动时登录，保存访问令牌、它的过期时间和刷新凭证。
2. 每个请求带上访问令牌。
3. 在访问令牌过期之前主动刷新（比如还剩 2 分钟时），不要等到请求失败。
4. 收到 401 时刷新一次再重试；刷新也失败就重新登录。
5. 同一时刻只发一个刷新请求。并发的两个刷新会让其中一个用到已作废的凭证，触发上面的会话作废。

## 4.7 密钥的管理

这一章引入了两个密钥：给访问令牌签名的 `SESSION_SECRET`，和 Telegram 的机器人令牌。它们都不能写进配置文件，也不能提交到仓库。

Workers 用"密钥"这种绑定来保存它们，值是加密存储的，设置之后在控制台和命令行里都读不出来：

```bash
npx wrangler secret put SESSION_SECRET
```

在配置文件里声明这个 Worker 需要哪些密钥：

```jsonc
"secrets": { "required": ["SESSION_SECRET", "TELEGRAM_BOT_TOKEN"] }
```

这一行声明有三个作用：

- 发布时如果有密钥没设置，`wrangler deploy` 会直接失败并列出缺了哪些。不声明的话，代码会带着 `undefined` 上线，表现是所有人都登录不了。
- `wrangler types` 根据它生成类型，`env.SESSION_SECRET` 的类型是 `string`。CI 上没有本地的密钥文件，类型也能正常生成。
- 本地开发时只加载列出的这些名字。

和其他绑定一样，它不会被环境继承，预发环境要再写一遍。密钥的值也是每个环境各设各的，给预发环境设置时加上 `--env staging`。第一次发布这一章的代码之前，两个环境的密钥都要先设好，否则发布会被上面的检查拦下。实际操作中我漏写过一次，结果是类型变成了 `string | undefined`，类型检查直接报错，这也是一种保护。

本地开发时，密钥放在配置文件旁边的 `.dev.vars` 里，格式是每行一个 `名字="值"`。这个文件必须在 `.gitignore` 里。示例项目提交了一份 `.dev.vars.example`，里面是只能用于本地的假值，复制一份改名即可：`cp server/.dev.vars.example server/.dev.vars`。

关于密钥还有几条规矩：

- **正式和预发用不同的密钥。** 否则预发环境签出的令牌可以直接用在正式环境上。
- **`SESSION_SECRET` 用足够长的随机值**，至少 32 字节。可以用 `openssl rand -base64 32` 生成。
- **不要把密钥打进日志**，也不要放进错误信息里返回给客户端。
- **测试不依赖本地的密钥文件。** 示例项目在测试配置里直接给了一组只用于测试的值，这样 CI 不需要配置任何密钥就能跑测试。

### 轮换

密钥泄露或者定期更换时，直接换掉 `SESSION_SECRET` 会让所有在线玩家的访问令牌同时失效。因为访问令牌只有 15 分钟的寿命，客户端又会自动刷新，直接更换的后果只是所有人各刷新一次，多数游戏可以接受。

如果不能接受，标准做法是让校验同时接受两个密钥：新增一个存放旧值的密钥，签发只用新的，校验时先试新的、失败再试旧的；等过了一个访问令牌的有效期，再把旧的删掉。示例项目没有实现这一步。

注意 `wrangler secret put` 会立即创建并发布一个新版本。如果你在用灰度发布，要改用 `wrangler versions secret put`，它只创建版本，由你决定什么时候发布。

## 4.8 给 WebSocket 鉴权

HTTP 接口的鉴权很直接：令牌放在 `Authorization` 请求头里。WebSocket 麻烦一些，因为浏览器的 `WebSocket` 接口不允许设置自定义请求头。可选的办法有四种：

| 办法 | 做法 | 问题 |
|---|---|---|
| 放在地址里 | `wss://…/ws?token=…` | 地址会被记进访问日志和各种中间环节，令牌跟着泄露 |
| 放在子协议里 | `new WebSocket(url, ["game.v1", "auth.<令牌>"])` | 写法有点绕，服务端必须在应答里选定一个子协议 |
| 连上之后再验 | 先接受连接，要求第一条消息是令牌 | 未鉴权的连接已经占用了对象，要自己处理超时和踢出 |
| 一次性票据 | 先用 HTTP 换一个只能用一次的短期票据，放在地址里 | 多一次请求，多一处存储 |

示例项目用的是第二种。客户端这样连接：

```js
ws = new WebSocket(`${scheme}://${location.host}/room/${room}/ws`, ["game.v1", "auth." + session.accessToken]);
```

浏览器会把这两个值放进 `Sec-WebSocket-Protocol` 请求头。入口从里面取出令牌校验：

```ts
export async function authenticateWebSocket(request: Request, env: Env): Promise<string | null> {
  const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((item) => item.trim());
  if (!protocols.includes(WS_PROTOCOL)) return null;
  const token = protocols.find((item) => item.startsWith(WS_AUTH_PREFIX))?.slice(WS_AUTH_PREFIX.length);
  if (!token) return null;
  const claims = await verifyAccessToken(env.SESSION_SECRET, token, Math.floor(Date.now() / 1000));
  return claims?.sub ?? null;
}
```

这种做法有两个必须知道的细节：

- **应答里要选定一个子协议。** 客户端声明了子协议，服务端的应答就必须带上 `Sec-WebSocket-Protocol`，值是客户端列出的其中一个，否则浏览器会认为握手失败并断开。示例里房间对象返回的是 `game.v1`，不要把带令牌的那一个回显回去。
- **令牌的字符必须能放进子协议。** 子协议的取值只允许一部分字符。示例的令牌由 base64url 和一个点号组成，都在允许范围内；如果你的令牌里有 `=` 或 `/`（标准的 base64 就会有），要先转换。

这个 `game.v1` 还顺便解决了协议版本的问题：以后协议有不兼容的改动，客户端声明 `game.v2`，服务端按声明决定怎么处理。

### 鉴权在入口做，对象信任入口

校验在入口 Worker 里完成，通过之后把玩家 ID 传给房间对象：

```ts
const playerId = await authenticateWebSocket(request, env);
if (!playerId) return fail(401, "unauthorized");

// 先删掉客户端可能自带的同名请求头，再写入校验过的玩家 ID。
const headers = new Headers(request.headers);
headers.set(PLAYER_HEADER, playerId);
return env.ROOM.getByName(match[1]!).fetch(new Request(request, { headers }));
```

房间对象直接读这个请求头，不再校验令牌。这样做是安全的，前提有两个：

- **对象不能从公网直接访问。** Durable Object 没有自己的地址，只能通过绑定调用，而绑定只在你自己的 Worker 里。
- **入口必须覆盖这个请求头。** 用 `set` 而不是 `append`，这样客户端即使自己带了一个 `X-Player-Id`，也会被替换掉。示例项目有一个测试专门验证这一点。

把鉴权放在入口而不是对象里，还有成本上的原因：没有令牌或令牌无效的请求在入口就被拒绝了，不会唤醒任何对象，也不会产生对象的请求费用。攻击者拿无效的令牌刷房间接口，消耗的只是入口 Worker 的请求数。

### 连接建立之后

令牌只在建立连接时校验一次。连接建立之后，即使访问令牌过期了，连接仍然有效，这是合理的：一局游戏可能超过 15 分钟，不能因为令牌过期就把玩家踢出去。

但它也意味着，封禁一个正在对局中的玩家，不会让他已有的连接断开。需要立即生效时，要由服务端主动通知房间断开这个玩家的连接。第 5 章给房间加上踢人的接口，第 9 章把封禁和踢人接起来。

## 4.9 绑定与合并

绑定是给已有的玩家再加一个身份。最常见的场景是游客绑定平台账号，这样换设备之后还能找回存档。

流程是：玩家已经登录（带着访问令牌），同时提交一份平台的登录数据；服务端验签之后，让这个平台身份认领当前玩家。

```ts
const identityName = `telegram:${user.id}`;
const player = env.PLAYER.getByName(claims.sub);

// 这个玩家已经绑过另一个 Telegram 账号。
const linked = (await player.getAccount()).identities.telegram;
if (linked && linked !== identityName) return fail(409, "already_linked");

// 认领身份。返回的不是自己，说明它已经属于另一个玩家。
const owner = await env.IDENTITY.getByName(identityName).claim(claims.sub);
if (owner !== claims.sub) return fail(409, "identity_taken");

// 这一步失败时客户端重试即可：上面的认领对同一个玩家是幂等的。
await player.linkIdentity("telegram", identityName, Date.now());
return json({ ok: true });
```

这段代码涉及两个对象：身份对象记下"我属于谁"，玩家对象记下"我绑了哪些身份"。按 3.7 节的说法，跨对象没有事务，所以要想清楚中途失败会怎样：

- 认领成功、记录失败：身份已经指向这个玩家，用这个身份登录能正确回到这个玩家，功能上没有问题，只是玩家对象里少了一条展示用的记录。客户端重试时，认领会再次返回自己，然后补上记录。
- 所以这里的顺序是有意的：**先做决定归属的那一步，再做只用于展示的那一步。** 真正的事实只有一份，在身份对象里；玩家对象里的那份是可以重建的副本。

### 身份已经被占用时

真正麻烦的情况是 `identity_taken`：玩家想绑定的 Telegram 账号，已经对应着另一个玩家了。典型的经过是，玩家在手机上用 Telegram 玩过，后来在网页上以游客身份又玩了一阵，现在想把两边连起来。

这时有三种处理方式：

| 方式 | 做法 | 评价 |
|---|---|---|
| 拒绝 | 告诉玩家这个账号已被使用 | 最简单，但玩家不知道该怎么办 |
| 切换 | 让玩家选择"改用那个账号继续玩"，当前的游客存档放弃 | 实现简单，结果明确，是本书的建议 |
| 合并 | 把两份存档合成一份 | 看起来最友好，实际问题最多 |

**不要自动合并。** 合并的问题不在技术上，而在规则上：两边的金币相加还是取大？两边都领过的新手奖励算不算重复领取？两边的排行榜成绩怎么算？更重要的是，"合并"会成为刷资源的工具：开一批游客号，每个号领完一次性奖励，再全部合并到主号上。

本书的建议是做"切换"：服务端返回 `identity_taken`，客户端提示"这个账号已有游戏进度，是否切换过去？当前的游客进度将不再保留"，玩家确认后，客户端直接用平台身份登录即可，服务端不需要额外的接口。游客的那份存档留在原地，不用删除，也不会再被访问。

如果产品上一定要合并，守住这几条：

- 只合并不可能被用来套利的数据，比如付费购买的货币和商品；一次性奖励、活动进度一律不合并。
- 合并是跨对象的操作，按 3.7 节的方式做：源玩家先记下一笔带编号的"转出"并扣掉余额，再调用目标玩家的入账方法，目标按编号去重，失败由定时器重试。
- 合并之后把源玩家标记为已合并，它的身份全部改指向目标玩家，并且不允许再登录。
- 每一次合并都要留下记录，能查到谁在什么时候把什么合并到了哪里。

### 解绑

解绑要注意一条底线：**不能解绑最后一个身份。** 一个没有任何身份的玩家，就是一份再也没有人能登录的存档。示例项目没有实现解绑；实现时，由玩家对象在自己的事务里检查剩余的身份数量，通过之后再去清除身份对象里的归属。

## 4.10 限流和封禁

### 限流

登录接口是整个后端里唯一不需要令牌就能调用的写接口，必须限流。Workers 提供了限流绑定，在配置文件里声明：

```jsonc
"ratelimits": [{ "name": "AUTH_LIMITER", "namespace_id": "1001", "simple": { "limit": 20, "period": 60 } }]
```

使用时给它一个键，它告诉你这个键有没有超限：

```ts
const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
const { success } = await env.AUTH_LIMITER.limit({ key: ip });
if (!success) return fail(429, "too_many_requests");
```

用它之前要知道它的特性，官方文档写得很明确：

- **它是近似的。** 计数是最终一致的，实际放行的请求数可能超过设定值。
- **它是按节点各自计数的。** 悉尼的请求只计入悉尼的额度，不同节点的计数不会合并成一个全球的上限。
- 周期只能是 10 秒或 60 秒。`namespace_id` 是你自己定的一个整数（写成字符串），在账号内唯一；两个绑定用了同一个值，就会共用计数。所以示例里正式和预发用的是不同的值。
- 它很快。每次检查用的是本地缓存的计数，不需要等待网络。

这些特性决定了它适合做什么：**挡住明显的滥用，不适合做精确的额度控制。** "每个地址每分钟最多登录 20 次"适合用它；"每个玩家每天只能领 3 次奖励"不能用它，那是业务规则，要写在玩家对象里。

按来源地址限流还有一个现实问题：很多出海市场的移动网络是大量用户共用一个出口地址的，限得太紧会误伤正常玩家。限流的数值要根据实际流量来调，并且把被拒绝的次数作为一个指标监控起来（第 11 章）。

只靠限流挡不住有意批量注册的人。更进一步的手段（人机验证、奖励的延迟发放）放在第 11 章，其余接口的限流也在那一章统一做。

### 封禁

封禁是玩家对象里的一个标志位。封禁时同时删掉所有会话：

```ts
ban(): void {
  this.ctx.storage.transactionSync(() => {
    this.ctx.storage.sql.exec("UPDATE profile SET banned = 1 WHERE id = 1");
    this.ctx.storage.sql.exec("DELETE FROM session");
  });
}
```

之后这个玩家的刷新会被拒绝，重新登录也会被拒绝。按 4.6 节的设计，他手上已有的访问令牌最长还能用 15 分钟。

对大多数接口这个延迟可以接受。对不能接受的操作（充值、提现、交易），有一个不增加成本的办法：这些操作本来就要调用玩家对象，让玩家对象在执行前自己检查封禁标志即可。**凡是本来就要进玩家对象的操作，封禁检查是免费的；只有那些不经过玩家对象的操作（比如进房间），才依赖令牌过期。**

示例项目没有提供封禁的 HTTP 接口，`ban` 方法目前只在测试里通过 RPC 调用。管理后台的鉴权是另一个话题，第 9 章讲运营后台时再做。

## 4.11 示例项目的变化

这一章结束时，示例项目多了这些东西：

- `server/src/auth/`：`crypto.ts`（编码、哈希、HMAC 的小函数）、`token.ts`（访问令牌的签发和校验）、`telegram.ts`（Telegram 登录数据的校验）、`websocket.ts`（从子协议里取令牌）、`routes.ts`（登录、刷新、退出、绑定几个接口）。
- `server/src/identity.ts`：身份对象。
- `server/src/player.ts`：新增一条迁移（会话表、身份表、封禁标志），以及会话、绑定和封禁相关的方法。
- 接口的变化：

  | 接口 | 说明 |
  |---|---|
  | `POST /auth/guest` | 游客登录。不带凭证时创建新账号 |
  | `POST /auth/telegram` | 用 Telegram 的登录数据登录 |
  | `POST /auth/refresh` | 用刷新凭证换新的访问令牌 |
  | `POST /auth/logout` | 结束当前会话 |
  | `POST /auth/bind/telegram` | 给当前玩家绑定 Telegram 身份 |
  | `GET /me` | 读取自己的存档，取代上一章的 `GET /player/:id` |
  | `/room/:id/ws` | 不再接受地址里的 `player` 参数，改为从子协议里取令牌 |

- 配置文件新增了 `IDENTITY` 绑定、`secrets` 声明和限流绑定，正式和预发两个环境都要声明。
- `server/.dev.vars.example`：本地开发用的密钥样例。
- `server/test/auth.test.ts`：18 个新测试，覆盖游客登录、令牌伪造和过期、刷新凭证的一次性、封禁、Telegram 验签、绑定的几种冲突、限流。
- 联调页面改为先以游客身份登录，再连接房间。

写这一章的代码时遇到过一个和鉴权无关的问题，值得记一笔：**入口模块里不能导出普通的常量。** 我最初在 `index.ts` 里写了 `export const PLAYER_HEADER = "X-Player-Id"`，测试全部通过，但本地开发服务器启动失败，报错说这个导出"不是函数或处理器"。入口模块的每一个具名导出都会被运行时当作一个入口点，只能是处理器或者类。共用的常量要放到别的模块里。这也说明测试通过不等于能启动，交付前两样都要跑。

## 本章小结

- 身份验证、会话、授权是三件事。身份验证重而少，会话校验轻而多，后者不应该读存储。
- 服务端永远不接受客户端报上来的玩家 ID，玩家 ID 只从校验通过的令牌里取。
- 玩家和身份分开：玩家 ID 由服务端生成且永远不变，一个玩家可以有多个身份。
- 每个身份一个对象，名字带来源前缀，秘密不进名字。"一个身份只属于一个玩家"由对象的唯一性和单线程保证。
- 游客凭证由服务端生成，服务端只存哈希。凭证丢失无法找回，要引导玩家绑定平台身份。
- 校验平台的登录数据：先验签名再用数据，用恒定时间的比较，检查签发时间，平台密钥按密钥保管。
- 会话用短期的访问令牌加可作废的刷新凭证。访问令牌的有效期就是作废的最大延迟。刷新凭证只能用一次，重复使用则整个会话作废。
- 密钥用密钥绑定保存，在配置里声明为必需，正式和预发分开。
- WebSocket 的令牌放在子协议里，应答必须选定一个子协议。鉴权在入口完成，用覆盖写入的请求头把玩家 ID 传给对象。
- 绑定时先写决定归属的身份对象，再写展示用的记录。身份已被占用时让玩家选择切换，不要自动合并存档。
- 限流绑定是近似的、按节点计数的，只用来挡滥用。业务上的次数限制写在玩家对象里。
- 封禁在玩家对象里做标记并清空会话。本来就要进玩家对象的操作可以立即拦住，其余的等访问令牌过期。

下一章回到房间：回合状态机、断线重连、服务端校验，以及怎么把一个房间从创建管到销毁。
