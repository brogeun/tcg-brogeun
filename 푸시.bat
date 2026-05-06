@echo off
cd /d "%~dp0"
echo.
echo ============================================
echo   Git Push - OnePiece Card Data
echo ============================================
echo.

if exist .git\index.lock del /f /q .git\index.lock

git add -A
git status --short
echo.
git commit -m "STEP D OnePiece official cardlist OP01-OP15 + EB01-EB04 (2040 cards)"
git push

echo.
echo ============================================
echo   Done.
echo ============================================
echo.
pause
