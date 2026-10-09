# 인증번호 카드·POP 자동 조회 작업기

PSA 공식 API와 TCG HUB의 인증 조회 대기열을 연결합니다. 서버가 인증번호를 접수하고, 운영자 PC 작업기가 카드 정보와 POP를 확인하여 결과를 전달합니다.

2026-10-09 기준 서버의 등록 횟수 제한 제거와 작업기 API 경로는 반영했습니다. 실제 PSA API에서는 HTTP 429와 Retry-After를 받았으며, 카드·POP 조회 성공은 아직 확인하지 못했습니다. 과거 브라우저 조회 3건은 사용자의 CAPTCHA 클릭 이후 성공한 결과입니다. 그 결과를 공식 API 무인 조회 성공으로 표시하지 않습니다.

## 공식 API 실행

Python 3.9 이상과 `requests`가 필요합니다. API 모드는 Chrome이나 `playwright`를 실행하지 않습니다. 브라우저 모드를 명시적으로 선택하는 경우에는 별도로 `playwright`와 Chrome이 필요합니다.

PSA 계정에서 [공식 API 문서](https://www.psacard.com/publicapi/documentation)를 열고 토큰을 발급합니다. `PSA_API_TOKEN`은 PSA에만, `PSA_WORKER_KEY`는 TCG HUB 서버에만 보냅니다. 토큰·작업기 키를 소스에 넣지 않습니다.

Windows에서는 다음 실행기로 토큰을 숨겨 입력하고 현재 Windows 계정으로 암호화 저장합니다.

```powershell
.\scripts\run_cert_worker_api.ps1 -ConfigureToken
.\scripts\run_cert_worker_api.ps1 -Verify
```

`-Verify`는 공개 인증번호 23483296, 24031556, 127270226을 확인합니다. 세 건 모두 인증번호·카드 정보·등급·POP 두 값이 실제 응답으로 확인되어야 성공입니다. 운영 사이트의 대기열이나 사용자 보유카드는 변경하지 않습니다. 실패하면 첫 건에서 멈춥니다. PSA가 지정한 대기 시간이 남았거나 저장한 대기 정보를 읽을 수 없으면 요청을 보내지 않습니다.

실제 작업기 실행에는 서버와 같은 `PSA_WORKER_KEY` 환경변수도 필요합니다. 실행기의 `-Check`는 설정만 확인하고 외부 조회를 하지 않습니다.

```powershell
.\scripts\run_cert_worker_api.ps1 -Check
.\scripts\run_cert_worker_api.ps1
```

다른 환경에서는 `PSA_LOOKUP_MODE=api`, `PSA_API_TOKEN`, `PSA_WORKER_KEY`를 설정한 뒤 `python scripts/psa_worker.py`로 실행합니다. `SITE` 기본값은 `https://tcghub.kr`입니다.

## 등록과 조회 대기

TCG HUB의 PSA/BGS 등록 요청에는 일일·분당·대기 건수 상한을 두지 않습니다. 같은 인증번호는 조회 작업 하나를 공유합니다. 결과를 24시간 재사용하는 설정은 조회 결과의 유효 기간이며 하루 1회 등록 제한이 아닙니다. 동일 인증서의 중복 소유권은 계속 검사합니다. BGS 운영 경로는 기존 직접 조회 API를 사용합니다.

PSA 공식 API의 실제 허용량·토큰 권한은 제공자의 응답에 따릅니다. HTTP 429를 받으면 Retry-After를 지키고 대기 정보를 저장해 재시작 후에도 보존합니다. 대기 중 추가 등록 요청은 기존 종료 시각을 연장하지 않습니다. 기존 보고서와 상태 폴더 보고서가 함께 있으면 더 늦은 시각을 적용합니다. 토큰·권한 오류는 브라우저로 전환하지 않고 종료합니다. 대기 정보 저장에 실패하면 서버에 결과 보고를 시도한 뒤 중단합니다.

## PC 상태와 개인정보

PC 로그인·인터넷 연결이 필요합니다. 절전·최대절전 중에는 작업이 멈추며 모니터는 꺼도 됩니다. 작업기 잠금으로 중복 실행을 막습니다. 상태·로그·암호화 토큰은 `CERT_WORKER_STATE_DIR`에 저장하며 기본값은 `%LOCALAPPDATA%\TCGHub\CertWorker`입니다. 실제 검증 보고서는 저장소 루트의 `unattended-api-validation.json`에 기록합니다.

로그에는 오류 종류와 인증번호 뒤 4자리만 기록합니다. API 진단도 제한된 오류 설명과 요청 식별자만 남기고 인증값·쿠키·원문 본문은 저장하지 않습니다. 상태·보고서·프로필·암호화 토큰·가상환경은 GitHub에 올리지 않습니다.

## 오프라인 검사

```powershell
python -B scripts/psa_worker.py --self-test
node --test scripts/test_certificates.mjs
```

2026-10-09 작업기 Python 검사 109개가 통과했습니다. 검사는 가짜 응답·시계·저장소를 사용합니다. 인증번호와 POP 확인, 차단 응답, 대기 보존, 재시작, 저장 실패, 등록 요청으로 대기가 연장되지 않는지 검사합니다. 검사 통과는 실제 PSA 조회 성공을 의미하지 않습니다.
