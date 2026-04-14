default:
    @just --list

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
