import type { Socket } from "socket.io";
import type { AccessTokenPayload } from "@legends/shared";
import { ACCESS_COOKIE } from "@legends/shared";
import { isJtiRevoked, parseCookie, verifyAccessToken } from "./auth";

/**
 * Resolves the access JWT for a Socket.io connection from its handshake
 * cookie, verifies the signature, and rejects revoked sessions.
 *
 * Used by io.use(...) middleware to populate socket.data.user before any
 * event handler fires. The JWT already carries the user's resolved
 * permission set (role perms + per-principal overrides resolved at issue
 * time) — handlers should read permissions straight off the payload
 * instead of hitting the DB.
 */
export async function authenticateSocket(socket: Socket): Promise<AccessTokenPayload> {
  const token = parseCookie(socket.handshake.headers.cookie, ACCESS_COOKIE);
  if (!token) throw new Error("no auth cookie");
  const payload = await verifyAccessToken(token);
  if (await isJtiRevoked(payload.jti)) throw new Error("token revoked");
  return payload;
}
