import { DurableObject } from "cloudflare:workers";

export interface Profile {
  coins: number;
  wins: number;
  games: number;
}

export interface MatchResult {
  won: boolean;
  coins: number;
}

/**
 * 表结构的变更记录。只能在末尾追加，已经发布过的条目不能修改。
 * 对象每次被唤醒时会检查并补上还没执行的部分。
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE profile (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     coins INTEGER NOT NULL DEFAULT 0,
     wins INTEGER NOT NULL DEFAULT 0,
     games INTEGER NOT NULL DEFAULT 0
   );
   INSERT INTO profile (id) VALUES (1);`,
  `CREATE TABLE ledger (
     op_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     coins INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );`,
];

/**
 * 一个玩家一个对象，保存这个玩家自己的数据。
 * 所有会改动数值的操作都带一个操作编号，同一个编号只生效一次。
 */
export class Player extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage);
  }

  getProfile(): Profile {
    return this.readProfile();
  }

  /** 记入一局的结果。matchId 相同的调用只会生效一次，可以放心重试。 */
  applyMatchResult(matchId: string, result: MatchResult): Profile {
    const sql = this.ctx.storage.sql;
    const opId = `match:${matchId}`;
    this.ctx.storage.transactionSync(() => {
      const seen = sql.exec("SELECT 1 FROM ledger WHERE op_id = ?", opId).toArray();
      if (seen.length > 0) return;
      sql.exec(
        "INSERT INTO ledger (op_id, kind, coins, created_at) VALUES (?, 'match', ?, ?)",
        opId,
        result.coins,
        Date.now(),
      );
      sql.exec(
        "UPDATE profile SET coins = coins + ?, wins = wins + ?, games = games + 1 WHERE id = 1",
        result.coins,
        result.won ? 1 : 0,
      );
    });
    return this.readProfile();
  }

  private readProfile(): Profile {
    const row = this.ctx.storage.sql.exec("SELECT coins, wins, games FROM profile WHERE id = 1").one();
    return { coins: Number(row.coins), wins: Number(row.wins), games: Number(row.games) };
  }
}

function migrate(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const current = sql.exec("SELECT version FROM schema_version").toArray()[0];
  const applied = current ? Number(current.version) : 0;
  if (applied >= MIGRATIONS.length) return;

  storage.transactionSync(() => {
    for (const statement of MIGRATIONS.slice(applied)) {
      sql.exec(statement);
    }
    sql.exec("DELETE FROM schema_version");
    sql.exec("INSERT INTO schema_version (version) VALUES (?)", MIGRATIONS.length);
  });
}
