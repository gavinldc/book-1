import { authenticate, fail, handleAuth, json } from "./auth/routes";
import { authenticateWebSocket, PLAYER_HEADER } from "./auth/websocket";

export { Identity } from "./identity";
export { Player } from "./player";
export { Room } from "./room";

const ROOM_WS = /^\/room\/([A-Za-z0-9_-]{1,32})\/ws$/;

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
      return env.ROOM.getByName(match[1]!).fetch(new Request(request, { headers }));
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
