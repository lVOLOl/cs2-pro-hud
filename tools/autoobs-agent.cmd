@echo off
rem Auto-observe agent. Set SERVER to the address of the PC running the HUD server.
rem On the same PC keep http://localhost:3000
set SERVER=http://localhost:3000
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autoobs-agent.ps1" -Server %SERVER%
pause
