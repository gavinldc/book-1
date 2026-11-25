import { authenticate, fail, handleAuth, json } from "./auth/routes";
import { authenticateWebSocket, PLAYER_HEADER } from "./auth/websocket";
import { saveRecords, type MatchRecord } from "./match/record";
import { handleEconomy } from "./economy/routes";
import { handleMatch } from "./match/routes";
import { handleAdmin } from "./ops/admin";
import { runScheduled } from "./ops/jobs";
import { handleLiveops } from "./ops/routes";
import { handlePlayerEvents, type PlayerEvent } from "./social/events";
import { handleSocial } from "./social/routes";

export { Identity } from "./identity";
export { Matchmaker } from "./matchmaker";
export { Player } from "./player";
export { Room } from "./room";

// 房间号是服务端生成的对象 ID，64 位十六进制。
const ROOM_WS = /^\/room\/([0-9a-f]{64})\/ws$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, environment: env.ENVIRONMENT });
    }

    if (url.pathname.startsWith("/auth/")) {
      return handleAuth(request, env, url.pathname);
    }

    if (url.pathname === "/me") {
      const claims = await authenticate(request, env);
      if (!claims) return fail(401, "unauthorized");
      // 玩家 ID 只从令牌里取，不接受客户端另外传入。
      const player = env.PLAYER.getByName(claims.sub);
      const [profile, account, currentRoom] = await Promise.all([
        player.getProfile(),
        player.getAccount(),
        player.getCurrentRoom(),
      ]);
      // currentRoom 只是提示：客户端拿它去连，连不上就当作没有进行中的对局。
      return json({ playerId: claims.sub, profile, identities: Object.keys(account.identities), currentRoom });
    }

    const matched = await handleMatch(request, env, url.pathname);
    if (matched) return matched;

    const social = await handleSocial(request, env, url.pathname);
    if (social) return social;

    const economy = await handleEconomy(request, env, url);
    if (economy) return economy;

    const liveops = await handleLiveops(request, env, url.pathname);
    if (liveops) return liveops;

    const admin = await handleAdmin(request, env, url);
    if (admin) return admin;

    const match = ROOM_WS.exec(url.pathname);
    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("需要 WebSocket 连接", { status: 426 });
      }
      const playerId = await authenticateWebSocket(request, env);
      if (!playerId) return fail(401, "unauthorized");

      // 先删掉客户端可能自带的同名请求头，再写入校验过的玩家 ID。
      const headers = new Headers(request.headers);
      headers.set(PLAYER_HEADER, playerId);
      let id: DurableObjectId;
      try {
        id = env.ROOM.idFromString(match[1]!);
      } catch {
        // 不是这个命名空间生成的 ID。
        return fail(404, "room_not_found");
      }
      const response = await env.ROOM.get(id).fetch(new Request(request, { headers }));
      // 进房成功后记下"这个玩家在这个房间"，重新打开游戏和封禁时用得上。
      if (response.status === 101) await env.PLAYER.getByName(playerId).setCurrentRoom(match[1]!);
      return response;
    }

    return new Response("Not Found", { status: 404 });
  },

  /**
   * 两个队列共用这个处理函数，按队列的名字分发。
   * 对局记录：整批写进 D1，抛出异常时整批重新投递。玩家通知：逐条确认。
   */
  async queue(batch: MessageBatch<MatchRecord | PlayerEvent>, env: Env): Promise<void> {
    if (batch.queue.startsWith("match-log")) {
      await saveRecords(
        env.DB,
        (batch as MessageBatch<MatchRecord>).messages.map((message) => message.body),
      );
    } else {
      await handlePlayerEvents(batch as MessageBatch<PlayerEvent>, env);
    }
  },

  /** 定时触发器。waitUntil 让任务在处理函数返回之后继续跑完。 */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(controller.cron, controller.scheduledTime, env));
  },
} satisfies ExportedHandler<Env, MatchRecord | PlayerEvent>;
