import { describe, expect, it } from "vitest";
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
