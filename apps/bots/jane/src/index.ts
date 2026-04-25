import { LegendsBot } from "@legends/bot-sdk";

const token = process.env.BOT_TOKEN;
const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";

if (!token) {
  console.error("BOT_TOKEN env var required");
  process.exit(1);
}

const bot = new LegendsBot({ token, baseUrl });

bot.on("new_member", async (ctx) => {
  const { display_name, username } = ctx.new_member;
  const tag = username ? `@${username}` : display_name;
  await ctx.send(
    `👋 Welcome to **${ctx.new_member.topic_title}**, ${tag}! Glad to have you here. Say hi!`,
  );
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
