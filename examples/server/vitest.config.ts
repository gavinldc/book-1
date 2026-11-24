import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // 测试用的密钥直接写在这里，不依赖本机的 .dev.vars，CI 上也能跑。
      miniflare: {
        bindings: {
          SESSION_SECRET: "test-only-session-secret",
          TELEGRAM_BOT_TOKEN: "123456:test-only-bot-token",
        },
      },
    }),
  ],
});
