@echo off
cd /d "%~dp0"
echo Riftbound English card collection. No paid API or OpenAI usage.
python scripts\import_riftbound.py
if errorlevel 1 (
  echo Collection failed. Existing published data has not been changed.
) else (
  echo Staged in .cache\riftbound-import. Ask Codex to review and apply.
)
pause
