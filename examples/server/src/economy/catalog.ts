/** 一次资产变更：每一项是变化量，正数是增加，负数是减少。 */
export interface Delta {
  coins?: number;
  gems?: number;
  items?: Record<string, number>;
}

export type Provider = "telegram" | "stripe";

/** 用真钱买的商品。价格以支付平台的最小单位计：Stars 是个数，美元是分。 */
export interface Product {
  title: string;
  description: string;
  grant: Delta;
  price: Record<Provider, { amount: number; currency: string }>;
}

/**
 * 商品表写在代码里，由服务端决定价格和内容。客户端只传商品的编号。
 * 第 9 章会把它挪到可以在线修改的配置里。
 */
export const PRODUCTS: Record<string, Product> = {
  gems_100: {
    title: "100 宝石",
    description: "一小袋宝石",
    grant: { gems: 100 },
    price: { telegram: { amount: 50, currency: "XTR" }, stripe: { amount: 99, currency: "usd" } },
  },
  gems_550: {
    title: "550 宝石",
    description: "一大袋宝石，多送 10%",
    grant: { gems: 550 },
    price: { telegram: { amount: 250, currency: "XTR" }, stripe: { amount: 499, currency: "usd" } },
  },
};

/** 用游戏内货币买的东西。cost 里的每一项都是要扣掉的数量。 */
export const SHOP: Record<string, { cost: { coins?: number; gems?: number }; grant: Delta }> = {
  shield: { cost: { coins: 30 }, grant: { items: { shield: 1 } } },
  dice_skin: { cost: { gems: 80 }, grant: { items: { dice_skin: 1 } } },
};

/** 把一次变更取反，用于退款时收回发出去的东西。 */
export function negate(delta: Delta): Delta {
  return {
    coins: -(delta.coins ?? 0),
    gems: -(delta.gems ?? 0),
    items: Object.fromEntries(Object.entries(delta.items ?? {}).map(([id, qty]) => [id, -qty])),
  };
}

/** 把两次变更合成一次。 */
export function combine(a: Delta, b: Delta): Delta {
  const items: Record<string, number> = { ...a.items };
  for (const [id, qty] of Object.entries(b.items ?? {})) items[id] = (items[id] ?? 0) + qty;
  return { coins: (a.coins ?? 0) + (b.coins ?? 0), gems: (a.gems ?? 0) + (b.gems ?? 0), items };
}
