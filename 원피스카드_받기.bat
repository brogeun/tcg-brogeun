@echo off
cd /d "%~dp0"
echo.
echo ============================================
echo   OnePiece Official Cardlist - Full Fetch
echo ============================================
echo.

REM Step 1: clean stale OP15.json (NULL bytes)
if exist data\cards-by-set\OP15.json del /f /q data\cards-by-set\OP15.json

echo Fetching all 19 sets (OP01..OP15, EB01..EB04)...
python scripts/fetch_onepiece_http.py

echo.
echo ============================================
echo   Done. Send the result summary to Claude.
echo ============================================
echo.
pause
