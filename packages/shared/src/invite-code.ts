// Invite-code format: LGND#XXXXXX where X is a char from a 32-char
// unambiguous alphabet (no 0/O/1/I). 32 divides 256 evenly so modulo
// sampling from random bytes is unbiased.

export const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_PREFIX = "LGND#";
export const INVITE_CODE_BODY_LENGTH = 6;
export const INVITE_CODE_LENGTH = INVITE_CODE_PREFIX.length + INVITE_CODE_BODY_LENGTH;

export const INVITE_CODE_REGEX = new RegExp(
  `^${INVITE_CODE_PREFIX}[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_BODY_LENGTH}}$`,
);

export function formatInviteCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < INVITE_CODE_BODY_LENGTH) {
    throw new Error(`need at least ${INVITE_CODE_BODY_LENGTH} random bytes`);
  }
  let body = "";
  for (let i = 0; i < INVITE_CODE_BODY_LENGTH; i += 1) {
    body += INVITE_CODE_ALPHABET[bytes[i]! % INVITE_CODE_ALPHABET.length];
  }
  return INVITE_CODE_PREFIX + body;
}
