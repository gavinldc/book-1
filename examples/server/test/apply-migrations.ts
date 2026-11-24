import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// 每个测试文件开始前把表建好。已经执行过的迁移不会重复执行。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
