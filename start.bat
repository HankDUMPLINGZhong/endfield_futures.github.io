@echo off
setlocal

cd /d "%~dp0"

REM 启动后端（同时托管前端）
start "Endfield Futures" cmd /k ^
  "cd /d %~dp0 && uv run uvicorn backend.app:app --host 127.0.0.1 --port 5000"

timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:5000/"

endlocal
