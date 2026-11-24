import { authenticate, fail, json } from "../auth/routes";
import { authenticateWebSocket, PLAYER_HEADER } from "../auth/websocket";
import { pickReplay } from "./record";
import { RATING_HEADER, REGION_HEADER, REGIONS, regionOf } from "./region";

/** 匹配、开房相关的接口。不归这里管的路径返回 null。 */
export async function handleMatch(request: Request, env: Env, pathname: string): Promise<Response | null> {
  // 排队：一条 WebSocket，连上就是入队。
  if (pathname === "/match/ws") {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("需要 WebSocket 连接", { status: 426 });
    }
    const playerId = await authenticateWebSocket(request, env);
    if (!playerId) return fail(401, "unauthorized");

    const player = env.PLAYER.getByName(playerId);
    const [profile, account] = await Promise.all([player.getProfile(), player.getAccount()]);
    if (account.banned) return fail(403, "banned");

    // 地区取自请求进入 Cloudflare 的位置，分数取自玩家对象，都不由客户端提供。
    const region = regionOf(request.cf?.continent as string | undefined);
    const headers = new Headers(request.headers);
    headers.set(PLAYER_HEADER, playerId);
    headers.set(RATING_HEADER, String(profile.rating));
    headers.set(REGION_HEADER, region);
    return env.MATCHMAKER.getByName(`ranked:${region}`, { locationHint: REGIONS[region].hint }).fetch(
      new Request(request, { headers }),
    );
  }

  // 好友房：服务端生成房间号，建房的人拿去分享。知道房间号的人都可以进。
  if (pathname === "/rooms" && request.method === "POST") {
    const claims = await authenticate(request, env);
    if (!claims) return fail(401, "unauthorized");
    const id = env.ROOM.newUniqueId();
    await env.ROOM.get(id).open({ kind: "private", allowed: null, ratings: {}, bots: [] });
    return json({ roomId: id.toString() });
  }

  // 镜像对战：对手是另一个玩家过去某一局的录像，不需要对方在线，也不需要排队。
  if (pathname === "/mirror" && request.method === "POST") {
    const claims = await authenticate(request, env);
    if (!claims) return fail(401, "unauthorized");
    const profile = await env.PLAYER.getByName(claims.sub).getProfile();
    const replay = await pickReplay(env.DB, profile.rating, claims.sub);
    // 录像池里没有合适的对手时，退回到普通的机器人。
    const opponent = replay
      ? { id: `ghost:${replay.playerId}`, rolls: replay.rolls }
      : { id: `bot:${crypto.randomUUID().slice(0, 8)}`, rolls: [] };
    const id = env.ROOM.newUniqueId();
    await env.ROOM.get(id).open({
      kind: "mirror",
      allowed: [claims.sub],
      ratings: { [claims.sub]: profile.rating },
      bots: [opponent],
    });
    return json({ roomId: id.toString(), opponent: opponent.id });
  }

  return null;
}
