@echo off
cd /d "%~dp0"
echo.
echo ============================================
echo   Trigger Cloudflare Pages Rebuild
echo ============================================
echo.

if exist .git\index.lock del /f /q .git\index.lock

git commit --allow-empty -m "chore: trigger CF Pages rebuild for OnePiece data"
git push

echo.
echo ============================================
echo   Done. Wait 1-2 minutes, then refresh CF dashboard.
echo ============================================
echo.
pause
