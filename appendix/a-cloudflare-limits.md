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
