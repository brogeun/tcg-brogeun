-- Local implementation only. Apply explicitly during a separately authorized deployment.
CREATE TABLE IF NOT EXISTS kanto151_saves (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at TEXT NOT NULL,
  bundle_json TEXT NOT NULL
);

-- Keep prior accepted revisions for recovery; no automatic deletion/pruning.
CREATE TABLE IF NOT EXISTS kanto151_save_backups (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  PRIMARY KEY (user_id, revision)
);
