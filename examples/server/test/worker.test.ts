import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, connect, get, guest, openSocket } from "./helpers";

describe("HTTP 接口", () => {
  it("健康检查", async () => {
    const response = await exports.default.fetch(new Request(`${BASE}/health`));
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("房间地址必须用 WebSocket 访问", async () => {
    const response = await exports.default.fetch(new Request(`${BASE}/room/r0/ws`));
    expect(response.status).toBe(426);
  });

  it("没有令牌不能进房间", async () => {
    expect((await openSocket("r0", null)).status).toBe(401);
    expect((await openSocket("r0", "not-a-token")).status).toBe(401);
  });

  it("客户端自带的玩家 ID 请求头不起作用", async () => {
    const session = await guest();
    const response = await openSocket("r-header", session.accessToken, { "X-Player-Id": "someone-else" });
    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("game.v1");
    const ws = response.webSocket!;
    const first = new Promise<string>((resolve) => ws.addEventListener("message", (e) => resolve(e.data as string)));
    ws.accept();
    const message = JSON.parse(await first);
    expect(message.state.players.map((p: { id: string }) => p.id)).toEqual([session.playerId]);
    ws.close();
  });
});

describe("房间", () => {
  it("两人准备后开始，并按回合掷骰子", async () => {
    const a = await connect("r1");
    expect(await a.next()).toMatchObject({ type: "state", state: { phase: "waiting" } });

    const b = await connect("r1");
    await a.next(); // b 加入的广播
    await b.next();

    a.ws.send(JSON.stringify({ type: "ready" }));
    await a.next();
    await b.next();
    b.ws.send(JSON.stringify({ type: "ready" }));
    expect(await a.next()).toMatchObject({ type: "state", state: { phase: "playing", turn: 0 } });
    await b.next();

    // 还没轮到 b。
    b.ws.send(JSON.stringify({ type: "roll" }));
    expect(await b.next()).toEqual({ type: "error", code: "not_your_turn" });

    a.ws.send(JSON.stringify({ type: "roll" }));
    const afterRoll = await a.next();
    if (afterRoll.type !== "state") throw new Error("应该收到状态");
    expect(afterRoll.state.turn).toBe(1);
    expect(afterRoll.state.players[0]!.position).toBeGreaterThanOrEqual(1);
    expect(afterRoll.state.players[0]!.position).toBeLessThanOrEqual(6);

    a.ws.close();
    b.ws.close();
  });

  it("不合法的消息会收到错误", async () => {
    const a = await connect("r2");
    await a.next();
    a.ws.send("不是 JSON");
    expect(await a.next()).toEqual({ type: "error", code: "bad_message" });
    a.ws.close();
  });

  it("心跳由平台自动应答", async () => {
    const response = await openSocket("r-ping", (await guest()).accessToken);
    const ws = response.webSocket!;
    const messages: string[] = [];
    ws.addEventListener("message", (event) => {
      messages.push(event.data as string);
    });
    ws.accept();
    ws.send("ping");
    await expect.poll(() => messages).toContain("pong");
    ws.close();
  });

  it("不同房间互不影响", async () => {
    const a = await connect("r3");
    const first = await a.next();
    if (first.type !== "state") throw new Error("应该收到状态");
    expect(first.state.players).toHaveLength(1);
    a.ws.close();
  });
});

describe("玩家数据与结算", () => {
  it("新玩家的初始数据", async () => {
    const session = await guest();
    const response = await get("/me", session.accessToken);
    expect(await response.json()).toEqual({
      playerId: session.playerId,
      profile: { coins: 0, wins: 0, games: 0 },
      identities: ["guest"],
    });
  });

  it("同一局的结果重复提交只生效一次", async () => {
    const player = env.PLAYER.getByName("idem");
    await player.applyMatchResult("m1", { won: true, coins: 10 });
    await player.applyMatchResult("m1", { won: true, coins: 10 });
    expect(await player.getProfile()).toEqual({ coins: 10, wins: 1, games: 1 });

    await player.applyMatchResult("m2", { won: false, coins: 0 });
    expect(await player.getProfile()).toEqual({ coins: 10, wins: 1, games: 2 });
  });

  it("对局结束后双方的数据都被更新", async () => {
    const a = await connect("settle");
    await a.next();
    const b = await connect("settle");
    await a.next();
    await b.next();
    a.ws.send(JSON.stringify({ type: "ready" }));
    await a.next();
    await b.next();
    b.ws.send(JSON.stringify({ type: "ready" }));
    let message = await a.next();
    await b.next();

    // 轮流掷骰子直到有人到达终点。
    const sockets = [a, b];
    while (message.type === "state" && message.state.phase === "playing") {
      sockets[message.state.turn]!.ws.send(JSON.stringify({ type: "roll" }));
      message = await a.next();
      await b.next();
    }
    if (message.type !== "state") throw new Error("应该收到状态");
    const winner = message.state.winner!;
    const loser = winner === a.playerId ? b.playerId : a.playerId;

    await expect.poll(() => env.PLAYER.getByName(winner).getProfile()).toEqual({ coins: 10, wins: 1, games: 1 });
    await expect.poll(() => env.PLAYER.getByName(loser).getProfile()).toEqual({ coins: 0, wins: 0, games: 1 });

    a.ws.close();
    b.ws.close();
  });
});
