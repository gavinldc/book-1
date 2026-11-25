import { savePayment } from "../economy/reconcile";
import { saveScores } from "./leaderboard";

/**
 * 玩家对象对外发出的通知。玩家对象先把它和自己的数据在同一个事务里写下来，
 * 再送进队列；消费者据此更新 D1 里的副本，或者去通知另一个玩家对象。
 * seq 是玩家对象里的发件序号，同一个玩家的通知按它分先后。
 */
export type PlayerEvent = { seq: number } & (
  | { type: "score"; playerId: string; rating: number; at: number }
  | { type: "friend_request"; from: string; to: string; at: number }
  | { type: "friend_accept"; from: string; to: string; at: number }
  | { type: "friend_remove"; from: string; to: string; at: number }
  | { type: "invited"; inviter: string; invitee: string; at: number }
  | { type: "invite_reward"; inviter: string; invitee: string; at: number }
  | {
      type: "payment";
      playerId: string;
      orderId: string;
      productId: string;
      provider: string;
      amount: number;
      currency: string;
      status: "pending" | "paid" | "refunded";
      externalId: string | null;
      createdAt: number;
      /** 付款成功的时间，还没付款时为 0。退款时仍然是原来那次付款的时间。 */
      paidAt: number;
      at: number;
    }
);

/** 玩家对象写进发件箱的内容。序号在送出时才加上。 */
export type PlayerEventDraft = PlayerEvent extends infer E ? (E extends unknown ? Omit<E, "seq"> : never) : never;

/** 出错的通知隔多久重新投递。 */
const RETRY_DELAY_SECONDS = 5;

/**
 * 玩家通知的消费者。每一种通知的处理都可以重复执行：
 * 队列至少投递一次，玩家对象重发时也会产生重复。
 */
export async function handlePlayerEvents(batch: MessageBatch<PlayerEvent>, env: Env): Promise<void> {
  // 分数更新合成一次批量写入。
  const scores = batch.messages.filter((message) => message.body.type === "score");
  if (scores.length > 0) {
    try {
      await saveScores(
        env.DB,
        scores.map((message) => message.body as Extract<PlayerEvent, { type: "score" }>),
      );
      for (const message of scores) message.ack();
    } catch (error) {
      console.error("写入排行榜失败", error);
      for (const message of scores) message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }

  // 其余的各自处理、各自确认：一条失败不影响同一批里的其他通知。
  for (const message of batch.messages) {
    if (message.body.type === "score") continue;
    try {
      await handleOne(message.body, env);
      message.ack();
    } catch (error) {
      console.error("处理玩家通知失败", message.body.type, error);
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}

async function handleOne(event: PlayerEvent, env: Env): Promise<void> {
  switch (event.type) {
    case "score":
      return;
    case "friend_request":
      await env.PLAYER.getByName(event.to).friendIncoming(event.from, event.at);
      return;
    case "friend_accept":
      await env.PLAYER.getByName(event.to).friendConfirm(event.from, event.at);
      return;
    case "friend_remove":
      await env.PLAYER.getByName(event.to).friendRemoved(event.from);
      return;
    case "payment":
      await savePayment(env.DB, event);
      return;
    case "invited":
      await env.DB.prepare("INSERT OR IGNORE INTO invite (invitee, inviter, created_at) VALUES (?, ?, ?)")
        .bind(event.invitee, event.inviter, event.at)
        .run();
      return;
    case "invite_reward":
      // 先发奖（玩家对象按被邀请人去重），再更新 D1 里的副本。
      await env.PLAYER.getByName(event.inviter).grantInviteReward(event.invitee);
      await env.DB.prepare(
        `INSERT INTO invite (invitee, inviter, created_at, rewarded_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (invitee) DO UPDATE SET rewarded_at = COALESCE(invite.rewarded_at, excluded.rewarded_at)`,
      )
        .bind(event.invitee, event.inviter, event.at, event.at)
        .run();
      return;
  }
}
