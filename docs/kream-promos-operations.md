# 한국 프로모 KREAM 자동 수집

대상은 `1096144, 893073, 998016, 998022, 937106, 934334, 508949`의 7종이다.
사인 아리와 포켓패드는 제외한다. 등급·라벨·팩 옵션별 원본 거래와 동일 날짜·가격의 별도 거래를 보존한다.

## 기본 운영: 소유자 Windows PC에서 수집

2026-11-03에 소유자 PC의 정상 로그인과 새 컨텍스트 전체 체결 접근은 성공했다.
같은 상태를 등록한 GitHub 서버는 첫 상품 HTTP 500으로 실패했고, 별도 Windows Edge와
Ubuntu Chrome 점검도 상품 탐색 단계에서 실패했다. 같은 Windows 서버의 비로그인·로그인
컨텍스트 모두 HTTP 응답 없이 탐색이 실패했다. 서버 측 원인이나 IP 차단 여부는 확정하지 않는다.
따라서 클라우드 수집 예약은 중지하고 `KREAM Korean Promos Daily`는 수동 진단용으로 남긴다.

`scripts/install_kream_local.ps1 -SourceRef <검토·병합된 40자리 커밋>`을 소유자의
Windows PowerShell에서 실행한다. 설치 파일과 Python 코드 모두 같은 고정 커밋에서 받는다.
수집은 일반 사용자 권한으로 실행한다. 기존 Python 3.11, GitHub CLI 로그인을 사용한다.
예약 작업 등록은 Windows 권한 설정에 따라 같은 계정의 관리자 승인이 필요할 수 있다.
필요한 Python 패키지는 `playwright==1.56.0`, `tzdata`이다. 설치된 Edge를 사용한다.

- 전용 Edge 프로필: `%LOCALAPPDATA%\TCGHUB\kream-local\profile`.
  기존 일반 브라우저 프로필은 읽지 않는다. 이 프로필에만 로그인 상태를 PC에 유지한다.
  이전 연결 도구의 임시 브라우저와 별개이므로 최초 설치 때 이 전용 창에서 한 번 로그인한다.
- 설치 도구가 `run_kream_local.py --setup`을 실행한다. 로그인 후 PowerShell에서 Enter를 누르면
  실제 전체 체결 창과 여섯 번째 행을 확인한다. 로그인 대기 중 브라우저 이벤트를 계속 처리한다.
- 현재 Windows 사용자로 작업 `TCGHUB-KREAM-Local-<사용자 SID>`를 등록한다.
  매일 오전 09:00 **Windows 현지 시각**과 사용자 로그인 시 실행한다.
  PC가 켜져 있고 해당 사용자가 로그인해 있어야 한다. 놓친 실행은 다음 가능한 때 실행하며
  동시 실행은 무시한다. 수집 도중 Edge 전용 창이 보이는 것은 정상이다.
- 설치 직후 첫 전체 수집을 실행한다. 이후 당일 동일 세대 성공이 있으면 중복 수집을 생략한다.
- 안전한 진행 기록: `%LOCALAPPDATA%\TCGHUB\kream-local\logs\latest.log`.
  인증값·원본 예외·브라우저 추적·스크린샷은 기록하지 않는다.

`--run`은 GitHub의 최신 main 커밋을 고정하고 기존 9개 가격 JSON을 내려받아 검증한다.
같은 전용 Edge 컨텍스트에서 7종 전체를 수집하고, 모든 기존 거래의 다중집합 보존을 확인한다.
전체 수집 성공 후에만 9개 가격 JSON으로 이루어진 새 데이터 커밋과
`kream-local-data/*` 브랜치를 만들고 `KREAM Local Publish`를 main에서 요청한다.
브라우저 프로필·비밀번호·쿠키·세션값은 업로드하지 않는다. PC에 Git 설치는 필요 없다.
수집·로그인·완전성 검사 실패 시 원격 데이터나 원격 성공 상태를 변경하지 않는다.

서버는 main의 검토된 코드만 실행한다. 전달된 커밋은 체크아웃하거나 실행하지 않고,
정확한 부모 커밋·9개 경로·일반 파일 모드·동일 기준 세대·JSON·정적 메타데이터·관측 시각·
전체 거래량과 옵션·모든 과거 거래의 다중집합을 검사한다. 검증 전 가격 파일을 변경하지 않는다.
기존 원자적 게시 도구로 현재 main의 동시 변경을 다시 확인한 뒤 9개 파일을 함께 게시한다.
기준 가격 파일이 수집 중 바뀌면 해당 변경을 보존하고 게시를 중단한다.
`KREAM Local Publish` 성공은 기존 `Scrape SNKRDUNK Daily`의 배포 전용 실행을 요청한다.
PC의 업로드 요청 메시지만으로 수집·배포 성공으로 표시하지 않는다.

로그인 만료 시 작업을 반복 우회하지 않고 중단한다. 같은 고정 버전 설치 명령을 다시 실행해
전용 Edge 창에서 정상 재로그인하면 된다. 프로필을 삭제하면 저장된 로그인도 제거된다.
자동 실행만 중지하려면 현재 사용자 PowerShell에서 다음을 실행한다.

```powershell
$kreamInstall = Get-Content (Join-Path $env:LOCALAPPDATA 'TCGHUB\kream-local\install.json') -Raw | ConvertFrom-Json
Unregister-ScheduledTask -TaskName $kreamInstall.taskName -Confirm:$false
```

Windows PC를 공개 저장소의 자체 호스팅 Actions 실행기로 등록하지 않는다.

### 로그인 성공 뒤 예약 등록만 거부된 경우

`dedicated_profile_verified`, `setup_complete` 뒤 `Register-ScheduledTask`의
`0x80070005`가 나오면 로그인 상태는 전용 프로필에 저장됐지만 예약은 등록되지 않은 상태다.
기존 릴리스의 `run_kream_local.py --run`을 일반 사용자 창에서 실행하면 재로그인 없이
첫 수집을 요청할 수 있다. 세션이 실제로 만료됐다면 수집기는 정상 로그인 요구를 표시한다.

설치기는 등록 실패를 `install.json`의 `scheduleStatus: registration_failed`로 저장하고
첫 수집을 계속한다. 수집까지 성공해도 예약이 없으면 설치 종료 코드는 3이다.
이 종료 코드는 수집 실패나 로그인 실패를 뜻하지 않는다. 실제 게시 결과는 Actions에서 확인한다.

새 설치기의 `-ScheduleOnly -SourceRef <기존에 설치한 40자리 SHA> -OwnerSid <소유자 SID>`는
기존 릴리스의 예약 등록만 재시도한다. 이전 설치에 `install.json`이 없어도 동작한다.
브라우저·Python·GitHub CLI를 실행하거나 로그인·다운로드·수집을 반복하지 않는다.
실행 파일 경로만 확인해 같은 사용자의 `Interactive`·`Limited` 작업을 구성한다.
관리자 승인이 필요하면 일반 사용자 창에서 소유자 SID를 확보한 뒤 같은 계정으로
등록 전용 명령을 승격한다. 다른 관리자 계정으로 바뀌면 거부한다.
재시도에서도 거부되면 Windows의 작업 등록 권한을 점검해야 한다. 작업 ACL이나 보안 정책을 변경하지 않는다.

## 최초 연결 또는 세션 만료 시

다음은 **수동 클라우드 진단용** 연결이다. 기본 운영은 위 PC 수집이다.

2026-11-02에 공개 상품 페이지를 확인했을 때 비로그인 화면은 최근 5건만 보여주고
“모든 시세는 로그인 후 확인 가능합니다.”를 표시했다. 전체 체결 수집에는 정상 로그인이 필요하다.
기존 GitHub 실행은 상품 페이지 HTTP 500에서 중단됐다. 그 500의 서버 측 원인은 확인되지 않았다.
로그인 세션 연결은 확인된 필수 조건이며, 연결만으로 GitHub 서버의 500이 해결됐다고 단정하지 않는다.

본인 컴퓨터에서 이 저장소를 열고 Python, GitHub CLI를 설치한 후 실행한다.

```sh
gh auth login
python -m pip install 'playwright==1.56.0' tzdata
python -m playwright install chromium
python scripts/setup_kream_session.py
```

Windows에 설치된 Edge를 사용하려면 `python scripts/setup_kream_session.py --browser msedge`로 실행한다.
열린 KREAM 창에서 직접 로그인하고 터미널에서 Enter를 누른다.
도구는 한복 아리의 전체 체결 창에 접근할 수 있는지 확인하고,
KREAM 도메인의 브라우저 상태만 GitHub Actions의 `KREAM_STORAGE_STATE` 비밀값으로 등록한다.
브라우저 상태는 메모리에서 GitHub CLI 표준입력으로 전달한다. 세션 파일·비밀번호·쿠키를 저장소나 채팅에 올리지 않는다.
이 명령은 해당 이름의 기존 비밀값을 교체하고 `KREAM Korean Promos Daily` 수동 실행을 요청한다.
스크립트는 기존 브라우저 프로필을 읽거나 변경하지 않는 새 브라우저를 연다.
로그인 대기 중에도 브라우저 이벤트를 처리하고, 체결 창이 실제로 열린 뒤 여섯 번째 행을 검사한다.
첫 클릭이 페이지 초기화 전에 무효가 된 경우에만 화면 로딩 후 한 번 더 확인한다.
기본 브라우저 상태로 새 창 검증이 안 될 때 필요한 경우에 한해, 로그인한 현재 탭의
정확한 `https://kream.co.kr` 또는 `https://www.kream.co.kr` sessionStorage를 메모리에서 추가 복원한다.
이 추가 상태도 새 컨텍스트의 여섯 번째 체결 검증을 통과해야 등록하며, 자동 수집기도 같은 형식으로 복원한다.
추가 저장소의 키와 값은 출력하지 않고, 전체 비밀값의 48 KiB 제한을 유지한다.
401/403/429 등 접근 거부와 일반 실행 오류는 이 복원 방식으로 재시도하지 않는다.

이 작업을 원격 점검 도구가 대신 로그인하거나 인증을 우회해서 완료하지 않는다.
인증·접근 차단이 나오면 정상 계정 접근을 확인하고 중단한다.
연결된 세션의 만료나 GitHub 실행 환경의 접근 거부가 발생하면 다시 수동 조치가 필요하다.

## 일일 실행과 확인

워크플로: `.github/workflows/kream-promos-daily.yml`

- 클라우드 예약은 중지했다. 기본 수집은 위 Windows 작업의 09:00 현지 시각과 로그인 시 실행이다.
- 수동 클라우드 진단은 PC의 정상 세대와 같은 파일들을 게시하므로 필요할 때만 실행한다.
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
