@echo off
title STRATUM - public share
cd /d "%~dp0"
echo.
echo   STRATUM - share the world over the internet
echo   ------------------------------------------
echo   Opens a temporary public HTTPS URL for this machine's world.
echo   The URL is random and CHANGES every time you run this.
echo   It only works while this window stays open.
echo.
echo   Anyone with the URL can join and claim unclaimed land.
echo   IMPORTANT: your land cannot be altered by them, and they cannot
echo   take yours - but they can build next to you.
echo.
echo   Starting the world server...
start "STRATUM world" /min cmd /c "cd /d %~dp0 && node server.js"
timeout /t 3 /nobreak >nul
echo   Opening the tunnel - look for the https://...trycloudflare.com line below.
echo.
npx -y cloudflared tunnel --url http://127.0.0.1:8090 --no-autoupdate
pause
