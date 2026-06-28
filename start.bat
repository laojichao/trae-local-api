@echo off
chcp 65001 >nul 2>&1
title Trae Local API Server

echo.
echo ========================================
echo   Trae Local API - One Click Start
echo ========================================
echo.

cd /d "%~dp0"

:: Read PORT from .env (fallback to 9220)
set "PORT=9220"
if exist ".env" (
    for /f "tokens=1,* delims==" %%a in (.env) do (
        if /i "%%a"=="PORT" set "PORT=%%b"
    )
)

:: Check if .env exists with TRAE_TOKEN
if exist ".env" (
    findstr /C:"TRAE_TOKEN=eyJ" .env >nul 2>&1
    if %errorlevel%==0 (
        echo [info] Found .env with valid token
        goto :start
    )
)

:: No valid .env, run setup first (auto-detects 4 editions)
echo [info] First run, decrypting Trae config...
echo.
node setup.js
if %errorlevel% neq 0 (
    echo.
    echo [error] Setup failed! Make sure any Trae IDE is installed and logged in.
    echo         Supported: Trae CN / TRAE SOLO CN / Trae SG / TRAE SOLO
    pause
    exit /b 1
)
echo.

:start
:: Kill existing process on configured port
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%PORT% ^| findstr LISTENING') do (
    echo [info] Killing old process on port %PORT% ^(PID: %%a^)
    taskkill /F /PID %%a >nul 2>&1
)

echo Starting server on port %PORT%...
echo.
node src/server.js

pause
