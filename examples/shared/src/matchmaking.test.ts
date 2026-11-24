import { describe, expect, it } from "vitest";

import { BOT_AFTER_MS, planMatches, ratingWindow, WIDEN_EVERY_MS, type Ticket } from "./matchmaking";

const ticket = (playerId: string, rating: number, since = 0): Ticket => ({ playerId, rating, since });

describe("匹配规则", () => {
  it("分数接近的两个人立刻配成一对", () => {
    const plan = planMatches([ticket("a", 1000), ticket("b", 1050)], 0);
    expect(plan.pairs.map((pair) => pair.map((t) => t.playerId))).toEqual([["a", "b"]]);
    expect(plan.solo).toEqual([]);
    expect(plan.nextCheck).toBeNull();
  });

  it("差距太大时先等着，范围放宽后才配上", () => {
    const tickets = [ticket("a", 1000), ticket("b", 1250)];
    expect(planMatches(tickets, 0).pairs).toEqual([]);
    // 250 分的差距需要放宽两次。
    expect(planMatches(tickets, WIDEN_EVERY_MS).pairs).toEqual([]);
    expect(planMatches(tickets, WIDEN_EVERY_MS * 2).pairs).toHaveLength(1);
  });

  it("双方都要接受：刚进来的人不会被配给差距很大的老玩家", () => {
    const waited = WIDEN_EVERY_MS * 2;
    const tickets = [ticket("old", 1000, 0), ticket("new", 1250, waited)];
    expect(planMatches(tickets, waited).pairs).toEqual([]);
  });

  it("有多个候选时选分数最接近的，等得最久的人先挑", () => {
    const tickets = [ticket("first", 1000, 0), ticket("far", 1090, 1), ticket("near", 1010, 2)];
    const plan = planMatches(tickets, 10);
    expect(plan.pairs.map((pair) => pair.map((t) => t.playerId))).toEqual([["first", "near"]]);
  });

  it("同一个玩家不会和自己配对", () => {
    expect(planMatches([ticket("a", 1000), ticket("a", 1000, 1)], 5).pairs).toEqual([]);
  });

  it("等够时间还没有对手，安排机器人", () => {
    const plan = planMatches([ticket("a", 1000)], BOT_AFTER_MS);
    expect(plan.solo.map((t) => t.playerId)).toEqual(["a"]);
    expect(plan.nextCheck).toBeNull();
  });

  it("告诉调用方下一次什么时候再算", () => {
    expect(planMatches([ticket("a", 1000)], 0).nextCheck).toBe(WIDEN_EVERY_MS);
    expect(planMatches([ticket("a", 1000)], WIDEN_EVERY_MS * 3).nextCheck).toBe(BOT_AFTER_MS);
    expect(planMatches([], 0).nextCheck).toBeNull();
  });

  it("可接受的分数差随等待时间放宽", () => {
    expect(ratingWindow(0)).toBe(100);
    expect(ratingWindow(WIDEN_EVERY_MS - 1)).toBe(100);
    expect(ratingWindow(WIDEN_EVERY_MS)).toBe(200);
  });
});
