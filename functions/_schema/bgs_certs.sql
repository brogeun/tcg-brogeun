-- BGS Certificate 누적 테이블
-- 사용자가 BGS cert# 를 등록 → Beckett 공식 POP (블랙라벨10 / 골드라벨10) 카드별 캐싱
-- 동일 cert# 는 전역 unique

CREATE TABLE IF NOT EXISTS bgs_certs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_number     TEXT NOT NULL UNIQUE,
  card_id         TEXT NOT NULL,           -- SNKRDUNK product id (우리 시스템 식별자)
  user_id         INTEGER NOT NULL,
  -- Beckett 응답 주요 필드
  final_grade     TEXT,                    -- "10.0"
  label           TEXT,                    -- gold / black 등
  card_key        TEXT,                    -- Beckett 카드 번호 (e.g. "OP07051")
  player_name     TEXT,
  set_name        TEXT,
  -- POP (등록 시점 스냅샷 — 최신 행이 카드의 현재 POP)
  pop_total       INTEGER,                 -- pop_report (총 그레이딩 수)
  pop_bl10        INTEGER,                 -- fgB100 (블랙라벨 10)
  pop_gl10        INTEGER,                 -- fg100  (골드라벨 10)
  pop_95          INTEGER,                 -- fg95   (9.5)
  registered_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  raw_payload     TEXT                     -- JSON.stringify(Beckett 응답)
);

CREATE INDEX IF NOT EXISTS idx_bgs_certs_card_id ON bgs_certs(card_id);
CREATE INDEX IF NOT EXISTS idx_bgs_certs_user_id ON bgs_certs(user_id);
