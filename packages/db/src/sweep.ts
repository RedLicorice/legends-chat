#!/usr/bin/env -S tsx
/**
 * Scheduled maintenance sweep.
 *
 * Several invariants in this codebase were only enforced *lazily* — on the next
 * request from the very principal they constrain — which means an inactive
 * principal is never reconciled. This script is the reconciler; run it from
 * cron or a systemd timer on one host:
 *
 *     # every 15 minutes
 *     *\/15 * * * * cd /app && pnpm db:sweep >> /var/log/legends-sweep.log 2>&1
 *
 * Flags:
 *   --dry-run      report only, change nothing
 *   --only=roles   run just the expired-role reconciler
 *   --only=uploads run just the orphaned-upload reclaimer
 *
 * Requires the same env as the app: DATABASE_URL and ENCRYPTION_MASTER_KEY
 * (the upload sweep decrypts at-rest message bodies to find attachment
 * references). It never touches E2EE payloads.
 */
import { rm } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { db } from "./client";
import { sweepOrphanUploads, sweepExpiredRoles } from "./maintenance";
import { getSetting } from "./system-settings";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const only = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);

const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ?? (process.env.NODE_ENV === "production" ? "/app/uploads" : join(process.cwd(), "../../apps/web/public/uploads"));

function log(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

async function unlinkUpload(storagePath: string): Promise<void> {
  // storagePath comes from our own ledger, but treat it as untrusted anyway:
  // refuse anything that escapes the upload root.
  const target = normalize(join(UPLOAD_ROOT, storagePath));
  if (target !== UPLOAD_ROOT && !target.startsWith(UPLOAD_ROOT + sep)) {
    throw new Error(`refusing to unlink outside upload root: ${storagePath}`);
  }
  await rm(target, { force: true });
}

async function main(): Promise<void> {
  if (!only || only === "roles") {
    const roles = await sweepExpiredRoles({ dryRun }, db);
    log("roles.swept", { dryRun, users: roles.users.length, bots: roles.bots.length, detail: roles });
  }

  if (!only || only === "uploads") {
    const graceHours = Number(await getSetting(db, "upload_orphan_grace_hours")) || 24;
    const result = await sweepOrphanUploads(
      { dryRun, graceMs: graceHours * 3600_000, unlink: unlinkUpload },
      db,
    );
    log("uploads.swept", { dryRun, graceHours, ...result, deleted: result.deleted.length });
  }
}

await main();
process.exit(0);
