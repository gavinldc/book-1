/** 订单的引用：哪个玩家的哪个订单。下单时交给支付平台，回调时原样带回来。 */
export interface OrderRef {
  playerId: string;
  orderId: string;
}

const REF = /^(p_[0-9a-f]{24}):(o_[0-9a-f]{24})$/;

export function formatRef(ref: OrderRef): string {
  return `${ref.playerId}:${ref.orderId}`;
}

/** 解析回调里带回来的引用。格式不对的一律当作无效，不去碰任何对象。 */
export function parseRef(text: unknown): OrderRef | null {
  if (typeof text !== "string") return null;
  const match = REF.exec(text);
  return match ? { playerId: match[1]!, orderId: match[2]! } : null;
}

export function newOrderId(): string {
  return "o_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}
