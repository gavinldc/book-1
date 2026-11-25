import { DurableObject } from "cloudflare:workers";
import {
  applyAction,
  CloseCode,
  currentPlayer,
  initialState,
  isServerSeat,
  parseClientMessage,
  ratingDelta,
  type Action,
  type RoomState,
  type RuleError,
  type ServerMessage,
} from "@game/shared";

import { PLAYER_HEADER, WS_PROTOCOL } from "./auth/websocket";
import type { LogEntry, MatchRecord } from "./match/record";
import { log as logger } from "./obs/log";
import { metric } from "./obs/metrics";

const CONFIG_KEY = "config";
const LOG_KEY = "log";
const SEATS_KEY = "seats";
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
/** 匹配房：开房后这么久还没开局（有人没来、没准备），房间作废。 */
export const JOIN_MS = 30_000;
/** 好友房：建好后这么久还没开局，房间作废。 */
export const IDLE_MS = 10 * 60_000;
/** 机器人"思考"的时间：最短这么久，再加一段随机的时间。 */
export const BOT_MIN_MS = 1_000;
export const BOT_SPREAD_MS = 2_000;
/** 每条连接在一个时间窗口内最多发多少条消息。 */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 20;

/** 由服务端操作的座位。 */
export interface BotSeat {
  /** bot: 开头是补位的机器人，ghost: 开头是某个玩家的录像。 */
  id: string;
  /** 预先定好的点数，按顺序使用；用完之后（或者本来就是空的）随机掷。 */
  rolls: number[];
}

/** 开房时定下来、之后不再变的内容。 */
export interface RoomOptions {
  /** 好友房不计分；排位赛和镜像对战计分。 */
  kind: "private" | "ranked" | "mirror";
  /** 可以进这个房间的玩家。null 表示知道房间号的人都可以进。 */
  allowed: string[] | null;
  /** 开房时各个玩家的分数。 */
  ratings: Record<string, number>;
  bots: BotSeat[];
}

/** 一局结束后要送出去的东西：给玩家对象的结算，和给队列的对局记录。送达之前一直保存在存储里。 */
interface PendingSettlement {
  matchId: string;
  results: { playerId: string; won: boolean; coins: number; rating: number }[];
  /** 上一个版本的代码留下的待办里没有这一项。 */
  record?: MatchRecord;
}

/**
 * 房间里所有"到点要做的事"。一个对象只有一个定时器，
 * 所以把各自的到期时间记在这里，定时器永远设在最早的那一个上。
 */
interface Timers {
  /** 开局的最后期限。过了还在等待阶段，房间作废。 */
  start?: number;
  /** 轮到机器人时，它什么时候出手。 */
  bot?: number;
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

  /**
   * 开房。只有服务端（匹配对象或入口）能调用，没有开过的房间谁也连不进来。
   * 重复调用不会重新开一次，所以调用方超时后可以放心重试。
   */
  async open(options: RoomOptions): Promise<void> {
    if (await this.ctx.storage.get(CONFIG_KEY)) return;

    // 机器人和录像在开房时就入座并准备好，走的是和真实玩家一样的规则。
    let state = initialState();
    for (const bot of options.bots) {
      for (const type of ["join", "ready"] as const) {
        const result = applyAction(state, { type, playerId: bot.id });
        if (!result.ok) throw new Error(`机器人入座失败：${result.error}`);
        state = result.state;
      }
    }

    const timers: Timers = { start: Date.now() + (options.kind === "private" ? IDLE_MS : JOIN_MS) };
    await this.ctx.storage.put({ [CONFIG_KEY]: options, [STATE_KEY]: state, [TIMERS_KEY]: timers });
    await this.arm(timers);
  }

  async fetch(request: Request): Promise<Response> {
    // 对象只能从入口 Worker 访问，这个请求头由入口在校验令牌之后写入。
    const playerId = request.headers.get(PLAYER_HEADER);
    if (!playerId) return new Response("缺少玩家身份", { status: 401 });

    // 没有开过（或者已经清理）的房间不存在；有名单的房间只让名单上的人进。
    const options = await this.options();
    if (!options) return new Response("room_not_found", { status: 404 });
    if (options.allowed && !options.allowed.includes(playerId)) {
      return new Response("not_allowed", { status: 403 });
    }

    // 新加入和重连走的是同一个操作，由规则决定允不允许。
    const before = await this.load();
    const action: Action = { type: "join", playerId };
    const joined = applyAction(before, action);
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
      await this.commit(before, joined.state, action);
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
    // 该来的人没来齐，或者建了房一直没开局。
    if (due((await this.timers()).start) && (await this.load()).phase === "waiting") {
      await this.destroy();
      return;
    }
    if (due((await this.timers()).bot)) {
      await this.playBot();
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
    if (result.state !== before) await this.commit(before, result.state, action);
    return null;
  }

  /** 替当前轮到的机器人掷一次骰子。录像有预先定好的点数，按顺序取用。 */
  private async playBot(): Promise<void> {
    const botId = currentPlayer(await this.load());
    if (!botId || !isServerSeat(botId)) {
      // 已经不是机器人的回合了，把这个定时去掉。
      const timers = await this.timers();
      delete timers.bot;
      await this.ctx.storage.put(TIMERS_KEY, timers);
      return;
    }
    const seat = (await this.options())?.bots.find((bot) => bot.id === botId);
    // 这个座位已经走了几步，就从录像的第几步接着取。
    const played = (await this.log()).filter((entry) => entry.playerId === botId).length;
    const dice = seat?.rolls[played] ?? rollDice();
    await this.apply({ type: "roll", playerId: botId, dice });
  }

  /**
   * 保存新状态并广播。状态、待结算记录和定时安排在一次写入里完成，
   * 它们要么都成功，要么都不成功。
   */
  private async commit(before: RoomState, after: RoomState, action: Action): Promise<void> {
    // 还没开局、真人已经走光：房间没有存在的必要了。
    if (after.phase === "waiting" && !after.players.some((p) => !isServerSeat(p.id))) {
      await this.destroy();
      return;
    }

    const timers = await this.timers();
    const current = currentPlayer(after);
    if (after.phase !== "waiting") delete timers.start;
    if (after.phase !== "playing") {
      delete timers.turn;
    } else if (currentPlayer(before) !== current) {
      // 换人了才重新计时；同一个人的回合里发生别的事（比如有人掉线）不会让他多出时间。
      timers.turn = Date.now() + TURN_MS;
    }
    if (current && isServerSeat(current)) {
      // 轮到机器人：过一小段时间再出手，不要瞬间完成。
      if (currentPlayer(before) !== current || timers.bot === undefined) {
        timers.bot = Date.now() + BOT_MIN_MS + Math.floor(Math.random() * BOT_SPREAD_MS);
      }
    } else {
      delete timers.bot;
    }

    const writes: Record<string, unknown> = { [STATE_KEY]: after, [TIMERS_KEY]: timers };

    // 把这一步记下来。这份记录既是对局记录，也是以后镜像对战用的录像。
    let log: LogEntry[] | null = null;
    // 开局的那一刻记下座位顺序。重放一局时，谁先谁后要和当时一样。
    if (before.phase === "waiting" && after.phase === "playing") {
      writes[SEATS_KEY] = after.players.map((p) => p.id);
    }
    // 对局中的离开（包括被踢）也是会改变结果的一步，一样要记。
    const left = action.type === "leave" && before.phase === "playing";
    if (action.type === "roll" || action.type === "timeout" || left) {
      const entry = {
        playerId: action.playerId,
        dice: action.type === "roll" ? action.dice : action.type === "timeout" ? 0 : -1,
      };
      log = [...(await this.log()), entry];
      writes[LOG_KEY] = log;
    }

    if (before.phase === "playing" && after.phase === "finished") {
      const options = await this.options();
      const kind = options?.kind ?? "private";
      const matchId = crypto.randomUUID();
      // 中途离开和弃权的人也在名单里，他们同样打了这一局。
      const players = [...after.players.map((p) => p.id), ...after.forfeited];
      writes[PENDING_KEY] = {
        matchId,
        // 机器人和录像没有玩家对象，不需要结算。
        results: players
          .filter((playerId) => !isServerSeat(playerId))
          .map((playerId) => ({
            playerId,
            won: playerId === after.winner,
            coins: playerId === after.winner ? WIN_COINS : 0,
            rating: kind === "private" ? 0 : ratingDelta(playerId === after.winner),
          })),
        record: {
          matchId,
          kind,
          winner: after.winner,
          players,
          seats: await this.ctx.storage.get<string[]>(SEATS_KEY),
          ratings: options?.ratings ?? {},
          log: log ?? (await this.log()),
          endedAt: Date.now(),
        },
      } satisfies PendingSettlement;
    }
    await this.ctx.storage.put(writes);
    await this.arm(timers);

    this.broadcast({ type: "state", state: after, deadline: timers.turn ?? null });
    if (after.phase === "finished") await this.settle();
  }

  /**
   * 把结算发给各个玩家对象，把对局记录送进队列。接收方都按 matchId 去重，所以这里可以重复执行。
   * 任何一步失败都保留待办，稍后由定时器重试。全部成功后安排清理房间。
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
            rating: r.rating,
          });
        }
        // 对局记录送进队列。队列可能重复投递，消费者按 matchId 去重。
        if (pending.record) await this.env.MATCH_LOG.send(pending.record);
        await this.ctx.storage.delete(PENDING_KEY);
        metric(this.env, "settle", ["ok"], [1]);
        if (pending.record) {
          metric(this.env, "match_end", [pending.record.kind], [pending.record.log.length, pending.results.length]);
        }
      } catch (error) {
        logger.error("settle_failed", { matchId: pending.matchId, error });
        metric(this.env, "settle", ["retry"], [1]);
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

  /** 关闭所有连接并清空存储。之后这个对象不占任何存储空间，这个房间号也不再能连上。 */
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

  private async options(): Promise<RoomOptions | undefined> {
    return this.ctx.storage.get<RoomOptions>(CONFIG_KEY);
  }

  private async log(): Promise<LogEntry[]> {
    return (await this.ctx.storage.get<LogEntry[]>(LOG_KEY)) ?? [];
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
