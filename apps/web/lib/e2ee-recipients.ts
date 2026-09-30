// Client-side verification of the Megolm recipient set (cr-h2).
//
// The client used to take `user_ids` from /api/crypto/rooms/<id>/members
// verbatim and hand the whole array to `shareRoomKey`. Three sets were in play
// and nothing reconciled them:
//
//   user_ids        — what the key actually gets shared with
//   admin_user_ids  — what the in-channel disclosure banner names
//   the Members panel roster — a *different* endpoint
//
// A server with a DB foothold could therefore return `user_ids` containing an
// extra attacker id with `admin_user_ids: []`. Honest senders' OlmMachines
// would wrap the session key for the attacker's devices, the disclosure banner
// would name no extra party, the Members panel wouldn't list them, and
// `checkForNewDevices` would stay silent (first sighting = silent TOFU
// baseline). A completely invisible additional recipient.
//
// The fix is structural: the client computes the recipient set itself as
//   roster(/api/topics/<id>/members) ∪ admin_user_ids
// and refuses to pass anything outside it to `shareRoomKey`. An id that is
// only reachable by being an admin is at least *named* in the disclosure
// banner, which is the trade-off the project already accepted.

export interface RecipientVerification {
  /** Ids that are safe to hand to shareRoomKey, sorted. */
  recipients: string[];
  /** Ids the server asked us to encrypt to that we refuse, sorted. */
  rejected: string[];
  /** Admin ids that survived verification — what the banner should name. */
  disclosedAdminIds: string[];
  ok: boolean;
}

export function verifyRecipientSet(args: {
  /** `user_ids` as returned by the crypto members endpoint. */
  serverUserIds: readonly string[];
  /** Roster from the independent Members endpoint. */
  rosterUserIds: readonly string[];
  /** `admin_user_ids` — the set the in-channel disclosure names. */
  adminUserIds: readonly string[];
  /** Local user; always a legitimate recipient of our own session. */
  selfUserId?: string | null;
}): RecipientVerification {
  const allowed = new Set<string>([...args.rosterUserIds, ...args.adminUserIds]);
  if (args.selfUserId) allowed.add(args.selfUserId);

  const recipients: string[] = [];
  const rejected: string[] = [];
  for (const id of new Set(args.serverUserIds)) {
    (allowed.has(id) ? recipients : rejected).push(id);
  }
  // The local user must always be in the set we share to — a second device of
  // our own needs the key, and the server omitting us must not silently drop it.
  if (args.selfUserId && !recipients.includes(args.selfUserId)) {
    recipients.push(args.selfUserId);
  }

  const kept = new Set(recipients);
  return {
    recipients: recipients.sort(),
    rejected: rejected.sort(),
    disclosedAdminIds: [...new Set(args.adminUserIds)].filter((id) => kept.has(id)).sort(),
    ok: rejected.length === 0,
  };
}
