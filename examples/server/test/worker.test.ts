import { exports } from "cloudflare:workers";
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

  it("不同房间互不影响", async () => {
    const a = await connect("r3", "a");
    const first = await a.next();
    if (first.type !== "state") throw new Error("应该收到状态");
    expect(first.state.players).toHaveLength(1);
    a.ws.close();
  });
});
