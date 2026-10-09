@echo off
TITLE CORS Anywhere - Setup
cd /d "%~dp0"

:: Check if Node is installed
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo ---------------------------------------------------
    echo ERROR: Node.js is NOT installed on this computer.
    echo ---------------------------------------------------
    echo The download page should have just opened, so follow these steps:
    echo 1. Download and run the "Windows Installer .msi"
    echo If it says "Windows protected your PC", just click more info and then click run anyway.
    echo 2. Follow the prompts to install - just click next.
    echo 3. RESTART your computer once finished.
    echo 4. Run this setup file again.
    echo ---------------------------------------------------
    start https://nodejs.org/en/download/
    pause
    exit
)

echo Node.js found! Installing server components...
call npm install
echo.
echo Setup Complete! You can now use '2-Run-Server.bat'.
pause