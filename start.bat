@echo off
chcp 65001 >nul
title Trae Local API Server

echo.
echo ╔══════════════════════════════════════════╗
echo ║    Trae Local API - One Click Start      ║
echo ╚══════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Check if .env exists with TRAE_TOKEN
if exist ".env" (
    findstr /C:"TRAE_TOKEN=eyJ" .env >nul 2>&1
    if %errorlevel%==0 (
        echo [info] Found .env with valid token, starting server...
        goto :start
    )
)

:: No valid .env, run setup first
echo [info] First run, decrypting Trae CN config...
echo.
node setup.js
if %errorlevel% neq 0 (
    echo.
    echo [error] Setup failed! Make sure Trae IDE is installed and you are logged in.
    pause
    exit /b 1
)
echo.

:start
echo Starting server...
echo.
node src/server.js

pause
