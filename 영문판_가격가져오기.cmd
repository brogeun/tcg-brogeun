@echo off
setlocal
cd /d "%~dp0"
echo English Pokemon PSA10 import - FREE / OFFLINE
echo Save public PriceCharting pages as HTML into the price-import folder.
echo For sales: select the PSA 10 sold-listings tab before saving.
echo Currency must be USD. Existing files can be imported again safely.
echo.
python scripts\import_english_prices.py --inbox
echo.
echo Ask Codex to review .cache\english-prices\report.json after import.
echo Website deployment is NOT included.
pause
