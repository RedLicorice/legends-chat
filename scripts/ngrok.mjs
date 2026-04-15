/**
 * Starts ngrok tunnels for the web (3000) and ws (3001) services.
 * Writes the public URLs to logs/ngrok.env so start.sh can source them
 * before launching the app processes.
 *
 * Usage (called automatically by start.sh when NGROK_AUTHTOKEN is set):
 *   node scripts/ngrok.mjs
 */
import ngrok from "@ngrok/ngrok";
import fs from "node:fs";
import path from "node:path";
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
const wsPort = parseInt(process.env.WS_PORT ?? "3001", 10);

// Catch unhandled errors so they appear in logs/ngrok.log instead of
// silently killing the process.
process.on("uncaughtException", (err) => {
  console.error("[ngrok] uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[ngrok] unhandled rejection:", reason);
  process.exit(1);
});

console.log(`[ngrok] connecting (web :${webPort}, ws :${wsPort})…`);

const webListener = await ngrok.forward({ addr: webPort, authtoken });
// Second tunnel reuses the same agent session (no second authtoken needed).
const wsListener = await ngrok.forward({ addr: wsPort });

const webUrl = webListener.url();
const wsUrl = wsListener.url();

fs.mkdirSync(logsDir, { recursive: true });
fs.writeFileSync(
  envFile,
  [`APP_PUBLIC_URL=${webUrl}`, `NEXT_PUBLIC_WS_URL=${wsUrl}`, `WS_URL=${wsUrl}`].join("\n") + "\n",
);

console.log(`[ngrok] web → ${webUrl}`);
console.log(`[ngrok] ws  → ${wsUrl}`);
console.log(`[ngrok] URLs written to logs/ngrok.env`);

// Keep the process alive to hold the tunnels open.
// The setInterval prevents Node's event loop from draining if the @ngrok/ngrok
// SDK doesn't maintain its own references after the initial connect.
const keepAlive = setInterval(() => {}, 30_000);

process.on("SIGTERM", async () => {
  clearInterval(keepAlive);
  await ngrok.disconnect();
  process.exit(0);
});
process.on("SIGINT", async () => {
  clearInterval(keepAlive);
  await ngrok.disconnect();
  process.exit(0);
});

// Also log if the session closes unexpectedly.
webListener.on?.("close", () => console.error("[ngrok] web tunnel closed unexpectedly"));
wsListener.on?.("close", () => console.error("[ngrok] ws tunnel closed unexpectedly"));
