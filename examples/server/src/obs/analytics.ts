import { authenticate, fail, json, readBody } from "../auth/routes";
import type { PlayerEvent } from "../social/events";
import { log } from "./log";

type PaymentEvent = Extract<PlayerEvent, { type: "payment" }>;

const ENDPOINT = "https://www.google-analytics.com/mp/collect";
/** 补报的事件最多能往回标多久。超过的不带时间戳，按收到的时间算。 */
const MAX_BACKDATE_MS = 72 * 60 * 60 * 1000;
/** 客户端的分析标识：字母、数字、点、下划线、连字符。 */
const CLIENT_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * 玩家行为的埋点由客户端的 Firebase SDK 直接上报，不经过我们的后端。
 * 这里只做一件客户端做不了的事：把服务端确认过的付款和退款补报进同一个数据流。
 *
 * 这是锦上添花：收入以 D1 里的支付记录为准，这里报不上去不影响任何业务，也不重试。
 */
export async function reportPayment(env: Env, event: PaymentEvent): Promise<void> {
  if (event.status === "pending") return;
  // 没有配置数据流，或者这个玩家的客户端还没告诉我们它的分析标识：不报。
  if (!env.GA_MEASUREMENT_ID || !event.analyticsId) return;

  const stripe = event.provider === "stripe";
  const body: Record<string, unknown> = {
    // client_id 让这条事件和这个玩家在客户端产生的事件归到同一个人、同一台设备上。
    client_id: event.analyticsId,
    user_id: event.playerId,
    events: [
      {
        name: event.status === "paid" ? "purchase" : "refund",
        params: {
          // 订单号。同一笔付款被重复上报时，分析时可以按它去掉重复的。
          transaction_id: event.orderId,
          item_id: event.productId,
          payment_provider: event.provider,
          // 真实货币按规范填金额和币种。Stars 不是标准币种，单独放一个参数。
          ...(stripe
            ? { currency: event.currency.toUpperCase(), value: event.amount / 100 }
            : { stars: event.amount }),
          source: "server",
        },
      },
    ],
  };
  const at = event.status === "paid" ? event.paidAt : event.at;
  if (Date.now() - at < MAX_BACKDATE_MS) body.timestamp_micros = at * 1000;

  // 密钥在地址里，这个地址不能进日志。
  const url = `${ENDPOINT}?measurement_id=${encodeURIComponent(env.GA_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(env.GA_API_SECRET)}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 这个接口只要收到请求就返回 2xx，内容不合法也不会报错。非 2xx 说明请求本身有问题，重试没有用。
    if (!response.ok) log.warn("analytics_report_failed", { orderId: event.orderId, status: response.status });
  } catch (error) {
    log.warn("analytics_report_failed", { orderId: event.orderId, error });
  }
}

/** 客户端把 Firebase 给它的分析标识告诉服务端，服务端补报事件时用。 */
export async function handleAnalytics(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname !== "/analytics/client") return null;
  if (request.method !== "POST") return fail(405, "method_not_allowed");
  const claims = await authenticate(request, env);
  if (!claims) return fail(401, "unauthorized");
  const body = await readBody(request);
  const clientId = body?.clientId;
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) return fail(400, "bad_request");
  await env.PLAYER.getByName(claims.sub).setAnalyticsId(clientId);
  return json({ ok: true });
}
