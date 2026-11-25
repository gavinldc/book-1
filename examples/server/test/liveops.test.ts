import { env, exports } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloseCode, DEFAULT_CONFIG, type GameConfig, type ServerMessage } from "@game/shared";
import worker from "../src/index";
import { savePayment } from "../src/economy/reconcile";
import { saveRecords } from "../src/match/record";
import { resetAccessKeysForTest } from "../src/ops/access";
import { cleanup, percentileOf, RECORD_RETENTION_MS, refreshScoreBuckets, sweepPendingOrders } from "../src/ops/jobs";
import { saveScores } from "../src/social/leaderboard";
import { BASE, get, guest, post, startGame, type Session } from "./helpers";

const player = (session: Session) => env.PLAYER.getByName(session.playerId);
const b64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === "string" ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** 测试里扮演 Cloudflare Access：生成一对密钥，签发令牌，并让代码拉公钥时拿到对应的公钥。 */
let accessKey: CryptoKeyPair;
let replies: Record<string, unknown> = {};

// 生成 RSA 密钥比较慢，整个文件只生成一次。
beforeAll(async () => {
  accessKey = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
});

beforeEach(async () => {
  resetAccessKeysForTest();
  const jwk = (await crypto.subtle.exportKey("jwk", accessKey.publicKey)) as JsonWebKey;
  replies = { "/cdn-cgi/access/certs": { keys: [{ ...jwk, kid: "key-1", alg: "RS256" }] } };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = Object.keys(replies).find((entry) => url.includes(entry));
    if (!key) throw new Error(`测试里没有准备这个地址的应答：${url}`);
    return Response.json(replies[key]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function accessToken(claims: Record<string, unknown> = {}, key = accessKey.privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "key-1" }));
  const payload = b64url(
    JSON.stringify({
      iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
      aud: [env.ACCESS_AUD],
      exp: now + 600,
      email: "ops@example.com",
      ...claims,
    }),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

async function admin(method: string, path: string, body?: unknown, token?: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const jwt = token === undefined ? await accessToken() : token;
  if (jwt) headers["Cf-Access-Jwt-Assertion"] = jwt;
  return exports.default.fetch(
    new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
}

/** 在当前配置的基础上发布一个新版本。 */
async function publish(patch: Partial<GameConfig>): Promise<GameConfig> {
  const current = (await (await admin("GET", "/admin/config")).json()) as GameConfig;
  const response = await admin("PUT", "/admin/config", { ...current, ...patch, version: current.version + 1 });
  expect(response.status).toBe(200);
  return response.json();
}

const logOf = async (target: string) =>
  (
    await env.DB.prepare("SELECT admin, action FROM admin_log WHERE target = ? ORDER BY id").bind(target).all()
  ).results;

describe("管理后台的鉴权", () => {
  it("没有令牌、令牌不对，都进不来", async () => {
    expect((await admin("GET", "/admin/config", undefined, null)).status).toBe(403);
    expect((await admin("GET", "/admin/config", undefined, "not.a.token")).status).toBe(403);
    // 玩家的访问令牌不是管理后台的令牌。
    const session = await guest();
    expect((await get("/admin/config", session.accessToken)).status).toBe(403);
  });

  it("签名是真的还不够：受众、签发方、有效期都要对", async () => {
    expect((await admin("GET", "/admin/config")).status).toBe(200);
    const past = Math.floor(Date.now() / 1000) - 10;
    expect((await admin("GET", "/admin/config", undefined, await accessToken({ aud: ["other-app"] }))).status).toBe(403);
    expect((await admin("GET", "/admin/config", undefined, await accessToken({ iss: "https://evil.example" }))).status).toBe(403);
    expect((await admin("GET", "/admin/config", undefined, await accessToken({ exp: past }))).status).toBe(403);
  });

  it("用别的密钥签的令牌不被接受", async () => {
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const forged = await accessToken({}, other.privateKey);
    expect((await admin("GET", "/admin/config", undefined, forged)).status).toBe(403);
  });
});

describe("在线配置", () => {
  it("玩家读到配置；版本没变时不重复下发", async () => {
    const session = await guest();
    const first = await get("/config", session.accessToken);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { version: number; shop: Record<string, { now: { coins: number } }> };
    expect(body.shop.shield!.now.coins).toBeGreaterThan(0);

    const again = await exports.default.fetch(
      new Request(`${BASE}/config`, {
        headers: { Authorization: `Bearer ${session.accessToken}`, "If-None-Match": first.headers.get("ETag")! },
      }),
    );
    expect(again.status).toBe(304);
    expect((await get("/config")).status).toBe(401);
  });

  it("发布要过校验，版本号必须正好加一", async () => {
    const current = (await (await admin("GET", "/admin/config")).json()) as GameConfig;
    const stale = await admin("PUT", "/admin/config", { ...current, version: current.version });
    expect(stale.status).toBe(400);
    const broken = await admin("PUT", "/admin/config", {
      ...current,
      version: current.version + 1,
      shop: { shield: { cost: { coins: 0 }, grant: { items: { shield: 1 } } } },
    });
    expect(await broken.json()).toMatchObject({ error: "invalid_config" });
    // 被拒绝的发布不改变线上的配置。
    expect(((await (await admin("GET", "/admin/config")).json()) as GameConfig).version).toBe(current.version);
  });

  it("改价格不用发版；活动期间自动打折，过了时间自动恢复", async () => {
    const session = await guest();
    const token = { token: session.accessToken };
    await player(session).transact("test:grant", "test", { coins: 1000 });
    const now = Date.now();

    await publish({
      shop: { ...DEFAULT_CONFIG.shop, shield: { cost: { coins: 40, gems: 0 }, grant: { items: { shield: 1 } } } },
      events: [{ id: "sale", type: "shop_discount", startsAt: now - 1000, endsAt: now + 60_000, percent: 25 }],
    });
    await post("/shop/buy", { itemId: "shield", opId: "cfg-buy-1" }, token);
    expect((await player(session).getWallet()).coins).toBe(970);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now + 120_000);
    await post("/shop/buy", { itemId: "shield", opId: "cfg-buy-2" }, token);
    expect((await player(session).getWallet()).coins).toBe(930);
  });

  it("回滚是把旧版本的内容作为新版本再发一次", async () => {
    const good = await publish({ notice: "一切正常" });
    await publish({ notice: "写错了的公告" });
    const response = await admin("POST", "/admin/config/rollback", { version: good.version });
    const rolled = (await response.json()) as GameConfig;
    expect(rolled.notice).toBe("一切正常");
    expect(rolled.version).toBe(good.version + 2);
    expect((await logOf("config")).at(-1)).toEqual({ admin: "ops@example.com", action: "config.rollback" });
  });

  it("实验分组对同一个玩家是稳定的", async () => {
    await publish({
      experiments: { new_shop: { variants: [{ name: "control", weight: 1 }, { name: "treatment", weight: 1 }] } },
    });
    const session = await guest();
    const read = async () =>
      ((await (await get("/config", session.accessToken)).json()) as { variants: Record<string, string> }).variants;
    const first = await read();
    expect(["control", "treatment"]).toContain(first.new_shop);
    expect(await read()).toEqual(first);
  });
});

describe("封禁", () => {
  it("封禁要写原因；封禁后把人从正在进行的对局里移出去", async () => {
    const { a, b, sa } = await startGame("ban-room");
    expect(((await (await get("/me", sa.accessToken)).json()) as { currentRoom: string }).currentRoom).toMatch(
      /^[0-9a-f]{64}$/,
    );

    expect((await admin("POST", `/admin/players/${sa.playerId}/ban`, {})).status).toBe(400);
    const response = await admin("POST", `/admin/players/${sa.playerId}/ban`, { reason: "外挂" });
    expect(await response.json()).toEqual({ ok: true, kicked: true });

    expect(await a.closed).toBe(CloseCode.Kicked);
    let message: ServerMessage = await b.next();
    while (message.type === "state" && message.state.phase !== "finished") message = await b.next();
    expect(message).toMatchObject({ state: { phase: "finished", winner: b.playerId } });
    expect((await player(sa).getAccount()).banned).toBe(true);
    expect(await logOf(sa.playerId)).toEqual([{ admin: "ops@example.com", action: "player.ban" }]);
    b.ws.close();
  });

  it("解封之后可以重新登录", async () => {
    const session = await guest();
    await admin("POST", `/admin/players/${session.playerId}/ban`, { reason: "误封测试" });
    expect((await post("/auth/guest", { secret: session.guestSecret })).status).toBe(403);
    await admin("POST", `/admin/players/${session.playerId}/unban`, { reason: "误封" });
    expect((await post("/auth/guest", { secret: session.guestSecret })).status).toBe(200);
  });

  it("对局结算之后，当前房间的记录被清掉", async () => {
    const { a, b, sa, sb } = await startGame("room-hint");
    a.ws.send(JSON.stringify({ type: "leave" }));
    await a.closed;
    await expect.poll(() => player(sb).getCurrentRoom()).toBeNull();
    expect(await player(sa).getCurrentRoom()).toBeNull();
    b.ws.close();
  });

  it("不存在的玩家不能被操作", async () => {
    const response = await admin("POST", `/admin/players/p_${"0".repeat(24)}/ban`, { reason: "x" });
    expect(response.status).toBe(404);
  });
});

describe("邮件和补偿", () => {
  const mail = (id: string, attachment: unknown = { coins: 100 }) => ({ id, title: "补偿", body: "抱歉", attachment });

  it("给一个玩家发邮件，附件只能领一次", async () => {
    const session = await guest();
    const token = { token: session.accessToken };
    expect((await admin("POST", `/admin/players/${session.playerId}/mail`, mail("comp-1"))).status).toBe(200);
    // 同一封邮件发两次，邮箱里只有一封。
    await admin("POST", `/admin/players/${session.playerId}/mail`, mail("comp-1"));

    const inbox = ((await (await get("/mail", session.accessToken)).json()) as { mail: { id: string }[] }).mail;
    expect(inbox.filter((entry) => entry.id === "comp-1")).toHaveLength(1);

    for (let i = 0; i < 2; i++) {
      const response = await post("/mail/claim", { mailId: "comp-1" }, token);
      expect(await response.json()).toMatchObject({ ok: true, duplicate: i > 0 });
    }
    expect((await player(session).getWallet()).coins).toBe(100);
    expect(await player(session).audit()).toMatchObject({ ok: true });
  });

  it("附件有上限，也不能是扣除", async () => {
    const session = await guest();
    const send = (attachment: unknown) => admin("POST", `/admin/players/${session.playerId}/mail`, mail("bad-1", attachment));
    expect((await send({ coins: 1_000_000 })).status).toBe(400);
    expect((await send({ coins: -5 })).status).toBe(400);
    expect((await send({ items: { shield: 5000 } })).status).toBe(400);
  });

  it("全服邮件只写一行；发信之前注册的人能领一次，之后注册的人看不到", async () => {
    const early = await guest();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const id = `all-${Date.now()}`;
    expect((await admin("POST", "/admin/mail/broadcast", mail(id, { gems: 20 }))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const late = await guest();

    const inbox = async (session: Session) =>
      ((await (await get("/mail", session.accessToken)).json()) as { mail: { id: string; claimed: boolean }[] }).mail;
    expect((await inbox(early)).find((entry) => entry.id === id)).toMatchObject({ claimed: false });
    expect((await inbox(late)).find((entry) => entry.id === id)).toBeUndefined();

    for (let i = 0; i < 2; i++) await post("/mail/claim", { mailId: id }, { token: early.accessToken });
    expect((await player(early).getWallet()).gems).toBe(20);
    expect((await inbox(early)).find((entry) => entry.id === id)).toMatchObject({ claimed: true });
    expect((await post("/mail/claim", { mailId: id }, { token: late.accessToken })).status).toBe(404);
  });

  it("客服能看到一个玩家的余额、对账结果和流水", async () => {
    const session = await guest();
    await player(session).transact("cs:1", "test", { coins: 7 });
    const view = (await (await admin("GET", `/admin/players/${session.playerId}`)).json()) as {
      wallet: { coins: number };
      audit: { ok: boolean };
      ledger: { opId: string }[];
    };
    expect(view.wallet.coins).toBe(7);
    expect(view.audit.ok).toBe(true);
    expect(view.ledger.map((row) => row.opId)).toContain("cs:1");
  });
});

describe("好友房短码", () => {
  it("建房时拿到短码，别人用短码换到房间号", async () => {
    const host = await guest();
    const created = (await (await post("/rooms", {}, { token: host.accessToken })).json()) as {
      roomId: string;
      code: string;
    };
    expect(created.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    const friend = await guest();
    const found = await get(`/rooms/code/${created.code.toLowerCase()}`, friend.accessToken);
    expect(await found.json()).toEqual({ roomId: created.roomId });
    expect((await get("/rooms/code/ZZZZZZ", friend.accessToken)).status).toBe(404);
    expect((await get("/rooms/code/abc", friend.accessToken)).status).toBe(400);
  });
});

describe("定时任务", () => {
  it("重算分数分布，据此估算靠后的玩家超过了多少人", async () => {
    await env.DB.exec("DELETE FROM leaderboard");
    await saveScores(
      env.DB,
      Array.from({ length: 100 }, (_, i) => ({ playerId: `p_dist_${i}`, rating: i * 10, seq: 1, at: i })),
    );
    expect(await refreshScoreBuckets(env.DB)).toBe(20);
    expect(await percentileOf(env.DB, 0)).toBeLessThan(5);
    const middle = (await percentileOf(env.DB, 500))!;
    expect(middle).toBeGreaterThan(45);
    expect(middle).toBeLessThan(56);
    expect(await percentileOf(env.DB, 5000)).toBe(99);
  });

  it("清理过期的对局记录和录像，没过期的留着", async () => {
    const now = Date.now();
    const record = (matchId: string, endedAt: number) => ({
      matchId,
      kind: "ranked" as const,
      winner: "p_clean",
      players: ["p_clean"],
      ratings: { p_clean: 1000 },
      log: [4, 4, 4].map((dice) => ({ playerId: "p_clean", dice })),
      endedAt,
    });
    await saveRecords(env.DB, [record("clean-old", now - RECORD_RETENTION_MS - 1000), record("clean-new", now)]);
    const removed = await cleanup(env.DB, now);
    expect(removed.match_record).toBeGreaterThanOrEqual(1);
    const left = await env.DB.prepare("SELECT match_id FROM match_record WHERE match_id LIKE 'clean-%'").all();
    expect(left.results).toEqual([{ match_id: "clean-new" }]);
    const replays = await env.DB.prepare("SELECT match_id FROM replay WHERE match_id LIKE 'clean-%'").all();
    expect(replays.results).toEqual([{ match_id: "clean-new" }]);
  });

  it("扫描未付款的订单：到支付平台核实，已付款的发货", async () => {
    const session = await guest();
    replies["api.stripe.com"] = { id: "cs_sweep", url: "https://checkout.stripe.com/c/pay/cs_sweep" };
    const response = await post("/pay/orders", { productId: "gems_100", provider: "stripe" }, { token: session.accessToken });
    const { orderId } = (await response.json()) as { orderId: string };
    await expect
      .poll(() => env.DB.prepare("SELECT external_id FROM payment WHERE order_id = ?").bind(orderId).first())
      .toEqual({ external_id: "cs_sweep" });

    // 刚下的单还不到核实的时间。
    expect((await sweepPendingOrders(env, Date.now())).checked).toBe(0);

    replies["api.stripe.com"] = {
      id: "cs_sweep",
      payment_status: "paid",
      amount_total: 99,
      currency: "usd",
      client_reference_id: `${session.playerId}:${orderId}`,
      payment_intent: "pi_sweep",
    };
    const result = await sweepPendingOrders(env, Date.now() + 15 * 60 * 1000);
    expect(result).toMatchObject({ failed: 0 });
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect((await player(session).getWallet()).gems).toBe(100);
  });

  it("很久以前的未付款订单不再查", async () => {
    const old = Date.now() - 3 * 24 * 60 * 60 * 1000;
    await savePayment(env.DB, {
      type: "payment",
      playerId: "p_old",
      orderId: "o_abandoned",
      productId: "gems_100",
      provider: "stripe",
      amount: 99,
      currency: "usd",
      status: "pending",
      externalId: "cs_abandoned",
      createdAt: old,
      paidAt: 0,
      at: old,
      seq: 1,
    });
    // 没有准备 Stripe 的应答：如果真的去查了，会计入 failed。
    delete replies["api.stripe.com"];
    await env.DB.exec("DELETE FROM payment WHERE status = 'pending' AND order_id != 'o_abandoned'");
    expect(await sweepPendingOrders(env, Date.now())).toEqual({ checked: 0, failed: 0 });
  });

  it("定时触发器按表达式分发到对应的任务", async () => {
    await env.DB.exec("DELETE FROM score_bucket");
    await saveScores(env.DB, [{ playerId: "p_cron", rating: 1234, seq: 1, at: 1 }]);
    const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: Date.now() });
    const ctx = createExecutionContext();
    worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
    const buckets = await env.DB.prepare("SELECT COUNT(*) AS n FROM score_bucket").first<{ n: number }>();
    expect(buckets!.n).toBeGreaterThan(0);
  });
});
