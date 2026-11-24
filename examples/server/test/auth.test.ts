import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { signAccessToken } from "../src/auth/token";
import { get, guest, post, telegramInitData, type Session } from "./helpers";

describe("游客账号", () => {
  it("第一次登录创建账号并返回凭证，之后用凭证回到同一个账号", async () => {
    const first = await guest();
    expect(first.playerId).toMatch(/^p_[0-9a-f]{24}$/);
    expect(first.guestSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const again = await post("/auth/guest", { secret: first.guestSecret });
    const second = (await again.json()) as Session;
    expect(second.playerId).toBe(first.playerId);
    // 凭证只在生成时返回一次。
    expect(second.guestSecret).toBeUndefined();
  });

  it("格式不对的凭证被拒绝", async () => {
    expect((await post("/auth/guest", { secret: "short" })).status).toBe(400);
    expect((await post("/auth/guest", { secret: 42 })).status).toBe(400);
  });
});

describe("访问令牌", () => {
  it("没有令牌或令牌不合法时拒绝", async () => {
    expect((await get("/me")).status).toBe(401);
    expect((await get("/me", "abc.def")).status).toBe(401);
  });

  it("改动载荷后签名失效", async () => {
    const { accessToken } = await guest();
    const [, signature] = accessToken.split(".");
    const forged = btoa(JSON.stringify({ sub: "p_victim", sid: "s_x", exp: 9999999999 })).replace(/=+$/, "");
    expect((await get("/me", `${forged}.${signature}`)).status).toBe(401);
  });

  it("过期的令牌被拒绝", async () => {
    const expired = await signAccessToken(env.SESSION_SECRET, {
      sub: "p_someone",
      sid: "s_x",
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    expect((await get("/me", expired)).status).toBe(401);
  });

  it("用别的密钥签出的令牌被拒绝", async () => {
    const forged = await signAccessToken("another-secret", { sub: "p_someone", sid: "s_x", exp: 9999999999 });
    expect((await get("/me", forged)).status).toBe(401);
  });
});

describe("会话刷新", () => {
  it("刷新后得到新的令牌，旧的刷新凭证作废", async () => {
    const session = await guest();
    const refreshed = (await (await post("/auth/refresh", { refreshToken: session.refreshToken })).json()) as Session;
    expect(refreshed.playerId).toBe(session.playerId);
    expect(refreshed.refreshToken).not.toBe(session.refreshToken);
    expect((await get("/me", refreshed.accessToken)).status).toBe(200);
  });

  it("重复使用旧的刷新凭证会让整个会话失效", async () => {
    const session = await guest();
    const refreshed = (await (await post("/auth/refresh", { refreshToken: session.refreshToken })).json()) as Session;
    // 旧凭证被再次使用：拒绝，并且连新凭证也一起作废。
    expect((await post("/auth/refresh", { refreshToken: session.refreshToken })).status).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: refreshed.refreshToken })).status).toBe(401);
  });

  it("退出登录后不能再刷新", async () => {
    const session = await guest();
    expect((await post("/auth/logout", {}, { token: session.accessToken })).status).toBe(200);
    expect((await post("/auth/refresh", { refreshToken: session.refreshToken })).status).toBe(401);
  });

  it("被封禁的玩家不能刷新，也不能重新登录", async () => {
    const session = await guest();
    await env.PLAYER.getByName(session.playerId).ban();
    expect((await post("/auth/refresh", { refreshToken: session.refreshToken })).status).toBe(403);
    expect((await post("/auth/guest", { secret: session.guestSecret })).status).toBe(403);
  });
});

describe("Telegram 登录", () => {
  it("签名正确时登录，同一个用户始终得到同一个玩家", async () => {
    const first = (await (await post("/auth/telegram", { initData: await telegramInitData(1001) })).json()) as Session;
    const second = (await (await post("/auth/telegram", { initData: await telegramInitData(1001) })).json()) as Session;
    expect(second.playerId).toBe(first.playerId);

    const other = (await (await post("/auth/telegram", { initData: await telegramInitData(1002) })).json()) as Session;
    expect(other.playerId).not.toBe(first.playerId);
  });

  it("改动任何字段都会让签名失效", async () => {
    const initData = await telegramInitData(2001);
    const tampered = initData.replace("2001", "2002");
    expect((await post("/auth/telegram", { initData: tampered })).status).toBe(401);
  });

  it("过期的登录数据被拒绝", async () => {
    const stale = await telegramInitData(2003, Math.floor(Date.now() / 1000) - 2 * 60 * 60);
    expect((await post("/auth/telegram", { initData: stale })).status).toBe(401);
  });
});

describe("绑定", () => {
  it("游客绑定 Telegram 后，用 Telegram 登录回到同一个账号", async () => {
    const session = await guest();
    const initData = await telegramInitData(3001);
    expect((await post("/auth/bind/telegram", { initData }, { token: session.accessToken })).status).toBe(200);
    // 重复绑定同一个身份不出错。
    expect((await post("/auth/bind/telegram", { initData }, { token: session.accessToken })).status).toBe(200);

    const viaTelegram = (await (await post("/auth/telegram", { initData })).json()) as Session;
    expect(viaTelegram.playerId).toBe(session.playerId);

    const me = (await (await get("/me", session.accessToken)).json()) as { identities: string[] };
    expect(me.identities.sort()).toEqual(["guest", "telegram"]);
  });

  it("身份已经属于别的玩家时拒绝绑定", async () => {
    const initData = await telegramInitData(3002);
    await post("/auth/telegram", { initData });

    const session = await guest();
    const response = await post("/auth/bind/telegram", { initData }, { token: session.accessToken });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "identity_taken" });
  });

  it("一个玩家只能绑定一个 Telegram 账号", async () => {
    const session = await guest();
    await post("/auth/bind/telegram", { initData: await telegramInitData(3003) }, { token: session.accessToken });
    const response = await post(
      "/auth/bind/telegram",
      { initData: await telegramInitData(3004) },
      { token: session.accessToken },
    );
    expect(await response.json()).toEqual({ error: "already_linked" });
  });

  it("绑定接口需要登录", async () => {
    expect((await post("/auth/bind/telegram", { initData: await telegramInitData(3005) })).status).toBe(401);
  });
});

describe("限流", () => {
  it("同一个来源地址短时间内请求过多会被拒绝", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      statuses.push((await post("/auth/refresh", { refreshToken: "x" }, { ip: "203.0.113.9" })).status);
    }
    expect(statuses).toContain(429);
    expect(statuses[0]).toBe(401);
  });
});
