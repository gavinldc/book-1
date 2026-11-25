import { authenticate, fail, handleAuth, json } from "./auth/routes";
import { authenticateWebSocket, PLAYER_HEADER } from "./auth/websocket";
import { saveRecords, type MatchRecord } from "./match/record";
import { handleEconomy } from "./economy/routes";
import { handleMatch } from "./match/routes";
import { storeDeadLetters } from "./obs/deadletter";
import { log } from "./obs/log";
import { handleAnalytics } from "./obs/analytics";
import { handleAdmin } from "./ops/admin";
import { runScheduled } from "./ops/jobs";
import { handleLiveops } from "./ops/routes";
import { handlePlayerEvents, type PlayerEvent } from "./social/events";
import { handleAccount } from "./security/account";
import { enforceRateLimit } from "./security/ratelimit";
import { handleSocial } from "./social/routes";

export { Identity } from "./identity";
export { Matchmaker } from "./matchmaker";
export { Player } from "./player";
export { Room } from "./room";

// 房间号是服务端生成的对象 ID，64 位十六进制。
const ROOM_WS = /^\/room\/([0-9a-f]{64})\/ws$/;

/** 按路径分发请求。 */
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return Response.json({ ok: true, environment: env.ENVIRONMENT });
  }

  // 所有业务接口之前先过限流。登录接口在自己的处理函数里限。
  const limited = await enforceRateLimit(request, env, url.pathname);
  if (limited) return limited;

  const analytics = await handleAnalytics(request, env, url.pathname);
  if (analytics) return analytics;

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

  const account = await handleAccount(request, env, url.pathname);
  if (account) return account;

  const match = ROOM_WS.exec(url.pathname);
  if (match) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return fail(426, "upgrade_required");
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

  return fail(404, "not_found");
}

export default {
  /**
   * 所有请求的入口：给每个请求一个编号，兜住没有被处理的异常。
   * 编号会出现在应答头和错误日志里，玩家报问题时带上它，就能直接找到那一次请求的日志。
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      log.error("unhandled_error", {
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        error,
      });
      // 错误的细节只进日志，不返回给客户端。
      response = Response.json({ error: "internal", requestId }, { status: 500 });
    }
    // WebSocket 的握手应答不能改动。
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    headers.set("X-Request-Id", requestId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },

  /**
   * 所有队列共用这个处理函数，按队列的名字分发。
   * 死信队列的名字以 -dlq 结尾，要先判断：它们的前缀和正常队列相同。
   */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue.endsWith("-dlq")) {
      await storeDeadLetters(batch, env);
    } else if (batch.queue.startsWith("match-log")) {
      // 对局记录整批写进 D1，抛出异常时整批重新投递。
      await saveRecords(
        env.DB,
        (batch as MessageBatch<MatchRecord>).messages.map((message) => message.body),
      );
    } else {
      // 玩家通知逐条确认。
      await handlePlayerEvents(batch as MessageBatch<PlayerEvent>, env);
    }
  },

  /** 定时触发器。waitUntil 让任务在处理函数返回之后继续跑完。 */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(controller.cron, controller.scheduledTime, env));
  },
} satisfies ExportedHandler<Env>;
