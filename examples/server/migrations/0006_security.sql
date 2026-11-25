-- 玩家名录：每个注册过的玩家一行。判断"这个 ID 是不是一个真实的玩家"时查这里，不去碰玩家对象。
CREATE TABLE player (
  player_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- 开局时的座位顺序。有了它和操作日志，一局可以从头重放出来。
ALTER TABLE match_record ADD COLUMN seats TEXT;
