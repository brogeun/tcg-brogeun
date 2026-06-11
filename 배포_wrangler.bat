@echo off
cd /d "%~dp0"
echo.
echo ============================================
echo   Cloudflare Pages Deploy (selective bundle)
echo ============================================
echo.

REM ---- build _deploy with ONLY what the site needs ----
REM Never deploys: cookies.json, *.bak, *.log, debug/, scripts/,
REM data/_bak-*, data/_snkrdunk_image_cache, node_modules, android/ios/www ...

if exist _deploy rmdir /s /q _deploy
mkdir _deploy

REM core static files
for %%f in (index.html _redirects _headers manifest.json sw.js robots.txt sitemap.xml ads.txt privacy.html terms.html mobile.html favicon.ico) do (
  if exist "%%f" copy /y "%%f" _deploy\ >nul
)

REM static folders
for %%d in (images ev-calculator) do (
  if exist "%%d" robocopy "%%d" "_deploy\%%d" /e /njh /njs /ndl /nfl >nul
)

REM data - exclude internal _* work files and cache dir
robocopy data _deploy\data /e /njh /njs /ndl /nfl /xd "_snkrdunk_image_cache" "history.bak-fix-grade-dup" /xf "_*.json" >nul
REM remove any _bak-* backup dirs that slipped through
for /d %%d in ("_deploy\data\_bak-*") do rmdir /s /q "%%d"

REM functions - full dir (all live API endpoints)
robocopy functions _deploy\functions /e /njh /njs /ndl /nfl >nul

echo Deploying _deploy to tcghubrogeun project...
echo (First time will open browser for Cloudflare login)
echo.

npx wrangler@latest pages deploy _deploy --project-name=tcghubrogeun --commit-dirty=true

echo.
echo ============================================
echo   Done. Check https://tcghub.kr after 30 sec.
echo ============================================
echo.
pause
