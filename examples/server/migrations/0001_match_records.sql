-- 对局记录：每局一行，客服查询和排查问题用。
CREATE TABLE match_record (
  match_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  winner TEXT,
  players TEXT NOT NULL,
  log TEXT NOT NULL,
  ended_at INTEGER NOT NULL
);

-- 录像：排位赛里每个真实玩家一行，镜像对战从这里挑对手。
CREATE TABLE replay (
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  rolls TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX replay_rating ON replay (rating);
