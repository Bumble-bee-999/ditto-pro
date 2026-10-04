@echo off
setlocal
cd /d "%~dp0"
title Building Ditto Pro installer

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Download the LTS version from https://nodejs.org , install it, then run this file again.
  pause
  exit /b 1
)

echo Installing dependencies (first time takes a few minutes)...
call npm install
if errorlevel 1 goto :fail

echo.
echo Fetching the offline speech engine for captions (skipped if already downloaded)...
call npm run fetch-whisper

echo.
echo Fetching the best-quality background-removal model (skipped if already downloaded)...
call npm run fetch-models

echo.
echo Building the Windows installer...
call npm run dist
if errorlevel 1 goto :fail

echo.
echo ===============================================================
echo  Done. Your installer is in the "dist" folder:
dir /b dist\*.exe
echo ===============================================================
start "" "%~dp0dist"
pause
exit /b 0

:fail
echo.
echo Something went wrong - see the messages above.
pause
exit /b 1
