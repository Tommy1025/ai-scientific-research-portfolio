@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo [首次啟動] 正在安裝本機依賴...
  call npm.cmd install --cache .npm-cache
  if errorlevel 1 exit /b 1
)
start "" "http://127.0.0.1:8787"
call npm.cmd start
