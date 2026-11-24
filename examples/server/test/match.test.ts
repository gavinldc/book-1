import { env, exports } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_AFTER_MS, CloseCode, isServerSeat, RATING_STEP, type ServerMessage } from "@game/shared";
import worker from "../src/index";
import { pickReplay, saveRecords, type MatchRecord } from "../src/match/record";
import { regionOf } from "../src/match/region";
import { BOT_MIN_MS, BOT_SPREAD_MS, JOIN_MS } from "../src/room";
import { connect, enqueue, guest, openSocket, post, roomStub, type Session } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
});

/** 把时钟拨快，然后让指定对象的定时器立即触发。 */
async function advance(stub: DurableObjectStub, ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
  await runDurableObjectAlarm(stub);
}

const matchmaker = () => env.MATCHMAKER.getByName("ranked:asia");

function expectState(message: ServerMessage) {
  if (message.type !== "state") throw new Error(`应该收到状态，实际是 ${JSON.stringify(message)}`);
  return message;
}

/** 排队直到拿到房间号。只有一个人时需要把时钟拨到补位的时间。 */
async function matchAlone(session: Session): Promise<string> {
  const ticket = await enqueue(session);
  expect(await ticket.next()).toEqual({ type: "queued" });
  await advance(matchmaker(), BOT_AFTER_MS);
  const matched = await ticket.next();
  if (matched.type !== "matched") throw new Error("应该配上机器人");
  expect(await ticket.closed).toBe(1000);
  return matched.roomId;
}

/** 和服务端座位打完一局：轮到自己就掷，轮到对方就让房间的定时器触发。返回结束时的状态。 */
async function playToEnd(room: string, me: Awaited<ReturnType<typeof connect>>) {
  let message = expectState(await me.next());
  me.ws.send(JSON.stringify({ type: "ready" }));
  message = expectState(await me.next());
  while (message.state.phase === "playing") {
    const current = message.state.players[message.state.turn]!.id;
    if (current === me.playerId) me.ws.send(JSON.stringify({ type: "roll", version: message.state.version }));
    else await advance(await roomStub(room), BOT_MIN_MS + BOT_SPREAD_MS);
    message = expectState(await me.next());
  }
  return message.state;
}

describe("开房和准入", () => {
  it("没有开过的房间连不上", async () => {
    const unknown = env.ROOM.newUniqueId().toString();
    expect((await openSocket(unknown, (await guest()).accessToken)).status).toBe(404);
  });

  it("不是房间号格式的地址返回 404", async () => {
    const response = await exports.default.fetch(new Request("http://example.com/room/demo/ws"));
    expect(response.status).toBe(404);
  });

  it("建好友房需要登录", async () => {
    expect((await post("/rooms", {})).status).toBe(401);
  });

  it("重复开房不会把已有的对局冲掉", async () => {
    const a = await connect("open-twice");
    await a.next();
    await (await roomStub("open-twice")).open({ kind: "private", allowed: [], ratings: {}, bots: [] });
    // 第二次调用被忽略：房间里的人还在，名单也没有被改成"谁都不能进"。
    const b = await connect("open-twice");
    expect(expectState(await b.next()).state.players).toHaveLength(2);
    a.ws.close();
    b.ws.close();
  });
});

describe("匹配", () => {
  it("分数接近的两个人配到同一个房间，只有他们能进", async () => {
    const sa = await guest();
    const sb = await guest();
    const a = await enqueue(sa);
    expect(await a.next()).toEqual({ type: "queued" });
    const b = await enqueue(sb);
    expect(await b.next()).toEqual({ type: "queued" });

    const [ma, mb] = [await a.next(), await b.next()];
    if (ma.type !== "matched" || mb.type !== "matched") throw new Error("应该配对成功");
    expect(ma.roomId).toBe(mb.roomId);
    expect(await a.closed).toBe(1000);
    expect(await b.closed).toBe(1000);

    const stranger = await openSocket(ma.roomId, (await guest()).accessToken);
    expect(stranger.status).toBe(403);

    const ca = await connect(ma.roomId, sa);
    const cb = await connect(ma.roomId, sb);
    expect(expectState(await cb.next()).state.players.map((p) => p.id)).toEqual([sa.playerId, sb.playerId]);
    ca.ws.close();
    cb.ws.close();
  });

  it("断开连接就是取消排队", async () => {
    const a = await enqueue(await guest());
    await a.next();
    a.ws.close();
    await a.closed;

    // 后来的人不会和已经走掉的人配上，等够时间后拿到的是机器人。
    const sb = await guest();
    const roomId = await matchAlone(sb);
    const b = await connect(roomId, sb);
    const players = expectState(await b.next()).state.players.map((p) => p.id);
    expect(players.filter(isServerSeat)).toHaveLength(1);
    b.ws.close();
  });

  it("同一个玩家重复排队，旧的连接被顶替", async () => {
    const session = await guest();
    const first = await enqueue(session);
    await first.next();
    const second = await enqueue(session);
    expect(await first.closed).toBe(CloseCode.Replaced);
    second.ws.close();
    await second.closed;
  });

  it("被封禁的玩家不能排队", async () => {
    const session = await guest();
    await env.PLAYER.getByName(session.playerId).ban();
    const response = await exports.default.fetch(
      new Request("http://example.com/match/ws", {
        headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `game.v1, auth.${session.accessToken}` },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("按请求进入的大洲划分地区", () => {
    expect(regionOf("AS")).toBe("asia");
    expect(regionOf("EU")).toBe("europe");
    expect(regionOf("SA")).toBe("america");
    expect(regionOf(undefined)).toBe("asia");
  });
});

describe("机器人补位", () => {
  it("等不到对手时和机器人打一局，照常计分", async () => {
    const session = await guest();
    const roomId = await matchAlone(session);
    const me = await connect(roomId, session);
    const finished = await playToEnd(roomId, me);

    expect(finished.phase).toBe("finished");
    const won = finished.winner === session.playerId;
    await expect
      .poll(() => env.PLAYER.getByName(session.playerId).getProfile())
      .toMatchObject({ games: 1, wins: won ? 1 : 0, rating: 1000 + (won ? RATING_STEP : -RATING_STEP) });
    me.ws.close();
  });

  it("配好的房间没人来，到时间自动作废", async () => {
    const roomId = await matchAlone(await guest());
    const stub = await roomStub(roomId);
    expect(await stub.debugStorageKeys()).not.toEqual([]);
    await advance(stub, JOIN_MS + 1);
    expect(await stub.debugStorageKeys()).toEqual([]);
  });
});

describe("对局记录", () => {
  const record = (matchId: string, playerId: string, rolls: number[]): MatchRecord => ({
    matchId,
    kind: "ranked",
    winner: playerId,
    players: [playerId, "bot:test"],
    ratings: { [playerId]: 1000 },
    log: rolls.map((dice) => ({ playerId, dice })),
    endedAt: 1,
  });

  it("队列的消费者把记录写进 D1，重复投递不会写两次", async () => {
    const body = record("m-queue", "p_recorded", [6, 6, 6, 2]);
    for (let i = 0; i < 2; i++) {
      const batch = createMessageBatch<MatchRecord>("match-log", [
        { id: `msg-${i}`, timestamp: new Date(), body, attempts: 1 },
      ]);
      const ctx = createExecutionContext();
      // 直接调用入口模块导出的处理函数，和线上被队列调用时走的是同一段代码。
      await worker.queue(batch, env);
      await getQueueResult(batch, ctx);
    }
    const rows = await env.DB.prepare("SELECT kind, winner FROM match_record WHERE match_id = ?")
      .bind("m-queue")
      .all();
    expect(rows.results).toEqual([{ kind: "ranked", winner: "p_recorded" }]);
    const replays = await env.DB.prepare("SELECT rolls FROM replay WHERE match_id = ?").bind("m-queue").all();
    expect(replays.results).toEqual([{ rolls: "[6,6,6,2]" }]);
  });

  it("好友房的对局不进录像池", async () => {
    await saveRecords(env.DB, [{ ...record("m-private", "p_private", [6, 6, 6, 2]), kind: "private" }]);
    const replays = await env.DB.prepare("SELECT 1 FROM replay WHERE match_id = ?").bind("m-private").all();
    expect(replays.results).toEqual([]);
  });

  it("挑录像时不会挑到自己，也不会挑分数差太远的", async () => {
    await saveRecords(env.DB, [record("m-pick", "p_pick", [5, 5, 5, 5])]);
    expect(await pickReplay(env.DB, 5000, "someone")).toBeNull();
    const all = await env.DB.prepare("SELECT player_id FROM replay").all<{ player_id: string }>();
    for (const row of all.results) {
      const picked = await pickReplay(env.DB, 1000, row.player_id);
      expect(picked?.playerId).not.toBe(row.player_id);
    }
  });

  it("一局排位赛结束后，记录经过队列落到 D1", async () => {
    const session = await guest();
    const roomId = await matchAlone(session);
    const me = await connect(roomId, session);
    await playToEnd(roomId, me);
    vi.useRealTimers();
    await expect
      .poll(
        async () =>
          (
            await env.DB.prepare("SELECT kind FROM match_record WHERE players LIKE ?")
              .bind(`%${session.playerId}%`)
              .all()
          ).results,
        { timeout: 15_000, interval: 500 },
      )
      .toEqual([{ kind: "ranked" }]);
    me.ws.close();
  }, 20_000);
});

describe("镜像对战", () => {
  it("对手按录像里的点数走", async () => {
    // 清空录像池，只放一段确定的录像：6、6、6、2，四步走完 20 格。
    await env.DB.exec("DELETE FROM replay");
    await saveRecords(env.DB, [
      {
        matchId: "m-ghost",
        kind: "ranked",
        winner: "p_ghost",
        players: ["p_ghost", "p_other"],
        ratings: { p_ghost: 1000, p_other: 1000 },
        log: [6, 6, 6, 2].map((dice) => ({ playerId: "p_ghost", dice })),
        endedAt: 1,
      },
    ]);

    const session = await guest();
    const response = await post("/mirror", {}, { token: session.accessToken });
    const { roomId, opponent } = (await response.json()) as { roomId: string; opponent: string };
    expect(opponent).toBe("ghost:p_ghost");

    const me = await connect(roomId, session);
    const finished = await playToEnd(roomId, me);
    // 录像四步到终点，真人三步最多走 18 格，所以录像一定先到。
    expect(finished.winner).toBe("ghost:p_ghost");
    expect(finished.players.find((p) => p.id === opponent)?.position).toBe(20);
    await expect
      .poll(() => env.PLAYER.getByName(session.playerId).getProfile())
      .toMatchObject({ games: 1, wins: 0, rating: 1000 - RATING_STEP });
    me.ws.close();
  });

  it("录像池里没有合适的对手时退回到机器人", async () => {
    await env.DB.exec("DELETE FROM replay");
    const session = await guest();
    const response = await post("/mirror", {}, { token: session.accessToken });
    const { opponent } = (await response.json()) as { opponent: string };
    expect(opponent.startsWith("bot:")).toBe(true);
  });

  it("别人进不了我的镜像对战", async () => {
    const response = await post("/mirror", {}, { token: (await guest()).accessToken });
    const { roomId } = (await response.json()) as { roomId: string };
    expect((await openSocket(roomId, (await guest()).accessToken)).status).toBe(403);
  });
});
