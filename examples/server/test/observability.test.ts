import { env, exports } from "cloudflare:workers";
import { createMessageBatch, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { reportPayment } from "../src/obs/analytics";
import { log } from "../src/obs/log";
import { toDataPoint } from "../src/obs/metrics";
import { runScheduled } from "../src/ops/jobs";
import type { PlayerEvent } from "../src/social/events";
import { BASE, get, guest, post } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 截住某个级别的日志，返回已经写出的日志对象。 */
function capture(level: "info" | "warn" | "error") {
  const entries: Record<string, unknown>[] = [];
  vi.spyOn(console, level).mockImplementation((entry: unknown) => {
    if (typeof entry === "object" && entry !== null) entries.push(entry as Record<string, unknown>);
  });
  return entries;
}

describe("日志", () => {
  it("每条日志是一个带事件名的对象，异常被展开成可读的字段", () => {
    const errors = capture("error");
    log.error("something_failed", { orderId: "o_1", error: new Error("boom") });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      event: "something_failed",
      orderId: "o_1",
      error: { name: "Error", message: "boom" },
    });
  });

  it("每个应答都带请求编号", async () => {
    const response = await get("/health");
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("没有处理的异常：记一条带请求编号的错误日志，返回给客户端的内容里没有细节", async () => {
    const errors = capture("error");
    // 让对外的请求全部失败，下单时向支付平台申请链接就会抛出异常。
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down: secret-internal-detail");
    });
    const session = await guest();
    const response = await post("/pay/orders", { productId: "gems_100", provider: "telegram" }, { token: session.accessToken });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; requestId: string };
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("secret-internal-detail");
    expect(response.headers.get("X-Request-Id")).toBe(body.requestId);

    const entry = errors.find((e) => e.event === "unhandled_error");
    expect(entry).toMatchObject({ requestId: body.requestId, path: "/pay/orders", method: "POST" });
  });
});

describe("指标", () => {
  it("指标名放在最前面，标签和数值按定义的顺序排列", () => {
    expect(toDataPoint("match_made", ["asia", "bot"], [10_000])).toEqual({
      indexes: ["match_made"],
      blobs: ["match_made", "asia", "bot"],
      doubles: [10_000],
    });
  });

  it("字段个数不对时在写入的地方就报错，而不是写进一条错位的数据", () => {
    expect(() => toDataPoint("match_made", ["asia"], [1])).toThrow();
    expect(() => toDataPoint("settle", ["ok"], [])).toThrow();
  });
});

describe("向分析平台补报付款", () => {
  const payment = (patch: Partial<Extract<PlayerEvent, { type: "payment" }>> = {}) =>
    ({
      type: "payment",
      seq: 1,
      playerId: "p_report",
      orderId: "o_report",
      productId: "gems_100",
      provider: "stripe",
      amount: 99,
      currency: "usd",
      status: "paid",
      externalId: "pi_1",
      analyticsId: "1234567890.987654321",
      createdAt: Date.now() - 60_000,
      paidAt: Date.now() - 30_000,
      at: Date.now(),
      ...patch,
    }) as Extract<PlayerEvent, { type: "payment" }>;

  /** 截住发往分析平台的请求。 */
  function outbound() {
    const calls: { url: URL; body: Record<string, any> }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), body: JSON.parse(init!.body as string) });
      return new Response(null, { status: 204 });
    });
    return calls;
  }

  it("客户端把自己的分析标识告诉服务端，格式不对的不收", async () => {
    const session = await guest();
    const token = { token: session.accessToken };
    expect((await post("/analytics/client", { clientId: "1234567890.987654321" })).status).toBe(401);
    expect((await post("/analytics/client", { clientId: "<script>" }, token)).status).toBe(400);
    expect((await post("/analytics/client", { clientId: "1234567890.987654321" }, token)).status).toBe(200);
  });

  it("付款成功：带上客户端的标识、玩家 ID 和订单号", async () => {
    const calls = outbound();
    await reportPayment(env, payment());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe("https://www.google-analytics.com/mp/collect");
    expect(calls[0]!.url.searchParams.get("measurement_id")).toBe("G-TEST");
    expect(calls[0]!.url.searchParams.get("api_secret")).toBe(env.GA_API_SECRET);
    expect(calls[0]!.body).toMatchObject({
      client_id: "1234567890.987654321",
      user_id: "p_report",
      events: [
        {
          name: "purchase",
          params: { transaction_id: "o_report", item_id: "gems_100", currency: "USD", value: 0.99, source: "server" },
        },
      ],
    });
    expect(typeof calls[0]!.body.timestamp_micros).toBe("number");
  });

  it("Stars 不是标准币种，不当作金额上报；退款是另一个事件名", async () => {
    const calls = outbound();
    await reportPayment(env, payment({ provider: "telegram", amount: 50, currency: "XTR", status: "refunded" }));
    const event = calls[0]!.body.events[0];
    expect(event.name).toBe("refund");
    expect(event.params).toMatchObject({ stars: 50, payment_provider: "telegram" });
    expect(event.params.currency).toBeUndefined();
  });

  it("没有客户端标识、还没付款的订单，都不上报", async () => {
    const calls = outbound();
    await reportPayment(env, payment({ analyticsId: null }));
    await reportPayment(env, payment({ status: "pending" }));
    expect(calls).toEqual([]);
  });

  it("报不上去只记一条警告，不影响支付通知的处理，日志里没有密钥", async () => {
    const warnings = capture("warn");
    vi.stubGlobal("fetch", async () => {
      throw new Error("analytics unreachable");
    });
    const batch = createMessageBatch<PlayerEvent>("player-events", [
      { id: "pay-1", timestamp: new Date(), body: payment({ orderId: "o_report_fail" }), attempts: 1 },
    ]);
    await worker.queue(batch, env);

    // 支付记录照常写进了 D1。
    const row = await env.DB.prepare("SELECT status FROM payment WHERE order_id = ?").bind("o_report_fail").first();
    expect(row).toEqual({ status: "paid" });
    const warning = warnings.find((e) => e.event === "analytics_report_failed");
    expect(warning).toMatchObject({ orderId: "o_report_fail" });
    expect(JSON.stringify(warning)).not.toContain(env.GA_API_SECRET);
  });
});

describe("告警依赖的日志", () => {
  it("进了死信队列的消息：留一条 error 日志，完整内容存进表里", async () => {
    await env.DB.exec("DELETE FROM dead_letter");
    const errors = capture("error");
    const batch = createMessageBatch("match-log-dlq", [
      { id: "dead-1", timestamp: new Date(), body: { matchId: "broken" }, attempts: 6 },
    ]);
    await worker.queue(batch, env);

    expect(errors.find((e) => e.event === "dead_letter")).toMatchObject({ queue: "match-log-dlq", messageId: "dead-1" });
    const rows = await env.DB.prepare("SELECT queue, body FROM dead_letter").all();
    expect(rows.results).toEqual([{ queue: "match-log-dlq", body: '{"matchId":"broken"}' }]);
    await env.DB.exec("DELETE FROM dead_letter");
  });

  it("定时任务成功时留一条 job_done；没有对应任务的表达式不会被当成成功", async () => {
    const infos = capture("info");
    const errors = capture("error");
    await runScheduled("*/5 * * * *", Date.now(), env);
    expect(infos.filter((e) => e.event === "job_done")).toHaveLength(1);
    expect(infos[0]).toMatchObject({ event: "job_done", cron: "*/5 * * * *" });

    await runScheduled("1 2 3 4 5", Date.now(), env);
    // 监控规则数的是 job_done 的条数，所以这里不能多出一条。
    expect(infos.filter((e) => e.event === "job_done")).toHaveLength(1);
    expect(errors.find((e) => e.event === "job_unknown")).toBeTruthy();
  });
});

describe("对账的告警", () => {
  it("余额和流水对不上时，登录会留下一条错误日志", async () => {
    const session = await guest();
    const stub = env.PLAYER.getByName(session.playerId);
    // 模拟一段绕过流水直接改余额的代码，并把"上次检查的时间"拨回去。
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE profile SET coins = coins + 999, pruned_at = 0 WHERE id = 1");
    });
    const errors = capture("error");
    expect((await post("/auth/guest", { secret: session.guestSecret })).status).toBe(200);
    expect(errors.find((e) => e.event === "audit_mismatch")).toMatchObject({
      playerId: session.playerId,
      coins: 999,
      ledgerCoins: 0,
    });
  });
});
