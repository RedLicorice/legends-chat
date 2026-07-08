import { redis } from "./redis";

// Shared contract with apps/ws/src/bootstrap.ts: POST /verify-password writes
// this key = the topic's current passwordVersion on a correct password. Every
// server-side read path for a password-protected topic must check it (#19).
// Rotating the password bumps passwordVersion, invalidating old proofs.
// ponytail: signed-stateless-proof migration deferred — Redis proof is
// ephemeral (a Redis restart forces re-entry). Tracked as follow-up.
export function topicPwProofKey(userId: string, topicId: string): string {
  return `legends:topic-pw:${userId}:${topicId}`;
}

// True when the caller may see a password-protected topic's content: no password
// set, admin, or a valid proof for the current passwordVersion.
export async function hasTopicPasswordProof(
  userRole: string,
  userId: string,
  topicId: string,
  passwordHash: string | null,
  passwordVersion: number,
): Promise<boolean> {
  if (passwordHash == null) return true; // gate is open
  if (userRole === "admin") return true; // admins bypass, matching client + WS
  const proof = await redis.get(topicPwProofKey(userId, topicId));
  return proof === String(passwordVersion);
}
