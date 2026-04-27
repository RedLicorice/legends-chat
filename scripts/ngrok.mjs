/**
 * Starts an ngrok tunnel for the web service and keeps it alive.
 * On disconnect, reconnects automatically and rewrites logs/ngrok.env
 * so the app picks up the new URL without a restart.
 *
 * Usage (called by start.sh when NGROK_AUTHTOKEN is set):
 *   node scripts/ngrok.mjs
 */
import ngrok from "@ngrok/ngrok";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logsDir = path.join(root, "logs");
const envFile = path.join(logsDir, "ngrok.env");

const authtoken = process.env.NGROK_AUTHTOKEN;
if (!authtoken) {
  console.error("[ngrok] NGROK_AUTHTOKEN not set — exiting");
  process.exit(1);
}

const webPort = parseInt(process.env.WEB_PORT ?? "3000", 10);
const domain = process.env.NGROK_DOMAIN || undefined;

process.on("uncaughtException", (err) => {
  console.error("[ngrok] uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[ngrok] unhandled rejection:", reason);
});

function writeEnvFile(webUrl) {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    envFile,
    [
      `APP_PUBLIC_URL=${webUrl}`,
      `WEB_URL=${webUrl}`,
      `NEXT_PUBLIC_WS_URL=${webUrl}`,
      `WS_URL=http://localhost:3001`,
    ].join("\n") + "\n",
  );
}

function tryReloadPm2(webUrl) {
  try {
    // Pass new URL into pm2's environment via process.env so --update-env picks it up.
    const env = {
      ...process.env,
      APP_PUBLIC_URL: webUrl,
      WEB_URL: webUrl,
      NEXT_PUBLIC_WS_URL: webUrl,
    };
    execSync("pm2 reload ecosystem.config.cjs --update-env --silent", {
      cwd: root,
      env,
      timeout: 15_000,
      stdio: "ignore",
    });
    console.log("[ngrok] signaled pm2 to reload with new URL");
  } catch {
    // pm2 not running yet, or no managed processes — fine on first start
  }
}

let currentListener = null;
let stopping = false;

async function connect() {
  console.log(`[ngrok] connecting (web :${webPort})${domain ? ` → ${domain}` : ""}…`);
  currentListener = await ngrok.forward({
    addr: webPort,
    authtoken,
    ...(domain ? { domain } : {}),
  });

  const webUrl = currentListener.url();
  writeEnvFile(webUrl);
  console.log(`[ngrok] web → ${webUrl}`);
  console.log("[ngrok] URLs written to logs/ngrok.env");

  currentListener.on?.("close", async () => {
    if (stopping) return;
    console.error("[ngrok] tunnel closed — reconnecting in 5s…");
    await new Promise((r) => setTimeout(r, 5_000));
    reconnectLoop();
  });

  return webUrl;
}

async function reconnectLoop() {
  while (!stopping) {
    try {
      const webUrl = await connect();
      tryReloadPm2(webUrl);
      return; // connected — exit loop
    } catch (err) {
      if (stopping) return;
      console.error("[ngrok] reconnect failed:", err.message, "— retrying in 10s…");
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

// Initial connect (no pm2 reload on first start — pm2 isn't running yet)
await connect();

// Keep event loop alive.
const keepAlive = setInterval(() => {}, 30_000);

async function shutdown() {
  stopping = true;
  clearInterval(keepAlive);
  if (currentListener) {
    try { await currentListener.close(); } catch { /* ignore */ }
  }
  await ngrok.disconnect().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
