-- 기존 psa_certs 테이블에 PSA 진짜 POP 숫자 컬럼 추가
-- (이미 등록된 cert 는 NULL — 제거 후 재등록 시 채워짐)

ALTER TABLE psa_certs ADD COLUMN psa_total_pop INTEGER;
ALTER TABLE psa_certs ADD COLUMN psa_pop_higher INTEGER;
