import type { Socket } from "socket.io";
import type { AccessTokenPayload } from "@legends/shared";
import { ACCESS_COOKIE } from "@legends/shared";
import { isJtiRevoked, parseCookie, verifyAccessToken } from "./auth";

export async function authenticateSocket(socket: Socket): Promise<AccessTokenPayload> {
  const token = parseCookie(socket.handshake.headers.cookie, ACCESS_COOKIE);
  if (!token) throw new Error("no auth cookie");
  const payload = await verifyAccessToken(token);
  if (await isJtiRevoked(payload.jti)) throw new Error("token revoked");
  return payload;
}

/**
 * Outcome of a post-connect re-check (#rt-1).
 *  - "ok"          → token still verifies and is not revoked
 *  - "rejected"    → the socket must be closed (expired / forged / logged out)
 *  - "unavailable" → the revocation store could not be consulted. Fails OPEN on
 *                    purpose: a Redis blip must not mass-disconnect every live
 *                    socket in the deployment. The next sweep decides.
 */
export type ReauthResult =
  | { status: "ok"; payload: AccessTokenPayload }
  | { status: "rejected"; reason: string }
  | { status: "unavailable"; reason: string };

/**
 * Re-runs the handshake auth against the cookie captured at connect time.
 * `verifyAccessToken` re-evaluates `exp`, so a socket that outlived its access
 * token is rejected here; the browser has already rotated its cookie by then
 * (TokenRefresh refreshes 30s before expiry) and Socket.IO reconnects with it.
 */
export async function reauthenticateSocket(socket: Socket): Promise<ReauthResult> {
  const token = parseCookie(socket.handshake.headers.cookie, ACCESS_COOKIE);
  if (!token) return { status: "rejected", reason: "no auth cookie" };
  let payload: AccessTokenPayload;
  try {
    payload = await verifyAccessToken(token);
  } catch (err) {
    return { status: "rejected", reason: `token invalid: ${(err as Error).message}` };
  }
  try {
    if (await isJtiRevoked(payload.jti)) return { status: "rejected", reason: "token revoked" };
  } catch (err) {
    return { status: "unavailable", reason: `revocation check failed: ${(err as Error).message}` };
  }
  return { status: "ok", payload };
}
