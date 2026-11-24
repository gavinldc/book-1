# 示例项目

贯穿全书的示例游戏后端。目前是第 5 章结束时的状态：一个 2 到 4 人的掷骰子竞速房间，支持断线重连、回合超时和弃权，对局结束后给每个玩家结算金币和战绩，然后自动清理；玩家以游客或 Telegram 身份登录，凭访问令牌进入房间。

## 结构

- `shared/`：前后端共享的协议类型和游戏规则（纯函数）
- `server/`：Worker 入口、鉴权（`src/auth/`），以及房间、玩家、身份三种对象（Durable Object）
- `client/`：仅用于联调的最小页面，书中不讲解
- `ci/`：GitHub Actions 工作流示例
- `AGENTS.md`：写给 AI 编程助手的约定

## 运行

以下命令在 Node.js 24 上验证过。

```bash
npm install
npm test
cp server/.dev.vars.example server/.dev.vars
npm run dev
```

测试不需要 `.dev.vars`，本地开发服务器需要。启动后打开终端里显示的本地地址，开两个浏览器窗口（其中一个用无痕模式，这样是两个不同的游客账号），用同一个房间号连接。

## 已验证的版本

| 工具 | 版本 |
|---|---|
| Node.js | 24.15.0 |
| wrangler | 4.167.0 |
| vitest | 4.1.12 |
| @cloudflare/vitest-plugin | 1.9.1 |
| TypeScript | 5.9.3 |
