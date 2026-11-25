import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAdKeysForTest } from "../src/economy/admob";
import { savePayment, totalsBetween } from "../src/economy/reconcile";
import { SIGNATURE_TOLERANCE_SECONDS, verifyStripeSignature } from "../src/economy/stripe";
import { AD_DAILY_CAP, AD_REWARD_COINS, MAX_PENDING_ORDERS } from "../src/player";
import { BASE, get, guest, post, type Session } from "./helpers";

const player = (session: Session) => env.PLAYER.getByName(session.playerId);
const wallet = (session: Session) => player(session).getWallet();

/** 记录代码向外发出的请求，并按地址返回预先准备好的应答。 */
let outbound: { url: string; init?: RequestInit }[] = [];
let replies: Record<string, unknown> = {};

beforeEach(() => {
  outbound = [];
  replies = {
    "api.telegram.org": { ok: true, result: "https://t.me/$test-invoice" },
    "api.stripe.com": { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" },
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    outbound.push({ url, init });
    const host = Object.keys(replies).find((key) => url.includes(key));
    if (!host) throw new Error(`测试里没有准备这个地址的应答：${url}`);
    return Response.json(replies[host]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function order(session: Session, provider: "telegram" | "stripe", productId = "gems_100") {
  const response = await post("/pay/orders", { productId, provider }, { token: session.accessToken });
  expect(response.status).toBe(200);
  return (await response.json()) as { orderId: string; url: string };
}

function telegram(update: unknown, secret = env.TELEGRAM_WEBHOOK_SECRET) {
  return exports.default.fetch(
    new Request(`${BASE}/webhooks/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify(update),
    }),
  );
}

const paidUpdate = (session: Session, orderId: string, amount = 50, kind = "successful_payment") => ({
  message: {
    [kind]: {
      currency: "XTR",
      total_amount: amount,
      invoice_payload: `${session.playerId}:${orderId}`,
      telegram_payment_charge_id: `charge-${orderId}`,
    },
  },
});

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stripe(event: unknown, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const signature = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${timestamp}.${body}`);
  return exports.default.fetch(
    new Request(`${BASE}/webhooks/stripe`, {
      method: "POST",
      headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}` },
      body,
    }),
  );
}

const stripeSession = (session: Session, orderId: string, status = "paid") => ({
  id: "cs_test_1",
  payment_status: status,
  amount_total: 99,
  currency: "usd",
  client_reference_id: `${session.playerId}:${orderId}`,
  payment_intent: `pi_${orderId}`,
});

describe("钱包和商店", () => {
  it("钱不够买不了；够的时候扣钱和到货一起发生", async () => {
    const session = await guest();
    const token = { token: session.accessToken };
    expect((await post("/shop/buy", { itemId: "shield", opId: "buy-00001" }, token)).status).toBe(409);
    expect(await wallet(session)).toEqual({ coins: 0, gems: 0, items: {} });

    await player(session).transact("test:grant", "test", { coins: 100 });
    expect((await post("/shop/buy", { itemId: "shield", opId: "buy-00002" }, token)).status).toBe(200);
    expect(await wallet(session)).toEqual({ coins: 70, gems: 0, items: { shield: 1 } });
  });

  it("同一个购买编号重复提交，只扣一次钱", async () => {
    const session = await guest();
    const token = { token: session.accessToken };
    await player(session).transact("test:grant", "test", { coins: 100 });
    for (let i = 0; i < 3; i++) {
      const response = await post("/shop/buy", { itemId: "shield", opId: "retry-0001" }, token);
      expect(await response.json()).toMatchObject({ ok: true, duplicate: i > 0 });
    }
    expect(await wallet(session)).toEqual({ coins: 70, gems: 0, items: { shield: 1 } });
  });

  it("一次变更里任何一项不够，整个变更都不生效", async () => {
    const session = await guest();
    await player(session).transact("test:grant", "test", { coins: 100 });
    const result = await player(session).transact("test:mixed", "test", { coins: -10, items: { shield: -1 } });
    expect(result).toBe("insufficient");
    expect(await wallet(session)).toEqual({ coins: 100, gems: 0, items: {} });
  });

  it("商品编号和购买编号都要合法，接口需要登录", async () => {
    const session = await guest();
    const token = { token: session.accessToken };
    expect((await post("/shop/buy", { itemId: "nothing", opId: "buy-00001" }, token)).status).toBe(400);
    expect((await post("/shop/buy", { itemId: "shield", opId: "x" }, token)).status).toBe(400);
    expect((await post("/shop/buy", { itemId: "shield", opId: "buy-00001" })).status).toBe(401);
    expect((await get("/wallet")).status).toBe(401);
  });
});

describe("Telegram Stars", () => {
  it("下单时把玩家和订单的引用交给 Telegram，价格取自商品表", async () => {
    const session = await guest();
    const { orderId, url } = await order(session, "telegram");
    expect(url).toBe("https://t.me/$test-invoice");
    const sent = JSON.parse(outbound[0]!.init!.body as string);
    expect(sent).toMatchObject({
      payload: `${session.playerId}:${orderId}`,
      currency: "XTR",
      provider_token: "",
      prices: [{ label: "100 宝石", amount: 50 }],
    });
  });

  it("回调必须带正确的密钥", async () => {
    const session = await guest();
    const { orderId } = await order(session, "telegram");
    expect((await telegram(paidUpdate(session, orderId), "wrong-secret")).status).toBe(403);
    expect((await wallet(session)).gems).toBe(0);
  });

  it("付款前的确认：订单有效且金额一致才放行", async () => {
    const session = await guest();
    const { orderId } = await order(session, "telegram");
    const query = (amount: number, payload = `${session.playerId}:${orderId}`) =>
      telegram({ pre_checkout_query: { id: "q1", currency: "XTR", total_amount: amount, invoice_payload: payload } });

    expect(await (await query(50)).json()).toEqual({
      method: "answerPreCheckoutQuery",
      pre_checkout_query_id: "q1",
      ok: true,
    });
    expect(await (await query(1)).json()).toMatchObject({ ok: false });
    expect(await (await query(50, "garbage")).json()).toMatchObject({ ok: false });
    // 只是确认，还没有发货。
    expect((await wallet(session)).gems).toBe(0);
  });

  it("付款成功后发货，同一个通知来多少次都只发一次", async () => {
    const session = await guest();
    const { orderId } = await order(session, "telegram");
    for (let i = 0; i < 3; i++) {
      expect((await telegram(paidUpdate(session, orderId))).status).toBe(200);
    }
    expect((await wallet(session)).gems).toBe(100);
    expect(await player(session).getOrder(orderId)).toMatchObject({ status: "paid", externalId: `charge-${orderId}` });
    expect(await player(session).audit()).toMatchObject({ ok: true, gems: 100 });

    await expect
      .poll(() => env.DB.prepare("SELECT status, amount FROM payment WHERE order_id = ?").bind(orderId).first())
      .toEqual({ status: "paid", amount: 50 });
  });

  it("金额对不上的付款不发货", async () => {
    const session = await guest();
    const { orderId } = await order(session, "telegram");
    expect((await telegram(paidUpdate(session, orderId, 1))).status).toBe(200);
    expect((await wallet(session)).gems).toBe(0);
    expect(await player(session).getOrder(orderId)).toMatchObject({ status: "pending" });
  });

  it("退款把东西收回来；已经花掉的部分变成欠款", async () => {
    const session = await guest();
    const token = { token: session.accessToken };
    const { orderId } = await order(session, "telegram");
    await telegram(paidUpdate(session, orderId));
    await post("/shop/buy", { itemId: "dice_skin", opId: "spend-0001" }, token);
    expect(await wallet(session)).toEqual({ coins: 0, gems: 20, items: { dice_skin: 1 } });

    for (let i = 0; i < 2; i++) {
      await telegram(paidUpdate(session, orderId, 50, "refunded_payment"));
    }
    expect(await wallet(session)).toEqual({ coins: 0, gems: -80, items: { dice_skin: 1 } });
    expect(await player(session).audit()).toMatchObject({ ok: true });
    // 欠着的时候什么都买不了。
    expect((await post("/shop/buy", { itemId: "dice_skin", opId: "spend-0002" }, token)).status).toBe(409);

    await expect
      .poll(() => env.DB.prepare("SELECT status FROM payment WHERE order_id = ?").bind(orderId).first())
      .toEqual({ status: "refunded" });
  });

  it("没付款的订单不能堆太多", async () => {
    const session = await guest();
    for (let i = 0; i < MAX_PENDING_ORDERS; i++) await order(session, "telegram");
    const response = await post("/pay/orders", { productId: "gems_100", provider: "telegram" }, { token: session.accessToken });
    expect(response.status).toBe(429);
  });
});

describe("Stripe", () => {
  it("签名校验：原文、时间和密钥都要对", async () => {
    const now = 1_800_000_000;
    const body = '{"type":"x"}';
    const good = await hmacHex("whsec_a", `${now}.${body}`);
    const check = (header: string | null, at = now, raw = body) => verifyStripeSignature("whsec_a", header, raw, at);

    expect(await check(`t=${now},v1=${good}`)).toBe(true);
    // 轮换密钥时会有多个签名，对上一个就行。
    expect(await check(`t=${now},v1=${"0".repeat(64)},v1=${good}`)).toBe(true);
    expect(await check(`t=${now},v1=${good}`, now, '{"type":"y"}')).toBe(false);
    expect(await check(`t=${now},v1=${good}`, now + SIGNATURE_TOLERANCE_SECONDS + 1)).toBe(false);
    expect(await check(`t=${now + 1},v1=${good}`)).toBe(false);
    expect(await check(null)).toBe(false);
    expect(await check("garbage")).toBe(false);
  });

  it("下单时带上幂等键和订单引用", async () => {
    const session = await guest();
    const { orderId, url } = await order(session, "stripe");
    expect(url).toContain("checkout.stripe.com");
    const call = outbound.find((entry) => entry.url.includes("api.stripe.com"))!;
    const headers = call.init!.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(orderId);
    const form = call.init!.body as URLSearchParams;
    expect(form.get("client_reference_id")).toBe(`${session.playerId}:${orderId}`);
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("99");
    expect(await player(session).getOrder(orderId)).toMatchObject({ externalId: "cs_test_1" });
  });

  it("签名不对的回调被拒绝", async () => {
    const response = await exports.default.fetch(
      new Request(`${BASE}/webhooks/stripe`, {
        method: "POST",
        headers: { "Stripe-Signature": "t=1,v1=00" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("结账完成且已付款才发货，重复的事件只发一次", async () => {
    const session = await guest();
    const { orderId } = await order(session, "stripe");

    await stripe({ type: "checkout.session.completed", data: { object: stripeSession(session, orderId, "unpaid") } });
    expect((await wallet(session)).gems).toBe(0);

    for (let i = 0; i < 2; i++) {
      const response = await stripe({
        type: "checkout.session.completed",
        data: { object: stripeSession(session, orderId) },
      });
      expect(response.status).toBe(200);
    }
    expect((await wallet(session)).gems).toBe(100);
  });

  it("回调没来时，主动查询也能把货发出去", async () => {
    const session = await guest();
    const { orderId } = await order(session, "stripe");
    replies["api.stripe.com"] = stripeSession(session, orderId);
    const response = await post("/pay/orders/sync", { orderId }, { token: session.accessToken });
    expect(await response.json()).toEqual({ status: "paid" });
    expect((await wallet(session)).gems).toBe(100);
    // 之后回调才到，不会再发一次。
    await stripe({ type: "checkout.session.completed", data: { object: stripeSession(session, orderId) } });
    expect((await wallet(session)).gems).toBe(100);
  });

  it("退款的事件比付款的事件先到：先不答复成功，等付款处理完再收回", async () => {
    const session = await guest();
    const { orderId } = await order(session, "stripe");
    const refund = () =>
      stripe({ type: "charge.refunded", data: { object: { metadata: { ref: `${session.playerId}:${orderId}` } } } });

    expect((await refund()).status).toBe(409);
    await stripe({ type: "checkout.session.completed", data: { object: stripeSession(session, orderId) } });
    expect((await wallet(session)).gems).toBe(100);
    // 支付平台重发退款事件。
    expect((await refund()).status).toBe(200);
    expect((await wallet(session)).gems).toBe(0);
  });

  it("退款和拒付都把东西收回来", async () => {
    const session = await guest();
    const { orderId } = await order(session, "stripe");
    await stripe({ type: "checkout.session.completed", data: { object: stripeSession(session, orderId) } });
    await stripe({
      type: "charge.dispute.created",
      data: { object: { metadata: { ref: `${session.playerId}:${orderId}` } } },
    });
    expect((await wallet(session)).gems).toBe(0);
    expect(await player(session).getOrder(orderId)).toMatchObject({ status: "refunded" });
  });
});

describe("广告奖励", () => {
  /** 生成一对测试用的密钥，让代码拉公钥时拿到它，并返回一个给查询串签名的函数。 */
  async function adNetwork() {
    resetAdKeysForTest();
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
    replies["verifier-keys.json"] = { keys: [{ keyId: 42, base64: btoa(String.fromCharCode(...spki)) }] };

    return async (params: Record<string, string>) => {
      const signed = new URLSearchParams(params).toString();
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(signed)),
      );
      const der = toDer(raw);
      const signature = btoa(String.fromCharCode(...der))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      return `${BASE}/webhooks/admob?${signed}&signature=${signature}&key_id=42`;
    };
  }

  /** 把 r‖s 编成 DER，和广告平台发来的格式一致。 */
  function toDer(raw: Uint8Array): Uint8Array {
    const int = (bytes: Uint8Array) => {
      let start = 0;
      while (start < bytes.length - 1 && bytes[start] === 0) start++;
      const body = bytes.subarray(start);
      const padded = body[0]! & 0x80 ? [0, ...body] : [...body];
      return [0x02, padded.length, ...padded];
    };
    const content = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
    return Uint8Array.from([0x30, content.length, ...content]);
  }

  const callback = (url: string) => exports.default.fetch(new Request(url));

  it("签名正确的回调发奖，同一次观看只发一次", async () => {
    const session = await guest();
    const sign = await adNetwork();
    // 回调里的奖励数量不被采用，发多少由服务端决定。
    const url = await sign({ reward_amount: "9999", transaction_id: "tx-1", user_id: session.playerId });
    expect(await (await callback(url)).json()).toEqual({ result: "ok" });
    expect(await (await callback(url)).json()).toEqual({ result: "duplicate" });
    expect((await wallet(session)).coins).toBe(AD_REWARD_COINS);
  });

  it("改过参数或者签名不对的回调被拒绝", async () => {
    const session = await guest();
    const other = await guest();
    const sign = await adNetwork();
    const url = await sign({ transaction_id: "tx-2", user_id: session.playerId });
    expect((await callback(url.replace(session.playerId, other.playerId))).status).toBe(400);
    expect((await callback(`${BASE}/webhooks/admob?transaction_id=tx-3&user_id=${session.playerId}`)).status).toBe(400);
    expect((await wallet(other)).coins).toBe(0);
  });

  it("签名是真的，但玩家不存在", async () => {
    const sign = await adNetwork();
    const url = await sign({ transaction_id: "tx-4", user_id: "p_" + "0".repeat(24) });
    expect((await callback(url)).status).toBe(404);
  });

  it("每天领取的次数有上限", async () => {
    const session = await guest();
    const stub = player(session);
    const now = Date.UTC(2026, 10, 24, 12);
    for (let i = 0; i < AD_DAILY_CAP; i++) {
      expect(await stub.grantAdReward(`cap-${i}`, now)).toBe("ok");
    }
    expect(await stub.grantAdReward("cap-over", now)).toBe("capped");
    expect(await stub.grantAdReward("cap-over", now)).toBe("duplicate");
    expect((await stub.getWallet()).coins).toBe(AD_DAILY_CAP * AD_REWARD_COINS);
    // 第二天重新计数。
    expect(await stub.grantAdReward("cap-next-day", now + 24 * 60 * 60 * 1000)).toBe("ok");
  });
});

describe("流水和对账", () => {
  it("余额等于流水的合计，清理旧流水之后仍然对得上", async () => {
    const session = await guest();
    const stub = player(session);
    await stub.transact("a:1", "test", { coins: 100, gems: 10 });
    await stub.transact("a:2", "test", { coins: -30 });
    await stub.applyMatchResult("a:m", { won: true, coins: 10 });
    expect(await stub.audit()).toEqual({ coins: 80, gems: 10, ledgerCoins: 80, ledgerGems: 10, ok: true });

    expect(await stub.pruneLedger(Date.now() + 1000)).toBe(3);
    expect(await stub.audit()).toEqual({ coins: 80, gems: 10, ledgerCoins: 80, ledgerGems: 10, ok: true });
    await stub.transact("a:3", "test", { coins: 5 });
    expect(await stub.audit()).toMatchObject({ coins: 85, ok: true });
  });

  it("按渠道汇总一段时间内的订单，退款单独成行", async () => {
    const base = { type: "payment", playerId: "p_x", productId: "gems_100", provider: "recon", externalId: null } as const;
    const event = (orderId: string, amount: number, status: "paid" | "refunded", seq: number, paidAt: number) =>
      savePayment(env.DB, { ...base, orderId, amount, currency: "XTR", status, seq, createdAt: paidAt, paidAt, at: paidAt });
    await event("o_r1", 50, "paid", 1, 1000);
    await event("o_r2", 250, "paid", 1, 2000);
    await event("o_r3", 50, "paid", 1, 2500);
    // 退款的通知先到，付款的通知后到：留下的仍然是退款。
    await event("o_r3", 50, "refunded", 2, 2500);
    await event("o_r3", 50, "paid", 1, 2500);
    await event("o_r4", 50, "paid", 1, 9000);

    const totals = (await totalsBetween(env.DB, 0, 5000)).filter((row) => row.provider === "recon");
    expect(totals).toEqual([
      { provider: "recon", currency: "XTR", status: "paid", orders: 2, amount: 300 },
      { provider: "recon", currency: "XTR", status: "refunded", orders: 1, amount: 50 },
    ]);
  });
});
