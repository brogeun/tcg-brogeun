@echo off
cd /d "%~dp0"
echo.
echo ============================================
echo   Cloudflare Pages Direct Deploy (Wrangler)
echo ============================================
echo.

REM Skip .git, node_modules, scripts, uploads, cache, debug files
echo Deploying current folder to tcghubrogeun project...
echo.
echo (First time will open browser for Cloudflare login)
echo.

npx wrangler@latest pages deploy . --project-name=tcghubrogeun --commit-dirty=true

echo.
echo ============================================
echo   Done. Check https://tcghub.kr after 30 sec.
echo ============================================
echo.
pause
