import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@game/shared";
import worker from "../src/index";
import { loadRecord, type MatchRecord } from "../src/match/record";
import { findPlayer } from "../src/security/directory";
import { tierOf } from "../src/security/ratelimit";
import { replayRecord } from "../src/security/replay";
import { verifyTurnstile } from "../src/security/turnstile";
import { saveScores, standingOf, RATING_BOARD } from "../src/social/leaderboard";
import { BASE, get, guest, post, startGame, type Session } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const player = (session: Session) => env.PLAYER.getByName(session.playerId);

/** 一份打开了人机验证的环境，其余和测试环境完全相同。 */
const strictEnv = new Proxy(env, {
  get: (target, key) => (key === "TURNSTILE_ENFORCE" ? "true" : Reflect.get(target, key)),
}) as Env;

describe("限流", () => {
  it("接口按用途分档", () => {
    expect(tierOf("POST", "/pay/orders")).toBe("sensitive");
    expect(tierOf("GET", "/rooms/code/ABCDEF")).toBe("sensitive");
    expect(tierOf("POST", "/shop/buy")).toBe("api");
    expect(tierOf("GET", "/match/ws")).toBe("api");
    expect(tierOf("POST", "/webhooks/stripe")).toBe("webhook");
    // 这几类不在这一层限：读取、登录（有自己的限流）、管理后台（在 Access 后面）。
    expect(tierOf("GET", "/leaderboard")).toBeNull();
    expect(tierOf("POST", "/auth/guest")).toBeNull();
    expect(tierOf("POST", "/admin/config")).toBeNull();
  });

  it("敏感接口按玩家计数：换来源地址绕不过去，也不影响别的玩家", async () => {
    const session = await guest();
    const other = await guest();
    const statuses: number[] = [];
    // 测试里的每个请求都带着不同的来源地址。
    for (let i = 0; i < 35; i++) {
      statuses.push((await post("/rooms", {}, { token: session.accessToken })).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);

    const blocked = await post("/rooms", {}, { token: session.accessToken });
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect((await post("/rooms", {}, { token: other.accessToken })).status).toBe(200);
  });

  it("排队和进房的连接也按玩家计数：同一个地址上的很多玩家互不影响", async () => {
    // 这类连接的令牌在子协议里。如果限流只认 Authorization 请求头，就会退回到按地址计数，
    // 共用一个出口地址的玩家会互相挤占额度。这是压测时发现的。
    const statuses: number[] = [];
    for (let i = 0; i < 130; i++) {
      const session = await guest();
      const response = await exports.default.fetch(
        new Request(`${BASE}/match/ws`, {
          headers: {
            Upgrade: "websocket",
            "CF-Connecting-IP": "203.0.113.50",
            "Sec-WebSocket-Protocol": `game.v1, auth.${session.accessToken}`,
          },
        }),
      );
      statuses.push(response.status);
      response.webSocket?.accept();
      response.webSocket?.close();
    }
    expect(statuses.filter((status) => status === 429)).toEqual([]);
  }, 30_000);

  it("回调地址按来源地址计数", async () => {
    const hit = (ip: string) =>
      exports.default.fetch(
        new Request(`${BASE}/webhooks/stripe`, {
          method: "POST",
          headers: { "CF-Connecting-IP": ip, "Stripe-Signature": "t=1,v1=00" },
          body: "{}",
        }),
      );
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await hit("203.0.113.9")).status;
    expect(last).toBe(429);
    // 别的地址不受影响：签名不对，得到的是 400 而不是 429。
    expect((await hit("203.0.113.10")).status).toBe(400);
  });
});

describe("人机验证", () => {
  function siteverify(result: unknown) {
    const calls: Record<string, string>[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(init!.body as string));
      if (result instanceof Error) throw result;
      return Response.json(result);
    });
    return calls;
  }

  it("向验证服务核实令牌，带上密钥和来源地址", async () => {
    const calls = siteverify({ success: true });
    expect(await verifyTurnstile(strictEnv, "token-from-widget", "198.51.100.7")).toBe(true);
    expect(calls[0]).toMatchObject({
      secret: env.TURNSTILE_SECRET,
      response: "token-from-widget",
      remoteip: "198.51.100.7",
    });
    expect(calls[0]!.idempotency_key).toBeTruthy();
  });

  it("没有令牌、令牌没通过、验证服务不可用，都算没通过", async () => {
    const calls = siteverify({ success: false, "error-codes": ["timeout-or-duplicate"] });
    expect(await verifyTurnstile(strictEnv, undefined, "198.51.100.7")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await verifyTurnstile(strictEnv, "used-token", "198.51.100.7")).toBe(false);

    siteverify(new Error("unreachable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await verifyTurnstile(strictEnv, "any-token", "198.51.100.7")).toBe(false);
  });

  it("只有创建新账号需要验证，老玩家带着凭证回来不需要", async () => {
    const existing = await guest();
    siteverify({ success: false });
    const call = (body: unknown) =>
      worker.fetch(
        new Request(`${BASE}/auth/guest`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.8" },
          body: JSON.stringify(body),
        }),
        strictEnv,
      );
    expect((await call({})).status).toBe(403);
    expect((await call({ turnstileToken: "rejected" })).status).toBe(403);
    expect((await call({ secret: existing.guestSecret })).status).toBe(200);

    siteverify({ success: true });
    expect((await call({ turnstileToken: "accepted" })).status).toBe(200);
  });
});

describe("玩家名录", () => {
  it("登录过的玩家在名录里；编出来的 ID 不在，而且不会因此多出一个对象", async () => {
    const session = await guest();
    expect(await findPlayer(env.DB, session.playerId)).not.toBeNull();

    const before = (await listDurableObjectIds(env.PLAYER)).length;
    const fake = `p_${"ab".repeat(12)}`;
    const token = { token: session.accessToken };
    expect((await post("/friends/request", { playerId: fake }, token)).status).toBe(404);
    expect((await post("/invite/accept", { playerId: fake }, token)).status).toBe(404);
    expect((await listDurableObjectIds(env.PLAYER)).length).toBe(before);
  });
});

describe("数据导出和账号删除", () => {
  it("玩家能拿到自己的数据；身份对象的名字不在其中", async () => {
    const session = await guest();
    await player(session).transact("export:1", "test", { coins: 5 });
    const response = await get("/account/export", session.accessToken);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toMatchObject({ playerId: session.playerId, wallet: { coins: 5 }, identities: ["guest"] });
    expect(Object.keys(data).sort()).toEqual(
      ["friends", "identities", "ledger", "mail", "orders", "playerId", "profile", "wallet"].sort(),
    );
    expect(JSON.stringify(data)).not.toContain("guest:");
    expect((await get("/account/export")).status).toBe(401);
  });

  it("删除账号：各处的数据都清掉，同一个凭证再登录得到的是一个新玩家", async () => {
    const leaving = await guest();
    const friend = await guest();
    await post("/friends/request", { playerId: friend.playerId }, { token: leaving.accessToken });
    await post("/friends/request", { playerId: leaving.playerId }, { token: friend.accessToken });
    await expect.poll(async () => (await player(friend).listFriends()).length).toBe(1);
    await saveScores(env.DB, [{ playerId: leaving.playerId, rating: 1500, seq: 1, at: 1 }]);
    await player(leaving).transact("erase:coins", "test", { coins: 77 });

    const response = await post("/account/delete", {}, { token: leaving.accessToken });
    expect(response.status).toBe(202);

    // 清除在后台分几步完成，等它做完。
    await expect.poll(() => findPlayer(env.DB, leaving.playerId), { timeout: 10_000 }).toBeNull();
    await expect.poll(() => player(leaving).getWallet(), { timeout: 10_000 }).toEqual({ coins: 0, gems: 0, items: {} });
    expect(await standingOf(env.DB, RATING_BOARD, leaving.playerId)).toBeNull();
    await expect.poll(() => player(friend).listFriends()).toEqual([]);
    expect((await player(leaving).getPublic()).exists).toBe(false);

    // 身份已经解除归属：原来的凭证现在对应一个全新的账号。
    const again = await post("/auth/guest", { secret: leaving.guestSecret });
    expect(again.status).toBe(200);
    const fresh = (await again.json()) as Session;
    expect(fresh.playerId).not.toBe(leaving.playerId);
  });

  it("清除的每一步都可以重来", async () => {
    const session = await guest();
    const { eraseEverywhere } = await import("../src/security/account");
    const names = Object.values((await player(session).getAccount()).identities);
    await eraseEverywhere(env, session.playerId, names);
    await eraseEverywhere(env, session.playerId, names);
    expect(await findPlayer(env.DB, session.playerId)).toBeNull();
  });
});

describe("对局重放", () => {
  /** 轮流掷骰子直到结束，返回结束时的状态。 */
  async function playOut(game: Awaited<ReturnType<typeof startGame>>, stopAfter = Infinity) {
    let state = game.state;
    let rolls = 0;
    while (state.phase === "playing" && rolls < stopAfter) {
      const current = state.players[state.turn]!.id === game.a.playerId ? game.a : game.b;
      current.ws.send(JSON.stringify({ type: "roll", version: state.version }));
      const message: ServerMessage = await game.a.next();
      await game.b.next();
      if (message.type !== "state") throw new Error("应该收到状态");
      state = message.state;
      rolls++;
    }
    return state;
  }

  async function recordOf(playerId: string): Promise<MatchRecord> {
    let matchId = "";
    await expect
      .poll(
        async () => {
          const row = await env.DB.prepare("SELECT match_id FROM match_record WHERE players LIKE ?")
            .bind(`%${playerId}%`)
            .first<{ match_id: string }>();
          matchId = row?.match_id ?? "";
          return matchId;
        },
        { timeout: 15_000, interval: 500 },
      )
      .not.toBe("");
    return (await loadRecord(env.DB, matchId))!;
  }

  it("正常打完的一局，重放出来的结果和记录一致", async () => {
    const game = await startGame("replay-full");
    const finished = await playOut(game);
    const record = await recordOf(game.a.playerId);
    expect(record.seats).toEqual([game.a.playerId, game.b.playerId]);
    expect(replayRecord(record)).toEqual({ ok: true, winner: finished.winner });
  }, 30_000);

  it("中途有人离开的一局也能重放", async () => {
    const game = await startGame("replay-leave");
    await playOut(game, 3);
    game.b.ws.send(JSON.stringify({ type: "leave" }));
    await game.b.closed;
    const record = await recordOf(game.a.playerId);
    expect(record.log.at(-1)).toEqual({ playerId: game.b.playerId, dice: -1 });
    expect(replayRecord(record)).toEqual({ ok: true, winner: game.a.playerId });
  }, 30_000);

  it("记录被改过时重放对不上", async () => {
    const seats = ["p_a", "p_b"];
    const honest: MatchRecord = {
      matchId: "m-tamper",
      kind: "ranked",
      winner: "p_a",
      players: seats,
      seats,
      ratings: {},
      // 双方轮流掷 6，先手第四步到终点。
      log: [6, 6, 6, 6, 6, 6, 2].map((dice, index) => ({ playerId: seats[index % 2]!, dice })),
      endedAt: 1,
    };
    expect(replayRecord(honest)).toEqual({ ok: true, winner: "p_a" });
    // 改赢家。
    expect(replayRecord({ ...honest, winner: "p_b" })).toMatchObject({ ok: false, reason: "winner_mismatch" });
    // 改点数：最后一步改小，这一局就没有结束。
    const shortened = { ...honest, log: [...honest.log.slice(0, -1), { playerId: "p_a", dice: 1 }] };
    expect(replayRecord(shortened)).toMatchObject({ ok: false, reason: "not_finished" });
    // 改顺序：不该他走的时候走了一步。
    const reordered = { ...honest, log: [honest.log[1]!, ...honest.log] };
    expect(replayRecord(reordered)).toMatchObject({ ok: false });
    // 早期的记录没有座位顺序，无法重放。
    expect(replayRecord({ ...honest, seats: undefined })).toMatchObject({ ok: false, reason: "no_seats" });
  });
});
