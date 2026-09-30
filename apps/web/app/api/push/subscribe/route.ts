import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { pushSubscriptions } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { SsrfError, assertPublicHttpsUrl } from "@/lib/ssrf";

const bodySchema = z.object({
  endpoint: z.string().url().max(2048),
  p256dh: z.string().min(1).max(256),
  auth: z.string().min(1).max(256),
  deviceLabel: z.string().max(120).optional(),
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // #rt-4: z.string().url() accepts ANY scheme and host, and the ws process
  // later POSTs to whatever is stored here on every notification-worthy
  // message — http://127.0.0.1/..., http://169.254.169.254/latest/meta-data or
  // an internal hostname turn that into SSRF with an observable result (a
  // 404/410 response deletes the row). Only public https endpoints are stored.
  // apps/ws re-checks at send time too, since DNS can be re-pointed later.
  try {
    await assertPublicHttpsUrl(parsed.data.endpoint);
  } catch (err) {
    if (err instanceof SsrfError) {
      return NextResponse.json({ error: "invalid push endpoint" }, { status: 400 });
    }
    throw err;
  }

  await db
    .insert(pushSubscriptions)
    .values({
      userId: user.id,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.p256dh,
      auth: parsed.data.auth,
      deviceLabel: parsed.data.deviceLabel ?? null,
    })
    // #rt-4: `endpoint` is UNIQUE, so onConflictDoNothing let an attacker who
    // learned a victim's endpoint register it under their own account first —
    // after which the victim's real subscribe silently no-ops forever and the
    // row stays bound to the squatter. Rebind to the currently authenticated
    // owner instead: only whoever can present the endpoint's own keys gets it,
    // and re-registration from the real device always wins.
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: user.id,
        p256dh: parsed.data.p256dh,
        auth: parsed.data.auth,
        deviceLabel: parsed.data.deviceLabel ?? null,
      },
    });
  return NextResponse.json({ ok: true });
}
