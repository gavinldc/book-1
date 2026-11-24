import { authenticate, fail, handleAuth, json } from "./auth/routes";
import { authenticateWebSocket, PLAYER_HEADER } from "./auth/websocket";
import { saveRecords, type MatchRecord } from "./match/record";
import { handleMatch } from "./match/routes";

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
      const [profile, account] = await Promise.all([player.getProfile(), player.getAccount()]);
      return json({ playerId: claims.sub, profile, identities: Object.keys(account.identities) });
    }

    const matched = await handleMatch(request, env, url.pathname);
    if (matched) return matched;

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
      return env.ROOM.get(id).fetch(new Request(request, { headers }));
    }

    return new Response("Not Found", { status: 404 });
  },

  /** 对局记录的消费者：把一批记录写进 D1。抛出异常时整批会被重新投递，写入是幂等的。 */
  async queue(batch: MessageBatch<MatchRecord>, env: Env): Promise<void> {
    await saveRecords(
      env.DB,
      batch.messages.map((message) => message.body),
    );
  },
} satisfies ExportedHandler<Env, MatchRecord>;
