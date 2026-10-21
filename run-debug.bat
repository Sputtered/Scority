@echo off
cd /d "%~dp0"
set "DEBUG_PACKETS=1"
call npm.cmd start
pause
