import { DurableObject } from "cloudflare:workers";
import { CloseCode, planMatches, type QueueMessage, type Ticket } from "@game/shared";

import { PLAYER_HEADER, WS_PROTOCOL } from "./auth/websocket";
import { DEFAULT_REGION, isRegion, RATING_HEADER, REGION_HEADER, REGIONS, type Region } from "./match/region";

/** 开房失败后隔多久再试。 */
const RETRY_MS = 1_000;

/** 跟着排队连接走的数据。队列本身不另外保存：还连着的就是还在排的。 */
interface Attachment extends Ticket {
  region: Region;
  /** 已经配好、正在开房。开房期间不能再被配给别人。 */
  matched: boolean;
}

/**
 * 一个队列一个对象（示例里是每个地区一个）。
 * 玩家用一条 WebSocket 排队：连上就是入队，断开就是取消，配好后服务端发房间号并断开。
 */
export class Matchmaker extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const playerId = request.headers.get(PLAYER_HEADER);
    const rating = Number(request.headers.get(RATING_HEADER));
    const regionHeader = request.headers.get(REGION_HEADER);
    if (!playerId || !Number.isFinite(rating)) return new Response("缺少玩家身份", { status: 401 });

    // 同一个玩家只能排一次，新的连接顶替旧的。
    for (const old of this.ctx.getWebSockets(playerId)) {
      old.close(CloseCode.Replaced, "replaced");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({
      playerId,
      rating,
      since: Date.now(),
      region: isRegion(regionHeader) ? regionHeader : DEFAULT_REGION,
      matched: false,
    } satisfies Attachment);
    this.send(server, { type: "queued" });

    await this.run();

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": WS_PROTOCOL },
    });
  }

  /** 排队的连接上不需要客户端发任何消息。 */
  webSocketMessage(ws: WebSocket): void {
    ws.close(1003, "unexpected message");
  }

  /** 连接断开就是取消排队。队列是从连接算出来的，不需要另外清理。 */
  webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      // 已经关闭。
    }
  }

  /** 到了某个人该放宽范围或者该补机器人的时间。 */
  async alarm(): Promise<void> {
    await this.run();
  }

  /** 算一遍当前谁能配上，给配上的人开房，并安排下一次计算的时间。 */
  private async run(): Promise<void> {
    const sockets = new Map<string, WebSocket>();
    const tickets: Attachment[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const ticket = ws.deserializeAttachment() as Attachment;
      if (ticket.matched) continue;
      sockets.set(ticket.playerId, ws);
      tickets.push(ticket);
    }

    const plan = planMatches(tickets, Date.now());
    const groups = [...plan.pairs, ...plan.solo.map((ticket) => [ticket])] as Attachment[][];

    // 开房要调用别的对象，等待期间新的连接可以进来并再次触发计算。
    // 所以在等待之前，先把这些人标成"已配好"，并把下一次计算的时间定下来。
    for (const group of groups) {
      for (const ticket of group) this.mark(sockets.get(ticket.playerId)!, ticket, true);
    }
    if (plan.nextCheck === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(plan.nextCheck);

    await Promise.all(groups.map((group) => this.start(group, sockets)));
  }

  /** 给配好的一组人开一个房间，然后把房间号发给他们。 */
  private async start(group: Attachment[], sockets: Map<string, WebSocket>): Promise<void> {
    const region = group[0]!.region;
    try {
      // 房间号由服务端生成。随机生成的 ID 不需要做全球范围的重名检查，首次访问更快。
      const id = this.env.ROOM.newUniqueId();
      // 房间建在这个队列所在的地区，而不是匹配对象恰好运行的地方。
      const room = this.env.ROOM.get(id, { locationHint: REGIONS[region].hint });
      await room.open({
        kind: "ranked",
        allowed: group.map((ticket) => ticket.playerId),
        ratings: Object.fromEntries(group.map((ticket) => [ticket.playerId, ticket.rating])),
        // 只有一个人时，用机器人补上另一个座位。
        bots: group.length === 1 ? [{ id: `bot:${crypto.randomUUID().slice(0, 8)}`, rolls: [] }] : [],
      });
      // 房间已经就绪，再通知玩家。玩家连过来时不会遇到一个还不存在的房间。
      for (const ticket of group) {
        const ws = sockets.get(ticket.playerId)!;
        this.send(ws, { type: "matched", roomId: id.toString() });
        ws.close(1000, "matched");
      }
    } catch (error) {
      console.error("开房失败，稍后重试", error);
      // 把人放回队列。他们的连接还在，下一次计算时会重新参与。
      for (const ticket of group) this.mark(sockets.get(ticket.playerId)!, ticket, false);
      const retryAt = Date.now() + RETRY_MS;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > retryAt) await this.ctx.storage.setAlarm(retryAt);
    }
  }

  private mark(ws: WebSocket, ticket: Attachment, matched: boolean): void {
    try {
      ws.serializeAttachment({ ...ticket, matched } satisfies Attachment);
    } catch {
      // 连接已经关闭，这个人已经不在队列里了。
    }
  }

  private send(ws: WebSocket, message: QueueMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // 连接已经关闭，忽略。
    }
  }
}
