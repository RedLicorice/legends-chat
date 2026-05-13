import { createServer } from "node:http";
import { Bot, webhookCallback, session, type Context, type SessionFlavor } from "grammy";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { inviteCodes } from "@legends/db/schema";
import { db } from "./db";
import { formatBanMessage, getActiveBan } from "./ban";
import { appPublicUrl, attachTelegramMessage, issueLoginToken, issuePendingToken, loginUrl } from "./login";
import { createAnonUser, findUserByTelegramId, getRegistrationPolicy } from "./registration";
import {
  rescheduleOnStartup,
  scheduleExpiryCheck,
  subscribeToConsumption,
} from "./token-lifecycle";

interface BotSession {
  awaitingInvite: boolean;
}
type Ctx = Context & SessionFlavor<BotSession>;

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

const bot = new Bot<Ctx>(token);
bot.use(session<BotSession, Ctx>({ initial: () => ({ awaitingInvite: false }) }));

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function sendLoginLink(ctx: Ctx, userId: string): Promise<void> {
  const issued = await issueLoginToken(userId);
  const url = loginUrl(issued.token);
  // Telegram only accepts https:// in inline keyboard buttons.
  // Fall back to plain text for localhost dev sessions.
  const isHttps = url.startsWith("https://");
  const sent = await ctx.reply(
    isHttps
      ? `<i>Link valid for 5 minutes.</i>`
      : `🔑 <b>Log in to Legends Chat</b>\n<code>${url}</code>\n<i>Link valid for 5 minutes.</i>`,
    {
      parse_mode: "HTML",
      ...(isHttps && {
        reply_markup: { inline_keyboard: [[{ text: "🔑 Log in to Legends Chat", url }]] },
      }),
    },
  );
  const chatId = BigInt(sent.chat.id);
  await attachTelegramMessage(issued.id, chatId, sent.message_id);
  scheduleExpiryCheck(bot.api, issued.id, chatId, sent.message_id, issued.expiresAt);
}

async function sendPendingLink(
  ctx: Ctx,
  telegramUserId: bigint,
  telegramUsername: string | null,
  inviteCode: string | null,
): Promise<void> {
  const issued = await issuePendingToken(telegramUserId, telegramUsername, inviteCode);
  const url = loginUrl(issued.token);
  const isHttps = url.startsWith("https://");
  const sent = await ctx.reply(
    isHttps
      ? `<i>Link valid for 5 minutes. Tap to continue registration.</i>`
      : `📝 <b>Continue registration on the web</b>\n<code>${url}</code>\n<i>Link valid for 5 minutes.</i>`,
    {
      parse_mode: "HTML",
      ...(isHttps && {
        reply_markup: { inline_keyboard: [[{ text: "📝 Continue on the web", url }]] },
      }),
    },
  );
  const chatId = BigInt(sent.chat.id);
  await attachTelegramMessage(issued.id, chatId, sent.message_id);
  scheduleExpiryCheck(bot.api, issued.id, chatId, sent.message_id, issued.expiresAt);
}

bot.command("start", async (ctx) => {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const existing = await findUserByTelegramId(BigInt(tgUser.id));

  if (existing) {
    const ban = await getActiveBan(existing.id);
    if (ban) {
      await ctx.reply(formatBanMessage(ban));
      return;
    }
    ctx.session.awaitingInvite = false;
    await sendLoginLink(ctx, existing.id);
    return;
  }

  const policy = await getRegistrationPolicy();

  if (policy.invitesEnabled) {
    ctx.session.awaitingInvite = true;
    await ctx.reply("Welcome! Please send your invite code to register.");
    return;
  }

  if (policy.publicRegistrationEnabled) {
    await sendPendingLink(
      ctx,
      BigInt(tgUser.id),
      tgUser.username ?? null,
      null,
    );
    return;
  }

  await ctx.reply("Sorry, we're not accepting new members at the moment.");
});

bot.on("message:text", async (ctx) => {
  if (!ctx.session.awaitingInvite) return;
  const tgUser = ctx.from;
  if (!tgUser) return;
  const code = ctx.message.text.trim().toUpperCase();
  if (!code) return;

  const existing = await findUserByTelegramId(BigInt(tgUser.id));
  if (existing) {
    ctx.session.awaitingInvite = false;
    await sendLoginLink(ctx, existing.id);
    return;
  }

  // Validate invite code without claiming it. The web register endpoint
  // performs the atomic claim when the user actually completes the form.
  const now = new Date();
  const [invite] = await db
    .select({ id: inviteCodes.id, role: inviteCodes.role })
    .from(inviteCodes)
    .where(
      and(
        eq(inviteCodes.code, code),
        or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
        or(
          isNull(inviteCodes.maxUses),
          sql`${inviteCodes.usesCount} < ${inviteCodes.maxUses}`,
        ),
        or(eq(inviteCodes.role, "user"), eq(inviteCodes.usesCount, 0)),
      ),
    )
    .limit(1);

  if (!invite) {
    await ctx.reply("That invite code is invalid, expired, or out of uses. Please try again.");
    return;
  }

  ctx.session.awaitingInvite = false;
  await ctx.reply("Code accepted! Generating your registration link…");
  await sendPendingLink(
    ctx,
    BigInt(tgUser.id),
    tgUser.username ?? null,
    code,
  );
});

bot.command("anon", async (ctx) => {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const caller = await findUserByTelegramId(BigInt(tgUser.id));
  if (!caller || caller.role !== "admin") {
    await ctx.reply("This command is only available to admins.");
    return;
  }

  const anon = await createAnonUser();
  const issued = await issueLoginToken(anon.id);
  const url = loginUrl(issued.token);
  const isHttps = url.startsWith("https://");
  const sent = await ctx.reply(
    `🎭 <b>${escapeHtml(anon.displayName)}</b>\n<code>${url}</code>\n<i>Link valid for 5 minutes. Identity expires 48 h after last use.</i>`,
    {
      parse_mode: "HTML",
      ...(isHttps && {
        reply_markup: {
          inline_keyboard: [[{ text: `🎭 Log in as ${anon.displayName}`, url }]],
        },
      }),
    },
  );
  const chatId = BigInt(sent.chat.id);
  await attachTelegramMessage(issued.id, chatId, sent.message_id);
  scheduleExpiryCheck(bot.api, issued.id, chatId, sent.message_id, issued.expiresAt);
});

bot.catch((err) => {
  console.error("[bot] handler error", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[bot] unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[bot] uncaughtException", err);
});

subscribeToConsumption(bot.api);
rescheduleOnStartup(bot.api).catch((err) => console.error("[lifecycle] reschedule failed", err));

const BOT_MODE = process.env.BOT_MODE ?? "polling";
const BOT_WEBHOOK_PORT = Number(process.env.BOT_WEBHOOK_PORT ?? 3002);
const BOT_WEBHOOK_PATH = "/bot/webhook";

console.log(`legends-chat telegram bot starting (mode: ${BOT_MODE})...`);

if (BOT_MODE === "webhook") {
  const publicUrl = appPublicUrl();
  const webhookUrl = `${publicUrl}${BOT_WEBHOOK_PATH}`;

  bot.api
    .setWebhook(webhookUrl, { drop_pending_updates: false })
    .then(() => {
      console.log(`[bot] webhook registered → ${webhookUrl}`);
      const handleUpdate = webhookCallback(bot, "http");
      const server = createServer(async (req, res) => {
        if (req.url === BOT_WEBHOOK_PATH && req.method === "POST") {
          await handleUpdate(req, res);
        } else {
          res.writeHead(404).end("not found");
        }
      });
      server.listen(BOT_WEBHOOK_PORT, () => {
        console.log(`[bot] webhook server listening on port ${BOT_WEBHOOK_PORT}`);
      });
    })
    .catch((err) => {
      console.error("[bot] failed to set webhook", err);
      process.exit(1);
    });
} else {
  bot.start({
    onStart: (me) => console.log(`[bot] polling started as @${me.username}`),
  })
    .then(() => console.log("[bot] polling loop ended"))
    .catch((err) => {
      console.error("[bot] polling failed to start", err);
      process.exit(1);
    });
}
