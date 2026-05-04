# 내일 아침 (5/5 06:00) 작업 루트 — Step by Step

> 일어나서 이 파일 보면 정확히 뭘 어느 순서로 할지 적혀있음.
> 모르는 거 있으면 채팅에 그대로 물어봐.

---

## 🌅 STEP 0 — 일어나자마자 (5분)

### 0-1. 백필 종료 확인
cmd 창 (백필 돌고 있던 거) 보면:
```
================================================
완료: 확장 X / 변화없음 Y / skip Z / 실패 W
소요 시간: 약 8~9시간
================================================
```
이 메시지 떴는지 확인.

**아직 안 끝났으면:** Ctrl+C 로 종료 (자체 저장은 카드 단위로 됐으니 손실 없음)

### 0-2. 백필 결과 push
```bash
cd "C:\Users\pc\Desktop\TCG project\TCG 프로젝트"
git status
# data/history/ 변경사항 많이 보일 것
git add data/history/
git commit -m "📊 거래량 풀 백필 완료 (max-pages=500)"
git push
```

> ⚠ 주의: 자기 전 커밋 안 한 변경 (어제 ↑ 버튼 + all-cards fallback + TODO) 있음
> → step 0-3 에서 같이 정리

### 0-3. 어제 미커밋 변경 push
어제 자기 전 commit 안 된 게 두 개 있어:
1. **↑ 버튼** — 카드 시세 페이지에서 카드 리스트로 복귀
2. **검색 결과 클릭 → 카드 못 찾는 버그 fix** — all-cards.json fallback 추가
3. TODO_TOMORROW.md (이 파일)

```bash
git add index.html TODO_TOMORROW.md
git commit -m "🐛 검색 결과 클릭 버그 fix + ↑ 버튼 카드 리스트 복귀"
git push
```

→ 자동 배포 트리거 (paths-ignore 가 data/scripts 만 무시, index.html 은 trigger 함)
→ 1~2분 후 사이트 반영

---

## 🔴 STEP 1 — 버그 검증 (15분)

배포 끝난 거 확인 후 사이트 들어가서:

### 1-1. 검색 버그 fix 검증
- https://tcghub.kr 에서 "리자몽" 검색
- 결과 클릭 → **이번엔 차트/가격 페이지가 잘 떠야 함**
- "카드 정보를 찾을 수 없습니다" 안 뜨는지 확인

**여전히 안 되면:** 콘솔 (F12) 열어서 에러 확인. 채팅에 스크린샷 보내.

### 1-2. ↑ 버튼 검증
- 카드 클릭 → 차트 페이지 → ↑ 버튼 클릭
- 카드 리스트 화면 (검색바 + 탭 + 그리드)으로 복귀하는지

---

## 🔴 STEP 2 — 모바일 홈 inline expand 수정 (30분)

### 증상
모바일에서 "포켓몬 카드" 탭 → TOP 10 이 "원피스 카드" 타일 **아래** 에서 펼쳐짐

### 원하는 동작
```
[포켓몬 타일]
[포켓몬 TOP 10] ← 펼쳐지면 바로 아래
[원피스 타일]
[원피스 TOP 10] ← 원피스 펼쳐지면 바로 아래
```

### 작업
- `index.html` 의 홈 페이지 HTML 구조 변경
- 데스크톱은 그대로 두고 모바일만 inline expand
- CSS media query 활용

**채팅에서:** "STEP 2 모바일 홈 inline expand 시작하자" 라고 말하면 내가 코드 작성해줌.

---

## 🟡 STEP 3 — 마이페이지 실데이터 폴리싱 (30~60분)

### 준비
- 사이트에 실제 로그인 (이메일 입력 → magic link)
- 카드 시세에서 카드 1~3개 추가 (포트폴리오 / 관심 둘 다)
- 마이페이지 들어가서 보이는 거 스크린샷 보내

### 폴리싱할 것 (예상)
- 프로필 헤더 정렬 / 아바타
- Hero 평가액 카드 시각적 무게감
- Stats 3개 카드 (매입가 / 최고수익 / 등급분포)
- 손익 색상 (양수 초록 / 음수 빨강) 잘 보이는지
- 차트 동작
- 모바일 반응형

**채팅에서:** "마이페이지 스크린샷이야" + 이미지 보내면 폴리싱 시작.

---

## 🟢 STEP 4 — 박스 이미지 자체 호스팅 (1~2시간)

### 작업 내용
1. `scripts/fetch_set_images.py` 작성
2. 포켓몬 ~20개 박스 (tcgcollector 에서) + 원피스 ~20개 박스 (tcgrepublic 에서) 이미지 다운로드
3. `images/sets/{code}.jpg` 로 저장
4. push → 자동 반영

**채팅에서:** "STEP 4 박스 이미지 자체 호스팅 시작" 이라고 말하면 진행.

---

## 🟢 STEP 5 — 카드 그리드 자체 호스팅 (Phase 2, 3~5시간)

### 목표
세트별로 카드 전체 (이미지 + 이름 + 번호) 자체 사이트에 표시.
- ~5,400 카드 (포켓몬 ~3,000 + 원피스 ~2,400)
- 외부 사이트 안 거치는 폐쇄 루프

### 작업
1. `scripts/fetch_set_cards.py` 작성
   - 각 세트의 `displayAs=images` 페이지 스크랩
   - 카드별 이미지 + 이름 + 번호 추출
2. `data/cards-by-set/{code}.json` 저장
3. UI: 카드 정보 → 박스 클릭 → 카드 그리드 표시
4. 카드 클릭 → 우리 시세 차트로 (5,400 카드 ID 매핑 필요)

**채팅에서:** STEP 4 끝나고 시작하자고 말하면 진행.

---

## 🟢 STEP 6 — 카드 → 박스 매핑 (1~2시간)

### 작업
1. SNKRDUNK `apparels/{id}` API 응답 분석 → `relatedProducts` 또는 `set` 필드 확인
2. 카드 시세 상세 페이지에 "이 카드가 나오는 상자" 추가
3. 박스 썸네일 클릭 → STEP 5 의 카드 그리드로 이동

→ **STEP 5 + 6 = 자체 사이트 무한 순환 완성**

---

## 🟢 STEP 7 — PSA 10 Pop 표시 (2~3시간)

### 작업
1. PSA Set Registry URL 매핑 (40개 세트, 수동 30분)
2. `scripts/fetch_psa_pop.py` 작성
3. psacard.com 에서 세트별 카드 PSA10 pop 추출
4. `data/psa-pop/{set-code}.json` 저장
5. 카드 시세 페이지에 "📊 PSA 10 Pop: 6,011" 한 줄 표시
6. GitHub Actions 에 단계 추가 (월 1회 갱신)

> 참고: PSA 데이터는 1년 이상 된 카드는 거의 안 변하니 **한번만 받으면 사실상 영구 캐시**
> tcgbreaker 도 똑같이 PSA 사이트 스크래핑함. 90~95% 안정성. 이 정도면 충분.

---

## 📋 STEP 8 — 자동 신규 카드 감지 워크플로우 (30~60분)

### 작업
1. `scripts/discover_new_cards.py` 작성
2. SNKRDUNK 리스팅 API 호출 → 기존 all-cards.json 와 diff
3. 신규 카드만 history 백필
4. `.github/workflows/scrape.yml` 에 단계 추가 (cron 04:00 KST 매일)

→ 신규 세트 발매 시 자동으로 데이터 업데이트

---

## 📱 STEP 9 — Google Play Store 출시 (4~5시간 + Google 심사 1~7일)

### Play Console 등록 완료 ✓ (계정 ID: 4723643500921102919)

### 9-A. TWA 빌드 (1~2시간)
1. Bubblewrap CLI 설치
   ```bash
   npm install -g @bubblewrap/cli
   ```
2. PWA 를 TWA 로 변환
   ```bash
   bubblewrap init --manifest https://tcghub.kr/manifest.json
   ```
3. 빌드 → AAB 파일 생성
   ```bash
   bubblewrap build
   ```

### 9-B. 에셋 준비 (1~2시간)
- 앱 아이콘 512×512 PNG (이미 있는 brand-logo.png 활용)
- Feature 그래픽 1024×500
- 스크린샷 4~8장 (홈 / 카드 시세 / 차트 / 마이페이지)
- 간단한 영상 (선택)

### 9-C. Play Console 등록 (1시간)
- 앱 정보 작성
- 카테고리: **쇼핑** 또는 **도구**
- 콘텐츠 등급 설문 (모든 연령)
- 데이터 안전 설문 (이메일, 포트폴리오 데이터 보유 명시)
- 개인정보처리방침 URL: https://tcghub.kr/privacy.html
- 첫 출시: **내부 테스트** 트랙 (자기만 설치해서 검증)

### 9-D. 심사 + 공개 (1~7일)
- 내부 테스트 → 비공개 테스트 → 공개 출시 순으로 점진 확장
- 첫 심사: 보통 1~3일

→ **STEP 1~7 끝나고 사이트 안정화 된 후 진행 추천**. 급한 거 아님.

---

## ⚙ 작업 순서 추천

```
06:00 STEP 0 (백필 push) — 5분
      STEP 1 (버그 검증) — 15분
06:30 STEP 2 (모바일 홈) — 30분
07:00 STEP 3 (마이페이지) — 60분
08:00 출근 (집중력 좋을 때 STEP 1~3 끝)
─────────────────────────
저녁 후
19:00 STEP 4 (박스 이미지) — 2시간
21:00 STEP 5 (카드 그리드) — 3~5시간
       또는 다음 날로 분할
```

복잡한 작업 (STEP 5~7) 은 시간 여유 있을 때 천천히 가자.

---

## 🚨 충돌 / 에러 사전 점검

### Push 충돌 가능성
- 어제 ↑ 버튼 + all-cards fallback 변경했는데 commit 안 함 → STEP 0-3 에서 처리
- TODO_TOMORROW.md 도 add 안 됨 → STEP 0-3 에서 처리
- data/history/ 는 백필 끝난 후 따로 push (STEP 0-2)

### 자동 배포 트리거
- index.html 변경 push → 트리거됨 ✓ (paths-ignore 에 없음)
- data/history push → 트리거 안됨 (paths-ignore: data/**)
- → 그래서 STEP 0-2 따로 하고, STEP 0-3 따로 하면 깔끔

### 콘솔 에러 모니터링
- F12 → Console 에서 빨간 줄 있나 확인
- 특히 `_ALL_CARDS_DETAILS` 관련 (어제 추가한 fallback)

---

## 📦 어제까지 완료된 작업

- [x] 가격 차트 1년 확장 (3,387 카드)
- [x] UI 개선 (사이드바 footer, 모바일 검색 토글, 정보 허브 3탭)
- [x] 카드 정보 검색바 + 이모티콘
- [x] 마이페이지 UI 재설계 (Hero 카드 + 프로필 헤더)
- [x] 문의 팝업 (텔레그램 + 이메일 클립보드 복사)
- [x] Footer 바닥 고정
- [x] 워크플로우 push 자동 배포 (paths-ignore 적용)
- [x] 한글 포켓몬 1,025마리 alias (PokéAPI 체인 매칭, 100% 커버리지)
- [x] 한글 표기 22 + 7 = 29개 수정
- [x] 거래량 백필 (자기 전 ~64% / 4,223 카드, 자는 동안 완료 예상)
- [x] **검색 결과 클릭 → 카드 못 찾는 버그 fix (all-cards.json fallback)** ← 어제 추가
- [x] **↑ 버튼: 카드 리스트로 복귀** ← 어제 추가

---

## 💬 도움 요청 시 채팅에서 이렇게 말하면 됨

- "백필 push 끝, STEP 1 검증 결과 [OK/실패]"
- "STEP 2 모바일 홈 inline expand 시작하자"
- "마이페이지 스크린샷이야" + 이미지
- "STEP 4 박스 이미지 시작"
- "STEP 5 카드 그리드 시작"
- 에러 나면: "[STEP X] 에서 [에러 메시지]" + 스크린샷
