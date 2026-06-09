import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { issueSession, setAuthCookies } from "@/lib/auth";
import { getSetting } from "@legends/db/system-settings";

export async function POST(req: Request) {
  const mode = await getSetting(db, "registration_mode");
  if ((mode ?? "telegram_only") !== "open") {
    return NextResponse.json({ error: "Email login is not enabled." }, { status: 403 });
  }

  const body = await req.json() as { email: string; password: string };
  const email = body.email?.trim().toLowerCase();
  const password = body.password;

  if (!email || !password) return NextResponse.json({ error: "Email and password required." }, { status: 400 });

  const [user] = await db
    .select({
      id: users.id,
      role: users.role,
      passwordHash: users.passwordHash,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      isAnon: users.isAnon,
      presenceOptOut: users.presenceOptOut,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const { accessJwt, refreshJwt } = await issueSession({
    id: user.id,
    role: user.role,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
    isAnon: user.isAnon,
    presenceOptOut: user.presenceOptOut,
  });
  await setAuthCookies(accessJwt, refreshJwt);

  return NextResponse.json({ ok: true });
}
