import { Bot, session, type Context, type SessionFlavor } from "grammy";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { auditLog, inviteCodes, users } from "@legends/db/schema";
import { db } from "./db";
import { formatBanMessage, getActiveBan } from "./ban";
import { attachTelegramMessage, issueLoginToken, loginUrl } from "./login";
import { createUser, findUserByTelegramId, getRegistrationPolicy } from "./registration";
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
    const created = await createUser({
      telegramUserId: BigInt(tgUser.id),
      telegramUsername: tgUser.username ?? null,
      displayName: tgUser.first_name || tgUser.username || "User",
    });
    await db.insert(auditLog).values({
      actorUserId: created.id,
      action: "user.register.public",
      targetType: "user",
      targetId: created.id,
    });
    await sendLoginLink(ctx, created.id);
    return;
  }

  await ctx.reply("Sorry, we're not accepting new members at the moment.");
});

bot.on("message:text", async (ctx) => {
  if (!ctx.session.awaitingInvite) return;
  const tgUser = ctx.from;
  if (!tgUser) return;
  const code = ctx.message.text.trim();
  if (!code) return;

  const existing = await findUserByTelegramId(BigInt(tgUser.id));
  if (existing) {
    ctx.session.awaitingInvite = false;
    await sendLoginLink(ctx, existing.id);
    return;
  }

  const created = await db
    .transaction(async (tx) => {
      const now = new Date();
      // Atomic claim: only increment if there is capacity left.
      // For non-user roles we require uses_count = 0 (single-use) on top of max_uses.
      const claimed = await tx
        .update(inviteCodes)
        .set({ usesCount: sql`${inviteCodes.usesCount} + 1` })
        .where(
          and(
            eq(inviteCodes.code, code),
            or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
            or(
              isNull(inviteCodes.maxUses),
              sql`${inviteCodes.usesCount} < ${inviteCodes.maxUses}`,
            ),
            // Non-user roles: enforce single-use regardless of max_uses.
            or(eq(inviteCodes.role, "user"), eq(inviteCodes.usesCount, 0)),
          ),
        )
        .returning({
          id: inviteCodes.id,
          role: inviteCodes.role,
          createdByUserId: inviteCodes.createdByUserId,
        });
      if (claimed.length === 0) {
        tx.rollback();
      }
      const claim = claimed[0]!;
      const [u] = await tx
        .insert(users)
        .values({
          telegramUserId: BigInt(tgUser.id),
          telegramUsername: tgUser.username ?? null,
          displayName: tgUser.first_name || tgUser.username || "User",
          role: claim.role,
          invitedByUserId: claim.createdByUserId,
          invitedByCodeId: claim.id,
        })
        .returning();
      return { user: u!, code: claim };
    })
    .catch(() => null);

  if (!created) {
    await ctx.reply("That invite code is invalid, expired, or out of uses. Please try again.");
    return;
  }

  await db.insert(auditLog).values({
    actorUserId: created.user.id,
    action: "user.register.invite",
    targetType: "user",
    targetId: created.user.id,
    metadata: { code, role: created.code.role, inviteCodeId: created.code.id },
  });

  ctx.session.awaitingInvite = false;
  await ctx.reply(
    created.code.role === "user"
      ? "Welcome aboard! Generating your login link..."
      : `Welcome aboard as ${created.code.role}! Generating your login link...`,
  );
  await sendLoginLink(ctx, created.user.id);
});

bot.catch((err) => {
  console.error("bot error", err);
});

subscribeToConsumption(bot.api);
rescheduleOnStartup(bot.api).catch((err) => console.error("[lifecycle] reschedule failed", err));

console.log("legends-chat telegram bot starting...");
bot.start();
