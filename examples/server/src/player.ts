import { DurableObject } from "cloudflare:workers";

import type { PlayerEvent, PlayerEventDraft } from "./social/events";

export interface Profile {
  coins: number;
  wins: number;
  games: number;
  /** 排位分数。 */
  rating: number;
}

export interface MatchResult {
  won: boolean;
  coins: number;
  /** 排位分数的变化。不计分的对局不传。 */
  rating?: number;
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
  `ALTER TABLE profile ADD COLUMN rating INTEGER NOT NULL DEFAULT 1000;`,
  `CREATE TABLE outbox (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     body TEXT NOT NULL
   );
   CREATE TABLE friend (
     player_id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );
   ALTER TABLE profile ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE profile ADD COLUMN rated_wins INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE profile ADD COLUMN inviter TEXT;
   ALTER TABLE profile ADD COLUMN invite_rewarded INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE profile ADD COLUMN invites_paid INTEGER NOT NULL DEFAULT 0;`,
];

/** 发件箱一次最多送出多少条，送出失败后隔多久重试。 */
const OUTBOX_BATCH = 50;
const OUTBOX_RETRY_MS = 5_000;

/** 好友数的上限（包括自己发出、还没被接受的申请）。好友榜用一条查询取所有好友的分数，上限受它约束。 */
export const MAX_FRIENDS = 50;
/** 最多保留多少条还没处理的好友申请，超出的直接丢弃。 */
export const MAX_INCOMING = 50;

/** 注册之后多久以内可以填邀请人。 */
export const INVITE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 被邀请的人赢下这么多局计分的对局之后，邀请人才拿到奖励。 */
export const INVITE_WINS_REQUIRED = 2;
/** 每成功邀请一个人的奖励，以及一个玩家最多能拿多少次。 */
export const INVITE_REWARD_COINS = 50;
export const INVITE_REWARD_CAP = 20;

export type FriendStatus = "outgoing" | "incoming" | "friend";

export interface Friend {
  playerId: string;
  status: FriendStatus;
}

export type FriendResult = "ok" | "self" | "full" | "not_found";
export type InviteResult = "ok" | "self" | "already" | "too_late" | "invalid";
export type RewardResult = "granted" | "capped" | "duplicate";

/** 别的玩家可以知道的信息。 */
export interface PublicInfo {
  /** 是不是一个注册过的玩家。任何人都可以拿任意 ID 来查，所以对象存在不代表玩家存在。 */
  exists: boolean;
  createdAt: number;
}

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

  /** 定时器只用来重发发件箱里没送出去的通知。 */
  async alarm(): Promise<void> {
    await this.flush();
  }

  /** 记入一局的结果。matchId 相同的调用只会生效一次，可以放心重试。 */
  async applyMatchResult(matchId: string, result: MatchResult): Promise<Profile> {
    const sql = this.ctx.storage.sql;
    const opId = `match:${matchId}`;
    const delta = result.rating ?? 0;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const seen = sql.exec("SELECT 1 FROM ledger WHERE op_id = ?", opId).toArray();
      if (seen.length > 0) return;
      sql.exec(
        "INSERT INTO ledger (op_id, kind, coins, created_at) VALUES (?, 'match', ?, ?)",
        opId,
        result.coins,
        now,
      );
      const row = sql
        .exec(
          `UPDATE profile SET coins = coins + ?, wins = wins + ?, games = games + 1,
             rating = MAX(0, rating + ?), rated_wins = rated_wins + ?
           WHERE id = 1
           RETURNING rating, rated_wins, inviter, invite_rewarded`,
          result.coins,
          result.won ? 1 : 0,
          delta,
          result.won && delta !== 0 ? 1 : 0,
        )
        .one();

      // 分数变了：通知排行榜。通知和分数在同一个事务里写下，不会只成功一半。
      if (delta !== 0) {
        this.emit({ type: "score", playerId: this.id, rating: Number(row.rating), at: now });
      }
      // 被邀请的人达到了门槛：通知邀请人领奖。标记保证只发一次。
      if (row.inviter && Number(row.invite_rewarded) === 0 && Number(row.rated_wins) >= INVITE_WINS_REQUIRED) {
        sql.exec("UPDATE profile SET invite_rewarded = 1 WHERE id = 1");
        this.emit({ type: "invite_reward", inviter: String(row.inviter), invitee: this.id, at: now });
      }
    });
    await this.flush();
    return this.readProfile();
  }

  /** 给别的玩家和入口用：这个 ID 是不是一个注册过的玩家。 */
  getPublic(): PublicInfo {
    const sql = this.ctx.storage.sql;
    const exists = sql.exec("SELECT 1 FROM identity LIMIT 1").toArray().length > 0;
    return { exists, createdAt: Number(sql.exec("SELECT created_at FROM profile WHERE id = 1").one().created_at) };
  }

  // ---- 好友 ----

  listFriends(): Friend[] {
    return this.ctx.storage.sql
      .exec("SELECT player_id, status FROM friend ORDER BY updated_at DESC")
      .toArray()
      .map((row) => ({ playerId: String(row.player_id), status: row.status as FriendStatus }));
  }

  /** 我向对方发出好友申请。对方已经申请过我的话，直接成为好友。 */
  async requestFriend(target: string, now: number): Promise<FriendResult> {
    if (target === this.id) return "self";
    const status = this.friendStatus(target);
    if (status === "friend" || status === "outgoing") return "ok";
    if (this.friendCount() >= MAX_FRIENDS) return "full";
    this.ctx.storage.transactionSync(() => {
      if (status === "incoming") {
        this.setFriend(target, "friend", now);
        this.emit({ type: "friend_accept", from: this.id, to: target, at: now });
      } else {
        this.setFriend(target, "outgoing", now);
        this.emit({ type: "friend_request", from: this.id, to: target, at: now });
      }
    });
    await this.flush();
    return "ok";
  }

  /** 我接受对方的申请。 */
  async acceptFriend(from: string, now: number): Promise<FriendResult> {
    const status = this.friendStatus(from);
    if (status === "friend") return "ok";
    if (status !== "incoming") return "not_found";
    if (this.friendCount() >= MAX_FRIENDS) return "full";
    this.ctx.storage.transactionSync(() => {
      this.setFriend(from, "friend", now);
      this.emit({ type: "friend_accept", from: this.id, to: from, at: now });
    });
    await this.flush();
    return "ok";
  }

  /** 我删除好友、撤回申请或者拒绝申请，三件事是同一个操作：去掉这一行并告诉对方。 */
  async removeFriend(other: string, now: number): Promise<void> {
    if (this.friendStatus(other) === null) return;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM friend WHERE player_id = ?", other);
      this.emit({ type: "friend_remove", from: this.id, to: other, at: now });
    });
    await this.flush();
  }

  /** 由消费者调用：有人向我发来了申请。 */
  async friendIncoming(from: string, now: number): Promise<void> {
    if (!this.getPublic().exists || from === this.id) return;
    const status = this.friendStatus(from);
    if (status === "incoming") return;
    this.ctx.storage.transactionSync(() => {
      if (status === "outgoing" || status === "friend") {
        // 我也申请过对方（或者我这边已经是好友了）：直接成为好友，并让对方知道。
        this.setFriend(from, "friend", now);
        this.emit({ type: "friend_accept", from: this.id, to: from, at: now });
        return;
      }
      const pending = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM friend WHERE status = 'incoming'").one();
      // 没处理的申请太多时，新的直接丢弃。
      if (Number(pending.n) < MAX_INCOMING) this.setFriend(from, "incoming", now);
    });
    await this.flush();
  }

  /** 由消费者调用：对方接受了我的申请。 */
  async friendConfirm(by: string, now: number): Promise<void> {
    const status = this.friendStatus(by);
    if (status === "friend") return;
    this.ctx.storage.transactionSync(() => {
      if (status === null) {
        // 我已经撤回了申请，对方却接受了。以我这边为准，让对方把我去掉。
        this.emit({ type: "friend_remove", from: this.id, to: by, at: now });
      } else {
        this.setFriend(by, "friend", now);
      }
    });
    await this.flush();
  }

  /** 由消费者调用：对方把我去掉了。 */
  friendRemoved(by: string): void {
    this.ctx.storage.sql.exec("DELETE FROM friend WHERE player_id = ?", by);
  }

  // ---- 邀请 ----

  /**
   * 记下是谁邀请了我。只能设置一次，只在注册后的一段时间内有效，
   * 并且邀请人必须比我注册得早，这样两个人不可能互为邀请人。
   */
  async setInviter(inviterId: string, inviterCreatedAt: number, now: number): Promise<InviteResult> {
    if (inviterId === this.id) return "self";
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT inviter, created_at FROM profile WHERE id = 1").one();
    if (row.inviter) return row.inviter === inviterId ? "ok" : "already";
    if (now - Number(row.created_at) > INVITE_WINDOW_MS) return "too_late";
    if (inviterCreatedAt >= Number(row.created_at)) return "invalid";
    this.ctx.storage.transactionSync(() => {
      sql.exec("UPDATE profile SET inviter = ? WHERE id = 1", inviterId);
      this.emit({ type: "invited", inviter: inviterId, invitee: this.id, at: now });
    });
    await this.flush();
    return "ok";
  }

  /** 由消费者调用：我邀请的人达到了门槛。按被邀请人去重，超过上限后只记账不发钱。 */
  grantInviteReward(invitee: string): RewardResult {
    const sql = this.ctx.storage.sql;
    const opId = `invite:${invitee}`;
    let outcome: RewardResult = "duplicate";
    this.ctx.storage.transactionSync(() => {
      if (sql.exec("SELECT 1 FROM ledger WHERE op_id = ?", opId).toArray().length > 0) return;
      const paid = Number(sql.exec("SELECT invites_paid FROM profile WHERE id = 1").one().invites_paid);
      const granted = paid < INVITE_REWARD_CAP && !this.isBanned();
      const coins = granted ? INVITE_REWARD_COINS : 0;
      // 没发钱也写一行流水：下次同一个被邀请人的通知再来时，仍然会被认出是重复的。
      sql.exec(
        "INSERT INTO ledger (op_id, kind, coins, created_at) VALUES (?, 'invite', ?, ?)",
        opId,
        coins,
        Date.now(),
      );
      if (granted) {
        sql.exec("UPDATE profile SET coins = coins + ?, invites_paid = invites_paid + 1 WHERE id = 1", coins);
      }
      outcome = granted ? "granted" : "capped";
    });
    return outcome;
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

  /** 这个玩家自己的 ID，也就是访问这个对象时用的名字。 */
  private get id(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("玩家对象只能按名字访问");
    return name;
  }

  /** 把一条通知写进发件箱。必须在修改数据的同一个事务里调用。 */
  private emit(event: PlayerEventDraft): void {
    this.ctx.storage.sql.exec("INSERT INTO outbox (body) VALUES (?)", JSON.stringify(event));
  }

  /**
   * 把发件箱里的通知送进队列，送达后删除。送不出去时不报错，
   * 数据已经保存好了，稍后由定时器重发。通知可能被送出不止一次，接收方都要能重复处理。
   */
  private async flush(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const rows = sql.exec("SELECT seq, body FROM outbox ORDER BY seq LIMIT ?", OUTBOX_BATCH).toArray();
    if (rows.length === 0) return;
    try {
      await this.env.PLAYER_EVENTS.sendBatch(
        rows.map((row) => ({ body: { ...JSON.parse(String(row.body)), seq: Number(row.seq) } as PlayerEvent })),
      );
      sql.exec("DELETE FROM outbox WHERE seq <= ?", Number(rows[rows.length - 1]!.seq));
      if (rows.length === OUTBOX_BATCH) await this.flush();
    } catch (error) {
      console.error("通知没有送出，稍后重试", error);
      await this.ctx.storage.setAlarm(Date.now() + OUTBOX_RETRY_MS);
    }
  }

  private friendStatus(other: string): FriendStatus | null {
    const row = this.ctx.storage.sql.exec("SELECT status FROM friend WHERE player_id = ?", other).toArray()[0];
    return row ? (row.status as FriendStatus) : null;
  }

  /** 已经是好友的，加上我发出去还没回音的。 */
  private friendCount(): number {
    const row = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM friend WHERE status != 'incoming'").one();
    return Number(row.n);
  }

  private setFriend(other: string, status: FriendStatus, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO friend (player_id, status, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (player_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
      other,
      status,
      now,
    );
  }

  private isBanned(): boolean {
    return Number(this.ctx.storage.sql.exec("SELECT banned FROM profile WHERE id = 1").one().banned) === 1;
  }

  private readProfile(): Profile {
    const row = this.ctx.storage.sql.exec("SELECT coins, wins, games, rating FROM profile WHERE id = 1").one();
    return {
      coins: Number(row.coins),
      wins: Number(row.wins),
      games: Number(row.games),
      rating: Number(row.rating),
    };
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
    // 第一次建表的时刻就是这个玩家的注册时间。老玩家在升级到这个版本时补上。
    sql.exec("UPDATE profile SET created_at = ? WHERE created_at = 0", Date.now());
  });
}
