@echo off
title STRATUM — world server
cd /d "%~dp0"
echo.
echo   STRATUM — a persistent shared world
echo   -----------------------------------
echo   Starting the world server. Leave this window OPEN while playing.
echo   Close it (or press Ctrl+C) to shut the world down.
echo.
echo   Your world lives in:  data\world.db
echo   Delete that folder to reset everything.
echo.
start "" http://127.0.0.1:8090/
node server.js
echo.
echo   Server stopped.
pause
