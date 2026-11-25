import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // 在 Node.js 这一侧读出 D1 的迁移文件，通过一个只在测试里存在的绑定传进去。
      const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // 测试用的密钥直接写在这里，不依赖本机的 .dev.vars，CI 上也能跑。
            SESSION_SECRET: "test-only-session-secret",
            TELEGRAM_BOT_TOKEN: "123456:test-only-bot-token",
            TELEGRAM_WEBHOOK_SECRET: "test-only-telegram-webhook-secret",
            STRIPE_SECRET_KEY: "sk_test_only",
            STRIPE_WEBHOOK_SECRET: "whsec_test_only",
            // 管理后台的测试用一个假的 Access 应用。
            ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // 经过队列的变化要等一两秒才能看到，轮询的默认时限（1 秒）不够。
    expect: { poll: { timeout: 5_000 } },
  },
});
