@echo off
rem Double-click this to start Postwright. It opens the browser for you.
rem
rem Everything the app needs is in this folder, so the first line makes the
rem working directory the folder this file lives in — a shortcut on the desktop
rem would otherwise start in the desktop and fail to find package.json.
cd /d "%~dp0"

echo Starting Postwright...
echo.

call npm run ui

rem Only reached if the server exits. Without the pause a double-click closes
rem the window instantly and takes the error message with it.
echo.
echo The server stopped. Read the message above; press a key to close.
pause >nul
