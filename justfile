default:
    @just --list

install:
    #!/usr/bin/env bash
    if command -v pnpm >/dev/null 2>&1; then
        pnpm install
    elif command -v corepack >/dev/null 2>&1; then
        corepack pnpm install
    else
        echo "pnpm not found. Run: npm install -g pnpm" >&2
        exit 1
    fi

start:
    ./start.sh

stop:
    ./stop.sh

restart: stop start

clearlogs:
    rm -f logs/*.log logs/ngrok.env
    @echo "logs cleared"

logs:
    tail -f logs/web.log logs/ws.log logs/bot.log
