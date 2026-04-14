import { z } from "zod";

export const accessTokenPayloadSchema = z.object({
  sub: z.string().uuid(),
  role: z.enum(["user", "moderator", "admin"]),
  jti: z.string(),
  iat: z.number(),
  exp: z.number(),
});
export type AccessTokenPayload = z.infer<typeof accessTokenPayloadSchema>;

export const refreshTokenPayloadSchema = z.object({
  sub: z.string().uuid(),
  jti: z.string(),
  sid: z.string().uuid(),
  iat: z.number(),
  exp: z.number(),
});
export type RefreshTokenPayload = z.infer<typeof refreshTokenPayloadSchema>;

export const ACCESS_COOKIE = "lc_access";
export const REFRESH_COOKIE = "lc_refresh";
