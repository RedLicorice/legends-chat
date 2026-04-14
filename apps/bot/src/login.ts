import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { authLoginTokens } from "@legends/db/schema";
import { db } from "./db";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const NGROK_ENV_FILE = resolve(ROOT, "logs/ngrok.env");

const TOKEN_TTL_MS = 5 * 60 * 1000;
const REUSE_WINDOW_MS = 15 * 1000;

export interface IssuedToken {
  id: string;
  token: string;
  expiresAt: Date;
  reused: boolean;
}

/**
 * Issues a login token for a user with two safeguards:
 *   - If the user already has an active token issued within the last
 *     REUSE_WINDOW_MS, return that same token (reused=true).
 *   - Otherwise, mark every still-active token for this user as consumed
 *     and issue a fresh one.
 */
export async function issueLoginToken(userId: string): Promise<IssuedToken> {
  return db.transaction(async (tx) => {
    const now = new Date();

    const [mostRecent] = await tx
      .select()
      .from(authLoginTokens)
      .where(
        and(
          eq(authLoginTokens.userId, userId),
          isNull(authLoginTokens.consumedAt),
          gt(authLoginTokens.expiresAt, now),
        ),
      )
      .orderBy(desc(authLoginTokens.createdAt))
      .limit(1);

    if (mostRecent && now.getTime() - mostRecent.createdAt.getTime() < REUSE_WINDOW_MS) {
      return {
        id: mostRecent.id,
        token: mostRecent.token,
        expiresAt: mostRecent.expiresAt,
        reused: true,
      };
    }

    // Invalidate every still-active token for this user before minting a new one.
    await tx
      .update(authLoginTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authLoginTokens.userId, userId),
          isNull(authLoginTokens.consumedAt),
        ),
      );

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
    const [row] = await tx
      .insert(authLoginTokens)
      .values({ token, userId, expiresAt })
      .returning({ id: authLoginTokens.id });
    return { id: row!.id, token, expiresAt, reused: false };
  });
}

export async function attachTelegramMessage(
  tokenId: string,
  chatId: bigint,
  messageId: number,
): Promise<void> {
  await db
    .update(authLoginTokens)
    .set({ telegramChatId: chatId, telegramMessageId: messageId })
    .where(eq(authLoginTokens.id, tokenId));
}

export async function isTokenConsumed(tokenId: string): Promise<boolean> {
  const [row] = await db
    .select({ consumedAt: authLoginTokens.consumedAt })
    .from(authLoginTokens)
    .where(eq(authLoginTokens.id, tokenId))
    .limit(1);
  return !!row?.consumedAt;
}

export async function listPendingTokensWithTelegramRefs(): Promise<
  Array<{ id: string; expiresAt: Date; chatId: bigint; messageId: number }>
> {
  const now = new Date();
  const rows = await db
    .select({
      id: authLoginTokens.id,
      expiresAt: authLoginTokens.expiresAt,
      chatId: authLoginTokens.telegramChatId,
      messageId: authLoginTokens.telegramMessageId,
    })
    .from(authLoginTokens)
    .where(and(isNull(authLoginTokens.consumedAt), gt(authLoginTokens.expiresAt, now)));
  return rows
    .filter((r): r is { id: string; expiresAt: Date; chatId: bigint; messageId: number } =>
      r.chatId !== null && r.messageId !== null,
    );
}

function appPublicUrl(): string {
  // Prefer the URL written by scripts/ngrok.mjs — read at call time so the
  // bot picks up a freshly-started tunnel without needing a restart.
  if (existsSync(NGROK_ENV_FILE)) {
    const match = readFileSync(NGROK_ENV_FILE, "utf-8").match(/^APP_PUBLIC_URL=(.+)$/m);
    if (match) return match[1].trim();
  }
  return process.env.APP_PUBLIC_URL ?? "http://localhost:3000";
}

export function loginUrl(token: string): string {
  return `${appPublicUrl()}/auth/callback?token=${token}`;
}
