# 示例项目

贯穿全书的示例游戏后端。目前是第 5 章结束时的状态：一个 2 到 4 人的掷骰子竞速房间，支持断线重连、回合超时和弃权，对局结束后给每个玩家结算金币和战绩，然后自动清理；玩家以游客或 Telegram 身份登录，凭访问令牌进入房间。

## 结构

- `shared/`：前后端共享的协议类型和游戏规则（纯函数）
- `server/`：Worker 入口、鉴权（`src/auth/`）、匹配与对局记录（`src/match/`）、排行榜与好友邀请（`src/social/`）、钱包商店与支付回调（`src/economy/`）、在线配置、管理后台与定时任务（`src/ops/`）、日志、指标与付款事件的补报（`src/obs/`）、限流、人机验证、名录、重放与账号删除（`src/security/`），以及房间、玩家、身份、匹配四种对象（Durable Object）；`migrations/` 是 D1 的表结构
- `client/`：仅用于联调的最小页面，书中不讲解
- `loadtest/`：压测脚本，模拟一批玩家走完登录、排队、对局的完整流程（第 12 章）
- `tools/`：成本模型脚本，按每一局实际发生的操作估算月度费用（第 12 章）
- `ci/`：GitHub Actions 工作流示例
- `AGENTS.md`：写给 AI 编程助手的约定

## 运行

以下命令在 Node.js 24 上验证过。

```bash
npm install
npm test
cp server/.dev.vars.example server/.dev.vars
npm run db:local -w server
npm run dev
```

测试不需要 `.dev.vars`，也不需要先建表；本地开发服务器两样都需要。`db:local` 在本地的 D1 上执行 `server/migrations/` 里的建表语句，只需要在第一次运行和表结构变化之后执行。

启动后打开终端里显示的本地地址，开两个浏览器窗口（其中一个用无痕模式，这样是两个不同的游客账号）。两边都点"排位匹配"会配到同一个房间；只开一个窗口时，等大约 10 秒会配到机器人。"镜像对战"的对手是录像池里别的玩家的录像，池子是空的时候会退回到机器人。

第一次发布到线上之前，同样要在线上的库里建表：`npx wrangler d1 migrations apply DB --remote`。

## 已验证的版本

| 工具 | 版本 |
|---|---|
| Node.js | 24.15.0 |
| wrangler | 4.167.0 |
| vitest | 4.1.12 |
| @cloudflare/vitest-plugin | 1.9.1 |
| TypeScript | 5.9.3 |
