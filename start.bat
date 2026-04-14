@echo off
REM Legends Chat - start all services
REM   - brings up postgres + redis via docker compose
REM   - opens 3 separate WSL terminal windows for web / ws / bot
REM
REM Requirements: Docker Desktop, WSL with the nvm/pnpm setup from this repo.

setlocal
set REPO_WIN=%~dp0
set REPO_WSL=/mnt/c/Users/giuse/repos/legends-chat

echo [1/4] Starting postgres + redis...
docker compose -f "%REPO_WIN%docker-compose.yml" up -d
if errorlevel 1 (
  echo docker compose failed. Is Docker Desktop running?
  exit /b 1
)

echo [2/4] Launching web (Next.js) on http://localhost:3000...
start "Legends Web" cmd /k wsl -e bash -lic "cd %REPO_WSL% && set -a && . ./.env && set +a && pnpm --filter @legends/web dev"

echo [3/4] Launching ws (Socket.IO) on http://localhost:3001...
start "Legends WS" cmd /k wsl -e bash -lic "cd %REPO_WSL% && set -a && . ./.env && set +a && pnpm --filter @legends/ws dev"

echo [4/4] Launching Telegram bot...
start "Legends Bot" cmd /k wsl -e bash -lic "cd %REPO_WSL% && set -a && . ./.env && set +a && pnpm --filter @legends/bot dev"

echo.
echo All services launched. Close the three windows or run stop.bat to stop them.
endlocal
