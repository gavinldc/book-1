import type { RoomState, RuleError } from "./rules";

/** 客户端发给服务端的消息。 */
export type ClientMessage = { type: "ready" } | { type: "roll" };

/** 服务端发给客户端的消息。 */
export type ServerMessage =
  | { type: "state"; state: RoomState }
  | { type: "error"; code: RuleError | "bad_message" };

const CLIENT_TYPES = new Set<string>(["ready", "roll"]);

/** 解析并校验客户端消息。任何不合法的输入都返回 null。 */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return null;
    const type = (data as { type?: unknown }).type;
    if (typeof type !== "string" || !CLIENT_TYPES.has(type)) return null;
    return { type } as ClientMessage;
  } catch {
    return null;
  }
}
