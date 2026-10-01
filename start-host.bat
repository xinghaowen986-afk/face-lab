@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 (
  node "%~dp0host-service.mjs"
  goto :finished
)
set "FACE_LAB_NODE=C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%FACE_LAB_NODE%" (
  "%FACE_LAB_NODE%" "%~dp0host-service.mjs"
  goto :finished
)
echo Node.js 18 or newer is required. Install it from https://nodejs.org/
:finished
pause

