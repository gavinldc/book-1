import { authenticate, fail, json, readBody } from "../auth/routes";
import { percentileOf } from "../ops/jobs";
import { findPlayer } from "../security/directory";
import { RATING_BOARD, scoresOf, standingOf, topOf } from "./leaderboard";

/** 玩家 ID 的格式。不符合的直接拒绝，不去碰对应的对象。 */
const PLAYER_ID = /^p_[0-9a-f]{24}$/;
/** 榜单前列所有人看到的都一样，缓存这么久。 */
const TOP_CACHE_SECONDS = 30;
const TOP_CACHE_KEY = "https://cache.internal/leaderboard/rating/top";

/** 排行榜、好友、邀请相关的接口。不归这里管的路径返回 null。 */
export async function handleSocial(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const known = ["/leaderboard", "/leaderboard/friends", "/friends", "/invites", "/invite/accept"];
  if (!known.includes(pathname) && !pathname.startsWith("/friends/")) return null;

  const claims = await authenticate(request, env);
  if (!claims) return fail(401, "unauthorized");
  const me = claims.sub;
  const player = env.PLAYER.getByName(me);

  if (request.method === "GET") {
    switch (pathname) {
      case "/leaderboard": {
        // 榜单走缓存，自己的名次每次现查。两部分分开，缓存才能所有人共用。
        const standing = await standingOf(env.DB, RATING_BOARD, me);
        // 排在精确名次之外的玩家，告诉他超过了百分之多少的人。这个数来自定时重算的分布表。
        const percent = standing && standing.rank === null ? await percentileOf(env.DB, standing.score) : null;
        return json({ top: await cachedTop(env), me: standing && { ...standing, percent } });
      }
      case "/leaderboard/friends": {
        const friends = (await player.listFriends()).filter((f) => f.status === "friend").map((f) => f.playerId);
        return json({ entries: await scoresOf(env.DB, RATING_BOARD, [me, ...friends]) });
      }
      case "/friends":
        return json({ friends: await player.listFriends() });
      case "/invites": {
        const rows = await env.DB.prepare(
          "SELECT invitee, created_at, rewarded_at FROM invite WHERE inviter = ? ORDER BY created_at DESC LIMIT 50",
        )
          .bind(me)
          .all<{ invitee: string; created_at: number; rewarded_at: number | null }>();
        return json({
          invites: rows.results.map((row) => ({ playerId: row.invitee, rewarded: row.rewarded_at !== null })),
        });
      }
    }
    return fail(404, "not_found");
  }

  if (request.method !== "POST") return fail(405, "method_not_allowed");
  const body = await readBody(request);
  const target = body?.playerId;
  if (typeof target !== "string" || !PLAYER_ID.test(target)) return fail(400, "bad_request");
  const now = Date.now();

  switch (pathname) {
    case "/friends/request": {
      // 先在名录里确认对方是一个真实存在的玩家。查的是 D1，不会碰到那个 ID 对应的对象。
      if (target !== me && !(await findPlayer(env.DB, target))) return fail(404, "not_found");
      return result(await player.requestFriend(target, now));
    }
    case "/friends/accept":
      return result(await player.acceptFriend(target, now));
    case "/friends/remove":
      await player.removeFriend(target, now);
      return json({ ok: true });
    case "/invite/accept": {
      if (target === me) return fail(400, "self");
      const inviter = await findPlayer(env.DB, target);
      if (!inviter) return fail(404, "not_found");
      return result(await player.setInviter(target, inviter.createdAt, now));
    }
  }
  return fail(404, "not_found");
}

function result(outcome: string): Response {
  if (outcome === "ok") return json({ ok: true });
  // 目标是自己属于请求本身不对，其余的是和当前状态冲突。
  if (outcome === "self") return fail(400, outcome);
  return fail(outcome === "not_found" ? 404 : 409, outcome);
}

/** 榜单前列。先看这个数据中心的缓存，没有再查 D1。 */
async function cachedTop(env: Env): Promise<unknown> {
  const cache = caches.default;
  const hit = await cache.match(TOP_CACHE_KEY);
  if (hit) return hit.json();
  const top = await topOf(env.DB, RATING_BOARD);
  await cache.put(
    TOP_CACHE_KEY,
    Response.json(top, { headers: { "Cache-Control": `max-age=${TOP_CACHE_SECONDS}` } }),
  );
  return top;
}
