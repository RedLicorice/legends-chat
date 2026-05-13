import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authLoginTokens, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getAllSettings } from "@legends/db/system-settings";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const settings = await getAllSettings(db);
  const settingsOut = {
    requirePasskeyAtRegistration: settings.require_passkey_at_registration === "true",
    magicLinkLoginDisabled: settings.magic_link_login_disabled === "true",
  };

  // 1. Already authenticated by cookie? Return profile + skip token logic.
  const me = await getCurrentUser();
  if (me) {
    const [u] = await db
      .select({
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        bannerUrl: users.bannerUrl,
      })
      .from(users)
      .where(eq(users.id, me.id))
      .limit(1);
    return NextResponse.json({
      state: "authenticated",
      user: u ?? null,
      settings: settingsOut,
    });
  }

  if (!token) {
    return NextResponse.json({ state: "invalid", settings: settingsOut });
  }

  // 2. Look up the token without consuming it.
  const now = new Date();
  const [row] = await db
    .select()
    .from(authLoginTokens)
    .where(
      and(
        eq(authLoginTokens.token, token),
        isNull(authLoginTokens.consumedAt),
        gt(authLoginTokens.expiresAt, now),
      ),
    )
    .limit(1);

  if (!row) {
    return NextResponse.json({ state: "invalid", settings: settingsOut });
  }

  // 3. Existing user token.
  if (row.userId) {
    const [u] = await db
      .select({
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        bannerUrl: users.bannerUrl,
      })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!u) return NextResponse.json({ state: "invalid", settings: settingsOut });
    return NextResponse.json({ state: "existing", user: u, settings: settingsOut });
  }

  // 4. Pending-registration token.
  if (row.telegramUserId !== null) {
    return NextResponse.json({
      state: "new",
      pending: {
        telegramUsername: row.telegramUsername ?? "",
        inviteCode: row.inviteCode,
      },
      settings: settingsOut,
    });
  }

  // Defensive: token with neither userId nor telegramUserId.
  return NextResponse.json({ state: "invalid", settings: settingsOut });
}
