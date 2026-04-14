@echo off
REM Legends Chat - stop all services
REM   - kills the 3 node dev processes inside WSL
REM   - stops postgres + redis containers (data is preserved in the volume)

setlocal
set REPO_WIN=%~dp0

echo [1/2] Stopping web / ws / bot node processes...
wsl -e bash -lic "pkill -f 'next dev' ; pkill -f 'tsx watch src/index.ts' ; pkill -f 'next-server' ; true"

echo [2/2] Stopping postgres + redis containers...
docker compose -f "%REPO_WIN%docker-compose.yml" stop

echo.
echo Stopped. Postgres volume is preserved (use 'docker compose down -v' to wipe data).
endlocal
