/**
 * 运营配置：不发版就能改的东西。和规则一样是纯函数，当前时间由调用方传入。
 */

export interface ShopEntry {
  cost: { coins?: number; gems?: number };
  grant: { items: Record<string, number> };
}

/** 一个定时开关的活动。示例里只有一种：商店打折。 */
export interface GameEvent {
  id: string;
  type: "shop_discount";
  /** 开始和结束的时间（Unix 毫秒）。配置可以提前发布，到点自动生效。 */
  startsAt: number;
  endsAt: number;
  /** 打几折：20 表示减 20%。 */
  percent: number;
}

/** 一个实验：把玩家按权重分到几个组里。 */
export interface Experiment {
  variants: { name: string; weight: number }[];
}

export interface GameConfig {
  /** 每次修改加一。客户端和缓存都靠它判断配置变了没有。 */
  version: number;
  /** 公告。空字符串表示没有。 */
  notice: string;
  shop: Record<string, ShopEntry>;
  events: GameEvent[];
  experiments: Record<string, Experiment>;
}

/** 还没有发布过任何配置时用的默认值。 */
export const DEFAULT_CONFIG: GameConfig = {
  version: 0,
  notice: "",
  shop: {
    shield: { cost: { coins: 30, gems: 0 }, grant: { items: { shield: 1 } } },
    dice_skin: { cost: { coins: 0, gems: 80 }, grant: { items: { dice_skin: 1 } } },
  },
  events: [],
  experiments: {},
};

/** 此刻正在进行的活动。 */
export function activeEvents(config: GameConfig, now: number): GameEvent[] {
  return config.events.filter((event) => event.startsAt <= now && now < event.endsAt);
}

/** 一件商品此刻的价格：原价叠加正在进行的折扣，向上取整，最低为 1。 */
export function shopCost(config: GameConfig, itemId: string, now: number): { coins: number; gems: number } | null {
  const entry = config.shop[itemId];
  if (!entry) return null;
  const off = Math.max(0, ...activeEvents(config, now).map((event) => event.percent));
  const apply = (price: number | undefined) => (price ? Math.max(1, Math.ceil((price * (100 - off)) / 100)) : 0);
  return { coins: apply(entry.cost.coins), gems: apply(entry.cost.gems) };
}

/**
 * 一个玩家在某个实验里被分到哪一组。
 * 同一个玩家、同一个实验，结果永远相同；不同的实验之间互不相关。
 */
export function variantOf(playerId: string, key: string, experiment: Experiment): string | null {
  const total = experiment.variants.reduce((sum, variant) => sum + variant.weight, 0);
  if (total <= 0) return null;
  let point = hash(`${key}:${playerId}`) % total;
  for (const variant of experiment.variants) {
    if (point < variant.weight) return variant.name;
    point -= variant.weight;
  }
  return null;
}

/** FNV-1a，32 位。用来把字符串均匀地映射成一个数，不用于任何安全用途。 */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 检查一份要发布的配置。合法时返回整理过的配置（只保留认识的字段），否则返回出错的原因。
 * 配置一旦发布，所有玩家都会读到，所以要在写入之前把能查的都查了。
 */
export function validateConfig(input: unknown): GameConfig | string {
  if (!isRecord(input)) return "配置必须是一个对象";
  if (!isCount(input.version)) return "version 必须是非负整数";
  if (typeof input.notice !== "string" || input.notice.length > 500) return "notice 必须是不超过 500 字的字符串";

  if (!isRecord(input.shop)) return "shop 必须是一个对象";
  const shop: Record<string, ShopEntry> = {};
  for (const [itemId, raw] of Object.entries(input.shop)) {
    if (!isRecord(raw) || !isRecord(raw.cost) || !isRecord(raw.grant) || !isRecord(raw.grant.items)) {
      return `shop.${itemId} 的格式不对`;
    }
    const { coins = 0, gems = 0 } = raw.cost as { coins?: unknown; gems?: unknown };
    if (!isCount(coins) || !isCount(gems)) return `shop.${itemId} 的价格必须是非负整数`;
    // 免费的商品几乎一定是填错了。
    if (coins + gems === 0) return `shop.${itemId} 没有价格`;
    const items: Record<string, number> = {};
    for (const [id, qty] of Object.entries(raw.grant.items)) {
      if (!isCount(qty) || qty === 0 || qty > 1000) return `shop.${itemId} 发放的数量不合理`;
      items[id] = qty;
    }
    if (Object.keys(items).length === 0) return `shop.${itemId} 什么都不发`;
    shop[itemId] = { cost: { coins, gems }, grant: { items } };
  }

  if (!Array.isArray(input.events)) return "events 必须是数组";
  const events: GameEvent[] = [];
  for (const raw of input.events as unknown[]) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.type !== "shop_discount") return "活动的格式不对";
    if (!isCount(raw.startsAt) || !isCount(raw.endsAt) || raw.endsAt <= raw.startsAt) {
      return `活动 ${raw.id} 的时间不对`;
    }
    if (!isCount(raw.percent) || raw.percent < 1 || raw.percent > 90) return `活动 ${raw.id} 的折扣必须在 1 到 90 之间`;
    events.push({
      id: raw.id,
      type: "shop_discount",
      startsAt: raw.startsAt,
      endsAt: raw.endsAt,
      percent: raw.percent,
    });
  }

  if (!isRecord(input.experiments)) return "experiments 必须是一个对象";
  const experiments: Record<string, Experiment> = {};
  for (const [key, raw] of Object.entries(input.experiments)) {
    if (!isRecord(raw) || !Array.isArray(raw.variants) || raw.variants.length === 0) return `实验 ${key} 的格式不对`;
    const variants: Experiment["variants"] = [];
    for (const variant of raw.variants as unknown[]) {
      if (!isRecord(variant) || typeof variant.name !== "string" || !isCount(variant.weight)) {
        return `实验 ${key} 的分组格式不对`;
      }
      variants.push({ name: variant.name, weight: variant.weight });
    }
    if (variants.every((variant) => variant.weight === 0)) return `实验 ${key} 的权重全是 0`;
    experiments[key] = { variants };
  }

  return { version: input.version, notice: input.notice, shop, events, experiments };
}
