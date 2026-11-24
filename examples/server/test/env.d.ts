import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** 只在测试里存在，见 vitest.config.ts。 */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
