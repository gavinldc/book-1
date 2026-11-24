import { isServerSeat } from "@game/shared";

/** 对局里的一步：谁掷出了几点。dice 为 0 表示这一回合超时轮空。 */
export interface LogEntry {
  playerId: string;
  dice: number;
}

/** 一局结束后留下的记录。由房间在结算时送进队列，消费者写入 D1。 */
export interface MatchRecord {
  matchId: string;
  kind: "private" | "ranked" | "mirror";
  winner: string | null;
  /** 参加了这一局的所有人，包括中途退出的。 */
  players: string[];
  /** 开局时各个真实玩家的分数。好友房没有。 */
  ratings: Record<string, number>;
  log: LogEntry[];
  endedAt: number;
}

/** 镜像对战用的录像：某个玩家在某一局里依次掷出的点数。 */
export interface Replay {
  playerId: string;
  rolls: number[];
}

/** 一段录像至少要有这么多步才值得拿来当对手。 */
const MIN_REPLAY_ROLLS = 3;

/**
 * 把一批对局记录写进 D1。同一条记录可能被投递多次，所以用 INSERT OR IGNORE，
 * 重复的写入不会产生第二行。
 */
export async function saveRecords(db: D1Database, records: MatchRecord[]): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const record of records) {
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO match_record (match_id, kind, winner, players, log, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          record.matchId,
          record.kind,
          record.winner,
          JSON.stringify(record.players),
          JSON.stringify(record.log),
          record.endedAt,
        ),
    );
    // 只有排位赛里真实玩家的操作才进录像池。
    if (record.kind !== "ranked") continue;
    for (const playerId of record.players) {
      const rating = record.ratings[playerId];
      if (isServerSeat(playerId) || rating === undefined) continue;
      const rolls = record.log.filter((e) => e.playerId === playerId && e.dice > 0).map((e) => e.dice);
      if (rolls.length < MIN_REPLAY_ROLLS) continue;
      statements.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO replay (match_id, player_id, rating, rolls, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(record.matchId, playerId, rating, JSON.stringify(rolls), record.endedAt),
      );
    }
  }
  if (statements.length > 0) await db.batch(statements);
}

/** 挑一段分数接近的录像，不挑自己的。找不到时返回 null。 */
export async function pickReplay(
  db: D1Database,
  rating: number,
  excludePlayerId: string,
  window = 200,
): Promise<Replay | null> {
  const row = await db
    .prepare(
      `SELECT player_id, rolls FROM replay
       WHERE rating BETWEEN ? AND ? AND player_id != ?
       ORDER BY RANDOM() LIMIT 1`,
    )
    .bind(rating - window, rating + window, excludePlayerId)
    .first<{ player_id: string; rolls: string }>();
  if (!row) return null;
  return { playerId: row.player_id, rolls: JSON.parse(row.rolls) as number[] };
}
