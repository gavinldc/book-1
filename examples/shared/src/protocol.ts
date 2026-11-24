import type { RoomState, RuleError } from "./rules";

/**
 * 客户端发给服务端的消息。
 * 会改变对局的操作要带上客户端当时看到的状态版本号，服务端据此拒绝过时的操作。
 */
export type ClientMessage = { type: "ready" } | { type: "roll"; version: number } | { type: "leave" };

/** 服务端发给客户端的消息。 */
export type ServerMessage =
  | {
      type: "state";
      state: RoomState;
      /** 当前回合的截止时间（Unix 毫秒），不在对局中时为 null。 */
      deadline: number | null;
    }
  | { type: "error"; code: RuleError | "bad_message" | "stale_version" };

/** 排队时服务端发给客户端的消息。排队的连接上，客户端不需要发任何消息，断开就是取消。 */
export type QueueMessage = { type: "queued" } | { type: "matched"; roomId: string };

/**
 * 由服务端操作的座位：补位的机器人（bot:）和镜像对战里的录像（ghost:）。
 * 真实玩家的 ID 是服务端生成的 UUID，不会带冒号。
 */
export function isServerSeat(playerId: string): boolean {
  return playerId.startsWith("bot:") || playerId.startsWith("ghost:");
}

/** 服务端主动断开连接时使用的关闭码。4000 到 4999 留给应用自己定义。 */
export const CloseCode = {
  /** 同一个玩家从别处连了进来，这条连接被顶替。 */
  Replaced: 4001,
  /** 被管理员移出房间。 */
  Kicked: 4002,
  /** 房间已经结束并清理。 */
  RoomClosed: 4003,
  /** 发消息太快。 */
  TooManyMessages: 4008,
} as const;

/** 单条消息的最大长度。合法的消息远小于这个值。 */
export const MAX_MESSAGE_LENGTH = 256;

/** 解析并校验客户端消息。任何不合法的输入都返回 null。 */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_LENGTH) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const message = data as { type?: unknown; version?: unknown };
  switch (message.type) {
    case "ready":
      return { type: "ready" };
    case "leave":
      return { type: "leave" };
    case "roll":
      // 只取认识的字段，重新组装一个对象，多余的字段不会被带进后面的逻辑。
      return Number.isSafeInteger(message.version) ? { type: "roll", version: message.version as number } : null;
    default:
      return null;
  }
}
