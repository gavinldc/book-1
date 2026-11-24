import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloseCode, type ServerMessage } from "@game/shared";
import { LINGER_MS, TURN_MS } from "../src/room";
import { connect, guest, openSocket, roomStub, startGame } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
});

/** 把时钟拨快，然后让房间的定时器立即触发。 */
async function advance(room: string, ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
  await runDurableObjectAlarm((await roomStub(room)));
}

function expectState(message: ServerMessage) {
  if (message.type !== "state") throw new Error(`应该收到状态，实际是 ${JSON.stringify(message)}`);
  return message;
}

describe("断线重连", () => {
  it("对局中掉线保留位置，重连后收到完整状态", async () => {
    const { a, b, sa, state } = await startGame("re1");
    a.ws.send(JSON.stringify({ type: "roll", version: state.version }));
    const rolled = expectState(await b.next()).state;
    await a.next();

    a.ws.close();
    const offline = expectState(await b.next()).state;
    expect(offline.phase).toBe("playing");
    expect(offline.players[0]).toMatchObject({ id: sa.playerId, connected: false });

    const back = await connect("re1", sa);
    const restored = expectState(await back.next()).state;
    expect(restored.players[0]).toMatchObject({
      id: sa.playerId,
      connected: true,
      position: rolled.players[0]!.position,
    });
    back.ws.close();
    b.ws.close();
  });

  it("同一个玩家再连一次，旧连接被顶替，位置不变", async () => {
    const { a, b, sa } = await startGame("re2");
    const second = await connect("re2", sa);
    expect(await a.closed).toBe(CloseCode.Replaced);
    // 状态没有变化，只有新连接收到一份快照，别人不会收到广播。
    const snapshot = expectState(await second.next()).state;
    expect(snapshot.players.map((p) => p.connected)).toEqual([true, true]);
    second.ws.close();
    b.ws.close();
  });

  it("开局后陌生人进不来", async () => {
    const { a, b } = await startGame("re3");
    const response = await openSocket("re3", (await guest()).accessToken);
    expect(response.status).toBe(409);
    a.ws.close();
    b.ws.close();
  });

  it("开局前掉线直接离开，人走光后房间被清空", async () => {
    const a = await connect("re4");
    await a.next();
    a.ws.close();
    await a.closed;
    const stub = await roomStub("re4");
    await expect.poll(async () => (await stub.debugStorageKeys()).length).toBe(0);
  });
});

describe("过时的操作", () => {
  it("版本号对不上的操作被拒绝", async () => {
    const { a, b, state } = await startGame("stale1");
    a.ws.send(JSON.stringify({ type: "roll", version: state.version - 1 }));
    expect(await a.next()).toEqual({ type: "error", code: "stale_version" });
    a.ws.close();
    b.ws.close();
  });
});

describe("回合计时", () => {
  it("超时后这一回合轮空，换下一个人", async () => {
    const { a, b, state, deadline } = await startGame("turn1");
    expect(deadline! - Date.now()).toBeLessThanOrEqual(TURN_MS);

    await advance("turn1", TURN_MS + 1);
    const skipped = expectState(await b.next());
    expect(skipped.state.turn).toBe(1);
    expect(skipped.state.players[0]).toMatchObject({ position: 0, missed: 1 });
    expect(skipped.state.version).toBe(state.version + 1);
    // 新的截止时间从现在算起。
    expect(skipped.deadline).toBe(Date.now() + TURN_MS);
    a.ws.close();
    b.ws.close();
  });

  it("定时器提前触发时什么都不做", async () => {
    const { a, b, state } = await startGame("turn2");
    await runDurableObjectAlarm((await roomStub("turn2")));
    a.ws.send(JSON.stringify({ type: "roll", version: state.version }));
    // 第一条收到的就是掷骰子的结果，中间没有多出一次轮空。
    expect(expectState(await b.next()).state.version).toBe(state.version + 1);
    a.ws.close();
    b.ws.close();
  });

  it("所有人都掉线的对局会自己结束、结算并清理", async () => {
    const { a, b, sa, sb } = await startGame("turn3");
    a.ws.close();
    b.ws.close();
    await Promise.all([a.closed, b.closed]);

    // a 轮空、b 轮空、a 第二次超时被判弃权，b 获胜。
    for (let i = 0; i < 3; i++) await advance("turn3", TURN_MS + 1);
    await expect.poll(() => env.PLAYER.getByName(sb.playerId).getProfile()).toMatchObject({ wins: 1, coins: 10 });
    expect(await env.PLAYER.getByName(sa.playerId).getProfile()).toMatchObject({ wins: 0, games: 1 });

    const stub = await roomStub("turn3");
    expect((await stub.debugStorageKeys()).sort()).toEqual(["config", "log", "state", "timers"]);
    await advance("turn3", LINGER_MS + 1);
    expect(await stub.debugStorageKeys()).toEqual([]);
  });
});

describe("房间的结束", () => {
  it("结算完成后保留一段时间，到点关闭连接并清空存储", async () => {
    const { a, b } = await startGame("end1");
    a.ws.send(JSON.stringify({ type: "leave" }));
    expect(await a.closed).toBe(1000);
    const finished = expectState(await b.next()).state;
    expect(finished).toMatchObject({ phase: "finished", winner: b.playerId });

    await advance("end1", LINGER_MS + 1);
    expect(await b.closed).toBe(CloseCode.RoomClosed);
    expect(await (await roomStub("end1")).debugStorageKeys()).toEqual([]);
  });
});

describe("管理与防护", () => {
  it("被踢出的玩家连接断开，对局中等同于弃权", async () => {
    const { a, b, sa } = await startGame("kick1");
    await (await roomStub("kick1")).kick(sa.playerId);
    expect(await a.closed).toBe(CloseCode.Kicked);
    expect(expectState(await b.next()).state).toMatchObject({ phase: "finished", winner: b.playerId });
    b.ws.close();
  });

  it("发消息太快的连接被断开", async () => {
    const a = await connect("flood1");
    await a.next();
    for (let i = 0; i < 25; i++) a.ws.send("x");
    expect(await a.closed).toBe(CloseCode.TooManyMessages);
  });
});
