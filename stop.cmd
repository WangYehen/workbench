@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: Only stop a verified Team Daily Workbench instance.
curl.exe --silent --max-time 2 http://127.0.0.1:8787/api/health | findstr /c:"team-daily-workbench" >nul
if errorlevel 1 goto :not_running

echo [STOP] Closing Team Daily Workbench ...
call :stop_port 8787
call :stop_port 5174
call :wait_for_ports
if errorlevel 1 goto :stop_timeout

echo [DONE] Workbench service stopped.
exit /b 0

:not_running
echo [INFO] No Team Daily Workbench service is running.
pause
exit /b 0

:stop_timeout
echo [ERROR] The service did not stop within 20 seconds. End its node.exe process and try again.
pause
exit /b 1

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
