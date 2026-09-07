-- Separate version-3 leaderboards; legacy single-mode records remain untouched.
CREATE TABLE IF NOT EXISTS jigglypuff_mode_sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('speed','endless')), nickname TEXT NOT NULL,
 seed INTEGER NOT NULL, rules_version INTEGER NOT NULL, started_at INTEGER NOT NULL,
 completed_at INTEGER, score INTEGER, max_level INTEGER, won INTEGER, duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS jigglypuff_mode_records (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('speed','endless')), nickname TEXT NOT NULL,
 score INTEGER NOT NULL CHECK(score>=0), max_level INTEGER NOT NULL CHECK(max_level BETWEEN 0 AND 7),
 won INTEGER NOT NULL CHECK(won IN (0,1)), duration_ms INTEGER NOT NULL CHECK(duration_ms>=1), achieved_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,mode), CHECK(mode!='speed' OR won=1)
);
CREATE INDEX IF NOT EXISTS idx_jigglypuff_speed ON jigglypuff_mode_records(mode,duration_ms,achieved_at,user_id);
CREATE INDEX IF NOT EXISTS idx_jigglypuff_endless ON jigglypuff_mode_records(mode,score DESC,duration_ms,achieved_at,user_id);
