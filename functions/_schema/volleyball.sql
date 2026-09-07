-- Additive migration for the existing DB binding. No user/card tables are changed.
CREATE TABLE IF NOT EXISTS volleyball_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'normal', 'hard')),
  player TEXT NOT NULL,
  opponent TEXT NOT NULL,
  rules_version INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  score INTEGER,
  conceded INTEGER,
  duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS volleyball_records (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'normal', 'hard')),
  nickname TEXT NOT NULL,
  character TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 7),
  conceded INTEGER NOT NULL CHECK (conceded BETWEEN 0 AND 7),
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  achieved_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, difficulty),
  CHECK ((score = 7 AND conceded < 7) OR (conceded = 7 AND score < 7))
);
CREATE INDEX IF NOT EXISTS idx_volleyball_records_ranking
  ON volleyball_records(difficulty, score DESC, conceded ASC, duration_ms ASC, achieved_at ASC, user_id ASC);
PRAGMA optimize;
