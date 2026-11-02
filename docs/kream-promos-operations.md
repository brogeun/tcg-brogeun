# 한국 프로모 KREAM 자동 수집

대상은 `1096144, 893073, 998016, 998022, 937106, 934334, 508949`의 7종이다.
사인 아리와 포켓패드는 제외한다. 등급·라벨·팩 옵션별 원본 거래와 동일 날짜·가격의 별도 거래를 보존한다.

## 최초 연결 또는 세션 만료 시

2026-11-02에 공개 상품 페이지를 확인했을 때 비로그인 화면은 최근 5건만 보여주고
“모든 시세는 로그인 후 확인 가능합니다.”를 표시했다. 전체 체결 수집에는 정상 로그인이 필요하다.
기존 GitHub 실행은 상품 페이지 HTTP 500에서 중단됐다. 그 500의 서버 측 원인은 확인되지 않았다.
로그인 세션 연결은 확인된 필수 조건이며, 연결만으로 GitHub 서버의 500이 해결됐다고 단정하지 않는다.

본인 컴퓨터에서 이 저장소를 열고 Python, GitHub CLI를 설치한 후 실행한다.

```sh
gh auth login
python -m pip install 'playwright==1.56.0'
python -m playwright install chromium
python scripts/setup_kream_session.py
```

열린 KREAM 창에서 직접 로그인하고 터미널에서 Enter를 누른다.
도구는 한복 아리의 전체 체결 창에 접근할 수 있는지 확인하고,
KREAM 도메인의 브라우저 상태만 GitHub Actions의 `KREAM_STORAGE_STATE` 비밀값으로 등록한다.
브라우저 상태는 메모리에서 GitHub CLI 표준입력으로 전달한다. 세션 파일·비밀번호·쿠키를 저장소나 채팅에 올리지 않는다.
이 명령은 해당 이름의 기존 비밀값을 교체하고 `KREAM Korean Promos Daily` 실행을 요청한다.
스크립트는 기존 브라우저 프로필을 읽거나 변경하지 않는 새 브라우저를 연다.

이 작업을 원격 점검 도구가 대신 로그인하거나 인증을 우회해서 완료하지 않는다.
인증·접근 차단이 나오면 정상 계정 접근을 확인하고 중단한다.
연결된 세션의 만료나 GitHub 실행 환경의 접근 거부가 발생하면 다시 수동 조치가 필요하다.

## 일일 실행과 확인

워크플로: `.github/workflows/kream-promos-daily.yml`

- 06:10 KST 기본 예약, 07:40 KST 보조 예약. GitHub 예약은 지연될 수 있으며 정확한 시각을 보장하지 않는다.
- 보조 실행은 당일 06:10 이후 성공한 동일 세대의 상태가 있을 때만 수집을 생략한다. 실패 후에는 재시도한다.
- 세션 누락/잘못된 형식은 브라우저 설치 전에 실패 처리한다.
- 500/502/503/504만 동일 브라우저에서 최대 3회 시도한다. 401/403/429 또는 로그인 요구는 우회·반복하지 않는다.
- 7종 전체 수집·원본 거래의 다중집합 보존·후보 세대 검증을 통과한 후에만 가격 파일을 교체한다.
- 검증 또는 쓰기 실패 시 이전 데이터를 보존한다. 혼합 세대는 게시 스크립트의 검증에서도 거부한다.
- `data/korean-promos-health.json`의 `failure_code`, `failed_product_id`, `http_status`는 인증값 없이 원인을 표시한다.
- 수집 실패도 기존 배포 워크플로가 상태 파일을 반영한다. 실패 상태 배포 성공은 수집 성공이 아니다.

정상화 완료 조건은 전체 수집 실행 성공, 7종 합계/옵션별 차트 거래량 일치,
`Scrape SNKRDUNK Daily` 배포 성공, 운영 사이트와 저장소의 동일 세대 확인이다.
비밀값 설정이나 사전 점검만으로 최신 수집 성공으로 표시하지 않는다.

참고: [Playwright 인증 상태](https://playwright.dev/python/docs/auth),
[GitHub Actions 비밀값](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets),
[GitHub 예약 실행 지연](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows).
