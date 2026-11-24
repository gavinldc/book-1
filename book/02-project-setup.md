# 第 2 章　工程搭建

> 状态：初稿　｜　文档核实与实际运行日期：2026-11-24

这一章把示例项目从零搭起来：目录怎么分，配置文件怎么写，本地怎么跑，测试怎么写，怎么发到预发和正式环境。章末你会得到一个能双人联机的掷骰子房间，后面每一章都在它上面加东西。

完整代码在仓库的 [examples/](../examples/README.md) 目录。正文只摘录关键片段，建议对照着代码读。

一个提醒：Cloudflare 的工具链这两年变化很快，对象的声明方式、测试插件、取对象的写法都换过。网上很多教程（以及 AI 助手的记忆）还停留在旧写法。本章的每一段配置和命令都在下表的版本上实际运行过，旧写法会在对应位置注明。

| 工具 | 本章使用的版本 |
|---|---|
| Node.js | 24.15.0 |
| wrangler | 4.167.0 |
| vitest | 4.1.12 |
| @cloudflare/vitest-plugin | 1.9.1 |
| TypeScript | 5.9.3 |

## 2.1 目录结构

```
examples/
├── package.json            工作区定义
├── tsconfig.base.json      共用的 TypeScript 配置
├── AGENTS.md               写给 AI 编程助手的约定
├── shared/                 协议类型和游戏规则，不依赖平台
│   └── src/
│       ├── protocol.ts
│       ├── rules.ts
│       └── rules.test.ts
├── server/                 Worker 入口和房间对象
│   ├── wrangler.jsonc
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts
│   │   └── room.ts
│   └── test/
│       └── worker.test.ts
├── client/                 联调用的最小页面
│   └── index.html
└── ci/
    └── github-actions.yml
```

分成 `shared` 和 `server` 两个包，是为了落实第 1 章的两条约定：

- **规则与平台分离。** `shared` 里没有任何 Cloudflare 的接口。游戏规则在这里是纯函数，可以在普通的 Node.js 里测试，也可以原样搬到别的平台。`server` 只做连接管理、调用规则、保存和广播状态。
- **协议只定义一次。** 消息类型放在 `shared`，服务端直接引用；将来真正的客户端也引用同一份，任何一端改了字段，另一端在编译时就会报错。

两个包用 npm 的工作区功能连起来。`shared` 的 `package.json` 直接把入口指向 TypeScript 源码，不需要单独的构建步骤，wrangler 和 vitest 都能直接处理：

```json
{
  "name": "@game/shared",
  "exports": "./src/index.ts"
}
```

## 2.2 把项目跑起来

本章在 Node.js 24 上验证。

```bash
git clone https://github.com/gavinldc/book-1.git
```

```bash
cd book-1/examples && npm install
```

```bash
npm test
```

```bash
npm run dev
```

`npm run dev` 启动后，终端会显示本地地址。用浏览器打开它，会看到联调页面。开两个窗口，填同一个房间号和不同的玩家 ID，各自点"连接"和"准备"，然后轮流掷骰子，先走到 20 的人获胜。

整个过程不需要 Cloudflare 账号。wrangler 在本机模拟了 Worker、房间对象和它的存储。本地的存储数据保存在 `server/.wrangler/` 目录下，删掉这个目录就回到初始状态。

## 2.3 shared：规则是纯函数

先看规则，因为它和平台完全无关。状态只有四个字段：

```ts
export interface RoomState {
  phase: "waiting" | "playing" | "finished";
  players: Player[];
  /** 当前轮到的玩家在 players 里的下标。 */
  turn: number;
  winner: string | null;
}
```

所有的状态变化都经过同一个函数：

```ts
export type Action =
  | { type: "join"; playerId: string }
  | { type: "leave"; playerId: string }
  | { type: "ready"; playerId: string }
  | { type: "roll"; playerId: string; dice: number };

export type Result = { ok: true; state: RoomState } | { ok: false; error: RuleError };

export function applyAction(state: RoomState, action: Action): Result;
```

这里有三个设计上的选择，后面的章节会一直沿用。

**不修改传入的状态，返回新状态。** 调用方可以在保存成功之后再替换内存里的状态，失败了就当什么都没发生。

**错误是返回值，不是异常。** "还没轮到你"是正常的业务结果，要原样告诉客户端。把它做成类型的一部分，调用方就不会忘记处理。

**骰子点数由调用方传入。** `roll` 这个操作自带 `dice` 字段，规则函数里没有随机数。这样规则是确定性的，同样的操作序列永远得到同样的结果，测试可以精确断言，第 6 章做对局回放时也能直接重放。随机数在哪里生成是服务端的事，见 2.6 节。

测试因此非常直接，不需要任何模拟：

```ts
it("只有当前回合的玩家可以掷骰子", () => {
  const state = run(twoReady);
  expect(applyAction(state, { type: "roll", playerId: "b", dice: 3 })).toEqual({
    ok: false,
    error: "not_your_turn",
  });
});
```

十个规则测试跑完用时不到 10 毫秒。这类测试是 AI 助手改完规则后自我验证的主要手段，也是你验收时最该看的东西。

### 协议和输入校验

协议文件定义了两个方向的消息：

```ts
export type ClientMessage = { type: "ready" } | { type: "roll" };

export type ServerMessage =
  | { type: "state"; state: RoomState }
  | { type: "error"; code: RuleError | "bad_message" };
```

注意客户端的 `roll` 消息里没有点数，也没有玩家 ID。点数由服务端生成，玩家是谁由连接决定。**客户端消息里只放"我想做什么"，凡是服务端能自己知道的信息都不让客户端传**，这是防作弊最基本的一条。

TypeScript 的类型只在编译时存在，线上收到的是任意字符串。所以协议文件里还有一个运行时的解析函数，任何不合法的输入都返回 `null`：

```ts
export function parseClientMessage(raw: string): ClientMessage | null;
```

## 2.4 配置文件：整个系统的清单

`server/wrangler.jsonc` 声明了这个后端由什么组成：

```jsonc
{
  "name": "game-backend-example",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",

  // 房间对象：绑定名 ROOM，对应代码里导出的 Room 类，使用 SQLite 存储。
  "durable_objects": {
    "bindings": [{ "name": "ROOM", "class_name": "Room" }]
  },
  "exports": {
    "Room": { "type": "durable-object", "storage": "sqlite" }
  },

  // 联调用的最小客户端，作为静态资源一起发布。
  "assets": { "directory": "../client" },

  "observability": { "enabled": true },

  "vars": { "ENVIRONMENT": "production" }
}
```

逐项说明：

- **`compatibility_date`** 固定了运行时的行为版本。平台之后的不兼容改动不会影响你，直到你主动改这个日期。新项目填当天即可。
- **`durable_objects.bindings`** 让代码里可以通过 `env.ROOM` 访问房间对象。
- **`exports`** 声明 `Room` 是一个使用 SQLite 存储的 Durable Object 类。
- **`assets`** 把一个目录作为静态资源发布。请求先匹配静态文件，匹配不到才进入 Worker 代码。
- **`observability`** 打开日志采集，第 10 章会用到。
- **`vars`** 是普通的环境变量。密钥不放这里，见 2.7 节。

> **旧写法提示。** 早先声明对象类用的是 `migrations` 字段，形如 `{ "tag": "v1", "new_sqlite_classes": ["Room"] }`，现在的入门文档改用上面的 `exports`。两者不能同时出现在一个配置里。如果你接手的是老项目，继续沿用 `migrations` 即可。

以后每加一样东西（数据库、队列、对象存储），都是在这个文件里加几行。它是整个系统的清单，也是 AI 助手了解项目的第一个入口。

## 2.5 类型：让配置和代码对得上

配置里声明了 `ROOM` 和 `ENVIRONMENT`，代码里怎么知道 `env` 上有这两个字段？答案是让 wrangler 根据配置生成类型：

```bash
npm run types -w server
```

它会生成 `server/worker-configuration.d.ts`，里面有运行时的全部类型定义，以及根据配置推导出的 `Env`：

```ts
ENVIRONMENT: "staging" | "production";
ROOM: DurableObjectNamespace<import("./src/index").Room>;
```

有两处细节值得注意：`ENVIRONMENT` 的类型不是 `string`，而是各个环境取值的联合类型；`ROOM` 带上了具体的类，通过它调用对象的方法时会有类型检查。

`tsconfig.json` 里引用这个文件就行：

```json
{
  "compilerOptions": {
    "types": ["./worker-configuration.d.ts"]
  }
}
```

这个文件有一万多行，是生成物，本项目没有把它提交进仓库，而是让类型检查脚本每次先生成一遍：

```json
"typecheck": "wrangler types && tsc -p . && tsc -p test"
```

改了配置文件之后要重新生成。写错绑定名、忘了在某个环境里声明绑定，都会在类型检查时暴露出来，不用等到运行时。

> **旧写法提示。** 以前的做法是安装 `@cloudflare/workers-types` 并手写 `interface Env`。现在生成的类型文件已经包含了运行时类型，应用代码不再需要那个包。

## 2.6 Worker 入口与房间对象

### 入口：只做路由

`server/src/index.ts` 是所有请求的入口。它是无状态的，只负责检查请求、找到对应的房间对象并把请求转过去：

```ts
export { Room } from "./room";

const ROOM_WS = /^\/room\/([A-Za-z0-9_-]{1,32})\/ws$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, environment: env.ENVIRONMENT });
    }

    const match = ROOM_WS.exec(url.pathname);
    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("需要 WebSocket 连接", { status: 426 });
      }
      // …… 校验 player 参数 ……
      return env.ROOM.getByName(match[1]!).fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

关键是 `env.ROOM.getByName(房间号)` 这一行。同一个房间号在全世界任何节点上取到的都是同一个对象，不存在就自动创建。传统架构里"这个房间在哪台机器上"的问题，在这里是一次函数调用。

房间号和玩家 ID 都用正则限制了字符集和长度。这些值来自外部输入，又会被用作对象的名字，必须在入口处校验。

第一行的 `export { Room }` 不能省。对象类必须从入口文件导出，平台才找得到它。

目前玩家 ID 直接取自查询参数，谁都可以冒充别人。第 4 章会把它换成真正的鉴权。

### 房间对象：连接、规则、存储

`server/src/room.ts` 里的 `Room` 类只做三件事：管理连接，调用 `shared` 里的规则，保存并广播状态。

接受连接：

```ts
async fetch(request: Request): Promise<Response> {
  const playerId = new URL(request.url).searchParams.get("player")!;

  const state = await this.load();
  const joined = applyAction(state, { type: "join", playerId });
  if (!joined.ok) {
    return new Response(joined.error, { status: 409 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  this.ctx.acceptWebSocket(server);
  server.serializeAttachment({ playerId });

  await this.save(joined.state);
  this.broadcast({ type: "state", state: joined.state });
  return new Response(null, { status: 101, webSocket: client });
}
```

处理消息：

```ts
async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
  const { playerId } = ws.deserializeAttachment() as Attachment;
  const message = typeof raw === "string" ? parseClientMessage(raw) : null;
  if (!message) {
    this.send(ws, { type: "error", code: "bad_message" });
    return;
  }

  const action: Action =
    message.type === "roll" ? { type: "roll", playerId, dice: rollDice() } : { type: "ready", playerId };

  const result = applyAction(await this.load(), action);
  if (!result.ok) {
    this.send(ws, { type: "error", code: result.error });
    return;
  }
  await this.save(result.state);
  this.broadcast({ type: "state", state: result.state });
}
```

有四点需要解释。

**用 `this.ctx.acceptWebSocket`，不要用 `server.accept()`。** 前者把连接交给运行时托管，对象空闲时可以休眠，连接仍然保持；后者会让对象一直驻留在内存里。第 1 章算过，这两种写法的账单能差出一个数量级。

**玩家是谁，记在连接的附加数据上。** `serializeAttachment` 把一小段数据绑在连接上，对象休眠再唤醒后仍然能通过 `deserializeAttachment` 取回。不要把"连接对应哪个玩家"存在类的成员变量里，休眠后它就没了。附加数据的上限是 16,384 字节，只适合放身份信息这类小东西。

**状态每次都从存储读。** `load()` 直接读存储，没有在内存里缓存。原因同上：对象随时可能休眠，内存里的东西不可靠。对象自带的存储是本地读写，速度很快，在这个规模下不需要缓存。第 3 章会讨论什么时候值得加缓存，以及怎么加才安全。

**骰子在服务端掷。** 客户端只能说"我要掷"，点数由 `rollDice()` 用 `crypto.getRandomValues` 生成，再作为操作的一部分交给规则函数。

断开连接时有一个容易漏掉的情况：

```ts
async webSocketClose(ws: WebSocket): Promise<void> {
  const { playerId } = ws.deserializeAttachment() as Attachment;
  // 同一个玩家可能开了多个连接，只有最后一个断开才算离开。
  const stillConnected = this.ctx
    .getWebSockets()
    .some((other) => other !== ws && (other.deserializeAttachment() as Attachment).playerId === playerId);
  if (stillConnected) return;
  // …… 应用 leave 操作并广播 ……
}
```

目前的处理是断线即离开，对局中只剩一人时直接判胜。真实的游戏需要断线重连和托管，这是第 5 章的内容。

## 2.7 本地开发

`npm run dev` 背后是 `wrangler dev`。它用和线上相同的运行时在本机执行你的代码，改动保存后自动重新加载。几个常用的事实：

- 本地运行不需要登录 Cloudflare 账号。
- 对象的存储保存在 `server/.wrangler/` 下，重启后数据还在。这个目录不应该提交。
- 密钥（支付平台的签名密钥、第三方接口的令牌等）不要写进 `wrangler.jsonc`。本地开发时放在 `server/.dev.vars` 文件里，格式是每行一个 `名称=值`，这个文件同样不提交。线上的密钥用 `wrangler secret put` 设置。本章还没有用到密钥，第 4 章开始会用。

不想开浏览器的话，用命令行也能验证：

```bash
curl http://localhost:8787/health
```

端口以你终端里实际显示的为准。

## 2.8 测试

示例项目有两层测试。

**第一层：规则测试。** 在 `shared` 里，用普通的 vitest 跑在 Node.js 上，2.3 节已经看过了。

**第二层：服务端测试。** 在 `server/test` 里，代码跑在真实的 Workers 运行时中，对象、存储、WebSocket 都是真的，只是在本机。这由 Cloudflare 的 vitest 插件实现，配置只有几行：

```ts
// server/vitest.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
```

插件读取同一份 `wrangler.jsonc`，所以测试里的绑定和线上一致。测试代码通过 `exports.default.fetch` 直接调用 Worker 的入口：

```ts
import { exports } from "cloudflare:workers";

it("房间地址必须用 WebSocket 访问", async () => {
  const response = await exports.default.fetch(new Request("http://example.com/room/r0/ws?player=a"));
  expect(response.status).toBe(426);
});
```

测试 WebSocket 也是同样的入口。带上 `Upgrade` 头发起请求，返回的响应上有一个 `webSocket` 属性，调用 `accept()` 之后就可以收发消息：

```ts
const response = await exports.default.fetch(
  new Request("http://example.com/room/r1/ws?player=a", { headers: { Upgrade: "websocket" } }),
);
const ws = response.webSocket!;
ws.accept();
ws.send(JSON.stringify({ type: "ready" }));
```

示例里用这种方式写了一个完整的双人流程：两人连接、各自准备、没轮到的人掷骰子收到错误、轮到的人掷骰子后回合交给对方。它走的是和真实客户端完全相同的路径。

两层测试的分工是：规则的各种分支在第一层测，快而且全；第二层只测"接线"是否正确，也就是路由、连接、存储、广播这些规则管不到的地方。不要在第二层重复测规则。

> **旧写法提示。** 之前的测试方案是 `@cloudflare/vitest-pool-workers` 包，配置用 `defineWorkersConfig`，测试里从 `cloudflare:test` 导入 `SELF`。现在的文档改用上面的 `@cloudflare/vitest-plugin`，并要求 vitest 4.1 或更高版本。

## 2.9 多环境

至少需要两个环境：预发环境用来验证，正式环境给玩家用。在配置文件里加一个 `env` 字段：

```jsonc
"env": {
  "staging": {
    "name": "game-backend-example-staging",
    // 绑定和变量不会被环境继承，必须在每个环境里重新声明。
    "durable_objects": {
      "bindings": [{ "name": "ROOM", "class_name": "Room" }]
    },
    "vars": { "ENVIRONMENT": "staging" }
  }
}
```

顶层的配置就是正式环境，`env.staging` 是预发环境。两个环境是两个独立的 Worker，名字不同，各自的房间对象和存储互不相通，预发环境怎么折腾都不会碰到正式数据。

这里有一个坑：**不是所有配置都会被环境继承。** `main`、`compatibility_date`、`assets`、`exports`、`observability` 这类会继承；而 `vars`、`durable_objects` 以及数据库、队列、存储桶等各种绑定都不会，必须在每个环境里重写一遍。漏写的后果是预发环境里 `env.ROOM` 不存在。好在 2.5 节生成的类型会把所有环境都考虑进去，漏了通常能在类型检查时发现。

发布到预发环境：

```bash
npm run deploy:staging -w server
```

发布到正式环境：

```bash
npm run deploy -w server
```

第二条命令实际执行的是 `wrangler deploy --env=""`。配置里定义了多个环境之后，不带 `--env` 的发布命令会收到警告，提醒你明确指定目标；传空字符串表示顶层环境。

首次发布前需要登录：

```bash
npx wrangler login
```

想在不实际发布的情况下检查配置和打包结果，可以加 `--dry-run`：

```bash
npx wrangler deploy --dry-run --env staging
```

它会列出这个环境最终拥有的绑定，是检查环境配置最快的办法。

## 2.10 灰度发布与回滚

`wrangler deploy` 会让新版本立刻接管全部流量。想更稳妥一些，可以分两步：

```bash
npx wrangler versions upload
```

```bash
npx wrangler versions deploy
```

第一条命令只上传新版本，不接流量；第二条命令以交互方式指定新旧版本各占多少比例的流量。出了问题用下面的命令退回：

```bash
npx wrangler rollback
```

对有房间对象的游戏后端，灰度和回滚有几条必须知道的规则：

- **一个对象同一时刻只运行一个版本。** 每个对象在一次发布中被分配到某个版本，直到下一次发布才会变。所以灰度的粒度是"房间"，同一个房间里的玩家不会一半连到新代码、一半连到旧代码。
- **对象被分配的版本变化时，对象会被重置。** 内存里的状态丢失，连接断开。这再次说明状态必须落盘，客户端必须能重连。
- **改动对象声明的版本不能灰度。** 新增或删除对象类（也就是改了 `exports` 或 `migrations`）的版本不能用 `versions upload` 上传，只能用 `wrangler deploy` 一次性发布。
- **回滚不能跨过对象声明的变更。** 如果当前版本和目标版本之间改过对象类的声明，回滚会被拒绝。
- **回滚只换代码，不动数据。** 存储里的数据不会跟着回退。如果新版本写入了旧版本读不懂的数据，回滚之后旧代码会出错。

最后一条的推论是：**存储里的数据结构要向前兼容。** 新增字段时让旧代码能忽略它，改字段含义时分两次发布。第 3 章会给出具体的做法。

回滚的范围也有上限：只能回到最近的 100 个版本之内。

## 2.11 持续集成

示例工作流在 `examples/ci/github-actions.yml`，使用时复制到仓库根目录的 `.github/workflows/` 下。它有三个任务：

| 任务 | 触发条件 | 做什么 |
|---|---|---|
| test | 每次推送和每个合并请求 | 安装依赖、类型检查、运行两层测试 |
| deploy-staging | 推送到 main，且测试通过 | 发布到预发环境 |
| deploy-production | 手动触发，且测试通过 | 发布到正式环境 |

发布步骤用的是 Cloudflare 官方的 Action：

```yaml
- uses: cloudflare/wrangler-action@v4
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    workingDirectory: examples/server
    command: deploy --env staging
```

需要在 GitHub 仓库的设置里添加两个密钥：`CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。令牌在 Cloudflare 控制台创建，使用 "Edit Cloudflare Workers" 模板，并把范围限定在要发布的那个账号上。

正式环境设为手动触发，是第 1 章那条约定的落实：线上发布由人来决定，AI 助手和自动化流程最多发到预发环境。

## 2.12 写给 AI 助手的约定文件

`examples/AGENTS.md` 是写给 AI 编程助手看的。它把本章的约定浓缩成助手每次开工都会读到的规则，摘录几条：

```markdown
- shared/：规则必须是纯函数，不能出现任何平台接口、时间和随机数。
- 交付前运行 npm run typecheck 和 npm test，两者都通过才算完成。
- 新增绑定时，env.staging 里要同步声明，绑定不会被环境继承。
- 不要运行 wrangler deploy、wrangler rollback 或任何会改动线上环境的命令。
- 不要在房间对象里使用 setInterval 或自己实现心跳，这会让对象无法休眠。
```

文件最后要求助手在每次改动后回答三个问题：改了哪些文件，消息频率有没有变化，房间对象还能不能休眠。后两个问题对应第 1 章的结论：这个平台上最贵的错误不会报错，只会出现在账单上。

不同的助手读取的文件名不一样，有的认 `AGENTS.md`，有的认 `CLAUDE.md`，按你用的工具改名即可。后面每一章引入新的约定时，都会回来更新这个文件。

## 本章小结

- 项目分成 `shared` 和 `server`。规则是纯函数，放在 `shared`，与平台无关；`server` 只做连接、调用规则、保存和广播。
- `wrangler.jsonc` 是整个系统的清单，`wrangler types` 根据它生成类型，让配置和代码在编译时就对得上。
- 房间对象用 `acceptWebSocket` 托管连接，玩家身份放在连接的附加数据上，状态每次从存储读。这三点都是为了让对象能安全地休眠。
- 测试分两层：规则测试求全，服务端测试只验证接线。
- 绑定和变量不会被环境继承，每个环境都要重新声明。
- 灰度的粒度是房间；改动对象声明的版本不能灰度，也不能被回滚跨过；回滚只换代码不动数据。

下一章讲存储：玩家数据、房间数据、全局数据分别该放在哪里。
