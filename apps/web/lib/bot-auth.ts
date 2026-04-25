import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { bots } from "@legends/db/schema";
import { db } from "./db";

export function generateBotToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashBotToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function getBotFromRequest(req: Request) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const hash = hashBotToken(token);
  const [bot] = await db.select().from(bots).where(eq(bots.tokenHash, hash)).limit(1);
  if (!bot || !bot.isActive) return null;
  return bot;
}
