import path from "node:path";
import { LegendsBot } from "@legends/bot-sdk";

const token = process.env.BOT_TOKEN;
const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";

if (!token) {
  console.error("BOT_TOKEN env var required");
  process.exit(1);
}

// Olm pickle for E2EE DMs lives here (gitignored). Operator must also flip the
// E2EE toggle in the admin UI (AdminBotsView → bot row → End-to-end encryption)
// for the SDK's keys/upload to be accepted by the server.
const dataDir = process.env.BOT_DATA_DIR ?? path.resolve(process.cwd(), "data");
const cryptoStorePath = path.join(dataDir, "olm-store.pickle");

const bot = new LegendsBot({ token, baseUrl, cryptoStorePath });

bot.on("new_member", async (ctx) => {
  const { display_name, username } = ctx.new_member;
  const tag = username ? `@${username}` : display_name;
  await ctx.send(
    `👋 Welcome to **${ctx.new_member.topic_title}**, ${tag}! Glad to have you here. Say hi!`,
  );
});

// Demonstrates E2EE DMs. Replies in both plaintext + E2EE conversations
// transparently — the SDK decrypts incoming ciphertext before this handler
// runs and encrypts outgoing replies when the conversation is E2EE.
bot.on("dm_message", async (ctx) => {
  const text = ctx.dm_message.text ?? "";
  if (text.trim().toLowerCase() === "ping") {
    await ctx.reply(`crypto-test echo: ${text}`);
  }
});

bot.catch((err) => {
  console.error("[jane] error:", err);
});

const webhookUrl = process.env.WEBHOOK_URL;
const webhookPort = Number(process.env.WEBHOOK_PORT ?? 3010);

if (webhookUrl) {
  bot.startWebhook({ port: webhookPort, webhookUrl }).catch((err) => {
    console.error("[jane] webhook start failed:", err);
    process.exit(1);
  });
} else {
  console.log("[jane] WEBHOOK_URL not set — using polling mode");
  bot.start().catch((err) => {
    console.error("[jane] polling failed:", err);
    process.exit(1);
  });
}
