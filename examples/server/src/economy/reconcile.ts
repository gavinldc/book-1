import type { PlayerEvent } from "../social/events";

type PaymentEvent = Extract<PlayerEvent, { type: "payment" }>;

/** 把一个订单的最新状态写进 D1。按序号覆盖：付款和退款的通知乱序到达时，留下的是后发生的那个。 */
export async function savePayment(db: D1Database, event: PaymentEvent): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payment
         (order_id, player_id, product_id, provider, amount, currency, status, external_id, seq, paid_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (order_id) DO UPDATE
         SET status = excluded.status, external_id = excluded.external_id,
             seq = excluded.seq, updated_at = excluded.updated_at
         WHERE excluded.seq > payment.seq`,
    )
    .bind(
      event.orderId,
      event.playerId,
      event.productId,
      event.provider,
      event.amount,
      event.currency,
      event.status,
      event.externalId,
      event.seq,
      event.paidAt,
      event.at,
    )
    .run();
}

export interface Totals {
  provider: string;
  currency: string;
  status: string;
  orders: number;
  amount: number;
}

/**
 * 一段时间内各支付渠道的订单数和金额，用来和支付平台的账单核对。
 * 两边对不上时，再按订单号逐笔比。
 */
export async function totalsBetween(db: D1Database, from: number, to: number): Promise<Totals[]> {
  const rows = await db
    .prepare(
      `SELECT provider, currency, status, COUNT(*) AS orders, SUM(amount) AS amount
       FROM payment WHERE paid_at >= ? AND paid_at < ?
       GROUP BY provider, currency, status ORDER BY provider, currency, status`,
    )
    .bind(from, to)
    .all<Totals>();
  return rows.results;
}
