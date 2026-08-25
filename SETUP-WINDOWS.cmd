@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required.
  echo Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

echo.
echo Touchline AI Windows setup
echo This installs local dependencies, FFmpeg, FFprobe, and football tracking.
echo.
set "CLOUD_OPTION="
set /p "CONFIGURE_CLOUD=Configure Google Cloud after local setup? [y/N]: "
if /I "%CONFIGURE_CLOUD%"=="Y" set "CLOUD_OPTION=-ConfigureCloud"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %CLOUD_OPTION%
if errorlevel 1 (
  echo.
  echo Setup failed. Read the error above, install the missing prerequisite, and run this file again.
  pause
  exit /b 1
)

echo.
echo Setup succeeded. Run npm run local:start, then open http://localhost:3000
pause
