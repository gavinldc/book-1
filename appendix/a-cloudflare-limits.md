# 附录 A　Cloudflare 各产品限额速查表

> 最后核实日期：2026-11-20。数字取自官方文档，会随时间变化，做预算和容量规划前请以官方文档为准。

## Workers

| 项目 | 免费版 | 付费版 |
|---|---|---|
| 月费 | 无 | 每账号 5 美元起 |
| 请求数 | 每天 10 万次 | 每月含 1,000 万次，超出每百万次 0.30 美元 |
| CPU 时间 | 单次请求 10 毫秒 | 每月含 3,000 万毫秒，超出每百万毫秒 0.02 美元 |
| 单次请求 CPU 上限 | 10 毫秒 | 默认 30 秒，最高可调到 5 分钟 |
| 内存 | 128 MB | 128 MB |
| 单次调用的子请求数 | 50 | 10,000 |
| 同时发起的出站连接 | 6 | 6 |
| 脚本大小（未压缩） | 64 MiB | 64 MiB |
| 流量（出口带宽） | 不收费 | 不收费 |

文档：[定价](https://developers.cloudflare.com/workers/platform/pricing/)、[限额](https://developers.cloudflare.com/workers/platform/limits/)

## Durable Objects

| 项目 | 免费版 | 付费版 |
|---|---|---|
| 可用的存储后端 | 仅 SQLite | SQLite；旧的键值后端仅付费版可用 |
| 请求数 | 每天 10 万次 | 每月含 100 万次，超出每百万次 0.15 美元 |
| 时长 | 每天 13,000 GB·秒 | 每月含 40 万 GB·秒，超出每百万 GB·秒 12.50 美元 |
| 读取行数 | 每天 500 万行 | 每月含 250 亿行，超出每百万行 0.001 美元 |
| 写入行数 | 每天 10 万行 | 每月含 5,000 万行，超出每百万行 1.00 美元 |
| 存储容量 | 账号合计 5 GB | 含 5 GB，超出每 GB 每月 0.20 美元 |
| 单个对象存储上限 | 见下方说明 | 10 GB |
| 每账号的类数量 | 100 | 500 |

计费与行为规则：

- 请求数包含 HTTP 请求、RPC 会话、WebSocket 消息和定时器触发。
- WebSocket 建立连接算 1 次请求；收到的消息按 20 条折算 1 次请求；发出的消息不计费。
- 对象休眠期间不计时长费用。
- 只有对象作为 WebSocket 服务端时才支持休眠；对象主动向外建立的 WebSocket 不会休眠。
- 未完成的输入输出操作会让对象最长在内存中保留 15 分钟。
- 单个对象的软限制为每秒约 1,000 个请求。
- 单条收到的 WebSocket 消息上限为 32 MiB。
- SQLite 单行、单个字符串或二进制字段上限为 8 MB；单条语句的绑定参数上限为 100 个。
- 每个 WebSocket 连接可附带的序列化数据上限为 16,384 字节。

说明：免费版单个对象的存储上限，官方限额页自身的表述不一致（表格写账号合计 5 GB，常见问题里写单个对象 1 GB），使用前请再确认。

文档：[定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[限额](https://developers.cloudflare.com/durable-objects/platform/limits/)、[WebSocket 最佳实践](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

## D1

| 项目 | 免费版 | 付费版 |
|---|---|---|
| 单库大小 | 500 MB | 10 GB |
| 账号总存储 | 5 GB | 1 TB |
| 数据库数量 | 10 | 含 10 万个，上限 100 万个 |
| 读取行数 | 每天 500 万行 | 每月含 250 亿行，超出每百万行 0.001 美元 |
| 写入行数 | 每天 10 万行 | 每月含 5,000 万行，超出每百万行 1.00 美元 |
| 存储价格 | 合计 5 GB | 含 5 GB，超出每 GB 每月 0.75 美元 |
| 单次调用的查询数 | 50 | 1,000 |
| 单条查询最长执行时间 | 30 秒 | 30 秒 |
| 单条语句的绑定参数 | 100 | 100 |
| 单行、字符串或二进制字段大小 | 2 MB | 2 MB |
| 查询结果大小 | 50 MB | 50 MB |

注意 D1 的存储单价（每 GB 每月 0.75 美元）高于 DO 自带 SQLite 的存储单价（0.20 美元）。

文档：[定价](https://developers.cloudflare.com/d1/platform/pricing/)、[限额](https://developers.cloudflare.com/d1/platform/limits/)

## 网络协议

- Workers 支持出站 TCP 连接；入站 TCP 处于公开测试阶段。
- 套接字接口文档未提及 UDP。

文档：[TCP 套接字](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)

## 扩展相关

核实日期：2026-11-24。

- D1 单库 10 GB 的上限不能申请提高。官方的设计思路是横向扩展为多个较小的数据库，例如按用户、按租户或按实体分库。
- 单个 DO 的请求超过软限制后，会先排队，再返回过载错误。同一个命名空间下的对象数量不设上限。
- 单个 DO 最多托管 32,768 个 WebSocket 连接，每个连接最多 10 个标签。
- DO 空闲且可休眠满 10 秒后进入休眠；空闲但不可休眠满 70 到 140 秒后被移出内存。只有活跃和"空闲但不可休眠"两种状态计时长费用。
- 对外的网络请求、RPC 调用和对外连接，每个最长让对象保持 15 分钟不被移出内存。
- Worker 的顶层代码必须在 1 秒内解析并执行完，超出时发布会被拒绝（错误码 10021）。
- 按名字首次访问一个对象时，全球唯一性检查最多需要几百毫秒；用 `newUniqueId` 创建的对象可以跳过。
- 获取对象引用时可设置重试，默认最多 4 次，超时默认 10 秒。
- 使用休眠接口托管的连接，在对象休眠后换用新代码时保持连接；正在运行的对象被强制更新时连接会断开。
- 位置提示中的南美、非洲、中东区域，对象会创建在邻近的受支持地点。
- 平台不提供对象关闭前的回调。重启时 WebSocket 连接会被断开，进行中的请求最多有 30 秒完成。
- DO 默认创建在离首次请求较近的数据中心，创建后不会迁移，官方表示未来计划支持。创建时可传入位置提示，仅首次调用生效，且是尽力而为。
- Hyperdrive 用于加速 Workers 访问已有的数据库，支持 Postgres 和 MySQL 及其兼容产品，免费版和付费版均可用。

文档：[D1 限额](https://developers.cloudflare.com/d1/platform/limits/)、[DO 限额](https://developers.cloudflare.com/durable-objects/platform/limits/)、[DO 数据位置](https://developers.cloudflare.com/durable-objects/reference/data-location/)、[Hyperdrive](https://developers.cloudflare.com/hyperdrive/)

## AI 相关产品

核实日期：2026-11-24。

| 项目 | 内容 |
|---|---|
| Workers AI 计费单位 | Neuron |
| Workers AI 免费额度 | 每天 1 万个 Neuron，免费版和付费版都有，每天 00:00（UTC）重置 |
| Workers AI 超出价格 | 付费版每 1,000 个 Neuron 0.011 美元；免费版用完即止 |
| Workers AI 调用方式 | 配置里声明 `ai` 绑定，代码里调用 `env.AI.run(模型, 输入)` |
| Workers AI 任务类型 | 文本生成、文本嵌入、多模态嵌入、文本分类、翻译、语音识别、语音合成、文生图、图生文、图像分类 |
| AI Gateway | 提供分析、日志、缓存、限流、重试、模型降级；可接 Workers AI、Anthropic、Google Gemini、OpenAI、Replicate 等；所有套餐可用，文档未说明各功能是否免费 |
| Agents SDK | 每个智能体是一个 Durable Object，具备状态、WebSocket、调度能力 |
| Vectorize | 全球分布的向量数据库；免费版是否可用，产品首页未说明 |
| 文档 MCP 服务 | 主服务 `https://mcp.cloudflare.com/mcp`（含文档搜索），文档服务 `https://docs.mcp.cloudflare.com/mcp` |

文档：[Workers AI 定价](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[AI 绑定](https://developers.cloudflare.com/workers-ai/configuration/bindings/)、[AI Gateway](https://developers.cloudflare.com/ai-gateway/)、[Agents](https://developers.cloudflare.com/agents/)、[Vectorize](https://developers.cloudflare.com/vectorize/)、[官方 MCP 服务列表](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/)

## KV

核实日期：2026-11-24。

| 项目 | 免费版 | 付费版 |
|---|---|---|
| 读取 | 每天 10 万次 | 每月含 1,000 万次，超出每百万次 0.50 美元 |
| 写入、删除、列举 | 各每天 1,000 次 | 各每月含 100 万次，超出每百万次 5.00 美元 |
| 存储 | 1 GB | 含 1 GB，超出每 GB 每月 0.50 美元 |
| 键长度 | 512 字节 | 512 字节 |
| 值大小 | 25 MiB | 25 MiB |
| 同一个键的写入频率 | 每秒 1 次 | 每秒 1 次 |

一致性：改动传播到其他节点可能需要 60 秒或更久；官方说明它不适合需要原子操作的场景。

文档：[限额](https://developers.cloudflare.com/kv/platform/limits/)、[定价](https://developers.cloudflare.com/kv/platform/pricing/)、[工作原理](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

## R2

核实日期：2026-11-24。以下为标准存储类别。

| 项目 | 免费额度 | 价格 |
|---|---|---|
| 存储 | 每月 10 GB | 每 GB 每月 0.015 美元 |
| A 类操作（写入、列举等） | 每月 100 万次 | 每百万次 4.50 美元 |
| B 类操作（读取等） | 每月 1,000 万次 | 每百万次 0.36 美元 |
| 删除 | 免费 | 免费 |
| 流量（出口带宽） | 不收费 | 不收费 |

单个对象最大 5 TiB，单次上传最大 5 GiB，更大的要分片上传。对象键最长 1,024 字节。同一个键每秒最多写入 1 次。

文档：[定价](https://developers.cloudflare.com/r2/pricing/)、[限额](https://developers.cloudflare.com/r2/platform/limits/)

## Queues

核实日期：2026-11-24。

| 项目 | 免费版 | 付费版 |
|---|---|---|
| 操作数 | 每天 1 万次 | 每月含 100 万次，超出每百万次 0.40 美元 |
| 消息保留时间 | 固定 24 小时 | 默认 4 天，最长可设 14 天 |

- 单条消息最大 128 KB。操作数按每 64 KB 一个单位计算，一条消息通常产生 3 次操作（写入、读取、删除）。
- 单次批量发送最多 100 条或合计 256 KB；消费者一批最多 100 条，最长等待 60 秒。
- 单条消息最多重试 100 次。
- 投递保证为至少一次。

文档：[限额](https://developers.cloudflare.com/queues/platform/limits/)、[定价](https://developers.cloudflare.com/queues/platform/pricing/)

## Hyperdrive

核实日期：2026-11-24。

| 项目 | 免费版 | 付费版 |
|---|---|---|
| 费用 | 包含在套餐内 | 包含在套餐内 |
| 每天查询数 | 10 万次 | 不限 |
| 每账号配置数 | 10 | 25 |
| 到数据库的最大连接数（每个配置） | 约 20 | 约 100 |
| 单条语句最长执行时间 | 60 秒 | 60 秒 |
| 首次连接超时 | 15 秒 | 15 秒 |
| 空闲连接超时 | 10 分钟 | 10 分钟 |
| 可缓存的最大响应 | 50 MB | 50 MB |

- 支持 PostgreSQL 9.0 到 18.x、MySQL 5.7 到 8.x（含 MariaDB），不支持 SQL Server 和 MongoDB。
- 连接池为事务模式，每个配置最少 5 条连接，上限可调整。
- 查询缓存默认开启，`max_age` 默认 60 秒（最长 1 小时），`stale_while_revalidate` 默认 15 秒。写入不会使缓存失效。
- 驱动最低版本：`pg` 8.16.3、`postgres` 3.4.5、`mysql2` 3.13.0。兼容日期在 2026-08-04 及之后的项目默认开启 Node.js 兼容。
- 本地模式的连接串：配置项 `localConnectionString`，或环境变量 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<绑定名>`，后者优先。
- Placement 的智能模式在部署后最长需要 15 分钟分析；只影响 `fetch` 处理函数。

文档：[工作原理](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)、[连接池](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)、[查询缓存](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)、[本地开发](https://developers.cloudflare.com/hyperdrive/configuration/local-development/)、[私有数据库](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/)、[限额](https://developers.cloudflare.com/hyperdrive/platform/limits/)、[Placement](https://developers.cloudflare.com/workers/configuration/placement/)

## 存储接口与恢复

核实日期：2026-11-24。

- DO 的异步键值接口 `put` 一次最多写入 128 个键值对。
- DO 的 SQLite 不支持 `PRAGMA user_version`，也不允许在 `exec` 中执行 `BEGIN TRANSACTION` 或 `SAVEPOINT`。
- DO 的每个对象同一时刻只能有一个定时器。定时器保证至少执行一次，失败后从 2 秒开始指数退避，最多重试 6 次。
- DO 按时间点恢复覆盖过去 30 天。
- D1 的时间旅行覆盖过去 30 天（付费版）或 7 天（免费版）。
- 每个 D1 数据库是单线程的，一次处理一条查询。

文档：[DO 的 SQLite 存储接口](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[DO 定时器](https://developers.cloudflare.com/durable-objects/api/alarms/)、[DO 使用规则](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)、[D1 时间旅行](https://developers.cloudflare.com/d1/reference/time-travel/)

## 限流绑定与密钥

核实日期：2026-11-24。

- 限流绑定的周期只能是 10 秒或 60 秒，需要 wrangler 4.36.0 或更高版本。
- 限流是近似的，计数最终一致，实际放行的请求数可能超过设定值。
- 限流按 Cloudflare 节点各自计数，不会合并成全球上限。
- `namespace_id` 相同的绑定在同一账号内共用计数，跨 Worker 也是如此。
- 配置里声明 `secrets.required` 后：缺少密钥时发布失败；类型由它生成，不再从 `.dev.vars` 推断；本地只加载列出的名字。
- `.dev.vars` 和 `.env` 二选一，前者存在时后者不会被加载。
- `wrangler secret put` 会立即创建并发布一个新版本；灰度发布时用 `wrangler versions secret put`。
- `crypto.subtle.timingSafeEqual` 是 Workers 对 Web Crypto 的非标准扩展。

文档：[限流绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[密钥](https://developers.cloudflare.com/workers/configuration/secrets/)、[配置文件的 secrets 属性](https://developers.cloudflare.com/workers/wrangler/configuration/#secrets-configuration-property)、[Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[Telegram 小程序数据校验](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)

## 房间与连接

核实日期：2026-11-24。

- 每条托管的 WebSocket 最多 10 个标签，每个标签最长 256 个字符。
- 连接的附加数据序列化后最大 16,384 字节；连接关闭后附加数据丢失。
- 收到的 WebSocket 消息单条上限 32 MiB。
- 协议层的 ping 帧由运行时自动应答，不唤醒对象，也不计费。
- 兼容日期在 2026-04-07 及之后，运行时自动完成关闭握手（`web_socket_auto_reply_to_close`）。
- 兼容日期在 2026-02-24 及之后，`deleteAll()` 会同时删除定时器；更早的需要单独调用 `deleteAlarm()`。
- SQLite 存储的 `deleteAll()` 是原子的。
- `getAlarm()` 在定时器处理函数运行期间返回 `null`，除非处理函数里又调用过 `setAlarm()`。
- 每次收到 HTTP 请求或 WebSocket 消息，对象可用的 CPU 时间重置为 30 秒（可通过 `limits.cpu_ms` 调到 5 分钟）。
- 官方建议把多条逻辑消息合并成一帧发送，高频数据按 50 到 100 毫秒或 50 到 100 条合并一次。

文档：[在 DO 里使用 WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[DO 的 State 接口](https://developers.cloudflare.com/durable-objects/api/state/)、[DO 限额](https://developers.cloudflare.com/durable-objects/platform/limits/)、[DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## 匹配、位置提示与对局记录

核实日期：2026-11-24。

- `newUniqueId()` 生成的 ID 首次访问时不需要做全球范围的重名检查，比按名字首次访问更快。
- 位置提示的取值：`wnam`、`enam`、`sam`、`weur`、`eeur`、`apac`、`apac-ne`、`apac-se`、`oc`、`afr`、`me`。只在对象第一次被访问时生效，是尽力而为。
- 提示 `sam`、`afr`、`me` 时，对象目前会创建在邻近的受支持地点（官方举例：南美会落在北美东部）。
- 官方建议亚太一般用 `apac`，玩家明确集中在东北亚或东南亚时才用 `apac-ne`、`apac-se`。
- 对象创建后不会迁移，官方表示未来计划支持。
- 队列：单条消息 128 KB；消费者一批最多 100 条，批量等待最长 60 秒；消息最多重试 100 次；单个队列每秒 5,000 条；消费者单次调用最长 15 分钟；并发消费者最多 250 个。
- 队列的消息保留时间：免费版 24 小时，不可调；付费版默认 4 天，最长 14 天。
- 队列计费：每 64 KB 算一次操作，一条消息通常是写入、读取、删除 3 次；免费版每天 1 万次，付费版每月含 100 万次，超出每百万次 0.40 美元。每次重试多算一次读取。
- 没有配置死信队列时，重试次数用完的消息会被丢弃。
- D1：单库 10 GB（免费版 500 MB）；单条语句最长 100 KB；每条查询最多绑定 100 个参数；单行最大 2 MB；查询最长 30 秒；付费版每次调用最多 1,000 条查询（免费版 50）。
- `wrangler deploy` 可以自动创建没有填资源 ID 的 KV、R2、D1、队列等资源，并把 ID 写回配置文件；自动创建的 D1 是空库，表结构要另外执行迁移。
- 测试：`readD1Migrations()` 从 `@cloudflare/vitest-plugin` 导入，在配置文件里读取迁移；`applyD1Migrations()`、`createMessageBatch()`、`getQueueResult()`、`runDurableObjectAlarm()` 从 `cloudflare:test` 导入。

文档：[数据位置](https://developers.cloudflare.com/durable-objects/reference/data-location/)、[命名空间接口](https://developers.cloudflare.com/durable-objects/api/namespace/)、[队列限额](https://developers.cloudflare.com/queues/platform/limits/)、[队列定价](https://developers.cloudflare.com/queues/platform/pricing/)、[批量与重试](https://developers.cloudflare.com/queues/configuration/batching-retries/)、[D1 限额](https://developers.cloudflare.com/d1/platform/limits/)、[配置文件](https://developers.cloudflare.com/workers/wrangler/configuration/)、[测试接口](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)

## 排行榜与社交

核实日期：2026-11-24。

- D1 计费：读取每月含 250 亿行，超出每百万行 0.001 美元；写入每月含 5,000 万行，超出每百万行 1.00 美元；存储含 5 GB，超出每 GB 每月 0.75 美元。免费版每天读 500 万行、写 10 万行。
- D1 每条查询最多绑定 100 个参数。
- D1 的读副本要通过会话接口（`withSession`）使用，否则所有查询都只在主库执行。
- 缓存接口（`caches.default`）的内容不跨数据中心；官方说明部署在自定义域名上的 Worker 才有可用的缓存操作；`cache.delete` 只清除当前数据中心的内容。
- KV 的键最短过期时间是 60 秒；写入在其他地点最长 60 秒后可见。
- 按名字访问的对象可以从 `ctx.id.name` 读到自己的名字；通过 `idFromString()` 访问、用 `newUniqueId()` 创建、或者名字超过 1,024 字节时，这个值是 `undefined`。
- 队列的消费者可以对单条消息调用 `ack()` 或 `retry({ delaySeconds })`；对同一条消息先调用的那个生效。
- Telegram 小程序的直达链接可以带 `startapp` 参数，它会出现在 `initData` 的 `start_param` 字段里。

文档：[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 限额](https://developers.cloudflare.com/d1/platform/limits/)、[D1 读副本](https://developers.cloudflare.com/d1/best-practices/read-replication/)、[缓存接口](https://developers.cloudflare.com/workers/runtime-apis/cache/)、[KV 写入](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)、[对象 ID](https://developers.cloudflare.com/durable-objects/api/id/)、[队列的 JavaScript 接口](https://developers.cloudflare.com/queues/configuration/javascript-apis/)、[Telegram 小程序](https://core.telegram.org/bots/webapps)

## 运营：KV、定时触发器与 Access

核实日期：2026-11-24。

- KV：写入在其他地点可能要 60 秒或更久才可见；同一个键每秒最多写 1 次；键最长 512 字节，值最大 25 MiB；每次 Worker 调用最多 1,000 次操作。
- KV：读取的 `cacheTtl` 最小 30 秒，默认 60 秒；键的过期时间最短 60 秒。
- KV 计费（付费版）：每月含 1,000 万次读、100 万次写，超出每百万次读 0.50 美元、写 5.00 美元；存储含 1 GB。免费版每天 10 万次读、1,000 次写。
- 定时触发器按 UTC 执行；新增、修改、删除后最长 15 分钟才传播到全网，期间到点的调用可能被错过。
- 定时触发器数量：免费版每个账号 5 个，付费版 1,000 个。
- 定时任务单次调用最长 15 分钟；间隔小于 1 小时的任务 CPU 时间默认 30 秒、最多 5 分钟，间隔 1 小时及以上最多 15 分钟。
- Access：令牌在 `Cf-Access-Jwt-Assertion` 请求头里，算法 RS256；公钥地址 `https://<团队名>.cloudflareaccess.com/cdn-cgi/access/certs`，要按令牌的 `kid` 匹配。
- Access：签名密钥默认每 6 周轮换，旧密钥在轮换后 7 天内仍然有效；除签名外还要核对 `iss`、`aud`、`exp`、`nbf`。
- 测试：`createScheduledController()`、`createExecutionContext()`、`waitOnExecutionContext()` 从 `cloudflare:test` 导入。

文档：[KV 的工作方式](https://developers.cloudflare.com/kv/concepts/how-kv-works/)、[KV 限额](https://developers.cloudflare.com/kv/platform/limits/)、[KV 定价](https://developers.cloudflare.com/kv/platform/pricing/)、[定时触发器](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)、[校验 Access 令牌](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

## 日志、指标与追踪

核实日期：2026-11-25。

- Workers Logs：保留 7 天（免费版 3 天）；单条日志最大 256 KB；每个账号每天 50 亿条，超出后当天剩余时间按 1% 采样。
- Workers Logs 计费：付费版每月含 2,000 万条，超出每百万条 0.60 美元；免费版每天 20 万条。官方注明自 2026 年 12 月 1 日起改用统一的可观测计价，届时需重新核对。
- `head_sampling_rate` 取 0 到 1，按请求采样；被采样掉的日志不会触发基于日志的告警。
- 日志推荐用对象（JSON）形式输出，字段会被自动提取并建立索引。
- 监控规则（Monitors）：定期执行一条 SQL 查询并判断结果，有阈值、异常检测、SLO 三种方式；阈值支持 `<`、`>`、`<=`、`>=`、`==`、`!=`。
- 监控规则可查的数据集包括 Workers 日志（`logs.workersLogs`）、Analytics Engine（`events.analyticsEngine.<数据集名>`）和平台自己的数据集；可用的数据集取决于套餐和权限。
- 监控规则最快每分钟执行一次（Log Explorer 的数据集最快 10 分钟）；重复通知的间隔 1 分钟到 168 小时，默认 1 小时；查询没有返回行时不产生信号。
- 自定义 SQL 要返回一个名为 `value` 的数值，只读一个数据集，带账号或域名的过滤条件。
- 通知目的地：邮件最多 20 个收件人；Webhook 所有套餐可用；PagerDuty 需要 Business 及以上。
- 异常检测的基线窗口至少是评估窗口的 6 倍，最长 24 小时。
- 平台现成的通知里有按用量触发的账单通知，适用于按量付费的账号，Professional 及以上套餐。
- Analytics Engine：每次 `writeDataPoint` 最多 20 个 blob、20 个 double、1 个 index；全部 blob 合计不超过 16 KB；index 不超过 96 字节；每次 Worker 调用最多写 250 个数据点；数据保留 3 个月。
- Analytics Engine 计费：付费版每月含 1,000 万个数据点（超出每百万 0.25 美元）和 100 万次查询（超出每百万 1.00 美元）；免费版每天 10 万个数据点、1 万次查询。
- Analytics Engine 会自动采样，查询时要用 `_sample_interval` 加权：计数写成 `SUM(_sample_interval)`。
- 追踪：在配置里设 `observability.traces.enabled` 打开，自动记录 `fetch`、RPC、存储等调用，不需要改代码。
- Tail Worker 仅付费版和企业版可用，按 CPU 时间计费；只是把日志发给外部工具时，官方建议用 OpenTelemetry 导出。
- `wrangler tail`：一个 Worker 同时最多 10 个查看者；流量大时进入采样模式。
- Durable Object 的日志和所属 Worker 的在一起，可按对象的类查看。

文档：[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、[实时日志](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)、[Analytics Engine 入门](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)、[Analytics Engine 限额](https://developers.cloudflare.com/analytics/analytics-engine/limits/)、[Analytics Engine 定价](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)、[监控规则](https://developers.cloudflare.com/notifications/monitors/)、[可用的通知类型](https://developers.cloudflare.com/notifications/notification-available/)、[SQL 接口的数据集](https://developers.cloudflare.com/analytics/sql-api/datasets/)、[日志查询界面](https://developers.cloudflare.com/workers/observability/query-builder/)、[追踪](https://developers.cloudflare.com/workers/observability/traces/)、[Tail Worker](https://developers.cloudflare.com/workers/observability/logs/tail-workers/)、[对象的指标](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)

## 安全：限流规则、人机验证与数据辖区

核实日期：2026-11-25。

- 防火墙的限流规则：免费版 1 条，Pro 2 条，Business 5 条，企业版 100 条。免费版和 Pro 只能按来源地址计数；免费版的计数周期和拦截时长都固定为 10 秒，Pro 的计数周期最长 1 分钟、拦截最长 1 小时。
- 限流规则的计数有几秒的延迟，不保证精确放行某个数量的请求。
- Bot Fight Mode 免费；要为特定流量（比如自己的 API 客户端）开例外，需要 Super Bot Fight Mode。
- Turnstile：令牌有效期 300 秒，只能使用一次，最长 2,048 个字符；必须在服务端调用 `https://challenges.cloudflare.com/turnstile/v0/siteverify` 核实；可带 `remoteip` 和 `idempotency_key`。
- Turnstile 的测试密钥：`1x0000000000000000000000000000000AA` 对任何令牌返回通过，`2x0000000000000000000000000000000AA` 一律返回不通过。
- 辖区目前支持 `eu` 和 `fedramp`。Durable Object 用 `namespace.jurisdiction("eu")`；同一个名字在不同辖区里是不同的对象；对象的 ID 会出于计费和调试被记录在辖区之外。
- D1 的辖区只能在创建数据库时指定，之后不能添加或修改；同时给了辖区和位置提示时，辖区优先。R2 的存储桶同样在创建时指定。
- 辖区只限制数据存放和对象运行的位置，Worker 仍然可以从任何地方访问这些资源。
- D1 的时间点恢复保留 30 天（免费版 7 天）。

文档：[限流规则](https://developers.cloudflare.com/waf/rate-limiting-rules/)、[Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)、[Turnstile 服务端校验](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)、[Turnstile 测试密钥](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)、[对象的数据位置](https://developers.cloudflare.com/durable-objects/reference/data-location/)、[D1 的数据位置](https://developers.cloudflare.com/d1/configuration/data-location/)、[R2 的数据位置](https://developers.cloudflare.com/r2/reference/data-location/)

## 计费细则与支出上限

核实日期：2026-11-25。第 12 章的成本模型用到这些规则。

- 每个计费项超出包含额度的部分，按计费单位向上取整后计费（官方举例：超出 50 万 GB·秒按 100 万 GB·秒计）。
- Durable Object 在执行代码时计时长；空闲但不满足休眠条件时也计；空闲且可以休眠的不计，包括被真正休眠之前的那一小段时间。
- 时长按分配的 128 MB 内存计，与实际占用无关。
- 用键值接口读写 SQLite 后端的对象，按读取和写入的行数计费；每次 `setAlarm()` 计为写入一行；删除计为写入。
- 用 `setWebSocketAutoResponse()` 自动应答的消息不产生时长费用。
- 空的 SQLite 数据库约占 12 KB 存储。
- Durable Object 可以设支出上限，对整个账号生效。达到后新的对象请求、SQL 读写、存储增长和新的定时器被拒绝；已经打开的 WebSocket 连接上的消息不受影响；已有的存储继续计费。
- 支出上限期间待触发的定时器被挂起，安排时间超过七天的会被删除；用量上报和执行有延迟，上限不保证账单不超过该数额。

文档：[对象的定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[对象的支出管理](https://developers.cloudflare.com/durable-objects/platform/spend-management/)

## 第三方：支付与广告平台

核实日期：2026-11-24。这一节不是 Cloudflare 的限额，是第 8 章用到的外部平台的规则。

- Telegram：数字商品必须用 Stars 结算，币种代码 `XTR`，`provider_token` 传空字符串。
- Telegram：`createInvoiceLink` 的 `payload` 为 1 到 128 字节，`title` 1 到 32 个字符，`description` 1 到 255 个字符。
- Telegram：付款前的确认（`pre_checkout_query`）必须在 10 秒内答复；只有收到 `successful_payment` 才能发货。
- Telegram：回调密钥（`secret_token`）1 到 256 个字符，只能用字母、数字、下划线和连字符，请求头是 `X-Telegram-Bot-Api-Secret-Token`。
- Telegram：回调返回非 2xx 时会重发，尝试若干次后放弃；可以在回调的应答正文里直接调用一个 Bot API 方法，但无法得知调用结果。
- Telegram：退款用 `refundStarPayment`，需要 `telegram_payment_charge_id`；`getStarTransactions` 里的交易编号和它一致；机器人必须响应 `/paysupport`。
- Stripe：签名在 `Stripe-Signature` 请求头里，格式 `t=时间戳,v1=签名`，签名是对 `时间戳.请求体原文` 做的 HMAC-SHA256；官方库默认允许 5 分钟的时间差；轮换密钥期间可能有多个 `v1`。
- Stripe：正式环境投递失败最长重试三天；同一事件可能重复投递；不保证事件的顺序。
- Stripe：幂等键最长 255 个字符，至少保留 24 小时；v1 接口所有 POST 请求都接受。
- Stripe：附加数据不会自动复制到关联对象；例外之一是付款意向的附加数据在创建扣款记录时复制过去（一次性快照）；结账会话可以用 `payment_intent_data.metadata` 给付款意向设置附加数据。
- AdMob：服务端校验回调是 GET 请求，最后两个参数依次是 `signature` 和 `key_id`，被签名的内容是它们之前的查询串；签名是 ECDSA（SHA-256，DER 编码）；公钥地址 `https://www.gstatic.com/admob/reward/verifier-keys.json`，缓存不应超过 24 小时，公钥会定期轮换。

文档：[Telegram Bot API](https://core.telegram.org/bots/api)、[Telegram Stars 支付](https://core.telegram.org/bots/payments-stars)、[Stripe 回调](https://docs.stripe.com/webhooks)、[Stripe 幂等请求](https://docs.stripe.com/api/idempotent_requests)、[Stripe 附加数据](https://docs.stripe.com/metadata)、[AdMob 服务端校验](https://developers.google.com/admob/android/ssv)

## 第三方：Google Analytics 衡量协议

核实日期：2026-11-25。第 10 章用它从服务端向 Firebase 的数据流补报付款事件。

- 地址 `https://www.google-analytics.com/mp/collect`，必须带 `api_secret`。网页数据流用 `measurement_id` 加请求体里的 `client_id`；应用数据流用 `firebase_app_id` 加 `app_instance_id`，两者不是同一种标识。
- 官方定位：用来补充 gtag、Tag Manager、Firebase SDK 的自动采集，不是替代。
- 每次请求最多 25 个事件；请求体小于 130 KB；事件名和参数名不超过 40 个字符；标准媒体资源的参数值不超过 100 个字符。
- `timestamp_micros` 可以把事件标到过去，最多 72 小时。
- 只要收到请求就返回 2xx，内容不合法或没有被处理也不会返回错误；非 2xx 时不要重试同一个请求。接入时用校验地址（`/debug/mp/collect`）检查请求。
- `api_secret` 是私密的，不能出现在客户端代码里。

文档：[衡量协议概览](https://developers.google.com/analytics/devguides/collection/protocol/ga4)、[发送事件](https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events)、[协议参考](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference)、[校验事件](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events)

## 第三方：Ably

核实日期：2026-11-24。这一节不是 Cloudflare 的限额，放在这里是因为 5.11 节把它作为全局广播的备选方案。

- 按月活跃用户数计费，以 `clientId` 区分用户；免费版每月 500 个月活。
- Pro 年付价：1,000 月活每月 29 美元，10,000 月活 249 美元，50,000 月活 1,149 美元；超出部分每个月活 0.05 美元。
- 直接调用 REST 接口的服务端请求要带 `clientType=server`，否则按用户计数。
- 付费套餐：并发连接 100,000；每个 `clientId` 并发连接 10；每个频道每秒发布 100 条；每条连接每秒收发各 100 条；每条连接最多加入 200 个频道。
- 单条消息上限：免费版 64 KiB，付费版 256 KiB。
- 在线状态成员每个频道 200，开启服务端批处理后付费版 10,000。
- 令牌最长 24 小时；开启令牌吊销的密钥签出的令牌最长 1 小时。
- JWT 用 HS256 签名，`kid` 填密钥名，必须带 `x-ably-capability`，`x-ably-clientId` 可选。

文档：[定价概览](https://ably.com/docs/platform/pricing)、[限额](https://ably.com/docs/platform/pricing/limits)、[令牌认证](https://ably.com/docs/auth/token)、[JWT](https://ably.com/docs/auth/token/jwt)、[权限](https://ably.com/docs/auth/capabilities)、[REST 接口](https://ably.com/docs/api/rest-api)
