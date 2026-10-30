-- Additive collections migration. Apply to staging before production.
-- User IDs are TEXT. Asset holdings and transactions are never altered.

CREATE TABLE IF NOT EXISTS collections (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 60),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
  items_json TEXT NOT NULL CHECK(CASE WHEN json_valid(items_json) THEN json_type(items_json)='array' AND json_array_length(items_json)<=5000 ELSE 0 END),
  snapshot_json TEXT NOT NULL CHECK(CASE WHEN json_valid(snapshot_json) THEN json_type(snapshot_json)='object' ELSE 0 END),
  catalog_version TEXT NOT NULL,
  create_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(user_id,id)
);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(user_id,deleted_at,updated_at,id);
CREATE TABLE IF NOT EXISTS user_card_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_key TEXT NOT NULL CHECK(length(card_key)=40 AND substr(card_key,1,4)='cp1_'),
  manual_owned INTEGER NOT NULL CHECK(typeof(manual_owned)='integer' AND manual_owned IN(0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>=1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,card_key)
);
CREATE TABLE IF NOT EXISTS collection_mutations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  accepted_revision INTEGER NOT NULL CHECK(typeof(accepted_revision)='integer' AND accepted_revision>=1),
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,scope_id,request_id)
);
