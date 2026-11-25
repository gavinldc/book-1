import { activeEvents, shopCost, variantOf } from "@game/shared";

import { authenticate, fail, json, readBody } from "../auth/routes";
import type { Delta } from "../economy/catalog";
import { loadConfig } from "./config";

const MAIL_ID = /^[A-Za-z0-9_-]{4,64}$/;

interface Broadcast {
  id: string;
  title: string;
  body: string;
  attachment: string;
  ends_at: number;
  registered_before: number;
}

/** 此刻有效的全服邮件。所有玩家读到的都一样。 */
async function activeBroadcasts(env: Env, now: number): Promise<Broadcast[]> {
  const rows = await env.DB.prepare(
    "SELECT id, title, body, attachment, ends_at, registered_before FROM broadcast_mail WHERE starts_at <= ? AND ends_at > ?",
  )
    .bind(now, now)
    .all<Broadcast>();
  return rows.results;
}

/** 玩家这一侧的运营接口：配置、邮件。不归这里管的路径返回 null。 */
export async function handleLiveops(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!["/config", "/mail", "/mail/claim"].includes(pathname)) return null;
  const claims = await authenticate(request, env);
  if (!claims) return fail(401, "unauthorized");
  const me = claims.sub;
  const player = env.PLAYER.getByName(me);
  const now = Date.now();

  if (pathname === "/config" && request.method === "GET") {
    const config = await loadConfig(env);
    // 版本没变就不用再传一遍内容。活动的开始和结束不改变版本，所以客户端按时间自己判断。
    const etag = `"v${config.version}"`;
    if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    const variants: Record<string, string | null> = {};
    for (const [key, experiment] of Object.entries(config.experiments)) {
      variants[key] = variantOf(me, key, experiment);
    }
    const body = {
      version: config.version,
      notice: config.notice,
      // 商品给出原价，以及此刻的实际价格。
      shop: Object.fromEntries(
        Object.entries(config.shop).map(([itemId, entry]) => [itemId, { ...entry, now: shopCost(config, itemId, now) }]),
      ),
      // 正在进行和将要开始的活动都发下去，客户端可以提前显示倒计时。
      events: config.events.filter((event) => event.endsAt > now),
      active: activeEvents(config, now).map((event) => event.id),
      variants,
      serverTime: now,
    };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ETag: etag } });
  }

  if (pathname === "/mail" && request.method === "GET") {
    const [personal, broadcasts, info] = await Promise.all([
      player.listMail(now),
      activeBroadcasts(env, now),
      player.getPublic(),
    ]);
    const eligible = broadcasts.filter((mail) => info.createdAt < mail.registered_before);
    const claimed = new Set(await player.hasOps(eligible.map((mail) => `mail:${mail.id}`)));
    return json({
      mail: [
        ...personal,
        ...eligible.map((mail) => ({
          id: mail.id,
          title: mail.title,
          body: mail.body,
          attachment: JSON.parse(mail.attachment) as Delta,
          expiresAt: mail.ends_at,
          claimed: claimed.has(`mail:${mail.id}`),
        })),
      ],
    });
  }

  if (pathname === "/mail/claim" && request.method === "POST") {
    const body = await readBody(request);
    const mailId = body?.mailId;
    if (typeof mailId !== "string" || !MAIL_ID.test(mailId)) return fail(400, "bad_request");

    // 先找自己邮箱里的；没有再看是不是一封全服邮件。
    let result = await player.claimMail(mailId, now);
    if (result === "not_found") {
      const mail = (await activeBroadcasts(env, now)).find((entry) => entry.id === mailId);
      if (!mail || (await player.getPublic()).createdAt >= mail.registered_before) return fail(404, "not_found");
      // 全服邮件没有"已领"的标记，领没领过看的是这个玩家的流水里有没有这个编号。
      result = await player.transact(`mail:${mailId}`, "mail", JSON.parse(mail.attachment) as Delta);
    }
    if (result === "expired") return fail(410, "expired");
    return json({ ok: true, duplicate: result === "duplicate", wallet: await player.getWallet() });
  }

  return fail(405, "method_not_allowed");
}
