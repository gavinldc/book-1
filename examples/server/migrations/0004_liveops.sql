-- 管理后台的操作记录：谁在什么时候对谁做了什么。只增不改。
CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  admin TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX admin_log_target ON admin_log (target, at);

-- 发给所有人（或者一类人）的邮件。玩家打开邮箱时才来这里取，不逐个投递。
CREATE TABLE broadcast_mail (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  attachment TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  -- 只发给这个时间之前注册的玩家。补偿某次故障时，故障之后才来的人不该领。
  registered_before INTEGER NOT NULL
);
CREATE INDEX broadcast_mail_time ON broadcast_mail (ends_at);

-- 分数分布：每个榜按分数段统计人数，定时重算。用来估算靠后的玩家超过了多少人。
CREATE TABLE score_bucket (
  board TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  players INTEGER NOT NULL,
  PRIMARY KEY (board, bucket)
);

-- 还没付款的订单也进支付记录，定时任务靠它找出需要去支付平台核实的订单。
ALTER TABLE payment ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX payment_pending ON payment (status, created_at);
