// Invite-code format: LGND#XXXXXXXXXXXX where X is a char from a 32-char
// unambiguous alphabet (no 0/O/1/I). 32 divides 256 evenly so modulo
// sampling from random bytes is unbiased.
//
// Body length is 12 → 32^12 = 2^60 codes. It used to be 6 (2^30), a space an
// online guesser can sweep in hours. Anything that validates a code (the web
// register endpoint, the Telegram bot's invite prompt) is inherently an
// oracle, so the code space itself has to be large enough that guessing stays
// hopeless even when an attacker gets many tries. Exactly one random byte is
// consumed per body character — callers must supply at least
// INVITE_CODE_BODY_LENGTH bytes (extra bytes are ignored).

export const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_PREFIX = "LGND#";
export const INVITE_CODE_BODY_LENGTH = 12;
export const INVITE_CODE_LENGTH = INVITE_CODE_PREFIX.length + INVITE_CODE_BODY_LENGTH;

export const INVITE_CODE_REGEX = new RegExp(
  `^${INVITE_CODE_PREFIX}[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_BODY_LENGTH}}$`,
);

export function formatInviteCodeFromBytes(bytes: Uint8Array, prefix?: string): string {
  if (bytes.length < INVITE_CODE_BODY_LENGTH) {
    throw new Error(`need at least ${INVITE_CODE_BODY_LENGTH} random bytes`);
  }
  const p = prefix ?? INVITE_CODE_PREFIX;
  let body = "";
  for (let i = 0; i < INVITE_CODE_BODY_LENGTH; i += 1) {
    body += INVITE_CODE_ALPHABET[bytes[i]! % INVITE_CODE_ALPHABET.length];
  }
  return p + body;
}
