import { DurableObject } from "cloudflare:workers";
import {
  applyAction,
  initialState,
  parseClientMessage,
  type Action,
  type RoomState,
  type ServerMessage,
} from "@game/shared";

const STATE_KEY = "state";

interface Attachment {
  playerId: string;
}

/**
 * 一个房间一个对象。这一层只做三件事：管理连接、调用规则、保存和广播状态。
 * 游戏规则全部在 @game/shared 里。
 */
export class Room extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const playerId = new URL(request.url).searchParams.get("player")!;

    const state = await this.load();
    const joined = applyAction(state, { type: "join", playerId });
    if (!joined.ok) {
      return new Response(joined.error, { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    // 交给运行时托管连接，对象空闲时可以休眠。
    this.ctx.acceptWebSocket(server);
    // 附加数据跟着连接走，休眠后仍然能取回。
    server.serializeAttachment({ playerId } satisfies Attachment);

    await this.save(joined.state);
    this.broadcast({ type: "state", state: joined.state });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const { playerId } = ws.deserializeAttachment() as Attachment;
    const message = typeof raw === "string" ? parseClientMessage(raw) : null;
    if (!message) {
      this.send(ws, { type: "error", code: "bad_message" });
      return;
    }

    // 骰子点数由服务端生成，客户端只能请求"掷一次"。
    const action: Action =
      message.type === "roll" ? { type: "roll", playerId, dice: rollDice() } : { type: "ready", playerId };

    const result = applyAction(await this.load(), action);
    if (!result.ok) {
      this.send(ws, { type: "error", code: result.error });
      return;
    }
    await this.save(result.state);
    this.broadcast({ type: "state", state: result.state });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const { playerId } = ws.deserializeAttachment() as Attachment;
    // 同一个玩家可能开了多个连接，只有最后一个断开才算离开。
    const stillConnected = this.ctx
      .getWebSockets()
      .some((other) => other !== ws && (other.deserializeAttachment() as Attachment).playerId === playerId);
    if (stillConnected) return;

    const result = applyAction(await this.load(), { type: "leave", playerId });
    if (!result.ok) return;
    await this.save(result.state);
    this.broadcast({ type: "state", state: result.state }, ws);
  }

  /** 对象休眠后内存会清空，所以每次都从存储读取。 */
  private async load(): Promise<RoomState> {
    return (await this.ctx.storage.get<RoomState>(STATE_KEY)) ?? initialState();
  }

  private async save(state: RoomState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    ws.send(JSON.stringify(message));
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // 连接已经关闭，忽略。
      }
    }
  }
}

function rollDice(): number {
  const bytes = new Uint8Array(1);
  // 拒绝采样，避免取模带来的偏差。
  do {
    crypto.getRandomValues(bytes);
  } while (bytes[0]! >= 252);
  return (bytes[0]! % 6) + 1;
}
