/**
 * 指标：用来画曲线和算比例的数据点，写进 Analytics Engine。
 * 和日志的区别是：日志回答"这一次发生了什么"，指标回答"总体上是多少"。
 *
 * 每种指标的字段顺序是固定的，写入和查询都按位置对应，所以只能在末尾追加，不能调换。
 */
export const METRICS = {
  /** 一次匹配的结果。labels: 地区、结果（pair/bot）。values: 等待毫秒数。 */
  match_made: { labels: ["region", "outcome"], values: ["wait_ms"] },
  /** 匹配对象每次计算时队列里的人数。labels: 地区。values: 人数。 */
  queue_size: { labels: ["region"], values: ["waiting"] },
  /** 一局结束。labels: 类型（private/ranked/mirror）。values: 步数、参加的真人数。 */
  match_end: { labels: ["kind"], values: ["turns", "humans"] },
  /** 一次结算尝试。labels: 结果（ok/retry）。values: 1。 */
  settle: { labels: ["outcome"], values: ["count"] },
  /** 玩家对象送出一批通知。labels: 结果（ok/failed）。values: 条数、最旧一条等了多久（毫秒）。 */
  outbox_flush: { labels: ["outcome"], values: ["rows", "lag_ms"] },
  /** 对象被唤醒时构造函数花的时间。labels: 对象的类。values: 毫秒数。 */
  object_wake: { labels: ["class"], values: ["construct_ms"] },
  /** 一次定时任务。labels: 表达式、结果（ok/failed）。values: 耗时毫秒数。 */
  job_run: { labels: ["cron", "outcome"], values: ["ms"] },
  /** 一笔订单的状态变化。labels: 渠道、状态。values: 金额（最小单位）。 */
  payment: { labels: ["provider", "status"], values: ["amount"] },
} as const;

export type MetricName = keyof typeof METRICS;

export interface DataPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

/** 把一个指标整理成 Analytics Engine 要的形状：指标名在最前面，后面依次是各个标签。 */
export function toDataPoint(name: MetricName, labels: string[], values: number[]): DataPoint {
  const shape = METRICS[name];
  if (labels.length !== shape.labels.length || values.length !== shape.values.length) {
    throw new Error(`指标 ${name} 的字段个数不对`);
  }
  // 指标名同时作为采样键：数据量大到需要采样时，每种指标各自采样，量小的不会被量大的挤掉。
  return { indexes: [name], blobs: [name, ...labels], doubles: values };
}

/** 写一个数据点。指标写不进去不应该影响正常的业务，所以这里吞掉所有异常。 */
export function metric(env: Env, name: MetricName, labels: string[], values: number[]): void {
  try {
    env.METRICS.writeDataPoint(toDataPoint(name, labels, values));
  } catch {
    // 忽略。
  }
}
