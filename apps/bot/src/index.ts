import { createServer } from "node:http";
import { Bot, webhookCallback, session, type Context, type SessionFlavor } from "grammy";
import { inviteCodes } from "@legends/db/schema";
import { redeemableInvitePredicate } from "@legends/db/invites";
import { createLogger } from "@legends/shared";
import { db } from "./db";
import { formatBanMessage, getActiveBan } from "./ban";
import {
  INVITE_MAX_ATTEMPTS,
  clearInviteAttempts,
  isInviteLockedOut,
  recordFailedInviteAttempt,
} from "./invite-attempts";
import { appPublicUrl, attachTelegramMessage, issueLoginToken, issuePendingToken, loginUrl } from "./login";
import { createAnonUser, findUserByTelegramId, getRegistrationPolicy, touchTelegramUsername } from "./registration";
import {
  rescheduleOnStartup,
  scheduleExpiryCheck,
  subscribeToConsumption,
} from "./token-lifecycle";

const log = createLogger("bot");

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

// Send a token-bearing message race-free. We can't include the URL/button in
// the initial reply: the user could click it (or Telegram's WebView could
// prefetch it) before `attachTelegramMessage` commits the chat/msg refs,
// causing the web callback to consume the token with null refs and skip the
// Redis publish that asks the bot to burn this message.
//
// Pattern: send a non-actionable placeholder → persist refs → edit the
// message to add the URL/button. Once the button exists, the refs are
// already committed, so any consume reliably triggers the bot edit.
async function sendTokenMessage(
  ctx: Ctx,
  issued: { id: string; token: string; expiresAt: Date },
  buildText: (url: string, isHttps: boolean) => string,
  buttonLabel: string,
): Promise<void> {
  const url = loginUrl(issued.token);
  // Telegram only accepts https:// in inline keyboard buttons.
  // Fall back to plain text for localhost dev sessions.
  const isHttps = url.startsWith("https://");

  const sent = await ctx.reply("⏳ <i>Preparing your link…</i>", { parse_mode: "HTML" });
  const chatId = BigInt(sent.chat.id);

  await attachTelegramMessage(issued.id, chatId, sent.message_id);

  await bot.api.editMessageText(Number(chatId), sent.message_id, buildText(url, isHttps), {
    parse_mode: "HTML",
    ...(isHttps && {
      reply_markup: { inline_keyboard: [[{ text: buttonLabel, url }]] },
    }),
  });

  scheduleExpiryCheck(bot.api, issued.id, chatId, sent.message_id, issued.expiresAt);
}

async function sendLoginLink(ctx: Ctx, userId: string): Promise<void> {
  const issued = await issueLoginToken(userId);
  await sendTokenMessage(
    ctx,
    issued,
    (url, isHttps) =>
      isHttps
        ? `<i>Link valid for 5 minutes.</i>`
        : `🔑 <b>Log in to Legends Chat</b>\n<code>${url}</code>\n<i>Link valid for 5 minutes.</i>`,
    "🔑 Log in to Legends Chat",
  );
}

async function sendPendingLink(
  ctx: Ctx,
  telegramUserId: bigint,
  telegramUsername: string | null,
  inviteCode: string | null,
): Promise<void> {
  const issued = await issuePendingToken(telegramUserId, telegramUsername, inviteCode);
  await sendTokenMessage(
    ctx,
    issued,
    (url, isHttps) =>
      isHttps
        ? `<i>Link valid for 5 minutes. Tap to continue registration.</i>`
        : `📝 <b>Continue registration on the web</b>\n<code>${url}</code>\n<i>Link valid for 5 minutes.</i>`,
    "📝 Continue on the web",
  );
}

bot.command("start", async (ctx) => {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const existing = await findUserByTelegramId(BigInt(tgUser.id));

  if (existing) {
    await touchTelegramUsername(existing.id, tgUser.username ?? null);
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
    // /start must not reset the guess allowance — otherwise the cap is one
    // /start away from being unlimited.
    if (await isInviteLockedOut(BigInt(tgUser.id))) {
      ctx.session.awaitingInvite = false;
      await ctx.reply("Too many incorrect invite codes. Please try again later.");
      return;
    }
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
    await touchTelegramUsername(existing.id, tgUser.username ?? null);
    ctx.session.awaitingInvite = false;
    await sendLoginLink(ctx, existing.id);
    return;
  }

  // This prompt is an invite-code oracle with no browser and nowhere to put a
  // CAPTCHA, so guesses are capped server-side. The counter is keyed on the
  // Telegram user id and lives in Redis (see invite-attempts.ts) — grammY's
  // in-memory session would reset on every bot restart.
  const telegramUserId = BigInt(tgUser.id);
  if (await isInviteLockedOut(telegramUserId)) {
    ctx.session.awaitingInvite = false;
    log.warn("invite prompt locked out", { telegramUserId: telegramUserId.toString() });
    await ctx.reply(
      "Too many incorrect invite codes. Please wait an hour and send /start to try again.",
    );
    return;
  }

  // Validate invite code without claiming it. The web register endpoint
  // performs the atomic claim when the user actually completes the form.
  const [invite] = await db
    .select({ id: inviteCodes.id, role: inviteCodes.role })
    .from(inviteCodes)
    .where(redeemableInvitePredicate(code))
    .limit(1);

  if (!invite) {
    const state = await recordFailedInviteAttempt(telegramUserId);
    if (state.lockedOut) {
      ctx.session.awaitingInvite = false;
      log.warn("invite prompt locked out", {
        telegramUserId: telegramUserId.toString(),
        attempts: state.used,
      });
      await ctx.reply(
        "Too many incorrect invite codes. Please wait an hour and send /start to try again.",
      );
      return;
    }
    log.info("invite code rejected", {
      telegramUserId: telegramUserId.toString(),
      attempts: state.used,
    });
    const left = INVITE_MAX_ATTEMPTS - state.used;
    await ctx.reply(
      `That invite code is invalid, expired, or out of uses. ${left} attempt${left === 1 ? "" : "s"} remaining.`,
    );
    return;
  }

  await clearInviteAttempts(telegramUserId);
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
  await touchTelegramUsername(caller.id, tgUser.username ?? null);

  const anon = await createAnonUser();
  const issued = await issueLoginToken(anon.id);
  await sendTokenMessage(
    ctx,
    issued,
    (url) => `🎭 <b>${escapeHtml(anon.displayName)}</b>\n<code>${url}</code>\n<i>Link valid for 5 minutes. Identity expires 48 h after last use.</i>`,
    `🎭 Log in as ${anon.displayName}`,
  );
});

bot.catch((err) => {
  log.error("handler error", err);
});

process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
});

const BOT_MODE = process.env.BOT_MODE ?? "polling";
const BOT_WEBHOOK_PORT = Number(process.env.BOT_WEBHOOK_PORT ?? 3002);
const BOT_WEBHOOK_PATH = "/bot/webhook";

log.info(`starting (mode: ${BOT_MODE})`);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

try {
  const me = await withTimeout(bot.api.getMe(), 10_000, "getMe");
  log.info(
    `identified as @${me.username} (id=${me.id}, name="${me.first_name}", can_join_groups=${me.can_join_groups})`,
  );
} catch (err) {
  log.error("getMe failed — check TELEGRAM_BOT_TOKEN and network to api.telegram.org", err);
  process.exit(1);
}

subscribeToConsumption(bot.api);
log.info("redis subscription initiated (login_token_consumed channel)");

await withTimeout(rescheduleOnStartup(bot.api), 10_000, "rescheduleOnStartup")
  .then(() => log.info("lifecycle reschedule ready"))
  .catch((err) => log.error("lifecycle reschedule failed (continuing anyway)", err));

if (BOT_MODE === "webhook") {
  const publicUrl = appPublicUrl();
  const webhookUrl = `${publicUrl}${BOT_WEBHOOK_PATH}`;

  bot.api
    .setWebhook(webhookUrl, { drop_pending_updates: false })
    .then(() => {
      log.info(`webhook registered → ${webhookUrl}`);
      const handleUpdate = webhookCallback(bot, "http");
      const server = createServer(async (req, res) => {
        if (req.url === BOT_WEBHOOK_PATH && req.method === "POST") {
          await handleUpdate(req, res);
        } else {
          res.writeHead(404).end("not found");
        }
      });
      server.listen(BOT_WEBHOOK_PORT, () => {
        log.info(`webhook server listening on port ${BOT_WEBHOOK_PORT}`);
      });
    })
    .catch((err) => {
      log.error("failed to set webhook", err);
      process.exit(1);
    });
} else {
  bot.start({
    onStart: (me) => log.info(`polling started as @${me.username}`),
  })
    .then(() => log.info("polling loop ended"))
    .catch((err) => {
      log.error("polling failed to start", err);
      process.exit(1);
    });
}
