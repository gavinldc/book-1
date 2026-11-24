-- 支付记录：每个订单一行。源头在玩家对象里，这里是用来对账和查询的副本。
CREATE TABLE payment (
  order_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  -- 金额用支付平台的最小单位：Stars 是个数，美元是分。
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  seq INTEGER NOT NULL,
  paid_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX payment_day ON payment (provider, paid_at);
