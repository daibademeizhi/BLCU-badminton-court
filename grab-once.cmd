@echo off
rem Thin shim: all timestamp/logging logic lives in src\once.js (avoids cmd codepage issues).
setlocal
cd /d "%~dp0"
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 if exist "C:\node\node.exe" set "NODE_EXE=C:\node\node.exe"
"%NODE_EXE%" src\once.js %*
exit /b %ERRORLEVEL%
