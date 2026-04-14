import { randomBytes } from "node:crypto";
import { authLoginTokens } from "@legends/db/schema";
import { db } from "./db";

const TOKEN_TTL_MS = 5 * 60 * 1000;

export async function issueLoginToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(authLoginTokens).values({
    token,
    userId,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });
  return token;
}

export function loginUrl(token: string): string {
  const base = process.env.APP_PUBLIC_URL ?? "http://localhost:3000";
  return `${base}/auth/callback?token=${token}`;
}
