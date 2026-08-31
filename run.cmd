@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

:: ============================================================
::  Team Daily Workbench - start / restart
::  Frontend: http://localhost:5174  Backend: http://localhost:8787
::  Stop: Ctrl + C
:: ============================================================

:: Remove unsupported Node.js options injected by desktop tools.
set "NODE_OPTIONS="
cd /d "%~dp0"

where node >nul 2>nul
if not errorlevel 1 goto :node_ready
echo [ERROR] Node.js 18+ was not found. Install it from https://nodejs.org/
pause
exit /b 1

:node_ready
for /f "tokens=1" %%v in ('node -v') do set "NODE_VER=%%v"
echo [INFO] Node.js !NODE_VER!

if exist "node_modules" goto :dependencies_ready
echo [SETUP] node_modules is missing. Running npm install ...
call npm install
if not errorlevel 1 goto :dependencies_ready
echo [ERROR] npm install failed. Check your network and npm configuration.
pause
exit /b 1

:dependencies_ready
node scripts\check-better-sqlite3.mjs >nul 2>&1
if not errorlevel 1 goto :check_service
echo [SETUP] Rebuilding better-sqlite3 for this Node.js version ...
call npm rebuild better-sqlite3
if not errorlevel 1 goto :check_service
echo [ERROR] better-sqlite3 rebuild failed. Check Node.js and npm.
pause
exit /b 1

:check_service
:: Verify the backend identity before stopping an existing process.
set "SERVICE_STATE=STOPPED"
curl.exe --silent --max-time 2 http://127.0.0.1:8787/api/health | findstr /c:"team-daily-workbench" >nul
if not errorlevel 1 set "SERVICE_STATE=RUNNING"
if /i "!SERVICE_STATE!"=="RUNNING" goto :restart_service

netstat -ano | findstr ":8787 " | findstr "LISTENING" >nul
if not errorlevel 1 goto :other_service_on_port
goto :start_service

:restart_service
echo [RESTART] Existing workbench detected. Stopping it ...
call :stop_port 8787
call :stop_port 5174
call :wait_for_ports
if errorlevel 1 goto :stop_timeout
echo [RESTART] Previous service stopped. Starting again.
goto :start_service

:other_service_on_port
echo [ERROR] Port 8787 is used by another program. It was not stopped.
echo Close that program and try again.
pause
exit /b 1

:stop_timeout
echo [ERROR] The old service did not stop within 20 seconds. End its node.exe process and try again.
pause
exit /b 1

:start_service
echo.
echo [START] Frontend (5174) + backend (8787) ...
echo [OPEN] http://localhost:5174
echo [STOP] Press Ctrl + C to stop all services.
echo.
start "" cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:5174"
call npm run dev
set "RUN_EXIT_CODE=!ERRORLEVEL!"
endlocal & exit /b %RUN_EXIT_CODE%

:stop_port
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%~1 " ^| findstr "LISTENING"') do taskkill /PID %%a /T /F >nul 2>&1
exit /b 0

:wait_for_ports
set /a WAIT_SECONDS=0
:wait_for_ports_again
set "PORTS_BUSY="
call :mark_port_busy 8787
call :mark_port_busy 5174
if not defined PORTS_BUSY exit /b 0
set /a WAIT_SECONDS+=1
if !WAIT_SECONDS! GEQ 20 exit /b 1
timeout /t 1 /nobreak >nul
goto :wait_for_ports_again

:mark_port_busy
netstat -ano | findstr ":%~1 " | findstr "LISTENING" >nul
if not errorlevel 1 set "PORTS_BUSY=1"
exit /b 0
