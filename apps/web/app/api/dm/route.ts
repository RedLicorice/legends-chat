import { NextResponse } from "next/server";
import { z } from "zod";
import { BOT_E2EE_ERROR_CODES } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { openConversation, listConversations } from "@/lib/dm";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conversations = await listConversations(user.id);
  return NextResponse.json({ conversations });
}

// firstMessage XOR: caller passes plaintext OR a ciphertext envelope, never
// both. Same shape as the per-conversation POST in
// /api/dm/[id]/messages — keeping them aligned makes the compose UI swappable
// once the convo exists.
const firstMessageSchema = z
  .object({
    text: z.string().min(1).max(8000).optional(),
    ciphertext: z.record(z.unknown()).optional(),
  })
  .refine((d) => (d.text != null) !== (d.ciphertext != null), {
    message: "provide exactly one of `text` or `ciphertext`",
  });

const openSchema = z.object({
  peerType: z.enum(["user", "bot"]),
  peerId: z.string().uuid(),
  e2ee: z.boolean().optional().default(false),
  // Optional at the schema level; openConversation enforces presence for user
  // peers (BAD / "first message required"). Bots may omit it.
  firstMessage: firstMessageSchema.optional(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.isAnon) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = openSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    const { id, created, e2eeRoomId } = await openConversation(
      user.id,
      { type: parsed.data.peerType, id: parsed.data.peerId },
      {
        e2ee: parsed.data.e2ee,
        firstMessage: parsed.data.firstMessage,
      },
    );
    return NextResponse.json({ id, created, e2eeRoomId }, { status: created ? 201 : 200 });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "BLOCKED") return NextResponse.json({ error: "blocked" }, { status: 403 });
    if (code === "BAD") return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    // Bot E2EE state-machine codes: stable identifiers the frontend pattern-
    // matches on to render specific UX ("admin disabled" vs "bot not ready").
    // Return the code value verbatim in `error` so callers don't have to split
    // on a sentence — see BOT_E2EE_ERROR_CODES in @legends/shared.
    if (
      code === BOT_E2EE_ERROR_CODES.BOT_E2EE_DISABLED ||
      code === BOT_E2EE_ERROR_CODES.BOT_E2EE_NOT_READY
    ) {
      return NextResponse.json({ error: code }, { status: 400 });
    }
    throw e;
  }
}
