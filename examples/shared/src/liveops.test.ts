import { describe, expect, it } from "vitest";

import { activeEvents, DEFAULT_CONFIG, shopCost, validateConfig, variantOf, type GameConfig } from "./liveops";

const sale = (startsAt: number, endsAt: number, percent = 20) =>
  ({ id: "sale", type: "shop_discount", startsAt, endsAt, percent }) as const;

describe("活动", () => {
  const config: GameConfig = { ...DEFAULT_CONFIG, events: [sale(1000, 2000)] };

  it("只在时间窗口内生效，开始算、结束不算", () => {
    expect(activeEvents(config, 999)).toEqual([]);
    expect(activeEvents(config, 1000)).toHaveLength(1);
    expect(activeEvents(config, 1999)).toHaveLength(1);
    expect(activeEvents(config, 2000)).toEqual([]);
  });

  it("折扣期间价格向上取整，活动结束恢复原价", () => {
    expect(shopCost(config, "shield", 1500)).toEqual({ coins: 24, gems: 0 });
    expect(shopCost(config, "shield", 2500)).toEqual({ coins: 30, gems: 0 });
    expect(shopCost({ ...config, events: [sale(0, 9999, 33)] }, "shield", 1)).toEqual({ coins: 21, gems: 0 });
    expect(shopCost(config, "nothing", 1500)).toBeNull();
  });
});

describe("实验分组", () => {
  const experiment = { variants: [{ name: "control", weight: 50 }, { name: "treatment", weight: 50 }] };

  it("同一个玩家在同一个实验里永远是同一组", () => {
    const first = variantOf("p_1", "exp", experiment);
    for (let i = 0; i < 5; i++) expect(variantOf("p_1", "exp", experiment)).toBe(first);
  });

  it("大致按权重分配，不同实验之间不相关", () => {
    const players = Array.from({ length: 2000 }, (_, i) => `p_${i}`);
    const inA = players.filter((id) => variantOf(id, "a", experiment) === "treatment");
    expect(inA.length).toBeGreaterThan(900);
    expect(inA.length).toBeLessThan(1100);
    // 在实验 a 里进了实验组的人，在实验 b 里仍然是一半一半。
    const both = inA.filter((id) => variantOf(id, "b", experiment) === "treatment");
    expect(both.length / inA.length).toBeGreaterThan(0.4);
    expect(both.length / inA.length).toBeLessThan(0.6);
  });

  it("权重为 0 的组没有人", () => {
    const off = { variants: [{ name: "control", weight: 1 }, { name: "treatment", weight: 0 }] };
    expect(variantOf("p_1", "exp", off)).toBe("control");
  });
});

describe("配置校验", () => {
  it("默认配置是合法的，多余的字段被去掉", () => {
    const result = validateConfig({ ...DEFAULT_CONFIG, extra: 1 });
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it("挡住明显填错的配置", () => {
    const bad = (patch: object) => typeof validateConfig({ ...DEFAULT_CONFIG, ...patch });
    expect(bad({ version: -1 })).toBe("string");
    expect(bad({ shop: { shield: { cost: {}, grant: { items: { shield: 1 } } } } })).toBe("string");
    expect(bad({ shop: { shield: { cost: { coins: 1.5 }, grant: { items: { shield: 1 } } } } })).toBe("string");
    expect(bad({ shop: { shield: { cost: { coins: 1 }, grant: { items: { shield: 100000 } } } } })).toBe("string");
    expect(bad({ events: [sale(2000, 1000)] })).toBe("string");
    expect(bad({ events: [sale(1000, 2000, 100)] })).toBe("string");
    expect(bad({ experiments: { x: { variants: [{ name: "a", weight: 0 }] } } })).toBe("string");
  });
});
