# 示例项目

贯穿全书的示例游戏后端。目前是第 2 章结束时的状态：一个 2 到 4 人的掷骰子竞速房间。

## 结构

- `shared/`：前后端共享的协议类型和游戏规则（纯函数）
- `server/`：Worker 入口与房间对象（Durable Object）
- `client/`：仅用于联调的最小页面，书中不讲解
- `ci/`：GitHub Actions 工作流示例
- `AGENTS.md`：写给 AI 编程助手的约定

## 运行

以下命令在 Node.js 24 上验证过。

```bash
npm install
npm test
npm run dev
```

启动后打开终端里显示的本地地址，开两个浏览器窗口，用同一个房间号、不同的玩家 ID 连接。

## 已验证的版本

| 工具 | 版本 |
|---|---|
| Node.js | 24.15.0 |
| wrangler | 4.167.0 |
| vitest | 4.1.12 |
| @cloudflare/vitest-plugin | 1.9.1 |
| TypeScript | 5.9.3 |
