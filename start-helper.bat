@echo off
rem Manual mode: fixed port + pairing token + status page (the extension normally starts the helper by itself).
cd /d "%~dp0"
if exist "frameboost-helper.exe" ( "frameboost-helper.exe" --serve ) else if exist "FrameBoost-NVIDIA-Setup.exe" ( "FrameBoost-NVIDIA-Setup.exe" --serve ) else ( node server\main.mjs --serve )
pause
