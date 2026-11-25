import { DurableObject } from "cloudflare:workers";

import { negate, PRODUCTS, type Delta, type Provider } from "./economy/catalog";
import { log } from "./obs/log";
import { metric } from "./obs/metrics";
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
  `ALTER TABLE profile ADD COLUMN gems INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE profile ADD COLUMN base_coins INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE profile ADD COLUMN base_gems INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE ledger ADD COLUMN gems INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE ledger ADD COLUMN items TEXT;
   CREATE INDEX ledger_time ON ledger (created_at);
   CREATE TABLE item (
     item_id TEXT PRIMARY KEY,
     qty INTEGER NOT NULL
   );
   CREATE TABLE purchase (
     order_id TEXT PRIMARY KEY,
     product_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     amount INTEGER NOT NULL,
     currency TEXT NOT NULL,
     status TEXT NOT NULL,
     external_id TEXT,
     created_at INTEGER NOT NULL,
     paid_at INTEGER
   );`,
  `CREATE TABLE mail (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     attachment TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     claimed_at INTEGER
   );
   ALTER TABLE profile ADD COLUMN current_room TEXT;
   ALTER TABLE profile ADD COLUMN pruned_at INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE profile ADD COLUMN analytics_id TEXT;`,
];

/** 邮箱里最多保留多少封邮件。超出时先删已经领过的、最旧的。 */
export const MAX_MAIL = 100;
/** 流水保留多久。必须比任何一种重试、补单可能持续的时间都长。 */
export const LEDGER_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export interface Mail {
  id: string;
  title: string;
  body: string;
  attachment: Delta;
  createdAt: number;
  expiresAt: number;
  claimed: boolean;
}

export interface LedgerRow {
  opId: string;
  kind: string;
  coins: number;
  gems: number;
  items: string | null;
  createdAt: number;
}

export type MailResult = TxResult | "not_found" | "expired";

/** 一小时内最多能有多少个还没付款的订单。 */
export const MAX_PENDING_ORDERS = 20;
/** 看一次广告的奖励，以及每天最多领多少次。 */
export const AD_REWARD_COINS = 5;
export const AD_DAILY_CAP = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Wallet {
  coins: number;
  gems: number;
  items: Record<string, number>;
}

export type TxResult = "ok" | "duplicate" | "insufficient";
export type OrderStatus = "pending" | "paid" | "refunded";

export interface Order {
  orderId: string;
  productId: string;
  provider: Provider;
  amount: number;
  currency: string;
  status: OrderStatus;
  externalId: string | null;
}

/** 支付平台告诉我们的付款信息。 */
export interface PaymentProof {
  provider: Provider;
  amount: number;
  currency: string;
  /** 支付平台那边的流水号，退款和查账时要用。 */
  externalId: string;
}

export type FulfillResult = "ok" | "duplicate" | "not_found" | "mismatch";
export type RefundResult = "ok" | "duplicate" | "not_found" | "not_paid";
export type AdResult = "ok" | "duplicate" | "capped";

export interface Audit {
  coins: number;
  gems: number;
  /** 按流水算出来应该有多少。 */
  ledgerCoins: number;
  ledgerGems: number;
  ok: boolean;
}

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
    // 构造函数在每次唤醒时都执行，它的耗时就是这类对象冷启动里属于我们自己的那一部分。
    const started = Date.now();
    migrate(ctx.storage);
    metric(env, "object_wake", ["Player"], [Date.now() - started]);
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
             rating = MAX(0, rating + ?), rated_wins = rated_wins + ?,
             current_room = NULL
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

  // ---- 钱包和背包 ----

  getWallet(): Wallet {
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT coins, gems FROM profile WHERE id = 1").one();
    const items: Record<string, number> = {};
    for (const item of sql.exec("SELECT item_id, qty FROM item WHERE qty != 0")) {
      items[String(item.item_id)] = Number(item.qty);
    }
    return { coins: Number(row.coins), gems: Number(row.gems), items };
  }

  /**
   * 改动资产的统一入口：一个操作编号，一组变化量，要么全部生效，要么全部不生效。
   * 编号相同的调用只生效一次；任何一项不够扣时整个操作被拒绝。
   */
  transact(opId: string, kind: string, delta: Delta): TxResult {
    let outcome: TxResult = "ok";
    this.ctx.storage.transactionSync(() => {
      outcome = this.applyDelta(opId, kind, delta, Date.now());
    });
    return outcome;
  }

  /** 看完一次广告的奖励。奖励多少由服务端定，每天有上限。transactionId 是广告平台给这次观看的编号。 */
  grantAdReward(transactionId: string, now: number): AdResult {
    const sql = this.ctx.storage.sql;
    const opId = `ad:${transactionId}`;
    let outcome: AdResult = "duplicate";
    this.ctx.storage.transactionSync(() => {
      if (sql.exec("SELECT 1 FROM ledger WHERE op_id = ?", opId).toArray().length > 0) return;
      const dayStart = now - (now % DAY_MS);
      const today = sql
        .exec("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'ad' AND coins > 0 AND created_at >= ?", dayStart)
        .one();
      const capped = Number(today.n) >= AD_DAILY_CAP;
      // 超过上限也记一行，金额为 0，这样同一次观看的通知再来时仍然会被认出是重复的。
      this.applyDelta(opId, "ad", { coins: capped ? 0 : AD_REWARD_COINS }, now);
      outcome = capped ? "capped" : "ok";
    });
    return outcome;
  }

  /** 最近的流水，新的在前。客服查问题时用。 */
  getLedger(limit: number): LedgerRow[] {
    return this.ctx.storage.sql
      .exec("SELECT * FROM ledger ORDER BY created_at DESC LIMIT ?", Math.min(Math.max(1, limit), 200))
      .toArray()
      .map((row) => ({
        opId: String(row.op_id),
        kind: String(row.kind),
        coins: Number(row.coins),
        gems: Number(row.gems),
        items: row.items === null ? null : String(row.items),
        createdAt: Number(row.created_at),
      }));
  }

  /** 这些操作编号里，哪些已经处理过。 */
  hasOps(opIds: string[]): string[] {
    const sql = this.ctx.storage.sql;
    return opIds.filter((opId) => sql.exec("SELECT 1 FROM ledger WHERE op_id = ?", opId).toArray().length > 0);
  }

  // ---- 邮件 ----

  /** 往这个玩家的邮箱里放一封邮件。id 相同的只会放一次。 */
  sendMail(mail: { id: string; title: string; body: string; attachment: Delta; expiresAt: number }, now: number): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT OR IGNORE INTO mail (id, title, body, attachment, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        mail.id,
        mail.title,
        mail.body,
        JSON.stringify(mail.attachment),
        now,
        mail.expiresAt,
      );
      // 过期的直接删；还是太多的话，先删已经领过的，再删最旧的。
      sql.exec("DELETE FROM mail WHERE expires_at <= ?", now);
      sql.exec(
        `DELETE FROM mail WHERE id NOT IN (
           SELECT id FROM mail ORDER BY claimed_at IS NOT NULL, created_at DESC LIMIT ?
         )`,
        MAX_MAIL,
      );
    });
  }

  listMail(now: number): Mail[] {
    return this.ctx.storage.sql
      .exec("SELECT * FROM mail WHERE expires_at > ? ORDER BY created_at DESC", now)
      .toArray()
      .map((row) => ({
        id: String(row.id),
        title: String(row.title),
        body: String(row.body),
        attachment: JSON.parse(String(row.attachment)) as Delta,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
        claimed: row.claimed_at !== null,
      }));
  }

  /** 领取一封邮件里的附件。标记已领和发放附件在同一个事务里。 */
  claimMail(mailId: string, now: number): MailResult {
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT attachment, expires_at, claimed_at FROM mail WHERE id = ?", mailId).toArray()[0];
    if (!row) return "not_found";
    if (row.claimed_at !== null) return "duplicate";
    if (Number(row.expires_at) <= now) return "expired";
    let outcome: MailResult = "ok";
    this.ctx.storage.transactionSync(() => {
      outcome = this.applyDelta(`mail:${mailId}`, "mail", JSON.parse(String(row.attachment)) as Delta, now);
      sql.exec("UPDATE mail SET claimed_at = ? WHERE id = ?", now, mailId);
    });
    return outcome;
  }

  /** 记下客户端在分析平台上的标识。服务端补报付款事件时带上它，才能和客户端的事件归到同一个人。 */
  setAnalyticsId(analyticsId: string): void {
    this.ctx.storage.sql.exec("UPDATE profile SET analytics_id = ? WHERE id = 1", analyticsId);
  }

  // ---- 当前所在的房间 ----

  /**
   * 记下这个玩家进了哪个房间。这只是一个提示，用来在重新打开游戏时找回对局、在封禁时找到要踢的房间；
   * 房间里到底有没有这个人，以房间自己的状态为准。
   */
  setCurrentRoom(roomId: string | null): void {
    this.ctx.storage.sql.exec("UPDATE profile SET current_room = ? WHERE id = 1", roomId);
  }

  getCurrentRoom(): string | null {
    const row = this.ctx.storage.sql.exec("SELECT current_room FROM profile WHERE id = 1").one();
    return row.current_room === null ? null : String(row.current_room);
  }

  // ---- 订单 ----

  /** 下单。价格由调用方按商品表填好，之后付款时要和这里记下的完全一致。 */
  async createOrder(
    orderId: string,
    productId: string,
    provider: Provider,
    now: number,
  ): Promise<Order | "unknown" | "too_many"> {
    const product = PRODUCTS[productId];
    if (!product) return "unknown";
    const sql = this.ctx.storage.sql;
    const recent = sql
      .exec("SELECT COUNT(*) AS n FROM purchase WHERE status = 'pending' AND created_at > ?", now - 60 * 60 * 1000)
      .one();
    if (Number(recent.n) >= MAX_PENDING_ORDERS) return "too_many";
    const { amount, currency } = product.price[provider];
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT OR IGNORE INTO purchase (order_id, product_id, provider, amount, currency, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        orderId,
        productId,
        provider,
        amount,
        currency,
        now,
      );
      // 没付款的订单也通知出去，定时任务靠 D1 里的这份记录找出需要去支付平台核实的订单。
      this.emitPayment(orderId, now);
    });
    await this.flush();
    return this.getOrder(orderId)!;
  }

  getOrder(orderId: string): Order | null {
    const row = this.ctx.storage.sql.exec("SELECT * FROM purchase WHERE order_id = ?", orderId).toArray()[0];
    if (!row) return null;
    return {
      orderId: String(row.order_id),
      productId: String(row.product_id),
      provider: row.provider as Provider,
      amount: Number(row.amount),
      currency: String(row.currency),
      status: row.status as OrderStatus,
      externalId: row.external_id === null ? null : String(row.external_id),
    };
  }

  /** 记下支付平台那边的编号（比如结账会话的 ID），以后主动查询付款状态时用。 */
  async setOrderExternal(orderId: string, externalId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE purchase SET external_id = ? WHERE order_id = ? AND status = 'pending'",
        externalId,
        orderId,
      );
      this.emitPayment(orderId, Date.now());
    });
    await this.flush();
  }

  /**
   * 发货。支付平台的回调可能来不止一次，也可能和主动查询同时到，所以这里必须能重复调用：
   * 订单的状态和发出去的东西在同一个事务里修改，已经发过的订单不会再发。
   */
  async fulfillOrder(orderId: string, proof: PaymentProof, now: number): Promise<FulfillResult> {
    const order = this.getOrder(orderId);
    if (!order) return "not_found";
    if (order.status !== "pending") return "duplicate";
    // 付的钱必须和下单时记下的一致。不一致说明有人改了金额，或者配置出了错，都不能发货。
    if (order.provider !== proof.provider || order.amount !== proof.amount || order.currency !== proof.currency) {
      return "mismatch";
    }
    this.ctx.storage.transactionSync(() => {
      this.applyDelta(`order:${orderId}`, "purchase", PRODUCTS[order.productId]!.grant, now);
      this.ctx.storage.sql.exec(
        "UPDATE purchase SET status = 'paid', external_id = ?, paid_at = ? WHERE order_id = ?",
        proof.externalId,
        now,
        orderId,
      );
      this.emitPayment(orderId, now);
    });
    await this.flush();
    return "ok";
  }

  /**
   * 退款：把发出去的东西收回来。已经花掉的部分会让余额变成负数，
   * 玩家下次充值时先补上这部分。这是唯一允许余额为负的地方。
   */
  async refundOrder(orderId: string, now: number): Promise<RefundResult> {
    const order = this.getOrder(orderId);
    if (!order) return "not_found";
    // 退款的通知比付款的通知先到。现在没有东西可收回，让调用方稍后再来。
    if (order.status === "pending") return "not_paid";
    if (order.status !== "paid") return "duplicate";
    this.ctx.storage.transactionSync(() => {
      this.applyDelta(`refund:${orderId}`, "refund", negate(PRODUCTS[order.productId]!.grant), now, true);
      this.ctx.storage.sql.exec("UPDATE purchase SET status = 'refunded' WHERE order_id = ?", orderId);
      this.emitPayment(orderId, now);
    });
    await this.flush();
    return "ok";
  }

  // ---- 对账 ----

  /** 余额应该等于所有流水的合计。对不上说明有代码绕过流水改了余额。 */
  audit(): Audit {
    const sql = this.ctx.storage.sql;
    const profile = sql.exec("SELECT coins, gems, base_coins, base_gems FROM profile WHERE id = 1").one();
    const sum = sql.exec("SELECT COALESCE(SUM(coins), 0) AS coins, COALESCE(SUM(gems), 0) AS gems FROM ledger").one();
    const ledgerCoins = Number(profile.base_coins) + Number(sum.coins);
    const ledgerGems = Number(profile.base_gems) + Number(sum.gems);
    const coins = Number(profile.coins);
    const gems = Number(profile.gems);
    return { coins, gems, ledgerCoins, ledgerGems, ok: coins === ledgerCoins && gems === ledgerGems };
  }

  /**
   * 清理早于指定时间的流水。被清掉的金额累加进一个基数里，对账时仍然算得平。
   * 清掉的流水不能再用来去重，所以保留期要比任何一种重试可能持续的时间都长。
   */
  pruneLedger(before: number): number {
    const sql = this.ctx.storage.sql;
    let removed = 0;
    this.ctx.storage.transactionSync(() => {
      const old = sql
        .exec(
          "SELECT COUNT(*) AS n, COALESCE(SUM(coins), 0) AS coins, COALESCE(SUM(gems), 0) AS gems FROM ledger WHERE created_at < ?",
          before,
        )
        .one();
      removed = Number(old.n);
      if (removed === 0) return;
      sql.exec(
        "UPDATE profile SET base_coins = base_coins + ?, base_gems = base_gems + ? WHERE id = 1",
        Number(old.coins),
        Number(old.gems),
      );
      sql.exec("DELETE FROM ledger WHERE created_at < ?", before);
    });
    return removed;
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
    // 没有办法从外面定时遍历所有玩家对象，所以每个对象在被用到时顺手清理自己：每天最多一次。
    const pruned = Number(sql.exec("SELECT pruned_at FROM profile WHERE id = 1").one().pruned_at);
    if (now - pruned > DAY_MS) {
      // 顺便对一次账。对不上说明有代码绕过流水改了余额，这是必须有人看的错误。
      const audit = this.audit();
      if (!audit.ok) log.error("audit_mismatch", { playerId: this.id, ...audit });
      this.pruneLedger(now - LEDGER_RETENTION_MS);
      sql.exec("UPDATE profile SET pruned_at = ? WHERE id = 1", now);
    }
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

  /**
   * 封禁并让所有会话失效。已经签发的访问令牌最长还能用到它自己过期。
   * 返回这个玩家此刻可能所在的房间，调用方据此把他从对局里移出去。
   */
  ban(): string | null {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE profile SET banned = 1 WHERE id = 1");
      this.ctx.storage.sql.exec("DELETE FROM session");
    });
    return this.getCurrentRoom();
  }

  unban(): void {
    this.ctx.storage.sql.exec("UPDATE profile SET banned = 0 WHERE id = 1");
  }

  /**
   * 执行一次资产变更并写流水。必须在事务里调用。
   * allowDebt 只在退款时为真：这时货币可以扣成负数，物品最少扣到 0。
   */
  private applyDelta(opId: string, kind: string, delta: Delta, now: number, allowDebt = false): TxResult {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM ledger WHERE op_id = ?", opId).toArray().length > 0) return "duplicate";

    const coins = delta.coins ?? 0;
    const gems = delta.gems ?? 0;
    const items = Object.entries(delta.items ?? {}).filter(([, qty]) => qty !== 0);
    const held = new Map<string, number>();
    for (const [itemId] of items) {
      const row = sql.exec("SELECT qty FROM item WHERE item_id = ?", itemId).toArray()[0];
      held.set(itemId, row ? Number(row.qty) : 0);
    }

    // 先检查，再修改。任何一项不够，整个操作都不做。
    if (!allowDebt) {
      const balance = sql.exec("SELECT coins, gems FROM profile WHERE id = 1").one();
      if (Number(balance.coins) + coins < 0 || Number(balance.gems) + gems < 0) return "insufficient";
      if (items.some(([itemId, qty]) => held.get(itemId)! + qty < 0)) return "insufficient";
    }

    sql.exec("UPDATE profile SET coins = coins + ?, gems = gems + ? WHERE id = 1", coins, gems);
    for (const [itemId, qty] of items) {
      sql.exec(
        `INSERT INTO item (item_id, qty) VALUES (?, ?)
         ON CONFLICT (item_id) DO UPDATE SET qty = excluded.qty`,
        itemId,
        Math.max(0, held.get(itemId)! + qty),
      );
    }
    sql.exec(
      "INSERT INTO ledger (op_id, kind, coins, gems, items, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      opId,
      kind,
      coins,
      gems,
      items.length > 0 ? JSON.stringify(Object.fromEntries(items)) : null,
      now,
    );
    return "ok";
  }

  /** 把订单的当前状态发给 D1 里的支付记录。必须在事务里调用。 */
  private emitPayment(orderId: string, now: number): void {
    const row = this.ctx.storage.sql.exec("SELECT * FROM purchase WHERE order_id = ?", orderId).one();
    const analytics = this.ctx.storage.sql.exec("SELECT analytics_id FROM profile WHERE id = 1").one().analytics_id;
    this.emit({
      type: "payment",
      playerId: this.id,
      orderId,
      productId: String(row.product_id),
      provider: String(row.provider),
      amount: Number(row.amount),
      currency: String(row.currency),
      status: row.status as OrderStatus,
      externalId: row.external_id === null ? null : String(row.external_id),
      analyticsId: analytics === null ? null : String(analytics),
      createdAt: Number(row.created_at),
      paidAt: row.paid_at === null ? 0 : Number(row.paid_at),
      at: now,
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
    // 最旧的一条通知已经等了多久。正常情况下接近 0，持续变大说明通知送不出去。
    const oldest = (JSON.parse(String(rows[0]!.body)) as { at?: number }).at;
    const lag = typeof oldest === "number" ? Math.max(0, Date.now() - oldest) : 0;
    try {
      await this.env.PLAYER_EVENTS.sendBatch(
        rows.map((row) => ({ body: { ...JSON.parse(String(row.body)), seq: Number(row.seq) } as PlayerEvent })),
      );
      sql.exec("DELETE FROM outbox WHERE seq <= ?", Number(rows[rows.length - 1]!.seq));
      metric(this.env, "outbox_flush", ["ok"], [rows.length, lag]);
      if (rows.length === OUTBOX_BATCH) await this.flush();
    } catch (error) {
      log.warn("outbox_flush_failed", { playerId: this.id, rows: rows.length, lagMs: lag, error });
      metric(this.env, "outbox_flush", ["failed"], [rows.length, lag]);
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
