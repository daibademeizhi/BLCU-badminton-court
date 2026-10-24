@echo off
rem ==========================================================================
rem  qiangchang.bat -- double click me
rem
rem  This file is deliberately PURE ASCII. It only starts the PowerShell menu
rem  sitting next to it (qiangchang-menu.ps1). All Chinese text lives in that
rem  .ps1 file, which PowerShell reads as UTF-8 (it carries a BOM), so cmd.exe
rem  never has to parse a single non-ASCII byte.
rem
rem  That is exactly what broke the earlier version: a Chinese .bat gets
rem  decoded as GBK by cmd.exe, the bytes shift, and half the lines turn into
rem  "not recognized as an internal or external command".
rem
rem  Double clicking only SHOWS A MENU. It books nothing by itself.
rem ==========================================================================
setlocal
cd /d "%~dp0"
where pwsh >nul 2>nul && (set "PS=pwsh") || (set "PS=powershell")
%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0qiangchang-menu.ps1"
endlocal
