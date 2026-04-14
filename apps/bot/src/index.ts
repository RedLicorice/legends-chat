import { Bot, session, type Context, type SessionFlavor } from "grammy";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { auditLog, inviteCodes, users } from "@legends/db/schema";
import { db } from "./db.js";
import { formatBanMessage, getActiveBan } from "./ban.js";
import { issueLoginToken, loginUrl } from "./login.js";
import { createUser, findUserByTelegramId, getRegistrationPolicy } from "./registration.js";

interface BotSession {
  awaitingInvite: boolean;
}
type Ctx = Context & SessionFlavor<BotSession>;

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

const bot = new Bot<Ctx>(token);
bot.use(session<BotSession, Ctx>({ initial: () => ({ awaitingInvite: false }) }));

async function sendLoginLink(ctx: Ctx, userId: string): Promise<void> {
  const t = await issueLoginToken(userId);
  await ctx.reply(`Tap to log in (link valid for 5 minutes):\n${loginUrl(t)}`);
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
      const consumed = await tx
        .update(inviteCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(inviteCodes.code, code),
            isNull(inviteCodes.usedByUserId),
            or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
          ),
        )
        .returning({ id: inviteCodes.id });
      if (consumed.length === 0) {
        tx.rollback();
      }
      const [u] = await tx
        .insert(users)
        .values({
          telegramUserId: BigInt(tgUser.id),
          telegramUsername: tgUser.username ?? null,
          displayName: tgUser.first_name || tgUser.username || "User",
        })
        .returning();
      await tx
        .update(inviteCodes)
        .set({ usedByUserId: u!.id })
        .where(eq(inviteCodes.id, consumed[0]!.id));
      return u!;
    })
    .catch(() => null);

  if (!created) {
    await ctx.reply("That invite code is invalid or expired. Please try again.");
    return;
  }

  await db.insert(auditLog).values({
    actorUserId: created.id,
    action: "user.register.invite",
    targetType: "user",
    targetId: created.id,
    metadata: { code },
  });

  ctx.session.awaitingInvite = false;
  await ctx.reply("Welcome aboard! Generating your login link...");
  await sendLoginLink(ctx, created.id);
});

bot.catch((err) => {
  console.error("bot error", err);
});

console.log("legends-chat telegram bot starting...");
bot.start();
