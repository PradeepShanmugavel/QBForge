@echo off
title TestPack - Setup
color 0B
echo.
echo  ============================================
echo    TestPack ^| First Time Setup
echo  ============================================
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  ERROR: Node.js is not installed.
    echo.
    echo  Please download and install it from:
    echo  https://nodejs.org  ^(LTS version^)
    echo.
    echo  After installing, run this file again.
    echo.
    pause
    exit /b 1
)

echo  [OK] Node.js detected:
node --version
echo.

:: Install all dependencies
echo  Installing dependencies ^(this may take a minute^)...
echo.
call npm run install:all
if %errorlevel% neq 0 (
    color 0C
    echo.
    echo  ERROR: npm install failed. Check your internet connection.
    pause
    exit /b 1
)

echo.
:: Create .env from example if it doesn't exist
if not exist "server\.env" (
    copy "server\.env.example" "server\.env" >nul
    echo  [OK] Created server\.env
    echo.
    color 0E
    echo  ============================================
    echo   IMPORTANT: Open server\.env and add your
    echo   GROQ_API_KEY before running the project.
    echo   Get your key at: https://console.groq.com
    echo  ============================================
) else (
    echo  [OK] server\.env already exists - skipping
)

echo.
color 0A
echo  ============================================
echo   Setup complete!
echo.
echo   Next steps:
echo   1. Edit server\.env  ^(add GROQ_API_KEY^)
echo   2. Double-click START.bat to run
echo  ============================================
echo.
pause
