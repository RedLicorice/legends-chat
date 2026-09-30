import { and, eq, gt, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { inviteCodes } from "./schema";

/**
 * The one definition of "this invite code may be redeemed right now".
 *
 * Every redemption path (web email register, web telegram-register, the
 * Telegram bot's invite prompt) MUST build its WHERE clause from this helper.
 * They previously each hand-rolled the predicate and every one of them forgot
 * `disabled_at` and `valid_from`, so an admin pressing "disable" in the
 * invites panel changed nothing — the code kept working until it expired or
 * ran out of uses — and codes scheduled to start in the future were
 * redeemable immediately. Keeping it in one place is what stops that drift
 * from happening again.
 *
 * Conditions, in order:
 *  - not administratively disabled (`disabled_at IS NULL`)
 *  - already in its validity window (`valid_from <= now`)
 *  - not expired (`expires_at IS NULL OR expires_at > now`)
 *  - uses remaining (`max_uses IS NULL OR uses_count < max_uses`)
 *  - elevated-role codes are strictly single-use: a `moderator`/`admin` code
 *    is only claimable while `uses_count = 0`, regardless of `max_uses`
 *    (belt-and-braces over the creation-time `maxUses = 1` clamp, and it
 *    repairs any legacy row that predates that clamp).
 *
 * `now` is a parameter so a caller doing a read-then-write can use a single
 * consistent timestamp across both statements.
 */
export function activeInvitePredicate(now: Date = new Date()): SQL {
  return and(
    isNull(inviteCodes.disabledAt),
    lte(inviteCodes.validFrom, now),
    or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
    or(isNull(inviteCodes.maxUses), sql`${inviteCodes.usesCount} < ${inviteCodes.maxUses}`),
    or(eq(inviteCodes.role, "user"), eq(inviteCodes.usesCount, 0)),
  )!;
}

/**
 * `activeInvitePredicate` narrowed to a single code. Callers normalise the
 * user-supplied string to upper case first.
 */
export function redeemableInvitePredicate(code: string, now: Date = new Date()): SQL {
  return and(eq(inviteCodes.code, code), activeInvitePredicate(now))!;
}
