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
  `CREATE TABLE session (
     id TEXT PRIMARY KEY,
     refresh_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE identity (
     provider TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     linked_at INTEGER NOT NULL
   );
   ALTER TABLE profile ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;`,
];

/** 刷新凭证的有效期。每次刷新都会顺延。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 一个玩家同时保留的会话数，超出时删掉最旧的。 */
const MAX_SESSIONS = 5;

export type SessionResult = "ok" | "banned" | "invalid";

export interface Account {
  banned: boolean;
  /** 已绑定的身份，键是来源（guest、telegram），值是身份对象的名字。 */
  identities: Record<string, string>;
}

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

  /** 登录成功后开一个会话。只保存刷新凭证的哈希，不保存原文。 */
  openSession(sessionId: string, refreshHash: string, now: number): SessionResult {
    if (this.isBanned()) return "banned";
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM session WHERE expires_at <= ?", now);
      sql.exec(
        "INSERT INTO session (id, refresh_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
        sessionId,
        refreshHash,
        now,
        now + SESSION_TTL_MS,
      );
      sql.exec(
        "DELETE FROM session WHERE id NOT IN (SELECT id FROM session ORDER BY created_at DESC LIMIT ?)",
        MAX_SESSIONS,
      );
    });
    return "ok";
  }

  /**
   * 用旧的刷新凭证换新的。旧凭证只能用一次：
   * 如果有人拿着已经用过的凭证来刷新，说明凭证可能泄露，整个会话作废。
   */
  rotateSession(sessionId: string, currentHash: string, nextHash: string, now: number): SessionResult {
    if (this.isBanned()) return "banned";
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT refresh_hash, expires_at FROM session WHERE id = ?", sessionId).toArray()[0];
    if (!row || Number(row.expires_at) <= now) return "invalid";
    if (row.refresh_hash !== currentHash) {
      sql.exec("DELETE FROM session WHERE id = ?", sessionId);
      return "invalid";
    }
    sql.exec(
      "UPDATE session SET refresh_hash = ?, expires_at = ? WHERE id = ?",
      nextHash,
      now + SESSION_TTL_MS,
      sessionId,
    );
    return "ok";
  }

  closeSession(sessionId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM session WHERE id = ?", sessionId);
  }

  /** 记下自己绑定了哪个身份。同一来源只能绑一个，重复调用不会出错。 */
  linkIdentity(provider: string, name: string, now: number): boolean {
    const sql = this.ctx.storage.sql;
    const existing = sql.exec("SELECT name FROM identity WHERE provider = ?", provider).toArray()[0];
    if (existing) return existing.name === name;
    sql.exec("INSERT INTO identity (provider, name, linked_at) VALUES (?, ?, ?)", provider, name, now);
    return true;
  }

  getAccount(): Account {
    const identities: Record<string, string> = {};
    for (const row of this.ctx.storage.sql.exec("SELECT provider, name FROM identity")) {
      identities[String(row.provider)] = String(row.name);
    }
    return { banned: this.isBanned(), identities };
  }

  /** 封禁并让所有会话失效。已经签发的访问令牌最长还能用到它自己过期。 */
  ban(): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE profile SET banned = 1 WHERE id = 1");
      this.ctx.storage.sql.exec("DELETE FROM session");
    });
  }

  private isBanned(): boolean {
    return Number(this.ctx.storage.sql.exec("SELECT banned FROM profile WHERE id = 1").one().banned) === 1;
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
