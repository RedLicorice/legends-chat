import { describe, it, expect } from "vitest";
import { BOT_E2EE_ERROR_CODES, type BotE2eeErrorCode } from "../src/index";

describe("BOT_E2EE_ERROR_CODES", () => {
  it("exposes the six bot-e2ee error strings", () => {
    expect(BOT_E2EE_ERROR_CODES.BOT_E2EE_DISABLED).toBe("bot_e2ee_disabled");
    expect(BOT_E2EE_ERROR_CODES.BOT_E2EE_NOT_READY).toBe("bot_e2ee_not_ready");
    expect(BOT_E2EE_ERROR_CODES.BOT_E2EE_REQUIRED).toBe("bot_e2ee_required");
    expect(BOT_E2EE_ERROR_CODES.OTK_UNAVAILABLE).toBe("otk_unavailable");
    expect(BOT_E2EE_ERROR_CODES.DEVICE_NOT_FOUND).toBe("device_not_found");
    expect(BOT_E2EE_ERROR_CODES.CRYPTO_KEYS_INVALID).toBe("crypto_keys_invalid");
  });

  it("has six unique values", () => {
    const vals = Object.values(BOT_E2EE_ERROR_CODES);
    expect(new Set(vals).size).toBe(vals.length);
    expect(vals).toHaveLength(6);
  });

  it("exposes a BotE2eeErrorCode type alias compatible with the values", () => {
    const code: BotE2eeErrorCode = BOT_E2EE_ERROR_CODES.BOT_E2EE_DISABLED;
    expect(code).toBe("bot_e2ee_disabled");
  });
});
