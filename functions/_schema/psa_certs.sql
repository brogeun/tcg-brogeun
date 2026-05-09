-- PSA Certificate 누적 테이블
-- 사용자가 보유한 PSA 카드의 cert# 를 등록 → 동일 카드의 PSA10/PSA9 POP 카운트
-- 동일 cert# 는 전역 unique (한 cert 는 한 번만 등록 가능)

CREATE TABLE IF NOT EXISTS psa_certs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_number     TEXT NOT NULL UNIQUE,
  card_id         TEXT NOT NULL,           -- SNKRDUNK product id (우리 시스템 식별자)
  grade           INTEGER NOT NULL,        -- PSA grade (10, 9, 8 ...)
  user_id         INTEGER NOT NULL,
  holding_id      INTEGER,                 -- 어느 holding 에 연결됐는지 (선택)
  -- PSA API 응답 원본 (변경/검증/디버깅용)
  spec_id         TEXT,
  brand           TEXT,
  year            TEXT,
  subject         TEXT,
  card_number     TEXT,                    -- PSA 가 인식한 카드 번호 (e.g. "197")
  variety         TEXT,
  category        TEXT,
  registered_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  raw_payload     TEXT                     -- JSON.stringify(PSA API response)
);

CREATE INDEX IF NOT EXISTS idx_psa_certs_card_id ON psa_certs(card_id);
CREATE INDEX IF NOT EXISTS idx_psa_certs_user_id ON psa_certs(user_id);
CREATE INDEX IF NOT EXISTS idx_psa_certs_grade   ON psa_certs(grade);
