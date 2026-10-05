@echo off
cd /d "%~dp0"
rem Release archive: frameboost-helper.exe. From a source checkout: node server\live.mjs
if exist "frameboost-helper.exe" (
  if not exist "bin\vfgpipe.exe" ( echo bin\vfgpipe.exe missing & pause & exit /b 1 )
  "frameboost-helper.exe"
) else (
  if not exist "bin\vfgpipe.exe" (
    echo bin\vfgpipe.exe missing. Run:  powershell -File scripts\build.ps1
    pause
    exit /b 1
  )
  if not exist "node_modules" call npm install --no-audit --no-fund
  node server\live.mjs
)
pause
