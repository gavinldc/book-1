import { syncCheckoutSession } from "../economy/stripe";
import { log } from "../obs/log";
import { metric } from "../obs/metrics";
import { RATING_BOARD } from "../social/leaderboard";

/** 分数分布表里每一段的宽度。 */
export const BUCKET_SIZE = 50;
/** 对局记录、录像保留多久。 */
export const RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** 一次清理最多删多少行。删不完的留给下一次。 */
const CLEANUP_BATCH = 1000;
/** 下单多久之后还没付款，才去支付平台核实；超过多久就不再管。 */
const SWEEP_AFTER_MS = 10 * 60 * 1000;
const SWEEP_UNTIL_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 50;

/** 重算一个榜的分数分布。整张表换成新的，在一个事务里完成，读的人不会看到一半。 */
export async function refreshScoreBuckets(db: D1Database, board = RATING_BOARD): Promise<number> {
  const rows = await db
    // 绑定进来的数是浮点数，除法的结果也是，所以要显式取整。
    .prepare(
      "SELECT CAST(score / ? AS INTEGER) AS bucket, COUNT(*) AS players FROM leaderboard WHERE board = ? GROUP BY bucket",
    )
    .bind(BUCKET_SIZE, board)
    .all<{ bucket: number; players: number }>();
  const insert = db.prepare("INSERT INTO score_bucket (board, bucket, players) VALUES (?, ?, ?)");
  await db.batch([
    db.prepare("DELETE FROM score_bucket WHERE board = ?").bind(board),
    ...rows.results.map((row) => insert.bind(board, row.bucket, row.players)),
  ]);
  return rows.results.length;
}

/**
 * 估算一个分数超过了百分之多少的玩家（0 到 100）。读的是分布表，和玩家总数无关。
 * 同一段里的人按一半在前、一半在后估算。分布表还没生成时返回 null。
 */
export async function percentileOf(db: D1Database, score: number, board = RATING_BOARD): Promise<number | null> {
  const rows = await db
    .prepare("SELECT bucket, players FROM score_bucket WHERE board = ?")
    .bind(board)
    .all<{ bucket: number; players: number }>();
  const total = rows.results.reduce((sum, row) => sum + row.players, 0);
  if (total === 0) return null;
  const mine = Math.floor(score / BUCKET_SIZE);
  let below = 0;
  for (const row of rows.results) {
    if (row.bucket < mine) below += row.players;
    else if (row.bucket === mine) below += row.players / 2;
  }
  return Math.min(99, Math.floor((below / total) * 100));
}

/**
 * 掉单的第三层补救：找出下单一段时间后仍未付款的订单，逐个去支付平台核实，已付款的发货。
 * 发货走的是和回调同一个函数，所以和回调撞在一起也不会发两次。
 */
export async function sweepPendingOrders(env: Env, now: number): Promise<{ checked: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT order_id, external_id FROM payment
     WHERE status = 'pending' AND provider = 'stripe' AND external_id IS NOT NULL
       AND created_at BETWEEN ? AND ?
     ORDER BY created_at LIMIT ?`,
  )
    .bind(now - SWEEP_UNTIL_MS, now - SWEEP_AFTER_MS, SWEEP_BATCH)
    .all<{ order_id: string; external_id: string }>();

  let failed = 0;
  for (const row of rows.results) {
    try {
      await syncCheckoutSession(env, row.external_id);
    } catch (error) {
      // 一个订单查不了不影响其他订单，下一轮还会再查到它。
      failed++;
      log.warn("order_sync_failed", { orderId: row.order_id, error });
    }
  }
  return { checked: rows.results.length, failed };
}

/** 删除过期的数据。每张表一次最多删一批，表很大时分很多次删完，不会有一次特别慢的执行。 */
export async function cleanup(db: D1Database, now: number): Promise<Record<string, number>> {
  const before = now - RECORD_RETENTION_MS;
  const bounded = (table: string, column: string) =>
    db
      .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`)
      .bind(before, CLEANUP_BATCH);
  const [records, replays, mails] = await db.batch([
    bounded("match_record", "ended_at"),
    bounded("replay", "created_at"),
    db.prepare("DELETE FROM broadcast_mail WHERE ends_at < ?").bind(before),
  ]);
  return {
    match_record: records?.meta.changes ?? 0,
    replay: replays?.meta.changes ?? 0,
    broadcast_mail: mails?.meta.changes ?? 0,
  };
}

/** 定时触发器的入口。按触发它的表达式决定做什么。 */
export async function runScheduled(cron: string, scheduledTime: number, env: Env): Promise<void> {
  const started = Date.now();
  try {
    let result: unknown;
    switch (cron) {
      case "*/5 * * * *":
        result = {
          buckets: await refreshScoreBuckets(env.DB),
          orders: await sweepPendingOrders(env, scheduledTime),
        };
        break;
      case "0 19 * * *":
        result = await cleanup(env.DB, scheduledTime);
        break;
      default:
        log.error("job_unknown", { cron });
        return;
    }
    const ms = Date.now() - started;
    // 每次成功都留一条日志和一个数据点。平台的监控规则盯着这条日志：
    // 一段时间内它出现的次数不够，说明任务不再发生了。所以事件名不能随便改。
    log.info("job_done", { cron, ms, result });
    metric(env, "job_run", [cron, "ok"], [ms]);
  } catch (error) {
    log.error("job_failed", { cron, ms: Date.now() - started, error });
    metric(env, "job_run", [cron, "failed"], [Date.now() - started]);
    throw error;
  }
}
