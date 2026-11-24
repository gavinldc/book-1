import { DurableObject } from "cloudflare:workers";
import {
  applyAction,
  CloseCode,
  currentPlayer,
  initialState,
  parseClientMessage,
  type Action,
  type RoomState,
  type RuleError,
  type ServerMessage,
} from "@game/shared";

import { PLAYER_HEADER, WS_PROTOCOL } from "./auth/websocket";

const STATE_KEY = "state";
const PENDING_KEY = "pending_settlement";
const TIMERS_KEY = "timers";

const WIN_COINS = 10;
/** 每个回合的思考时间。 */
export const TURN_MS = 30_000;
/** 结算失败后隔多久重试。 */
const RETRY_DELAY_MS = 5_000;
/** 对局结束后房间保留多久，让玩家看完结果。 */
export const LINGER_MS = 60_000;
/** 每条连接在一个时间窗口内最多发多少条消息。 */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 20;

/** 一局结束后要发给各个玩家对象的结算内容。发放成功之前一直保存在存储里。 */
interface PendingSettlement {
  matchId: string;
  results: { playerId: string; won: boolean; coins: number }[];
}

/**
 * 房间里所有"到点要做的事"。一个对象只有一个定时器，
 * 所以把各自的到期时间记在这里，定时器永远设在最早的那一个上。
 */
interface Timers {
  /** 当前回合的截止时间。 */
  turn?: number;
  /** 下一次重试结算的时间。 */
  settle?: number;
  /** 清理房间的时间。 */
  close?: number;
}

/** 跟着连接走的数据，休眠后仍然能取回。 */
interface Attachment {
  playerId: string;
  windowStart: number;
  count: number;
}

/**
 * 一个房间一个对象。这一层只做几件事：管理连接、调用规则、保存和广播状态、管理定时。
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

    // 新加入和重连走的是同一个操作，由规则决定允不允许。
    const before = await this.load();
    const joined = applyAction(before, { type: "join", playerId });
    if (!joined.ok) return new Response(joined.error, { status: 409 });

    // 同一个玩家只保留最新的一条连接，旧的被顶替。
    for (const old of this.ctx.getWebSockets(playerId)) {
      old.close(CloseCode.Replaced, "replaced");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    // 交给运行时托管连接，对象空闲时可以休眠。标签用来按玩家找连接。
    this.ctx.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({ playerId, windowStart: Date.now(), count: 0 } satisfies Attachment);

    if (joined.state !== before) {
      // 状态变了，所有人（包括新连接）都会收到广播。
      await this.commit(before, joined.state);
    } else {
      // 状态没变（比如同一个玩家开了第二个窗口），只给新连接发一份完整状态。
      this.send(server, await this.snapshot(joined.state));
    }

    // 客户端声明了子协议，应答里必须选定其中一个，否则浏览器会断开连接。
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": WS_PROTOCOL },
    });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment;
    if (!this.allow(ws, attachment)) return;

    const message = typeof raw === "string" ? parseClientMessage(raw) : null;
    if (!message) {
      this.send(ws, { type: "error", code: "bad_message" });
      return;
    }
    const { playerId } = attachment;

    let action: Action;
    switch (message.type) {
      case "ready":
        action = { type: "ready", playerId };
        break;
      case "leave":
        action = { type: "leave", playerId };
        break;
      case "roll": {
        // 客户端是看着某个版本的状态做出这个操作的。版本对不上，说明它看到的已经过时。
        if (message.version !== (await this.load()).version) {
          this.send(ws, { type: "error", code: "stale_version" });
          return;
        }
        // 骰子点数由服务端生成，客户端只能请求"掷一次"。
        action = { type: "roll", playerId, dice: rollDice() };
        break;
      }
    }

    const error = await this.apply(action);
    if (error) this.send(ws, { type: "error", code: error });
    if (message.type === "leave") {
      try {
        ws.close(1000, "left");
      } catch {
        // 房间清理时已经关过了。
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      // 回应对方的关闭，完成关闭握手。
      ws.close();
    } catch {
      // 已经关闭。
    }
    await this.onGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onGone(ws);
  }

  /** 管理接口：把一个玩家移出房间。对局中等同于弃权。 */
  async kick(playerId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(playerId)) {
      ws.close(CloseCode.Kicked, "kicked");
    }
    await this.apply({ type: "leave", playerId });
  }

  /** 仅供测试和排查使用：列出存储里还有哪些键。 */
  async debugStorageKeys(): Promise<string[]> {
    return [...(await this.ctx.storage.list()).keys()];
  }

  /** 定时器到点。可能有不止一件事到期，也可能被提前或重复触发，所以每件事都自己检查时间。 */
  async alarm(): Promise<void> {
    const due = (at: number | undefined) => at !== undefined && at <= Date.now();

    if (due((await this.timers()).close)) {
      await this.destroy();
      return;
    }
    if (due((await this.timers()).turn)) {
      const playerId = currentPlayer(await this.load());
      if (playerId) await this.apply({ type: "timeout", playerId });
    }
    if (due((await this.timers()).settle)) {
      await this.settle();
    }
    // 还有没到期的事，把定时器重新设上。
    await this.arm(await this.timers());
  }

  /** 连接断开。只有这个玩家的最后一条连接断开才算掉线。 */
  private async onGone(ws: WebSocket): Promise<void> {
    const { playerId } = ws.deserializeAttachment() as Attachment;
    if (this.ctx.getWebSockets(playerId).some((other) => other !== ws)) return;
    await this.apply({ type: "disconnect", playerId });
  }

  /** 把一个操作交给规则处理，成功就保存、广播，并在对局结束时结算。 */
  private async apply(action: Action): Promise<RuleError | null> {
    const before = await this.load();
    const result = applyAction(before, action);
    if (!result.ok) return result.error;
    if (result.state !== before) await this.commit(before, result.state);
    return null;
  }

  /**
   * 保存新状态并广播。状态、待结算记录和定时安排在一次写入里完成，
   * 它们要么都成功，要么都不成功。
   */
  private async commit(before: RoomState, after: RoomState): Promise<void> {
    // 还没开局、人已经走光：房间没有存在的必要了。
    if (after.phase === "waiting" && after.players.length === 0) {
      await this.destroy();
      return;
    }

    const timers = await this.timers();
    if (after.phase !== "playing") {
      delete timers.turn;
    } else if (currentPlayer(before) !== currentPlayer(after)) {
      // 换人了才重新计时；同一个人的回合里发生别的事（比如有人掉线）不会让他多出时间。
      timers.turn = Date.now() + TURN_MS;
    }

    const writes: Record<string, unknown> = { [STATE_KEY]: after, [TIMERS_KEY]: timers };
    if (before.phase === "playing" && after.phase === "finished") {
      writes[PENDING_KEY] = {
        matchId: crypto.randomUUID(),
        // 中途离开和弃权的人也在名单里，他们同样打了这一局。
        results: [...after.players.map((p) => p.id), ...after.forfeited].map((playerId) => ({
          playerId,
          won: playerId === after.winner,
          coins: playerId === after.winner ? WIN_COINS : 0,
        })),
      } satisfies PendingSettlement;
    }
    await this.ctx.storage.put(writes);
    await this.arm(timers);

    this.broadcast({ type: "state", state: after, deadline: timers.turn ?? null });
    if (after.phase === "finished") await this.settle();
  }

  /**
   * 把待结算记录发给各个玩家对象。玩家对象按 matchId 去重，所以这里可以重复执行。
   * 任何一步失败都保留记录，稍后由定时器重试。全部成功后安排清理房间。
   */
  private async settle(): Promise<void> {
    const pending = await this.ctx.storage.get<PendingSettlement>(PENDING_KEY);
    const timers = await this.timers();
    delete timers.settle;
    if (pending) {
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
        timers.settle = Date.now() + RETRY_DELAY_MS;
      }
    }
    // 结算发完之后才安排清理，没发完的房间不会被清掉。
    if (timers.settle === undefined && timers.close === undefined) {
      timers.close = Date.now() + LINGER_MS;
    }
    await this.ctx.storage.put(TIMERS_KEY, timers);
    await this.arm(timers);
  }

  /** 关闭所有连接并清空存储。之后这个对象不占任何存储空间，同名的房间可以重新开始。 */
  private async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(CloseCode.RoomClosed, "room closed");
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** 把定时器设在最早到期的那件事上；没有待办就取消定时器。 */
  private async arm(timers: Timers): Promise<void> {
    const times = Object.values(timers).filter((at): at is number => typeof at === "number");
    if (times.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
  }

  /** 限制每条连接的消息频率。计数放在连接的附加数据里，休眠后不会丢。 */
  private allow(ws: WebSocket, attachment: Attachment): boolean {
    const now = Date.now();
    const next =
      now - attachment.windowStart >= RATE_WINDOW_MS
        ? { ...attachment, windowStart: now, count: 1 }
        : { ...attachment, count: attachment.count + 1 };
    ws.serializeAttachment(next);
    if (next.count <= RATE_MAX_MESSAGES) return true;
    ws.close(CloseCode.TooManyMessages, "too many messages");
    return false;
  }

  /** 对象休眠后内存会清空，所以每次都从存储读取。 */
  private async load(): Promise<RoomState> {
    return (await this.ctx.storage.get<RoomState>(STATE_KEY)) ?? initialState();
  }

  private async timers(): Promise<Timers> {
    return (await this.ctx.storage.get<Timers>(TIMERS_KEY)) ?? {};
  }

  private async snapshot(state: RoomState): Promise<ServerMessage> {
    return { type: "state", state, deadline: (await this.timers()).turn ?? null };
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // 连接已经关闭，忽略。
    }
  }

  private broadcast(message: ServerMessage): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
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
