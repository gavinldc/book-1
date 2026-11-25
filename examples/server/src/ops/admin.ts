import { fail, json, readBody } from "../auth/routes";
import type { Delta } from "../economy/catalog";
import { totalsBetween } from "../economy/reconcile";
import { syncCheckoutSession } from "../economy/stripe";
import { verifyAccess, type Admin } from "./access";
import { loadConfig, loadConfigVersion, publishConfig } from "./config";

const PLAYER_PATH = /^\/admin\/players\/(p_[0-9a-f]{24})(\/[a-z]+)?$/;
const MAIL_ID = /^[A-Za-z0-9_-]{4,64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 一封邮件的附件最多能发多少。防的不是坏人，是手滑多打的一个零。 */
const MAX_ATTACHMENT = { coins: 10_000, gems: 1_000, itemQty: 100 };

/** 管理后台的接口。全部要求经过 Cloudflare Access，并且每一次修改都留记录。 */
export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/admin/")) return null;
  const admin = await verifyAccess(request, env);
  if (!admin) return fail(403, "forbidden");
  const { pathname } = url;
  const now = Date.now();
  const body = request.method === "GET" ? {} : await readBody(request);
  if (!body) return fail(400, "bad_request");

  // ---- 配置 ----
  if (pathname === "/admin/config") {
    if (request.method === "GET") return json(await loadConfig(env));
    if (request.method !== "PUT") return fail(405, "method_not_allowed");
    const result = await publishConfig(env, body);
    if (typeof result === "string") return json({ error: "invalid_config", detail: result }, 400);
    await record(env, admin, "config.publish", "config", { version: result.version }, now);
    return json(result);
  }

  // 回滚：把某个历史版本的内容作为一个新版本重新发布。版本号只增不减。
  if (pathname === "/admin/config/rollback" && request.method === "POST") {
    const old = typeof body.version === "number" ? await loadConfigVersion(env, body.version) : null;
    if (!old) return fail(404, "not_found");
    const current = await loadConfig(env);
    const result = await publishConfig(env, { ...old, version: current.version + 1 });
    if (typeof result === "string") return json({ error: "invalid_config", detail: result }, 400);
    await record(env, admin, "config.rollback", "config", { to: body.version, version: result.version }, now);
    return json(result);
  }

  // ---- 全服邮件 ----
  if (pathname === "/admin/mail/broadcast" && request.method === "POST") {
    const mail = parseMail(body);
    if (!mail) return fail(400, "bad_request");
    const days = typeof body.days === "number" && body.days > 0 && body.days <= 30 ? body.days : 7;
    // 只写一行。玩家打开邮箱时才会读到它，不需要逐个投递。
    await env.DB.prepare(
      `INSERT OR IGNORE INTO broadcast_mail (id, title, body, attachment, starts_at, ends_at, registered_before)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(mail.id, mail.title, mail.body, JSON.stringify(mail.attachment), now, now + days * DAY_MS, now)
      .run();
    await record(env, admin, "mail.broadcast", mail.id, mail, now);
    return json({ ok: true });
  }

  // ---- 对账 ----
  if (pathname === "/admin/payments/totals" && request.method === "GET") {
    const day = Date.parse(`${url.searchParams.get("day") ?? ""}T00:00:00Z`);
    if (Number.isNaN(day)) return fail(400, "bad_request");
    return json({ totals: await totalsBetween(env.DB, day, day + DAY_MS) });
  }

  // ---- 单个玩家 ----
  const match = PLAYER_PATH.exec(pathname);
  if (!match) return fail(404, "not_found");
  const playerId = match[1]!;
  const action = match[2] ?? "";
  const player = env.PLAYER.getByName(playerId);
  if (!(await player.getPublic()).exists) return fail(404, "not_found");

  if (action === "" && request.method === "GET") {
    const [profile, account, wallet, audit, ledger, room] = await Promise.all([
      player.getProfile(),
      player.getAccount(),
      player.getWallet(),
      player.audit(),
      player.getLedger(50),
      player.getCurrentRoom(),
    ]);
    return json({ playerId, profile, account, wallet, audit, ledger, currentRoom: room });
  }
  if (request.method !== "POST") return fail(405, "method_not_allowed");
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "";

  switch (action) {
    case "/ban": {
      // 管理操作必须说明原因。几个月后有人问"为什么封他"，答案只能从这里来。
      if (reason === "") return fail(400, "reason_required");
      const roomId = await player.ban();
      let kicked = false;
      if (roomId) {
        try {
          await env.ROOM.get(env.ROOM.idFromString(roomId)).kick(playerId);
          kicked = true;
        } catch (error) {
          // 房间可能已经结束。封禁本身已经生效，踢不到不算失败。
          console.error("封禁后踢出失败", roomId, error);
        }
      }
      await record(env, admin, "player.ban", playerId, { reason, roomId, kicked }, now);
      return json({ ok: true, kicked });
    }
    case "/unban":
      if (reason === "") return fail(400, "reason_required");
      await player.unban();
      await record(env, admin, "player.unban", playerId, { reason }, now);
      return json({ ok: true });
    case "/mail": {
      const mail = parseMail(body);
      if (!mail) return fail(400, "bad_request");
      await player.sendMail({ ...mail, expiresAt: now + 30 * DAY_MS }, now);
      await record(env, admin, "player.mail", playerId, mail, now);
      return json({ ok: true });
    }
    case "/sync": {
      // 手动补单：让服务端去支付平台核实一个订单。结果以支付平台的答复为准，不由操作的人说了算。
      const order = typeof body.orderId === "string" ? await player.getOrder(body.orderId) : null;
      if (!order) return fail(404, "not_found");
      if (order.status === "pending" && order.provider === "stripe" && order.externalId) {
        await syncCheckoutSession(env, order.externalId);
      }
      const status = (await player.getOrder(order.orderId))!.status;
      await record(env, admin, "order.sync", playerId, { orderId: order.orderId, status }, now);
      return json({ status });
    }
  }
  return fail(404, "not_found");
}

function parseMail(body: Record<string, unknown>) {
  const { id, title, body: text, attachment } = body;
  if (typeof id !== "string" || !MAIL_ID.test(id)) return null;
  if (typeof title !== "string" || title === "" || title.length > 50) return null;
  if (typeof text !== "string" || text.length > 500) return null;
  const parsed = parseAttachment(attachment);
  return parsed ? { id, title, body: text, attachment: parsed } : null;
}

/** 附件只能是增加，并且有上限。 */
function parseAttachment(input: unknown): Delta | null {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null) return null;
  const { coins = 0, gems = 0, items = {} } = input as { coins?: unknown; gems?: unknown; items?: unknown };
  const within = (value: unknown, max: number): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
  if (!within(coins, MAX_ATTACHMENT.coins) || !within(gems, MAX_ATTACHMENT.gems)) return null;
  if (typeof items !== "object" || items === null) return null;
  const granted: Record<string, number> = {};
  for (const [itemId, qty] of Object.entries(items)) {
    if (!within(qty, MAX_ATTACHMENT.itemQty)) return null;
    granted[itemId] = qty;
  }
  return { coins, gems, items: granted };
}

/** 记一条操作记录。先做事再记录：记录失败会让接口报错，但不会出现"记了却没做"。 */
async function record(env: Env, admin: Admin, action: string, target: string, detail: unknown, now: number) {
  await env.DB.prepare("INSERT INTO admin_log (at, admin, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(now, admin.email, action, target, JSON.stringify(detail))
    .run();
}
