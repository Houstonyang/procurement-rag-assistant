@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts/service.mjs start
if errorlevel 1 (
  pause
  exit /b 1
)
