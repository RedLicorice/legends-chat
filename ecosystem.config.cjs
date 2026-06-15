/** @type {import('pm2').StartOptions[]} */
const ROOT = __dirname;
const ENV_FILE = `${ROOT}/.env`;
// Toggle dev vs prod via env. `PM2_WEB_MODE=dev` runs `next dev` (turbopack,
// HMR); anything else (or unset) runs `next start` against the prebuilt
// `.next/standalone` output. The latter is what we want under `./start.sh`
// in production so `pm2 reload` is zero-downtime.
const WEB_MODE = process.env.PM2_WEB_MODE === "dev" ? "dev" : "prod";
const WEB_ARGS = WEB_MODE === "dev" ? "dev -p 3000 -H 0.0.0.0" : "start -p 3000 -H 0.0.0.0";

module.exports = {
  apps: [
    {
      name: "legends-web",
      cwd: `${ROOT}/apps/web`,
      script: "node_modules/next/dist/bin/next",
      args: WEB_ARGS,
      interpreter: "node",
      env_file: ENV_FILE,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,
      kill_timeout: 8000,
      treekill: true,
      out_file: `${ROOT}/logs/web.log`,
      error_file: `${ROOT}/logs/web.log`,
      merge_logs: true,
      time: true,
    },
    {
      name: "legends-ws",
      cwd: `${ROOT}/apps/ws`,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "watch src/index.ts",
      interpreter: "node",
      env_file: ENV_FILE,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,
      kill_timeout: 5000,
      treekill: true,
      out_file: `${ROOT}/logs/ws.log`,
      error_file: `${ROOT}/logs/ws.log`,
      merge_logs: true,
      time: true,
    },
    {
      name: "legends-bot",
      cwd: `${ROOT}/apps/bot`,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "watch src/index.ts",
      interpreter: "node",
      env_file: ENV_FILE,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,
      kill_timeout: 5000,
      treekill: true,
      out_file: `${ROOT}/logs/bot.log`,
      error_file: `${ROOT}/logs/bot.log`,
      merge_logs: true,
      time: true,
    },
  ],
};
