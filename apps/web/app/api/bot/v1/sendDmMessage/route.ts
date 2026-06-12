// POST /api/bot/v1/sendDmMessage
//
// RPC-shaped bot DM send. Body: { conversationId, text? | ciphertext?,
// replyToMessageId? }. Exactly one of `text` / `ciphertext` must be provided;
// the choice must match the conversation's `isE2ee` mode:
//   - E2EE convo ⇒ ciphertext (a Matrix m.room.encrypted envelope)
//   - Plaintext convo ⇒ text
//
// Why this exists alongside the existing /api/bot/v1/sendMessage route: the
// SDK exposes `bot.sendDmMessage(...)` as its own RPC method, mirroring the
// `bot.sendMessage(...)` shape for topics. The two RPC entry points share the
// same persistence layer (`insertDmMessage` in lib/dm.ts) and WS-emit path
// (`REDIS_CHANNELS.DM_MESSAGE_NEW`) so the user side receives bot-authored
// ciphertext via the existing /api/dm/[id]/messages GET fan-out.
//
// `deliverDmToBots` is intentionally NOT invoked here — that helper skips
// bot-authored sends to prevent feedback loops, so calling it would be a
// no-op. If/when bot→bot DMs land, the helper itself is the right place to
// add the cross-bot forwarding.

import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { BOT_E2EE_ERROR_CODES, REDIS_CHANNELS } from "@legends/shared";
import { dmConversations, dmParticipants } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getBotFromRequest } from "@/lib/bot-auth";
import { insertDmMessage, recipientUserIds } from "@/lib/dm";

// `ciphertext` arrives as a JSON-stringified m.room.encrypted CONTENT
// object — matches the bot SDK's wasm output and what its decrypt path
// expects on incoming envelopes (see packages/bot-sdk/src/crypto/olm-machine.ts).
// We refine that the string parses to a JSON object so a bot can't
// accidentally smuggle a non-Matrix body through the field.
const sendSchema = z
  .object({
    conversationId: z.string().uuid(),
    text: z.string().min(1).max(8000).optional(),
    ciphertext: z
      .string()
      .min(1)
      .max(64_000)
      .refine(
        (s) => {
          try {
            const v = JSON.parse(s) as unknown;
            return typeof v === "object" && v !== null && !Array.isArray(v);
          } catch {
            return false;
          }
        },
        { message: "ciphertext must be a JSON-stringified object" },
      )
      .optional(),
    replyToMessageId: z.string().regex(/^\d+$/).optional().nullable(),
  })
  .refine((d) => (d.text != null) !== (d.ciphertext != null), {
    message: "provide exactly one of `text` or `ciphertext`",
  });

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const parsed = sendSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { conversationId } = parsed.data;

  const [conv] = await db
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.id, conversationId))
    .limit(1);
  if (!conv) {
    return NextResponse.json(
      { ok: false, error: "conversation not found" },
      { status: 404 },
    );
  }
  if (conv.state === "blocked") {
    return NextResponse.json({ ok: false, error: "blocked" }, { status: 403 });
  }

  // Bot must own a participant slot in this conversation.
  const [member] = await db
    .select({ pid: dmParticipants.principalId })
    .from(dmParticipants)
    .where(
      and(
        eq(dmParticipants.conversationId, conversationId),
        eq(dmParticipants.principalType, "bot"),
        eq(dmParticipants.principalId, bot.id),
      ),
    )
    .limit(1);
  if (!member) {
    return NextResponse.json(
      { ok: false, error: "bot not in conversation" },
      { status: 403 },
    );
  }

  // Finding 10: re-check bots.e2eeState on E2EE convos. conv.isE2ee is set at
  // open time; admin can flip the bot to 'disabled' or 'pending' afterwards.
  // BotWithPermissions.e2eeState comes from the auth helper so no extra query.
  if (conv.isE2ee && bot.e2eeState !== "ready") {
    const code =
      bot.e2eeState === "disabled"
        ? BOT_E2EE_ERROR_CODES.BOT_E2EE_DISABLED
        : BOT_E2EE_ERROR_CODES.BOT_E2EE_NOT_READY;
    return NextResponse.json({ ok: false, error: code }, { status: 403 });
  }

  // Payload-mode must match the conversation mode.
  if (conv.isE2ee && parsed.data.ciphertext == null) {
    return NextResponse.json(
      { ok: false, error: "E2EE conversation; send ciphertext" },
      { status: 400 },
    );
  }
  if (!conv.isE2ee && parsed.data.text == null) {
    return NextResponse.json(
      { ok: false, error: "plaintext conversation; send text" },
      { status: 400 },
    );
  }

  // Ciphertext arrives as a JSON string on the wire; the DB stores it as a
  // jsonb object. Parse once here so the DM row keeps the existing shape
  // (also the shape the user-facing /api/dm/[id]/messages route persists).
  // The refine in `sendSchema` already guaranteed it's a parseable object.
  const ciphertextJson = parsed.data.ciphertext
    ? (JSON.parse(parsed.data.ciphertext) as Record<string, unknown>)
    : undefined;

  const msg = await insertDmMessage({
    conversationId,
    senderType: "bot",
    senderId: bot.id,
    text: parsed.data.text,
    ciphertext: ciphertextJson,
    replyToMessageId: parsed.data.replyToMessageId ?? null,
  });

  // WS fan-out: every user participant of the convo gets the new message via
  // the existing DM_MESSAGE_NEW path. The handler in apps/ws routes by user id.
  const peers = await recipientUserIds(conversationId);
  await redis.publish(
    REDIS_CHANNELS.DM_MESSAGE_NEW,
    JSON.stringify({
      conversationId,
      message: msg,
      userIds: peers,
      isE2ee: conv.isE2ee,
    }),
  );

  return NextResponse.json(
    { ok: true, result: { messageId: msg.id } },
    { status: 201 },
  );
}
