/**
 * 匹配按地区分开：同一个地区的玩家进同一个队列，房间也建在这个地区。
 * 地区分得越细延迟越低，但每个队列里的人越少、等得越久，所以只分三个。
 */
export const REGIONS = {
  asia: { hint: "apac" },
  europe: { hint: "weur" },
  america: { hint: "enam" },
} as const satisfies Record<string, { hint: DurableObjectLocationHint }>;

export type Region = keyof typeof REGIONS;

/** 取不到位置时用的地区。 */
export const DEFAULT_REGION: Region = "asia";

/** 按请求进入 Cloudflare 的位置所在的大洲决定地区。这个值由平台给出，客户端改不了。 */
export function regionOf(continent: string | undefined): Region {
  switch (continent) {
    case "AS":
    case "OC":
      return "asia";
    case "EU":
    case "AF":
      return "europe";
    case "NA":
    case "SA":
      return "america";
    default:
      return DEFAULT_REGION;
  }
}

export function isRegion(value: string | null): value is Region {
  return value !== null && value in REGIONS;
}

/** 入口传给匹配对象的请求头。和玩家 ID 一样，由入口在校验之后写入。 */
export const RATING_HEADER = "X-Player-Rating";
export const REGION_HEADER = "X-Match-Region";
