import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@game/shared";

const BASE = "http://example.com";

/** 通过 Worker 入口连进房间，返回连接和一个按顺序读取消息的函数。 */
async function connect(room: string, player: string) {
  const response = await exports.default.fetch(
    new Request(`${BASE}/room/${room}/ws?player=${player}`, { headers: { Upgrade: "websocket" } }),
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const queue: ServerMessage[] = [];
  const waiters: ((message: ServerMessage) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  ws.accept();
  const next = () =>
    new Promise<ServerMessage>((resolve) => {
      const message = queue.shift();
      if (message) resolve(message);
      else waiters.push(resolve);
    });
  return { ws, next };
}

describe("HTTP 接口", () => {
  it("健康检查", async () => {
    const response = await exports.default.fetch(new Request(`${BASE}/health`));
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("房间地址必须用 WebSocket 访问", async () => {
    const response = await exports.default.fetch(new Request(`${BASE}/room/r0/ws?player=a`));
    expect(response.status).toBe(426);
  });

  it("缺少玩家 ID 时拒绝", async () => {
    const response = await exports.default.fetch(
      new Request(`${BASE}/room/r0/ws`, { headers: { Upgrade: "websocket" } }),
    );
    expect(response.status).toBe(400);
  });
});

describe("房间", () => {
  it("两人准备后开始，并按回合掷骰子", async () => {
    const a = await connect("r1", "a");
    expect(await a.next()).toMatchObject({ type: "state", state: { phase: "waiting" } });

    const b = await connect("r1", "b");
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
    const a = await connect("r2", "a");
    await a.next();
    a.ws.send("不是 JSON");
    expect(await a.next()).toEqual({ type: "error", code: "bad_message" });
    a.ws.close();
  });

  it("心跳由平台自动应答", async () => {
    const response = await exports.default.fetch(
      new Request(`${BASE}/room/r-ping/ws?player=a`, { headers: { Upgrade: "websocket" } }),
    );
    const ws = response.webSocket!;
    const messages: string[] = [];
    ws.addEventListener("message", (event) => messages.push(event.data as string));
    ws.accept();
    ws.send("ping");
    await expect.poll(() => messages).toContain("pong");
    ws.close();
  });

  it("不同房间互不影响", async () => {
    const a = await connect("r3", "a");
    const first = await a.next();
    if (first.type !== "state") throw new Error("应该收到状态");
    expect(first.state.players).toHaveLength(1);
    a.ws.close();
  });
});

describe("玩家数据与结算", () => {
  it("新玩家的初始数据", async () => {
    const response = await exports.default.fetch(new Request(`${BASE}/player/newbie`));
    expect(await response.json()).toEqual({ coins: 0, wins: 0, games: 0 });
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
    const a = await connect("settle", "sa");
    await a.next();
    const b = await connect("settle", "sb");
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
    const loser = winner === "sa" ? "sb" : "sa";

    await expect.poll(() => env.PLAYER.getByName(winner).getProfile()).toEqual({ coins: 10, wins: 1, games: 1 });
    await expect.poll(() => env.PLAYER.getByName(loser).getProfile()).toEqual({ coins: 0, wins: 0, games: 1 });

    a.ws.close();
    b.ws.close();
  });
});
