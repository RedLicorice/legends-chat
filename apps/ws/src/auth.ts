import { jwtVerify } from "jose";
import { ACCESS_COOKIE, accessTokenPayloadSchema, REDIS_KEYS, type AccessTokenPayload } from "@legends/shared";
import { cacheClient } from "./redis";

const secret = new TextEncoder().encode(
  process.env.JWT_ACCESS_SECRET ?? (() => { throw new Error("JWT_ACCESS_SECRET not set"); })(),
);

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
  return accessTokenPayloadSchema.parse(payload);
}

export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function isJtiRevoked(jti: string): Promise<boolean> {
  const v = await cacheClient.get(REDIS_KEYS.REVOKED_JTI(jti));
  return v !== null;
}

export { ACCESS_COOKIE };
