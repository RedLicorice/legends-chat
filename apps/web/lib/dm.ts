import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { dmConversations, dmParticipants, dmMessages, dmBlocks, encryptionKeys, users, bots } from "@legends/db/schema";
import { generateDataKey, wrapKey, unwrapKey, encryptMessage, decryptMessage } from "@legends/crypto";
import { buildDmKey } from "@legends/db/dm-key";
import { db } from "@/lib/db";
import { encodeDmContent, decodeDmContent } from "@/lib/dm.codec";
import { toMatrixRoomId } from "@/lib/crypto-matrix";

// ── data key (cached) — mirrors apps/ws/src/messages.ts currentDataKey ────────
let cachedKey: { id: string; data: Uint8Array } | null = null;
async function currentDataKey(): Promise<{ id: string; data: Uint8Array }> {
  if (cachedKey) return cachedKey;
  const rows = await db.select().from(encryptionKeys).where(eq(encryptionKeys.purpose, "messages")).orderBy(desc(encryptionKeys.createdAt)).limit(1);
  if (rows[0]) {
    cachedKey = { id: rows[0].id, data: unwrapKey(rows[0].wrappedKey) };
    return cachedKey;
  }
  const data = generateDataKey();
  const { wrapped } = wrapKey(data);
  const [inserted] = await db.insert(encryptionKeys).values({ purpose: "messages", wrappedKey: wrapped }).returning();
  cachedKey = { id: inserted!.id, data };
  return cachedKey;
}
const keyDataCache = new Map<string, Uint8Array>();
async function getKeyData(keyId: string): Promise<Uint8Array> {
  const hit = keyDataCache.get(keyId);
  if (hit) return hit;
  const [row] = await db.select().from(encryptionKeys).where(eq(encryptionKeys.id, keyId)).limit(1);
  if (!row) throw new Error("encryption key not found");
  const data = unwrapKey(row.wrappedKey);
  keyDataCache.set(keyId, data);
  return data;
}

export type DmMessageView = {
  id: string;
  conversationId: string;
  senderType: "user" | "bot";
  senderId: string;
  /** Plaintext body. Empty string for E2EE rows (use `ciphertext` instead). */
  text: string;
  /** Matrix m.room.encrypted envelope for E2EE rows; null for plaintext rows. */
  ciphertext: Record<string, unknown> | null;
  replyToMessageId: string | null;
  createdAt: string;
  editedAt: string | null;
};

export type DmConversationView = {
  id: string;
  state: "pending" | "accepted" | "blocked";
  isE2ee: boolean;
  /** Matrix-shaped synthetic room id "!<convId>:legends.local" when E2EE; null otherwise. */
  e2eeRoomId: string | null;
  peer: { type: "user" | "bot"; id: string; displayName: string; avatarUrl: string | null } | null;
  lastMessageAt: string | null;
  incoming: boolean; // true if the current user is the recipient of a pending request
};


export async function isBlockedBetween(a: string, b: string): Promise<boolean> {
  const rows = await db
    .select({ blocker: dmBlocks.blockerUserId })
    .from(dmBlocks)
    .where(or(and(eq(dmBlocks.blockerUserId, a), eq(dmBlocks.blockedUserId, b)), and(eq(dmBlocks.blockerUserId, b), eq(dmBlocks.blockedUserId, a))));
  return rows.length > 0;
}

export async function assertParticipant(conversationId: string, userId: string): Promise<void> {
  const rows = await db
    .select({ pid: dmParticipants.principalId })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.conversationId, conversationId), eq(dmParticipants.principalType, "user"), eq(dmParticipants.principalId, userId)))
    .limit(1);
  if (rows.length === 0) throw Object.assign(new Error("not a participant"), { code: "FORBIDDEN" });
}

export async function openConversation(
  initiatorUserId: string,
  peer: { type: "user" | "bot"; id: string },
  options?: { e2ee?: boolean },
): Promise<{ id: string; created: boolean; e2eeRoomId: string | null }> {
  if (peer.type === "user" && initiatorUserId === peer.id) {
    throw Object.assign(new Error("cannot DM yourself"), { code: "BAD" });
  }
  if (peer.type === "bot" && options?.e2ee) {
    throw Object.assign(new Error("e2ee bot DMs are not supported yet"), { code: "BAD" });
  }
  if (peer.type === "user" && (await isBlockedBetween(initiatorUserId, peer.id))) {
    throw Object.assign(new Error("blocked"), { code: "BLOCKED" });
  }
  if (peer.type === "bot") {
    const [b] = await db.select({ id: bots.id, dmEnabled: bots.dmEnabled, isActive: bots.isActive }).from(bots).where(eq(bots.id, peer.id)).limit(1);
    if (!b || !b.isActive || !b.dmEnabled) throw Object.assign(new Error("bot not dm-able"), { code: "BAD" });
  }

  const isE2ee = peer.type === "user" && !!options?.e2ee;

  const dmKey = buildDmKey({ type: "user", id: initiatorUserId }, peer);
  const existing = await db
    .select({ id: dmConversations.id, isE2ee: dmConversations.isE2ee, e2eeRoomId: dmConversations.e2eeRoomId })
    .from(dmConversations)
    .where(eq(dmConversations.dmKey, dmKey))
    .limit(1);
  if (existing[0]) {
    if (isE2ee !== existing[0].isE2ee) {
      throw Object.assign(
        new Error(
          `existing DM is ${existing[0].isE2ee ? "encrypted" : "plaintext"}; re-use that thread`,
        ),
        { code: "BAD" },
      );
    }
    return { id: existing[0].id, created: false, e2eeRoomId: existing[0].e2eeRoomId };
  }

  const state = peer.type === "bot" ? "accepted" : "pending";
  // E2EE rows get a synthetic Matrix room id derived from the conversation UUID.
  // We don't know the conversation id yet (server-generated), so we insert
  // without it, then patch it once we have the row back. Cheaper than an INSERT
  // ... RETURNING + UPDATE round-trip is to just compute it from a pre-allocated
  // UUID, but Drizzle's defaultRandom() means letting the DB allocate is fine.
  const [conv] = await db
    .insert(dmConversations)
    .values({ dmKey, isE2ee, state, initiatorType: "user", initiatorId: initiatorUserId })
    .onConflictDoNothing({ target: dmConversations.dmKey })
    .returning({ id: dmConversations.id });
  if (!conv) {
    const [row] = await db
      .select({ id: dmConversations.id, e2eeRoomId: dmConversations.e2eeRoomId })
      .from(dmConversations)
      .where(eq(dmConversations.dmKey, dmKey))
      .limit(1);
    return { id: row!.id, created: false, e2eeRoomId: row!.e2eeRoomId };
  }
  let e2eeRoomId: string | null = null;
  if (isE2ee) {
    e2eeRoomId = toMatrixRoomId(conv.id);
    await db.update(dmConversations).set({ e2eeRoomId }).where(eq(dmConversations.id, conv.id));
  }
  await db.insert(dmParticipants).values([
    { conversationId: conv.id, principalType: "user", principalId: initiatorUserId },
    { conversationId: conv.id, principalType: peer.type, principalId: peer.id },
  ]).onConflictDoNothing();
  // For user↔user DMs that land in `pending` state, notify the recipient via
  // the notification bell. Bot DMs auto-accept (state='accepted' above) and
  // bots have no notification bell, so skip them. Dynamic import keeps the
  // notification helper from pulling redis into bot-only code paths.
  if (peer.type === "user" && state === "pending") {
    const { emitDmRequestNotification } = await import("@/lib/dm-requests");
    await emitDmRequestNotification({
      conversationId: conv.id,
      recipientUserId: peer.id,
      senderUserId: initiatorUserId,
      isE2ee,
    });
  }
  return { id: conv.id, created: true, e2eeRoomId };
}

// Keep a thin compat alias so the existing /api/dm POST keeps working until Task 3 lands:
export async function openUserConversation(initiatorId: string, peerUserId: string) {
  return openConversation(initiatorId, { type: "user", id: peerUserId });
}

export async function listConversations(
  userId: string,
  options?: { state?: "pending" | "accepted" | "blocked" },
): Promise<DmConversationView[]> {
  const myConvs = await db
    .select({ conversationId: dmParticipants.conversationId })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.principalType, "user"), eq(dmParticipants.principalId, userId)));
  const ids = myConvs.map((c) => c.conversationId);
  if (ids.length === 0) return [];

  // Filter by state at the DB layer when requested — ChatListPane only wants
  // "accepted" rows; the NotificationBell handles pending requests separately.
  const convs = options?.state
    ? await db
        .select()
        .from(dmConversations)
        .where(and(inArray(dmConversations.id, ids), eq(dmConversations.state, options.state)))
    : await db.select().from(dmConversations).where(inArray(dmConversations.id, ids));
  const parts = await db.select().from(dmParticipants).where(inArray(dmParticipants.conversationId, ids));

  const userPeerIds = parts.filter((p) => p.principalType === "user" && p.principalId !== userId).map((p) => p.principalId);
  const botPeerIds = parts.filter((p) => p.principalType === "bot").map((p) => p.principalId);

  const userRows = userPeerIds.length
    ? await db.select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(inArray(users.id, userPeerIds))
    : [];
  const botRows = botPeerIds.length
    ? await db.select({ id: bots.id, name: bots.name, avatarUrl: bots.avatarUrl }).from(bots).where(inArray(bots.id, botPeerIds))
    : [];
  const userById = new Map(userRows.map((u) => [u.id, u]));
  const botById = new Map(botRows.map((b) => [b.id, b]));

  return convs.map((c) => {
    const peerPart = parts.find((p) => p.conversationId === c.id && !(p.principalType === "user" && p.principalId === userId));
    let peer: DmConversationView["peer"] = null;
    if (peerPart?.principalType === "user") {
      const u = userById.get(peerPart.principalId);
      if (u) peer = { type: "user", id: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl };
    } else if (peerPart?.principalType === "bot") {
      const b = botById.get(peerPart.principalId);
      if (b) peer = { type: "bot", id: b.id, displayName: b.name, avatarUrl: b.avatarUrl };
    }
    return {
      id: c.id,
      state: c.state,
      isE2ee: c.isE2ee,
      e2eeRoomId: c.e2eeRoomId,
      peer,
      lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
      incoming: c.state === "pending" && c.initiatorId !== userId,
    };
  });
}

export async function listMessages(conversationId: string, beforeId?: string, limit = 50): Promise<DmMessageView[]> {
  const where = beforeId
    ? and(eq(dmMessages.conversationId, conversationId), lt(dmMessages.id, BigInt(beforeId)))
    : eq(dmMessages.conversationId, conversationId);
  const rows = await db.select().from(dmMessages).where(where).orderBy(desc(dmMessages.id)).limit(limit);
  const out: DmMessageView[] = [];
  for (const r of rows.reverse()) {
    let text = "";
    let ciphertext: Record<string, unknown> | null = null;
    if (r.deletedAt) {
      // tombstoned row — render nothing on either branch
    } else if (r.ciphertextJson) {
      // E2EE row: server cannot decrypt; client handles.
      ciphertext = r.ciphertextJson;
    } else {
      const keyData = await getKeyData(r.keyId);
      const aad = new TextEncoder().encode(conversationId);
      const raw = decryptMessage(keyData, r.contentCiphertext, r.contentNonce, aad);
      text = decodeDmContent(raw);
    }
    out.push({
      id: r.id.toString(),
      conversationId,
      senderType: r.senderType,
      senderId: r.senderId,
      text,
      ciphertext,
      replyToMessageId: r.replyToMessageId ? r.replyToMessageId.toString() : null,
      createdAt: r.createdAt.toISOString(),
      editedAt: r.editedAt ? r.editedAt.toISOString() : null,
    });
  }
  return out;
}

export async function insertDmMessage(args: {
  conversationId: string;
  senderType: "user" | "bot";
  senderId: string;
  /** Plaintext body (mutually exclusive with `ciphertext`). */
  text?: string;
  /** Matrix m.room.encrypted envelope (mutually exclusive with `text`). */
  ciphertext?: Record<string, unknown>;
  replyToMessageId?: string | null;
}): Promise<DmMessageView> {
  if ((args.text == null) === (args.ciphertext == null)) {
    throw new Error("insertDmMessage: provide exactly one of `text` or `ciphertext`");
  }
  const key = await currentDataKey();
  let contentCiphertext: Uint8Array;
  let contentNonce: Uint8Array;
  if (args.ciphertext) {
    // E2EE row: leave content_ciphertext as an empty bytea; CHECK constraint
    // requires (octet_length(content_ciphertext) > 0) XOR (ciphertext_json IS NOT NULL).
    contentCiphertext = new Uint8Array(0);
    contentNonce = new Uint8Array(0);
  } else {
    const aad = new TextEncoder().encode(args.conversationId);
    const enc = encryptMessage(key.data, encodeDmContent(args.text!), aad);
    contentCiphertext = enc.ciphertext;
    contentNonce = enc.nonce;
  }
  const [row] = await db
    .insert(dmMessages)
    .values({
      conversationId: args.conversationId,
      senderType: args.senderType,
      senderId: args.senderId,
      contentCiphertext,
      contentNonce,
      keyId: key.id,
      ciphertextJson: args.ciphertext ?? null,
      replyToMessageId: args.replyToMessageId ? BigInt(args.replyToMessageId) : null,
    })
    .returning();
  await db.update(dmConversations).set({ lastMessageAt: row!.createdAt }).where(eq(dmConversations.id, args.conversationId));
  return {
    id: row!.id.toString(),
    conversationId: args.conversationId,
    senderType: args.senderType,
    senderId: args.senderId,
    text: args.text ?? "",
    ciphertext: args.ciphertext ?? null,
    replyToMessageId: args.replyToMessageId ?? null,
    createdAt: row!.createdAt.toISOString(),
    editedAt: null,
  };
}

export async function recipientUserIds(conversationId: string, exceptUserId?: string): Promise<string[]> {
  const rows = await db
    .select({ pid: dmParticipants.principalId, ptype: dmParticipants.principalType })
    .from(dmParticipants)
    .where(eq(dmParticipants.conversationId, conversationId));
  return rows.filter((r) => r.ptype === "user" && r.pid !== exceptUserId).map((r) => r.pid);
}
