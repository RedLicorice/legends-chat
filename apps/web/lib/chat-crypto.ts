"use client";
import { toMatrixUserId } from "@/lib/crypto-matrix";
import type { EncryptedEnvelope, IncomingEnvelope } from "@/lib/crypto";

export interface ChatCrypto {
  readonly kind: "megolm" | "olm";
  /** Returns the matrix-flavored sender id for the room/peer when decrypting. */
  matrixSenderFor(senderUserId: string | null, fallbackUserId: string): string;
  init(currentUserId: string): Promise<void>;
  ensureSession(memberUserIds: string[]): Promise<void>;
  encrypt(plaintext: string): Promise<EncryptedEnvelope>;
  decrypt(envelope: IncomingEnvelope): Promise<string>;
  pumpOutgoing(): Promise<void>;
  pollSync(): Promise<void>;
  onMembershipChange?(action: "join" | "leave", affectedUserId: string, newMemberList: string[]): Promise<void>;
}

type CryptoMod = typeof import("@/lib/crypto");

async function loadCrypto(): Promise<CryptoMod> {
  return import("@/lib/crypto");
}

export function createMegolmChatCrypto(roomId: string): ChatCrypto {
  let mod: CryptoMod | null = null;
  let initPromise: Promise<void> | null = null;
  return {
    kind: "megolm",
    matrixSenderFor(senderUserId, fallbackUserId) {
      return toMatrixUserId(senderUserId ?? fallbackUserId);
    },
    async init(currentUserId: string) {
      if (mod) return;
      if (initPromise) { await initPromise; return; }
      initPromise = (async () => {
        const m = await loadCrypto();
        await m.initCrypto(currentUserId);
        await m.bootstrap();
        mod = m;
      })();
      try { await initPromise; } finally { initPromise = null; }
    },
    async ensureSession(memberUserIds: string[]) {
      if (!mod) throw new Error("chat-crypto: not initialized");
      await mod.ensureRoomMembers(roomId, memberUserIds);
    },
    async encrypt(plaintext: string): Promise<EncryptedEnvelope> {
      if (!mod) throw new Error("chat-crypto: not initialized");
      return mod.encryptRoom(roomId, plaintext);
    },
    async decrypt(envelope: IncomingEnvelope): Promise<string> {
      if (!mod) throw new Error("chat-crypto: not initialized");
      return mod.decryptRoom(roomId, envelope);
    },
    async pumpOutgoing(): Promise<void> {
      if (!mod) return;
      await mod.pumpOutgoing();
    },
    async pollSync(): Promise<void> {
      if (!mod) return;
      await mod.pollSync();
    },
    async onMembershipChange(action, affectedUserId, newMemberList) {
      if (!mod) return;
      await mod.onMembershipChange(roomId, action, affectedUserId, newMemberList);
    },
  };
}

/**
 * Create an Olm 1:1 chat-crypto bound to a single peer.
 *
 * `peerMatrixId` must be a fully namespaced Matrix id so user and bot peers
 * are unambiguous on the wire (`@<uuid>:legends.local` vs
 * `@bot.<uuid>:legends.local`). Build it from a peer principal via
 * `toMatrixUserId` / `toMatrixBotId` in `@/lib/crypto-matrix`.
 */
export function createOlmChatCrypto(roomKey: string, peerMatrixId: string): ChatCrypto {
  let mod: CryptoMod | null = null;
  let initPromise: Promise<void> | null = null;
  return {
    kind: "olm",
    matrixSenderFor(senderUserId, fallbackUserId) {
      const id = senderUserId ?? fallbackUserId;
      return toMatrixUserId(id);
    },
    async init(currentUserId: string) {
      if (mod) return;
      if (initPromise) { await initPromise; return; }
      initPromise = (async () => {
        const m = await loadCrypto();
        await m.initCrypto(currentUserId);
        await m.bootstrap();
        mod = m;
      })();
      try { await initPromise; } finally { initPromise = null; }
    },
    async ensureSession(_memberUserIds: string[]) {
      if (!mod) throw new Error("chat-crypto: not initialized");
      await mod.ensurePeerTracked(peerMatrixId);
      await mod.ensureSessionWithPeer(peerMatrixId);
    },
    async encrypt(plaintext: string): Promise<EncryptedEnvelope> {
      if (!mod) throw new Error("chat-crypto: not initialized");
      return mod.encryptDm(roomKey, plaintext);
    },
    async decrypt(envelope: IncomingEnvelope): Promise<string> {
      if (!mod) throw new Error("chat-crypto: not initialized");
      return mod.decryptDm(roomKey, envelope);
    },
    async pumpOutgoing(): Promise<void> {
      if (!mod) return;
      await mod.pumpOutgoing();
    },
    async pollSync(): Promise<void> {
      if (!mod) return;
      await mod.pollSync();
    },
  };
}
