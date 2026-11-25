-- 重试多次仍然处理不了的消息。留在这里等人来看，修好问题后可以重新投递。
CREATE TABLE dead_letter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  queue TEXT NOT NULL,
  message_id TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX dead_letter_queue ON dead_letter (queue, at);
