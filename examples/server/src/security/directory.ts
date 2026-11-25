/**
 * 玩家名录：D1 里的一张表，记着所有注册过的玩家。
 *
 * 对象是按名字自动创建的，访问一个不存在的玩家 ID 也会得到一个对象并留下数据。
 * 所以凡是 ID 来自别处（好友申请、邀请码、广告回调、管理后台）的地方，先查名录，查到了再去访问对象。
 */
export async function registerPlayer(db: D1Database, playerId: string, now: number): Promise<void> {
  // 每次登录都执行一次。已经在名录里的玩家不会被改动，早于名录存在的老玩家会在下次登录时补上。
  await db.prepare("INSERT OR IGNORE INTO player (player_id, created_at) VALUES (?, ?)").bind(playerId, now).run();
}

export async function findPlayer(db: D1Database, playerId: string): Promise<{ createdAt: number } | null> {
  const row = await db
    .prepare("SELECT created_at FROM player WHERE player_id = ?")
    .bind(playerId)
    .first<{ created_at: number }>();
  return row ? { createdAt: row.created_at } : null;
}
