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
- 单个 DO 可同时保持的 WebSocket 连接数，文档没有给出确切上限，只说明可以连接数千个客户端。
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

## 尚未整理

KV、R2、Queues 的限额将在写到对应章节时补充。
