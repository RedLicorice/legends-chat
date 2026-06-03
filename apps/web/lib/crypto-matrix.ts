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
