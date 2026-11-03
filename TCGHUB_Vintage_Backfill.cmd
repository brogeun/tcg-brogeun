@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONUNBUFFERED=1"
set "BACKFILL_RESULT=1"
echo TCGHUB 구형 카드 이미지 이어받기
echo 이 창을 닫아도 완료한 파일은 .backfill-cache에 보존됩니다.
echo.

if exist ".backfill-venv\Scripts\python.exe" goto verify_environment
call :find_python
if not defined BACKFILL_SYSTEM_PYTHON goto no_python
"%BACKFILL_SYSTEM_PYTHON%" %BACKFILL_SYSTEM_ARGS% -m venv ".backfill-venv"
if errorlevel 1 goto environment_error

:verify_environment
".backfill-venv\Scripts\python.exe" -c "import sys;sys.exit(0 if sys.version_info >= (3,11) else 1)" >nul 2>&1
if errorlevel 1 goto environment_error
".backfill-venv\Scripts\python.exe" -c "import PIL;assert PIL.__version__ == '12.2.0'" >nul 2>&1
if not errorlevel 1 goto run_backfill
echo 이미지 검증 모듈을 준비합니다. 최초 실행에만 다운로드가 필요합니다.
".backfill-venv\Scripts\python.exe" -m pip install --disable-pip-version-check "Pillow==12.2.0"
if errorlevel 1 goto dependency_error

:run_backfill
".backfill-venv\Scripts\python.exe" -X utf8 "scripts\run_vintage_backfill.py"
set "BACKFILL_RESULT=%ERRORLEVEL%"
echo.
if "%BACKFILL_RESULT%"=="0" echo 받기 완료. TCGHUB_Vintage_Backfill_Result.zip을 대화에 첨부해주세요.
if "%BACKFILL_RESULT%"=="2" echo 일부 항목이 남았습니다. 완료한 파일과 결과 ZIP은 보존되었습니다.
if "%BACKFILL_RESULT%"=="130" echo 중단되었습니다. 같은 CMD를 다시 실행하면 이어받습니다.
if "%BACKFILL_RESULT%"=="3" echo 다른 백필 창이 실행 중인지 확인해주세요. 동시에 두 번 실행하지 않습니다.
if "%BACKFILL_RESULT%"=="1" echo 오류가 발생했습니다. 결과 ZIP 또는 이 창의 내용을 알려주세요.
goto finish

:no_python
echo Python 3.11 이상을 찾지 못했습니다. Python 설치 후 같은 CMD를 다시 실행해주세요.
goto finish

:environment_error
echo Python 실행환경을 준비하지 못했습니다. .backfill-cache는 지우지 마세요.
goto finish

:dependency_error
echo 이미지 검증 모듈 설치에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 실행해주세요.
goto finish

:find_python
set "BACKFILL_SYSTEM_PYTHON="
set "BACKFILL_SYSTEM_ARGS="
py -3.11 -c "import sys;sys.exit(0 if sys.version_info >= (3,11) else 1)" >nul 2>&1
if errorlevel 1 goto try_py3
set "BACKFILL_SYSTEM_PYTHON=py"
set "BACKFILL_SYSTEM_ARGS=-3.11"
exit /b 0

:try_py3
py -3 -c "import sys;sys.exit(0 if sys.version_info >= (3,11) else 1)" >nul 2>&1
if errorlevel 1 goto try_python311
set "BACKFILL_SYSTEM_PYTHON=py"
set "BACKFILL_SYSTEM_ARGS=-3"
exit /b 0

:try_python311
"%LOCALAPPDATA%\Programs\Python\Python311\python.exe" -c "import sys;sys.exit(0 if sys.version_info >= (3,11) else 1)" >nul 2>&1
if errorlevel 1 goto try_python_path
set "BACKFILL_SYSTEM_PYTHON=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
exit /b 0

:try_python_path
python -c "import sys;sys.exit(0 if sys.version_info >= (3,11) else 1)" >nul 2>&1
if not errorlevel 1 set "BACKFILL_SYSTEM_PYTHON=python"
exit /b 0

:finish
echo.
echo 창을 닫으려면 아무 키나 누르세요.
pause >nul
exit /b %BACKFILL_RESULT%
