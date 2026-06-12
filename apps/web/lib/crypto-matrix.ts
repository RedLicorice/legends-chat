// Helpers to translate between Legends user/conversation UUIDs and the
// Matrix-shaped ids (`@<uuid>:legends.local`, `!<uuid>:legends.local`) that
// `@matrix-org/matrix-sdk-crypto-wasm` expects on every Client-Server API
// surface we expose under `/api/crypto/*`.
//
// We are NOT a Matrix homeserver; we only speak the *shape* the OlmMachine
// requires so it can drive its own Olm/Megolm state on the client.

export const CRYPTO_DOMAIN = "legends.local";

export function toMatrixUserId(userId: string): string {
  return `@${userId}:${CRYPTO_DOMAIN}`;
}

export function fromMatrixUserId(matrixId: string): string | null {
  const m = matrixId.match(/^@([0-9a-fA-F-]+):legends\.local$/);
  return m && m[1] ? m[1] : null;
}

export function toMatrixRoomId(convId: string): string {
  return `!${convId}:${CRYPTO_DOMAIN}`;
}

export function fromMatrixRoomId(roomId: string): string | null {
  const m = roomId.match(/^!([0-9a-fA-F-]+):legends\.local$/);
  return m && m[1] ? m[1] : null;
}

// Bot namespace: bots live under `@bot.<bot-uuid>:legends.local` so a single
// Matrix-id surface (e.g. /api/crypto/keys/query) can address both users and
// bots without ambiguity. The `bot.` prefix contains a `.` which the user
// regex's `[0-9a-fA-F-]` class rejects — so `fromMatrixUserId` will never
// match a bot id and vice versa.
export type MatrixPrincipal =
  | { type: "user"; id: string }
  | { type: "bot"; id: string };

export function toMatrixBotId(botId: string): string {
  return `@bot.${botId}:${CRYPTO_DOMAIN}`;
}

export function fromMatrixBotId(matrixId: string): string | null {
  const m = matrixId.match(/^@bot\.([0-9a-fA-F-]+):legends\.local$/);
  return m && m[1] ? m[1] : null;
}

export function parseMatrixPrincipal(matrixId: string): MatrixPrincipal | null {
  const bot = fromMatrixBotId(matrixId);
  if (bot) return { type: "bot", id: bot };
  const user = fromMatrixUserId(matrixId);
  if (user) return { type: "user", id: user };
  return null;
}
