import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getCurrentUser();
  if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const [user] = await db
    .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, role: users.role, bio: users.bio })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(user);
}
