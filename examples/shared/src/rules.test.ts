import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./protocol";
import { applyAction, FINISH, initialState, type Action, type RoomState } from "./rules";

function run(actions: Action[], from: RoomState = initialState()): RoomState {
  return actions.reduce((state, action) => {
    const result = applyAction(state, action);
    if (!result.ok) throw new Error(result.error);
    return result.state;
  }, from);
}

const twoReady: Action[] = [
  { type: "join", playerId: "a" },
  { type: "join", playerId: "b" },
  { type: "ready", playerId: "a" },
  { type: "ready", playerId: "b" },
];

describe("准备阶段", () => {
  it("所有人准备后才开始", () => {
    const waiting = run(twoReady.slice(0, 3));
    expect(waiting.phase).toBe("waiting");
    expect(run(twoReady).phase).toBe("playing");
  });

  it("只有一个人时不会开始", () => {
    const state = run([
      { type: "join", playerId: "a" },
      { type: "ready", playerId: "a" },
    ]);
    expect(state.phase).toBe("waiting");
  });

  it("第五个人进不来", () => {
    const full = run(["a", "b", "c", "d"].map((id) => ({ type: "join", playerId: id }) as Action));
    expect(applyAction(full, { type: "join", playerId: "e" })).toEqual({ ok: false, error: "room_full" });
  });

  it("重复加入不会产生第二个玩家", () => {
    const state = run([
      { type: "join", playerId: "a" },
      { type: "join", playerId: "a" },
    ]);
    expect(state.players).toHaveLength(1);
  });
});

describe("对局阶段", () => {
  it("只有当前回合的玩家可以掷骰子", () => {
    const state = run(twoReady);
    expect(applyAction(state, { type: "roll", playerId: "b", dice: 3 })).toEqual({
      ok: false,
      error: "not_your_turn",
    });
  });

  it("掷完后轮到下一个人", () => {
    const state = run([...twoReady, { type: "roll", playerId: "a", dice: 4 }]);
    expect(state.players[0]!.position).toBe(4);
    expect(state.turn).toBe(1);
  });

  it("拒绝不合法的点数", () => {
    const state = run(twoReady);
    for (const dice of [0, 7, 2.5, Number.NaN]) {
      expect(applyAction(state, { type: "roll", playerId: "a", dice })).toEqual({ ok: false, error: "bad_dice" });
    }
  });

  it("先到终点的人获胜", () => {
    let state = run(twoReady);
    while (state.phase === "playing") {
      state = run([{ type: "roll", playerId: state.players[state.turn]!.id, dice: 6 }], state);
    }
    expect(state.winner).toBe("a");
    expect(state.players[0]!.position).toBe(FINISH);
  });

  it("对手离开后剩下的人获胜", () => {
    const state = run([...twoReady, { type: "leave", playerId: "a" }]);
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe("b");
    // 离开的人不在座位上了，但要留下记录，结算时给他记一场。
    expect(state.forfeited).toEqual(["a"]);
  });

  it("三人局里有人离开后回合仍指向正确的人", () => {
    const three = run([
      { type: "join", playerId: "a" },
      { type: "join", playerId: "b" },
      { type: "join", playerId: "c" },
      { type: "ready", playerId: "a" },
      { type: "ready", playerId: "b" },
      { type: "ready", playerId: "c" },
      { type: "roll", playerId: "a", dice: 1 },
    ]);
    // 轮到 b；a 离开后仍然应该轮到 b。
    const afterLeave = run([{ type: "leave", playerId: "a" }], three);
    expect(afterLeave.players[afterLeave.turn]!.id).toBe("b");
  });
});

describe("版本号", () => {
  it("状态每变化一次加一", () => {
    expect(run(twoReady).version).toBe(4);
  });

  it("没有变化的操作不改版本号，被拒绝的操作也不改", () => {
    const state = run(twoReady);
    // 已经在房间里并且在线，再加入一次什么都不变。
    const same = applyAction(state, { type: "join", playerId: "a" });
    expect(same.ok && same.state).toBe(state);
    expect(applyAction(state, { type: "roll", playerId: "b", dice: 3 }).ok).toBe(false);
  });
});

describe("断线与重连", () => {
  it("开局前断线直接离开房间", () => {
    const state = run([
      { type: "join", playerId: "a" },
      { type: "join", playerId: "b" },
      { type: "disconnect", playerId: "a" },
    ]);
    expect(state.players.map((p) => p.id)).toEqual(["b"]);
  });

  it("对局中断线保留位置，重连后恢复", () => {
    const offline = run([
      ...twoReady,
      { type: "roll", playerId: "a", dice: 5 },
      { type: "disconnect", playerId: "a" },
    ]);
    expect(offline.phase).toBe("playing");
    expect(offline.players[0]).toMatchObject({ id: "a", position: 5, connected: false });

    const back = run([{ type: "join", playerId: "a" }], offline);
    expect(back.players[0]).toMatchObject({ id: "a", position: 5, connected: true });
  });

  it("对局开始后陌生人进不来", () => {
    expect(applyAction(run(twoReady), { type: "join", playerId: "c" })).toEqual({
      ok: false,
      error: "already_started",
    });
  });
});

describe("回合超时", () => {
  it("第一次超时轮空", () => {
    const state = run([...twoReady, { type: "timeout", playerId: "a" }]);
    expect(state.phase).toBe("playing");
    expect(state.turn).toBe(1);
    expect(state.players[0]).toMatchObject({ position: 0, missed: 1 });
  });

  it("自己掷一次骰子后超时计数清零", () => {
    const state = run([
      ...twoReady,
      { type: "timeout", playerId: "a" },
      { type: "roll", playerId: "b", dice: 1 },
      { type: "roll", playerId: "a", dice: 1 },
    ]);
    expect(state.players[0]!.missed).toBe(0);
  });

  it("连续两次超时按弃权处理", () => {
    const state = run([
      ...twoReady,
      { type: "timeout", playerId: "a" },
      { type: "roll", playerId: "b", dice: 1 },
      { type: "timeout", playerId: "a" },
    ]);
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe("b");
  });

  it("只能判当前回合的玩家超时", () => {
    expect(applyAction(run(twoReady), { type: "timeout", playerId: "b" })).toEqual({
      ok: false,
      error: "not_your_turn",
    });
  });
});

describe("消息解析", () => {
  it("只接受认识的消息，并丢掉多余的字段", () => {
    expect(parseClientMessage('{"type":"ready","admin":true}')).toEqual({ type: "ready" });
    expect(parseClientMessage('{"type":"roll","version":3,"dice":6}')).toEqual({ type: "roll", version: 3 });
  });

  it("拒绝格式不对的消息", () => {
    for (const raw of ["", "null", "[]", '{"type":"cheat"}', '{"type":"roll"}', '{"type":"roll","version":"3"}']) {
      expect(parseClientMessage(raw)).toBeNull();
    }
    expect(parseClientMessage(JSON.stringify({ type: "ready", pad: "x".repeat(1000) }))).toBeNull();
  });
});
