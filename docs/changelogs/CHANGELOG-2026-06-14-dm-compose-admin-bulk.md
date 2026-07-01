# Changelog — 2026-06-14

## DM compose flow + admin bulk operations

Two threads: a real "start a conversation" compose flow for DMs (with
delete-on-decline so rejected requests leave no trace), and bulk management
tooling for admins (mass-delete for topics and bots, plus a master/detail
bots screen). Docs (README, user manual, admin manual, whitepaper) rewritten
for the DMs/E2EE/SPA era.

### DM compose + requests
- `refactor(dm)`: a DM request now *requires* a first message; declining a
  request deletes the empty conversation instead of leaving a dangling row.
- `/c/new` compose route for composing that first message before a
  conversation exists.
- Compose flow wired into the new-chat modals; decline UX finished.
- Fix: the sender of a pending DM request sees a "waiting" state, not the
  accept/decline buttons meant for the recipient.
- SW cache bumped `v5-dm-compose`.

### Admin bulk-ops
- Bulk-delete endpoint + UI for topics (`POST /api/admin/topics/bulk`).
- Bulk-delete endpoint + UI for bots (`POST /api/admin/bots/bulk`); guarded on
  `bots.manage` to match the per-id routes.
- Bots screen converted to a master/detail layout with bulk-ops selection.
- Bulk-delete batches client-side to respect the 200-id server cap; surfaces
  server error detail (zod issues + message).
- Fix: admin mobile hamburger visible on every admin view.

### Ops + docs
- Ecosystem web entry runs prod by default.
- README, user manual, and admin manual rewritten for DMs, E2EE, bot E2EE,
  principals/pipelines, and the SPA shell; trimmed to length budgets.
