import { authenticate, fail, json, readBody } from "../auth/routes";
import { verifyAdCallback } from "./admob";
import { shopCost } from "@game/shared";

import { loadConfig } from "../ops/config";
import { combine, PRODUCTS, type Provider } from "./catalog";
import { formatRef, newOrderId } from "./orders";
import { createCheckoutSession, handleStripeWebhook, syncCheckoutSession } from "./stripe";
import { createInvoiceLink, handleTelegramWebhook } from "./telegram";

const PLAYER_ID = /^p_[0-9a-f]{24}$/;
const ORDER_ID = /^o_[0-9a-f]{24}$/;
/** 客户端为一次购买生成的编号。同一个编号重复提交只扣一次钱。 */
const CLIENT_OP_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** 钱包、商店、支付和广告相关的接口。不归这里管的路径返回 null。 */
export async function handleEconomy(request: Request, env: Env, url: URL): Promise<Response | null> {
  const { pathname } = url;

  // 三个回调接口不走玩家的登录，各自校验来源。
  if (pathname === "/webhooks/telegram" && request.method === "POST") return handleTelegramWebhook(request, env);
  if (pathname === "/webhooks/stripe" && request.method === "POST") return handleStripeWebhook(request, env);
  if (pathname === "/webhooks/admob" && request.method === "GET") return handleAdCallback(env, url);

  if (!["/wallet", "/shop/buy", "/pay/orders", "/pay/orders/sync"].includes(pathname)) return null;
  const claims = await authenticate(request, env);
  if (!claims) return fail(401, "unauthorized");
  const player = env.PLAYER.getByName(claims.sub);

  if (pathname === "/wallet" && request.method === "GET") return json(await player.getWallet());
  if (request.method !== "POST") return fail(405, "method_not_allowed");
  const body = await readBody(request);
  if (!body) return fail(400, "bad_request");

  if (pathname === "/shop/buy") {
    if (typeof body.itemId !== "string" || typeof body.opId !== "string" || !CLIENT_OP_ID.test(body.opId)) {
      return fail(400, "bad_request");
    }
    // 商品和价格来自运营配置，价格里已经算上了此刻正在进行的折扣。
    const config = await loadConfig(env);
    const price = shopCost(config, body.itemId, Date.now());
    if (!price) return fail(400, "bad_request");
    // 扣钱和给东西是同一次变更，不会出现扣了钱没拿到东西。
    const cost = { coins: -price.coins, gems: -price.gems };
    const result = await player.transact(`buy:${body.opId}`, "buy", combine(cost, config.shop[body.itemId]!.grant));
    if (result === "insufficient") return fail(409, "insufficient");
    return json({ ok: true, duplicate: result === "duplicate", wallet: await player.getWallet() });
  }

  if (pathname === "/pay/orders") {
    const provider = body.provider;
    if (provider !== "telegram" && provider !== "stripe") return fail(400, "bad_request");
    if (typeof body.productId !== "string" || !PRODUCTS[body.productId]) return fail(400, "bad_request");

    // 先在自己这边记下订单，再去找支付平台。反过来的话，付款成功的回调可能找不到订单。
    const orderId = newOrderId();
    const order = await player.createOrder(orderId, body.productId, provider satisfies Provider, Date.now());
    if (order === "unknown") return fail(400, "bad_request");
    if (order === "too_many") return fail(429, "too_many_orders");

    const ref = formatRef({ playerId: claims.sub, orderId });
    if (provider === "telegram") {
      return json({ orderId, url: await createInvoiceLink(env, order, ref) });
    }
    const session = await createCheckoutSession(env, order, ref, `${url.origin}/`);
    await player.setOrderExternal(orderId, session.id);
    return json({ orderId, url: session.url });
  }

  // 付完钱回到游戏却没到账时，客户端可以让服务端主动去支付平台查一次。
  if (pathname === "/pay/orders/sync") {
    if (typeof body.orderId !== "string" || !ORDER_ID.test(body.orderId)) return fail(400, "bad_request");
    const order = await player.getOrder(body.orderId);
    if (!order) return fail(404, "not_found");
    if (order.status === "pending" && order.provider === "stripe" && order.externalId) {
      await syncCheckoutSession(env, order.externalId);
    }
    return json({ status: (await player.getOrder(body.orderId))!.status });
  }

  return fail(404, "not_found");
}

/** 广告平台的回调：玩家看完了一次激励广告。 */
async function handleAdCallback(env: Env, url: URL): Promise<Response> {
  const params = await verifyAdCallback(url, Date.now());
  if (!params) return new Response("bad signature", { status: 400 });
  const playerId = params.get("user_id") ?? "";
  const transactionId = params.get("transaction_id") ?? "";
  if (!PLAYER_ID.test(playerId) || transactionId === "" || transactionId.length > 128) {
    return new Response("bad request", { status: 400 });
  }
  const player = env.PLAYER.getByName(playerId);
  // 签名只能说明这次观看是真的，不能说明这个玩家存在。
  if (!(await player.getPublic()).exists) return new Response("unknown player", { status: 404 });
  // 奖励多少由服务端决定，回调里的 reward_amount 只是广告后台里填的一个数，不使用。
  const result = await player.grantAdReward(transactionId, Date.now());
  return json({ result });
}
