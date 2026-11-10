@echo off
rem LevelPlay Web: start the local server and open the browser.
rem Double-click this file. Close the "LevelPlay server" window to stop.
cd /d "%~dp0"
start "LevelPlay server" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1"
