import { json } from "../auth/routes";
import { safeEqual } from "../auth/crypto";
import type { Order } from "../player";
import { PRODUCTS } from "./catalog";
import { parseRef, type OrderRef } from "./orders";

const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/** 向 Telegram 要一个付款链接。客户端拿到后用小程序的 openInvoice 打开。 */
export async function createInvoiceLink(env: Env, order: Order, ref: string): Promise<string> {
  const product = PRODUCTS[order.productId]!;
  // 机器人令牌在地址里，这个地址不能出现在任何日志和错误信息中。
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/createInvoiceLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: product.title,
      description: product.description,
      // 回调里会原样带回来，用它找到是哪个玩家的哪个订单。
      payload: ref,
      // 数字商品用 Stars 结算，不需要支付服务商的令牌。
      provider_token: "",
      currency: order.currency,
      prices: [{ label: product.title, amount: order.amount }],
    }),
  });
  const body = (await response.json()) as { ok: boolean; result?: string };
  if (!body.ok || !body.result) throw new Error(`createInvoiceLink 失败：${response.status}`);
  return body.result;
}

interface Update {
  pre_checkout_query?: { id: string; currency: string; total_amount: number; invoice_payload: string };
  message?: {
    successful_payment?: PaymentInfo;
    refunded_payment?: PaymentInfo;
  };
}

interface PaymentInfo {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
}

/**
 * Telegram 的回调。一次付款会先后来两个通知：
 * 付款前的确认（必须在 10 秒内答复），和付款成功的消息（这时才能发货）。
 */
export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  // 设置回调地址时指定的密钥，Telegram 每次请求都会带上。没有它，任何人都能伪造"付款成功"。
  const secret = request.headers.get(SECRET_HEADER);
  if (!secret || !(await safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))) {
    return new Response("forbidden", { status: 403 });
  }
  const update = (await request.json()) as Update;
  const now = Date.now();

  const query = update.pre_checkout_query;
  if (query) {
    const ref = parseRef(query.invoice_payload);
    const order = ref ? await env.PLAYER.getByName(ref.playerId).getOrder(ref.orderId) : null;
    const ok =
      order !== null &&
      order.status === "pending" &&
      order.provider === "telegram" &&
      order.currency === query.currency &&
      order.amount === query.total_amount;
    // 直接在回调的应答里调用 Bot API 的方法，省掉一次对外请求，也更容易赶上 10 秒的时限。
    return json({
      method: "answerPreCheckoutQuery",
      pre_checkout_query_id: query.id,
      ok,
      ...(ok ? {} : { error_message: "订单已失效，请重新下单" }),
    });
  }

  const paid = update.message?.successful_payment;
  if (paid) {
    const ref = parseRef(paid.invoice_payload);
    if (ref) await settle(env, ref, paid, now);
    return json({ ok: true });
  }

  const refunded = update.message?.refunded_payment;
  if (refunded) {
    const ref = parseRef(refunded.invoice_payload);
    const result = ref ? await env.PLAYER.getByName(ref.playerId).refundOrder(ref.orderId, now) : "not_found";
    // 付款的通知还没处理到：不答复成功，让 Telegram 稍后重发这条退款。
    if (result === "not_paid") return new Response("order not paid yet", { status: 409 });
    return json({ ok: true });
  }

  // 其他类型的通知不关心，但要答复成功，否则 Telegram 会一直重发。
  return json({ ok: true });
}

async function settle(env: Env, ref: OrderRef, paid: PaymentInfo, now: number): Promise<void> {
  // 这里抛出异常时，回调会返回 500，Telegram 稍后重发，发货不会丢。
  const result = await env.PLAYER.getByName(ref.playerId).fulfillOrder(
    ref.orderId,
    {
      provider: "telegram",
      amount: paid.total_amount,
      currency: paid.currency,
      externalId: paid.telegram_payment_charge_id,
    },
    now,
  );
  if (result === "not_found" || result === "mismatch") {
    // 钱已经收了，货却发不出去。重试没有用，需要人来处理：记下来，第 10 章给它加告警。
    console.error("收到付款但无法发货", { provider: "telegram", orderId: ref.orderId, result });
  }
}
