import { DurableObject } from "cloudflare:workers";
import {
  applyAction,
  initialState,
  parseClientMessage,
  type Action,
  type RoomState,
  type ServerMessage,
} from "@game/shared";

import { PLAYER_HEADER, WS_PROTOCOL } from "./auth/websocket";

const STATE_KEY = "state";
const PENDING_KEY = "pending_settlement";

const WIN_COINS = 10;
const RETRY_DELAY_MS = 5_000;

/** 一局结束后要发给各个玩家对象的结算内容。发放成功之前一直保存在存储里。 */
interface PendingSettlement {
  matchId: string;
  results: { playerId: string; won: boolean; coins: number }[];
}

interface Attachment {
  playerId: string;
}

/**
 * 一个房间一个对象。这一层只做三件事：管理连接、调用规则、保存和广播状态。
 * 游戏规则全部在 @game/shared 里。
 */
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 心跳由平台直接应答，不会唤醒对象。
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    // 对象只能从入口 Worker 访问，这个请求头由入口在校验令牌之后写入。
    const playerId = request.headers.get(PLAYER_HEADER);
    if (!playerId) return new Response("缺少玩家身份", { status: 401 });

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
    // 客户端声明了子协议，应答里必须选定其中一个，否则浏览器会断开连接。
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": WS_PROTOCOL },
    });
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

    const before = await this.load();
    const result = applyAction(before, action);
    if (!result.ok) {
      this.send(ws, { type: "error", code: result.error });
      return;
    }
    await this.commit(before, result.state);
    this.broadcast({ type: "state", state: result.state });
    await this.settle();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const { playerId } = ws.deserializeAttachment() as Attachment;
    // 同一个玩家可能开了多个连接，只有最后一个断开才算离开。
    const stillConnected = this.ctx
      .getWebSockets()
      .some((other) => other !== ws && (other.deserializeAttachment() as Attachment).playerId === playerId);
    if (stillConnected) return;

    const before = await this.load();
    const result = applyAction(before, { type: "leave", playerId });
    if (!result.ok) return;
    await this.commit(before, result.state);
    this.broadcast({ type: "state", state: result.state }, ws);
    await this.settle();
  }

  /** 结算没发完时由定时器再试一次。 */
  async alarm(): Promise<void> {
    await this.settle();
  }

  /**
   * 保存新状态。如果这一步让对局结束，把待结算记录和状态一起写入，
   * 两者要么都成功，要么都不成功。
   */
  private async commit(before: RoomState, after: RoomState): Promise<void> {
    if (before.phase === "playing" && after.phase === "finished") {
      const pending: PendingSettlement = {
        matchId: crypto.randomUUID(),
        results: after.players.map((p) => ({
          playerId: p.id,
          won: p.id === after.winner,
          coins: p.id === after.winner ? WIN_COINS : 0,
        })),
      };
      await this.ctx.storage.put({ [STATE_KEY]: after, [PENDING_KEY]: pending });
      return;
    }
    await this.save(after);
  }

  /**
   * 把待结算记录发给各个玩家对象。玩家对象按 matchId 去重，所以这里可以重复执行。
   * 任何一步失败都保留记录，稍后由定时器重试。
   */
  private async settle(): Promise<void> {
    const pending = await this.ctx.storage.get<PendingSettlement>(PENDING_KEY);
    if (!pending) return;
    try {
      for (const r of pending.results) {
        await this.env.PLAYER.getByName(r.playerId).applyMatchResult(pending.matchId, {
          won: r.won,
          coins: r.coins,
        });
      }
      await this.ctx.storage.delete(PENDING_KEY);
    } catch (error) {
      console.error("结算失败，稍后重试", pending.matchId, error);
      await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
    }
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
