-- 排行榜：每个榜里每个玩家一行。数据的源头是玩家对象，这里是用来排序和查询的副本。
CREATE TABLE leaderboard (
  board TEXT NOT NULL,
  player_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  -- 玩家对象发出这次更新时的序号，用来丢弃迟到的旧更新。
  seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (board, player_id)
);
CREATE INDEX leaderboard_rank ON leaderboard (board, score DESC, updated_at);

-- 邀请关系：每个被邀请的人一行。源头同样在玩家对象里。
CREATE TABLE invite (
  invitee TEXT PRIMARY KEY,
  inviter TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rewarded_at INTEGER
);
CREATE INDEX invite_inviter ON invite (inviter, created_at);
