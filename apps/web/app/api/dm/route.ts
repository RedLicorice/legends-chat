import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { openConversation, listConversations } from "@/lib/dm";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conversations = await listConversations(user.id);
  return NextResponse.json({ conversations });
}

const openSchema = z.object({
  peerType: z.enum(["user", "bot"]),
  peerId: z.string().uuid(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.isAnon) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = openSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    const { id, created } = await openConversation(user.id, { type: parsed.data.peerType, id: parsed.data.peerId });
    return NextResponse.json({ id, created }, { status: created ? 201 : 200 });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "BLOCKED") return NextResponse.json({ error: "blocked" }, { status: 403 });
    if (code === "BAD") return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    throw e;
  }
}
