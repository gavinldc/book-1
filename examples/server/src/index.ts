export { Player } from "./player";
export { Room } from "./room";

const ROOM_WS = /^\/room\/([A-Za-z0-9_-]{1,32})\/ws$/;
const PLAYER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const PLAYER_PROFILE = /^\/player\/([A-Za-z0-9_-]{1,32})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, environment: env.ENVIRONMENT });
    }

    const profile = PLAYER_PROFILE.exec(url.pathname);
    if (profile) {
      // 通过 RPC 直接调用玩家对象上的方法。
      return Response.json(await env.PLAYER.getByName(profile[1]!).getProfile());
    }

    const match = ROOM_WS.exec(url.pathname);
    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("需要 WebSocket 连接", { status: 426 });
      }
      // 第 4 章会把这里换成真正的鉴权，目前直接信任查询参数里的玩家 ID。
      const playerId = url.searchParams.get("player") ?? "";
      if (!PLAYER_ID.test(playerId)) {
        return new Response("缺少合法的 player 参数", { status: 400 });
      }
      return env.ROOM.getByName(match[1]!).fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
