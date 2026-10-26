@echo off
REM Restart the wechat-claude-code Windows service.
REM
REM Each sc.exe call below is an RPC to the Service Control Manager and blocks
REM until SCM acknowledges the request. The two stages (stop then start) are
REM chained with synchronous polling loops so the script does not depend on
REM staying alive between them. If PowerShell ISE kills this cmd.exe mid-run,
REM the SCM transaction issued just before the kill has already been committed.
REM This is more reliable than the previous Node-based restart function,
REM which was killed mid-flight when npm process tree was reaped,
REM stranding the service in STOPPED.

setlocal
set SERVICE=wechatclaudecodebridge.exe

echo Stopping %SERVICE% ...
sc.exe stop "%SERVICE%"
if errorlevel 1 (
  echo sc stop returned errorlevel %errorlevel% — continuing.
)

REM Wait for STOPPED. sc.exe stop is non-blocking on its own; poll synchronously.
set /a i=0
:wait_stop
set /a i+=1
sc.exe query "%SERVICE%" | findstr /C:"STOPPED" >nul && goto do_start
if %i% gtr 60 (
  echo Service did not reach STOPPED within 30s; aborting.
  exit /b 1
)
REM timeout is a single builtin that runs in this cmd.exe — not a separate
REM process — so PowerShell ISE killing the process tree can't interrupt the
REM wait. (ping forks a child, which was the old reliability hole.)
timeout /t 1 /nobreak >nul
goto wait_stop

:do_start
echo Starting %SERVICE% ...
sc.exe start "%SERVICE%"
if errorlevel 1 (
  echo sc start returned errorlevel %errorlevel%.
  exit /b 1
)

REM Wait for RUNNING.
set /a j=0
:wait_run
set /a j+=1
sc.exe query "%SERVICE%" | findstr /C:"RUNNING" >nul && goto done
if %j% gtr 60 (
  echo Service did not reach RUNNING within 60s; manual check recommended.
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait_run

:done
echo Service %SERVICE% is RUNNING.
endlocal