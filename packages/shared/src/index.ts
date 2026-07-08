export * from "./permissions";
export * from "./events";
export * from "./zod";
export * from "./jwt";
export * from "./format";
export * from "./invite-code";
export * from "./log";
export * from "./link-processor";
export * from "./shlink-client";
export * from "./bootstrap";
export * from "./ssrf";

// Bot E2EE error codes — returned by /api/dm/open, /api/bot/v1/crypto/*, and
// /api/admin/topics/[id]/bots so the frontend can branch on stable identifiers
// rather than user-facing copy. See spec §11 (bot E2EE DMs + topic channels).
export const BOT_E2EE_ERROR_CODES = {
  BOT_E2EE_DISABLED: "bot_e2ee_disabled",
  BOT_E2EE_NOT_READY: "bot_e2ee_not_ready",
  BOT_E2EE_REQUIRED: "bot_e2ee_required",
  OTK_UNAVAILABLE: "otk_unavailable",
  DEVICE_NOT_FOUND: "device_not_found",
  CRYPTO_KEYS_INVALID: "crypto_keys_invalid",
} as const;

export type BotE2eeErrorCode =
  (typeof BOT_E2EE_ERROR_CODES)[keyof typeof BOT_E2EE_ERROR_CODES];
