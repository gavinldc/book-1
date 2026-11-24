/** 示例里只有一个榜：排位分数。赛季榜、周榜只是换一个榜名。 */
export const RATING_BOARD = "rating";

/** 榜单一次返回多少名。 */
export const TOP_SIZE = 50;
/** 精确名次只算到这里，再往后只告诉玩家"在这之外"。 */
export const RANK_CAP = 1000;

export interface Entry {
  playerId: string;
  score: number;
}

export interface Standing {
  score: number;
  /** 名次，从 1 开始。超过 RANK_CAP 时为 null。 */
  rank: number | null;
}

/**
 * 写入一批分数。带序号的条件更新：只有比库里更新的才会生效，
 * 所以重复投递和乱序到达都不会把新分数改回旧分数。
 */
export async function saveScores(
  db: D1Database,
  events: { playerId: string; rating: number; seq: number; at: number }[],
): Promise<void> {
  const statement = db.prepare(
    `INSERT INTO leaderboard (board, player_id, score, seq, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (board, player_id) DO UPDATE
       SET score = excluded.score, seq = excluded.seq, updated_at = excluded.updated_at
       WHERE excluded.seq > leaderboard.seq`,
  );
  await db.batch(events.map((e) => statement.bind(RATING_BOARD, e.playerId, e.rating, e.seq, e.at)));
}

/** 前若干名。分数相同时，先达到这个分数的排在前面。 */
export async function topOf(db: D1Database, board: string, limit = TOP_SIZE): Promise<Entry[]> {
  const rows = await db
    .prepare(
      `SELECT player_id, score FROM leaderboard WHERE board = ?
       ORDER BY score DESC, updated_at ASC LIMIT ?`,
    )
    .bind(board, limit)
    .all<{ player_id: string; score: number }>();
  return rows.results.map((row) => ({ playerId: row.player_id, score: row.score }));
}

/**
 * 一个玩家的分数和名次。名次等于"排在他前面的人数加一"。
 * 数人数的查询带了上限，最多读 RANK_CAP 行左右，不会因为玩家排得靠后而越来越贵。
 */
export async function standingOf(db: D1Database, board: string, playerId: string): Promise<Standing | null> {
  const me = await db
    .prepare("SELECT score, updated_at FROM leaderboard WHERE board = ? AND player_id = ?")
    .bind(board, playerId)
    .first<{ score: number; updated_at: number }>();
  if (!me) return null;

  const [higher, earlier] = await db.batch<{ n: number }>([
    db
      .prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM leaderboard WHERE board = ? AND score > ? LIMIT ?)")
      .bind(board, me.score, RANK_CAP),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM leaderboard WHERE board = ? AND score = ? AND updated_at < ? LIMIT ?
         )`,
      )
      .bind(board, me.score, me.updated_at, RANK_CAP),
  ]);
  const ahead = (higher?.results[0]?.n ?? 0) + (earlier?.results[0]?.n ?? 0);
  return { score: me.score, rank: ahead >= RANK_CAP ? null : ahead + 1 };
}

/** 一组玩家在榜上的分数，按名次排好。用于好友榜。人数受单条查询的参数个数限制。 */
export async function scoresOf(db: D1Database, board: string, playerIds: string[]): Promise<Entry[]> {
  if (playerIds.length === 0) return [];
  const marks = playerIds.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT player_id, score FROM leaderboard WHERE board = ? AND player_id IN (${marks})
       ORDER BY score DESC, updated_at ASC`,
    )
    .bind(board, ...playerIds)
    .all<{ player_id: string; score: number }>();
  return rows.results.map((row) => ({ playerId: row.player_id, score: row.score }));
}
