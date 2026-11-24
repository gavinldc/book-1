import { json } from "../auth/routes";
import { fromHex, hmacVerify } from "../auth/crypto";
import type { Order } from "../player";
import { PRODUCTS } from "./catalog";
import { parseRef } from "./orders";

const API = "https://api.stripe.com/v1";
/** 回调里的时间戳和当前时间最多差多少秒。超过的当作重放，拒绝。 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** 创建一个结账页面，返回它的地址和会话编号。 */
export async function createCheckoutSession(
  env: Env,
  order: Order,
  ref: string,
  returnUrl: string,
): Promise<{ id: string; url: string }> {
  const product = PRODUCTS[order.productId]!;
  const form = new URLSearchParams({
    mode: "payment",
    success_url: returnUrl,
    cancel_url: returnUrl,
    // 结账会话上带着订单的引用，付款成功的回调里会原样带回来。
    client_reference_id: ref,
    // 同一个引用也放在付款意向上，它会被复制到扣款记录，退款的回调里靠它找到订单。
    "payment_intent_data[metadata][ref]": ref,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": order.currency,
    "line_items[0][price_data][unit_amount]": String(order.amount),
    "line_items[0][price_data][product_data][name]": product.title,
  });
  const response = await fetch(`${API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      // 用订单号做幂等键：这个请求超时后重试，不会创建出第二个结账页面。
      "Idempotency-Key": order.orderId,
    },
    body: form,
  });
  if (!response.ok) throw new Error(`创建结账会话失败：${response.status}`);
  return (await response.json()) as { id: string; url: string };
}

interface Session {
  id: string;
  payment_status: string;
  amount_total: number;
  currency: string;
  client_reference_id: string | null;
  payment_intent: string | null;
}

/** 主动向 Stripe 查询一个结账会话，已经付款的话发货。用于回调迟迟不来的订单。 */
export async function syncCheckoutSession(env: Env, sessionId: string): Promise<string> {
  const response = await fetch(`${API}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!response.ok) throw new Error(`查询结账会话失败：${response.status}`);
  return fulfillSession(env, (await response.json()) as Session);
}

/** 校验 Stripe 回调的签名。签名的内容是"时间戳.原始请求体"，必须用收到的原文，不能先解析再序列化。 */
export async function verifyStripeSignature(
  secret: string,
  header: string | null,
  rawBody: string,
  nowSeconds: number,
): Promise<boolean> {
  if (!header) return false;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value) timestamp = value;
    // 密钥轮换期间会同时带着新旧两个签名，任何一个对得上都算通过。
    if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  for (const signature of signatures) {
    const bytes = fromHex(signature);
    if (bytes && (await hmacVerify(secret, `${timestamp}.${rawBody}`, bytes))) return true;
  }
  return false;
}

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const valid = await verifyStripeSignature(
    env.STRIPE_WEBHOOK_SECRET,
    request.headers.get("Stripe-Signature"),
    rawBody,
    Math.floor(Date.now() / 1000),
  );
  if (!valid) return new Response("bad signature", { status: 400 });

  const event = JSON.parse(rawBody) as { type: string; data: { object: Record<string, unknown> } };
  switch (event.type) {
    // 第二种是银行转账这类延迟到账的付款方式，到账时才会来。
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await fulfillSession(env, event.data.object as unknown as Session);
      break;
    // 退款和拒付都要把发出去的东西收回来。
    case "charge.refunded":
    case "charge.dispute.created": {
      const metadata = event.data.object.metadata as { ref?: string } | undefined;
      const ref = parseRef(metadata?.ref);
      const result = ref ? await env.PLAYER.getByName(ref.playerId).refundOrder(ref.orderId, Date.now()) : null;
      // 事件不保证按顺序到达。付款的事件还没处理到时不答复成功，让 Stripe 稍后重发这条退款。
      if (result === "not_paid") return new Response("order not paid yet", { status: 409 });
      break;
    }
  }
  // 不关心的事件也答复成功，否则 Stripe 会重试最长三天。
  return json({ received: true });
}

async function fulfillSession(env: Env, session: Session): Promise<string> {
  // 会话完成不等于钱到账。延迟到账的付款方式，这时的状态还不是 paid。
  if (session.payment_status !== "paid") return "unpaid";
  const ref = parseRef(session.client_reference_id);
  if (!ref) return "not_found";
  const result = await env.PLAYER.getByName(ref.playerId).fulfillOrder(
    ref.orderId,
    {
      provider: "stripe",
      amount: session.amount_total,
      currency: session.currency,
      externalId: session.payment_intent ?? session.id,
    },
    Date.now(),
  );
  if (result === "not_found" || result === "mismatch") {
    console.error("收到付款但无法发货", { provider: "stripe", orderId: ref.orderId, result });
  }
  return result;
}
