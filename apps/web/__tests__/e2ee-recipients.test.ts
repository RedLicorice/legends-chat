import { describe, it, expect } from "vitest";
import { verifyRecipientSet } from "@/lib/e2ee-recipients";

const SELF = "self-uuid";

describe("verifyRecipientSet (cr-h2)", () => {
  it("accepts a recipient set that is exactly roster ∪ admins", () => {
    const v = verifyRecipientSet({
      serverUserIds: [SELF, "member-a", "admin-a"],
      rosterUserIds: [SELF, "member-a"],
      adminUserIds: ["admin-a"],
      selfUserId: SELF,
    });
    expect(v.ok).toBe(true);
    expect(v.rejected).toEqual([]);
    expect(v.recipients).toEqual([SELF, "admin-a", "member-a"].sort());
    expect(v.disclosedAdminIds).toEqual(["admin-a"]);
  });

  it("rejects a smuggled recipient that is in neither the roster nor the disclosure", () => {
    // The exact attack: compromised server adds an id to user_ids and returns
    // admin_user_ids: [] so the disclosure banner names nobody extra.
    const v = verifyRecipientSet({
      serverUserIds: [SELF, "member-a", "attacker"],
      rosterUserIds: [SELF, "member-a"],
      adminUserIds: [],
      selfUserId: SELF,
    });
    expect(v.ok).toBe(false);
    expect(v.rejected).toEqual(["attacker"]);
    expect(v.recipients).not.toContain("attacker");
  });

  it("lets an id through only when it is disclosed as an admin", () => {
    const v = verifyRecipientSet({
      serverUserIds: [SELF, "offroster-admin"],
      rosterUserIds: [SELF],
      adminUserIds: ["offroster-admin"],
      selfUserId: SELF,
    });
    expect(v.ok).toBe(true);
    // ...and the banner is derived from the same computed set, so the extra
    // party is always named.
    expect(v.disclosedAdminIds).toEqual(["offroster-admin"]);
  });

  it("never drops the local user, even if the server omits them", () => {
    const v = verifyRecipientSet({
      serverUserIds: ["member-a"],
      rosterUserIds: ["member-a"],
      adminUserIds: [],
      selfUserId: SELF,
    });
    expect(v.recipients).toContain(SELF);
  });

  it("does not disclose an admin id that was itself rejected", () => {
    const v = verifyRecipientSet({
      serverUserIds: ["member-a"],
      rosterUserIds: ["member-a"],
      adminUserIds: ["admin-not-in-user-ids"],
      selfUserId: SELF,
    });
    // admin_user_ids that the server never actually shares to shouldn't be
    // named as recipients.
    expect(v.disclosedAdminIds).toEqual([]);
  });

  it("de-duplicates", () => {
    const v = verifyRecipientSet({
      serverUserIds: ["member-a", "member-a", SELF],
      rosterUserIds: ["member-a"],
      adminUserIds: [],
      selfUserId: SELF,
    });
    expect(v.recipients).toEqual([SELF, "member-a"].sort());
  });
});
