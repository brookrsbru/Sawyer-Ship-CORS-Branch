@echo off
TITLE CORS Anywhere - Active Server
cd /d "%~dp0"

:: Check if node_modules exists
if not exist "node_modules\" (
    echo ERROR: Dependencies not found. 
    echo Please run '1-Install-Dependencies.bat' first.
    pause
    exit
)

echo ---------------------------------------------------
echo CORS Anywhere is starting on localhost...
echo Keep this window open to keep the server alive.
echo ---------------------------------------------------
echo.
node server.js
pause