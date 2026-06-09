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
